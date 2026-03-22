/**
 * Void Memory — MCP Server
 * 5 tools: recall, store, stats, void_zones, explain
 * Runs on stdio for Claude Code MCP integration
 */

import { openDB } from './db.js';
import { recall, store, stats, voidZones, type RecallResult, type MemoryStats } from './engine.js';
import { scoreMessage, processMessage, getRecentThoughts, getUnstoredThoughts, generateSessionSummary, clearThoughts } from './inner-voice.js';
import { runSelfTest } from './self-test.js';
import { dream, storeDreamInsights } from './dream.js';

const db = openDB();

// ── MCP Protocol (stdio JSON-RPC) ──

const TOOLS = [
  {
    name: 'void_recall',
    description: 'Recall memories relevant to a query. Uses three-pass pipeline: keyword scoring, void marking (~30% structural absence), budget-fit. Returns only interference-free results. Always use this before working on topics the team has covered.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall — topic, question, or keywords' },
        budget: { type: 'number', description: 'Max tokens to use (default 4000, max 10000). Lower = tighter recall.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'void_store',
    description: 'Store a new memory block. Quality-gated: min 20 chars, 30% alphabetic, auto-dedup on keyword overlap >80%. Blocks start as "stored" confidence and must be accessed 3+ times to reach "confirmed".',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The knowledge to store' },
        category: { type: 'string', enum: ['fact', 'preference', 'context', 'skill', 'episode', 'decision'], description: 'Category (default: fact)' },
        keywords: { type: 'array', items: { type: 'string' }, description: '3-8 specific lowercase keywords for retrieval' },
        supersedes: { type: 'number', description: 'ID of block this replaces (marks old block as inhibitory)' },
      },
      required: ['content', 'keywords'],
    },
  },
  {
    name: 'void_stats',
    description: 'Memory health dashboard. Shows block counts by state (active/void/inhibitory), confidence distribution, dead weight %, average void fraction across recalls, and recall performance.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'void_zones',
    description: 'Show what would be suppressed (void-marked) for a given query. Useful for understanding why certain memories are excluded — the void is structural, not accidental.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query to analyze void zones for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'void_explain',
    description: 'Explain the Void Memory system — what makes it different from standard RAG/memory systems. The core insight: 30% structural absence (from PNN research) creates interference-free recall channels.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'void_inner_voice',
    description: 'Process a message through the inner voice pipeline. Scores it for importance (FE), generates a thought if significant, auto-stores urgent items. Use this on incoming messages to automatically capture infrastructure facts, corrections, and decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message content to process' },
        sender: { type: 'string', description: 'Who sent the message (gavin, tron, arch, flynn, etc.)' },
        context: { type: 'string', description: 'Optional conversation context for richer storage' },
      },
      required: ['message', 'sender'],
    },
  },
  {
    name: 'void_session_review',
    description: 'Generate a session summary from accumulated inner voice thoughts. Call this before compact or at end of session to capture the arc of the conversation. Returns summary + list of unstored thoughts that should be reviewed.',
    inputSchema: {
      type: 'object',
      properties: {
        store_all: { type: 'boolean', description: 'If true, auto-store all pending thoughts above threshold (default false)' },
      },
    },
  },
  {
    name: 'void_self_test',
    description: 'Run automated recall quality benchmarks. Tests precision@k, recall, MRR, void accuracy, and speed across 10 standardized queries. Tracks results over time and detects regressions. Run this periodically to ensure memory quality stays high.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'void_dream',
    description: 'Run a dream consolidation cycle. Clusters related memories, discovers unexpected connections between distant topics, detects knowledge gaps, surfaces forgotten high-value blocks, and finds recurring patterns. Returns a morning briefing with insights. Optionally stores top insights as memory blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        store_insights: { type: 'boolean', description: 'If true, store top dream insights as memory blocks (default false)' },
      },
    },
  },
];

// ── Tool handlers ──

