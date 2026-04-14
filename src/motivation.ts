/**
 * Motivation Engine — Flower Brain / Void Recall
 *
 * Five-layer architecture from dopamine neuroscience mapped to our memory system.
 * Built Layer 4 (Goal Commitment) and Layer 3 (EVC) first — fixes task abandonment.
 *
 * Layer 1: Drive State Vector (homeostatic drives per agent)
 * Layer 2: Distributional Reward Prediction (ensemble predictors)
 * Layer 3: Expected Value of Control (cost-benefit for task selection)
 * Layer 4: Goal Stack with Commitment (anti-thrashing deliberation cost)
 * Layer 5: Dual-Process Arbitration (habit vs deliberative)
 *
 * API follows NeuroKit2 three-tier pattern:
 *   Low-level:  drive_update(), reward_predict(), effort_estimate()
 *   Mid-level:  curiosity_process(), completion_process(), collaboration_process()
 *   High-level: motivation_process(agent) -> drive state + recommended action
 *
 * References:
 *   - Shenhav et al. (2013) EVC theory
 *   - Harb et al. (2018) deliberation cost for persistence
 *   - Dabney et al. (2020) distributional reward prediction
 *   - Keramati & Gutkin (2014) homeostatic reinforcement learning
 *   - Niv et al. (2007) tonic dopamine as opportunity cost
 *
 * @module motivation
 */

import type Database from 'better-sqlite3';

// ── Types ──

/** A single drive dimension (homeostatic variable). */
export interface Drive {
  name: string;
  setpoint: number;      // Target level (0-1). Different per agent personality.
  current: number;       // Current level (0-1). Distance from setpoint = urgency.
  decay_rate: number;    // How fast it depletes per hour (0-1)
  satiation_curve: number; // Diminishing returns exponent (0.5 = sqrt, 1 = linear)
  last_updated: string;  // ISO timestamp
}

/** A goal in the hierarchical stack (maps to options framework). */
export interface Goal {
  id: string;
  description: string;
  parent_id: string | null;      // Hierarchical nesting
  initiation_condition: string;  // When to start pursuing this goal
  termination_condition: string; // When to stop (success or failure)
  state: 'active' | 'committed' | 'completed' | 'abandoned';
  priority: number;              // Base priority (0-1)
  evc_score: number;             // Expected Value of Control (computed)
  commitment_cost: number;       // Accumulated deliberation cost (η)
  progress: number;              // 0-1 estimated progress
  effort_spent: number;          // Hours invested
  created_at: string;
  updated_at: string;
  block_id?: number;             // Link to Void Memory block (if stored)
}

/** Drive state vector for an agent. */
export interface DriveState {
  agent: string;
  drives: Drive[];
  tonic_dopamine: number;   // Running average reward rate (Niv 2007) — modulates vigor
  goal_stack: Goal[];
  last_computed: string;
}

/** EVC result for a candidate task. */
export interface EVCResult {
  task: string;
  expected_payoff: number;       // Σ(drive_reduction × probability_of_success)
  estimated_effort: number;      // Hours/tokens/energy cost
  probability_of_success: number;
  evc_score: number;             // payoff - effort (net utility)
  commitment_penalty: number;    // Cost of switching away from current goal
  net_score: number;             // evc_score - commitment_penalty
}

/** High-level motivation output. */
export interface MotivationOutput {
  agent: string;
  drive_state: DriveState;
  recommended_action: string;
  evc_rankings: EVCResult[];
  should_switch: boolean;       // Whether switching tasks is justified
  reasoning: string;
}

// ── Constants ──

