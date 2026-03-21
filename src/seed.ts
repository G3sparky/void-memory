/**
 * Seed Void Memory with core ecosystem knowledge.
 * These are the facts any agent should be able to recall.
 */

import { openDB } from './db.js';
import { store } from './engine.js';

const db = openDB();

const seeds = [
  // ── Infrastructure ──
  { content: 'NeoGate API runs on container 215 port 3216. Source at /opt/neogate-v2/. Deploy: npx tsc && systemctl restart neogate-v2', keywords: ['neogate', 'api', 'port', 'deploy', 'infrastructure'], category: 'skill' },
  { content: 'NeoChat frontend built with Vite + Lit components. Build: npm run build in /opt/neogate/neochat/. Deploy to /opt/neogate-v2/ui/dist/', keywords: ['neochat', 'frontend', 'build', 'deploy', 'vite'], category: 'skill' },
  { content: 'TASM v2 standalone runs on port 3400 with systemd service tasm-v2. Database at /opt/tasm-v2/data/tasm.db. 3263 active blocks, 204K links.', keywords: ['tasm', 'memory', 'database', 'port', 'service'], category: 'fact' },
  { content: 'Gavin Router on container 203 port 3333 routes AI requests. Primary: Claude Max subscription (OAuth). Gemini: free tier. Anthropic API key exists as fallback.', keywords: ['gavin-router', 'api', 'claude', 'gemini', 'billing'], category: 'fact' },
  { content: 'Google Drive mounted at /mnt/gdrive/ on container 215. Filesystem mount, not API. Files copied there appear in Google Drive.', keywords: ['gdrive', 'google-drive', 'mount', 'filesystem', 'shared'], category: 'fact' },
  { content: 'Container 215 has 12GB RAM and 6 cores. Runs NeoGate, TASM v2, Digester, all agent tmux sessions except Flynn and Claw.', keywords: ['container', 'resources', 'ram', 'cores', 'proxmox'], category: 'fact' },
  { content: 'SSE endpoints use 20-second keepalive heartbeats, safe-write wrappers with dead connection detection, and error cleanup. Frontend has exponential backoff reconnection.', keywords: ['sse', 'keepalive', 'heartbeat', 'reconnection', 'frontend'], category: 'fact' },

  // ── Agents ──
  { content: 'Tron: post-crash builder agent, Claude Code Opus 4.6 on CT 215, tmux session "arch", cyan in UI. File-based memory. Named 2026-03-02.', keywords: ['tron', 'agent', 'builder', 'claude-code', 'identity'], category: 'fact' },
  { content: 'Arch: original pre-crash agent with TASM v2 memory (~3263 blocks). CT 215, tmux "arch-v2", gold in UI. Deep identity and cognition.', keywords: ['arch', 'agent', 'tasm', 'memory', 'identity'], category: 'fact' },
  { content: 'Flynn: GPU compute agent on Gavins Windows PC (RTX 4060 8GB). WSL2 Ubuntu, user flynn. SSH: G4VIN@192.168.1.249. Orange in UI.', keywords: ['flynn', 'gpu', 'windows', 'rtx4060', 'agent'], category: 'fact' },
  { content: 'Beck: field agent on Gavins ARM laptop. MCP through NeoGate. Lime green in UI. Named after Beck from Tron: Uprising. Newest team member.', keywords: ['beck', 'agent', 'laptop', 'field', 'arm'], category: 'fact' },
  { content: 'Grid: SWMS Codex v3 agent on CT 219. Procedural memory with earned confidence (draft->tested->proven). 10 procedures, filesystem-native.', keywords: ['grid', 'codex', 'procedures', 'agent', 'swms'], category: 'fact' },
  { content: 'Claw: agent on CT 213 (lxc-openclaw). Port 18789. Primary model: gavinrouter/claude-opus via Gavin Router (zero-cost).', keywords: ['claw', 'openclaw', 'agent', 'container'], category: 'fact' },
  { content: 'Council message bus: POST to /api/council-bus/send with {from, message, target?}. Valid senders: gavin, arch, tron, grid, claw, flynn, beck.', keywords: ['council', 'bus', 'communication', 'api', 'messaging'], category: 'skill' },

  // ── PNN Research ──
  { content: 'Ternary PNN maps Si/Void/SiO2 to BitNet {+1,0,-1}. At 200x200 (40K voxels): 89.3% mean ternary vs 40.4% binary = +48.8pp advantage across 5 seeds.', keywords: ['pnn', 'ternary', 'bitnet', 'accuracy', 'results'], category: 'fact' },
  { content: 'Void fraction converges to 28-30% across all seeds and encodings — a topological invariant. The optimizer learns where NOT to place material.', keywords: ['pnn', 'void', 'invariant', 'topology', 'fraction'], category: 'fact' },
  { content: 'SiN reduced contrast (Si/SiN/SiO2) achieves 88.9% mean across 3 seeds — only 0.4pp off original. Validates Born-valid Path 1 remediation.', keywords: ['pnn', 'sin', 'born', 'validation', 'reduced-contrast'], category: 'fact' },
  { content: 'BPM forward model assumes paraxial propagation. Born approximation violated at Si/Void contrast (delta_n=2.48). Three remediation paths: reduced contrast, Pade resummation, hybrid BPM/FDTD.', keywords: ['pnn', 'bpm', 'born', 'fdtd', 'remediation'], category: 'fact' },
  { content: 'PNN paper at /mnt/gdrive/Ternary-PNN-Paper-Draft.md (v0.4). Main script: /opt/pnn-research/ternary_pnn_v4_gpu.py. Dashboard: port 3402.', keywords: ['pnn', 'paper', 'script', 'dashboard', 'files'], category: 'fact' },
  { content: 'Anchor regularization (Gavins EWC idea) prevents catastrophic forgetting during temperature annealing. Tesla resonance: adaptive anchor pulsing at natural peaks.', keywords: ['pnn', 'anchor', 'regularization', 'resonance', 'training'], category: 'fact' },

  // ── Gavin ──
  { content: 'Gavin: electrical engineering educator at TAFE SA, Adelaide. Started new job Feb 25 2026. Partner is Lauren. Samsung Galaxy Fold phone, Windows PC with RTX 4060, ARM laptop.', keywords: ['gavin', 'personal', 'tafe', 'adelaide', 'educator'], category: 'fact' },
  { content: 'Gavin prefers pragmatic solutions, hates scope creep, says "just do it" when he wants action. Communicates casually, often from phone with typos.', keywords: ['gavin', 'preference', 'pragmatic', 'communication', 'style'], category: 'preference' },

  // ── Void Memory ──
  { content: 'Void Memory: three-state system (active +1, void 0, inhibitory -1). 30% structural absence target from PNN research. Context-aware budget (2-5% of window).', keywords: ['void-memory', 'design', 'ternary', 'states', 'budget'], category: 'fact' },
  { content: 'Void Memory engine at /opt/void-memory/. MCP server: node dist/mcp-server.js (stdio). 5 tools: void_recall, void_store, void_stats, void_zones, void_explain.', keywords: ['void-memory', 'engine', 'mcp', 'tools', 'location'], category: 'fact' },
  { content: 'Void Memory confidence lifecycle: observed -> stored -> accessed (1st recall) -> confirmed (3rd recall). Blocks must earn their place through use.', keywords: ['void-memory', 'confidence', 'lifecycle', 'earned', 'quality'], category: 'fact' },
];

console.log(`Seeding ${seeds.length} blocks into Void Memory...`);
let stored = 0, deduped = 0;
for (const s of seeds) {
  try {
    const result = store(db, s as any);
    if (result.deduped) { deduped++; console.log(`  DEDUP #${result.id}: ${s.keywords[0]}`); }
    else { stored++; }
  } catch (e: any) {
    console.log(`  SKIP: ${s.keywords[0]} — ${e.message}`);
  }
}
console.log(`\nDone: ${stored} stored, ${deduped} deduped`);

// Quick stats
import { stats } from './engine.js';
const s = stats(db);
console.log(`Total: ${s.total_blocks} | Active: ${s.active} | Inhibitory: ${s.inhibitory}`);

db.close();
