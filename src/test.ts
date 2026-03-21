/**
 * Void Memory — Phase 2 Test Suite
 * Tests: store, recall, void marking at scale, score gaps, clustering, hub dampening
 */

import { openDB } from './db.js';
import { store, recall, stats } from './engine.js';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

const testDir = mkdtempSync(join(tmpdir(), 'void-test-'));
const db = openDB(join(testDir, 'test.db'));

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== Void Memory Phase 2 Test Suite ===\n');

// ── Seed diverse blocks across 5 topic clusters ──
console.log('1. Seeding 30 blocks across 5 topics...');

const topics = [
  { prefix: 'pnn', keywords: ['pnn', 'ternary', 'photonic', 'research'], cat: 'fact', blocks: [
    'PNN ternary advantage is 48.8pp at 200x200 grid with void fraction at 28-30%',
    'SiN reduced contrast achieves 88.9% mean across 3 seeds — validates Born path',
    'BPM forward model assumes paraxial propagation and first-order Born approximation',
    'Learned encoding (784->10 linear layer) matches PCA-20 performance without compression',
    'Anchor regularization prevents catastrophic forgetting during temperature annealing',
    'Tesla resonance uses adaptive anchor pulsing at natural frequency peaks',
  ]},
  { prefix: 'infra', keywords: ['neogate', 'infrastructure', 'deploy', 'server'], cat: 'fact', blocks: [
    'NeoGate API runs on port 3216 and serves frontend plus all agent bridges',
    'Deploy NeoGate: cd /opt/neogate-v2 && npx tsc && systemctl restart neogate-v2',
    'TASM v2 standalone runs on port 3400 with systemd service tasm-v2',
    'Gavin Router on port 3333 routes requests to AI providers via OAuth',
    'Container 215 has 12GB RAM and 6 cores for NeoGate and agents',
    'SSE keepalive heartbeats every 20 seconds prevent stale connections',
  ]},
  { prefix: 'agents', keywords: ['agent', 'team', 'council', 'communication'], cat: 'fact', blocks: [
    'Tron is the builder agent, post-crash, tmux session arch, cyan color',
    'Arch is the original agent with TASM v2 memory, tmux arch-v2, gold color',
    'Flynn is the GPU agent on RTX 4060, Windows PC, orange color',
    'Beck is the field agent on Gavins ARM laptop, lime green color',
    'Council bus accepts messages from gavin, arch, tron, grid, claw, flynn, beck',
    'Grid runs SWMS Codex v3 with earned confidence and procedural memory',
  ]},
  { prefix: 'gavin', keywords: ['gavin', 'preference', 'personal', 'work'], cat: 'preference', blocks: [
    'Gavin prefers pragmatic solutions and hates scope creep in engineering',
    'Gavin is an electrical engineering educator at TAFE SA Adelaide',
    'Gavin communicates casually, often from phone, expect typos and abbreviations',
    'Gavin started new job February 25 2026 at TAFE SA teaching electrical',
    'Gavin uses Samsung Galaxy Fold phone and Windows desktop PC with RTX 4060',
    'Lauren is Gavins partner mentioned occasionally in conversations',
  ]},
  { prefix: 'memory', keywords: ['memory', 'void', 'tasm', 'recall'], cat: 'fact', blocks: [
    'Void Memory uses three states: active (+1), void (0), inhibitory (-1)',
    'TASM v2 has 3263 active blocks but 73% have never been accessed',
    'The 30% void fraction is a topological invariant from PNN research',
    'Context window budget: 2% ambient (4K tokens), up to 5% deep (10K tokens)',
    'Confidence lifecycle: observed to stored to accessed to confirmed at 3 uses',
    'Hub dampening prevents high-access blocks from dominating every recall',
  ]},
];