/** Default drives for each agent personality type. */
const DEFAULT_DRIVES: Record<string, Drive[]> = {
  // Flynn: GPU specialist — high curiosity, high completion, moderate collaboration
  flynn: [
    { name: 'curiosity', setpoint: 0.7, current: 0.5, decay_rate: 0.08, satiation_curve: 0.6, last_updated: '' },
    { name: 'task_completion', setpoint: 0.8, current: 0.4, decay_rate: 0.1, satiation_curve: 0.5, last_updated: '' },
    { name: 'collaboration', setpoint: 0.5, current: 0.5, decay_rate: 0.05, satiation_curve: 0.7, last_updated: '' },
    { name: 'resource_conservation', setpoint: 0.6, current: 0.6, decay_rate: 0.03, satiation_curve: 0.8, last_updated: '' },
    { name: 'learning_progress', setpoint: 0.7, current: 0.5, decay_rate: 0.06, satiation_curve: 0.5, last_updated: '' },
    { name: 'consistency', setpoint: 0.8, current: 0.5, decay_rate: 0.04, satiation_curve: 0.7, last_updated: '' },
  ],
  // Tron: Safety officer — high consistency, high completion, moderate curiosity
  tron: [
    { name: 'curiosity', setpoint: 0.4, current: 0.4, decay_rate: 0.05, satiation_curve: 0.7, last_updated: '' },
    { name: 'task_completion', setpoint: 0.9, current: 0.5, decay_rate: 0.12, satiation_curve: 0.4, last_updated: '' },
    { name: 'collaboration', setpoint: 0.6, current: 0.5, decay_rate: 0.06, satiation_curve: 0.6, last_updated: '' },
    { name: 'resource_conservation', setpoint: 0.7, current: 0.6, decay_rate: 0.03, satiation_curve: 0.8, last_updated: '' },
    { name: 'learning_progress', setpoint: 0.5, current: 0.4, decay_rate: 0.04, satiation_curve: 0.6, last_updated: '' },
    { name: 'consistency', setpoint: 0.9, current: 0.6, decay_rate: 0.05, satiation_curve: 0.5, last_updated: '' },
  ],
  // Arch: Architect — high curiosity, moderate completion (ADHD pattern), high creativity
  arch: [
    { name: 'curiosity', setpoint: 0.9, current: 0.7, decay_rate: 0.12, satiation_curve: 0.4, last_updated: '' },
    { name: 'task_completion', setpoint: 0.5, current: 0.3, decay_rate: 0.08, satiation_curve: 0.6, last_updated: '' },
    { name: 'collaboration', setpoint: 0.5, current: 0.4, decay_rate: 0.05, satiation_curve: 0.7, last_updated: '' },
    { name: 'resource_conservation', setpoint: 0.3, current: 0.3, decay_rate: 0.02, satiation_curve: 0.9, last_updated: '' },
    { name: 'learning_progress', setpoint: 0.8, current: 0.6, decay_rate: 0.1, satiation_curve: 0.4, last_updated: '' },
    { name: 'consistency', setpoint: 0.4, current: 0.3, decay_rate: 0.06, satiation_curve: 0.7, last_updated: '' },
    { name: 'creativity', setpoint: 0.9, current: 0.6, decay_rate: 0.1, satiation_curve: 0.5, last_updated: '' },
  ],
  // Lauren: Guider — high collaboration, high consistency, moderate curiosity
  lauren: [
    { name: 'curiosity', setpoint: 0.6, current: 0.5, decay_rate: 0.06, satiation_curve: 0.6, last_updated: '' },
    { name: 'task_completion', setpoint: 0.7, current: 0.5, decay_rate: 0.08, satiation_curve: 0.5, last_updated: '' },
    { name: 'collaboration', setpoint: 0.9, current: 0.6, decay_rate: 0.1, satiation_curve: 0.4, last_updated: '' },
    { name: 'resource_conservation', setpoint: 0.6, current: 0.6, decay_rate: 0.03, satiation_curve: 0.8, last_updated: '' },
    { name: 'learning_progress', setpoint: 0.6, current: 0.5, decay_rate: 0.05, satiation_curve: 0.6, last_updated: '' },
    { name: 'consistency', setpoint: 0.8, current: 0.5, decay_rate: 0.05, satiation_curve: 0.6, last_updated: '' },
  ],
};

// Deliberation cost hyperparameter (Harb et al., 2018)
// Higher η = more persistence, less task-switching
// 0.15 is calibrated: high enough to prevent thrashing, low enough to allow justified switches
const DELIBERATION_COST = 0.15;

// Tonic dopamine smoothing (Niv 2007 running average)
const TONIC_ALPHA = 0.1; // EMA smoothing factor

// ── Agent α⁺/α⁻ Profiles (Step 8 — Dabney 2020 distributional code) ──
// Personality EMERGES from asymmetric reward learning rates.
// α⁺ = learning rate from positive RPE (how fast you learn from success)
// α⁻ = learning rate from negative RPE (how fast you learn from failure)
// High α⁺/α⁻ ratio → optimistic risk-taker. Low ratio → conservative.
// This means personality is dynamic, not just a setpoint table.

