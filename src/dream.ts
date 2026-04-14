/**
 * VoidOS Dream Engine — Cross-domain discovery through structural absence
 *
 * Dreaming is what happens when the memory engine runs offline:
 * 1. Consolidation: decay stale blocks, merge duplicates, confirm active ones
 * 2. Cross-domain connections: find unexpected links between distant topics
 * 3. Gap detection: identify knowledge holes from recall patterns
 * 4. Pattern discovery: surface recurring themes across blocks
 * 5. Forgotten surfacing: find high-value blocks that slipped into void
 *
 * Like the brain — dreaming reorganises, connects, and prunes.
 * Patent Pending: AU 2026902541, AU 2026902542
 */

import Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────

export interface DreamInsight {
  type: 'connection' | 'gap' | 'pattern' | 'forgotten' | 'contradiction' | 'consolidation';
  title: string;
  description: string;
  confidence: number;  // 0-1
  blocks: number[];    // related block IDs
}

export interface DreamReport {
  timestamp: string;
  duration_ms: number;
  morning_briefing: string;
  insights: DreamInsight[];
  consolidations: {
    merged: number;
    inhibited: number;
    decayed: number;
    confirmed: number;
    total: number;
    connections_discovered: number;
    gaps_detected: number;
    forgotten_surfaced: number;
    patterns_found: number;
  };
  memory_health: {
    total_blocks: number;
    active: number;
    void_count: number;
    inhibitory: number;
    never_accessed: number;
    dead_weight_pct: number;
    avg_age_days: number;
    top_categories: { category: string; count: number }[];
    top_projects: { project: string; count: number }[];
  };
}

interface BlockRow {
  id: number;
  content: string;
  category: string;
  keywords: string;
  state: number;
  confidence: string;
  access_count: number;
  created_at: string;
}

// ── Stopwords (match engine.ts) ─────────────────────────────

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','have','has','had',
  'do','does','did','will','would','could','should','may','might','can',
  'to','of','in','for','on','with','at','by','from','as','into','through',
  'and','but','or','not','so','what','which','who','how','when','where','why',
  'i','me','my','we','you','your','he','him','she','her','it','its',
  'they','them','their','this','that','these','those',
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function keywordOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const w of setA) if (setB.has(w)) overlap++;
  const smaller = Math.min(setA.size, setB.size);
  return smaller > 0 ? overlap / smaller : 0;
}

// ── Dream Engine ─────────────────────────────────────────────

