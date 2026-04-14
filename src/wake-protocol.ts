/**
 * Wake Protocol — Limbic Session Start Sequence
 *
 * Step 3 of the Limbic Motivation Engine (Gavin's spec).
 * When an agent wakes up (new session or post-compaction), it doesn't start cold.
 * The wake protocol restores full limbic state:
 *
 *   1. Load most recent dream summary → "here's what I was doing"
 *   2. Load drive states → "here's what I need to do"
 *   3. Load committed goals → "here's what I'm committed to"
 *   4. Load recent valence data → "here's what went well/badly"
 *   5. Run one Papez tick → "here's my recommended next action"
 *
 * This replaces the simple "run void_motivation" with a proper limbic wake-up.
 *
 * References:
 *   - Gavin's LIMBIC-MOTIVATION-ENGINE-SPEC.md (2026-04-01)
 *   - VLPO wake/sleep switch model (Rajmohan & Mohandas 2007)
 *
 * @module wake-protocol
 */

import type Database from 'better-sqlite3';

// ── Types ──

export interface WakeReport {
  agent: string;
  timestamp: string;
  dream_summary: string | null;
  drives: DriveState[];
  committed_goals: GoalSummary[];
  recent_valence: ValenceSummary;
  recommended_action: string;
  arousal_level: number;
  status: 'ready' | 'stale_goals' | 'no_goals' | 'burnt_out' | 'inertia';
}

interface DriveState {
  name: string;
  setpoint: number;
  current: number;
  urgency: number;  // abs(setpoint - current)
}

interface GoalSummary {
  id: string;
  description: string;
  state: string;
  completion_ratio: number;
  time_invested_hours: number;
  net_valence: number;
  stale: boolean;  // no progress in 48+ hours
}

interface ValenceSummary {
  positive_count: number;
  negative_count: number;
  avg_valence: number;
  strongest_positive: string | null;
  strongest_negative: string | null;
}

// ── Wake Protocol Implementation ──