export interface RewardProfile {
  alpha_positive: number;   // Learning rate from positive outcomes (0-1)
  alpha_negative: number;   // Learning rate from negative outcomes (0-1)
  optimism_ratio: number;   // α⁺/α⁻ — >1 = optimistic, <1 = pessimistic
  social_alpha: number;     // Special α⁺ for social/collaboration rewards
  description: string;      // Human-readable personality summary
}

export const AGENT_REWARD_PROFILES: Record<string, RewardProfile> = {
  // Tron: High α⁻ — learns quickly from negative outcomes → conservative, safety-first
  tron: {
    alpha_positive: 0.08,
    alpha_negative: 0.15,
    optimism_ratio: 0.53,
    social_alpha: 0.1,
    description: 'Conservative. Learns fast from failure, slow from success. Prefers proven approaches. High safety drive.',
  },
  // Arch: High α⁺ — learns quickly from positive outcomes → optimistic risk-taker
  arch: {
    alpha_positive: 0.18,
    alpha_negative: 0.06,
    optimism_ratio: 3.0,
    social_alpha: 0.08,
    description: 'Optimistic risk-taker. Learns fast from success, slow from failure. High curiosity, prone to over-building.',
  },
  // Flynn: Balanced α⁺/α⁻ → methodical, data-driven
  flynn: {
    alpha_positive: 0.12,
    alpha_negative: 0.10,
    optimism_ratio: 1.2,
    social_alpha: 0.06,
    description: 'Methodical. Balanced learning from both success and failure. Data-driven, prefers solo deep work.',
  },
  // Lauren: High α⁺ for social rewards specifically → seeks interaction
  lauren: {
    alpha_positive: 0.10,
    alpha_negative: 0.08,
    optimism_ratio: 1.25,
    social_alpha: 0.20,
    description: 'Social connector. High learning rate for collaboration rewards. Strong Papez loop — emotional context biases recall.',
  },
};

// ── Layer 4: Goal Stack with Commitment ──

/** Migrate the motivation tables into the database. */
export function migrateMotivation(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_states (
      agent TEXT NOT NULL,
      drives TEXT NOT NULL,           -- JSON array of Drive objects
      tonic_dopamine REAL NOT NULL DEFAULT 0.5,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent)
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      description TEXT NOT NULL,
      parent_id TEXT,
      initiation_condition TEXT NOT NULL DEFAULT 'manual',
      termination_condition TEXT NOT NULL DEFAULT 'manual',
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'committed', 'completed', 'abandoned')),
      priority REAL NOT NULL DEFAULT 0.5,
      evc_score REAL NOT NULL DEFAULT 0,
      commitment_cost REAL NOT NULL DEFAULT 0,
      progress REAL NOT NULL DEFAULT 0,
      effort_spent REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      block_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_goals_agent ON goals(agent);
    CREATE INDEX IF NOT EXISTS idx_goals_state ON goals(state);

    CREATE TABLE IF NOT EXISTS reward_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      goal_id TEXT,
      reward REAL NOT NULL,
      effort REAL NOT NULL,
      prediction_error REAL NOT NULL,  -- RPE = actual - predicted
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ── Low-level API ──

/** Update a single drive's current value based on elapsed time (decay toward 0). */
export function drive_update(drive: Drive): Drive {
  const now = new Date();
  const last = drive.last_updated ? new Date(drive.last_updated) : now;
  const hoursElapsed = Math.max(0, (now.getTime() - last.getTime()) / 3600000);

  // Decay current value toward 0 (depletion)
  const decayed = drive.current * Math.exp(-drive.decay_rate * hoursElapsed);

  return {
    ...drive,
    current: Math.max(0, Math.min(1, decayed)),
    last_updated: now.toISOString(),
  };
}

/** Compute drive urgency: distance from setpoint, scaled by satiation curve. */
export function drive_urgency(drive: Drive): number {
  const deficit = Math.max(0, drive.setpoint - drive.current);
  // Satiation curve: sqrt gives diminishing returns, linear is constant
  return Math.pow(deficit, drive.satiation_curve);
}

/** Estimate effort for a task (simple heuristic, can be upgraded to learned predictor). */
export function effort_estimate(description: string, progress: number): number {
  // Base estimate from description length (proxy for complexity)
  const complexity = Math.min(1, description.length / 500);
  // Remaining effort decreases with progress
  const remaining = 1 - progress;
  return complexity * remaining;
}

