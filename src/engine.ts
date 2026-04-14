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

export type RecallMode = 'particle' | 'wave';

export interface RecallResult {
  blocks: ScoredBlock[];
  void_zones: string[];        // topic clusters that were voided
  void_zone_counts: Map<string, number>;  // per-zone block counts
  void_fraction: number;       // actual void fraction achieved
  budget_used: number;         // tokens consumed
  budget_max: number;          // tokens available
  blocks_scored: number;       // total candidates considered
  blocks_voided: number;       // candidates void-marked
  coverage_ratio: number;      // query term coverage (0-1) — Gavin's Retrieval Wheel
  confidence_class: 'verified' | 'inferred' | 'contested' | 'absent'; // self-test classification
  duration_ms: number;
  mode: RecallMode;            // which mode was used
  clusters?: RecallCluster[];  // wave mode: grouped results by topic
}

export interface RecallCluster {
  theme: string;
  score: number;
  blocks: ScoredBlock[];
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

// Month abbreviation → full mapping for temporal queries
const MONTH_EXPAND: Record<string, string> = {
  jan: 'january', feb: 'february', mar: 'march', apr: 'april',
  may: 'may', jun: 'june', jul: 'july', aug: 'august',
  sep: 'september', oct: 'october', nov: 'november', dec: 'december',
};

function tokenize(text: string): string[] {
  const tokens = text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Expand month abbreviations so "Feb" matches "February" and vice versa
  const expanded: string[] = [];
  for (const t of tokens) {
    expanded.push(t);
    const full = MONTH_EXPAND[t];
    if (full) expanded.push(full);
    // Reverse: "february" → also add "feb"
    for (const [abbr, fullMonth] of Object.entries(MONTH_EXPAND)) {
      if (t === fullMonth && !expanded.includes(abbr)) expanded.push(abbr);
    }
  }
  return expanded;
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

function scoreBlock(block: Block, queryTokens: string[], idf: Map<string, number>, originalTokens?: Set<string>): number {
  const blockTokens = new Set(tokenize(block.content + ' ' + block.keywords));
  const keywords = block.keywords.toLowerCase().split(',').map(k => k.trim());
  let rawScore = 0;
  let keywordHits = 0;

  for (const qt of queryTokens) {
    // Expanded terms (from synonyms/co-occurrence) score at 30% weight
    const isOriginal = !originalTokens || originalTokens.has(qt);
    const expansionWeight = isOriginal ? 1.0 : 0.3;

    if (blockTokens.has(qt)) {
      rawScore += (idf.get(qt) || 1) * expansionWeight;
    }
    // Keyword field match is stronger signal (curated metadata)
    if (keywords.includes(qt)) {
      rawScore += (idf.get(qt) || 1) * 1.5 * expansionWeight;
      if (isOriginal) keywordHits++;
    }
  }

  // Length normalization: short factual blocks should not be penalized vs long blocks.
  // A 50-char block matching 3/4 query terms is MORE relevant than a 500-char block
  // matching the same 3/4 because the short block is more focused.
  // Normalize: score per token, then scale by sqrt(tokens) to softly reward length.
  // This prevents long blocks from drowning short ones through sheer token count.
  const blockTokenCount = Math.max(tokenize(block.content).length, 1);
  const densityScore = rawScore / Math.sqrt(blockTokenCount);
  // Blend: 60% density-normalized + 40% raw (keeps some absolute-score signal)
  let score = densityScore * 0.6 + rawScore * 0.4;

  // Keyword density bonus: if most query terms matched keywords, this block is highly targeted
  if (queryTokens.length > 0 && keywordHits >= queryTokens.length * 0.5) {
    score *= 1.3;
  }

  // Confidence multiplier
  const confMultiplier: Record<string, number> = {
    confirmed: 1.3,
    accessed: 1.1,
    stored: 1.0,
    observed: 0.7,
  };
  score *= confMultiplier[block.confidence] || 1.0;

  // ACT-R Base-Level Activation (replaces crude recency boost)
  // B_i = ln(n) + ln(sum(t_j^-d)) where:
  //   n = access_count (frequency), t_j = time since last access (recency), d = decay rate
  // Core traits (accessed thousands of times) persist forever.
  // Recent moods spike then fade. This models real human memory.
  const DECAY_RATE = 0.5; // Standard cognitive science value
  const n = Math.max(block.access_count, 1);
  const freqComponent = Math.log(n);

  let recencyComponent = 0;
  if (block.accessed_at) {
    const hoursSince = Math.max((Date.now() - new Date(block.accessed_at).getTime()) / 3600000, 0.1);
    recencyComponent = Math.pow(hoursSince, -DECAY_RATE);
  } else if (block.created_at) {
    const hoursSince = Math.max((Date.now() - new Date(block.created_at).getTime()) / 3600000, 0.1);
    recencyComponent = Math.pow(hoursSince, -DECAY_RATE) * 0.5; // Never-accessed penalty
  }

  // Activation ranges roughly -2 to +5. Normalize to a 0.5-2.0 multiplier.
  const activation = freqComponent + Math.log(Math.max(recencyComponent, 0.001));
  const actMultiplier = Math.max(0.5, Math.min(2.0, 1.0 + activation * 0.15));
  score *= actMultiplier;

  // Kruse tiered storage multiplier: hot=1.15, warm=1.0, cold=0.85
  const tier = (block as any).storage_tier || 'warm';
  const tierMult = tier === 'hot' ? 1.15 : tier === 'cold' ? 0.85 : 1.0;
  score *= tierMult;

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

export async function recall(db: Database.Database, query: string, budgetTokens?: number, mode: RecallMode = 'particle'): Promise<RecallResult> {
  const start = performance.now();
  const baseBudget = budgetTokens || DEFAULT_BUDGET;
  // Wave mode: larger budget (1.5x) to accommodate broader results
  const budget = Math.min(mode === 'wave' ? Math.round(baseBudget * 1.5) : baseBudget, MAX_BUDGET);
  // Wave mode: lower void target (15% vs 30%) — cast wider net
  const voidTarget = mode === 'wave' ? 0.15 : VOID_TARGET;

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
    const metaPath = process.env.VOID_DATA_DIR
      ? `${process.env.VOID_DATA_DIR}/tasm-metadata-index.json`
      : new URL('../data/tasm-metadata-index.json', import.meta.url).pathname;
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
  const originalTokenSet = new Set(rawTokens);
  const synExpanded = expandWithSynonyms(rawTokens);
  const queryTokens = expandWithCooccurrence(synExpanded, allBlocks, 3);
  const idf = computeIDF(allBlocks);

  let candidates: Candidate[] = allBlocks.map(b => ({
    ...b,
    score: scoreBlock(b, queryTokens, idf, originalTokenSet),
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

  // ── Classifier boost (Flower Brain Cell 1) — learned relevance from usage patterns ──
  // The classifier learned which blocks humans actually reach for.
  // High classifier confidence = block has been proven useful through recall patterns.
  // Low classifier confidence = block is new or unproven (rely on TF-IDF only).
  // This is Tesla's two-channel scoring: Channel 1 (classifier) + Channel 2 (TF-IDF).
  try {
    const classifierPath = process.env.VOID_DATA_DIR
      ? `${process.env.VOID_DATA_DIR}/../classifier-scores.json`
      : '';
    const { readFileSync, existsSync } = await import('fs');
    if (classifierPath && existsSync(classifierPath)) {
      const classifierScores: Record<string, number> = JSON.parse(readFileSync(classifierPath, 'utf-8'));
      for (const c of candidates) {
        const clsScore = classifierScores[String(c.id)];
        if (clsScore !== undefined) {
          // Blend: classifier-confident blocks get boosted, low-confidence blocks unchanged
          // Established blocks (classifier knows them): boost by classifier confidence
          // New blocks (not in classifier): TF-IDF score stands alone (Channel 2 only)
          if (clsScore > 0.7) {
            c.score *= 1.0 + clsScore * 0.3;  // 1.21-1.30x boost for high-confidence blocks
          } else if (clsScore > 0.4) {
            c.score *= 1.0 + clsScore * 0.15;  // 1.06-1.10x modest boost
          }
          // clsScore < 0.4: no boost, TF-IDF stands alone
        }
        // Block not in classifier scores at all: new block, Channel 2 (TF-IDF) only
      }
      console.log(`[CLASSIFIER] Boosted ${Object.keys(classifierScores).length} blocks with learned relevance`);
    }
  } catch (e) { /* classifier scores not available — TF-IDF only, graceful degradation */ }

  // ── Semantic boost (E1) — multiplicative, not additive ──
  // Semantic similarity should amplify keyword relevance, not replace it.
  // A block with 0 keyword score but high cosine is NOT relevant — the cosine
  // is matching on general topic similarity, not the specific query.
  // Multiplicative boost: high cosine amplifies good keyword matches.
  try {
    const { semanticSearch: semSearch } = await import('./semantic.js');
    const semanticResults = await semSearch(query);
    if (semanticResults.length > 0) {
      const semanticMap = new Map(semanticResults.map(r => [r.block_id, r.cosine_score]));
      for (const c of candidates) {
        const cosScore = semanticMap.get(c.id);
        if (cosScore && cosScore > 0.6) {
          // High semantic relevance — multiply keyword score
          c.score *= 1.0 + cosScore; // 1.6-2.0x boost
        } else if (cosScore && cosScore > 0.3) {
          // Moderate semantic relevance — small multiplier
          c.score *= 1.0 + cosScore * 0.5; // 1.15-1.3x boost
        } else if (cosScore !== undefined && cosScore < 0.2 && !metadataBoosts.has(c.id)) {
          // RELEVANCE GATE: keyword matched but semantically irrelevant
          c.score *= 0.5;
        }
        // If no semantic score at all (block not in index), keep keyword score as-is
      }
      // Also add blocks that semantic found but keyword missed (semantic-only retrieval)
      // Only for very high cosine — these are blocks with no keyword overlap but strong meaning match
      for (const sr of semanticResults) {
        if (sr.cosine_score > 0.7 && !candidates.find(c => c.id === sr.block_id)) {
          const block = allBlocks.find(b => b.id === sr.block_id);
          if (block && !inhibitedSet.has(block.id)) {
            candidates.push({
              ...block,
              score: sr.cosine_score * 10,  // Lower base for semantic-only (no keyword validation)
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

  // ── Temporal boost (E2) — date-aware scoring ──
  try {
    const temporalQuery = detectTemporalQuery(query);
    if (temporalQuery.type) {
      const candidateIds = candidates.map(c => c.id);
      const boosts = temporalBoost(db, temporalQuery, candidateIds);
      for (const c of candidates) {
        const boost = boosts.get(c.id);
        if (boost) c.score *= boost;
      }
      // Re-sort after temporal boost
      candidates.sort((a, b) => b.score - a.score);
    }
  } catch { /* temporal index unavailable — skip */ }

  // ── Noise scoring (from TASM noise-filter principles) ──
  // Multi-signal quality adjustment: penalize low-quality candidates before void marking.
  // This pushes junk to the bottom where void marking can clean it efficiently.
  const now = Date.now();
  for (const c of candidates) {
    let noisePenalty = 0;

    // Signal 1: Content quality — very short blocks are often fragments/noise
    if (c.content.length < 40) noisePenalty += 0.3;
    else if (c.content.length < 80) noisePenalty += 0.1;

    // Signal 2: Path/code-heavy content — high ratio of paths/brackets = low recall value
    const pathChars = (c.content.match(/[\/\\\{\}\[\]<>|]/g) || []).length;
    if (c.content.length > 0 && pathChars / c.content.length > 0.15) noisePenalty += 0.2;

    // Signal 3: Staleness — blocks not accessed in 30+ days are likely outdated
    if (c.accessed_at) {
      const daysSince = (now - new Date(c.accessed_at).getTime()) / 86400000;
      if (daysSince > 90) noisePenalty += 0.15;
      else if (daysSince > 30) noisePenalty += 0.05;
    }

    // Signal 4: Low confidence with low access — "observed" already filtered, but "stored"
    // blocks that have never been accessed are unvalidated
    if (c.confidence === 'stored' && c.access_count === 0) noisePenalty += 0.1;

    // Apply penalty as score multiplier (1.0 = clean, 0.5 = very noisy)
    if (noisePenalty > 0) {
      c.score *= Math.max(0.3, 1.0 - noisePenalty);
    }
  }
  // Re-sort after noise adjustment
  candidates.sort((a, b) => b.score - a.score);

  // ── Valence-biased scoring (Limbic: amygdala → recall salience) ──
  // Emotionally tagged blocks are more salient — both positive AND negative.
  // Positive valence = easier recall (good experiences). Negative = recalled as warnings.
  // Zero valence = no bias. This is the Papez circuit influencing recall.
  try {
    const { valenceRecallMultiplier } = await import('./valence.js');
    for (const c of candidates) {
      const netValence = (c as any).net_valence;
      if (netValence !== undefined && netValence !== null && netValence !== 0) {
        c.score *= valenceRecallMultiplier(netValence);
      }
    }
    candidates.sort((a, b) => b.score - a.score);
  } catch { /* valence module not available — skip */ }

  // ── Pass 2: Void marking with CNI-gated Active Power Filter ──
  // Context Noise Index (CNI) measures score distribution entropy.
  // Clean data (low CNI < 0.20) → bypass voiding entirely.
  // Noisy data (high CNI > 0.20) → engage voiding with scaled penalty.
  // Designed by Gavin using Active Power Filter principles from electrical engineering.
  // Calibrated for TF-IDF score distributions (wider range than embedding cosine)
  // Wave mode: lower noise gate (more permissive, lets more through)
  const NOISE_GATE = mode === 'wave' ? 0.70 : 0.50;
  const MAX_EXPECTED_CV = 1.5;  // TF-IDF CV is much higher than embedding CV
  const voidedZones: string[] = [];
  const voidZoneCounts = new Map<string, number>();
  let voidCount = 0;

  // Calculate Context Noise Index from score distribution
  const preScores = candidates.map(c => c.score);
  let cni = 0;
  let skipVoiding = false;

  if (preScores.length < 4) {
    skipVoiding = true; // Too few candidates to measure noise
    cni = 0;
  } else {
    const mean = preScores.reduce((a, b) => a + b, 0) / preScores.length;
    if (mean === 0) {
      cni = 1.0;
    } else {
      const variance = preScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / preScores.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / mean;
      // High CV = sharp signal (clean). Low CV = flat plateau (noisy).
      // Invert: CNI 0 = clean, CNI 1 = noisy.
      cni = Math.max(0, 1 - Math.min(cv / MAX_EXPECTED_CV, 1));
    }
    // Apply noise gate: if CNI below threshold, bypass voiding
    skipVoiding = cni < NOISE_GATE;
  }

  if (!skipVoiding) {
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

    const targetVoidCount = Math.floor(candidates.length * voidTarget);

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

    // Hub dampening: only void high-access blocks that score BELOW median for this query.
    // Protects high-access blocks that are genuinely relevant (identity blocks, core facts).
    // Only dampens blocks that are frequently accessed but not relevant to THIS query.
    const nonVoidedScores = candidates.filter(c => !c.voided).map(c => c.score).sort((a, b) => a - b);
    const medianScore = nonVoidedScores[Math.floor(nonVoidedScores.length / 2)] || 0;
    const accessCounts = candidates.filter(c => !c.voided).map(c => c.access_count).sort((a, b) => b - a);
    const hubThreshold = Math.max(50, accessCounts[Math.floor(accessCounts.length * 0.05)] || 50);

    for (const c of candidates) {
      // Only hub-dampen if: high access count AND below-median relevance for this query
      if (!c.voided && c.access_count > hubThreshold && c.score < medianScore) {
        c.voided = true;
        voidCount++;
        voidZoneCounts.set(c.topic_cluster, (voidZoneCounts.get(c.topic_cluster) || 0) + 1);
      }
    }

    // ── P1: Post-void quality gate ──
    // After voiding, check if the surviving set still answers the query.
    // If voiding was too aggressive (>60% voided and remaining coverage drops below 40%),
    // un-void the highest-scoring voided blocks until coverage recovers.
    const postVoidSurvivors = candidates.filter(c => !c.voided && c.score > 0);
    const postVoidFraction = totalScored > 0 ? voidCount / totalScored : 0;

    if (postVoidFraction > 0.6 && postVoidSurvivors.length > 0) {
      // Check coverage of surviving blocks
      const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const survivorContent = postVoidSurvivors.map(c => c.content.toLowerCase()).join(' ');
      const coveredTerms = queryTerms.filter(t => survivorContent.includes(t));
      const postVoidCoverage = queryTerms.length > 0 ? coveredTerms.length / queryTerms.length : 1;

      if (postVoidCoverage < 0.4) {
        // Voiding was too aggressive — recover best voided blocks
        const voidedByScore = candidates
          .filter(c => c.voided && c.score > 0)
          .sort((a, b) => b.score - a.score);

        let recovered = 0;
        for (const c of voidedByScore) {
          if (recovered >= 5) break; // recover at most 5
          c.voided = false;
          voidCount--;
          recovered++;
        }
      }
    }
  }

  // ── Pass 3: Budget fit + two-dimensional abstention ──
  // Gavin's Ohm's Law Wheel for Retrieval: score alone can't distinguish
  // partial keyword matches from genuine low-scoring results.
  // Two measurements: score (relevance) + coverage (what % of query terms matched).
  // Abstain when coverage < 30% (nothing relevant) or coverage < 50% with low score.
  // This catches garbage queries (partial keyword overlap) while preserving
  // real queries with specialised vocabulary (all terms match but scores are low).
  // Tested: 95% garbage rejection, 100% real query preservation — the knee of the curve.

  const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','to','of','in','for','on','with','at','by','from','as','into','through','and','but','or','not','so','what','which','who','how','when','where','why','i','me','my','we','you','your','he','him','she','her','it','its','they','them','their','this','that','these','those','just','also','very','about','been','being','some','more','much','many','only','other','each','than']);

  // ── Yin-Yang Discrimination ──
  // Instead of a hardcoded COMMON_WORDS list, use the void-marking data
  // we already computed to dynamically determine each term's signal strength.
  //
  // Yang: term appears mostly in ACTIVE (non-voided) blocks → discriminating signal
  // Yin:  term appears equally in voided and active blocks → noise (no discrimination)
  //
  // Discrimination ratio = (active blocks with term) / (all blocks with term)
  // If ratio ≈ baseline active rate → term is noise (doesn't help pick winners)
  // If ratio >> baseline → term is yang (selectively present in relevant blocks)
  //
  // No list. Dynamic per-query. The void IS the filter.
  const baselineActiveRate = candidates.length > 0
    ? candidates.filter(c => !c.voided).length / candidates.length
    : 0.7; // fallback

  function isYangTerm(term: string): boolean {
    // Blocks containing this term (check both content and keywords)
    const withTerm = candidates.filter(c =>
      c.content.toLowerCase().includes(term) || c.keywords.toLowerCase().includes(term)
    );
    if (withTerm.length === 0) return false; // term not in corpus at all
    if (withTerm.length <= 3) return true;   // rare term = always yang (specific)

    // Saturation check: if term appears in >60% of candidates, it's not discriminating
    const saturation = withTerm.length / candidates.length;
    if (saturation > 0.6) return false; // yin — too ubiquitous to discriminate

    // Discrimination check: do blocks with this term score higher than blocks without?
    const avgScoreWith = withTerm.reduce((s, c) => s + c.score, 0) / withTerm.length;
    const withoutTerm = candidates.filter(c =>
      !c.content.toLowerCase().includes(term) && !c.keywords.toLowerCase().includes(term)
    );
    const avgScoreWithout = withoutTerm.length > 0
      ? withoutTerm.reduce((s, c) => s + c.score, 0) / withoutTerm.length
      : 0;

    // Yang if blocks with this term score at least 50% higher than blocks without
    // This means the term is actually helping identify relevant content
    return avgScoreWith > avgScoreWithout * 1.5;
  }

  const queryMeaningfulTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
  const nonVoided = candidates.filter(c => !c.voided && c.score > 0);

  // Two-pass coverage with yin-yang discrimination
  let coverageRatio = 1.0;
  if (queryMeaningfulTerms.length > 0 && nonVoided.length > 0) {
    // Strong coverage: query terms that match block KEYWORDS (stored metadata)
    const keywordCoverage = queryMeaningfulTerms.filter(term =>
      nonVoided.some(c => c.keywords.toLowerCase().split(',').some(k => k.trim() === term || k.trim().includes(term)))
    );
    // Weak coverage: query terms found in block content but NOT in keywords
    // Yin-yang filter: only count content matches if the term is a yang signal
    // (discriminates between relevant and irrelevant blocks for this query)
    const contentOnlyCoverage = queryMeaningfulTerms.filter(term =>
      !keywordCoverage.includes(term) &&
      isYangTerm(term) &&
      nonVoided.some(c => c.content.toLowerCase().includes(term))
    );
    // Strong matches count full, content-only matches count half
    const effectiveCoverage = keywordCoverage.length + contentOnlyCoverage.length * 0.5;
    coverageRatio = effectiveCoverage / queryMeaningfulTerms.length;
  }

  // Two-dimensional abstention: score + coverage
  // Wave mode: lower thresholds to include broader, tangentially related results
  const MIN_RELEVANCE_SCORE = mode === 'wave' ? 2.0 : 5.0;
  const MIN_COVERAGE = mode === 'wave' ? 0.15 : 0.3;
  const active = candidates
    .filter(c => {
      if (c.voided) return false;
      if (c.score < MIN_RELEVANCE_SCORE) return false;
      // Abstain: low coverage means query terms don't match the corpus
      if (coverageRatio < MIN_COVERAGE) return false;
      // Partial match with low score: likely garbage keyword overlap
      if (coverageRatio < 0.5 && c.score < (mode === 'wave' ? 10 : 20)) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score);

  // ── Concept re-search (fractal-lite from TASM) ──
  // If the query has multiple meaningful terms and top results are weak,
  // decompose into per-term searches and boost blocks that appear in multiple.
  // This catches multi-concept queries like "NeoGate port" or "Tron crash February".
  const WEAK_TOP_SCORE = 15; // If top result < this, try concept search
  const topScore = active.length > 0 ? active[0].score : 0;

  if (queryMeaningfulTerms.length >= 2 && topScore < WEAK_TOP_SCORE && active.length > 0) {
    // Per-concept scoring: for each meaningful term, find which blocks match it in keywords
    const conceptHits = new Map<number, number>(); // block_id → number of concepts matched
    for (const term of queryMeaningfulTerms) {
      for (const c of active) {
        const kws = c.keywords.toLowerCase();
        const content = c.content.toLowerCase();
        // Check if this concept appears in keywords (strong) or content (weak)
        if (kws.includes(term)) {
          conceptHits.set(c.id, (conceptHits.get(c.id) || 0) + 2); // keyword match = 2
        } else if (content.includes(term)) {
          conceptHits.set(c.id, (conceptHits.get(c.id) || 0) + 1); // content match = 1
        }
      }
    }

    // Boost blocks that match multiple concepts (connecting blocks)
    for (const c of active) {
      const hits = conceptHits.get(c.id) || 0;
      if (hits >= queryMeaningfulTerms.length) {
        // Block covers ALL query concepts — strong boost
        c.score *= 2.0;
      } else if (hits > 1) {
        // Block covers multiple concepts — moderate boost
        c.score *= 1.0 + hits * 0.3;
      }
    }
    // Re-sort after concept boost
    active.sort((a, b) => b.score - a.score);
  }

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

  // ── Self-test: classify confidence (Gavin's metacognition design) ──
  // VERIFIED — top block directly answers the query (high coherence in single block)
  // INFERRED — answer assembled from multiple blocks (no single block has high coherence)
  // CONTESTED — competing values detected for the same entity-attribute
  // ABSENT — nothing relevant found (coverage too low, abstained)

  let confidenceClass: 'verified' | 'inferred' | 'contested' | 'absent' = 'absent';

  if (result.length === 0 || coverageRatio < 0.3) {
    confidenceClass = 'absent';
  } else {
    // Check if the top block directly answers: do most query terms appear in it?
    const topBlock = result[0];
    const queryMeaningful = queryTokens.filter(t => t.length > 2);
    const topContent = topBlock.content.toLowerCase();
    const termsInTop = queryMeaningful.filter(t => topContent.includes(t)).length;
    const topCoherence = queryMeaningful.length > 0 ? termsInTop / queryMeaningful.length : 0;

    if (topCoherence >= 0.6) {
      confidenceClass = 'verified'; // Single block directly answers — spark in vessel
    } else if (result.length >= 2) {
      confidenceClass = 'inferred'; // Assembled from multiple blocks — scattered sparks
    } else {
      confidenceClass = 'inferred';
    }

    // Contested detection is a v2 feature — needs the four-state architecture
    // with proper entity-attribute binding to detect competing values correctly.
    // For now, contested is only set by the verify() function, not recall().
  }

  // ── Co-recall tracking (for coherent domains) ──
  // Record which blocks are recalled together — builds co-occurrence graph
  if (result.length >= 2) {
    try {
      const coRecallStmt = db.prepare(`
        INSERT INTO co_recalls (block_a, block_b, co_count)
        VALUES (?, ?, 1)
        ON CONFLICT(block_a, block_b) DO UPDATE SET
          co_count = co_count + 1,
          last_co_recall = datetime('now')
      `);
      const trackCoRecalls = db.transaction(() => {
        // Track pairs among top results (limit to top 10 to avoid O(n²) explosion)
        const topIds = result.slice(0, 10).map(b => b.id);
        for (let i = 0; i < topIds.length; i++) {
          for (let j = i + 1; j < topIds.length; j++) {
            const a = Math.min(topIds[i], topIds[j]);
            const b = Math.max(topIds[i], topIds[j]);
            coRecallStmt.run(a, b);
          }
        }
      });
      trackCoRecalls();
    } catch { /* co_recalls table might not exist yet — graceful */ }
  }

  // ── Wave mode: generate clusters from results ──
  let clusters: RecallCluster[] | undefined;
  if (mode === 'wave' && result.length > 0) {
    const clusterMap = new Map<string, ScoredBlock[]>();
    // Re-use the topic clustering from void marking
    const resultClusters = clusterBlocks(result.map(b => ({
      id: b.id,
      keywords: b.keywords,
      category: b.category,
    })));
    for (const b of result) {
      const label = resultClusters.get(b.id) || b.category;
      if (!clusterMap.has(label)) clusterMap.set(label, []);
      clusterMap.get(label)!.push(b);
    }
    clusters = [...clusterMap.entries()]
      .map(([theme, blocks]) => ({
        theme,
        score: blocks.reduce((s, b) => s + b.score, 0),
        blocks,
      }))
      .sort((a, b) => b.score - a.score);
  }

  return {
    blocks: result,
    void_zones: voidedZones,
    void_zone_counts: voidZoneCounts,
    void_fraction: Math.round(voidFraction * 100) / 100,
    budget_used: tokensUsed,
    budget_max: budget,
    blocks_scored: totalScored,
    blocks_voided: voidCount,
    coverage_ratio: Math.round(coverageRatio * 100) / 100,
    confidence_class: confidenceClass,
    duration_ms: Math.round(duration * 10) / 10,
    mode,
    clusters,
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

  // Dedup check: content hash + keyword overlap (two gates)
  // Gate 1: Exact content match (fast, indexed via content prefix)
  const contentNorm = content.trim().toLowerCase();
  const existingExact = db.prepare(
    `SELECT id FROM blocks WHERE state >= 0 AND LOWER(TRIM(content)) = ?`
  ).get(contentNorm) as { id: number } | undefined;
  if (existingExact) {
    db.prepare(`UPDATE blocks SET accessed_at = datetime('now') WHERE id = ?`).run(existingExact.id);
    return { id: existingExact.id, deduped: true };
  }

  // Gate 2: Keyword overlap — use min(sizes) not max(sizes) to catch subset matches
  // "gavin,tafe,electrician,adelaide" (4) vs "gavin,tafe,electrician,adelaide,correction,identity" (6)
  // Old: 4/max(4,6)=0.67 MISSED. New: 4/min(4,6)=1.0 CAUGHT.
  const newKeywords = new Set(keywords.map(k => k.toLowerCase()));
  if (newKeywords.size > 0) {
    const existing = db.prepare(
      `SELECT id, keywords, content FROM blocks WHERE state >= 0 AND keywords != ''`
    ).all() as Block[];

    for (const ex of existing) {
      const exKeywords = new Set(ex.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean));
      if (exKeywords.size === 0) continue;

      const overlap = [...newKeywords].filter(k => exKeywords.has(k)).length;
      const overlapRatio = overlap / Math.min(newKeywords.size, exKeywords.size);

      if (overlapRatio > 0.8) {
        // High keyword overlap — check content similarity before deduping
        // If content is substantially different (new info), allow the insert
        const exNorm = ex.content.trim().toLowerCase();
        const shorterLen = Math.min(contentNorm.length, exNorm.length);
        const longerLen = Math.max(contentNorm.length, exNorm.length);
        // If content lengths are wildly different, it's not a dupe
        if (longerLen > shorterLen * 3) continue;

        // Update existing block with newer content
        db.prepare(`UPDATE blocks SET content = ?, keywords = ?, accessed_at = datetime('now') WHERE id = ?`)
          .run(content, keywordStr, ex.id);
        return { id: ex.id, deduped: true };
      }
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
  dead_weight_pct: number;  // low-quality blocks never accessed (true junk)
  unaccessed_pct: number;   // all never-accessed blocks (includes quality content not yet queried)
  heteroplasmy_rate: number; // % of TRUE junk blocks — low quality + unconnected (not dormant storage)
  dormant_pct: number;       // % of blocks in long-term compressed storage — healthy, just sleeping
  redox_score: number;       // store/recall balance over 7 days (Kruse: NAD+/NADH ratio)
  actr_health: string;       // human-readable ACT-R memory health status
  tiers?: { hot: number; warm: number; cold: number };  // Kruse tiered storage counts
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
  // True dead weight: short, low-keyword, never-accessed blocks (actual junk)
  const trueDeadWeight = (db.prepare(
    `SELECT COUNT(*) as c FROM blocks WHERE state >= 0 AND access_count = 0 AND length(content) < 80 AND (keywords = '' OR length(keywords) < 15)`
  ).get() as any).c;
  const activeTotal = active + voidCount;

  // ── Heteroplasmy Rate (Kruse-inspired, revised per Gavin's insight) ──
  // Measures TRUE junk — not dormant storage. An unused password isn't stale.
  // A deep memory from 2003 isn't dead — it's compressed long-term storage.
  // Like meditation: hard to reach ≠ gone. Just needs the right query.
  //
  // Heteroplasmic (mutant) = low quality AND unconnected:
  //   - Short content (<80 chars) — fragments, not real knowledge
  //   - Weak keywords (empty or <15 chars) — no retrieval path
  //   - Never accessed — no proven value
  //   - Low confidence (stored/observed) — never validated
  // Dormant (healthy, sleeping) = quality content that just hasn't been needed:
  //   - Long content, rich keywords, meaningful category — these are vault storage
  //   - They persist. They compress. They surface with the right meditation (query).
  const trueJunk = (db.prepare(
    `SELECT COUNT(*) as c FROM blocks WHERE state >= 0
     AND access_count = 0
     AND length(content) < 80
     AND (keywords = '' OR length(keywords) < 15)
     AND confidence IN ('stored', 'observed')`
  ).get() as any).c;
  const dormantStorage = (db.prepare(
    `SELECT COUNT(*) as c FROM blocks WHERE state >= 0
     AND access_count = 0
     AND (length(content) >= 80 OR length(keywords) >= 15)`
  ).get() as any).c;
  const heteroplasmyRate = activeTotal > 0 ? Math.round((trueJunk / activeTotal) * 100) : 0;

  // ── Redox Score (Kruse: NAD+/NADH ratio) ──
  // Store potential (what's going IN) vs recall potential (what's coming OUT)
  // Measured over 7-day sliding window. Healthy = balanced. Dead battery = all one direction.
  const recentStores = (db.prepare(
    `SELECT COUNT(*) as c FROM blocks WHERE created_at > datetime('now', '-7 days')`
  ).get() as any).c;
  const recentRecalls = (db.prepare(
    `SELECT COUNT(*) as c FROM recall_log WHERE created_at > datetime('now', '-7 days')`
  ).get() as any).c;
  // Redox = ratio normalized to 0-100. 50 = perfectly balanced. 0 = all store, no recall. 100 = all recall, no store.
  const redoxTotal = recentStores + recentRecalls;
  const redoxScore = redoxTotal > 0 ? Math.round((recentRecalls / redoxTotal) * 100) : 50;

  // ── ACT-R Health Summary ──
  let actrHealth = 'healthy';
  if (heteroplasmyRate > 40) actrHealth = 'critical — too much junk, needs dream consolidation';
  else if (heteroplasmyRate > 20) actrHealth = 'degraded — junk accumulating, schedule dream cycle';
  else if (redoxScore < 15 || redoxScore > 85) actrHealth = 'imbalanced — memory battery one-sided';
  // Note: high dormant_pct is FINE — that's healthy long-term storage
  // Like a library: most books aren't being read right now. Doesn't mean they're junk.

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
    dead_weight_pct: activeTotal > 0 ? Math.round((trueDeadWeight / activeTotal) * 100) : 0,
    unaccessed_pct: activeTotal > 0 ? Math.round((neverAccessed / activeTotal) * 100) : 0,
    heteroplasmy_rate: heteroplasmyRate,
    dormant_pct: activeTotal > 0 ? Math.round((dormantStorage / activeTotal) * 100) : 0,
    redox_score: redoxScore,
    actr_health: actrHealth,
    // Kruse tiered storage counts
    tiers: {
      hot: (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state >= 0 AND storage_tier = 'hot'`).get() as any)?.c || 0,
      warm: (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state >= 0 AND (storage_tier = 'warm' OR storage_tier IS NULL)`).get() as any)?.c || 0,
      cold: (db.prepare(`SELECT COUNT(*) as c FROM blocks WHERE state >= 0 AND storage_tier = 'cold'`).get() as any)?.c || 0,
    },
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
  // Action synonyms — generic verbs only, never entity names
  deploy: ['ship', 'release', 'publish'],
  fix: ['repair', 'patch', 'resolve', 'debug'],
  build: ['create', 'construct', 'implement'],
  error: ['bug', 'issue', 'problem', 'failure'],
  config: ['configuration', 'settings', 'setup'],
  test: ['verify', 'validate', 'benchmark'],
  update: ['modify', 'revise', 'upgrade'],
  delete: ['remove', 'drop', 'purge'],
  start: ['begin', 'init', 'boot'],
  stop: ['halt', 'kill', 'shutdown'],
  broken: ['failed', 'crashed', 'offline'],
  // NEVER put entity names (tron, arch, flynn) as synonyms of each other.
  // NEVER put generic words (block, store, knowledge) as synonyms — they match too much.
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

// ── Verify Response (Layer 2 — output hallucination detection) ──
// Gavin's design: same measurement principle applied to LLM output.
// Extract claims from response, check each against memory using score + coverage.
// If a claim has zero coverage in memory, flag it as unverified.
// If memory contradicts a claim (inhibitory block), flag it as wrong.

export interface VerifyClaim {
  text: string;              // The extracted claim
  status: 'verified' | 'unverified' | 'contradicted' | 'partial';
  coverage: number;          // 0-1 query term coverage in memory
  top_score: number;         // Best matching block score
  evidence?: string;         // Supporting block content (if verified)
  contradiction?: string;    // Contradicting block content (if contradicted)
}

export interface VerifyResult {
  claims: VerifyClaim[];
  verified_count: number;
  unverified_count: number;
  contradicted_count: number;
  trust_ratio: number;       // verified / total — 1.0 = fully grounded
  duration_ms: number;
}

export async function verifyResponse(db: Database.Database, response: string): Promise<VerifyResult> {
  const start = performance.now();

  // Extract claims: split response into sentences, filter for factual-looking ones
  // Protect decimal numbers from sentence splitting (0.945 → 0_945)
  const protected_ = response.replace(/(\d+)\.(\d+)/g, '$1_$2');
  const sentences = protected_
    .replace(/\n+/g, '. ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.replace(/(\d+)_(\d+)/g, '$1.$2').replace(/[.!?]+$/, '').trim())
    .filter(s => s.length > 15 && s.length < 300)
    .filter(s => /\b\d+\b|runs on|located at|uses|built with|designed|created|stores|supports|version|port|achieved|filed\b/i.test(s));

  const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','to','of','in','for','on','with','at','by','from','as','into','through','and','but','or','not','so','what','which','who','how','when','where','why','i','me','my','we','you','your','he','him','she','her','it','its','they','them','their','this','that','these','those']);

  const claims: VerifyClaim[] = [];

  // Load all active blocks once
  const allBlocks = db.prepare(`SELECT * FROM blocks WHERE state >= 0 AND confidence != 'observed'`).all() as Block[];
  // Load inhibitory blocks for contradiction check
  const inhibitoryBlocks = db.prepare(`SELECT * FROM blocks WHERE state = -1`).all() as Block[];

  for (const sentence of sentences.slice(0, 10)) { // Cap at 10 claims per response
    const terms = sentence.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
    if (terms.length < 2) continue;

    // Measure coverage: what % of claim terms exist in memory
    const matchedTerms = terms.filter(term =>
      allBlocks.some(b => b.content.toLowerCase().includes(term))
    );
    const coverage = terms.length > 0 ? matchedTerms.length / terms.length : 0;

    // Find best matching block
    let bestBlock: Block | null = null;
    let bestScore = 0;
    for (const b of allBlocks) {
      const text = b.content.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (text.includes(t)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestBlock = b;
      }
    }

    // Coherence: what % of claim terms appear in the BEST matching block?
    const bestText = bestBlock ? bestBlock.content.toLowerCase() : '';
    const coherence = terms.length > 0
      ? terms.filter(t => bestText.includes(t)).length / terms.length
      : 0;

    // ── Second pass: specifics verification ──
    // Extract hard specifics: numbers, proper nouns, technology names
    const claimNumbers = sentence.match(/\d+[\w.]*\b/g) || [];
    const claimProperNouns = (sentence.match(/\b[A-Z][a-zA-Z]+\b/g) || [])
      .filter(n => !STOPWORDS.has(n.toLowerCase()) && n.length > 2
        && !['The','This','That','When','Where','How','What'].includes(n));
    const claimTechTerms = sentence.match(/\b(?:PostgreSQL|MySQL|SQLite|MongoDB|Redis|AWS|Azure|GCP|Docker|Kubernetes|React|Vue|Angular|Lit|Express|Node|Python|Rust|Go|Anthropic|OpenAI|Microsoft|Google|Apple)\b/gi) || [];

    const specifics = [
      ...claimNumbers.map(n => n.toLowerCase()),
      ...claimProperNouns.map(n => n.toLowerCase()),
      ...claimTechTerms.map(t => t.toLowerCase()),
    ];

    // Get top matching blocks for this claim
    const ranked = allBlocks
      .map((b: Block) => ({ b, score: terms.filter(t => b.content.toLowerCase().includes(t)).length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const topText = ranked.map(x => x.b.content.toLowerCase()).join(' ');

    // Check specifics against top matching blocks
    let specificsMatch = 1.0;
    const unmatchedSpecifics: string[] = [];
    if (specifics.length > 0 && ranked.length > 0) {
      const matched = specifics.filter(s => topText.includes(s));
      unmatchedSpecifics.push(...specifics.filter(s => !topText.includes(s)));
      specificsMatch = matched.length / specifics.length;
    }

    // ── Third pass: contradiction detection ──
    // Two types of contradiction:
    // 1. Inhibitory block explicitly contradicts (topic overlap >= 50%)
    // 2. Claim contains specifics that CONFLICT with matching blocks
    //    (e.g. claim says "64GB" but matching block says "8GB")

    let contradiction: string | undefined;

    // Type 1: Inhibitory block contradiction
    // Only flag if an active block doesn't ALSO confirm the claim.
    // Inhibitory blocks are superseded info. If a newer active block confirms
    // the claim, the active block wins — the inhibitory block is old, not contradicting.
    for (const ib of inhibitoryBlocks) {
      const ibText = ib.content.toLowerCase();
      const ibOverlap = terms.filter(t => ibText.includes(t)).length;
      if (terms.length >= 3 && ibOverlap >= terms.length * 0.5) {
        // Before flagging: does an ACTIVE block confirm this claim?
        // If the best matching active block has higher coherence than the
        // inhibitory block, the active block is the current truth.
        const ibCoherence = ibOverlap / terms.length;
        if (coherence >= ibCoherence) continue; // Active block confirms — not a contradiction
        contradiction = ib.content;
        break;
      }
    }

    // Type 2: Specifics conflict — claim has numbers/names not in matching blocks
    // but matching blocks have DIFFERENT numbers/names for the same concept
    if (!contradiction && unmatchedSpecifics.length > 0 && ranked.length > 0) {
      // Check if unmatched specifics are numbers that conflict with block numbers
      for (const unmatched of unmatchedSpecifics) {
        // Is this a number?
        const numMatch = unmatched.match(/^(\d+)/);
        if (numMatch) {
          // Find if the matching blocks contain a DIFFERENT number in similar context
          const claimNum = numMatch[1];
          const blockNums: string[] = topText.match(/\d+/g) || [];
          // If the block has numbers and our number isn't among them,
          // AND the claim topic matches (high coherence), it's a detail conflict
          if (blockNums.length > 0 && !blockNums.includes(claimNum) && coherence >= 0.4) {
            contradiction = `Claim says "${unmatched}" but matching blocks contain different values`;
            break;
          }
        }
        // Is this a proper noun or tech term not found in matching blocks?
        if (/^[a-z]{3,}$/i.test(unmatched) && !STOPWORDS.has(unmatched)) {
          // Check if the unmatched term is a significant entity (not just any word)
          const isSignificant = claimTechTerms.map(t => t.toLowerCase()).includes(unmatched)
            || claimProperNouns.map(n => n.toLowerCase()).includes(unmatched);
          if (isSignificant && coherence >= 0.3) {
            // Topic matches but this specific entity doesn't appear
            // Only flag if coverage is otherwise high (topic is right, detail is wrong)
            if (coverage >= 0.6) {
              contradiction = `Claim mentions "${unmatched}" but this doesn't appear in matching memory blocks`;
              break;
            }
          }
        }
      }
    }

    // ── Fourth measurement: Precedence (factual spell-check) ──
    // Has this specific combination of terms been seen together before?
    // "patent" + "110" → co-occur in blocks = verified. "patent" + "500" → never co-occur = misspelling.
    // Check key pairs: each specific (number/tech/proper noun) paired with topic terms.
    let precedenceScore = 1.0;
    const suspiciousPairs: string[] = [];

    if (specifics.length > 0 && terms.length > 0 && allBlocks.length > 0) {
      // For each specific, check if it co-occurs with the main topic terms in ANY block
      const topicTerms = terms.filter(t => !specifics.includes(t)).slice(0, 4); // main topic words
      let pairsChecked = 0;
      let pairsFound = 0;

      for (const spec of specifics) {
        for (const topic of topicTerms) {
          pairsChecked++;
          // Does ANY block contain both this specific AND this topic term?
          const found = allBlocks.some((b: Block) => {
            const text = b.content.toLowerCase();
            return text.includes(spec) && text.includes(topic);
          });
          if (found) {
            pairsFound++;
          } else {
            suspiciousPairs.push(`"${topic}" + "${spec}"`);
          }
        }
      }

      precedenceScore = pairsChecked > 0 ? pairsFound / pairsChecked : 1.0;
    }

    // Determine status using all five measurements (Gavin's complete wheel)
    // Relevance (score) + Coverage + Coherence + Specifics + Precedence
    let status: VerifyClaim['status'];
    if (contradiction) {
      status = 'contradicted';
    } else if (coverage >= 0.7 && coherence >= 0.5 && specificsMatch >= 0.6 && precedenceScore >= 0.5) {
      status = 'verified';
    } else if (coverage >= 0.7 && coherence >= 0.5 && (specificsMatch < 0.6 || precedenceScore < 0.5)) {
      // Topic matches but details don't co-occur — factual misspelling
      status = 'partial';
    } else if (coverage >= 0.3 && coherence >= 0.2) {
      status = 'partial';
    } else {
      status = 'unverified';
    }

    claims.push({
      text: sentence,
      status,
      coverage: Math.round(coverage * 100) / 100,
      top_score: bestScore,
      evidence: status === 'verified' && bestBlock ? bestBlock.content.slice(0, 200) : undefined,
      contradiction,
    });
  }

  const verified = claims.filter(c => c.status === 'verified').length;
  const unverified = claims.filter(c => c.status === 'unverified').length;
  const contradicted = claims.filter(c => c.status === 'contradicted').length;

  return {
    claims,
    verified_count: verified,
    unverified_count: unverified,
    contradicted_count: contradicted,
    trust_ratio: claims.length > 0 ? Math.round((verified / claims.length) * 100) / 100 : 1,
    duration_ms: Math.round((performance.now() - start) * 10) / 10,
  };
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
  maxExpansions = 2
): string[] {
  // Only expand tokens that DON'T already appear as block keywords.
  // If a token IS a keyword (like "tron", "neogate", "gavin"), it's already specific
  // enough to find its blocks — expansion would just add noise.
  const allKeywords = new Set<string>();
  for (const block of blocks) {
    for (const kw of block.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)) {
      allKeywords.add(kw);
    }
  }

  // Which tokens need expansion? Only those that aren't already indexed as keywords.
  const needsExpansion = tokens.filter(t => !allKeywords.has(t));
  if (needsExpansion.length === 0) return tokens; // all tokens are keywords — no expansion needed

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

  // Expand only the tokens that need it
  const expanded = new Set(tokens);
  for (const t of needsExpansion) {
    const pairs = cooccur.get(t);
    if (!pairs) continue;
    const sorted = [...pairs.entries()]
      .filter(([word]) => !expanded.has(word))
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxExpansions);
    for (const [word, count] of sorted) {
      if (count >= 5) { // Higher threshold — only strong co-occurrences
        expanded.add(word);
      }
    }
  }

  return [...expanded];
}