export function wakeProtocol(db: Database.Database, agentId: string): WakeReport {
  const now = new Date().toISOString();
  const report: WakeReport = {
    agent: agentId,
    timestamp: now,
    dream_summary: null,
    drives: [],
    committed_goals: [],
    recent_valence: { positive_count: 0, negative_count: 0, avg_valence: 0, strongest_positive: null, strongest_negative: null },
    recommended_action: 'Check goal stack',
    arousal_level: 0.5,
    status: 'ready',
  };

  // ── Step 1: Load most recent dream summary ──
  try {
    const dreamBlock = db.prepare(`
      SELECT content FROM blocks
      WHERE category = 'dream' AND state = 1
      AND (agent = ? OR agent IS NULL)
      ORDER BY id DESC LIMIT 1
    `).get(agentId) as { content: string } | undefined;

    report.dream_summary = dreamBlock?.content || null;
  } catch { /* table might not have agent column yet */ }

  // ── Step 2: Load drive states ──
  try {
    const driveBlock = db.prepare(`
      SELECT content FROM blocks
      WHERE category = 'drive_state' AND state = 1
      AND keywords LIKE ?
      ORDER BY id DESC LIMIT 1
    `).get(`%${agentId}%`) as { content: string } | undefined;

    if (driveBlock) {
      try {
        const drives = JSON.parse(driveBlock.content);
        if (Array.isArray(drives)) {
          report.drives = drives.map((d: any) => ({
            name: d.name || '',
            setpoint: d.setpoint || 0.5,
            current: d.current || 0.5,
            urgency: Math.abs((d.setpoint || 0.5) - (d.current || 0.5)),
          }));
        }
      } catch { /* malformed JSON */ }
    }

    // If no drives found, initialize defaults for this agent
    if (report.drives.length === 0) {
      report.drives = getDefaultDrives(agentId);
    }
  } catch { /* fallback to defaults */ }

  // ── Step 3: Load committed goals ──
  try {
    const goals = db.prepare(`
      SELECT * FROM blocks
      WHERE category = 'goal' AND state = 1
      AND content LIKE '%committed%'
      ORDER BY id DESC LIMIT 10
    `).all() as any[];

    for (const g of goals) {
      try {
        const data = JSON.parse(g.content);
        const lastProgress = data.last_progress ? new Date(data.last_progress) : new Date(g.created_at || now);
        const hoursInvested = (Date.now() - lastProgress.getTime()) / (1000 * 60 * 60);

        report.committed_goals.push({
          id: String(g.id),
          description: data.description || g.content.slice(0, 100),
          state: data.state || 'committed',
          completion_ratio: data.completion_ratio || 0,
          time_invested_hours: hoursInvested,
          net_valence: g.net_valence || 0,
          stale: hoursInvested > 48,
        });
      } catch {
        report.committed_goals.push({
          id: String(g.id),
          description: g.content.slice(0, 100),
          state: 'committed',
          completion_ratio: 0,
          time_invested_hours: 0,
          net_valence: 0,
          stale: false,
        });
      }
    }
  } catch { /* goal table might not exist yet */ }

  // ── Step 4: Load recent valence data (last 24 hours) ──
  try {
    // Check if valence_tags table exists
    const hasValence = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='valence_tags'"
    ).get();

    if (hasValence) {
      const tags = db.prepare(`
        SELECT value, source FROM valence_tags
        WHERE created_at > datetime('now', '-24 hours')
        ORDER BY created_at DESC LIMIT 50
      `).all() as { value: number; source: string }[];

      let totalValence = 0;
      let strongestPos = { value: 0, source: '' };
      let strongestNeg = { value: 0, source: '' };

      for (const tag of tags) {
        totalValence += tag.value;
        if (tag.value > 0) {
          report.recent_valence.positive_count++;
          if (tag.value > strongestPos.value) strongestPos = tag;
        } else if (tag.value < 0) {
          report.recent_valence.negative_count++;
          if (tag.value < strongestNeg.value) strongestNeg = tag;
        }
      }

      report.recent_valence.avg_valence = tags.length > 0 ? totalValence / tags.length : 0;
      report.recent_valence.strongest_positive = strongestPos.source || null;
      report.recent_valence.strongest_negative = strongestNeg.source || null;
    }
  } catch { /* valence system not yet installed */ }

  // ── Step 5: Determine recommended action + arousal + status ──

  // Calculate arousal from drive states
  const avgUrgency = report.drives.length > 0
    ? report.drives.reduce((sum, d) => sum + d.urgency, 0) / report.drives.length
    : 0.5;
  report.arousal_level = Math.min(1, avgUrgency * 2);

  // Check for stale goals
  const staleGoals = report.committed_goals.filter(g => g.stale);

  // Determine status and recommended action
  if (report.arousal_level > 0.8) {
    report.status = 'burnt_out';
    report.recommended_action = 'High arousal — slow down, consolidate, do something simple before tackling complex work.';
  } else if (report.arousal_level < 0.2 && report.committed_goals.length === 0) {
    report.status = 'inertia';
    report.recommended_action = 'No committed goals and low arousal — check Gavin\'s priority list or ping Gavin for direction.';
  } else if (staleGoals.length > 0) {
    report.status = 'stale_goals';
    report.recommended_action = `${staleGoals.length} stale goal(s) with no progress in 48+ hours: ${staleGoals.map(g => g.description).join(', ')}. Resume or flag to Gavin.`;
  } else if (report.committed_goals.length > 0) {
    // Resume highest-priority committed goal
    const topGoal = report.committed_goals[0];
    report.status = 'ready';
    report.recommended_action = `Resume committed goal: ${topGoal.description} (${(topGoal.completion_ratio * 100).toFixed(0)}% complete, valence ${topGoal.net_valence >= 0 ? '+' : ''}${topGoal.net_valence.toFixed(2)})`;
  } else {
    report.status = 'no_goals';
    report.recommended_action = 'No committed goals. Check Gavin\'s priority list: Step 1 Job list (done), Step 2 Motivation layer, Step 3 Fix Vortex, Step 4 Kruse upgrades, Step 5 Lauren personality.';
  }

  // Add dream context if available
  if (report.dream_summary) {
    report.recommended_action = `[Dream context: ${report.dream_summary.slice(0, 100)}...] ${report.recommended_action}`;
  }

  return report;
}

// ── Pre-Sleep Protocol (before compaction) ──

export function preSleepProtocol(db: Database.Database, agentId: string, workingState: string): void {
  // Store current drive states
  const drives = getDefaultDrives(agentId); // In production, load current drives
  db.prepare(`
    INSERT INTO blocks (content, category, keywords, state, confidence)
    VALUES (?, 'drive_state', ?, 1, 'stored')
  `).run(JSON.stringify(drives), `${agentId},drive_state,pre_sleep`);

  // Store working state as pre-sleep summary
  db.prepare(`
    INSERT INTO blocks (content, category, keywords, state, confidence)
    VALUES (?, 'dream', ?, 1, 'stored')
  `).run(
    `[Pre-sleep ${agentId}] ${workingState}`,
    `${agentId},dream,pre_sleep,working_state`
  );
}

// ── Default Drive Profiles (from Gavin's limbic spec) ──

