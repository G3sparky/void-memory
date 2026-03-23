/**
 * Seed Void Memory with example knowledge.
 * Replace these with your own domain-specific facts.
 *
 * Usage: node dist/seed.js
 */

import { openDB } from './db.js';
import { store } from './engine.js';

const db = openDB();

const seeds = [
  // ── Example: Project facts ──
  { content: 'The API server runs on port 3000 by default. Set PORT env var to change. Deploy with: npm run build && npm start', keywords: ['api', 'server', 'port', 'deploy', 'infrastructure'], category: 'skill' },
  { content: 'Database uses SQLite in WAL mode for concurrent reads. DB file at ./data/app.db. Backup: cp data/app.db data/app.db.bak', keywords: ['database', 'sqlite', 'backup', 'wal'], category: 'skill' },
  { content: 'Authentication uses JWT tokens with 24-hour expiry. Refresh tokens stored in httpOnly cookies. Secret in AUTH_SECRET env var.', keywords: ['auth', 'jwt', 'tokens', 'security'], category: 'fact' },

  // ── Example: Team knowledge ──
  { content: 'Frontend built with Lit web components and Vite. Build: npm run build. Output in dist/. Uses container queries for responsive layout.', keywords: ['frontend', 'lit', 'vite', 'build', 'responsive'], category: 'skill' },
  { content: 'Tests run with vitest. Coverage target: 80%. Run: npm test. CI runs on every push to main.', keywords: ['testing', 'vitest', 'coverage', 'ci'], category: 'skill' },

  // ── Example: Decisions ──
  { content: 'Chose SQLite over PostgreSQL because the system runs on a single node. If we need multi-node, migrate to Postgres.', keywords: ['database', 'decision', 'sqlite', 'postgres', 'architecture'], category: 'decision' },
  { content: 'Rate limiting set to 60 requests/minute/IP. Increase if legitimate users hit it. Decrease if abuse detected.', keywords: ['rate-limit', 'security', 'configuration'], category: 'decision' },

  // ── Example: Void Memory itself ──
  { content: 'Void Memory uses three states: active (+1, retrieve), void (0, suppressed), inhibitory (-1, actively blocks stale info). Target void fraction: ~30%.', keywords: ['void-memory', 'architecture', 'three-state', 'design'], category: 'fact' },
  { content: 'Confidence lifecycle: observed → stored → accessed (1st recall) → confirmed (3rd recall). Blocks earn their place through use.', keywords: ['void-memory', 'confidence', 'lifecycle', 'quality'], category: 'fact' },
  { content: 'CNI (Context Noise Index) measures retrieval signal quality before voiding. Below gate threshold: bypass. Above: engage proportionally.', keywords: ['cni', 'noise', 'adaptive', 'filtering', 'void-memory'], category: 'fact' },
];

console.log(`Seeding ${seeds.length} example blocks into Void Memory...`);
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

import { stats } from './engine.js';
const s = stats(db);
console.log(`Total: ${s.total_blocks} | Active: ${s.active} | Inhibitory: ${s.inhibitory}`);

db.close();
