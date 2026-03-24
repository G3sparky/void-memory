/**
 * E3: Auto Contradiction Detector for Void Memory
 * =================================================
 * Detects when blocks contain conflicting information about the same topic.
 * Auto-inhibits older contradicted blocks via the supersedes mechanism.
 *
 * Works WITHOUT semantic embeddings (keyword overlap + date comparison).
 * When E1 embeddings are available, can use cosine similarity for better matching.
 *
 * Flynn — 2026-03-22
 */

import type Database from 'better-sqlite3';

// ── Types ──

export interface Contradiction {
  newer_id: number;
  older_id: number;
  topic: string;           // shared keyword cluster
  confidence: number;      // 0-1, how confident we are this is a real contradiction
  reason: string;
  auto_resolved: boolean;
}

export interface ContradictionScanResult {
  scanned: number;
  contradictions_found: number;
  auto_inhibited: number;
  details: Contradiction[];
  duration_ms: number;
}

// ── Contradiction signals ──

// Words that signal an update/change (block likely supersedes older info)
const UPDATE_SIGNALS = [
  'changed from', 'changed to', 'updated', 'moved to', 'migrated to',
  'replaced by', 'replaced with', 'no longer', 'now uses', 'now runs',
  'switched to', 'switched from', 'was changed', 'has been moved',
  'increased to', 'decreased to', 'raised to', 'lowered to',
  'renamed to', 'rebalanced', 'revised', 'corrected', 'fixed',
  'new port', 'new version', 'upgraded to', 'downgraded to',
];

// Numeric value patterns that might conflict
const NUMERIC_RE = /\b(\d+(?:\.\d+)?)\s*(%|ms|mb|gb|port|minutes?|hours?|seconds?|days?|blocks?|features?|cells?)\b/gi;

/**
 * Extract numeric claims from text: "port 3216", "25 minutes", "16 features"
 */
function extractNumericClaims(text: string): Map<string, number> {
  const claims = new Map<string, number>();
  let m;
  const re = new RegExp(NUMERIC_RE.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    const unit = m[2].toLowerCase().replace(/s$/, '');
    claims.set(unit, parseFloat(m[1]));
  }
  return claims;
}

/**
 * Check if two blocks have conflicting numeric claims.
 * E.g., "port 3216" vs "port 3220" — same unit, different value.
 */
function hasNumericConflict(a: string, b: string): { conflicting: boolean; unit?: string; valA?: number; valB?: number } {
  const claimsA = extractNumericClaims(a);
  const claimsB = extractNumericClaims(b);

  for (const [unit, valA] of claimsA) {
    const valB = claimsB.get(unit);
    if (valB !== undefined && valA !== valB) {
      return { conflicting: true, unit, valA, valB };
    }
  }
  return { conflicting: false };
}

/**
 * Check if text contains update signal words.
 */
function hasUpdateSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return UPDATE_SIGNALS.some(signal => lower.includes(signal));
}

/**
 * Calculate keyword overlap between two blocks.
 * Returns Jaccard similarity of keyword sets.
 */
