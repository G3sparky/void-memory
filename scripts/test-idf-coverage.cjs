#!/usr/bin/env node
/**
 * Test: IDF-based coverage vs hardcoded COMMON_WORDS list
 *
 * Runs the same queries through both approaches and compares results.
 * Tests both abstention (garbage rejection) and real query coverage.
 */

const Database = require('better-sqlite3');
const db = new Database('/opt/void-memory/data/void-memory.db', { readonly: true });

// ── Load all active blocks ──
const allBlocks = db.prepare('SELECT id, content, keywords, category, confidence, state, access_count FROM blocks WHERE state = 1').all();
console.log(`Loaded ${allBlocks.length} active blocks\n`);

// ── Tokenizer (matches engine.ts) ──
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

// ── Compute IDF ──
const docFreq = new Map();
const N = allBlocks.length || 1;
for (const b of allBlocks) {
  const words = new Set(tokenize(b.content + ' ' + b.keywords));
  for (const w of words) {
    docFreq.set(w, (docFreq.get(w) || 0) + 1);
  }
}
const idf = new Map();
for (const [word, df] of docFreq) {
  idf.set(word, Math.log(N / df));
}

// ── The old hardcoded list ──
const COMMON_WORDS = new Set(['completely','irrelevant','actually','really','probably','basically','certainly','different','important','something','everything','anything','possible','available','currently','following','including','according','sometimes','especially','generally','previously','particular','specific','certain','working','running','building','using','looking','making','getting','going','coming','taking','giving','having','doing','saying','telling','thinking','trying','starting','already','several','another','however','without','because','through','between','before','after','during','always','never','still','even','most','well','back','then','also','just','now','new','old','good','bad','big','small','long','short','high','low','right','left','first','last','next','same','like','make','take','know','think','come','want','look','give','find','tell','work']);

const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','to','of','in','for','on','with','at','by','from','as','into','through','and','but','or','not','so','what','which','who','how','when','where','why','i','me','my','we','you','your','he','him','she','her','it','its','they','them','their','this','that','these','those','just','also','very','about','been','being','some','more','much','many','only','other','each','than']);

// ── IDF-based "is this word common?" check ──
// A word is "common" if it appears in >20% of blocks (IDF < log(5) ≈ 1.61)
const IDF_COMMON_THRESHOLD = Math.log(5); // Words in >20% of blocks

function isCommonByIDF(word) {
  const score = idf.get(word);
  if (score === undefined) return false; // Unknown word = not common
  return score < IDF_COMMON_THRESHOLD;
}

// ── Auto-detected common words by IDF ──
const autoCommon = [];
for (const [word, score] of idf) {
  if (score < IDF_COMMON_THRESHOLD && word.length > 2) {
    autoCommon.push({ word, idf: score, df: docFreq.get(word), pct: ((docFreq.get(word) / N) * 100).toFixed(1) });
  }
}
autoCommon.sort((a, b) => a.idf - b.idf);

console.log(`=== IDF-based auto-detected common words (${autoCommon.length}) ===`);
console.log(`Threshold: IDF < ${IDF_COMMON_THRESHOLD.toFixed(2)} (appears in >20% of blocks)`);
console.log('Top 30:');
for (const w of autoCommon.slice(0, 30)) {
  const inOldList = COMMON_WORDS.has(w.word) ? ' [IN OLD LIST]' : '';
  console.log(`  "${w.word}" — IDF=${w.idf.toFixed(2)}, in ${w.pct}% of blocks${inOldList}`);
}

