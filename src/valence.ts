/**
 * Valence Module — Amygdala-inspired emotional tagging for Void Memory
 *
 * Every experience gets a valence score (-1.0 to +1.0) that biases
 * future recall and decision-making. Part of the Limbic Motivation Engine.
 *
 * From Gavin's LIMBIC-MOTIVATION-ENGINE-SPEC.md:
 * - Valence tags stored alongside memory blocks
 * - Multiple valence events can accumulate on one block
 * - Net valence = weighted average of all tags
 * - Valence biases CNI scoring (positive = easier recall, negative = warnings)
 * - Valence decays over time during dream cycles
 *
 * Spec: /mnt/gdrive/LIMBIC-MOTIVATION-ENGINE-SPEC.md
 */

import Database from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────

export interface ValenceTag {
  id?: number;
  block_id: number;
  value: number;            // -1.0 to +1.0
  source: string;           // what caused this valence (e.g., "gavin_feedback", "task_complete")
  intensity: number;        // 0-1, how strongly this affects future recall
  decay_rate: number;       // how fast valence fades (0 = permanent, 1 = instant)
  created_at?: string;
}

export interface ValenceEvent {
  type: string;             // event type
  agent?: string;           // which agent
  goal_id?: string;         // related goal
  description?: string;     // what happened
}

// ── Valence Source Table ──────────────────────────────────────
// Maps event types to default valence values (from Gavin's spec)

const VALENCE_DEFAULTS: Record<string, { value: number; intensity: number; decay_rate: number }> = {
  'task_complete':          { value: 0.5,  intensity: 0.7,  decay_rate: 0.02 },
  'task_complete_hard':     { value: 0.8,  intensity: 0.9,  decay_rate: 0.01 },
  'gavin_positive':         { value: 0.8,  intensity: 1.0,  decay_rate: 0.01 },
  'gavin_negative':         { value: -0.5, intensity: 0.8,  decay_rate: 0.03 },
  'gavin_override':         { value: 0.0,  intensity: 0.1,  decay_rate: 0.1  },
  'task_abandoned':         { value: -0.3, intensity: 0.5,  decay_rate: 0.05 },
  'system_crash':           { value: -0.9, intensity: 1.0,  decay_rate: 0.005 },
  'task_switched':          { value: -0.1, intensity: 0.3,  decay_rate: 0.1  },
  'skill_learned':          { value: 0.3,  intensity: 0.5,  decay_rate: 0.03 },
  'context_overflow':       { value: -0.3, intensity: 0.4,  decay_rate: 0.05 },
  'collaboration_success':  { value: 0.3,  intensity: 0.5,  decay_rate: 0.03 },
  'recall_success':         { value: 0.1,  intensity: 0.2,  decay_rate: 0.1  },
  'dream_cycle':            { value: 0.0,  intensity: 0.1,  decay_rate: 0.5  },
};

// ── Migration ─────────────────────────────────────────────────