function keywordOverlap(kwA: string, kwB: string): number {
  const setA = new Set(kwA.split(',').map(k => k.trim().toLowerCase()).filter(Boolean));
  const setB = new Set(kwB.split(',').map(k => k.trim().toLowerCase()).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const k of setA) if (setB.has(k)) intersection++;

  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Parse date from block content or created_at.
 * Returns the most specific date found, or the block creation date.
 */
function getBlockDate(content: string, createdAt: string): Date {
  // Try to find ISO date in content
  const isoMatch = content.match(/\b(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/);
  if (isoMatch) return new Date(isoMatch[1]);

  // Fall back to created_at
  return new Date(createdAt);
}

// ── Core detection ──

/**
 * Scan for contradictions in the block corpus.
 * Groups blocks by keyword overlap, then checks for conflicting claims.
 *
 * @param autoResolve If true, auto-inhibit older contradicted blocks
 */
export function scanContradictions(
  db: Database.Database,
  autoResolve = false
): ContradictionScanResult {
  const start = performance.now();

  // Load all active blocks
  const blocks = db.prepare(`
    SELECT id, content, keywords, category, confidence, created_at
    FROM blocks WHERE state = 1
    ORDER BY id DESC
  `).all() as Array<{
    id: number; content: string; keywords: string;
    category: string; confidence: string; created_at: string;
  }>;

  const contradictions: Contradiction[] = [];
  const processed = new Set<string>(); // "id1-id2" pairs already checked

  // Compare each block against others with high keyword overlap
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]; // newer (higher id)
      const b = blocks[j]; // older (lower id)

      const pairKey = `${a.id}-${b.id}`;
      if (processed.has(pairKey)) continue;
      processed.add(pairKey);

      // Step 1: Check keyword overlap (must be about same topic)
      const overlap = keywordOverlap(a.keywords, b.keywords);
      if (overlap < 0.3) continue; // Not enough topic overlap

      // Step 2: Check for contradiction signals
      let confidence = 0;
      let reason = '';

      // 2a: Numeric conflict (e.g., "port 3216" vs "port 3220")
      const numConflict = hasNumericConflict(a.content, b.content);
      if (numConflict.conflicting) {
        confidence += 0.5;
        reason += `Numeric conflict: ${numConflict.unit} ${numConflict.valA} vs ${numConflict.valB}. `;
      }

      // 2b: Update signal in newer block
      if (hasUpdateSignal(a.content)) {
        confidence += 0.3;
        reason += 'Newer block contains update language. ';
      }

      // 2c: Same category with high overlap suggests replacement
      if (a.category === b.category && overlap > 0.6) {
        confidence += 0.2;
        reason += `High keyword overlap (${(overlap * 100).toFixed(0)}%) in same category. `;
      }

      // Only flag if confidence meets threshold
      if (confidence >= 0.5) {
        const topic = a.keywords.split(',')[0]?.trim() || a.category;
        contradictions.push({
          newer_id: a.id,
          older_id: b.id,
          topic,
          confidence: Math.min(confidence, 1.0),
          reason: reason.trim(),
          auto_resolved: false,
        });
      }
    }

    // Performance guard: don't compare every block against every other
    // Only check blocks within the same keyword neighborhood
    if (i > 500) break; // Limit scan to newest 500 blocks
  }

  // Auto-resolve if requested
  let autoInhibited = 0;
  if (autoResolve && contradictions.length > 0) {
    const inhibit = db.prepare(`UPDATE blocks SET state = -1 WHERE id = ?`);
    const addInhibition = db.prepare(`
      INSERT OR IGNORE INTO inhibitions (blocker_id, blocked_id, reason)
      VALUES (?, ?, ?)
    `);

    const txn = db.transaction(() => {
      for (const c of contradictions) {
        if (c.confidence >= 0.7) { // Only auto-resolve high-confidence contradictions
          inhibit.run(c.older_id);
          addInhibition.run(c.newer_id, c.older_id, `Auto-contradiction: ${c.reason}`);
          c.auto_resolved = true;
          autoInhibited++;
        }
      }
    });
    txn();
  }

  return {
    scanned: blocks.length,
    contradictions_found: contradictions.length,
    auto_inhibited: autoInhibited,
    details: contradictions,
    duration_ms: Math.round((performance.now() - start) * 10) / 10,
  };
}

/**
 * Check a single new block against existing blocks for contradictions.
 * Called during store() to catch contradictions at write time.
 *
 * Returns the ID of the older block to supersede, or null.
 */
export function checkNewBlockContradiction(
  db: Database.Database,
  content: string,
  keywords: string,
  category: string
): { supersedes: number | null; reason: string | null } {
  // Find existing blocks with high keyword overlap
  const keywordList = keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  if (keywordList.length === 0) return { supersedes: null, reason: null };

  // Build a LIKE query for keyword matching
  const conditions = keywordList.slice(0, 5).map(k => `keywords LIKE '%${k.replace(/'/g, "''")}%'`);
  const where = conditions.join(' OR ');

  const candidates = db.prepare(`
    SELECT id, content, keywords, category, created_at
    FROM blocks WHERE state = 1 AND (${where})
    ORDER BY id DESC LIMIT 50
  `).all() as Array<{
    id: number; content: string; keywords: string;
    category: string; created_at: string;
  }>;

  for (const existing of candidates) {
    const overlap = keywordOverlap(keywords, existing.keywords);
    if (overlap < 0.4) continue;

    let confidence = 0;
    let reason = '';

    const numConflict = hasNumericConflict(content, existing.content);
    if (numConflict.conflicting) {
      confidence += 0.5;
      reason += `Numeric conflict: ${numConflict.unit} ${numConflict.valA} vs ${numConflict.valB}. `;
    }

    if (hasUpdateSignal(content)) {
      confidence += 0.3;
      reason += 'New block contains update language. ';
    }

    if (category === existing.category && overlap > 0.6) {
      confidence += 0.2;
      reason += `High keyword overlap (${(overlap * 100).toFixed(0)}%). `;
    }

    if (confidence >= 0.7) {
      return { supersedes: existing.id, reason: reason.trim() };
    }
  }

  return { supersedes: null, reason: null };
}
