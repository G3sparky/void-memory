/**
 * Kruse Memory Upgrades — Quantum Biology Inspired Memory Management
 *
 * Three deliverables:
 * 1. WIRING — heteroplasmy/redox/ACT-R drive live decisions:
 *    - Auto-trigger dream when heteroplasmy > 40%
 *    - Adjust recall budget based on redox balance
 *    - Add health advisory to recall results
 *
 * 2. TIERED STORAGE — hot/warm/cold based on access patterns:
 *    - Hot:  accessed in last 7 days OR access_count >= 5 — full recall weight
 *    - Warm: accessed in last 30 days OR access_count >= 2 — normal weight
 *    - Cold: not accessed in 30+ days AND access_count < 2 — reduced weight, candidates for consolidation
 *    - Blocks promote/demote automatically based on access patterns
 *
 * 3. CIRCADIAN CYCLING — cron-based void_dream for all agents:
 *    - Runs dream consolidation on a schedule
 *    - Per-agent, sequential (no concurrent DB access)
 *    - Logs results for monitoring
 *
 * From Gavin's Kruse quantum biology research + Lauren's proposals.
 * Patent Pending: AU 2026902541, AU 2026902542
 *
 * @module kruse
 */

import type Database from 'better-sqlite3';
import { stats } from './engine.js';
import { limbicDream, storeLimbicDreamInsights } from './limbic-dream.js';

// ── Types ──

export type StorageTier = 'hot' | 'warm' | 'cold';

export interface TierReport {
  hot: number;
  warm: number;
  cold: number;
  total: number;
  promotions: number;
  demotions: number;
}

export interface HealthAdvisory {
  status: 'healthy' | 'degraded' | 'critical' | 'imbalanced';
  heteroplasmy_rate: number;
  redox_score: number;
  actr_health: string;
  recommendations: string[];
  auto_dream_triggered: boolean;
  budget_adjustment: number;  // multiplier on recall budget (0.8-1.2)
  tiers: TierReport;
}

export interface CircadianResult {
  agent: string;
  success: boolean;
  duration_ms: number;
  insights_count: number;
  consolidations: {
    merged: number;
    decayed: number;
    confirmed: number;
  };
  health_before: { heteroplasmy: number; redox: number };
  health_after: { heteroplasmy: number; redox: number };
  error?: string;
}

// ── Constants ──

const HOT_ACCESS_DAYS = 7;
const WARM_ACCESS_DAYS = 30;
const HOT_ACCESS_COUNT = 5;
const WARM_ACCESS_COUNT = 2;

// Health thresholds (from Kruse heteroplasmy model)
const HETEROPLASMY_CRITICAL = 40;    // Auto-dream trigger
const HETEROPLASMY_DEGRADED = 20;    // Warning, recommend dream
const REDOX_LOW = 15;                // All store, no recall — battery charging too much
const REDOX_HIGH = 85;               // All recall, no store — battery draining

// Budget adjustments based on health
const BUDGET_HEALTHY = 1.0;
const BUDGET_DEGRADED = 0.9;         // Tighter budget when junk is high (less noise)
const BUDGET_CRITICAL = 0.8;         // Even tighter — only high-quality results
const BUDGET_IMBALANCED = 1.1;       // Slightly larger to compensate for one-sided flow

// ── 1. TIERED STORAGE ──

/**
 * Migrate: add storage_tier column to blocks table
 */
