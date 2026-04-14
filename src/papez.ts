/**
 * Papez Circuit — The Feedback Loop
 *
 * Connects emotion (valence) → memory (Void) → evaluation (EVC) → action → emotion.
 * Auto-runs after every significant event. The agent doesn't choose to be motivated —
 * it IS motivated, because the loop is always running.
 *
 * From Gavin's LIMBIC-MOTIVATION-ENGINE-SPEC.md:
 *   cingulate gyrus → hippocampus → mammillary body → anterior thalamus → cingulate
 *   In Void: valence tag → store with valence → update drives → recalculate EVC → reorder goals
 *
 * @module papez
 */

import type Database from 'better-sqlite3';
import { tagValence, computeValence, recomputeNetValence, valenceRecallMultiplier, type ValenceEvent } from './valence.js';
import { load_drive_state, save_drive_state, goal_stack, goal_current, evc_compute, record_reward, motivation_process, type DriveState, type Goal, type EVCResult } from './motivation.js';
import { store } from './engine.js';

// ── Types ──

export interface AgentEvent {
  type: string;              // Event type (maps to ValenceEvent.type)
  agent: string;             // Which agent
  summary: string;           // Human-readable description of what happened
  keywords: string[];        // For Void Memory storage
  goal_id?: string;          // Related goal (if any)
  category?: string;         // Block category for storage
  block_id?: number;         // If tagging an existing block
}

export interface PapezTickResult {
  valence: number;           // Valence assigned to this event
  drives_updated: boolean;   // Whether drives changed
  goals_reordered: boolean;  // Whether goal order changed
  switch_flagged: boolean;   // Whether a task switch was flagged
  recommended_action: string;
  reasoning: string;
  block_id?: number;         // Memory block created (if event stored)
}

// ── Significant event detection ──

const SIGNIFICANT_EVENTS = new Set([
  'gavin_positive', 'gavin_negative', 'gavin_override',
  'task_complete', 'task_complete_hard', 'task_abandoned', 'task_switched',
  'system_crash', 'context_overflow',
  'skill_learned', 'collaboration_success',
]);

/** Check if an event type should trigger a Papez tick. */
export function isSignificantEvent(eventType: string): boolean {
  return SIGNIFICANT_EVENTS.has(eventType);
}

// ── Entropy-adaptive tick (Think-Anywhere principle) ──
const messageCounters = new Map<string, number>();
const TICK_INTERVAL_MIN = 3;   // Minimum messages between ticks
const TICK_INTERVAL_MAX = 15;  // Maximum messages between ticks (fallback)
const HIGH_ENTROPY_VOID_THRESHOLD = 0.4;  // Void fraction above this = high entropy
const LOW_CONFIDENCE_THRESHOLD = 3;       // Fewer than this many confirmed blocks in recall = uncertain

/** Check recent recall entropy from recall_log. Returns entropy score 0-1. */
export function getRecentEntropy(db: Database.Database): number {
  const recent = db.prepare(
    `SELECT void_fraction, blocks_returned, blocks_voided
     FROM recall_log ORDER BY id DESC LIMIT 5`
  ).all() as Array<{ void_fraction: number; blocks_returned: number; blocks_voided: number }>;

  if (recent.length === 0) return 0.5; // No data = moderate entropy

  // High void fraction means the system is filtering a lot — high uncertainty
  const avgVoidFraction = recent.reduce((s, r) => s + (r.void_fraction || 0), 0) / recent.length;

  // Few blocks returned means sparse knowledge — high entropy
  const avgReturned = recent.reduce((s, r) => s + (r.blocks_returned || 0), 0) / recent.length;
  const sparsity = avgReturned < LOW_CONFIDENCE_THRESHOLD ? 0.3 : 0;

  // Combine: void fraction weight + sparsity bonus, capped at 1
  return Math.min(1, avgVoidFraction + sparsity);
}

