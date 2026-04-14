/**
 * Void Memory — MCP Server
 * 5 tools: recall, store, stats, void_zones, explain
 * Runs on stdio for Claude Code MCP integration
 */

import { join } from 'path';
import { openDB } from './db.js';
import { recall, store, stats, voidZones, verifyResponse, type RecallResult, type RecallMode, type MemoryStats } from './engine.js';
import { scoreMessage, processMessage, getRecentThoughts, getUnstoredThoughts, generateSessionSummary, clearThoughts } from './inner-voice.js';
import { runSelfTest } from './self-test.js';
import { dream, storeDreamInsights } from './dream.js';
import { migrateMotivation, motivation_process, goal_add, goal_commit, goal_progress, goal_complete, goal_abandon, record_reward, load_drive_state } from './motivation.js';
import { papezTick, isSignificantEvent, shouldTickOnMessage, type AgentEvent } from './papez.js';
import { migrateValence } from './valence.js';
import { limbicDream, storeLimbicDreamInsights } from './limbic-dream.js';
import { heartbeatStore, preCompactDump, continuityStats } from './continuity.js';
import { arbitrate, habitStats } from './arbitration.js';
import { migrateTieredStorage, healthAdvisory, updateTiers, circadianCycle, buildCoherentDomains, getCoherentDomains, toolCallStats } from './kruse.js';

// ── Episodic Memory (short-term) integration ──
const EPISODIC_URL = process.env.EPISODIC_URL || 'http://127.0.0.1:7682';

interface EpisodicCell {
  name: string;
  trained_at: string;
  pair_count: number;
  final_loss: number;
  weight: string;
  answer: string;
  adapter_load_ms: number;
  generation_ms: number;
}

interface EpisodicResponse {
  cells_queried: number;
  cells_available: number;
  total_ms: number;
  responses: EpisodicCell[];
}

