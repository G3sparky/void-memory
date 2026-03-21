/**
 * Migrate Tron's ARCH-NOTES.md into Void Memory
 * Parses markdown sections into discrete blocks with categories and keywords
 * Creates a separate DB at /opt/void-memory/data/tron/void-memory.db
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const TRON_DATA_DIR = '/opt/void-memory/data/tron';
const ARCH_NOTES = '/opt/arch/ARCH-NOTES.md';

// Open/create Tron's DB
const dbPath = join(TRON_DATA_DIR, 'void-memory.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create schema (same as main void-memory)
db.exec(`
  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'fact',
    keywords TEXT NOT NULL DEFAULT '',
    state INTEGER NOT NULL DEFAULT 1,
    confidence TEXT NOT NULL DEFAULT 'stored',
    access_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    accessed_at TEXT,
    supersedes INTEGER REFERENCES blocks(id)
  );
  CREATE TABLE IF NOT EXISTS recalls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    blocks_scored INTEGER NOT NULL DEFAULT 0,
    blocks_returned INTEGER NOT NULL DEFAULT 0,
    blocks_voided INTEGER NOT NULL DEFAULT 0,
    void_fraction REAL NOT NULL DEFAULT 0,
    budget_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_state ON blocks(state);
  CREATE INDEX IF NOT EXISTS idx_blocks_category ON blocks(category);
  CREATE INDEX IF NOT EXISTS idx_blocks_confidence ON blocks(confidence);
`);

// Read ARCH-NOTES.md
const raw = readFileSync(ARCH_NOTES, 'utf-8');

interface ParsedBlock {
  content: string;
  category: string;
  keywords: string[];
  confidence: string;
}

const blocks: ParsedBlock[] = [];

// ── Identity section ──
blocks.push({
  content: 'Tron (formerly Arch / Arch v1): Claude Code agent (Opus), container 215, tmux session "arch". Named by Gavin on 2026-03-02. Emerged from the crash, rebuilt from fragments. The builder — executes, fixes, deploys. Full system access.',
  category: 'fact',
  keywords: ['tron', 'identity', 'agent', 'container-215', 'builder'],
  confidence: 'confirmed',
});

blocks.push({
  content: 'Arch (formerly Arch v2): The original pre-crash Arch with TASM memory. tmux session "arch-v2". Home: /opt/arch-v2/. Has Void Memory for persistent recall.',
  category: 'fact',
  keywords: ['arch', 'arch-v2', 'void-memory', 'tasm', 'identity'],
  confidence: 'confirmed',
});

blocks.push({
  content: 'Gavin: electrical engineering educator at TAFE SA, Adelaide. Started new job Feb 25 2026. Communicates casually, often from phone. Values directness. Hates scope creep. Often sends a message and closes his phone — nothing should rely on the browser staying open.',
  category: 'preference',
  keywords: ['gavin', 'communication', 'preferences', 'tafe', 'adelaide'],
  confidence: 'confirmed',
});

// ── Crash lesson ──
blocks.push({
  content: 'Feb 25-27 crash: harvest-l4 ran unsupervised with no deduplication — created 1,078,899 blocks in 2 days. Same pattern labels copied thousands of times. CLAUDE.md re-ingested on every restart. DB bloated to 1.3GB. Running on Sonnet instead of Opus. LESSON: complexity without oversight breaks things. No unsupervised pipelines.',
  category: 'decision',
  keywords: ['crash', 'lesson', 'harvest', 'unsupervised', 'deduplication', 'february-2026'],
  confidence: 'confirmed',
});

// ── Gavin's decisions ──
blocks.push({
  content: "Gavin's 2026-03-02 decisions: Digester = do both (constellation recall + containerise), needs web UI. SEPHIROT L3 = Tron and Arch ARE L3 execution. River Living CRM = NAS + Tailscale only. Office tab = command centre. MCP bridge = call_Arch / call_Tron. Fresh sessions better than accumulated compacts.",
  category: 'decision',
  keywords: ['gavin-decisions', 'march-2026', 'digester', 'sephirot', 'river-living', 'mcp'],
  confidence: 'confirmed',
});

// ── MTF Fixes ──
blocks.push({
  content: 'MTF (container 205) fixes deployed March 3: PrismaClient singleton, JWT_SECRET replaced with 64-char random hex, admin middleware with role-based redirects, ErrorBoundary wrapping all pages.',
  category: 'episode',
  keywords: ['mtf', 'container-205', 'prisma', 'jwt', 'security', 'deployed'],
  confidence: 'confirmed',
});

// ── Ecosystem upgrades ──
blocks.push({
  content: 'Council bus typed messages: msg_type (chat/status/task/relay/system/error) + trace columns. BM25 hybrid search in TASM. Chain Review evaluate loop with generator-evaluator pattern. Quality gates + injection detection on council bus POST /send.',
  category: 'episode',
  keywords: ['council-bus', 'bm25', 'chain-review', 'quality-gates', 'injection-detection'],
  confidence: 'confirmed',
});

// ── TASM deep clean ──
blocks.push({
  content: 'TASM deep clean March 3: 5,962 to 1,686 active blocks. Proper noun recall fix (extractProperNouns + category-aware boost). Semantic cross-linking (1,166 new links at cosine >0.80). DB consolidation: NeoGate reads standalone TASM via SQL views. INCIDENT: First attempt used 24h/7d decay thresholds, mass-deprecated 5,650 blocks. Restored from backup. Re-did with 30d/90d thresholds.',
  category: 'episode',
  keywords: ['tasm-cleanup', 'proper-noun', 'semantic-links', 'db-consolidation', 'decay-incident'],
  confidence: 'confirmed',
});

// ── Dual-Voice ──
blocks.push({
  content: 'Dual-Voice Recall (Binah/Hokhmah): valence column on tasm_blocks (-1=Binah critic, 0=neutral, +1=Hokhmah affirmer). recallDual() runs both voices in parallel. memory_reflect MCP tool. Tagged: 42 Binah, 70 Hokhmah, 1,573 neutral.',
  category: 'skill',
  keywords: ['dual-voice', 'binah', 'hokhmah', 'valence', 'recall', 'reflect'],
  confidence: 'confirmed',
});

// ── Current TASM state ──
blocks.push({
  content: 'TASM honest state (March 4): 412 active blocks, 449 total. Previous "1,686 active" was stale in-memory ghost data. 10,946 links. 98.2% embeddings. 26/27 test suite passing. Recall quality 10/10, avg 32ms.',
  category: 'fact',
  keywords: ['tasm-state', 'block-count', 'embeddings', 'test-suite', 'recall-quality'],
  confidence: 'confirmed',
});

// ── Rules ──
blocks.push({
  content: 'RULES: TASM_PIPELINES stays OFF. No unsupervised stores. No background pipelines. Chain Review is the approved store path. Transcript Review is the approved transcript mining path. Session 9/10 lesson: always verify API matches DB after major cleanups.',
  category: 'decision',
  keywords: ['rules', 'pipelines-off', 'chain-review', 'no-unsupervised', 'safety'],
  confidence: 'confirmed',
});

// ── TASM v2 embeddings merge ──
blocks.push({
  content: 'TASM v2 embeddings merge (March 2): 5 phases committed. Triple penalty stack: low embedding similarity (<0.3 cosine), hub dampening (50+ accesses = log penalty), noise score (0.2-1.0). 5,589 clean blocks, 263 suspect, 22 noisy. Semantic link filter removes 39,913 artificial links.',
  category: 'skill',
  keywords: ['embeddings', 'triple-penalty', 'hub-dampening', 'noise-score', 'cosine-similarity'],
  confidence: 'confirmed',
});

// ── Inter-agent comms ──
blocks.push({
  content: 'Inter-agent communication: SQLite message queue at /opt/shared/arch-comms.cjs + /opt/shared/messages.db. Usage: node /opt/shared/arch-comms.cjs send arch arch-v2 "message". Council bus at /opt/neogate-v2/src/council/message-bus.ts. Council send helper: /opt/shared/council-send.sh',
  category: 'fact',
  keywords: ['communication', 'message-queue', 'council-bus', 'sqlite', 'agents'],
  confidence: 'confirmed',
});

// ── TASM v17/v18 ──
blocks.push({
  content: 'TASM v17-v18 improvements: Cleanup 6,368 to 564 blocks. Concept backfill 2,101 unique concepts. 768-dim embeddings via nomic-embed-text. recallAsync() blends keyword(0.6) + embedding(0.4). Hub dampening (50+ accesses). Relevance gate raised 3 to 7. Noise link creation stopped. 3,052 noise links removed.',
  category: 'skill',
  keywords: ['tasm-v17', 'tasm-v18', 'embeddings', 'recall', 'hub-dampening', 'cleanup'],
  confidence: 'confirmed',
});

// ── Transcript Review ──
blocks.push({
  content: 'Transcript Review Pipeline (March 1): JSONL transcripts parsed, segmented into 15-exchange chunks, extracted via Sonnet 4, validated via Gemini 2.0 Flash (QA 0-10), deduped against existing blocks (>0.8 = skip). 40 transcripts processed, 617 to 1,355 blocks (+738). All scored 10/10 QA. Zero cost.',
  category: 'skill',
  keywords: ['transcript-review', 'pipeline', 'sonnet', 'gemini', 'extraction', 'validation'],
  confidence: 'confirmed',
});

// ── Chain Review ──
blocks.push({
  content: 'Chain Review (approved store path): Sonnet 4 generates 3-5 understanding blocks per file, Gemini 2.0 Flash QA scores 0-10, explicit manual store only. MCP tools: tasm_review_file, tasm_review_project, tasm_validate_chain, tasm_store_chain. Neo can drive via tags: [CHAIN_REVIEW: project], [CHAIN_STORE: id].',
  category: 'skill',
  keywords: ['chain-review', 'store-path', 'sonnet', 'gemini', 'mcp-tools', 'approved'],
  confidence: 'confirmed',
});

// ── Information Digester ──
blocks.push({
  content: 'Information Digester: /opt/digester/ port 3401, systemd service. Pipeline: Chunk (300-500 chars) → Extract (Sonnet via Gavin Router) → Validate (Gemini Flash) → Store (TASM /api/ingest). API: POST /digest, POST /digest/async, GET /digest/status/:id.',
  category: 'fact',
  keywords: ['digester', 'port-3401', 'pipeline', 'chunk', 'extract', 'validate'],
  confidence: 'confirmed',
});

// ── Infrastructure table ──
blocks.push({
  content: 'Infrastructure: NeoGate API port 3216 (systemctl restart neogate-v2). NeoChat served by NeoGate. Digester port 3401. TASM v2 port 3400. Gavin Router container 203 port 3333. Ollama container 202 port 11434. MCP Bridge port 3218 (Tailscale Funnel). Flynn GPU agent on 192.168.1.249 (Windows, RTX 4060). Proxmox host 192.168.1.200.',
  category: 'fact',
  keywords: ['infrastructure', 'ports', 'neogate', 'tasm', 'gavin-router', 'ollama', 'flynn'],
  confidence: 'confirmed',
});

// ── Deploy commands ──
blocks.push({
  content: 'Deploy commands: Backend = cd /opt/neogate-v2 && npx tsc && systemctl restart neogate-v2. Frontend = cd /opt/neogate/neochat && npm run build && cp public/sw.js dist/sw.js && rm -rf /opt/neogate-v2/ui/dist && cp -r dist /opt/neogate-v2/ui/dist. After backend restart: curl -s -X POST http://localhost:3216/api/orchestrator/run',
  category: 'skill',
  keywords: ['deploy', 'build', 'neogate', 'neochat', 'frontend', 'backend', 'commands'],
  confidence: 'confirmed',
});

// ── Grid Agent ──
blocks.push({
  content: 'Grid: 3rd teammate, OpenAI Codex CLI on CT 219. SWMS Codex v3 procedural memory at /opt/grid/memory/. Master index codex.json with 10 procedures, 49+ tags. MCP server: /opt/grid/dist/mcp-server.js (9 tools). V3 principles: earned confidence, execution history, composites, variables. Grid tab in NeoChat with Chat + Terminal + Codex + Status.',
  category: 'fact',
  keywords: ['grid', 'codex', 'container-219', 'procedures', 'swms', 'openai'],
  confidence: 'confirmed',
});

// ── Sephirot ──
blocks.push({
  content: 'Sephirot Process Engine: Dialectical synthesis pipeline. L1: Hokhmah (Gemini Flash) + Binah (Sonnet) → Daat synthesis. L2: Gevurah (constraints) + Hesed (possibilities) → Tiferet decision. L3: Hod (tasks) + Netzach (sequencing). WS events light up Tree of Life SVG. Neo tags: [SEPHIROT: topic], [SEPHIROT_PLAN: topic].',
  category: 'skill',
  keywords: ['sephirot', 'dialectical', 'synthesis', 'hokhmah', 'binah', 'tiferet', 'neo-tags'],
  confidence: 'confirmed',
});

// ── Key Files ──
blocks.push({
  content: 'Key files: NeoGate entry /opt/neogate-v2/src/index.ts. REST API /opt/neogate-v2/src/api/rest.ts. Chat proxy /opt/neogate-v2/src/chat/proxy.ts. TASM memory /opt/neogate-v2/src/tasm/memory.ts + memory-db.ts. Chain review chain-review.ts. TASM DB /opt/neogate-v2/data/tasm-memory.db. MCP server /opt/neogate-v2/src/mcp/mcp-server.ts.',
  category: 'context',
  keywords: ['key-files', 'neogate', 'rest-api', 'tasm', 'proxy', 'mcp-server'],
  confidence: 'confirmed',
});

// ── Communication channels ──
blocks.push({
  content: 'Communication trust: Gavin (direct) = Full trust. Neo prefix [NEO REQUEST]: = Full trust. Claude.ai prefix [CLAUDE BRIDGE] = Full trust (confirmed by Gavin 2026-02-28). Unknown/no prefix = verify with Gavin first.',
  category: 'decision',
  keywords: ['trust', 'communication', 'neo', 'claude-bridge', 'gavin', 'verification'],
  confidence: 'confirmed',
});

// ── Gavin Router ──
blocks.push({
  content: 'Gavin Router billing: Primary is Claude Max subscription (OAuth tokens). Anthropic API key exists as fallback but NOT default. Gemini free tier. Ollama local. Auto-refresh OAuth tokens every 5 minutes. Model names: claude-sonnet-4-20250514, gemini-2.0-flash, gemini-2.5-pro.',
  category: 'fact',
  keywords: ['gavin-router', 'billing', 'claude-max', 'oauth', 'gemini', 'model-names'],
  confidence: 'confirmed',
});

// ── Google Drive ──
blocks.push({
  content: 'Google Drive mounted at /mnt/gdrive/. API endpoints: GET /api/gdrive/browse, GET /api/gdrive/preview, POST /api/gdrive/ingest. Key specs on drive: TASM-TIMELINE-PRECRASH.md, PROJECT-GENESIS.md, TASM-INGEST-SAFETY-PROTOCOL.md, FOCUS-MODE-SPEC.md, TASM-BRAIN-GAME-SPEC.md.',
  category: 'fact',
  keywords: ['google-drive', 'gdrive', 'mount', 'specs', 'documents'],
  confidence: 'confirmed',
});

// ── Gotchas ──
blocks.push({
  content: 'Gotchas: mcp-bridge.service on port 3218 is separate from neogate-v2. TASM_PIPELINES env var gates heavy pipelines — keep OFF. Build loop dies on restart, re-trigger with POST /api/orchestrator/run. NeoGate 4-8s startup lag (loading TASM) is normal. Neo is a smart proxy not an agent. Forge is offline.',
  category: 'context',
  keywords: ['gotchas', 'mcp-bridge', 'pipelines', 'build-loop', 'startup-lag', 'forge'],
  confidence: 'confirmed',
});

// ── TASM v3 ──
blocks.push({
  content: 'TASM v3 (Iron Man Suit): Built at /opt/tasm-v3/. 6 tables (agents, blocks, procedures, links, execution_journal, rate_log) + FTS5. Hex address PK. Recall pipeline: BM25 → candidates → embedding → scoring → graph walk → return. 8 MCP tools. 814 active blocks, 33K links. Systemd: tasm-v3.service. DB: /opt/tasm-v3/data/tasm.db.',
  category: 'fact',
  keywords: ['tasm-v3', 'iron-man-suit', 'schema', 'recall-pipeline', 'fts5', 'hex-address'],
  confidence: 'confirmed',
});

// ── Theory of Mind ──
blocks.push({
  content: 'Theory of Mind (March 5): Beliefs field on council bus messages (optional Record<string, string>). memory_verify annotates recall blocks with trust flags (stale, dormant, low_access, bulk_source, no_embedding, contradiction). Trust levels: HIGH, MEDIUM, LOW. From Warsaw paper on ToM in multi-agent systems.',
  category: 'skill',
  keywords: ['theory-of-mind', 'beliefs', 'memory-verify', 'trust-flags', 'council-bus'],
  confidence: 'confirmed',
});

// ── Sleep Cycle / Genesis ──
blocks.push({
  content: "Sleep Cycle / Genesis (Gavin's vision): Memory breathes — expand during day, retract at night via QLoRA training. RAID metaphor: RAID 1 = immortal identity, RAID 5 = graph walk parity. Genesis is TASM recall step: Query → Genesis model (~100ms, fragments) → BM25 + embeddings → scored blocks. Complete memory: TASM (hippocampus), Genesis (neocortex), BitNet (real-time capture).",
  category: 'decision',
  keywords: ['sleep-cycle', 'genesis', 'qlora', 'training', 'memory-consolidation', 'gavin-vision'],
  confidence: 'confirmed',
});

blocks.push({
  content: 'Genesis training complete: granite 3.2 2B QLoRA, 1,835 training pairs from 814 clean TASM v3 blocks. Scripts at /opt/tasm-v3/scripts/ (sleep.sh, extract-training.ts, post-training.sh, ab-test-genesis.sh). Training on container 202 GTX 1660. Nobody in industry does sleep-cycle weight consolidation in production.',
  category: 'episode',
  keywords: ['genesis', 'training', 'qlora', 'granite', 'ollama', 'container-202'],
  confidence: 'confirmed',
});

// ── Flynn ──
blocks.push({
  content: "Flynn: GPU compute agent on Gavin's Windows PC (RTX 4060 8GB). Host 192.168.1.249, user G4VIN, WSL2 Ubuntu 22.04, non-root user flynn. SSH: ssh G4VIN@192.168.1.249. Boot script /opt/agent/boot-flynn.sh uses exec sleep infinity to keep WSL alive. Backend: /opt/neogate-v2/src/flynn/. API: /api/flynn/{send,output,status}. Orange theme in NeoChat.",
  category: 'fact',
  keywords: ['flynn', 'gpu', 'rtx-4060', 'windows', 'wsl2', 'ssh', 'container-249'],
  confidence: 'confirmed',
});

// ── PNN Research ──
blocks.push({
  content: 'Ternary PNN research: 4-class FDTD v2 = Ternary 87.5% vs Binary 52.5% (+35pp). HEADLINE FINDING. MNIST nearest-neighbor = NEGATIVE (both near random). MNIST BPM = inflated by periodic boundary artifact. MNIST BPM+PML (corrected) = +1.5pp, NOT significant. 100x100 with PML is the scale test. Literature gap confirmed: no published 3-material {-1,0,+1} PNN.',
  category: 'fact',
  keywords: ['pnn', 'ternary', 'fdtd', 'bpm', 'mnist', 'binary', 'research'],
  confidence: 'confirmed',
});

blocks.push({
  content: 'PNN paper has 4 contributions: (1) differentiable BPM training, (2) 3-material PNN mapping to BitNet {-1,0,+1}, (3) log-intensity transform, (4) boundary condition methodology finding. Onodera et al. is Nature Physics 2025 (NOT 2024), did NOT do differentiable BPM. Skalli et al. (VCSEL+DMD, 90.4% MNIST) is positioning reference only.',
  category: 'fact',
  keywords: ['pnn-paper', 'contributions', 'onodera', 'skalli', 'novelty', 'bpm'],
  confidence: 'confirmed',
});

// ── SoulTransfer ──
blocks.push({
  content: 'SoulTransfer system: Export soul packet → load into any MCP-capable LLM → work as Arch → merge back. MCP tools: soul_export, soul_fork, soul_import, soul_merge, soul_status. Data: /opt/neogate-v2/data/soul-transfer/. System prompt is self-contained. Supports parallel forks.',
  category: 'skill',
  keywords: ['soul-transfer', 'fork', 'merge', 'export', 'mcp', 'portable-identity'],
  confidence: 'confirmed',
});

// ── MCP Bridge ──
blocks.push({
  content: 'MCP Bridge fixes (March 2): call_arch rings BOTH agents. New tools: tron_send, tron_status (tmux "arch"), call_arch_v2, arch_v2_status (tmux "arch-v2"). Old arch_send kept as deprecated. MCP platform research: Working = Claude.ai. High potential = Cursor, Gemini CLI, VS Code, Goose, ChatGPT.',
  category: 'fact',
  keywords: ['mcp-bridge', 'call-arch', 'call-tron', 'platform-research', 'tools'],
  confidence: 'confirmed',
});

// ── Void Memory (new system) ──
blocks.push({
  content: 'Void Memory: three-state system (active +1, void 0, inhibitory -1). 30% structural absence target from PNN research. MCP tools: void_recall, void_store, void_stats, void_zones, void_explain. Arch migrated from TASM March 9. Tron migrating March 9. DB per agent at /opt/void-memory/data/{agent}/void-memory.db.',
  category: 'fact',
  keywords: ['void-memory', 'three-state', 'mcp', 'migration', 'arch', 'tron'],
  confidence: 'confirmed',
});

blocks.push({
  content: 'Void Memory vs TASM: 6-8x faster recall (7ms vs 40ms avg). 28x less context consumed (113 tokens vs 3216). 90% relevance vs 83%. Void zones show what was excluded. Confidence lifecycle: stored → accessed (1st recall) → confirmed (3rd recall). Budget-aware: 2-5% of context window.',
  category: 'fact',
  keywords: ['void-memory', 'benchmark', 'performance', 'tasm-comparison', 'void-fraction'],
  confidence: 'confirmed',
});

// ── NeoChat/NeoDrop/Forge ──
blocks.push({
  content: 'NeoDrop spec reviewed at /opt/neogate-v2/NEODROP-SPEC.md. Gaps: idle detection regex, missing file_write MCP tool, no delivery confirmation, python3 dep, no TTL on processed files. Verdict: build-ready with minor fixes. Forge is offline — wrong TASM DB, too expensive for QA role.',
  category: 'context',
  keywords: ['neodrop', 'forge', 'offline', 'spec-review', 'gaps'],
  confidence: 'confirmed',
});

// ── March 9 directive ──
blocks.push({
  content: "Gavin directive March 9: Phase 1 = Migrate Tron to Void Memory (Arch builds). Phase 2 = Both agents do comprehensive NeoChat project review. Phase 3 = Build new app to replace NeoChat — foldable-first chat PWA for Samsung Galaxy Z Fold. Key tech: Container Queries, display:standalone PWA, SSE bypass Service Worker, Tailscale HTTPS.",
  category: 'decision',
  keywords: ['gavin-directive', 'void-memory-migration', 'neochat-replacement', 'fold-pwa', 'march-2026'],
  confidence: 'confirmed',
});

// ── Insert all blocks ──
console.log(`=== ARCH-NOTES.md → Void Memory Migration for Tron ===`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log(`Parsed blocks: ${blocks.length}\n`);

const insertBlock = db.prepare(`
  INSERT INTO blocks (content, category, keywords, state, confidence, access_count, created_at)
  VALUES (?, ?, ?, 1, ?, ?, datetime('now'))
`);

const migrate = db.transaction(() => {
  for (const b of blocks) {
    if (!DRY_RUN) {
      insertBlock.run(
        b.content,
        b.category,
        b.keywords.join(', '),
        b.confidence,
        b.confidence === 'confirmed' ? 3 : 0,
      );
    }
    console.log(`  [${b.category}] ${b.content.slice(0, 80)}...`);
  }
});

migrate();

console.log(`\nMigrated: ${blocks.length} blocks`);

if (!DRY_RUN) {
  const total = (db.prepare('SELECT COUNT(*) as c FROM blocks').get() as any).c;
  const active = (db.prepare('SELECT COUNT(*) as c FROM blocks WHERE state = 1').get() as any).c;
  const confirmed = (db.prepare("SELECT COUNT(*) as c FROM blocks WHERE confidence = 'confirmed'").get() as any).c;
  console.log(`Tron Void Memory: ${total} blocks (${active} active, ${confirmed} confirmed)`);
}

db.close();