export function migrateTieredStorage(db: Database.Database): void {
  try {
    db.exec(`ALTER TABLE blocks ADD COLUMN storage_tier TEXT DEFAULT 'warm'`);
  } catch {
    // Column already exists — fine
  }

  // Create index for tier-based queries
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_tier ON blocks(storage_tier)`);
  } catch {
    // Already exists
  }
}

/**
 * Classify a block into hot/warm/cold based on access patterns.
 */
export function classifyTier(accessCount: number, accessedAt: string | null, createdAt: string): StorageTier {
  const now = Date.now();

  // Check recency
  let daysSinceAccess = Infinity;
  if (accessedAt) {
    daysSinceAccess = (now - new Date(accessedAt).getTime()) / 86400000;
  } else {
    // Never accessed — use creation date
    daysSinceAccess = (now - new Date(createdAt).getTime()) / 86400000;
  }

  // Hot: recently accessed OR frequently accessed
  if (daysSinceAccess <= HOT_ACCESS_DAYS || accessCount >= HOT_ACCESS_COUNT) {
    return 'hot';
  }

  // Warm: moderately recent OR some access
  if (daysSinceAccess <= WARM_ACCESS_DAYS || accessCount >= WARM_ACCESS_COUNT) {
    return 'warm';
  }

  // Cold: old and rarely accessed
  return 'cold';
}

/**
 * Run tiered storage classification on all active blocks.
 * Returns promotion/demotion counts.
 */
export function updateTiers(db: Database.Database): TierReport {
  migrateTieredStorage(db);

  const blocks = db.prepare(
    `SELECT id, access_count, accessed_at, created_at, storage_tier FROM blocks WHERE state >= 0`
  ).all() as { id: number; access_count: number; accessed_at: string | null; created_at: string; storage_tier: string }[];

  let hot = 0, warm = 0, cold = 0;
  let promotions = 0, demotions = 0;

  const tierOrder = { cold: 0, warm: 1, hot: 2 };
  const updateStmt = db.prepare(`UPDATE blocks SET storage_tier = ? WHERE id = ?`);

  const batchUpdate = db.transaction(() => {
    for (const block of blocks) {
      const newTier = classifyTier(block.access_count, block.accessed_at, block.created_at);
      const oldTier = (block.storage_tier || 'warm') as StorageTier;

      if (newTier !== oldTier) {
        updateStmt.run(newTier, block.id);
        const oldRank = tierOrder[oldTier] ?? 1;
        const newRank = tierOrder[newTier];
        if (newRank > oldRank) promotions++;
        else demotions++;
      }

      if (newTier === 'hot') hot++;
      else if (newTier === 'warm') warm++;
      else cold++;
    }
  });

  batchUpdate();

  return { hot, warm, cold, total: blocks.length, promotions, demotions };
}

/**
 * Get tier multiplier for recall scoring.
 * Hot blocks get a boost, cold blocks get penalized.
 */
export function tierMultiplier(tier: StorageTier): number {
  switch (tier) {
    case 'hot': return 1.15;   // 15% boost — recently/frequently accessed
    case 'warm': return 1.0;   // Baseline
    case 'cold': return 0.85;  // 15% penalty — old and rarely accessed
  }
}

// ── 2. HEALTH WIRING — Drive Live Decisions ──

/**
 * Generate a health advisory from current stats.
 * This is called before recall to adjust behavior.
 */
export function healthAdvisory(db: Database.Database): HealthAdvisory {
  migrateTieredStorage(db);

  const s = stats(db);
  const tiers = getTierCounts(db);

  const recommendations: string[] = [];
  let budgetAdjustment = BUDGET_HEALTHY;
  let autoDreamTriggered = false;
  let status: HealthAdvisory['status'] = 'healthy';

  // Heteroplasmy checks
  if (s.heteroplasmy_rate > HETEROPLASMY_CRITICAL) {
    status = 'critical';
    budgetAdjustment = BUDGET_CRITICAL;
    autoDreamTriggered = true;
    recommendations.push(
      `Heteroplasmy critical (${s.heteroplasmy_rate}%). Auto-triggering dream consolidation.`,
      'Too much junk accumulating — dream cycle will merge duplicates and decay stale blocks.'
    );
  } else if (s.heteroplasmy_rate > HETEROPLASMY_DEGRADED) {
    status = 'degraded';
    budgetAdjustment = BUDGET_DEGRADED;
    recommendations.push(
      `Heteroplasmy elevated (${s.heteroplasmy_rate}%). Schedule a dream cycle soon.`,
      'Tightening recall budget to filter low-quality results.'
    );
  }

  // Redox checks
  if (s.redox_score < REDOX_LOW) {
    if (status === 'healthy') status = 'imbalanced';
    budgetAdjustment = Math.max(budgetAdjustment, BUDGET_IMBALANCED);
    recommendations.push(
      `Redox low (${s.redox_score}%). All storage, no retrieval — memory battery overcharging.`,
      'Recall more often. Knowledge unused is knowledge wasted.'
    );
  } else if (s.redox_score > REDOX_HIGH) {
    if (status === 'healthy') status = 'imbalanced';
    budgetAdjustment = Math.max(budgetAdjustment, BUDGET_IMBALANCED);
    recommendations.push(
      `Redox high (${s.redox_score}%). All retrieval, no storage — memory battery draining.`,
      'Store new knowledge. Learning stopped.'
    );
  }

  // Cold tier check
  const coldPct = tiers.total > 0 ? Math.round((tiers.cold / tiers.total) * 100) : 0;
  if (coldPct > 60) {
    recommendations.push(
      `${coldPct}% of blocks are cold storage. Consider a dream cycle to consolidate.`
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('Memory health is good. No action needed.');
  }

  return {
    status,
    heteroplasmy_rate: s.heteroplasmy_rate,
    redox_score: s.redox_score,
    actr_health: s.actr_health,
    recommendations,
    auto_dream_triggered: autoDreamTriggered,
    budget_adjustment: budgetAdjustment,
    tiers,
  };
}

/**
 * Quick tier counts without full reclassification.
 */
function getTierCounts(db: Database.Database): TierReport {
  const hot = (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state >= 0 AND storage_tier = 'hot'`).get() as any)?.c || 0;
  const warm = (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state >= 0 AND storage_tier = 'warm'`).get() as any)?.c || 0;
  const cold = (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state >= 0 AND storage_tier = 'cold'`).get() as any)?.c || 0;
  const total = hot + warm + cold;
  return { hot, warm, cold, total, promotions: 0, demotions: 0 };
}