export function dream(db: Database.Database): DreamReport {
  const start = Date.now();
  const insights: DreamInsight[] = [];
  let merged = 0, inhibited = 0, decayed = 0, confirmed = 0;

  // ── Phase 1: Memory Health Snapshot ──
  const totalBlocks = (db.prepare('SELECT COUNT(*) as c FROM blocks').get() as any).c;
  const activeCount = (db.prepare('SELECT COUNT(*) as c FROM blocks WHERE state = 1').get() as any).c;
  const voidCount = (db.prepare('SELECT COUNT(*) as c FROM blocks WHERE state = 0').get() as any).c;
  const inhibitoryCount = (db.prepare('SELECT COUNT(*) as c FROM blocks WHERE state = -1').get() as any).c;
  const neverAccessed = (db.prepare('SELECT COUNT(*) as c FROM blocks WHERE state >= 0 AND access_count = 0').get() as any).c;
  const avgAge = (db.prepare("SELECT AVG(julianday('now') - julianday(created_at)) as d FROM blocks WHERE state = 1").get() as any).d || 0;

  const topCats = db.prepare(
    'SELECT category, COUNT(*) as c FROM blocks WHERE state = 1 GROUP BY category ORDER BY c DESC LIMIT 5'
  ).all() as { category: string; c: number }[];

  const topProjects: { project: string; count: number }[] = []; // project column not in schema

  // ── Phase 2: Consolidation — Decay, Confirm, Merge ──

  // Decay: blocks older than 30 days with 0 access and low confidence → void
  const staleBlocks = db.prepare(
    "SELECT id FROM blocks WHERE state = 1 AND access_count = 0 AND confidence = 'stored' AND julianday('now') - julianday(created_at) > 30"
  ).all() as { id: number }[];

  for (const b of staleBlocks.slice(0, 50)) {
    db.prepare('UPDATE blocks SET state = 0, accessed_at = CURRENT_TIMESTAMP WHERE id = ?').run(b.id);
    decayed++;
  }

  // Confirm: blocks accessed 3+ times that are still 'stored' → 'confirmed'
  const frequentBlocks = db.prepare(
    "SELECT id FROM blocks WHERE state = 1 AND confidence = 'stored' AND access_count >= 3"
  ).all() as { id: number }[];

  for (const b of frequentBlocks) {
    db.prepare("UPDATE blocks SET confidence = 'confirmed', accessed_at = CURRENT_TIMESTAMP WHERE id = ?").run(b.id);
    confirmed++;
  }

  // Merge: find duplicate active blocks with high keyword overlap
  const activeBlocks = db.prepare(
    'SELECT id, content, keywords, category FROM blocks WHERE state = 1 ORDER BY access_count DESC, id DESC'
  ).all() as BlockRow[];

  const seenPairs = new Set<string>();
  for (let i = 0; i < Math.min(activeBlocks.length, 200); i++) {
    const a = activeBlocks[i];
    const tokA = tokenize(a.keywords + ' ' + a.content.slice(0, 200));
    for (let j = i + 1; j < Math.min(activeBlocks.length, 200); j++) {
      const b = activeBlocks[j];
      if (a.category !== b.category) continue;
      const pairKey = `${a.id}-${b.id}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const tokB = tokenize(b.keywords + ' ' + b.content.slice(0, 200));
      const overlap = keywordOverlap(tokA, tokB);

      if (overlap > 0.8) {
        // Inhibit the less-accessed one
        db.prepare('UPDATE blocks SET state = -1, accessed_at = CURRENT_TIMESTAMP WHERE id = ?').run(b.id);
        db.prepare('INSERT OR IGNORE INTO inhibitions (blocker_id, blocked_id, reason) VALUES (?, ?, ?)').run(a.id, b.id, 'dream-merge');
        merged++;
      }
    }
  }

  // ── Phase 3: Cross-Domain Connections ──
  // Sample blocks from different categories and look for unexpected keyword overlap
  const categories = [...new Set(activeBlocks.map(b => b.category))];
  let connectionsDiscovered = 0;

  for (let ci = 0; ci < categories.length && ci < 10; ci++) {
    for (let cj = ci + 1; cj < categories.length && cj < 10; cj++) {
      const catA = categories[ci];
      const catB = categories[cj];

      const blocksA = activeBlocks.filter(b => b.category === catA).slice(0, 10);
      const blocksB = activeBlocks.filter(b => b.category === catB).slice(0, 10);

      for (const a of blocksA) {
        const tokA = tokenize(a.keywords + ' ' + a.content.slice(0, 300));
        for (const bBlock of blocksB) {
          const tokB = tokenize(bBlock.keywords + ' ' + bBlock.content.slice(0, 300));
          const overlap = keywordOverlap(tokA, tokB);

          if (overlap >= 0.25 && overlap < 0.8) {
            // Interesting connection — not duplicate, but related
            const shared = tokA.filter(t => new Set(tokB).has(t)).slice(0, 5);
            insights.push({
              type: 'connection',
              title: `${catA} ↔ ${catB}: shared concepts`,
              description: `Blocks #${a.id} (${catA}) and #${bBlock.id} (${catB}) share ${(overlap * 100).toFixed(0)}% keywords: ${shared.join(', ')}`,
              confidence: overlap,
              blocks: [a.id, bBlock.id],
            });
            connectionsDiscovered++;
            if (connectionsDiscovered >= 10) break;
          }
        }
        if (connectionsDiscovered >= 10) break;
      }
      if (connectionsDiscovered >= 10) break;
    }
    if (connectionsDiscovered >= 10) break;
  }

  // ── Phase 4: Gap Detection ──
  // Check recall_log for queries that returned 0 results or very low scores
  let gapsDetected = 0;

  // Known test/garbage queries used by Grid safety officer — skip these
  const TEST_QUERIES = new Set(['recipe chocolate cake baking flour']);

  try {
    const failedQueries = db.prepare(
      "SELECT query, blocks_scored, blocks_returned FROM recall_log WHERE blocks_returned = 0 AND created_at > datetime('now', '-7 days') GROUP BY query ORDER BY COUNT(*) DESC LIMIT 5"
    ).all() as { query: string; blocks_scored: number; blocks_returned: number }[];

    for (const q of failedQueries) {
      if (TEST_QUERIES.has(q.query.toLowerCase().trim())) continue;
      insights.push({
        type: 'gap',
        title: `Knowledge gap: "${q.query}"`,
        description: `Query "${q.query}" returned 0 results (${q.blocks_scored} blocks scored). This topic may need attention.`,
        confidence: 0.7,
        blocks: [],
      });
      gapsDetected++;
    }
  } catch { /* recall_log may not exist in all configs */ }

  // High void fraction queries — knows something but not confident
  try {
    const highVoid = db.prepare(
      "SELECT query, AVG(void_fraction) as vf, COUNT(*) as c FROM recall_log WHERE void_fraction > 0.6 AND created_at > datetime('now', '-7 days') GROUP BY query HAVING c >= 2 ORDER BY vf DESC LIMIT 3"
    ).all() as { query: string; vf: number; c: number }[];

    for (const q of highVoid) {
      insights.push({
        type: 'gap',
        title: `Noisy topic: "${q.query}"`,
        description: `Query "${q.query}" has ${(q.vf * 100).toFixed(0)}% void fraction across ${q.c} recalls. Memory is cluttered or contradictory here.`,
        confidence: 0.6,
        blocks: [],
      });
      gapsDetected++;
    }
  } catch {}

  // ── Phase 5: Pattern Discovery ──
  // Find keywords that appear across many blocks — recurring themes
  let patternsFound = 0;
  const keywordFreq = new Map<string, { count: number; blocks: number[] }>();

  for (const b of activeBlocks.slice(0, 500)) {
    const tokens = tokenize(b.keywords);
    for (const t of tokens) {
      if (!keywordFreq.has(t)) keywordFreq.set(t, { count: 0, blocks: [] });
      const entry = keywordFreq.get(t)!;
      entry.count++;
      if (entry.blocks.length < 5) entry.blocks.push(b.id);
    }
  }

  const patterns = [...keywordFreq.entries()]
    .filter(([_, v]) => v.count >= 5)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  for (const [kw, info] of patterns) {
    insights.push({
      type: 'pattern',
      title: `Recurring theme: "${kw}"`,
      description: `"${kw}" appears in ${info.count} active blocks. This is a core concept in your memory.`,
      confidence: Math.min(info.count / 20, 1),
      blocks: info.blocks,
    });
    patternsFound++;
  }

  // ── Phase 6: Forgotten Surfacing ──
  // Find voided blocks with high access counts — maybe they shouldn't be void
  let forgottenSurfaced = 0;

  const forgottenBlocks = db.prepare(
    'SELECT id, content, keywords, access_count FROM blocks WHERE state = 0 AND access_count >= 2 ORDER BY access_count DESC LIMIT 5'
  ).all() as BlockRow[];

  for (const b of forgottenBlocks) {
    insights.push({
      type: 'forgotten',
      title: `Buried memory #${b.id}`,
      description: `Block #${b.id} is voided but was accessed ${b.access_count} times: "${b.content.slice(0, 100)}..."`,
      confidence: Math.min(b.access_count / 10, 0.9),
      blocks: [b.id],
    });
    forgottenSurfaced++;
  }

  // ── Phase 7: Contradiction Detection ──
  // Find blocks that might contradict each other (same keywords, different content)
  const byKeywordGroup = new Map<string, BlockRow[]>();
  for (const b of activeBlocks.slice(0, 300)) {
    const key = tokenize(b.keywords).sort().slice(0, 3).join('|');
    if (key.length < 3) continue;
    if (!byKeywordGroup.has(key)) byKeywordGroup.set(key, []);
    byKeywordGroup.get(key)!.push(b);
  }

  for (const [key, group] of byKeywordGroup) {
    if (group.length < 2) continue;
    // Check if content differs significantly
    for (let i = 0; i < group.length && i < 3; i++) {
      for (let j = i + 1; j < group.length && j < 3; j++) {
        const tokA = tokenize(group[i].content.slice(0, 200));
        const tokB = tokenize(group[j].content.slice(0, 200));
        const overlap = keywordOverlap(tokA, tokB);
        if (overlap < 0.3) {
          insights.push({
            type: 'contradiction',
            title: `Possible conflict on "${key.replace(/\|/g, ', ')}"`,
            description: `Blocks #${group[i].id} and #${group[j].id} share keywords but only ${(overlap * 100).toFixed(0)}% content overlap. May need reconciliation.`,
            confidence: 1 - overlap,
            blocks: [group[i].id, group[j].id],
          });
          break;
        }
      }
    }
  }

  // ── Morning Briefing ──
  const duration = Date.now() - start;

  const briefingParts: string[] = [];
  briefingParts.push(`Dream cycle complete in ${duration}ms.`);
  briefingParts.push(`Memory: ${activeCount} active, ${voidCount} void, ${inhibitoryCount} inhibitory.`);

  if (decayed > 0) briefingParts.push(`Decayed ${decayed} stale blocks.`);
  if (merged > 0) briefingParts.push(`Merged ${merged} duplicates.`);
  if (confirmed > 0) briefingParts.push(`Confirmed ${confirmed} frequently-accessed blocks.`);
  if (connectionsDiscovered > 0) briefingParts.push(`Found ${connectionsDiscovered} cross-domain connections.`);
  if (gapsDetected > 0) briefingParts.push(`Detected ${gapsDetected} knowledge gaps.`);
  if (patternsFound > 0) briefingParts.push(`Identified ${patternsFound} recurring patterns.`);
  if (forgottenSurfaced > 0) briefingParts.push(`Surfaced ${forgottenSurfaced} buried memories.`);

  const deadPct = totalBlocks > 0 ? Math.round((neverAccessed / totalBlocks) * 100) : 0;
  if (deadPct > 30) briefingParts.push(`Warning: ${deadPct}% of blocks have never been accessed.`);

  return {
    timestamp: new Date().toISOString(),
    duration_ms: duration,
    morning_briefing: briefingParts.join(' '),
    insights,
    consolidations: {
      merged,
      inhibited,
      decayed,
      confirmed,
      total: merged + inhibited + decayed + confirmed,
      connections_discovered: connectionsDiscovered,
      gaps_detected: gapsDetected,
      forgotten_surfaced: forgottenSurfaced,
      patterns_found: patternsFound,
    },
    memory_health: {
      total_blocks: totalBlocks,
      active: activeCount,
      void_count: voidCount,
      inhibitory: inhibitoryCount,
      never_accessed: neverAccessed,
      dead_weight_pct: deadPct,
      avg_age_days: Math.round(avgAge * 10) / 10,
      top_categories: topCats.map(c => ({ category: c.category, count: c.c })),
      top_projects: topProjects,
    },
  };
}

export function storeDreamInsights(db: Database.Database, report: DreamReport): number {
  let stored = 0;
  const topInsights = report.insights
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);

  for (const insight of topInsights) {
    if (insight.confidence < 0.3) continue;

    db.prepare(
      "INSERT INTO blocks (content, category, keywords, state, confidence, created_at) VALUES (?, 'dream-insight', ?, 1, 'stored', CURRENT_TIMESTAMP)"
    ).run(
      `[Dream ${insight.type}] ${insight.title}: ${insight.description}`,
      insight.type
    );
    stored++;
  }

  return stored;
}
