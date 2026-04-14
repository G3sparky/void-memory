/**
 * Layer 5: Dual-Process Arbitration — Basal Ganglia Model
 *
 * Two parallel pathways evaluate every decision:
 *   HABITUAL (fast): Uses confirmed memory blocks + cached EVC scores.
 *     Fires when the situation is familiar and low-stakes.
 *   DELIBERATIVE (slow): Full EVC computation with drive states and reward prediction.
 *     Fires when the situation is novel, high-stakes, or uncertain.
 *
 * The Arbitrator picks which pathway's recommendation to follow based on:
 *   - Novelty: How familiar is this situation? (confirmed block count)
 *   - Stakes: How much could go wrong? (effort invested, goal priority)
 *   - Time pressure: How urgent? (drive urgency, tonic dopamine)
 *
 * Go/NoGo model (Mink 1996, Frank 2006):
 *   Go pathway: activates actions — "do this"
 *   NoGo pathway: inhibits actions — "don't do that" (inhibitory blocks)
 *
 * Connection to VLPO (dream cycle): habits are consolidated during sleep.
 * Confirmed blocks with positive valence become habitual responses.
 *
 * References:
 *   - Daw et al. (2005) model-based vs model-free RL
 *   - Frank (2006) Go/NoGo basal ganglia model
 *   - Keramati et al. (2011) speed-accuracy tradeoff in arbitration
 *
 * @module arbitration
 */

import type Database from 'better-sqlite3';
import {
  load_drive_state,
  motivation_process,
  evc_compute,
  goal_current,
  goal_stack,
  reward_predict,
  drive_urgency,
  AGENT_REWARD_PROFILES,
  type Goal,
  type EVCResult,
  type MotivationOutput,
  type RewardProfile,
} from './motivation.js';

// ── Types ──

/** Result from the habitual (fast) pathway. */
export interface HabitualResult {
  recommendation: string;
  confidence: number;       // 0-1: how confident the habit is
  source: 'cached_evc' | 'confirmed_block' | 'prior_success';
  reasoning: string;
  latency_ms: number;
}

/** Result from the deliberative (slow) pathway. */
export interface DeliberativeResult {
  recommendation: string;
  evc_score: number;
  full_analysis: MotivationOutput;
  reasoning: string;
  latency_ms: number;
}

/** Go signal: pursue this action. */
export interface GoSignal {
  action: string;
  strength: number;         // 0-1: how strongly to pursue
  source_goal_id?: string;
  reasoning: string;
}

/** NoGo signal: inhibit this action. */
export interface NoGoSignal {
  action: string;
  strength: number;         // 0-1: how strongly to inhibit
  source_block_id?: number; // inhibitory memory block
  reasoning: string;
}

/** Final arbitration output. */
export interface ArbitrationResult {
  pathway_used: 'habitual' | 'deliberative' | 'blended';
  recommendation: string;
  confidence: number;
  go_signals: GoSignal[];
  nogo_signals: NoGoSignal[];
  novelty_score: number;    // 0-1: how novel the situation is
  stakes_score: number;     // 0-1: how much is at risk
  urgency_score: number;    // 0-1: how time-pressured
  habitual: HabitualResult | null;
  deliberative: DeliberativeResult | null;
  reasoning: string;
}

// ── Constants ──

// Arbitration thresholds (Keramati et al. 2011 speed-accuracy tradeoff)
const NOVELTY_THRESHOLD = 0.5;       // Above this → use deliberative
const STAKES_THRESHOLD = 0.6;        // Above this → use deliberative
const HABIT_CONFIDENCE_MIN = 0.6;    // Minimum confidence to trust habitual
const BLENDING_ZONE = 0.15;          // Range around thresholds where both pathways contribute
const NOGO_INHIBITION_THRESHOLD = 0.3; // NoGo signals above this block the action

// ── Habitual Pathway (Fast — Model-Free) ──

/**
 * Fast pathway: check confirmed memory blocks for cached responses.
 * Uses pattern matching on prior successful actions, not full EVC.
 */
