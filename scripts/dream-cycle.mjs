#!/usr/bin/env node
/**
 * Nightly dream cycle runner.
 *
 * 1. Time-based consolidation: observation-tier blocks aged >= 24h
 *    auto-promote observed -> stored. This is the fix for the stranded-
 *    observed-tier bug (block #6755 option B-variant). Harvester writes
 *    always land as confidence='observed' category='observation' with
 *    net_valence=0; without this step they were invisible to recall forever.
 *
 * 2. Full dream() consolidation pass for active-tier blocks.
 * 3. limbicDream() replay for positively-valenced episodes.
 *
 * Safe to run under WAL concurrently with the REST API. Takes ~seconds.
 */
import Database from 'better-sqlite3';
import { dream, storeDreamInsights } from '/opt/void-memory/dist/dream.js';
import { limbicDream, storeLimbicDreamInsights } from '/opt/void-memory/dist/limbic-dream.js';

const DB_PATH = process.env.VOID_DB_PATH || '/opt/void-memory/data/void-memory.db';
const PROMOTION_AGE_HOURS = 24;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log(`[dream-cycle] ${new Date().toISOString()} — starting`);

const before = db.prepare(
  `SELECT COUNT(*) AS n FROM blocks WHERE confidence='observed' AND state >= 0`
).get().n;

const promoteStmt = db.prepare(`
  UPDATE blocks
     SET confidence = 'stored'
   WHERE confidence = 'observed'
     AND state >= 0
     AND category = 'observation'
     AND created_at < datetime('now', '-${PROMOTION_AGE_HOURS} hours')
`);
const promoted = promoteStmt.run().changes;
console.log(`[dream-cycle] promoted ${promoted} observation blocks observed->stored`);

try {
  const dreamReport = dream(db);
  storeDreamInsights(db, dreamReport);
  console.log(`[dream-cycle] dream consolidation ok`);
} catch (e) {
  console.error(`[dream-cycle] dream() failed:`, e.message);
}

try {
  const limbicReport = limbicDream(db, 'arch');
  storeLimbicDreamInsights(db, limbicReport);
  console.log(`[dream-cycle] limbic replay ok`);
} catch (e) {
  console.error(`[dream-cycle] limbicDream() failed:`, e.message);
}

const after = db.prepare(
  `SELECT COUNT(*) AS n FROM blocks WHERE confidence='observed' AND state >= 0`
).get().n;

console.log(`[dream-cycle] observed tier: ${before} -> ${after} (delta ${after - before})`);
console.log(`[dream-cycle] done`);
db.close();
