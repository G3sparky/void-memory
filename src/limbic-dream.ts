/**
 * Limbic Dream Cycle — VLPO Sleep Switch
 *
 * Wraps the existing dream engine with limbic integration:
 * 1. Drive rebalancing (homeostatic recovery toward setpoints)
 * 2. Valence decay (prevents ancient emotions from permanently blocking)
 * 3. Goal housekeeping (stale goals flagged, completed → void, abandoned → inhibitory)
 * 4. Pattern consolidation (positively-valenced patterns reinforced)
 * 5. Dream summary generation (stored for next wake protocol)
 *
 * Plus the existing dream engine's:
 * - Cross-domain connection discovery
 * - Gap detection
 * - Duplicate merging
 * - Forgotten block surfacing
 *
 * From Gavin's LIMBIC-MOTIVATION-ENGINE-SPEC.md (VLPO section)
 *
 * @module limbic-dream
 */

import type Database from 'better-sqlite3';
import { dream, storeDreamInsights, type DreamReport } from './dream.js';
import { load_drive_state, save_drive_state, goal_stack, adaptSetpoints, type DriveState, type Goal } from './motivation.js';
import { decayValence, recomputeNetValence } from './valence.js';
import { store } from './engine.js';
import { identifyHabitCandidates } from './arbitration.js';

// ── Types ──

export interface LimbicDreamReport extends DreamReport {
  limbic: {
    drives_rebalanced: { name: string; before: number; after: number; setpoint: number }[];
    valence_decayed: number;
    valence_removed: number;
    stale_goals: string[];
    completed_goals_voided: number;
    patterns_reinforced: number;
    habits_consolidated: number;
    setpoints_adapted: number;
    dream_summary_block_id: number | null;
  };
}

// ── Constants ──

const DRIVE_RECOVERY_RATE = 0.3;    // Restore 30% of distance to setpoint per cycle
const STALE_HOURS = 48;              // Goals with no progress in 48h are flagged stale
const POSITIVE_VALENCE_THRESHOLD = 0.3;  // Blocks above this get confidence boost
const CONFIDENCE_BOOST = 0.05;       // How much confidence increases per dream cycle

// ── The Limbic Dream Cycle ──

