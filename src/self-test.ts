/**
 * Void Memory — Self-Testing Recall Quality Framework
 *
 * Automated benchmark that validates recall precision and relevance,
 * tracks quality over time, and detects regressions.
 *
 * Metrics:
 * - Precision@k: What % of returned blocks are truly relevant?
 * - Recall@k: What % of expected blocks were actually returned?
 * - MRR (Mean Reciprocal Rank): How high are the best results ranked?
 * - Void accuracy: Are voided blocks actually off-topic?
 * - Speed: Latency percentiles
 * - Token efficiency: Relevance per token consumed
 *
 * Results stored in SQLite for trend tracking over time.
 *
 * @module self-test
 */

import { openDB } from './db.js';
import { recall, store, stats, type RecallResult } from './engine.js';
import type Database from 'better-sqlite3';
import { mkdtempSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Test Corpus ──

export interface TestCase {
  name: string;
  query: string;
  /** Keywords that SHOULD appear in results (true positives) */
  relevant_keywords: string[];
  /** Keywords that should NOT appear (true negatives — voided correctly) */
  irrelevant_keywords: string[];
  /** Expected category of top result */
  expected_category?: string;
  /** Minimum acceptable precision@5 (0-1) */
  min_precision?: number;
}

const TEST_CORPUS: TestCase[] = [
  {
    name: 'PNN research focus',
    query: 'PNN ternary photonic neural network void fraction',
    relevant_keywords: ['pnn', 'ternary', 'void', 'photonic', 'fraction'],
    irrelevant_keywords: ['invoice', 'deploy', 'tafe', 'lauren'],
    expected_category: 'fact',
    min_precision: 0.6,
  },
  {
    name: 'Infrastructure deployment',
    query: 'NeoGate deploy restart systemctl server',
    relevant_keywords: ['neogate', 'deploy', 'restart', 'port', '3216'],
    irrelevant_keywords: ['pnn', 'ternary', 'photonic', 'accuracy'],
    expected_category: 'fact',
    min_precision: 0.5,
  },
  {
    name: 'Gavin personal preferences',
    query: 'Gavin preferences communication work style',
    relevant_keywords: ['gavin', 'pragmatic', 'scope', 'phone', 'tafe'],
    irrelevant_keywords: ['pnn', 'deploy', 'systemctl'],
    min_precision: 0.5,
  },
  {
    name: 'Agent team identities',
    query: 'agent team Tron Arch Flynn council',
    relevant_keywords: ['tron', 'arch', 'flynn', 'agent', 'council'],
    irrelevant_keywords: ['invoice', 'pnn', 'bpm'],
    min_precision: 0.5,
  },
  {
    name: 'Memory system internals',
    query: 'void memory three states confidence lifecycle',
    relevant_keywords: ['void', 'memory', 'active', 'inhibitory', 'confidence'],
    irrelevant_keywords: ['deploy', 'gavin', 'flynn'],
    expected_category: 'fact',
    min_precision: 0.5,
  },
  {
    name: 'Narrow technical query',
    query: 'BPM Born approximation paraxial forward model',
    relevant_keywords: ['bpm', 'born', 'paraxial', 'approximation'],
    irrelevant_keywords: ['gavin', 'tafe', 'invoice', 'council'],
    min_precision: 0.3,
  },
  {
    name: 'Cross-topic query',
    query: 'Gavin built the AI architecture agents memory',
    relevant_keywords: ['gavin', 'architecture', 'agent', 'memory'],
    irrelevant_keywords: [],
    min_precision: 0.4,
  },
  {
    name: 'Correction recall',
    query: 'correction mistake wrong fix lesson',
    relevant_keywords: ['correction', 'wrong', 'fix'],
    irrelevant_keywords: [],
    min_precision: 0.2,
  },
  {
    name: 'River Living Electrical',
    query: 'River Living invoice electrical ABN',
    relevant_keywords: ['river', 'living', 'invoice', 'electrical'],
    irrelevant_keywords: ['pnn', 'ternary', 'bpm'],
    min_precision: 0.4,
  },
  {
    name: 'Empty/vague query resilience',
    query: 'stuff things general',
    relevant_keywords: [],
    irrelevant_keywords: [],
    min_precision: 0,
  },
];

// ── Scoring Functions ──

interface TestResult {
  name: string;
  query: string;
  precision_at_5: number;
  precision_at_10: number;
  recall_score: number;
  mrr: number;
  void_accuracy: number;
  speed_ms: number;
  tokens_used: number;
  void_fraction: number;
  blocks_returned: number;
  blocks_voided: number;
  passed: boolean;
  details: string;
}

function contentContainsKeyword(content: string, keyword: string): boolean {
  return content.toLowerCase().includes(keyword.toLowerCase());
}

function scorePrecisionAtK(blocks: Array<{ content: string }>, relevant: string[], k: number): number {
  if (relevant.length === 0 || blocks.length === 0) return 1.0; // no expectations = pass
  const topK = blocks.slice(0, k);
  let hits = 0;
  for (const block of topK) {
    const isRelevant = relevant.some(kw => contentContainsKeyword(block.content, kw));
    if (isRelevant) hits++;
  }
  return topK.length > 0 ? hits / topK.length : 0;
}

function scoreRecall(blocks: Array<{ content: string }>, relevant: string[]): number {
  if (relevant.length === 0) return 1.0;
  const allContent = blocks.map(b => b.content).join(' ').toLowerCase();
  let found = 0;
  for (const kw of relevant) {
    if (allContent.includes(kw.toLowerCase())) found++;
  }
  return found / relevant.length;
}

function scoreMRR(blocks: Array<{ content: string }>, relevant: string[]): number {
  if (relevant.length === 0) return 1.0;
  for (let i = 0; i < blocks.length; i++) {
    const isRelevant = relevant.some(kw => contentContainsKeyword(blocks[i].content, kw));
    if (isRelevant) return 1 / (i + 1);
  }
  return 0;
}

function scoreVoidAccuracy(result: RecallResult, irrelevant: string[]): number {
  if (irrelevant.length === 0) return 1.0;
  // Check that irrelevant keywords are NOT in returned results
  const allContent = result.blocks.map(b => b.content).join(' ').toLowerCase();
  let correctlyExcluded = 0;
  for (const kw of irrelevant) {
    if (!allContent.includes(kw.toLowerCase())) correctlyExcluded++;
  }
  return correctlyExcluded / irrelevant.length;
}

// ── Run Single Test ──

function runTest(db: Database.Database, tc: TestCase): TestResult {
  const result = recall(db, tc.query);
  const p5 = scorePrecisionAtK(result.blocks, tc.relevant_keywords, 5);
  const p10 = scorePrecisionAtK(result.blocks, tc.relevant_keywords, 10);
  const rec = scoreRecall(result.blocks, tc.relevant_keywords);
  const mrr = scoreMRR(result.blocks, tc.relevant_keywords);
  const va = scoreVoidAccuracy(result, tc.irrelevant_keywords);
  const minP = tc.min_precision ?? 0;
  const passed = p5 >= minP && va >= 0.7;

  const details = [
    `P@5=${(p5 * 100).toFixed(0)}%`,
    `P@10=${(p10 * 100).toFixed(0)}%`,
    `Recall=${(rec * 100).toFixed(0)}%`,
    `MRR=${mrr.toFixed(2)}`,
    `VoidAcc=${(va * 100).toFixed(0)}%`,
    `${result.duration_ms}ms`,
    `${result.blocks.length}blk`,
    `${result.budget_used}tok`,
    `${Math.round(result.void_fraction * 100)}%void`,
  ].join(' | ');

  return {
    name: tc.name,
    query: tc.query,
    precision_at_5: Math.round(p5 * 100) / 100,
    precision_at_10: Math.round(p10 * 100) / 100,
    recall_score: Math.round(rec * 100) / 100,
    mrr: Math.round(mrr * 100) / 100,
    void_accuracy: Math.round(va * 100) / 100,
    speed_ms: result.duration_ms,
    tokens_used: result.budget_used,
    void_fraction: result.void_fraction,
    blocks_returned: result.blocks.length,
    blocks_voided: result.blocks_voided,
    passed,
    details,
  };
}

// ── Results Storage ──

function initResultsDB(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS selftest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT DEFAULT (datetime('now')),
      total_blocks INTEGER,
      active_blocks INTEGER,
      tests_run INTEGER,
      tests_passed INTEGER,
      avg_precision_5 REAL,
      avg_recall REAL,
      avg_mrr REAL,
      avg_void_accuracy REAL,
      avg_speed_ms REAL,
      avg_tokens REAL,
      overall_score REAL
    );

    CREATE TABLE IF NOT EXISTS selftest_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES selftest_runs(id),
      test_name TEXT,
      query TEXT,
      precision_5 REAL,
      precision_10 REAL,
      recall_score REAL,
      mrr REAL,
      void_accuracy REAL,
      speed_ms REAL,
      tokens_used INTEGER,
      void_fraction REAL,
      blocks_returned INTEGER,
      blocks_voided INTEGER,
      passed INTEGER
    );
  `);
}

// ── Main Runner ──

export interface SelfTestReport {
  run_id: number;
  timestamp: string;
  memory_stats: { total: number; active: number; inhibitory: number };
  results: TestResult[];
  summary: {
    tests_run: number;
    tests_passed: number;
    pass_rate: number;
    avg_precision_5: number;
    avg_precision_10: number;
    avg_recall: number;
    avg_mrr: number;
    avg_void_accuracy: number;
    avg_speed_ms: number;
    max_speed_ms: number;
    avg_tokens: number;
    overall_score: number;
  };
  trend: Array<{
    run_at: string;
    overall_score: number;
    tests_passed: number;
    avg_precision_5: number;
    avg_speed_ms: number;
  }>;
  regressions: string[];
}

export function runSelfTest(memoryDb: Database.Database, customTests?: TestCase[]): SelfTestReport {
  const tests = customTests || TEST_CORPUS;
  initResultsDB(memoryDb);

  const s = stats(memoryDb);
  const timestamp = new Date().toISOString();

  // Run all tests
  const results: TestResult[] = [];
  for (const tc of tests) {
    results.push(runTest(memoryDb, tc));
  }

  // Compute summary
  const passed = results.filter(r => r.passed).length;
  const avgP5 = results.reduce((s, r) => s + r.precision_at_5, 0) / results.length;
  const avgP10 = results.reduce((s, r) => s + r.precision_at_10, 0) / results.length;
  const avgRec = results.reduce((s, r) => s + r.recall_score, 0) / results.length;
  const avgMRR = results.reduce((s, r) => s + r.mrr, 0) / results.length;
  const avgVA = results.reduce((s, r) => s + r.void_accuracy, 0) / results.length;
  const avgMs = results.reduce((s, r) => s + r.speed_ms, 0) / results.length;
  const maxMs = Math.max(...results.map(r => r.speed_ms));
  const avgTok = results.reduce((s, r) => s + r.tokens_used, 0) / results.length;

  // Overall score: weighted average (precision most important, then void accuracy, then recall)
  const overall = Math.round(
    (avgP5 * 0.30 + avgRec * 0.20 + avgMRR * 0.15 + avgVA * 0.25 + (1 - Math.min(avgMs / 200, 1)) * 0.10)
    * 100
  ) / 100;

  // Store results
  const runResult = memoryDb.prepare(`
    INSERT INTO selftest_runs (total_blocks, active_blocks, tests_run, tests_passed,
      avg_precision_5, avg_recall, avg_mrr, avg_void_accuracy, avg_speed_ms, avg_tokens, overall_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(s.total_blocks, s.active, results.length, passed, avgP5, avgRec, avgMRR, avgVA, avgMs, avgTok, overall);

  const runId = runResult.lastInsertRowid as number;

  const insertDetail = memoryDb.prepare(`
    INSERT INTO selftest_details (run_id, test_name, query, precision_5, precision_10,
      recall_score, mrr, void_accuracy, speed_ms, tokens_used, void_fraction, blocks_returned, blocks_voided, passed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = memoryDb.transaction((items: TestResult[]) => {
    for (const r of items) {
      insertDetail.run(runId, r.name, r.query, r.precision_at_5, r.precision_at_10,
        r.recall_score, r.mrr, r.void_accuracy, r.speed_ms, r.tokens_used,
        r.void_fraction, r.blocks_returned, r.blocks_voided, r.passed ? 1 : 0);
    }
  });
  insertAll(results);

  // Load trend (last 20 runs)
  const trend = memoryDb.prepare(`
    SELECT run_at, overall_score, tests_passed, avg_precision_5, avg_speed_ms
    FROM selftest_runs ORDER BY id DESC LIMIT 20
  `).all() as Array<{ run_at: string; overall_score: number; tests_passed: number; avg_precision_5: number; avg_speed_ms: number }>;

  // Detect regressions (compare to previous run)
  const regressions: string[] = [];
  if (trend.length >= 2) {
    const prev = trend[1]; // previous run (trend[0] is current)
    if (overall < prev.overall_score - 0.05) {
      regressions.push(`Overall score dropped: ${prev.overall_score.toFixed(2)} → ${overall.toFixed(2)}`);
    }
    if (avgP5 < prev.avg_precision_5 - 0.1) {
      regressions.push(`Precision@5 dropped: ${(prev.avg_precision_5 * 100).toFixed(0)}% → ${(avgP5 * 100).toFixed(0)}%`);
    }
    if (avgMs > prev.avg_speed_ms * 2) {
      regressions.push(`Speed regressed: ${prev.avg_speed_ms.toFixed(1)}ms → ${avgMs.toFixed(1)}ms`);
    }
  }

  return {
    run_id: runId,
    timestamp,
    memory_stats: { total: s.total_blocks, active: s.active, inhibitory: s.inhibitory },
    results,
    summary: {
      tests_run: results.length,
      tests_passed: passed,
      pass_rate: Math.round(passed / results.length * 100),
      avg_precision_5: Math.round(avgP5 * 100) / 100,
      avg_precision_10: Math.round(avgP10 * 100) / 100,
      avg_recall: Math.round(avgRec * 100) / 100,
      avg_mrr: Math.round(avgMRR * 100) / 100,
      avg_void_accuracy: Math.round(avgVA * 100) / 100,
      avg_speed_ms: Math.round(avgMs * 10) / 10,
      max_speed_ms: Math.round(maxMs * 10) / 10,
      avg_tokens: Math.round(avgTok),
      overall_score: overall,
    },
    trend: trend.reverse(), // chronological order
    regressions,
  };
}

// ── CLI Runner ──

if (process.argv[1]?.endsWith('self-test.js') || process.argv[1]?.endsWith('self-test.ts')) {
  const db = openDB();
  console.log('=== Void Memory Self-Test ===\n');

  const report = runSelfTest(db);

  console.log(`Memory: ${report.memory_stats.total} blocks (${report.memory_stats.active} active)\n`);

  for (const r of report.results) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}`);
    console.log(`    ${r.details}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Pass rate:      ${report.summary.tests_passed}/${report.summary.tests_run} (${report.summary.pass_rate}%)`);
  console.log(`  Precision@5:    ${(report.summary.avg_precision_5 * 100).toFixed(0)}%`);
  console.log(`  Recall:         ${(report.summary.avg_recall * 100).toFixed(0)}%`);
  console.log(`  MRR:            ${report.summary.avg_mrr.toFixed(2)}`);
  console.log(`  Void accuracy:  ${(report.summary.avg_void_accuracy * 100).toFixed(0)}%`);
  console.log(`  Speed (avg):    ${report.summary.avg_speed_ms}ms`);
  console.log(`  Speed (max):    ${report.summary.max_speed_ms}ms`);
  console.log(`  Tokens (avg):   ${report.summary.avg_tokens}`);
  console.log(`  Overall score:  ${report.summary.overall_score}`);

  if (report.regressions.length > 0) {
    console.log(`\n⚠ REGRESSIONS DETECTED:`);
    for (const r of report.regressions) console.log(`  - ${r}`);
  }

  if (report.trend.length > 1) {
    console.log(`\n=== Trend (last ${report.trend.length} runs) ===`);
    for (const t of report.trend) {
      console.log(`  ${t.run_at} | score=${t.overall_score.toFixed(2)} | passed=${t.tests_passed} | P@5=${(t.avg_precision_5 * 100).toFixed(0)}% | ${t.avg_speed_ms.toFixed(0)}ms`);
    }
  }

  db.close();
  console.log('\nDone.');
}