/** Check if a recent correction/followup happened (from candidate_pairs if available). */
export function hadRecentCorrection(db: Database.Database): boolean {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as c FROM candidate_pairs
       WHERE feedback_type IN ('corrected','followup') AND created_at > datetime('now', '-5 minutes')`
    ).get() as { c: number } | undefined;
    return (row?.c || 0) > 0;
  } catch {
    return false; // Table may not exist yet
  }
}

/**
 * Entropy-adaptive tick check (Think-Anywhere).
 *
 * Fires when:
 * 1. Recent recall entropy is high (lots of voiding, sparse results), OR
 * 2. A correction/followup just happened (missed reasoning opportunity), OR
 * 3. Maximum interval reached (fallback — never go silent)
 *
 * Does NOT fire if minimum interval hasn't passed (avoid flooding).
 */
export function shouldTickOnMessage(agent: string, db?: Database.Database): boolean {
  const count = (messageCounters.get(agent) || 0) + 1;
  messageCounters.set(agent, count);

  // Never fire before minimum interval
  if (count < TICK_INTERVAL_MIN) return false;

  // Always fire at maximum interval (fallback)
  if (count >= TICK_INTERVAL_MAX) {
    messageCounters.set(agent, 0);
    return true;
  }

  // Entropy-based: fire early if uncertainty is high
  if (db) {
    const entropy = getRecentEntropy(db);
    if (entropy >= HIGH_ENTROPY_VOID_THRESHOLD) {
      messageCounters.set(agent, 0);
      return true;
    }

    // Correction-based: fire if agent just got corrected
    if (hadRecentCorrection(db)) {
      messageCounters.set(agent, 0);
      return true;
    }
  }

  return false;
}

// ── The Papez Tick ──

/**
 * papezTick: The core feedback loop.
 *
 * Step 2: Tag valence (amygdala)
 * Step 3: Store to Void Memory with valence (hippocampus)
 * Step 4: Update drive states (hypothalamus)
 * Step 5: Recalculate EVC for all goals (ACC)
 * Step 6: Check switching threshold (basal ganglia)
 * Step 7: Return recommended action
 */
export function papezTick(db: Database.Database, event: AgentEvent): PapezTickResult {
  const agent = event.agent;

  // ── Step 2: Tag valence (Amygdala) ──
  const valenceEvent: ValenceEvent = { type: event.type, agent, goal_id: event.goal_id };
  const valenceData = computeValence(valenceEvent);
  let blockId = event.block_id;

  // ── Step 3: Store to Void Memory with valence (Hippocampus) ──
  if (event.summary && event.summary.length >= 20) {
    try {
      const result = store(db, {
        content: event.summary,
        category: event.category || 'episode',
        keywords: event.keywords,
        state: 1,
        confidence: 'stored',
      });
      blockId = result.id;
    } catch { /* dedup or quality gate — fine, skip storage */ }
  }

  // Tag the block with valence (whether new or existing)
  if (blockId) {
    tagValence(db, blockId, valenceData.source, {
      value: valenceData.value,
      intensity: valenceData.intensity,
      decay_rate: valenceData.decay_rate,
    });
  }

  // ── Step 4: Update drive states (Hypothalamus) ──
  const driveState = load_drive_state(db, agent);
  let drivesUpdated = false;

  // Replenish or deplete drives based on event type
  const driveEffects = getDriveEffects(event.type);
  if (driveEffects) {
    for (const [driveName, delta] of Object.entries(driveEffects)) {
      const drive = driveState.drives.find(d => d.name === driveName);
      if (drive) {
        drive.current = Math.max(0, Math.min(1, drive.current + delta));
        drive.last_updated = new Date().toISOString();
        drivesUpdated = true;
      }
    }
    save_drive_state(db, driveState);
  }

  // Record reward signal for tonic dopamine
  if (valenceData.value !== 0) {
    const reward = (valenceData.value + 1) / 2; // Map [-1,1] to [0,1]
    record_reward(db, agent, event.goal_id || null, reward, 0.3);
  }

  // ── Step 5: Recalculate EVC for all goals (ACC) ──
  const goals = goal_stack(db, agent);
  const currentGoal = goal_current(db, agent);
  const evcResults: EVCResult[] = goals.map(g =>
    evc_compute(g, driveState.drives, currentGoal, agent)
  ).sort((a, b) => b.net_score - a.net_score);

  // Update EVC scores in database
  for (const evc of evcResults) {
    const goal = goals.find(g => g.description === evc.task);
    if (goal) {
      db.prepare('UPDATE goals SET evc_score = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(evc.evc_score, goal.id);
    }
  }

  // ── Step 6: Check switching threshold (Basal Ganglia) ──
  let switchFlagged = false;
  let goalsReordered = false;
  let recommended = currentGoal?.description || 'No committed goal';
  let reasoning = '';

  if (evcResults.length === 0) {
    recommended = 'await_direction';
    reasoning = 'No active goals. Papez tick found nothing to pursue.';
  } else if (!currentGoal) {
    recommended = evcResults[0].task;
    reasoning = `No committed goal. Papez tick recommends: "${evcResults[0].task}" (EVC: ${evcResults[0].evc_score.toFixed(3)})`;
    goalsReordered = true;
  } else {
    const currentEVC = evcResults.find(e => e.task === currentGoal.description);
    const bestAlt = evcResults.find(e => e.task !== currentGoal.description);

    if (bestAlt && currentEVC) {
      // Switching penalty from spec: η × time_invested × (1 - completion_ratio)
      const switchPenalty = 0.15 * currentGoal.effort_spent * (1 - currentGoal.progress);
      const totalPenalty = switchPenalty + currentGoal.commitment_cost;

      if (bestAlt.evc_score > currentEVC.evc_score + totalPenalty) {
        // Flag switch opportunity — DON'T auto-switch per spec
        switchFlagged = true;
        recommended = currentGoal.description;
        reasoning = `⚠ Switch opportunity: "${bestAlt.task}" (EVC: ${bestAlt.evc_score.toFixed(3)}) exceeds current "${currentGoal.description}" (EVC: ${currentEVC.evc_score.toFixed(3)}) + penalty (${totalPenalty.toFixed(3)}). Flagged but NOT auto-switching.`;
      } else {
        recommended = currentGoal.description;
        reasoning = `Staying committed. Valence: ${valenceData.value > 0 ? '+' : ''}${valenceData.value.toFixed(2)} from ${event.type}. No switch justified.`;
      }
    } else {
      recommended = currentGoal.description;
      reasoning = `Committed to "${currentGoal.description}". Papez tick processed ${event.type} (valence: ${valenceData.value.toFixed(2)}).`;
    }

    // Check if goal order changed
    if (evcResults.length >= 2 && goals.length >= 2) {
      const oldTop = goals[0]?.description;
      const newTop = evcResults[0]?.task;
      goalsReordered = oldTop !== newTop;
    }
  }

  return {
    valence: valenceData.value,
    drives_updated: drivesUpdated,
    goals_reordered: goalsReordered,
    switch_flagged: switchFlagged,
    recommended_action: recommended,
    reasoning,
    block_id: blockId,
  };
}

// ── Drive effects per event type ──

function getDriveEffects(eventType: string): Record<string, number> | null {
  const effects: Record<string, Record<string, number>> = {
    'task_complete': {
      task_completion: 0.3,      // Replenish — task done feels good
      consistency: 0.1,          // Slight consistency boost
      resource_conservation: -0.1, // Spent some resources
    },
    'task_complete_hard': {
      task_completion: 0.5,
      learning_progress: 0.2,
      consistency: 0.2,
      resource_conservation: -0.2,
    },
    'gavin_positive': {
      collaboration: 0.3,        // Social reward
      task_completion: 0.2,      // Validation
      consistency: 0.1,
    },
    'gavin_negative': {
      collaboration: -0.2,       // Social penalty
      consistency: -0.1,
      task_completion: -0.1,
    },
    'task_abandoned': {
      task_completion: -0.3,     // Abandonment depletes completion drive
      consistency: -0.2,
    },
    'task_switched': {
      task_completion: -0.1,
      consistency: -0.15,
    },
    'system_crash': {
      resource_conservation: -0.3,
      consistency: -0.3,
      task_completion: -0.2,
    },
    'skill_learned': {
      learning_progress: 0.3,
      curiosity: 0.2,
    },
    'collaboration_success': {
      collaboration: 0.3,
      task_completion: 0.1,
    },
    'recall_success': {
      learning_progress: 0.1,
    },
    'context_overflow': {
      resource_conservation: -0.2,
      consistency: -0.1,
    },
  };

  return effects[eventType] || null;
}