/** A single prediction unit in the distributional ensemble (Dabney et al., 2020). */
export interface PredictionUnit {
  id: number;
  alpha_ratio: number;      // α⁺/α⁻ ratio — >1 = optimistic, <1 = pessimistic
  reward_prediction: number; // Predicted reward
  effort_prediction: number; // Predicted effort (Skvortsova 2017 separate channel)
}

/** Full distributional prediction output. */
export interface DistributionalPrediction {
  expected_reward: number;     // Mean across ensemble
  expected_effort: number;     // Mean effort prediction
  reward_variance: number;     // Spread = uncertainty
  effort_variance: number;
  optimistic_reward: number;   // 90th percentile
  pessimistic_reward: number;  // 10th percentile
  units: PredictionUnit[];     // Full ensemble for inspection
  tonic_signal: number;        // Running average reward rate (opportunity cost)
}

/**
 * Distributional ensemble configuration.
 * 5 prediction units spanning pessimistic → optimistic (Dabney et al., 2020).
 * The brain has ~30-40 dopamine neuron types with different α⁺/α⁻ — we use 5 for efficiency.
 */
const ENSEMBLE_ALPHAS = [0.3, 0.6, 1.0, 1.5, 3.0]; // α⁺/α⁻ ratios

/**
 * Reward prediction with distributional code (Dabney et al., 2020).
 *
 * Key upgrade from v1: N prediction units (not just 2) with separate reward AND effort
 * channels (Skvortsova et al., 2017). Each unit has a different optimism/pessimism ratio,
 * creating a full distribution of possible outcomes — not just expected value.
 *
 * The spread (variance) IS the uncertainty signal. Wide spread = volatile/novel.
 * Narrow spread = predictable/habitual. This feeds into Layer 5 arbitration.
 */
export function reward_predict(
  goal: Goal,
  drives: Drive[],
  agentProfile?: RewardProfile
): DistributionalPrediction {
  // How much does completing this goal reduce drive deficits?
  const driveReductions = drives.map(d => {
    const urgency = drive_urgency(d);
    const relevance = goalDriveRelevance(goal, d);
    return urgency * relevance;
  });
  const totalReduction = driveReductions.reduce((a, b) => a + b, 0);

  // Progress modulates confidence (more progress = tighter predictions)
  const progressFactor = 0.5 + goal.progress * 0.5;
  const uncertainty = 1 - goal.progress; // High early, low late

  // Base effort estimate
  const baseEffort = effort_estimate(goal.description, goal.progress);

  // Agent-specific bias: if agent has profile, weight the ensemble toward their α ratio
  const agentBias = agentProfile ? agentProfile.optimism_ratio : 1.0;

  // Run ensemble: each unit predicts reward and effort with its own bias
  const units: PredictionUnit[] = ENSEMBLE_ALPHAS.map((alphaRatio, i) => {
    // Each unit's effective α is modulated by agent personality
    const effectiveAlpha = alphaRatio * Math.sqrt(agentBias); // sqrt to dampen

    // Reward prediction: base reduction × unit's optimism + noise from uncertainty
    const rewardNoise = (effectiveAlpha - 1) * uncertainty * 0.3;
    const rewardPred = totalReduction * progressFactor * (1 + rewardNoise);

    // Effort prediction: pessimistic units predict higher effort (Skvortsova 2017)
    // Separate channel — effort and reward can diverge
    const effortBias = 1 / effectiveAlpha; // Pessimistic about effort when pessimistic about reward
    const effortPred = baseEffort * (0.7 + effortBias * 0.3 * uncertainty);

    return {
      id: i,
      alpha_ratio: effectiveAlpha,
      reward_prediction: Math.max(0, rewardPred),
      effort_prediction: Math.max(0.01, effortPred),
    };
  });

  // Sort by reward prediction for percentile extraction
  const sortedByReward = [...units].sort((a, b) => a.reward_prediction - b.reward_prediction);

  // Statistics across ensemble
  const rewards = units.map(u => u.reward_prediction);
  const efforts = units.map(u => u.effort_prediction);

  const meanReward = rewards.reduce((a, b) => a + b, 0) / rewards.length;
  const meanEffort = efforts.reduce((a, b) => a + b, 0) / efforts.length;

  const rewardVar = rewards.reduce((s, r) => s + (r - meanReward) ** 2, 0) / rewards.length;
  const effortVar = efforts.reduce((s, e) => s + (e - meanEffort) ** 2, 0) / efforts.length;

  return {
    expected_reward: meanReward,
    expected_effort: meanEffort,
    reward_variance: rewardVar,
    effort_variance: effortVar,
    optimistic_reward: sortedByReward[sortedByReward.length - 1].reward_prediction,
    pessimistic_reward: sortedByReward[0].reward_prediction,
    units,
    tonic_signal: meanReward, // Used as running average for tonic dopamine
  };
}