// ── Check what the old list catches that IDF misses, and vice versa ──
console.log(`\n=== Comparison ===`);
const oldOnly = [...COMMON_WORDS].filter(w => !isCommonByIDF(w));
const idfOnly = autoCommon.filter(w => !COMMON_WORDS.has(w.word));
console.log(`Old list has ${COMMON_WORDS.size} words`);
console.log(`IDF auto-detects ${autoCommon.length} common words`);
console.log(`\nIn OLD list but NOT flagged by IDF (${oldOnly.length}) — these are specific enough to matter:`);
for (const w of oldOnly.slice(0, 20)) {
  const score = idf.get(w);
  const df = docFreq.get(w);
  console.log(`  "${w}" — IDF=${score?.toFixed(2) || 'N/A'}, in ${df || 0} blocks (${((df || 0) / N * 100).toFixed(1)}%)`);
}
console.log(`\nFlagged by IDF but NOT in old list (${idfOnly.length}) — old list was missing these:`);
for (const w of idfOnly.slice(0, 20)) {
  console.log(`  "${w}" — IDF=${w.idf.toFixed(2)}, in ${w.pct}% of blocks`);
}

// ── Test queries: compare coverage calculation ──
console.log(`\n=== Coverage Test Queries ===`);

const testQueries = [
  // Should ABSTAIN (garbage)
  { q: 'completely irrelevant nonsense xyzzy', expect: 'abstain' },
  { q: 'basically just really important something', expect: 'abstain' },
  { q: 'running building working making going', expect: 'abstain' },

  // Should MATCH (real queries)
  { q: 'who is Tron', expect: 'match' },
  { q: 'what port does NeoGate use', expect: 'match' },
  { q: 'void memory three state architecture', expect: 'match' },
  { q: 'Gavin electrician TAFE', expect: 'match' },
  { q: 'council bus message system', expect: 'match' },
  { q: 'discord bot agent zero', expect: 'match' },
  { q: 'Lauren health PCOS insulin', expect: 'match' },
  { q: 'dream cycle consolidation overnight', expect: 'match' },
  { q: 'flower brain topology sacred geometry', expect: 'match' },
];

let oldCorrect = 0, idfCorrect = 0;

for (const test of testQueries) {
  const terms = test.q.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));

  // Simulate coverage with old approach
  const oldCoverage = terms.filter(t => {
    const inKeywords = allBlocks.some(b => b.keywords.toLowerCase().includes(t));
    if (inKeywords) return true;
    if (COMMON_WORDS.has(t)) return false;
    return allBlocks.some(b => b.content.toLowerCase().includes(t));
  });
  const oldRatio = terms.length > 0 ? oldCoverage.length / terms.length : 0;
  const oldAbstains = oldRatio < 0.3;

  // Simulate coverage with IDF approach
  const idfCoverage = terms.filter(t => {
    const inKeywords = allBlocks.some(b => b.keywords.toLowerCase().includes(t));
    if (inKeywords) return true;
    if (isCommonByIDF(t)) return false;
    return allBlocks.some(b => b.content.toLowerCase().includes(t));
  });
  const idfRatio = terms.length > 0 ? idfCoverage.length / terms.length : 0;
  const idfAbstains = idfRatio < 0.3;

  const oldResult = oldAbstains ? 'abstain' : 'match';
  const idfResult = idfAbstains ? 'abstain' : 'match';
  const oldOk = oldResult === test.expect;
  const idfOk = idfResult === test.expect;
  if (oldOk) oldCorrect++;
  if (idfOk) idfCorrect++;

  const status = oldOk && idfOk ? 'BOTH OK' : !oldOk && idfOk ? 'IDF BETTER' : oldOk && !idfOk ? 'OLD BETTER' : 'BOTH WRONG';
  console.log(`  [${status}] "${test.q}"`);
  console.log(`    expect=${test.expect} | old=${oldResult}(${(oldRatio*100).toFixed(0)}%) | idf=${idfResult}(${(idfRatio*100).toFixed(0)}%)`);
  if (status !== 'BOTH OK') {
    console.log(`    old covered: [${oldCoverage.join(', ')}]`);
    console.log(`    idf covered: [${idfCoverage.join(', ')}]`);
  }
}

console.log(`\n=== RESULTS ===`);
console.log(`Old list: ${oldCorrect}/${testQueries.length} correct`);
console.log(`IDF-based: ${idfCorrect}/${testQueries.length} correct`);
console.log(`\nVerdict: ${idfCorrect >= oldCorrect ? 'IDF is equal or better — safe to replace' : 'Old list wins — keep it'}`);

db.close();