export function habitualEvaluate(
  db: Database.Database,
  agent: string,
  context: string
): HabitualResult {
  const start = Date.now();

  // 1. Check for confirmed blocks matching this context (habitual memory)
  const keywords = extractKeywords(context);
  const keywordPattern = keywords.map(k => `%${k}%`);

  let bestMatch: { content: string; confidence: string; net_valence: number; access_count: number } | null = null;
  let bestScore = 0;

  // Search confirmed blocks (habits are confirmed through repeated access)
  const confirmedBlocks = db.prepare(`
    SELECT content, confidence, net_valence, access_count
    FROM blocks
    WHERE state = 1 AND confidence = 'confirmed'
    AND category IN ('decision', 'pattern', 'skill')
    ORDER BY access_count DESC, net_valence DESC
    LIMIT 50
  `).all() as { content: string; confidence: string; net_valence: number; access_count: number }[];

  for (const block of confirmedBlocks) {
    const contentLower = block.content.toLowerCase();
    const matchCount = keywords.filter(k => contentLower.includes(k)).length;
    const score = (matchCount / Math.max(keywords.length, 1)) * 0.7
      + (block.net_valence > 0 ? 0.2 : 0)
      + (block.access_count > 5 ? 0.1 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = block;
    }
  }

  // 2. Check cached EVC scores from recent goal evaluations
  const currentGoal = goal_current(db, agent);
  let cachedRecommendation = '';
  let cachedConfidence = 0;

  if (currentGoal && currentGoal.state === 'committed') {
    // If we have a committed goal with high EVC, the habit is "keep going"
    cachedRecommendation = currentGoal.description;
    cachedConfidence = Math.min(1, 0.5 + currentGoal.progress * 0.3 + currentGoal.evc_score * 0.2);
  }

  // Pick the stronger signal
  const latency = Date.now() - start;

  if (bestMatch && bestScore > cachedConfidence) {
    return {
      recommendation: bestMatch.content.slice(0, 120),
      confidence: bestScore,
      source: 'confirmed_block',
      reasoning: `Habitual: matched confirmed block (score: ${bestScore.toFixed(2)}, valence: ${bestMatch.net_valence.toFixed(2)}, accessed: ${bestMatch.access_count}x)`,
      latency_ms: latency,
    };
  }

  if (cachedRecommendation) {
    return {
      recommendation: cachedRecommendation,
      confidence: cachedConfidence,
      source: 'cached_evc',
      reasoning: `Habitual: continue committed goal (confidence: ${cachedConfidence.toFixed(2)}, progress: ${(currentGoal!.progress * 100).toFixed(0)}%)`,
      latency_ms: latency,
    };
  }

  return {
    recommendation: '',
    confidence: 0,
    source: 'cached_evc',
    reasoning: 'Habitual: no prior habits for this context',
    latency_ms: latency,
  };
}

// ── Deliberative Pathway (Slow — Model-Based) ──

/**
 * Slow pathway: full EVC computation with drive states, reward prediction,
 * and commitment analysis. Uses the complete motivation engine.
 */
export function deliberativeEvaluate(
  db: Database.Database,
  agent: string,
  _context: string
): DeliberativeResult {
  const start = Date.now();

  const fullAnalysis = motivation_process(db, agent);

  return {
    recommendation: fullAnalysis.recommended_action,
    evc_score: fullAnalysis.evc_rankings.length > 0 ? fullAnalysis.evc_rankings[0].evc_score : 0,
    full_analysis: fullAnalysis,
    reasoning: `Deliberative: ${fullAnalysis.reasoning}`,
    latency_ms: Date.now() - start,
  };
}

// ── Go/NoGo Evaluation ──

/**
 * Go pathway: find reasons TO take an action.
 * Scans active blocks with positive valence related to the context.
 */