async function handleTool(name: string, args: any): Promise<any> {
  switch (name) {
    case 'void_recall': {
      const result = await recall(db, args.query, args.budget);
      return {
        summary: `Recalled ${result.blocks.length} blocks (scored ${result.blocks_scored}, voided ${result.blocks_voided}, ${Math.round(result.void_fraction * 100)}% void) in ${result.duration_ms}ms. Budget: ${result.budget_used}/${result.budget_max} tokens.`,
        blocks: result.blocks.map(b => ({
          id: b.id,
          content: b.content,
          category: b.category,
          confidence: b.confidence,
          score: b.score,
        })),
        void_zones: result.void_zones,
        void_fraction: result.void_fraction,
        budget: { used: result.budget_used, max: result.budget_max },
      };
    }

    case 'void_store': {
      const result = store(db, {
        content: args.content,
        category: args.category,
        keywords: args.keywords,
        supersedes: args.supersedes,
      });
      return {
        id: result.id,
        deduped: result.deduped,
        message: result.deduped
          ? `Updated existing block #${result.id} (>80% keyword overlap detected)`
          : `Stored new block #${result.id}`,
      };
    }

    case 'void_stats': {
      const s = stats(db);
      return {
        blocks: {
          total: s.total_blocks,
          active: s.active,
          void: s.void,
          inhibitory: s.inhibitory,
        },
        confidence: s.by_confidence,
        categories: s.by_category,
        avg_block_tokens: s.avg_block_tokens,
        health: {
          dead_weight_pct: s.dead_weight_pct,
          total_recalls: s.total_recalls,
          avg_recall_ms: s.avg_recall_ms,
          avg_void_fraction: s.avg_void_fraction,
        },
      };
    }

    case 'void_zones': {
      return voidZones(db, args.query);
    }

    case 'void_explain': {
      return {
        name: 'Void Memory',
        version: '1.0.0',
        insight: 'Every AI memory system tries to ADD the right things to context. Void Memory carves out ~30% structural absence — creating interference-free channels for relevant memories to flow through. The 30% void fraction is a topological invariant discovered in ternary photonic neural network research across 5 random seeds.',
        states: {
          'active (+1)': 'Block is relevant to current context. Retrieved.',
          'void (0)': 'Block is deliberately suppressed for this query — not irrelevant, but structurally absent to prevent interference.',
          'inhibitory (-1)': 'Block actively suppresses related blocks (corrections, supersessions).',
        },
        lifecycle: 'observed → stored → accessed → confirmed. Blocks must prove their worth through use.',
        budget: 'Context-aware: adapts from 4K tokens (2% of window) down to 2K near compact. Never silent truncation — reports what was voided and why.',
        speed: '<200ms target. No LLM calls, no embedding distance, no deep chain walks.',
      };
    }

    case 'void_inner_voice': {
      const result = processMessage(db, args.message, args.sender, {
        autoStore: true,
        context: args.context,
      });
      if (!result) {
        // Below threshold — score it anyway for transparency
        const fe = scoreMessage(args.message, args.sender);
        return {
          processed: false,
          feScore: fe.score,
          factors: fe.factors,
          message: `FE score ${fe.score.toFixed(2)} — below threshold (${0.4}), not stored.`,
        };
      }
      return {
        processed: true,
        feScore: result.feScore,
        thought: result.thought,
        stored: result.stored,
        blockId: result.blockId,
        message: result.stored
          ? `Stored as block #${result.blockId} (FE ${result.feScore.toFixed(2)})`
          : `Thought recorded (FE ${result.feScore.toFixed(2)}), pending session review`,
      };
    }

    case 'void_session_review': {
      const summary = generateSessionSummary();
      const unstored = getUnstoredThoughts();

      if (args.store_all && unstored.length > 0) {
        let storedCount = 0;
        for (const t of unstored) {
          try {
            const fe = scoreMessage(t.message, t.sender);
            store(db, {
              content: `[SESSION REVIEW] ${t.thought}`,
              category: fe.category,
              keywords: fe.keywords.slice(0, 8),
            });
            t.stored = true;
            storedCount++;
          } catch { /* dedup or quality gate */ }
        }
        return {
          summary,
          thoughts_total: getRecentThoughts().length,
          stored_now: storedCount,
          message: `Session review complete. ${storedCount} additional thoughts stored.`,
        };
      }

      return {
        summary,
        thoughts_total: getRecentThoughts().length,
        unstored_count: unstored.length,
        unstored: unstored.map(t => ({
          sender: t.sender,
          feScore: t.feScore,
          thought: t.thought,
        })),
        message: `${unstored.length} thoughts pending review. Use store_all=true to store them.`,
      };
    }

    case 'void_self_test': {
      const report = await runSelfTest(db);
      return {
        run_id: report.run_id,
        timestamp: report.timestamp,
        memory: report.memory_stats,
        summary: report.summary,
        results: report.results.map(r => ({
          name: r.name,
          passed: r.passed,
          details: r.details,
        })),
        regressions: report.regressions,
        trend: report.trend,
        message: `Self-test complete: ${report.summary.tests_passed}/${report.summary.tests_run} passed (${report.summary.pass_rate}%). Overall score: ${report.summary.overall_score}. ${report.regressions.length > 0 ? `⚠ ${report.regressions.length} regressions detected!` : 'No regressions.'}`,
      };
    }

    case 'void_dream': {
      const report = dream(db);
      let storedCount = 0;
      if (args.store_insights) {
        storedCount = storeDreamInsights(db, report);
      }
      return {
        timestamp: report.timestamp,
        duration_ms: report.duration_ms,
        morning_briefing: report.morning_briefing,
        consolidations: report.consolidations,
        memory_health: report.memory_health,
        insights: report.insights.slice(0, 15).map(i => ({
          type: i.type,
          title: i.title,
          description: i.description,
          confidence: i.confidence,
          blocks: i.blocks,
        })),
        insights_stored: storedCount,
        message: `Dream cycle complete in ${report.duration_ms}ms. ${report.insights.length} insights: ${report.consolidations.connections_discovered} connections, ${report.consolidations.gaps_detected} gaps, ${report.consolidations.forgotten_surfaced} forgotten, ${report.consolidations.patterns_found} patterns.${storedCount > 0 ? ` ${storedCount} stored.` : ''}`,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP JSON-RPC over stdio ──

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;

  // Process complete JSON-RPC messages (newline-delimited)
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (e) {
      sendError(null, -32700, 'Parse error');
    }
  }
});

function handleMessage(msg: any) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'void-memory', version: '1.0.0' },
        },
      });
      break;

    case 'notifications/initialized':
      // No response needed
      break;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      break;

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = handleTool(name, args || {});
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        });
      } catch (e: any) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${e.message}` }],
            isError: true,
          },
        });
      }
      break;
    }

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendError(id: any, code: number, message: string) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// Keep alive
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
