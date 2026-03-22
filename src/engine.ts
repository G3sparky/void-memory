/**
 * Void Memory — Core Engine
 * Three-pass recall: keyword scoring → void marking → budget fit
 * Target: <200ms, no LLM dependency
 */

import type Database from 'better-sqlite3';
import type { Block } from './db.js';
import { detectTemporalQuery, temporalBoost, indexBlockDates } from "./temporal-index.js";
import { checkNewBlockContradiction } from "./contradiction-detector.js";

// ── Types ──

export interface RecallResult {
  blocks: ScoredBlock[];
  void_zones: string[];        // topic clusters that were voided
  void_zone_counts: Map<string, number>;  // per-zone block counts
  void_fraction: number;       // actual void fraction achieved
  budget_used: number;         // tokens consumed
  budget_max: number;          // tokens available
  blocks_scored: number;       // total candidates considered
  blocks_voided: number;       // candidates void-marked
  duration_ms: number;
}

export interface ScoredBlock {
  id: number;
  content: string;
  category: string;
  keywords: string;
  confidence: string;
  score: number;
  state: number;  // 1=active, -1=inhibitory (only active returned to caller)
}

interface Candidate extends Block {
  score: number;
  topic_cluster: string;
  voided: boolean;
  inhibited_by: number | null;
  tokens: number;
}

// ── Constants ──

const CHARS_PER_TOKEN = 4;
const DEFAULT_BUDGET = 4000;   // tokens — 2% of 200K context
const MAX_BUDGET = 10000;      // tokens — 5% cap
const VOID_TARGET = 0.30;      // 30% void fraction target from PNN research
const MAX_CANDIDATES = 100;    // score at most this many