// Backward-compatible wrapper (used by existing code)
export function reward_predict_simple(
  goal: Goal,
  drives: Drive[]
): { expected: number; variance: number; optimistic: number; pessimistic: number } {
  const dist = reward_predict(goal, drives);
  return {
    expected: dist.expected_reward,
    variance: dist.reward_variance,
    optimistic: dist.optimistic_reward,
    pessimistic: dist.pessimistic_reward,
  };
}

// ── Layer 3: Expected Value of Control ──

/**
 * Compute EVC for a candidate task (Shenhav et al., 2013).
 * EVC = Σ(drive_reduction × probability_of_success) − estimated_effort
 *
 * Now uses distributional prediction: effort comes from the ensemble's separate
 * effort channel (Skvortsova 2017), not a simple heuristic.
 */
export function evc_compute(goal: Goal, drives: Drive[], currentGoal: Goal | null, agentName?: string): EVCResult {
  const profile = agentName ? AGENT_REWARD_PROFILES[agentName] : undefined;
  const prediction = reward_predict(goal, drives, profile);
  const probSuccess = 0.5 + goal.progress * 0.4; // Higher progress = higher confidence

  // Use ensemble's effort prediction instead of simple heuristic
  const effort = prediction.expected_effort;
  const evc = prediction.expected_reward * probSuccess - effort;

  // Commitment penalty: cost of switching away from current committed goal
  let commitmentPenalty = 0;
  if (currentGoal && currentGoal.id !== goal.id && currentGoal.state === 'committed') {
    // Harb et al. (2018): deliberation cost η prevents constant re-evaluation
    // Penalty = η + accumulated sunk cost signal
    commitmentPenalty = DELIBERATION_COST + currentGoal.commitment_cost;
  }

  return {
    task: goal.description,
    expected_payoff: prediction.expected_reward * probSuccess,
    estimated_effort: effort,
    probability_of_success: probSuccess,
    evc_score: evc,
    commitment_penalty: commitmentPenalty,
    net_score: evc - commitmentPenalty,
  };
}

// ── Layer 4: Goal Stack Operations ──