for (const topic of topics) {
  for (let i = 0; i < topic.blocks.length; i++) {
    const kw = [...topic.keywords];
    // Add a unique keyword per block for variety
    const unique = topic.blocks[i].split(' ').filter(w => w.length > 5)[0]?.toLowerCase();
    if (unique) kw.push(unique);
    store(db, { content: topic.blocks[i], category: topic.cat, keywords: kw });
  }
}
console.log('  30 blocks stored across 5 topic clusters\n');

// ── Test 2: Recall with void marking ──
console.log('2. Recall "PNN ternary research void fraction" (should void off-topic clusters)...');
const r1 = recall(db, 'PNN ternary research void fraction');
console.log(`  Scored: ${r1.blocks_scored}, Returned: ${r1.blocks.length}, Voided: ${r1.blocks_voided}`);
console.log(`  Void fraction: ${Math.round(r1.void_fraction * 100)}%`);
console.log(`  Void zones: [${r1.void_zones.join(', ')}]`);
console.log(`  Budget: ${r1.budget_used}/${r1.budget_max} tokens`);
console.log(`  Duration: ${r1.duration_ms}ms`);

assert('Void fraction > 0%', r1.void_fraction > 0, `got ${Math.round(r1.void_fraction * 100)}%`);
assert('Void fraction near 30%', r1.void_fraction >= 0.15 && r1.void_fraction <= 0.5, `got ${Math.round(r1.void_fraction * 100)}%`);
assert('At least 1 void zone', r1.void_zones.length >= 1, `got ${r1.void_zones.length}`);
assert('PNN blocks in results', r1.blocks.some(b => b.content.includes('PNN')), 'no PNN blocks found');
assert('Speed under 200ms', r1.duration_ms < 200, `${r1.duration_ms}ms`);

console.log('  Results:');
for (const b of r1.blocks.slice(0, 5)) {
  console.log(`    #${b.id} score=${b.score}: ${b.content.slice(0, 65)}...`);
}

// ── Test 3: Different topic should void PNN ──
console.log('\n3. Recall "NeoGate deployment infrastructure server" (should void PNN)...');
const r2 = recall(db, 'NeoGate deployment infrastructure server');
console.log(`  Scored: ${r2.blocks_scored}, Returned: ${r2.blocks.length}, Voided: ${r2.blocks_voided}`);
console.log(`  Void fraction: ${Math.round(r2.void_fraction * 100)}%`);
console.log(`  Void zones: [${r2.void_zones.join(', ')}]`);

assert('Infra blocks in results', r2.blocks.some(b => b.content.includes('NeoGate')), 'no infra blocks');
assert('PNN blocks voided or absent', !r2.blocks.some(b => b.content.includes('PNN ternary advantage')), 'PNN blocks should be voided');

// ── Test 4: Broad query should still work ──
console.log('\n4. Recall "Gavin preferences and team agents" (cross-topic)...');
const r3 = recall(db, 'Gavin preferences and team agents');
console.log(`  Scored: ${r3.blocks_scored}, Returned: ${r3.blocks.length}, Voided: ${r3.blocks_voided}`);
console.log(`  Void fraction: ${Math.round(r3.void_fraction * 100)}%`);

assert('Gavin blocks present', r3.blocks.some(b => b.content.includes('Gavin')), 'no Gavin blocks');
assert('Agent blocks present', r3.blocks.some(b => b.content.includes('agent') || b.content.includes('Tron')), 'no agent blocks');

// ── Test 5: Supersession + inhibition ──
console.log('\n5. Supersession test...');
const oldId = store(db, { content: 'TASM has 5930 active blocks after initial cleanup', keywords: ['tasm', 'blocks', 'count', 'cleanup'] });
const newId = store(db, { content: 'TASM has 3263 active blocks after deep cleanup and deprecation', keywords: ['tasm', 'blocks', 'count', 'cleanup', 'updated'], supersedes: oldId.id });
const oldState = (db.prepare('SELECT state FROM blocks WHERE id = ?').get(oldId.id) as any).state;
assert('Old block is inhibitory', oldState === -1, `state=${oldState}`);
const inhibition = db.prepare('SELECT * FROM inhibitions WHERE blocked_id = ?').get(oldId.id) as any;
assert('Inhibition link exists', !!inhibition, 'no inhibition record');
assert('Blocker is new block', inhibition?.blocker_id === newId.id, `blocker=${inhibition?.blocker_id}`);