// ── TF-IDF helpers ──

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function computeIDF(blocks: Block[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  const N = blocks.length || 1;

  for (const b of blocks) {
    const words = new Set(tokenize(b.content + ' ' + b.keywords));
    for (const w of words) {
      docFreq.set(w, (docFreq.get(w) || 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [word, df] of docFreq) {
    idf.set(word, Math.log(N / df));
  }
  return idf;
}

function scoreBlock(block: Block, queryTokens: string[], idf: Map<string, number>): number {
  const blockTokens = new Set(tokenize(block.content + ' ' + block.keywords));
  let score = 0;

  for (const qt of queryTokens) {
    if (blockTokens.has(qt)) {
      score += idf.get(qt) || 1;
    }
    // Partial match bonus for keyword field (exact keyword match is stronger)
    const keywords = block.keywords.toLowerCase().split(',').map(k => k.trim());
    if (keywords.includes(qt)) {
      score += (idf.get(qt) || 1) * 1.5; // keyword exact match bonus
    }
  }

  // Confidence multiplier
  const confMultiplier: Record<string, number> = {
    confirmed: 1.3,
    accessed: 1.1,
    stored: 1.0,
    observed: 0.7,
  };
  score *= confMultiplier[block.confidence] || 1.0;

  // Recency boost (accessed in last 7 days)
  if (block.accessed_at) {
    const daysSince = (Date.now() - new Date(block.accessed_at).getTime()) / 86400000;
    if (daysSince < 1) score *= 1.3;
    else if (daysSince < 7) score *= 1.15;
  }

  return score;
}

// ── Topic clustering (multi-keyword Jaccard similarity) ──

function getKeywordSet(block: Block): Set<string> {
  return new Set(
    block.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const k of a) if (b.has(k)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Cluster blocks by keyword similarity using single-linkage clustering.
 * Two blocks join the same cluster if they share >= CLUSTER_THRESHOLD keyword overlap.
 * Returns cluster label (representative keyword set) for each block.
 */
const CLUSTER_THRESHOLD = 0.25; // 25% Jaccard overlap = same topic

function clusterBlocks(blocks: Array<{ id: number; keywords: string; category: string }>): Map<number, string> {
  const labels = new Map<number, string>();
  const clusters: Array<{ label: string; members: number[]; keywords: Set<string> }> = [];

  for (const b of blocks) {
    const bKeys = getKeywordSet(b as Block);
    let bestCluster: typeof clusters[0] | null = null;
    let bestSim = 0;

    for (const c of clusters) {
      const sim = jaccardSimilarity(bKeys, c.keywords);
      if (sim > bestSim && sim >= CLUSTER_THRESHOLD) {
        bestSim = sim;
        bestCluster = c;
      }
    }

    if (bestCluster) {
      bestCluster.members.push(b.id);
      // Merge keywords into cluster
      for (const k of bKeys) bestCluster.keywords.add(k);
    } else {
      // New cluster — label is the first keyword or category
      const kws = b.keywords.split(',').map(k => k.trim()).filter(Boolean);
      const label = kws[0] || b.category;
      clusters.push({ label, members: [b.id], keywords: bKeys });
    }
  }

  // Assign labels
  for (const c of clusters) {
    for (const id of c.members) {
      labels.set(id, c.label);
    }
  }

  return labels;
}

// ── Score gap detection ──

/**
 * Find the largest relative score drop in a sorted (descending) candidate list.
 * Returns the index AFTER which blocks should be considered for voiding.
 * Only triggers if gap is > 40% relative drop.
 */
function findScoreGap(scores: number[]): number | null {
  if (scores.length < 4) return null; // too few to detect gaps

  let maxDrop = 0;
  let gapIdx = -1;

  for (let i = 1; i < scores.length; i++) {
    if (scores[i - 1] === 0) continue;
    const drop = (scores[i - 1] - scores[i]) / scores[i - 1];
    if (drop > maxDrop && drop > 0.4) { // 40% relative drop
      maxDrop = drop;
      gapIdx = i;
    }
  }

  return gapIdx > 0 ? gapIdx : null;
}

// ── Core engine ──

export async function recall(db: Database.Database, query: string, budgetTokens?: number): Promise<RecallResult> {
  const start = performance.now();
  const budget = Math.min(budgetTokens || DEFAULT_BUDGET, MAX_BUDGET);

  // Load eligible blocks (state >= 0, confidence not 'observed')
  const allBlocks = db.prepare(`
    SELECT * FROM blocks
    WHERE state >= 0 AND confidence != 'observed'
    ORDER BY access_count DESC
  `).all() as Block[];

  // Load inhibitions
  const inhibitions = db.prepare(`
    SELECT blocker_id, blocked_id FROM inhibitions
    WHERE blocker_id IN (SELECT id FROM blocks WHERE state = -1)
  `).all() as Array<{ blocker_id: number; blocked_id: number }>;

  const inhibitedSet = new Map<number, number>(); // blocked_id → blocker_id
  for (const inh of inhibitions) {
    inhibitedSet.set(inh.blocked_id, inh.blocker_id);
  }

  // ── Pre-pass: Structured metadata lookup for numeric queries ──
  // Embeddings are bad at numbers. Exact-match lookup for ports, CTs, IPs, percentages.
  const metadataBoosts = new Map<number, number>();
  try {
    const { readFileSync, existsSync } = await import('fs');
    const metaPath = '/opt/void-memory/data/tasm-metadata-index.json';
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      // Extract numbers from query
      const queryNumbers = query.match(/\d+\.?\d*/g) || [];
      // Also extract entity keywords that suggest numeric lookup
      const numericHints = query.match(/\b(port|ct|container|ip|version|percent|accuracy)\b/gi) || [];

      for (const num of queryNumbers) {
        // Check each category
        for (const [category, entries] of Object.entries(meta)) {
          if (typeof entries === 'object' && entries !== null) {
            const blockIds = (entries as Record<string, number[]>)[num];
            if (blockIds && Array.isArray(blockIds)) {
              for (const id of blockIds.slice(0, 10)) {
                metadataBoosts.set(id, (metadataBoosts.get(id) || 0) + 25); // Strong boost
              }
            }
          }
        }
      }
      // If query mentions "port" or "container" without a number, still boost blocks containing ports/CTs
      if (numericHints.length > 0 && queryNumbers.length === 0) {
        for (const hint of numericHints) {
          const cat = hint.toLowerCase().startsWith('port') ? 'ports' :
                      hint.toLowerCase().startsWith('ct') || hint.toLowerCase().startsWith('container') ? 'cts' : null;
          if (cat && meta[cat]) {
            // Boost all blocks that have any port/CT data
            for (const [, blockIds] of Object.entries(meta[cat] as Record<string, number[]>)) {
              if (Array.isArray(blockIds)) {
                for (const id of blockIds.slice(0, 5)) {
                  metadataBoosts.set(id, (metadataBoosts.get(id) || 0) + 15);
                }
              }
            }
          }
        }
      }

      // Service name matching: "where does Ollama run" → boost Ollama blocks
      if (meta.services) {
        const queryLower = query.toLowerCase();
        for (const [service, blockIds] of Object.entries(meta.services as Record<string, number[]>)) {
          const serviceName = service.replace(/-/g, ' ');
          if (queryLower.includes(serviceName) || queryLower.includes(service)) {
            if (Array.isArray(blockIds)) {
              for (const id of blockIds.slice(0, 10)) {
                metadataBoosts.set(id, (metadataBoosts.get(id) || 0) + 20);
              }
            }
          }
        }
      }
    }
  } catch (e) { console.error('[META] metadata index error:', e); }
  if (metadataBoosts.size > 0) console.log('[META] boosts applied:', Object.fromEntries(metadataBoosts));

  // ── Pass 1: Score all blocks (with synonym + co-occurrence expansion) ──
  const rawTokens = tokenize(query);
  const synExpanded = expandWithSynonyms(rawTokens);
  const queryTokens = expandWithCooccurrence(synExpanded, allBlocks, 3);
  const idf = computeIDF(allBlocks);

  let candidates: Candidate[] = allBlocks.map(b => ({
    ...b,
    score: scoreBlock(b, queryTokens, idf),
    topic_cluster: b.keywords.split(',')[0]?.trim() || b.category,
    voided: false,
    inhibited_by: inhibitedSet.get(b.id) || null,
    tokens: Math.ceil(b.content.length / CHARS_PER_TOKEN),
  }));

  // Apply metadata boosts (for numeric queries)
  if (metadataBoosts.size > 0) {
    for (const c of candidates) {
      const boost = metadataBoosts.get(c.id);
      if (boost) c.score += boost;
    }
  }

  // ── Semantic boost (E1) — add cosine similarity scores from embedding index ──
  try {
    const { semanticSearch: semSearch } = await import('./semantic.js');
    const semanticResults = await semSearch(query);
    if (semanticResults.length > 0) {
      const semanticMap = new Map(semanticResults.map(r => [r.block_id, r.cosine_score]));
      for (const c of candidates) {
        const cosScore = semanticMap.get(c.id);
        if (cosScore && cosScore > 0.6) {
          // High semantic relevance — boost keyword score
          c.score += cosScore * 20;
        } else if (cosScore && cosScore > 0.3) {
          // Moderate semantic relevance — small boost
          c.score += cosScore * 10;
        } else if (cosScore !== undefined && cosScore < 0.3 && !metadataBoosts.has(c.id)) {
          // RELEVANCE GATE: keyword matched but semantically irrelevant
          // Penalise to prevent false positives (e.g. "production" matching
          // TASM crash history when query is about Kubernetes)
          // Skip penalty for metadata-boosted blocks (exact entity matches)
          c.score *= 0.5;
        }
        // If no semantic score at all (block not in index), keep keyword score as-is
      }
      // Also add blocks that semantic found but keyword missed (semantic-only retrieval)
      for (const sr of semanticResults) {
        if (sr.cosine_score > 0.5 && !candidates.find(c => c.id === sr.block_id)) {
          const block = allBlocks.find(b => b.id === sr.block_id);
          if (block && !inhibitedSet.has(block.id)) {
            candidates.push({
              ...block,
              score: sr.cosine_score * 20,
              topic_cluster: block.keywords.split(',')[0]?.trim() || block.category,
              voided: false,
              inhibited_by: null,
              tokens: Math.ceil(block.content.length / CHARS_PER_TOKEN),
            });
          }
        }
      }
    }
  } catch { /* Semantic search unavailable — keyword-only fallback */ }

  // Remove zero-score candidates and inhibited blocks
  candidates = candidates
    .filter(c => c.score > 0 && !c.inhibited_by)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  const totalScored = candidates.length;

    // ── Temporal boost (E2) — DISABLED pending calibration ──
  // Index is built and available but boost not applied until combined with E1 semantic scoring.
  // To re-enable: uncomment and tune multipliers in temporal-index.ts

  // ── Pass 2: Void marking (Phase 2 algorithm) ──
  // Minimum 6 candidates before void marking activates
  // Below that, every result is likely relevant — voiding would hurt more than help
  const MIN_VOID_CANDIDATES = 6;
  const voidedZones: string[] = [];
  const voidZoneCounts = new Map<string, number>();
  let voidCount = 0;

  if (totalScored >= MIN_VOID_CANDIDATES) {
    // Step 1: Cluster blocks by multi-keyword Jaccard similarity
    const clusterLabels = clusterBlocks(candidates);
    for (const c of candidates) {
      c.topic_cluster = clusterLabels.get(c.id) || c.topic_cluster;
    }

    // Step 2: Score gap detection — find natural boundary between relevant and tangential
    const scores = candidates.map(c => c.score);
    const gapIdx = findScoreGap(scores);

    // Step 3: Identify primary cluster (highest total score)
    const clusterTotalScores = new Map<string, number>();
    for (const c of candidates) {
      clusterTotalScores.set(c.topic_cluster, (clusterTotalScores.get(c.topic_cluster) || 0) + c.score);
    }
    const rankedClusters = [...clusterTotalScores.entries()].sort((a, b) => b[1] - a[1]);
    const primaryCluster = rankedClusters[0]?.[0] || '';
    // Protect top 2 clusters (or top 1 if only 2 clusters)
    const protectedCount = Math.min(2, Math.ceil(rankedClusters.length * 0.4));
    const protectedClusters = new Set(rankedClusters.slice(0, protectedCount).map(([c]) => c));

    const targetVoidCount = Math.floor(candidates.length * VOID_TARGET);

    // Strategy A: Void blocks below score gap (if detected)
    if (gapIdx !== null) {
      for (let i = gapIdx; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c.voided && !protectedClusters.has(c.topic_cluster) && !metadataBoosts.has(c.id)) {
          c.voided = true;
          voidCount++;
          voidZoneCounts.set(c.topic_cluster, (voidZoneCounts.get(c.topic_cluster) || 0) + 1);
          if (!voidedZones.includes(c.topic_cluster)) voidedZones.push(c.topic_cluster);
        }
      }
    }

    // Strategy B: Void lowest-scoring off-topic clusters (fill toward 30% target)
    if (voidCount < targetVoidCount) {
      for (const [cluster] of [...rankedClusters].reverse()) {
        if (voidCount >= targetVoidCount) break;
        if (protectedClusters.has(cluster)) continue;

        for (const c of candidates) {
          if (c.topic_cluster === cluster && !c.voided && !metadataBoosts.has(c.id)) {
            c.voided = true;
            voidCount++;
            voidZoneCounts.set(cluster, (voidZoneCounts.get(cluster) || 0) + 1);
          }
        }
        if (!voidedZones.includes(cluster)) voidedZones.push(cluster);
      }
    }

    // Strategy C: Void lowest-scoring individuals from non-primary clusters
    if (voidCount < targetVoidCount) {
      const remaining = candidates
        .filter(c => !c.voided && c.topic_cluster !== primaryCluster && !metadataBoosts.has(c.id))
        .sort((a, b) => a.score - b.score);

      for (const c of remaining) {
        if (voidCount >= targetVoidCount) break;
        c.voided = true;
        voidCount++;
        voidZoneCounts.set(c.topic_cluster, (voidZoneCounts.get(c.topic_cluster) || 0) + 1);
        if (!voidedZones.includes(c.topic_cluster)) voidedZones.push(c.topic_cluster);
      }
    }

    // Hub dampening: relative threshold (top 5% by access count, min 50 accesses)
    const accessCounts = candidates.filter(c => !c.voided).map(c => c.access_count).sort((a, b) => b - a);
    const hubThreshold = Math.max(50, accessCounts[Math.floor(accessCounts.length * 0.05)] || 50);
    const topIds = new Set(candidates.filter(c => !c.voided).slice(0, 3).map(c => c.id));

    for (const c of candidates) {
      if (!c.voided && c.access_count > hubThreshold && !topIds.has(c.id)) {
        c.voided = true;
        voidCount++;
        voidZoneCounts.set(c.topic_cluster, (voidZoneCounts.get(c.topic_cluster) || 0) + 1);
      }
    }
  }

  // ── Pass 3: Budget fit + relevance threshold ──
  // Minimum score to be included in results. Blocks below this are considered
  // irrelevant — the system should abstain rather than return noise.
  // Calibrated: median score on random queries is ~5-8. Real queries score 15+.
  // Calibrated: random queries score 5-15, real queries score 20+.
  // Set to 15 to filter noise while keeping genuine matches.
  const MIN_RELEVANCE_SCORE = 15.0;

  const active = candidates
    .filter(c => !c.voided && c.score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.score - a.score);

  const result: ScoredBlock[] = [];
  let tokensUsed = 0;

  for (const c of active) {
    if (tokensUsed + c.tokens > budget) continue; // skip, don't truncate
    tokensUsed += c.tokens;
    result.push({
      id: c.id,
      content: c.content,
      category: c.category,
      keywords: c.keywords,
      confidence: c.confidence,
      score: Math.round(c.score * 100) / 100,
      state: c.state,
    });
  }

  // Update access counts and timestamps
  const updateAccess = db.prepare(`
    UPDATE blocks SET access_count = access_count + 1, accessed_at = datetime('now'),
    confidence = CASE
      WHEN confidence = 'stored' THEN 'accessed'
      WHEN confidence = 'accessed' AND access_count >= 2 THEN 'confirmed'
      ELSE confidence
    END
    WHERE id = ?
  `);

  const updateMany = db.transaction((ids: number[]) => {
    for (const id of ids) updateAccess.run(id);
  });
  updateMany(result.map(b => b.id));

  const voidFraction = totalScored > 0 ? voidCount / totalScored : 0;
  const duration = performance.now() - start;

  // Log recall
  db.prepare(`
    INSERT INTO recall_log (query, blocks_scored, blocks_returned, blocks_voided, void_fraction, budget_tokens, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(query, totalScored, result.length, voidCount, voidFraction, budget, duration);

  return {
    blocks: result,
    void_zones: voidedZones,
    void_zone_counts: voidZoneCounts,
    void_fraction: Math.round(voidFraction * 100) / 100,
    budget_used: tokensUsed,
    budget_max: budget,
    blocks_scored: totalScored,
    blocks_voided: voidCount,
    duration_ms: Math.round(duration * 10) / 10,
  };
}

// ── Store ──

export interface StoreOpts {
  content: string;
  category?: string;
  keywords?: string[];
  state?: number;          // default 1 (active)
  confidence?: string;     // default 'stored'
  supersedes?: number;     // id of block this replaces
}

export function store(db: Database.Database, opts: StoreOpts): { id: number; deduped: boolean } {
  const { content, category = 'fact', keywords = [], state = 1, confidence = 'stored', supersedes } = opts;
  const keywordStr = keywords.map(k => k.toLowerCase().trim()).join(', ');

  // Quality gate
  if (content.length < 20) throw new Error('Content too short (min 20 chars)');
  const alphaRatio = (content.match(/[a-zA-Z]/g) || []).length / content.length;
  if (alphaRatio < 0.3) throw new Error('Content must be at least 30% alphabetic');

  // Dedup check: keyword overlap
  const existing = db.prepare(`
    SELECT id, keywords, content FROM blocks WHERE state >= 0
  `).all() as Block[];

  const newKeywords = new Set(keywords.map(k => k.toLowerCase()));
  for (const ex of existing) {
    const exKeywords = new Set(ex.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean));
    if (exKeywords.size === 0 || newKeywords.size === 0) continue;

    const overlap = [...newKeywords].filter(k => exKeywords.has(k)).length;
    const overlapRatio = overlap / Math.max(newKeywords.size, exKeywords.size);

    if (overlapRatio > 0.8) {
      // Update existing block instead of duplicating
      db.prepare(`UPDATE blocks SET content = ?, keywords = ?, accessed_at = datetime('now') WHERE id = ?`)
        .run(content, keywordStr, ex.id);
      return { id: ex.id, deduped: true };
    }
  }


  // E3: Auto-contradiction detection
  // If new block contradicts an existing one, auto-supersede the older block
  const contradiction = checkNewBlockContradiction(db, content, keywordStr, category);
  const autoSupersedes = contradiction.supersedes || supersedes;
  // Insert the new block first
  const result = db.prepare(`
    INSERT INTO blocks (content, category, keywords, state, confidence)
    VALUES (?, ?, ?, ?, ?)
  `).run(content, category, keywordStr, state, confidence);

  const newId = result.lastInsertRowid as number;

  // Index temporal events (E2)
  indexBlockDates(db, newId as number, content, keywordStr);

  // Handle supersession after insert (so we have a valid blocker_id)
  if (autoSupersedes) {
    db.prepare(`UPDATE blocks SET state = -1 WHERE id = ?`).run(autoSupersedes);
    db.prepare(`INSERT INTO inhibitions (blocker_id, blocked_id, reason) VALUES (?, ?, 'superseded')`)
      .run(newId, autoSupersedes);
  }

  return { id: newId, deduped: false };
}

// ── Stats ──

export interface MemoryStats {
  total_blocks: number;
  active: number;
  void: number;
  inhibitory: number;
  by_confidence: Record<string, number>;
  by_category: Record<string, number>;
  avg_block_tokens: number;
  total_recalls: number;
  avg_recall_ms: number;
  avg_void_fraction: number;
  dead_weight_pct: number;  // blocks never accessed
}

export function stats(db: Database.Database): MemoryStats {
  const total = (db.prepare(`SELECT COUNT(*) as c FROM blocks`).get() as any).c;
  const active = (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state = 1`).get() as any).c;
  const voidCount = (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state = 0`).get() as any).c;
  const inhibitory = (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state = -1`).get() as any).c;

  const confRows = db.prepare(`SELECT confidence, COUNT(*) as c FROM blocks WHERE state >= 0 GROUP BY confidence`).all() as any[];
  const by_confidence: Record<string, number> = {};
  for (const r of confRows) by_confidence[r.confidence] = r.c;

  const catRows = db.prepare(`SELECT category, COUNT(*) as c FROM blocks WHERE state >= 0 GROUP BY category`).all() as any[];
  const by_category: Record<string, number> = {};
  for (const r of catRows) by_category[r.category] = r.c;

  const avgLen = (db.prepare(`SELECT AVG(LENGTH(content)) as a FROM blocks WHERE state >= 0`).get() as any).a || 0;

  const recallStats = db.prepare(`SELECT COUNT(*) as c, AVG(duration_ms) as avg_ms, AVG(void_fraction) as avg_vf FROM recall_log`).get() as any;

  const neverAccessed = (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state >= 0 AND access_count = 0`).get() as any).c;
  const activeTotal = active + voidCount;

  return {
    total_blocks: total,
    active,
    void: voidCount,
    inhibitory,
    by_confidence,
    by_category,
    avg_block_tokens: Math.round(avgLen / CHARS_PER_TOKEN),
    total_recalls: recallStats.c || 0,
    avg_recall_ms: Math.round((recallStats.avg_ms || 0) * 10) / 10,
    avg_void_fraction: Math.round((recallStats.avg_vf || 0) * 100) / 100,
    dead_weight_pct: activeTotal > 0 ? Math.round((neverAccessed / activeTotal) * 100) : 0,
  };
}

// ── Void Zones (explain what's being suppressed) ──

export async function voidZones(db: Database.Database, query: string): Promise<{ zones: Array<{ topic: string; block_count: number; reason: string }>; total_voided: number; void_fraction: number }> {
  const result = await recall(db, query);
  return {
    zones: result.void_zones.map(z => ({
      topic: z,
      block_count: result.void_zone_counts.get(z) || 0,
      reason: 'Off-topic for current query — suppressed to prevent interference',
    })),
    total_voided: result.blocks_voided,
    void_fraction: result.void_fraction,
  };
}

// ── Synonym Expansion (improves semantic retrieval) ──

const SYNONYMS: Record<string, string[]> = {
  // Common project terms
  deploy: ['ship', 'release', 'launch', 'push', 'publish'],
  fix: ['repair', 'patch', 'resolve', 'correct', 'debug'],
  build: ['create', 'make', 'construct', 'develop', 'implement'],
  error: ['bug', 'issue', 'problem', 'failure', 'crash'],
  config: ['configuration', 'settings', 'setup', 'preferences'],
  test: ['verify', 'check', 'validate', 'benchmark', 'assess'],
  memory: ['recall', 'remember', 'store', 'block', 'knowledge'],
  agent: ['tron', 'arch', 'flynn', 'bot', 'assistant'],
  update: ['change', 'modify', 'edit', 'revise', 'upgrade'],
  delete: ['remove', 'drop', 'clear', 'purge', 'archive'],
  start: ['begin', 'launch', 'init', 'boot', 'activate'],
  stop: ['halt', 'kill', 'shutdown', 'disable', 'pause'],
  fast: ['quick', 'speed', 'performance', 'latency', 'efficient'],
  broken: ['failed', 'down', 'crashed', 'dead', 'offline'],
  working: ['running', 'active', 'alive', 'online', 'operational'],
};

// Build reverse map
const SYNONYM_MAP = new Map<string, Set<string>>();
for (const [key, syns] of Object.entries(SYNONYMS)) {
  if (!SYNONYM_MAP.has(key)) SYNONYM_MAP.set(key, new Set());
  for (const s of syns) {
    SYNONYM_MAP.get(key)!.add(s);
    if (!SYNONYM_MAP.has(s)) SYNONYM_MAP.set(s, new Set());
    SYNONYM_MAP.get(s)!.add(key);
    // Also link synonyms to each other
    for (const s2 of syns) {
      if (s !== s2) SYNONYM_MAP.get(s)!.add(s2);
    }
  }
}

export function expandWithSynonyms(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const syns = SYNONYM_MAP.get(t);
    if (syns) {
      for (const s of syns) expanded.add(s);
    }
  }
  return [...expanded];
}

// ── Co-occurrence Query Expander (the "translator at the front desk") ──
// Learns from existing blocks: if "neogate" and "port" frequently co-occur,
// querying "neogate" should also boost blocks containing "port".
// This is lightweight — no embeddings, just keyword co-occurrence stats.

export function expandWithCooccurrence(
  tokens: string[],
  blocks: Array<{ keywords: string }>,
  maxExpansions = 3
): string[] {
  // Build co-occurrence matrix from block keywords
  const cooccur = new Map<string, Map<string, number>>();

  for (const block of blocks) {
    const kws = block.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    for (let i = 0; i < kws.length; i++) {
      for (let j = i + 1; j < kws.length; j++) {
        const a = kws[i], b = kws[j];
        if (!cooccur.has(a)) cooccur.set(a, new Map());
        if (!cooccur.has(b)) cooccur.set(b, new Map());
        cooccur.get(a)!.set(b, (cooccur.get(a)!.get(b) || 0) + 1);
        cooccur.get(b)!.set(a, (cooccur.get(b)!.get(a) || 0) + 1);
      }
    }
  }

  // For each query token, find top co-occurring keywords
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const pairs = cooccur.get(t);
    if (!pairs) continue;
    // Sort by co-occurrence count, take top N
    const sorted = [...pairs.entries()]
      .filter(([word]) => !expanded.has(word)) // don't add duplicates
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxExpansions);
    for (const [word, count] of sorted) {
      if (count >= 3) { // minimum 3 co-occurrences to be meaningful
        expanded.add(word);
      }
    }
  }

  return [...expanded];
}
