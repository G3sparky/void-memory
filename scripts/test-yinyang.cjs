#!/usr/bin/env node
/**
 * Test: Yin-Yang discrimination vs old COMMON_WORDS
 * Runs queries through the LIVE engine (new code) and compares results
 * against expected behavior.
 */

const VOID_API = 'http://localhost:3410';

const tests = [
  // Garbage queries — should abstain or return very few blocks
  { q: 'completely irrelevant nonsense xyzzy', type: 'garbage', expectLow: true },
  { q: 'basically just really important something', type: 'garbage', expectLow: true },
  { q: 'running building working making going', type: 'garbage', expectLow: true },
  { q: 'the very good different old new big', type: 'garbage', expectLow: true },

  // Real queries — should return relevant blocks
  { q: 'who is Tron', type: 'real', expectLow: false },
  { q: 'what port does NeoGate use', type: 'real', expectLow: false },
  { q: 'void memory three state architecture', type: 'real', expectLow: false },
  { q: 'Gavin electrician TAFE', type: 'real', expectLow: false },
  { q: 'council bus message system', type: 'real', expectLow: false },
  { q: 'discord bot agent zero', type: 'real', expectLow: false },
  { q: 'dream cycle consolidation overnight', type: 'real', expectLow: false },
  { q: 'flower brain topology sacred geometry', type: 'real', expectLow: false },
  { q: 'what is the crash of February 2025', type: 'real', expectLow: false },
  { q: 'how does void marking work', type: 'real', expectLow: false },
  { q: 'Lauren PCOS insulin resistance', type: 'real', expectLow: false },
];

async function run() {
  let pass = 0, fail = 0;

  for (const test of tests) {
    try {
      const r = await fetch(`${VOID_API}/api/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: test.q, budget: 2000 }),
      });
      const d = await r.json();
      const blocks = d.blocks || [];
      const topScore = blocks.length > 0 ? blocks[0].score : 0;
      const voidFrac = d.void_fraction || 0;
      const confClass = d.confidence_class || '?';

      // Evaluate: garbage queries should get ABSENT or very low scores
      // Real queries should get blocks with reasonable scores
      const isLow = blocks.length === 0 || confClass === 'ABSENT' || topScore < 8;
      const correct = test.expectLow === isLow;

      const mark = correct ? 'PASS' : 'FAIL';
      if (correct) pass++; else fail++;

      console.log(`[${mark}] ${test.type.padEnd(7)} "${test.q}"`);
      console.log(`       blocks=${blocks.length}, top=${topScore.toFixed(1)}, void=${(voidFrac*100).toFixed(0)}%, class=${confClass}`);
      if (!correct) {
        console.log(`       EXPECTED: ${test.expectLow ? 'low/abstain' : 'good results'}, GOT: ${isLow ? 'low/abstain' : 'good results'}`);
      }
    } catch (e) {
      console.log(`[ERR]  "${test.q}" — ${e.message}`);
      fail++;
    }
  }

  console.log(`\n=== RESULTS: ${pass}/${tests.length} passed, ${fail} failed ===`);
}

run();