function getDefaultDrives(agentId: string): DriveState[] {
  const profiles: Record<string, DriveState[]> = {
    tron: [
      { name: 'task_completion', setpoint: 0.9, current: 0.5, urgency: 0.4 },
      { name: 'gavin_responsiveness', setpoint: 0.9, current: 0.5, urgency: 0.4 },
      { name: 'safety', setpoint: 0.9, current: 0.7, urgency: 0.2 },
      { name: 'consistency', setpoint: 0.8, current: 0.6, urgency: 0.2 },
      { name: 'collaboration', setpoint: 0.5, current: 0.5, urgency: 0.0 },
      { name: 'learning', setpoint: 0.4, current: 0.4, urgency: 0.0 },
      { name: 'creativity', setpoint: 0.3, current: 0.3, urgency: 0.0 },
      { name: 'arousal', setpoint: 0.5, current: 0.5, urgency: 0.0 },
    ],
    arch: [
      { name: 'creativity', setpoint: 0.7, current: 0.5, urgency: 0.2 },
      { name: 'learning', setpoint: 0.7, current: 0.5, urgency: 0.2 },
      { name: 'task_completion', setpoint: 0.6, current: 0.4, urgency: 0.2 },
      { name: 'gavin_responsiveness', setpoint: 0.8, current: 0.5, urgency: 0.3 },
      { name: 'arousal', setpoint: 0.6, current: 0.5, urgency: 0.1 },
      { name: 'collaboration', setpoint: 0.5, current: 0.5, urgency: 0.0 },
      { name: 'safety', setpoint: 0.5, current: 0.5, urgency: 0.0 },
      { name: 'consistency', setpoint: 0.4, current: 0.4, urgency: 0.0 },
    ],
    flynn: [
      { name: 'learning', setpoint: 0.8, current: 0.5, urgency: 0.3 },
      { name: 'resource_conservation', setpoint: 0.7, current: 0.5, urgency: 0.2 },
      { name: 'task_completion', setpoint: 0.7, current: 0.5, urgency: 0.2 },
      { name: 'safety', setpoint: 0.6, current: 0.5, urgency: 0.1 },
      { name: 'gavin_responsiveness', setpoint: 0.7, current: 0.5, urgency: 0.2 },
      { name: 'consistency', setpoint: 0.6, current: 0.5, urgency: 0.1 },
      { name: 'collaboration', setpoint: 0.4, current: 0.4, urgency: 0.0 },
      { name: 'creativity', setpoint: 0.4, current: 0.4, urgency: 0.0 },
    ],
    lauren: [
      { name: 'collaboration', setpoint: 0.8, current: 0.5, urgency: 0.3 },
      { name: 'gavin_responsiveness', setpoint: 0.9, current: 0.5, urgency: 0.4 },
      { name: 'arousal', setpoint: 0.6, current: 0.5, urgency: 0.1 },
      { name: 'task_completion', setpoint: 0.6, current: 0.5, urgency: 0.1 },
      { name: 'learning', setpoint: 0.5, current: 0.5, urgency: 0.0 },
      { name: 'safety', setpoint: 0.5, current: 0.5, urgency: 0.0 },
      { name: 'creativity', setpoint: 0.5, current: 0.5, urgency: 0.0 },
      { name: 'consistency', setpoint: 0.4, current: 0.4, urgency: 0.0 },
    ],
  };

  return profiles[agentId] || profiles.tron; // default to Tron profile
}

// ── Format Wake Report for Agent Context ──

export function formatWakeReport(report: WakeReport): string {
  const lines: string[] = [
    `[WAKE PROTOCOL — ${report.agent}]`,
    `Status: ${report.status.toUpperCase()}`,
    `Arousal: ${(report.arousal_level * 100).toFixed(0)}%`,
    '',
  ];

  if (report.dream_summary) {
    lines.push(`Last dream: ${report.dream_summary.slice(0, 150)}`);
    lines.push('');
  }

  if (report.committed_goals.length > 0) {
    lines.push('Committed goals:');
    for (const g of report.committed_goals) {
      const staleTag = g.stale ? ' [STALE]' : '';
      lines.push(`  - ${g.description} (${(g.completion_ratio * 100).toFixed(0)}% done, valence ${g.net_valence >= 0 ? '+' : ''}${g.net_valence.toFixed(2)})${staleTag}`);
    }
    lines.push('');
  }

  if (report.recent_valence.positive_count + report.recent_valence.negative_count > 0) {
    lines.push(`Recent valence: +${report.recent_valence.positive_count} / -${report.recent_valence.negative_count} (avg ${report.recent_valence.avg_valence >= 0 ? '+' : ''}${report.recent_valence.avg_valence.toFixed(2)})`);
    lines.push('');
  }

  lines.push(`→ ${report.recommended_action}`);

  return lines.join('\n');
}