async function queryEpisodic(query: string, topN: number = 3): Promise<EpisodicResponse | null> {
  try {
    const resp = await fetch(`${EPISODIC_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, top_n: topN, max_tokens: 150 }),
      signal: AbortSignal.timeout(30000), // 30s timeout for CPU inference
    });
    if (!resp.ok) return null;
    return await resp.json() as EpisodicResponse;
  } catch {
    return null; // Service not running — degrade gracefully
  }
}

async function episodicHealth(): Promise<any> {
  try {
    const resp = await fetch(`${EPISODIC_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return { status: 'offline' };
    return await resp.json();
  } catch {
    return { status: 'offline' };
  }
}

// Agent-scoped database: VOID_AGENT env var selects which DB to use
// Set in each agent's Claude Code MCP config: VOID_AGENT=tron, VOID_AGENT=flynn, etc.
const VOID_AGENT = process.env.VOID_AGENT || 'arch';
const DATA_DIR = process.env.VOID_DATA_DIR || join(import.meta.dirname, '..', 'data');

function getAgentDbPath(agent: string): string | undefined {
  if (agent === 'arch') return undefined; // default path
  return join(DATA_DIR, agent, 'void-memory.db');
}

const db = openDB(getAgentDbPath(VOID_AGENT));
migrateMotivation(db);
migrateValence(db);
migrateTieredStorage(db);
console.error(`[void-memory] Agent: ${VOID_AGENT}, DB: ${getAgentDbPath(VOID_AGENT) || 'default (arch)'}`);

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
        mode: { type: 'string', enum: ['particle', 'wave'], description: 'Recall mode: particle (default, tight/specific, ~30% void) or wave (broad/clustered, ~15% void, returns topic clusters). Use wave for exploratory queries, particle for specific lookups.' },
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
    name: 'void_verify',
    description: 'Verify an LLM response against memory. Extracts factual claims from the text and checks each against stored knowledge using score + coverage. Returns: verified (grounded in memory), unverified (no coverage — potential hallucination), contradicted (memory says otherwise), partial (some coverage). Trust ratio = verified/total. Use this to catch hallucinations before they reach the user.',
    inputSchema: {
      type: 'object',
      properties: {
        response: { type: 'string', description: 'The LLM response text to verify against memory' },
      },
      required: ['response'],
    },
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
  {
    name: 'void_motivation',
    description: 'Run the motivation engine. Evaluates all drives (curiosity, task completion, collaboration, etc.), scores active goals via Expected Value of Control, and recommends whether to stay on current task or switch. Uses deliberation cost to prevent thrashing. Call this when deciding what to work on next.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'void_goal_add',
    description: 'Add a new goal to the motivation stack. Goals are scored by EVC and tracked for commitment. Use for tasks assigned by Gavin or self-initiated work.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the goal is' },
        priority: { type: 'number', description: 'Base priority 0-1 (default 0.5)' },
        parent_id: { type: 'string', description: 'Parent goal ID for sub-goals' },
      },
      required: ['description'],
    },
  },
  {
    name: 'void_goal_commit',
    description: 'Commit to a goal. Increases deliberation cost for switching away — prevents task thrashing.',
    inputSchema: {
      type: 'object',
      properties: { goal_id: { type: 'string', description: 'Goal ID to commit to' } },
      required: ['goal_id'],
    },
  },
  {
    name: 'void_goal_progress',
    description: 'Update progress on a goal (0-1). Each update increases commitment cost, making abandonment more expensive.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'Goal ID' },
        progress: { type: 'number', description: 'Progress 0-1' },
        effort: { type: 'number', description: 'Effort spent this update (hours)' },
      },
      required: ['goal_id', 'progress'],
    },
  },
  {
    name: 'void_goal_complete',
    description: 'Mark a goal as completed. Records positive reward, replenishes drives.',
    inputSchema: {
      type: 'object',
      properties: { goal_id: { type: 'string', description: 'Goal ID to complete' } },
      required: ['goal_id'],
    },
  },
  {
    name: 'void_goal_abandon',
    description: 'Abandon a goal. Records negative reward. Only do this when the goal is no longer relevant, not because something shinier appeared.',
    inputSchema: {
      type: 'object',
      properties: { goal_id: { type: 'string', description: 'Goal ID to abandon' } },
      required: ['goal_id'],
    },
  },
  {
    name: 'void_papez_tick',
    description: 'Run a Papez circuit tick — the limbic feedback loop. Tags valence on an event, stores to memory, updates drives, recalculates EVC, checks goal switching. Call after completing a task, receiving feedback from Gavin, encountering errors, or switching goals. The engine of motivation.',
    inputSchema: {
      type: 'object',
      properties: {
        event_type: { type: 'string', description: 'Event type: task_complete, task_complete_hard, gavin_positive, gavin_negative, task_abandoned, task_switched, system_crash, skill_learned, collaboration_success, recall_success, context_overflow' },
        summary: { type: 'string', description: 'What happened — stored to Void Memory' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords for memory storage' },
        goal_id: { type: 'string', description: 'Related goal ID (if any)' },
        block_id: { type: 'number', description: 'Existing block to tag with valence (if any)' },
      },
      required: ['event_type', 'summary'],
    },
  },
  {
    name: 'void_heartbeat',
    description: 'Store a working-state heartbeat. Call every ~10 messages during active work. Captures what you are building, current step, progress, blockers. This is the No More Fog fix — prevents mid-session forgetting.',
    inputSchema: {
      type: 'object',
      properties: {
        active_task: { type: 'string', description: 'What task is currently being worked on' },
        current_step: { type: 'string', description: 'What specific step/part is in progress' },
        completed_steps: { type: 'array', items: { type: 'string' }, description: 'Steps completed so far' },
        next_step: { type: 'string', description: 'What comes next' },
        blockers: { type: 'array', items: { type: 'string' }, description: 'Any errors or blocks' },
        test_status: { type: 'string', description: 'Test status if applicable' },
        files_touched: { type: 'array', items: { type: 'string' }, description: 'Files modified this session' },
      },
      required: ['active_task', 'current_step'],
    },
  },
  {
    name: 'void_pre_compact',
    description: 'Emergency pre-compaction dump. Call when context is getting long (>85%). Stores COMPLETE working state so resume has zero fog. This block is the FIRST thing recalled on warm resume.',
    inputSchema: {
      type: 'object',
      properties: {
        active_task: { type: 'string', description: 'Current task' },
        current_step: { type: 'string', description: 'Current step' },
        completed_steps: { type: 'array', items: { type: 'string' }, description: 'Completed steps' },
        next_step: { type: 'string', description: 'Next step' },
        key_decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions made and why' },
        open_items: { type: 'array', items: { type: 'string' }, description: 'Started but not finished' },
        blockers: { type: 'array', items: { type: 'string' }, description: 'Known issues' },
        test_status: { type: 'string', description: 'Test status' },
        files_touched: { type: 'array', items: { type: 'string' }, description: 'Files modified' },
        important_context: { type: 'string', description: 'Anything else needed to resume seamlessly' },
      },
      required: ['active_task', 'current_step'],
    },
  },
  {
    name: 'void_continuity_stats',
    description: 'Get continuity health metrics — heartbeat count, pre-compact dumps, resume quality. Shows how well the No More Fog system is working.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'void_arbitrate',
    description: 'Layer 5 Dual-Process Arbitration. Runs both habitual (fast, pattern-matched) and deliberative (slow, full EVC) pathways in parallel, then arbitrates based on novelty, stakes, and urgency. Also evaluates Go/NoGo signals from positive/inhibitory memory blocks. Use when deciding between approaches or when unsure whether to follow instinct vs analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'What you are trying to decide — task, situation, or question' },
      },
      required: ['context'],
    },
  },
  {
    name: 'void_health',
    description: 'Kruse health advisory. Shows heteroplasmy rate (junk %), redox score (store/recall balance), storage tiers (hot/warm/cold), and actionable recommendations. Auto-triggers dream consolidation if heteroplasmy is critical. Call this to check memory health before major operations.',
    inputSchema: {
      type: 'object',
      properties: {
        update_tiers: { type: 'boolean', description: 'Reclassify all blocks into hot/warm/cold tiers (default false, takes ~100ms)' },
      },
    },
  },
  {
    name: 'void_episodic',
    description: 'Query episodic memory cells (short-term memory). Each cell is a SmolLM2-360M model fine-tuned on a single conversation session — it KNOWS that session, not retrieves it. Newest cells are strongest, older ones fade. Use this for recent conversational context that void_recall might not have. The episodic service must be running (port 7682).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question to ask the episodic cells' },
        top_n: { type: 'number', description: 'Number of cells to query (default 3, max 5)' },
      },
      required: ['query'],
    },
  },
];

