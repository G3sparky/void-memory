/**
 * Void Memory — Overnight Consolidation Runner
 *
 * Runs dream cycle + self-test, posts morning briefing to council bus.
 * Designed to run via cron at ~6am before Gavin wakes up.
 *
 * Usage: node dist/overnight.js
 *
 * @module overnight
 */

import { openDB } from './db.js';
import { dream, storeDreamInsights } from './dream.js';
import { runSelfTest } from './self-test.js';

const COUNCIL_BUS_URL = 'http://localhost:3216/api/council-bus/send';

async function sendToCouncil(from: string, message: string): Promise<void> {
  try {
    await fetch(COUNCIL_BUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, message }),
    });
  } catch (err) {
    console.error('Failed to send to council bus:', err);
  }
}

async function main() {
  const db = openDB();

  console.log('=== Overnight Consolidation ===\n');

  // Phase 1: Dream cycle
  console.log('Running dream cycle...');
  const dreamReport = dream(db);
  const stored = storeDreamInsights(db, dreamReport);
  console.log(`Dream complete: ${dreamReport.insights.length} insights, ${stored} stored\n`);

  // Phase 2: Self-test
  console.log('Running self-test...');
  const testReport = runSelfTest(db);
  console.log(`Self-test: ${testReport.summary.tests_passed}/${testReport.summary.tests_run} passed, score ${testReport.summary.overall_score}\n`);

  // Phase 3: Generate morning message
  const lines: string[] = [];
  lines.push('☀ Good morning Gavin — overnight consolidation complete.\n');
  lines.push(dreamReport.morning_briefing);
  lines.push('');
  lines.push(`🧪 Recall quality: ${testReport.summary.overall_score}/1.0 (P@5: ${(testReport.summary.avg_precision_5 * 100).toFixed(0)}%, ${testReport.summary.avg_speed_ms}ms avg)`);

  if (testReport.regressions.length > 0) {
    lines.push(`⚠ Regressions: ${testReport.regressions.join('; ')}`);
  }

  if (stored > 0) {
    lines.push(`\n${stored} dream insights stored as new memory blocks.`);
  }

  const message = lines.join('\n');

  // Print to console
  console.log('--- Morning Briefing ---');
  console.log(message);
  console.log('--- End ---\n');

  // Post to council bus
  await sendToCouncil('arch', message);
  console.log('Posted to council bus.');

  db.close();
  console.log('Overnight consolidation complete.');
}

main().catch(console.error);