export function evaluateGo(
  db: Database.Database,
  agent: string,
  context: string
): GoSignal[] {
  const keywords = extractKeywords(context);
  const goals = goal_stack(db, agent);
  const signals: GoSignal[] = [];

  // Active goals with positive EVC are Go signals
  for (const goal of goals.slice(0, 5)) {
    if (goal.evc_score > 0) {
      const relevance = keywords.filter(k =>
        goal.description.toLowerCase().includes(k)
      ).length / Math.max(keywords.length, 1);

      if (relevance > 0.1 || goal.state === 'committed') {
        signals.push({
          action: goal.description,
          strength: Math.min(1, goal.evc_score * 0.5 + relevance * 0.5),
          source_goal_id: goal.id,
          reasoning: `Goal "${goal.description.slice(0, 60)}" has positive EVC (${goal.evc_score.toFixed(3)})`,
        });
      }
    }
  }

  // Positive-valence confirmed blocks are also Go signals
  const positiveBlocks = db.prepare(`
    SELECT id, content, net_valence FROM blocks
    WHERE state = 1 AND confidence = 'confirmed' AND net_valence > 0.2
    AND category IN ('decision', 'pattern', 'episode')
    ORDER BY net_valence DESC LIMIT 5
  `).all() as { id: number; content: string; net_valence: number }[];

  for (const block of positiveBlocks) {
    const relevance = keywords.filter(k =>
      block.content.toLowerCase().includes(k)
    ).length / Math.max(keywords.length, 1);

    if (relevance > 0.2) {
      signals.push({
        action: block.content.slice(0, 120),
        strength: block.net_valence * relevance,
        reasoning: `Positive memory (valence: ${block.net_valence.toFixed(2)}) supports this approach`,
      });
    }
  }

  return signals.sort((a, b) => b.strength - a.strength).slice(0, 5);
}

/**
 * NoGo pathway: find reasons NOT to take an action.
 * Scans inhibitory blocks and negative-valence memories related to the context.
 */
export function evaluateNoGo(
  db: Database.Database,
  _agent: string,
  context: string
): NoGoSignal[] {
  const keywords = extractKeywords(context);
  const signals: NoGoSignal[] = [];

  // Inhibitory blocks (state = -1) are the strongest NoGo signals
  // These are things the system has explicitly learned NOT to do
  const inhibitoryBlocks = db.prepare(`
    SELECT id, content FROM blocks
    WHERE state = -1
    ORDER BY created_at DESC LIMIT 30
  `).all() as { id: number; content: string }[];

  for (const block of inhibitoryBlocks) {
    const contentLower = block.content.toLowerCase();
    const matchedKeywords = keywords.filter(k => contentLower.includes(k));
    const relevance = matchedKeywords.length / Math.max(keywords.length, 1);

    // Require at least 3 matching keywords and 25% relevance to avoid false positives
    if (matchedKeywords.length >= 3 && relevance > 0.25) {
      signals.push({
        action: block.content.slice(0, 120),
        strength: Math.min(1, 0.5 + relevance * 0.5),
        source_block_id: block.id,
        reasoning: `Inhibitory block #${block.id}: "${block.content.slice(0, 60)}..."`,
      });
    }
  }

  // Negative-valence active blocks are weaker NoGo signals (warnings, not blocks)
  const negativeBlocks = db.prepare(`
    SELECT id, content, net_valence FROM blocks
    WHERE state = 1 AND net_valence < -0.2
    AND category IN ('episode', 'pattern', 'decision')
    ORDER BY net_valence ASC LIMIT 15
  `).all() as { id: number; content: string; net_valence: number }[];

  for (const block of negativeBlocks) {
    const contentLower = block.content.toLowerCase();
    const matchedKeywords = keywords.filter(k => contentLower.includes(k));
    const relevance = matchedKeywords.length / Math.max(keywords.length, 1);

    // Require at least 2 matching keywords and 30% relevance
    if (matchedKeywords.length >= 2 && relevance > 0.3) {
      signals.push({
        action: block.content.slice(0, 120),
        strength: Math.abs(block.net_valence) * relevance * 0.7, // Weaker than inhibitory
        source_block_id: block.id,
        reasoning: `Negative memory (valence: ${block.net_valence.toFixed(2)}): "${block.content.slice(0, 60)}..."`,
      });
    }
  }

  return signals.sort((a, b) => b.strength - a.strength).slice(0, 5);
}

// ── Novelty / Stakes / Urgency Scoring ──

/**
 * Score how novel the current situation is (0 = very familiar, 1 = completely new).
 * Based on how many confirmed blocks match the context.
 */