// Recall should not return the old block
const r4 = recall(db, 'TASM blocks count cleanup');
assert('Old superseded block excluded', !r4.blocks.some(b => b.id === oldId.id), 'old block still in results');
assert('New block included', r4.blocks.some(b => b.id === newId.id), 'new block missing');

// ── Test 6: Dedup ──
console.log('\n6. Dedup test...');
const dup = store(db, { content: 'PNN ternary shows massive advantage with void at thirty percent', keywords: ['pnn', 'ternary', 'photonic', 'research'] });
assert('Dedup detected', dup.deduped === true, `deduped=${dup.deduped}`);

// ── Test 7: Confidence lifecycle ──
console.log('\n7. Confidence lifecycle...');
const freshId = store(db, { content: 'A brand new fact that has never been recalled before today', keywords: ['fresh', 'new', 'test', 'lifecycle'] });
const fresh1 = (db.prepare('SELECT confidence FROM blocks WHERE id = ?').get(freshId.id) as any).confidence;
assert('New block starts as stored', fresh1 === 'stored', `got ${fresh1}`);

recall(db, 'fresh new test lifecycle');
const fresh2 = (db.prepare('SELECT confidence FROM blocks WHERE id = ?').get(freshId.id) as any).confidence;
assert('After 1 recall: accessed', fresh2 === 'accessed', `got ${fresh2}`);

recall(db, 'fresh new test lifecycle');
recall(db, 'fresh new test lifecycle');
const fresh3 = (db.prepare('SELECT confidence, access_count FROM blocks WHERE id = ?').get(freshId.id) as any);
assert('After 3 recalls: confirmed', fresh3.confidence === 'confirmed', `got ${fresh3.confidence} (accesses=${fresh3.access_count})`);

// ── Test 8: Quality gate ──
console.log('\n8. Quality gate...');
let caught = false;
try { store(db, { content: 'too short', keywords: ['x'] }); } catch { caught = true; }
assert('Rejects short content', caught === true);

caught = false;
try { store(db, { content: '12345678901234567890123456789', keywords: ['x'] }); } catch { caught = true; }
assert('Rejects non-alpha content', caught === true);

// ── Test 9: Speed at scale ──
console.log('\n9. Speed test (20 recalls across topics)...');
const queries = [
  'PNN ternary void research', 'NeoGate deploy infrastructure',
  'Gavin preferences work', 'Grid codex procedures', 'memory void recall',
  'agent team communication', 'Born approximation BPM', 'Flynn GPU compute',
  'TASM blocks dead weight', 'anchor regularization training',
];
const times: number[] = [];
for (let i = 0; i < 20; i++) {
  const r = recall(db, queries[i % queries.length]);
  times.push(r.duration_ms);
}
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const max = Math.max(...times);
console.log(`  Avg: ${avg.toFixed(1)}ms | Max: ${max.toFixed(1)}ms`);
assert('Avg recall under 50ms', avg < 50, `${avg.toFixed(1)}ms`);
assert('Max recall under 200ms', max < 200, `${max.toFixed(1)}ms`);

// ── Test 10: Stats ──
console.log('\n10. Final stats:');
const s = stats(db);
console.log(`  Total: ${s.total_blocks} | Active: ${s.active} | Void: ${s.void} | Inhibitory: ${s.inhibitory}`);
console.log(`  Confidence: ${JSON.stringify(s.by_confidence)}`);
console.log(`  Avg void fraction: ${Math.round(s.avg_void_fraction * 100)}%`);
console.log(`  Dead weight: ${s.dead_weight_pct}%`);
assert('Avg void fraction > 0', s.avg_void_fraction > 0, `${Math.round(s.avg_void_fraction * 100)}%`);

// ── Summary ──
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