/**
 * Get adjusted recall budget based on health state.
 * Called by the recall engine to dynamically adjust token budget.
 */
export function adjustedBudget(db: Database.Database, requestedBudget: number): number {
  try {
    const advisory = healthAdvisory(db);
    return Math.round(requestedBudget * advisory.budget_adjustment);
  } catch {
    return requestedBudget; // Fail safe — no adjustment
  }
}

// ── 2b. COHERENT DOMAINS — Co-recalled blocks form bonds like hydrogen bonds in water ──

export interface CoherentDomain {
  id: number;
  name: string;
  description: string;
  block_count: number;
  total_co_recall_strength: number;
  member_ids: number[];
}

/**
 * Build coherent domains from co-recall patterns.
 * Blocks that are frequently recalled together form "coherent domains" —
 * semantic clusters that emerge from usage, not from keyword similarity.
 *
 * Algorithm:
 * 1. Load co-recall pairs with count >= threshold (default 3)
 * 2. Build adjacency graph
 * 3. Find connected components (domains)
 * 4. Name each domain by most common keywords of its members
 * 5. Persist to coherent_domains + domain_members tables
 */
const CO_RECALL_BOND_THRESHOLD = 3;  // Minimum co-recalls to form a bond

export function buildCoherentDomains(db: Database.Database): CoherentDomain[] {
  // Load strong co-recall pairs
  const pairs = db.prepare(`
    SELECT block_a, block_b, co_count FROM co_recalls
    WHERE co_count >= ?
    ORDER BY co_count DESC
  `).all(CO_RECALL_BOND_THRESHOLD) as { block_a: number; block_b: number; co_count: number }[];

  if (pairs.length === 0) return [];

  // Build adjacency graph
  const adj = new Map<number, Set<number>>();
  const strength = new Map<string, number>();

  for (const p of pairs) {
    if (!adj.has(p.block_a)) adj.set(p.block_a, new Set());
    if (!adj.has(p.block_b)) adj.set(p.block_b, new Set());
    adj.get(p.block_a)!.add(p.block_b);
    adj.get(p.block_b)!.add(p.block_a);
    strength.set(`${p.block_a}:${p.block_b}`, p.co_count);
  }

  // Find connected components (BFS)
  const visited = new Set<number>();
  const components: number[][] = [];

  for (const node of adj.keys()) {
    if (visited.has(node)) continue;
    const component: number[] = [];
    const queue = [node];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);
      component.push(curr);
      for (const neighbor of adj.get(curr) || []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (component.length >= 2) {  // Minimum 2 blocks for a domain
      components.push(component);
    }
  }

  // Clear old domains and rebuild
  db.exec(`DELETE FROM domain_members`);
  db.exec(`DELETE FROM coherent_domains`);

  const domains: CoherentDomain[] = [];
  const insertDomain = db.prepare(`
    INSERT INTO coherent_domains (name, description, block_count, total_co_recall_strength)
    VALUES (?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT INTO domain_members (domain_id, block_id) VALUES (?, ?)
  `);

  const buildDomains = db.transaction(() => {
    for (const component of components) {
      // Calculate total strength of this domain
      let totalStrength = 0;
      for (let i = 0; i < component.length; i++) {
        for (let j = i + 1; j < component.length; j++) {
          const a = Math.min(component[i], component[j]);
          const b = Math.max(component[i], component[j]);
          totalStrength += strength.get(`${a}:${b}`) || 0;
        }
      }

      // Name domain by most common keywords of members
      const blocks = db.prepare(
        `SELECT keywords FROM blocks WHERE id IN (${component.map(() => '?').join(',')})`
      ).all(...component) as { keywords: string }[];

      const keywordFreq = new Map<string, number>();
      for (const b of blocks) {
        for (const kw of b.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)) {
          keywordFreq.set(kw, (keywordFreq.get(kw) || 0) + 1);
        }
      }
      const topKeywords = [...keywordFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k]) => k);

      const name = topKeywords.join(' + ') || `domain-${component[0]}`;
      const description = `${component.length} blocks, ${totalStrength} total co-recall bonds. Keywords: ${topKeywords.join(', ')}`;

      const result = insertDomain.run(name, description, component.length, totalStrength);
      const domainId = result.lastInsertRowid as number;

      for (const blockId of component) {
        insertMember.run(domainId, blockId);
      }

      domains.push({
        id: domainId,
        name,
        description,
        block_count: component.length,
        total_co_recall_strength: totalStrength,
        member_ids: component,
      });
    }
  });

  buildDomains();
  return domains.sort((a, b) => b.total_co_recall_strength - a.total_co_recall_strength);
}