export function scoreNovelty(db: Database.Database, context: string): number {
  const keywords = extractKeywords(context);
  if (keywords.length === 0) return 0.8; // No keywords = uncertain = treat as novel

  // Count confirmed blocks that match any keyword
  const matchCount = db.prepare(`
    SELECT COUNT(*) as c FROM blocks
    WHERE state = 1 AND confidence = 'confirmed'
    AND (${keywords.map(() => 'LOWER(content) LIKE ?').join(' OR ')})
  `).get(...keywords.map(k => `%${k}%`)) as { c: number };

  // More confirmed matches = less novel
  // 0 matches = completely novel (1.0), 10+ matches = very familiar (0.1)
  return Math.max(0.05, 1 - Math.min(matchCount.c / 10, 0.95));
}

/**
 * Score how high-stakes the decision is (0 = low risk, 1 = critical).
 * Based on committed goal investment, priority, and consequences.
 */
export function scoreStakes(db: Database.Database, agent: string): number {
  const currentGoal = goal_current(db, agent);
  if (!currentGoal) return 0.3; // No committed goal = moderate stakes

  // Higher stakes when: lots of effort invested, high priority, low progress
  const effortFactor = Math.min(1, currentGoal.effort_spent / 5); // 5+ hours = max
  const priorityFactor = currentGoal.priority;
  const progressRisk = 1 - currentGoal.progress; // More to lose if early

  return Math.min(1, effortFactor * 0.4 + priorityFactor * 0.4 + progressRisk * 0.2);
}

/**
 * Score urgency from drive states (0 = relaxed, 1 = critical).
 * High urgency = high average drive deficit.
 */
export function scoreUrgency(db: Database.Database, agent: string): number {
  const driveState = load_drive_state(db, agent);
  const avgUrgency = driveState.drives.reduce((sum, d) =>
    sum + drive_urgency(d), 0
  ) / Math.max(driveState.drives.length, 1);

  // Tonic dopamine modulates urgency (low DA = low vigor = less urgency felt)
  return Math.min(1, avgUrgency * (0.5 + driveState.tonic_dopamine * 0.5));
}

// ── The Arbitrator ──

/**
 * arbitrate: The main dual-process decision function.
 *
 * Runs both pathways in parallel (conceptually), then picks based on:
 * - Novelty: novel → deliberative
 * - Stakes: high stakes → deliberative
 * - Habit confidence: high → habitual
 * - NoGo signals: strong → inhibit regardless of pathway
 *
 * Returns the final recommendation with full reasoning.
 */
