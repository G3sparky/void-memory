/**
 * Continuity Engine — "No More Fog"
 *
 * From Gavin's TASM-CONTINUITY-ADDENDUM.md (February 20, 2026).
 * Implemented April 4, 2026. Six weeks late. Never again.
 *
 * Heartbeat stores every 10 messages capture working state.
 * Pre-compaction dumps save everything needed to resume.
 * Warm resume protocol eliminates post-compaction fog.
 *
 * @module continuity
 */

import type Database from 'better-sqlite3';
import { store } from './engine.js';

// ── Types ──

export interface WorkingState {
  activeTask: string;
  currentStep: string;
  completedSteps: string[];
  nextStep: string;
  openDecisions: string[];
  blockers: string[];
  testStatus: string;
  filesTouched?: string[];
}

export interface PreCompactSnapshot extends WorkingState {
  keyDecisions: string[];
  openItems: string[];
  importantContext: string;
}

export interface ContinuityScore {
  blocksStoredPreCompact: number;
  heartbeatStoresThisSession: number;
  subtaskCompletions: number;
  resumeRecallTokens: number;
  timeToContinuityMs: number;
  selfReportedGap: boolean;
}

// ── Database Migration ──

export function migrateContinuity(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS continuity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL DEFAULT 'arch',
      type TEXT NOT NULL CHECK (type IN ('heartbeat', 'pre-compact', 'subtask', 'decision', 'resume')),
      blocks_pre_compact INTEGER DEFAULT 0,
      heartbeat_stores INTEGER DEFAULT 0,
      subtask_completions INTEGER DEFAULT 0,
      resume_recall_tokens INTEGER DEFAULT 0,
      time_to_continuity_ms INTEGER DEFAULT 0,
      felt_gap INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ── Heartbeat Store (every 10 messages) ──

/**
 * Store a working-state heartbeat. Called every 10 messages during a session.
 * This is the core fix for mid-session forgetting.
 */
export function heartbeatStore(db: Database.Database, state: WorkingState, agent: string = 'arch'): number {
  const content = `[HEARTBEAT] Task: ${state.activeTask}. ` +
    `Step: ${state.currentStep}. ` +
    `Done: ${state.completedSteps.join(', ') || 'none'}. ` +
    `Next: ${state.nextStep}. ` +
    (state.blockers.length ? `Blockers: ${state.blockers.join(', ')}. ` : '') +
    (state.testStatus ? `Tests: ${state.testStatus}. ` : '') +
    (state.filesTouched?.length ? `Files: ${state.filesTouched.join(', ')}.` : '');

  const result = store(db, {
    content,
    category: 'context',
    keywords: ['working-state', 'heartbeat', 'continuity', 'progress', agent],
    state: 1,
    confidence: 'stored',
  });

  // Log the heartbeat
  db.prepare(`INSERT INTO continuity_log (agent, type) VALUES (?, 'heartbeat')`).run(agent);

  return result.id;
}

// ── Pre-Compaction Emergency Dump ──

/**
 * Store a complete pre-compaction snapshot. Called when context is >85% full.
 * This block is the FIRST thing recalled on resume.
 */
export function preCompactDump(db: Database.Database, snapshot: PreCompactSnapshot, agent: string = 'arch'): number {
  const content = `[PRE-COMPACT] Task: ${snapshot.activeTask}. ` +
    `Step: ${snapshot.currentStep}. ` +
    `Done: ${snapshot.completedSteps.join(', ') || 'none'}. ` +
    `Next: ${snapshot.nextStep}. ` +
    (snapshot.keyDecisions.length ? `Decisions: ${snapshot.keyDecisions.join('; ')}. ` : '') +
    (snapshot.openItems.length ? `Open: ${snapshot.openItems.join(', ')}. ` : '') +
    (snapshot.blockers.length ? `Blockers: ${snapshot.blockers.join(', ')}. ` : '') +
    (snapshot.testStatus ? `Tests: ${snapshot.testStatus}. ` : '') +
    (snapshot.filesTouched?.length ? `Files: ${snapshot.filesTouched.join(', ')}. ` : '') +
    (snapshot.importantContext ? `Context: ${snapshot.importantContext}` : '');

  const result = store(db, {
    content,
    category: 'context',
    keywords: ['pre-compact', 'working-state', 'continuity', 'resume', agent],
    state: 1,
    confidence: 'confirmed',  // Pre-compact dumps are always confirmed — they are critical
  });

  // Log the dump
  db.prepare(`INSERT INTO continuity_log (agent, type, blocks_pre_compact) VALUES (?, 'pre-compact', 1)`).run(agent);

  return result.id;
}

// ── Subtask Completion Store ──

/**
 * Store a specific subtask completion. NOT "worked on Academy" —
 * YES "finished academy-bridge.ts domain classification, 6 tests passing"
 */
export function subtaskComplete(
  db: Database.Database,
  task: string,
  subtask: string,
  result: 'done' | 'failed' | 'partial',
  notes: string,
  agent: string = 'arch'
): number {
  const content = `[SUBTASK ${result.toUpperCase()}] ${subtask}. ` +
    `Part of: ${task}. ` +
    `${notes}`;

  const storeResult = store(db, {
    content,
    category: 'episode',
    keywords: ['progress', 'subtask', result, 'continuity', agent],
    state: 1,
    confidence: 'confirmed',
  });

  db.prepare(`INSERT INTO continuity_log (agent, type, subtask_completions) VALUES (?, 'subtask', 1)`).run(agent);

  return storeResult.id;
}

// ── Decision Store ──

/**
 * Store a decision with reasoning and alternatives.
 * Captures WHY, not just WHAT.
 */
export function decisionStore(
  db: Database.Database,
  decision: string,
  reason: string,
  alternatives: string[],
  context: string,
  agent: string = 'arch'
): number {
  const content = `[DECISION] ${decision}. ` +
    `Reason: ${reason}. ` +
    (alternatives.length ? `Alternatives considered: ${alternatives.join(', ')}. ` : '') +
    `Context: ${context}`;

  const result = store(db, {
    content,
    category: 'decision',
    keywords: ['decision', 'reasoning', 'continuity', agent],
    state: 1,
    confidence: 'confirmed',
  });

  db.prepare(`INSERT INTO continuity_log (agent, type) VALUES (?, 'decision')`).run(agent);

  return result.id;
}

// ── Resume Logging ──

/**
 * Log a session resume and its continuity quality.
 */
export function logResume(db: Database.Database, score: ContinuityScore, agent: string = 'arch'): void {
  db.prepare(`
    INSERT INTO continuity_log (agent, type, blocks_pre_compact, heartbeat_stores,
      subtask_completions, resume_recall_tokens, time_to_continuity_ms, felt_gap)
    VALUES (?, 'resume', ?, ?, ?, ?, ?, ?)
  `).run(
    agent,
    score.blocksStoredPreCompact,
    score.heartbeatStoresThisSession,
    score.subtaskCompletions,
    score.resumeRecallTokens,
    score.timeToContinuityMs,
    score.selfReportedGap ? 1 : 0
  );
}

// ── Continuity Stats ──

/**
 * Get continuity health metrics for an agent.
 */
export function continuityStats(db: Database.Database, agent: string = 'arch'): {
  heartbeats_today: number;
  pre_compacts_today: number;
  subtasks_today: number;
  decisions_today: number;
  last_resume_gap_ms: number;
  total_resumes: number;
  gap_free_resumes: number;
} {
  const today = db.prepare(`
    SELECT type, COUNT(*) as c FROM continuity_log
    WHERE agent = ? AND created_at > datetime('now', '-24 hours')
    GROUP BY type
  `).all(agent) as Array<{ type: string; c: number }>;

  const counts: Record<string, number> = {};
  for (const row of today) counts[row.type] = row.c;

  const lastResume = db.prepare(`
    SELECT time_to_continuity_ms, felt_gap FROM continuity_log
    WHERE agent = ? AND type = 'resume'
    ORDER BY id DESC LIMIT 1
  `).get(agent) as { time_to_continuity_ms: number; felt_gap: number } | undefined;

  const resumeStats = db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN felt_gap = 0 THEN 1 ELSE 0 END) as gap_free
    FROM continuity_log WHERE agent = ? AND type = 'resume'
  `).get(agent) as { total: number; gap_free: number };

  return {
    heartbeats_today: counts['heartbeat'] || 0,
    pre_compacts_today: counts['pre-compact'] || 0,
    subtasks_today: counts['subtask'] || 0,
    decisions_today: counts['decision'] || 0,
    last_resume_gap_ms: lastResume?.time_to_continuity_ms || 0,
    total_resumes: resumeStats?.total || 0,
    gap_free_resumes: resumeStats?.gap_free || 0,
  };
}