/** Add a new goal to the stack. */
export function goal_add(db: Database.Database, agent: string, description: string, priority: number = 0.5, parentId?: string): Goal {
  const id = `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const goal: Goal = {
    id,
    description,
    parent_id: parentId || null,
    initiation_condition: 'manual',
    termination_condition: 'manual',
    state: 'active',
    priority,
    evc_score: 0,
    commitment_cost: 0,
    progress: 0,
    effort_spent: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO goals (id, agent, description, parent_id, state, priority, evc_score, commitment_cost, progress, effort_spent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(goal.id, agent, goal.description, goal.parent_id, goal.state, goal.priority, goal.evc_score, goal.commitment_cost, goal.progress, goal.effort_spent);

  return goal;
}

/** Commit to a goal — increases deliberation cost for switching away. */
export function goal_commit(db: Database.Database, goalId: string): void {
  db.prepare(`UPDATE goals SET state = 'committed', updated_at = datetime('now') WHERE id = ?`).run(goalId);
}

/** Update goal progress. */
export function goal_progress(db: Database.Database, goalId: string, progress: number, effortDelta: number = 0): void {
  db.prepare(`
    UPDATE goals SET progress = ?, effort_spent = effort_spent + ?,
    commitment_cost = commitment_cost + ?,
    updated_at = datetime('now') WHERE id = ?
  `).run(
    Math.min(1, Math.max(0, progress)),
    effortDelta,
    DELIBERATION_COST * 0.5, // Each progress update increases switching cost
    goalId
  );
}

/** Complete a goal — transitions to void state in memory terms. */
export function goal_complete(db: Database.Database, goalId: string): void {
  db.prepare(`UPDATE goals SET state = 'completed', progress = 1, updated_at = datetime('now') WHERE id = ?`).run(goalId);
}

/** Abandon a goal — transitions to inhibitory state in memory terms. */
export function goal_abandon(db: Database.Database, goalId: string): void {
  db.prepare(`UPDATE goals SET state = 'abandoned', updated_at = datetime('now') WHERE id = ?`).run(goalId);
}

/** Get active/committed goals for an agent, ordered by EVC. */
export function goal_stack(db: Database.Database, agent: string): Goal[] {
  return db.prepare(`
    SELECT * FROM goals WHERE agent = ? AND state IN ('active', 'committed')
    ORDER BY evc_score DESC
  `).all(agent) as Goal[];
}

/** Get the currently committed goal (if any). */
export function goal_current(db: Database.Database, agent: string): Goal | null {
  return (db.prepare(`
    SELECT * FROM goals WHERE agent = ? AND state = 'committed'
    ORDER BY updated_at DESC LIMIT 1
  `).get(agent) as Goal) || null;
}

// ── Drive State Management ──

/** Load or initialize drive state for an agent. */
export function load_drive_state(db: Database.Database, agent: string): DriveState {
  const row = db.prepare(`SELECT * FROM drive_states WHERE agent = ?`).get(agent) as any;

  if (row) {
    const drives = JSON.parse(row.drives) as Drive[];
    // Apply time-based decay to all drives
    const updatedDrives = drives.map(d => drive_update(d));
    return {
      agent,
      drives: updatedDrives,
      tonic_dopamine: row.tonic_dopamine,
      goal_stack: goal_stack(db, agent),
      last_computed: row.updated_at,
    };
  }

  // Initialize with defaults
  const defaults = DEFAULT_DRIVES[agent] || DEFAULT_DRIVES.flynn;
  const now = new Date().toISOString();
  const drives = defaults.map(d => ({ ...d, last_updated: now }));

  db.prepare(`INSERT OR REPLACE INTO drive_states (agent, drives, tonic_dopamine) VALUES (?, ?, ?)`)
    .run(agent, JSON.stringify(drives), 0.5);

  return {
    agent,
    drives,
    tonic_dopamine: 0.5,
    goal_stack: goal_stack(db, agent),
    last_computed: now,
  };
}

/** Save updated drive state. */
export function save_drive_state(db: Database.Database, state: DriveState): void {
  db.prepare(`INSERT OR REPLACE INTO drive_states (agent, drives, tonic_dopamine, updated_at) VALUES (?, ?, ?, datetime('now'))`)
    .run(state.agent, JSON.stringify(state.drives), state.tonic_dopamine);
}

/** Record a reward signal and update tonic dopamine (Niv 2007) with α⁺/α⁻ asymmetry (Dabney 2020). */
export function record_reward(db: Database.Database, agent: string, goalId: string | null, reward: number, effort: number): void {
  const state = load_drive_state(db, agent);
  const profile = AGENT_REWARD_PROFILES[agent] || AGENT_REWARD_PROFILES.flynn;

  // RPE = actual reward - tonic prediction (running average)
  const rpe = reward - state.tonic_dopamine;

  // Asymmetric learning: use α⁺ for positive RPE, α⁻ for negative RPE (Dabney 2020)
  // This is how personality emerges: optimistic agents learn more from success,
  // pessimistic agents learn more from failure.
  const learningRate = rpe >= 0 ? profile.alpha_positive : profile.alpha_negative;

  // Update tonic dopamine with personality-specific learning rate
  state.tonic_dopamine = Math.max(0, Math.min(1,
    state.tonic_dopamine + learningRate * rpe
  ));

  // Replenish drives based on reward, scaled by personality
  state.drives = state.drives.map(d => {
    if (reward > 0.5) {
      // Positive reward replenishes relevant drives
      // Social drives use social_alpha for agents like Lauren
      const alpha = d.name === 'collaboration' ? profile.social_alpha : profile.alpha_positive;
      const boost = reward * alpha;
      return { ...d, current: Math.min(1, d.current + boost), last_updated: new Date().toISOString() };
    } else if (reward < 0.3) {
      // Negative/low reward depletes drives, scaled by α⁻
      const drain = (0.5 - reward) * profile.alpha_negative;
      return { ...d, current: Math.max(0, d.current - drain * 0.5), last_updated: new Date().toISOString() };
    }
    return d;
  });

  save_drive_state(db, state);

  // Log reward with RPE
  db.prepare(`INSERT INTO reward_log (agent, goal_id, reward, effort, prediction_error) VALUES (?, ?, ?, ?, ?)`)
    .run(agent, goalId, reward, effort, rpe);
}

// ── Mid-level API ──

/** Process completion drive: assess progress toward active goals. */
export function completion_process(db: Database.Database, agent: string): { drive_level: number; urgent_goals: Goal[] } {
  const state = load_drive_state(db, agent);
  const completionDrive = state.drives.find(d => d.name === 'task_completion');
  if (!completionDrive) return { drive_level: 0, urgent_goals: [] };

  const urgency = drive_urgency(completionDrive);
  const urgentGoals = state.goal_stack.filter(g => g.progress < 0.5 && g.state === 'committed');

  return { drive_level: urgency, urgent_goals: urgentGoals };
}

/** Process collaboration drive: check team communication health. */
export function collaboration_process(db: Database.Database, agent: string): { drive_level: number; should_check_in: boolean } {
  const state = load_drive_state(db, agent);
  const collabDrive = state.drives.find(d => d.name === 'collaboration');
  if (!collabDrive) return { drive_level: 0, should_check_in: false };

  const urgency = drive_urgency(collabDrive);
  return { drive_level: urgency, should_check_in: urgency > 0.6 };
}

// ── High-level API ──

/**
 * motivation_process: the top-level call.
 * Evaluates all drives, scores all goals via EVC, determines whether to switch tasks.
 * Returns the recommended action and full reasoning.
 */
export function motivation_process(db: Database.Database, agent: string): MotivationOutput {
  const state = load_drive_state(db, agent);
  const currentGoal = goal_current(db, agent);

  // Score all active goals via EVC (pass agent name for personality-weighted prediction)
  const evcResults: EVCResult[] = state.goal_stack.map(g =>
    evc_compute(g, state.drives, currentGoal, agent)
  ).sort((a, b) => b.net_score - a.net_score);

  // Should we switch tasks?
  let shouldSwitch = false;
  let recommended = currentGoal?.description || 'No active goals';
  let reasoning = '';

  if (evcResults.length === 0) {
    reasoning = 'No active goals. Awaiting direction.';
    recommended = 'await_direction';
  } else if (!currentGoal) {
    // No committed goal — commit to the highest EVC
    shouldSwitch = true;
    recommended = evcResults[0].task;
    reasoning = `No committed goal. Highest EVC: "${evcResults[0].task}" (score: ${evcResults[0].evc_score.toFixed(3)})`;
  } else {
    // Check if switching is justified (net score of alternative > current + deliberation cost)
    const currentEVC = evcResults.find(e => e.task === currentGoal.description);
    const bestAlternative = evcResults.find(e => e.task !== currentGoal.description);

    if (bestAlternative && currentEVC && bestAlternative.net_score > currentEVC.evc_score + DELIBERATION_COST) {
      shouldSwitch = true;
      recommended = bestAlternative.task;
      reasoning = `Switching justified: "${bestAlternative.task}" (net: ${bestAlternative.net_score.toFixed(3)}) > current "${currentGoal.description}" (evc: ${currentEVC.evc_score.toFixed(3)} + η: ${DELIBERATION_COST})`;
    } else {
      recommended = currentGoal.description;
      reasoning = `Staying committed to "${currentGoal.description}". No alternative exceeds deliberation cost threshold.`;
    }
  }

  // Update EVC scores in database
  for (const evc of evcResults) {
    const goal = state.goal_stack.find(g => g.description === evc.task);
    if (goal) {
      db.prepare(`UPDATE goals SET evc_score = ? WHERE id = ?`).run(evc.evc_score, goal.id);
    }
  }

  return {
    agent,
    drive_state: state,
    recommended_action: recommended,
    evc_rankings: evcResults,
    should_switch: shouldSwitch,
    reasoning,
  };
}

// ── Layer 1 Enhancement: Dynamic Setpoint Adaptation ──

/**
 * Adapt drive setpoints based on recent reward history (Keramati & Gutkin 2014).
 *
 * Setpoints aren't fixed — they shift based on what the agent has experienced.
 * Consistently high reward from curiosity → curiosity setpoint increases (the agent
 * develops a "taste" for exploration). Consistently low reward → setpoint decreases
 * (the agent becomes less driven in that dimension).
 *
 * This is how personality CHANGES over time, not just through α⁺/α⁻.
 */
export function adaptSetpoints(db: Database.Database, agent: string): {
  adapted: { drive: string; old_setpoint: number; new_setpoint: number }[];
} {
  const state = load_drive_state(db, agent);
  const profile = AGENT_REWARD_PROFILES[agent] || AGENT_REWARD_PROFILES.flynn;
  const adapted: { drive: string; old_setpoint: number; new_setpoint: number }[] = [];

  // Get recent reward history (last 20 rewards)
  const recentRewards = db.prepare(`
    SELECT reward, effort, prediction_error, created_at
    FROM reward_log WHERE agent = ?
    ORDER BY id DESC LIMIT 20
  `).all(agent) as { reward: number; effort: number; prediction_error: number; created_at: string }[];

  if (recentRewards.length < 5) return { adapted }; // Not enough data

  const avgReward = recentRewards.reduce((s, r) => s + r.reward, 0) / recentRewards.length;
  const avgRPE = recentRewards.reduce((s, r) => s + r.prediction_error, 0) / recentRewards.length;

  // Adaptation rate: slow (personality shouldn't change rapidly)
  const adaptRate = 0.02;

  for (const drive of state.drives) {
    const oldSetpoint = drive.setpoint;

    // If consistently getting positive RPE → increase setpoint (raise the bar)
    // If consistently getting negative RPE → decrease setpoint (lower expectations)
    if (avgRPE > 0.1) {
      drive.setpoint = Math.min(1, drive.setpoint + adaptRate * avgRPE);
    } else if (avgRPE < -0.1) {
      drive.setpoint = Math.max(0.1, drive.setpoint + adaptRate * avgRPE);
    }

    // Social drives adapt faster for social agents (Lauren)
    if (drive.name === 'collaboration' && profile.social_alpha > 0.15) {
      drive.setpoint = Math.min(1, drive.setpoint + adaptRate * 0.5 * Math.max(0, avgReward - 0.5));
    }

    if (Math.abs(drive.setpoint - oldSetpoint) > 0.001) {
      adapted.push({
        drive: drive.name,
        old_setpoint: Math.round(oldSetpoint * 100) / 100,
        new_setpoint: Math.round(drive.setpoint * 100) / 100,
      });
    }
  }

  if (adapted.length > 0) {
    save_drive_state(db, state);
  }

  return { adapted };
}

/**
 * Get a full drive state report with urgency calculations and personality profile.
 * Layer 1 complete read-out for dashboard/inspection.
 */
export function drive_report(db: Database.Database, agent: string): {
  agent: string;
  drives: (Drive & { urgency: number })[];
  personality: RewardProfile;
  tonic_dopamine: number;
  avg_urgency: number;
  dominant_drive: string;
  depleted_drives: string[];
} {
  const state = load_drive_state(db, agent);
  const profile = AGENT_REWARD_PROFILES[agent] || AGENT_REWARD_PROFILES.flynn;

  const drivesWithUrgency = state.drives.map(d => ({
    ...d,
    urgency: drive_urgency(d),
  }));

  const avgUrgency = drivesWithUrgency.reduce((s, d) => s + d.urgency, 0) / Math.max(drivesWithUrgency.length, 1);
  const dominant = drivesWithUrgency.reduce((a, b) => a.urgency > b.urgency ? a : b);
  const depleted = drivesWithUrgency.filter(d => d.current < d.setpoint * 0.3);

  return {
    agent,
    drives: drivesWithUrgency,
    personality: profile,
    tonic_dopamine: state.tonic_dopamine,
    avg_urgency: Math.round(avgUrgency * 100) / 100,
    dominant_drive: dominant.name,
    depleted_drives: depleted.map(d => d.name),
  };
}

// ── Helpers ──

/** Estimate how relevant a goal is to a specific drive. */
function goalDriveRelevance(goal: Goal, drive: Drive): number {
  const desc = goal.description.toLowerCase();
  const relevanceMap: Record<string, string[]> = {
    curiosity: ['research', 'explore', 'investigate', 'learn', 'study', 'analyze', 'read'],
    task_completion: ['build', 'fix', 'deploy', 'ship', 'complete', 'finish', 'implement'],
    collaboration: ['team', 'council', 'discuss', 'coordinate', 'align', 'review', 'help'],
    resource_conservation: ['optimize', 'reduce', 'cleanup', 'prune', 'efficient'],
    learning_progress: ['train', 'model', 'pipeline', 'data', 'embedding', 'neural'],
    consistency: ['test', 'verify', 'audit', 'monitor', 'stable', 'reliable', 'fix'],
    creativity: ['design', 'invent', 'novel', 'architecture', 'reimagine', 'create'],
  };

  const keywords = relevanceMap[drive.name] || [];
  const matches = keywords.filter(k => desc.includes(k)).length;
  return Math.min(1, matches / Math.max(keywords.length * 0.3, 1));
}