export function arbitrate(
  db: Database.Database,
  agent: string,
  context: string
): ArbitrationResult {
  // Score the situation
  const novelty = scoreNovelty(db, context);
  const stakes = scoreStakes(db, agent);
  const urgency = scoreUrgency(db, agent);

  // Run both pathways
  const habitual = habitualEvaluate(db, agent, context);
  const deliberative = deliberativeEvaluate(db, agent, context);

  // Run Go/NoGo evaluation
  const goSignals = evaluateGo(db, agent, context);
  const nogoSignals = evaluateNoGo(db, agent, context);

  // Check for strong NoGo signals (inhibition overrides both pathways)
  const strongNogo = nogoSignals.filter(s => s.strength > NOGO_INHIBITION_THRESHOLD);

  // Arbitration logic (Daw et al. 2005 + Keramati et al. 2011)
  let pathwayUsed: 'habitual' | 'deliberative' | 'blended';
  let recommendation: string;
  let confidence: number;
  let reasoning: string;

  // Strong NoGo overrides everything
  if (strongNogo.length > 0) {
    const topNogo = strongNogo[0];
    pathwayUsed = 'deliberative'; // NoGo forces deliberation
    recommendation = deliberative.recommendation;
    confidence = Math.max(0.3, 1 - topNogo.strength);
    reasoning = `NoGo inhibition active: "${topNogo.reasoning}". Falling back to deliberative analysis. ${deliberative.reasoning}`;
  }
  // Novel or high-stakes → deliberative
  else if (novelty > NOVELTY_THRESHOLD || stakes > STAKES_THRESHOLD) {
    pathwayUsed = 'deliberative';
    recommendation = deliberative.recommendation;
    confidence = Math.min(1, deliberative.evc_score * 2);
    reasoning = `Deliberative pathway selected (novelty: ${novelty.toFixed(2)}, stakes: ${stakes.toFixed(2)}). ${deliberative.reasoning}`;
  }
  // Familiar and low-stakes with confident habit → habitual
  else if (habitual.confidence >= HABIT_CONFIDENCE_MIN) {
    pathwayUsed = 'habitual';
    recommendation = habitual.recommendation;
    confidence = habitual.confidence;
    reasoning = `Habitual pathway selected (familiar context, low stakes). ${habitual.reasoning}`;
  }
  // Blending zone: both pathways contribute
  else {
    pathwayUsed = 'blended';
    // Weight toward deliberative for ambiguous cases
    const habitWeight = habitual.confidence * (1 - novelty);
    const delibWeight = (deliberative.evc_score > 0 ? 0.5 + deliberative.evc_score : 0.5) * novelty;

    if (habitWeight > delibWeight && habitual.recommendation) {
      recommendation = habitual.recommendation;
      confidence = habitual.confidence * 0.8; // Slightly reduced for blended
    } else {
      recommendation = deliberative.recommendation;
      confidence = Math.min(1, deliberative.evc_score * 1.5);
    }
    reasoning = `Blended (habit: ${habitWeight.toFixed(2)}, delib: ${delibWeight.toFixed(2)}). ` +
      `Habit: ${habitual.reasoning}. Delib: ${deliberative.reasoning}`;
  }

  return {
    pathway_used: pathwayUsed,
    recommendation,
    confidence: Math.round(confidence * 100) / 100,
    go_signals: goSignals,
    nogo_signals: nogoSignals,
    novelty_score: Math.round(novelty * 100) / 100,
    stakes_score: Math.round(stakes * 100) / 100,
    urgency_score: Math.round(urgency * 100) / 100,
    habitual,
    deliberative,
    reasoning,
  };
}

// ── Habit Consolidation (for dream cycle integration) ──

/**
 * Identify blocks that should be promoted to habitual status.
 * Called during dream cycle to consolidate successful patterns.
 *
 * Criteria: confirmed confidence + positive valence + high access count
 */
export function identifyHabitCandidates(db: Database.Database): {
  id: number;
  content: string;
  access_count: number;
  net_valence: number;
}[] {
  return db.prepare(`
    SELECT id, content, access_count, net_valence
    FROM blocks
    WHERE state = 1
    AND confidence = 'confirmed'
    AND net_valence > 0.2
    AND access_count >= 3
    AND category IN ('decision', 'pattern', 'skill')
    ORDER BY access_count DESC, net_valence DESC
    LIMIT 20
  `).all() as { id: number; content: string; access_count: number; net_valence: number }[];
}

/**
 * Get habit statistics for an agent — used in dashboard/stats.
 */
export function habitStats(db: Database.Database): {
  total_habits: number;
  avg_access_count: number;
  avg_valence: number;
  top_habits: string[];
} {
  const habits = identifyHabitCandidates(db);

  if (habits.length === 0) {
    return { total_habits: 0, avg_access_count: 0, avg_valence: 0, top_habits: [] };
  }

  return {
    total_habits: habits.length,
    avg_access_count: habits.reduce((s, h) => s + h.access_count, 0) / habits.length,
    avg_valence: habits.reduce((s, h) => s + h.net_valence, 0) / habits.length,
    top_habits: habits.slice(0, 5).map(h => h.content.slice(0, 80)),
  };
}

// ── Helpers ──

/** Extract meaningful keywords from context string. */
function extractKeywords(context: string): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'ought',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it',
    'they', 'them', 'their', 'this', 'that', 'these', 'those', 'what',
    'which', 'who', 'whom', 'where', 'when', 'why', 'how', 'not', 'no',
    'but', 'or', 'and', 'if', 'then', 'else', 'for', 'of', 'to', 'in',
    'on', 'at', 'by', 'from', 'with', 'as', 'into', 'about', 'up',
  ]);

  return context
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w))
    .slice(0, 10);
}