export function limbicDream(db: Database.Database, agent: string): LimbicDreamReport {
  // Run the base dream engine first (consolidation, connections, gaps, patterns)
  const baseReport = dream(db);

  const limbicResult = {
    drives_rebalanced: [] as { name: string; before: number; after: number; setpoint: number }[],
    valence_decayed: 0,
    valence_removed: 0,
    stale_goals: [] as string[],
    completed_goals_voided: 0,
    patterns_reinforced: 0,
    habits_consolidated: 0,
    setpoints_adapted: 0,
    dream_summary_block_id: null as number | null,
  };

  // ── 1. Drive Rebalancing (Homeostatic Recovery) ──
  // During "sleep", drives that drifted far from setpoint partially restore.
  // Like the body recovering during sleep — not full reset, just partial recovery.
  try {
    const driveState = load_drive_state(db, agent);

    for (const drive of driveState.drives) {
      const before = drive.current;
      const distance = drive.setpoint - drive.current;
      drive.current += distance * DRIVE_RECOVERY_RATE;
      drive.current = Math.max(0, Math.min(1, drive.current));
      drive.last_updated = new Date().toISOString();

      limbicResult.drives_rebalanced.push({
        name: drive.name,
        before: Math.round(before * 100) / 100,
        after: Math.round(drive.current * 100) / 100,
        setpoint: drive.setpoint,
      });
    }

    save_drive_state(db, driveState);
  } catch (e: any) {
    console.error('[limbic-dream] Drive rebalancing failed:', e.message);
  }

  // ── 2. Valence Decay ──
  // Strong emotional tags fade slightly over time.
  // Prevents ancient negative experiences from permanently blocking tasks.
  // Ancient positive experiences also fade — but core identity tags have low decay rates.
  try {
    const decayResult = decayValence(db);
    limbicResult.valence_decayed = decayResult.decayed;
    limbicResult.valence_removed = decayResult.removed;
  } catch (e: any) {
    console.error('[limbic-dream] Valence decay failed:', e.message);
  }

  // ── 3. Goal Housekeeping ──
  // Stale goals (no progress in 48h) get flagged.
  // Completed goals confirmed in void state.
  // Abandoned goals confirmed in inhibitory state.
  try {
    const goals = goal_stack(db, agent);
    const now = Date.now();

    for (const goal of goals) {
      const updatedAt = new Date(goal.updated_at).getTime();
      const hoursSinceUpdate = (now - updatedAt) / 3600000;

      // Flag stale committed goals
      if (goal.state === 'committed' && hoursSinceUpdate > STALE_HOURS) {
        limbicResult.stale_goals.push(goal.id);
        // Don't auto-abandon — just flag. Gavin or agent decides.
        db.prepare(`UPDATE goals SET updated_at = datetime('now') WHERE id = ?`).run(goal.id);
      }
    }

    // Move completed goals' linked blocks to void state
    const completedGoals = db.prepare(
      `SELECT * FROM goals WHERE agent = ? AND state = 'completed' AND block_id IS NOT NULL`
    ).all(agent) as Goal[];

    for (const goal of completedGoals) {
      if (goal.block_id) {
        const block = db.prepare('SELECT state FROM blocks WHERE id = ?').get(goal.block_id) as { state: number } | undefined;
        if (block && block.state === 1) {
          // Active → void (completed goals are dormant storage, not active recall)
          db.prepare('UPDATE blocks SET state = 0 WHERE id = ?').run(goal.block_id);
          limbicResult.completed_goals_voided++;
        }
      }
    }
  } catch (e: any) {
    console.error('[limbic-dream] Goal housekeeping failed:', e.message);
  }

  // ── 4. Pattern Consolidation (Hippocampal Replay) ──
  // Positively-valenced episodes get confidence boost.
  // This is the "replay" mechanism — successful strategies get reinforced in memory.
  try {
    const positiveBlocks = db.prepare(`
      SELECT id, confidence FROM blocks
      WHERE state >= 0 AND net_valence > ? AND category = 'episode'
      ORDER BY net_valence DESC LIMIT 20
    `).all(POSITIVE_VALENCE_THRESHOLD) as { id: number; confidence: string }[];

    const confOrder = ['observed', 'stored', 'accessed', 'confirmed'];

    for (const block of positiveBlocks) {
      const currentIdx = confOrder.indexOf(block.confidence);
      if (currentIdx < confOrder.length - 1) {
        // Boost: observed → stored, stored → accessed, accessed → confirmed
        // Only boost one level per dream cycle (gradual reinforcement)
        const nextConf = confOrder[Math.min(currentIdx + 1, confOrder.length - 1)];
        db.prepare('UPDATE blocks SET confidence = ? WHERE id = ?').run(nextConf, block.id);
        limbicResult.patterns_reinforced++;
      }
    }
  } catch (e: any) {
    console.error('[limbic-dream] Pattern consolidation failed:', e.message);
  }

  // ── 5. Habit Consolidation (Circuit C: Basal Ganglia → VLPO) ──
  // Confirmed blocks with positive valence and high access count become habits.
  // This is the Layer 5 ↔ dream cycle connection.
  try {
    const habitCandidates = identifyHabitCandidates(db);
    // Habits get a small access_count boost during sleep (hippocampal replay)
    for (const habit of habitCandidates) {
      db.prepare('UPDATE blocks SET access_count = access_count + 1 WHERE id = ?').run(habit.id);
      limbicResult.habits_consolidated++;
    }
  } catch (e: any) {
    console.error('[limbic-dream] Habit consolidation failed:', e.message);
  }

  // ── 6. Setpoint Adaptation (Layer 1 dynamic personality) ──
  // Drive setpoints slowly shift based on recent reward history.
  try {
    const adaptation = adaptSetpoints(db, agent);
    limbicResult.setpoints_adapted = adaptation.adapted.length;
  } catch (e: any) {
    console.error('[limbic-dream] Setpoint adaptation failed:', e.message);
  }

  // ── 7. Generate and Store Dream Summary ──
  // A structured summary of the dream cycle for the wake protocol.
  try {
    const drivesSummary = limbicResult.drives_rebalanced
      .filter(d => Math.abs(d.after - d.before) > 0.01)
      .map(d => `${d.name}: ${d.before}→${d.after}`)
      .join(', ');

    const summary = [
      `DREAM CYCLE [${agent}] ${new Date().toISOString().slice(0, 16)}`,
      `Consolidation: ${baseReport.consolidations.merged} merged, ${baseReport.consolidations.decayed} decayed, ${baseReport.consolidations.confirmed} confirmed`,
      `Insights: ${baseReport.consolidations.connections_discovered} connections, ${baseReport.consolidations.gaps_detected} gaps, ${baseReport.consolidations.patterns_found} patterns`,
      drivesSummary ? `Drive recovery: ${drivesSummary}` : null,
      limbicResult.valence_removed > 0 ? `Valence cleanup: ${limbicResult.valence_removed} expired tags removed` : null,
      limbicResult.stale_goals.length > 0 ? `⚠ Stale goals (48h+ no progress): ${limbicResult.stale_goals.length}` : null,
      limbicResult.patterns_reinforced > 0 ? `Reinforced: ${limbicResult.patterns_reinforced} positive patterns promoted` : null,
      limbicResult.habits_consolidated > 0 ? `Habits consolidated: ${limbicResult.habits_consolidated} (Layer 5 replay)` : null,
      limbicResult.setpoints_adapted > 0 ? `Setpoints adapted: ${limbicResult.setpoints_adapted} drives shifted (Layer 1 personality)` : null,
    ].filter(Boolean).join('. ');

    if (summary.length >= 20) {
      try {
        const result = store(db, {
          content: summary,
          category: 'episode',
          keywords: ['dream-cycle', 'consolidation', 'limbic', agent],
          state: 1,
          confidence: 'stored',
        });
        limbicResult.dream_summary_block_id = result.id;
      } catch { /* dedup — fine */ }
    }
  } catch (e: any) {
    console.error('[limbic-dream] Dream summary failed:', e.message);
  }

  // Combine base + limbic reports
  return {
    ...baseReport,
    limbic: limbicResult,
  };
}

/**
 * Store top limbic dream insights alongside base dream insights.
 */
export function storeLimbicDreamInsights(db: Database.Database, report: LimbicDreamReport): number {
  // Store base dream insights
  let count = storeDreamInsights(db, report);

  // Store stale goal warnings as insights
  if (report.limbic.stale_goals.length > 0) {
    try {
      store(db, {
        content: `Dream cycle flagged ${report.limbic.stale_goals.length} stale goals with no progress in 48+ hours. Goal IDs: ${report.limbic.stale_goals.join(', ')}. Consider: are these still relevant? Resume or abandon.`,
        category: 'context',
        keywords: ['dream-warning', 'stale-goals', 'limbic'],
        state: 1,
        confidence: 'stored',
      });
      count++;
    } catch { /* dedup */ }
  }

  return count;
}