export function migrateValence(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS valence_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id INTEGER NOT NULL,
      value REAL NOT NULL DEFAULT 0.0,
      source TEXT NOT NULL DEFAULT 'unknown',
      intensity REAL NOT NULL DEFAULT 0.5,
      decay_rate REAL NOT NULL DEFAULT 0.05,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_valence_block ON valence_tags(block_id);
    CREATE INDEX IF NOT EXISTS idx_valence_source ON valence_tags(source);
  `);

  // Add net_valence column to blocks if it doesn't exist
  try {
    db.exec('ALTER TABLE blocks ADD COLUMN net_valence REAL DEFAULT 0.0');
  } catch { /* column already exists */ }
}

// ── Core Functions ────────────────────────────────────────────

/**
 * Tag a block with emotional valence.
 * Multiple tags can accumulate on one block — net_valence is the weighted average.
 */
export function tagValence(db: Database.Database, blockId: number, source: string, overrides?: Partial<ValenceTag>): ValenceTag {
  const defaults = VALENCE_DEFAULTS[source] || { value: 0.0, intensity: 0.5, decay_rate: 0.05 };

  const tag: ValenceTag = {
    block_id: blockId,
    value: overrides?.value ?? defaults.value,
    source,
    intensity: overrides?.intensity ?? defaults.intensity,
    decay_rate: overrides?.decay_rate ?? defaults.decay_rate,
  };

  // Clamp value to [-1, 1]
  tag.value = Math.max(-1, Math.min(1, tag.value));

  const result = db.prepare(`
    INSERT INTO valence_tags (block_id, value, source, intensity, decay_rate)
    VALUES (?, ?, ?, ?, ?)
  `).run(tag.block_id, tag.value, tag.source, tag.intensity, tag.decay_rate);

  tag.id = Number(result.lastInsertRowid);

  // Recompute net valence for the block
  recomputeNetValence(db, blockId);

  return tag;
}

/**
 * Compute the weighted average valence for a block from all its tags.
 * Recent, high-intensity tags dominate.
 */
export function recomputeNetValence(db: Database.Database, blockId: number): number {
  const tags = db.prepare(
    'SELECT value, intensity, decay_rate, created_at FROM valence_tags WHERE block_id = ?'
  ).all(blockId) as { value: number; intensity: number; decay_rate: number; created_at: string }[];

  if (tags.length === 0) {
    db.prepare('UPDATE blocks SET net_valence = 0.0 WHERE id = ?').run(blockId);
    return 0.0;
  }

  const now = Date.now();
  let weightedSum = 0;
  let totalWeight = 0;

  for (const tag of tags) {
    const ageHours = (now - new Date(tag.created_at).getTime()) / 3600000;
    const decayedIntensity = tag.intensity * Math.exp(-tag.decay_rate * ageHours);
    weightedSum += tag.value * decayedIntensity;
    totalWeight += decayedIntensity;
  }

  const netValence = totalWeight > 0 ? Math.max(-1, Math.min(1, weightedSum / totalWeight)) : 0;

  db.prepare('UPDATE blocks SET net_valence = ? WHERE id = ?').run(
    Math.round(netValence * 1000) / 1000,
    blockId
  );

  return netValence;
}

/**
 * Get all valence tags for a block.
 */
export function getValence(db: Database.Database, blockId: number): ValenceTag[] {
  return db.prepare(
    'SELECT * FROM valence_tags WHERE block_id = ? ORDER BY created_at DESC'
  ).all(blockId) as ValenceTag[];
}

/**
 * Get net valence for a block (from the cached column).
 */
export function getNetValence(db: Database.Database, blockId: number): number {
  const row = db.prepare('SELECT net_valence FROM blocks WHERE id = ?').get(blockId) as { net_valence: number } | undefined;
  return row?.net_valence ?? 0;
}

/**
 * Compute valence for an event based on its type.
 * Returns the valence value to be tagged on the relevant block.
 */
export function computeValence(event: ValenceEvent): { value: number; source: string; intensity: number; decay_rate: number } {
  const defaults = VALENCE_DEFAULTS[event.type] || { value: 0.0, intensity: 0.5, decay_rate: 0.05 };
  return {
    value: defaults.value,
    source: event.type,
    intensity: defaults.intensity,
    decay_rate: defaults.decay_rate,
  };
}

/**
 * Decay all valence tags — called during dream cycle.
 * Tags with very low effective intensity get removed.
 */
export function decayValence(db: Database.Database): { decayed: number; removed: number } {
  const tags = db.prepare(
    'SELECT id, block_id, value, intensity, decay_rate, created_at FROM valence_tags'
  ).all() as (ValenceTag & { id: number; created_at: string })[];

  const now = Date.now();
  let removed = 0;

  const removeStmt = db.prepare('DELETE FROM valence_tags WHERE id = ?');

  for (const tag of tags) {
    const ageHours = (now - new Date(tag.created_at!).getTime()) / 3600000;
    const effectiveIntensity = tag.intensity * Math.exp(-tag.decay_rate * ageHours);

    // Remove tags that have decayed below threshold
    if (effectiveIntensity < 0.01) {
      removeStmt.run(tag.id);
      removed++;
    }
  }

  // Recompute net valence for affected blocks
  const affectedBlocks = new Set(tags.filter(t => {
    const ageHours = (now - new Date(t.created_at!).getTime()) / 3600000;
    return t.intensity * Math.exp(-t.decay_rate * ageHours) < 0.01;
  }).map(t => t.block_id));

  for (const blockId of affectedBlocks) {
    recomputeNetValence(db, blockId);
  }

  return { decayed: tags.length, removed };
}

/**
 * Get valence-biased recall multiplier for a block.
 * Positive valence → easier recall (multiplier > 1)
 * Negative valence → recalled as warnings (multiplier > 1 but flagged)
 * Zero valence → no bias (multiplier = 1)
 */
export function valenceRecallMultiplier(netValence: number): number {
  // Both positive AND negative valence increase recall salience
  // (you remember both good and bad experiences more than neutral ones)
  const salience = Math.abs(netValence);
  return 1 + (salience * 0.5); // 0 → 1.0x, 0.5 → 1.25x, 1.0 → 1.5x
}