/**
 * Get existing coherent domains.
 */
export function getCoherentDomains(db: Database.Database): CoherentDomain[] {
  const domains = db.prepare(`
    SELECT id, name, description, block_count, total_co_recall_strength FROM coherent_domains
    ORDER BY total_co_recall_strength DESC
  `).all() as Omit<CoherentDomain, 'member_ids'>[];

  return domains.map(d => {
    const members = db.prepare(
      `SELECT block_id FROM domain_members WHERE domain_id = ?`
    ).all(d.id) as { block_id: number }[];
    return {
      ...d,
      member_ids: members.map(m => m.block_id),
    };
  });
}

/**
 * Get tool call tracking stats for motivation instrumentation.
 */
export function toolCallStats(db: Database.Database, agent?: string): any {
  const where = agent ? `WHERE agent = ?` : '';
  const params = agent ? [agent] : [];

  const totals = db.prepare(`
    SELECT tool_name, COUNT(*) as calls, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
           AVG(duration_ms) as avg_ms
    FROM tool_calls ${where}
    GROUP BY tool_name
    ORDER BY calls DESC
  `).all(...params) as { tool_name: string; calls: number; successes: number; avg_ms: number }[];

  const recent = db.prepare(`
    SELECT tool_name, called_at, success FROM tool_calls ${where}
    ORDER BY called_at DESC LIMIT 20
  `).all(...params) as { tool_name: string; called_at: string; success: number }[];

  return { totals, recent };
}

// ── 3. CIRCADIAN CYCLING ──

/**
 * Run circadian dream cycle for a single agent.
 * Includes: tier update → health check → dream → post-dream tier update
 */
export function circadianCycle(db: Database.Database, agent: string): CircadianResult {
  const start = Date.now();

  try {
    // Pre-dream health snapshot
    const preDream = stats(db);
    const healthBefore = {
      heteroplasmy: preDream.heteroplasmy_rate,
      redox: preDream.redox_score,
    };

    // Update tiers before dream (so dream can use tier info)
    updateTiers(db);

    // Run limbic dream cycle
    const report = limbicDream(db, agent);
    storeLimbicDreamInsights(db, report);

    // Post-dream tier update (dream may have changed block states)
    updateTiers(db);

    // Build coherent domains from co-recall patterns
    try { buildCoherentDomains(db); } catch { /* co_recalls may not exist */ }

    // Post-dream health snapshot
    const postDream = stats(db);
    const healthAfter = {
      heteroplasmy: postDream.heteroplasmy_rate,
      redox: postDream.redox_score,
    };

    return {
      agent,
      success: true,
      duration_ms: Date.now() - start,
      insights_count: report.insights.length,
      consolidations: {
        merged: report.consolidations.merged,
        decayed: report.consolidations.decayed,
        confirmed: report.consolidations.confirmed,
      },
      health_before: healthBefore,
      health_after: healthAfter,
    };
  } catch (err: any) {
    return {
      agent,
      success: false,
      duration_ms: Date.now() - start,
      insights_count: 0,
      consolidations: { merged: 0, decayed: 0, confirmed: 0 },
      health_before: { heteroplasmy: 0, redox: 50 },
      health_after: { heteroplasmy: 0, redox: 50 },
      error: err.message,
    };
  }
}