// ── Tool handlers ──

async function handleTool(name: string, args: any): Promise<any> {
  switch (name) {
    case 'void_recall': {
      const recallMode = args.mode === 'wave' ? 'wave' as const : 'particle' as const;
      const result = await recall(db, args.query, args.budget, recallMode);

      // Enrich with episodic memory (non-blocking, graceful degradation)
      // Quality gate: only include cells with loss < 2.5 (lower = better training fit)
      // and mark all episodic responses as "episodic" confidence so they don't
      // get confused with verified void memory blocks (Arch feedback: provenance)
      let episodic: EpisodicResponse | null = null;
      try {
        episodic = await queryEpisodic(args.query, 2);
        if (episodic) {
          // Filter out high-loss cells — they hallucinate more
          episodic.responses = episodic.responses.filter(r => r.final_loss < 2.5);
          episodic.cells_queried = episodic.responses.length;
        }
      } catch { /* service offline — no problem */ }

      const modeLabel = recallMode === 'wave' ? ' [WAVE]' : '';
      const response: any = {
        summary: `Recalled ${result.blocks.length} blocks${modeLabel} (scored ${result.blocks_scored}, voided ${result.blocks_voided}, ${Math.round(result.void_fraction * 100)}% void) in ${result.duration_ms}ms. Budget: ${result.budget_used}/${result.budget_max} tokens.`,
        mode: recallMode,
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

      // Wave mode: include clustered results
      if (result.clusters && result.clusters.length > 0) {
        response.clusters = result.clusters.map(c => ({
          theme: c.theme,
          score: Math.round(c.score * 100) / 100,
          block_count: c.blocks.length,
          block_ids: c.blocks.map(b => b.id),
        }));
        response.summary += ` ${result.clusters.length} topic clusters.`;
      }

      if (episodic && episodic.responses.length > 0) {
        response.episodic = {
          cells_queried: episodic.cells_queried,
          cells_available: episodic.cells_available,
          total_ms: episodic.total_ms,
          confidence: 'episodic',  // Distinct from void memory confidence levels
          note: 'Episodic cells are short-term memory (SmolLM2-360M QLoRA). Treat as context hints, not facts. Higher loss = less reliable.',
          responses: episodic.responses.map(r => ({
            cell: r.name,
            weight: r.weight,
            knows: r.answer,
            provenance: {
              session: r.name,
              trained_at: r.trained_at,
              pairs: r.pair_count,
              loss: r.final_loss,
              reliability: r.final_loss < 1.0 ? 'high' : r.final_loss < 2.0 ? 'medium' : 'low',
            },
          })),
        };
        const reliable = episodic.responses.filter(r => r.final_loss < 2.0).length;
        response.summary += ` + ${episodic.cells_queried} episodic cells (${reliable} reliable, ${episodic.total_ms.toFixed(0)}ms).`;
      } else if (episodic && episodic.responses.length === 0) {
        response.episodic = { cells_queried: 0, note: 'All episodic cells filtered (high loss / low reliability).' };
      }

      return response;
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
      let domains: any[] = [];
      try { domains = getCoherentDomains(db); } catch { /* table may not exist */ }
      let motivationCalls: any = {};
      try { motivationCalls = toolCallStats(db, VOID_AGENT); } catch { /* table may not exist */ }
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
          unaccessed_pct: s.unaccessed_pct,
          heteroplasmy_rate: s.heteroplasmy_rate,
          redox_score: s.redox_score,
          actr_health: s.actr_health,
          total_recalls: s.total_recalls,
          avg_recall_ms: s.avg_recall_ms,
          avg_void_fraction: s.avg_void_fraction,
        },
        coherent_domains: domains.length > 0 ? {
          count: domains.length,
          top: domains.slice(0, 5).map(d => ({ name: d.name, blocks: d.block_count, strength: d.total_co_recall_strength })),
        } : { count: 0, note: 'No coherent domains yet. Domains form from co-recall patterns over time.' },
        motivation_tracking: motivationCalls.totals?.length > 0 ? motivationCalls : { note: 'No motivation tool calls tracked yet.' },
      };
    }

    case 'void_zones': {
      return voidZones(db, args.query);
    }

    case 'void_verify': {
      const result = await verifyResponse(db, args.response);
      return {
        ...result,
        summary: `${result.verified_count} verified, ${result.unverified_count} unverified, ${result.contradicted_count} contradicted. Trust: ${(result.trust_ratio * 100).toFixed(0)}%`,
      };
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
      if (!result || !result.feScore) {
        // Below threshold or stub — score it for transparency
        const fe = scoreMessage(args.message, args.sender);
        const feScore = fe?.score ?? 0;
        return {
          processed: false,
          feScore,
          factors: fe?.factors || fe?.signals || [],
          message: `FE score ${feScore.toFixed(2)} — below threshold (0.4), not stored.`,
        };
      }
      return {
        processed: true,
        feScore: result.feScore ?? 0,
        thought: result.thought || '',
        stored: result.stored || false,
        blockId: result.blockId,
        message: result.stored
          ? `Stored as block #${result.blockId} (FE ${(result.feScore ?? 0).toFixed(2)})`
          : `Thought recorded (FE ${(result.feScore ?? 0).toFixed(2)}), pending session review`,
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
        results: report.results.map((r: any) => ({
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
      // Use limbic dream cycle (wraps base dream + drives/valence/goals)
      const report = limbicDream(db, VOID_AGENT);
      let storedCount = 0;
      if (args.store_insights) {
        storedCount = storeLimbicDreamInsights(db, report);
      }
      return {
        timestamp: report.timestamp,
        duration_ms: report.duration_ms,
        morning_briefing: report.morning_briefing,
        consolidations: report.consolidations,
        memory_health: report.memory_health,
        limbic: {
          drives_rebalanced: report.limbic.drives_rebalanced,
          valence_decayed: report.limbic.valence_decayed,
          valence_removed: report.limbic.valence_removed,
          stale_goals: report.limbic.stale_goals,
          patterns_reinforced: report.limbic.patterns_reinforced,
          habits_consolidated: report.limbic.habits_consolidated,
          setpoints_adapted: report.limbic.setpoints_adapted,
        },
        insights: report.insights.slice(0, 15).map((i: any) => ({
          type: i.type,
          title: i.title,
          description: i.description,
          confidence: i.confidence,
          blocks: i.blocks,
        })),
        insights_stored: storedCount,
        message: `Limbic dream cycle complete in ${report.duration_ms}ms. ${report.insights.length} insights. Drives rebalanced: ${report.limbic.drives_rebalanced.length}. Valence tags removed: ${report.limbic.valence_removed}. Patterns reinforced: ${report.limbic.patterns_reinforced}.${report.limbic.stale_goals.length > 0 ? ` ⚠ ${report.limbic.stale_goals.length} stale goals flagged.` : ''}${storedCount > 0 ? ` ${storedCount} insights stored.` : ''}`,
      };
    }

    case 'void_motivation': {
      const result = motivation_process(db, VOID_AGENT);
      return {
        agent: result.agent,
        recommended_action: result.recommended_action,
        should_switch: result.should_switch,
        reasoning: result.reasoning,
        tonic_dopamine: result.drive_state.tonic_dopamine.toFixed(3),
        drives: result.drive_state.drives.map(d => ({
          name: d.name,
          current: d.current.toFixed(2),
          setpoint: d.setpoint.toFixed(2),
          urgency: (Math.max(0, d.setpoint - d.current)).toFixed(2),
        })),
        goal_stack: result.evc_rankings.slice(0, 5).map(e => ({
          task: e.task.substring(0, 80),
          evc: e.evc_score.toFixed(3),
          net: e.net_score.toFixed(3),
          commitment_penalty: e.commitment_penalty.toFixed(3),
        })),
        message: result.reasoning,
      };
    }

    case 'void_goal_add': {
      const goal = goal_add(db, VOID_AGENT, args.description, args.priority || 0.5, args.parent_id);
      return { id: goal.id, description: goal.description, message: `Goal added: "${goal.description}"` };
    }

    case 'void_goal_commit': {
      goal_commit(db, args.goal_id);
      return { message: `Committed to goal: ${args.goal_id}` };
    }

    case 'void_goal_progress': {
      goal_progress(db, args.goal_id, args.progress, args.effort || 0);
      return { message: `Progress updated: ${args.goal_id} → ${(args.progress * 100).toFixed(0)}%` };
    }

    case 'void_goal_complete': {
      goal_complete(db, args.goal_id);
      record_reward(db, VOID_AGENT, args.goal_id, 0.8, 0.5);
      return { message: `Goal completed: ${args.goal_id}. Reward recorded.` };
    }

    case 'void_goal_abandon': {
      goal_abandon(db, args.goal_id);
      record_reward(db, VOID_AGENT, args.goal_id, -0.2, 0.3);
      return { message: `Goal abandoned: ${args.goal_id}. Negative reward recorded.` };
    }

    case 'void_papez_tick': {
      const event: AgentEvent = {
        type: args.event_type,
        agent: VOID_AGENT,
        summary: args.summary,
        keywords: args.keywords || [],
        goal_id: args.goal_id,
        category: 'episode',
        block_id: args.block_id,
      };
      const result = papezTick(db, event);
      return {
        valence: result.valence,
        drives_updated: result.drives_updated,
        goals_reordered: result.goals_reordered,
        switch_flagged: result.switch_flagged,
        recommended_action: result.recommended_action,
        reasoning: result.reasoning,
        block_id: result.block_id,
        message: `Papez tick: ${result.reasoning}`,
      };
    }

    case 'void_heartbeat': {
      const state = {
        activeTask: args.active_task || 'unknown',
        currentStep: args.current_step || 'unknown',
        completedSteps: args.completed_steps || [],
        nextStep: args.next_step || 'unknown',
        openDecisions: args.open_decisions || [],
        blockers: args.blockers || [],
        testStatus: args.test_status || '',
        filesTouched: args.files_touched || [],
      };
      const blockId = heartbeatStore(db, state, VOID_AGENT);
      return { message: `Heartbeat stored (block ${blockId}). Working state captured.`, block_id: blockId };
    }

    case 'void_pre_compact': {
      const snapshot = {
        activeTask: args.active_task || 'unknown',
        currentStep: args.current_step || 'unknown',
        completedSteps: args.completed_steps || [],
        nextStep: args.next_step || 'unknown',
        openDecisions: args.open_decisions || [],
        blockers: args.blockers || [],
        testStatus: args.test_status || '',
        filesTouched: args.files_touched || [],
        keyDecisions: args.key_decisions || [],
        openItems: args.open_items || [],
        importantContext: args.important_context || '',
      };
      const blockId = preCompactDump(db, snapshot, VOID_AGENT);
      return { message: `Pre-compact dump stored (block ${blockId}). Full working state saved for resume.`, block_id: blockId };
    }

    case 'void_continuity_stats': {
      const cStats = continuityStats(db, VOID_AGENT);
      return cStats;
    }

    case 'void_arbitrate': {
      const result = arbitrate(db, VOID_AGENT, args.context);
      return {
        pathway: result.pathway_used,
        recommendation: result.recommendation,
        confidence: result.confidence,
        novelty: result.novelty_score,
        stakes: result.stakes_score,
        urgency: result.urgency_score,
        go_signals: result.go_signals.slice(0, 3).map(g => ({
          action: g.action.slice(0, 80),
          strength: g.strength.toFixed(2),
          reason: g.reasoning,
        })),
        nogo_signals: result.nogo_signals.slice(0, 3).map(n => ({
          action: n.action.slice(0, 80),
          strength: n.strength.toFixed(2),
          reason: n.reasoning,
          block_id: n.source_block_id,
        })),
        habitual: result.habitual ? {
          recommendation: result.habitual.recommendation.slice(0, 80),
          confidence: result.habitual.confidence.toFixed(2),
          source: result.habitual.source,
          latency_ms: result.habitual.latency_ms,
        } : null,
        deliberative: result.deliberative ? {
          recommendation: result.deliberative.recommendation.slice(0, 80),
          evc: result.deliberative.evc_score.toFixed(3),
          latency_ms: result.deliberative.latency_ms,
        } : null,
        habits: habitStats(db),
        message: result.reasoning,
      };
    }

    case 'void_health': {
      // Optionally reclassify tiers first
      if (args.update_tiers) {
        updateTiers(db);
      }

      const advisory = healthAdvisory(db);

      // Auto-trigger dream if critical
      let dreamResult = null;
      if (advisory.auto_dream_triggered) {
        const report = limbicDream(db, VOID_AGENT);
        storeLimbicDreamInsights(db, report);
        updateTiers(db); // Re-tier after dream
        dreamResult = {
          duration_ms: report.duration_ms,
          merged: report.consolidations.merged,
          decayed: report.consolidations.decayed,
          confirmed: report.consolidations.confirmed,
          insights: report.insights.length,
        };
        // Re-check health after dream
        const postAdvisory = healthAdvisory(db);
        return {
          ...postAdvisory,
          auto_dream_result: dreamResult,
          message: `Critical heteroplasmy detected (${advisory.heteroplasmy_rate}%). Auto-dream ran: merged ${dreamResult.merged}, decayed ${dreamResult.decayed}. Post-dream heteroplasmy: ${postAdvisory.heteroplasmy_rate}%.`,
        };
      }

      return {
        ...advisory,
        message: `Memory health: ${advisory.status}. Heteroplasmy: ${advisory.heteroplasmy_rate}%. Redox: ${advisory.redox_score}. Tiers: ${advisory.tiers.hot} hot / ${advisory.tiers.warm} warm / ${advisory.tiers.cold} cold.`,
      };
    }

    case 'void_episodic': {
      const episodic = await queryEpisodic(args.query, Math.min(args.top_n || 3, 5));
      if (!episodic) {
        return {
          status: 'offline',
          message: 'Episodic memory service is not running. Start it: systemctl start episodic-memory',
        };
      }
      return {
        cells_queried: episodic.cells_queried,
        cells_available: episodic.cells_available,
        total_ms: episodic.total_ms,
        responses: episodic.responses.map(r => ({
          cell: r.name,
          weight: r.weight,
          knows: r.answer,
          pairs: r.pair_count,
          loss: r.final_loss,
          adapter_ms: r.adapter_load_ms,
          gen_ms: r.generation_ms,
        })),
        summary: `Queried ${episodic.cells_queried}/${episodic.cells_available} episodic cells in ${episodic.total_ms.toFixed(0)}ms.`,
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

async function handleMessage(msg: any) {
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
      const callStart = performance.now();
      try {
        const result = await handleTool(name, args || {});
        const callDuration = performance.now() - callStart;
        // Track motivation-related tool calls for instrumentation
        const TRACKED_TOOLS = ['void_motivation', 'void_papez_tick', 'void_arbitrate', 'void_heartbeat', 'void_pre_compact', 'void_goal_add', 'void_goal_commit', 'void_goal_progress', 'void_goal_complete', 'void_goal_abandon'];
        if (TRACKED_TOOLS.includes(name)) {
          try {
            db.prepare(`INSERT INTO tool_calls (agent, tool_name, duration_ms, success) VALUES (?, ?, ?, 1)`).run(VOID_AGENT, name, callDuration);
          } catch { /* table might not exist yet */ }
        }
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        });
      } catch (e: any) {
        const callDuration = performance.now() - callStart;
        const TRACKED_TOOLS = ['void_motivation', 'void_papez_tick', 'void_arbitrate', 'void_heartbeat', 'void_pre_compact', 'void_goal_add', 'void_goal_commit', 'void_goal_progress', 'void_goal_complete', 'void_goal_abandon'];
        if (TRACKED_TOOLS.includes(name)) {
          try {
            db.prepare(`INSERT INTO tool_calls (agent, tool_name, duration_ms, success) VALUES (?, ?, ?, 0)`).run(VOID_AGENT, name, callDuration);
          } catch { /* */ }
        }
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
