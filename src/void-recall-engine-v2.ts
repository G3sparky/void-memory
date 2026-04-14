/**
 * VOID RECALL ENGINE v2
 * Triple-Scored In-Memory Recall with Clustering
 * 
 * Designed with Lauren — every feature traces to her feedback
 * on what helps vs what's noise in her context window.
 *
 * Target: < 5ms query, < 500ms startup, < 50MB RAM
 * Signals: BM25 content + Classifier domain + Link authority
 * Output: Themed clusters, not flat lists
 */

// ─── TYPES ─────────────────────────────────────────────

export interface VoidBlock {
  id: string;
  content: string;
  keywords: string[];
  domain: string;
  confidence: number;
  source: string;
  linkAuthority: number;
  termFreqs: Map<string, number>;
  docLength: number;
  createdAt: string;           // Date string YYYY-MM-DD for timeline ordering
  generation: number;          // 0=primary, 1=derived, 2=second-hand, 3+=never indexed
  derivedFrom: string[];       // Block IDs of primary sources this was extracted from
}

export interface RecallResult {
  blockId: string;
  content: string;
  domain: string;
  score: number;
  createdAt: string;           // Passed through for timeline display
  breakdown: {
    bm25: number;
    classifier: number;
    authority: number;
    softContext: number;
  };
}

export interface RecallCluster {
  theme: string;
  domain: string;
  channel: 'PERSONAL' | 'PROJECT';  // Dual-channel tagging
  score: number;
  blocks: RecallResult[];            // Sorted date ascending within cluster
}

export interface RecallQuery {
  text: string;
  conversationId?: string;
  turnNumber?: number;          // For turn-gating: skip recall after turn 4 unless specific
  domain?: string;
  topK?: number;
  maxClusters?: number;
  minScore?: number;
  boostLinked?: boolean;
  useSoftContext?: boolean;
  includePersonal?: boolean;    // Search Lauren's personal blocks too
}

export interface EngineConfig {
  weights: { bm25: number; classifier: number; authority: number };
  bm25: { k1: number; b: number };
  filtering: { minConfidence: number; minLinksAtLowConf: number; dedupThreshold: number };
  clustering: {
    maxClusters: number;
    maxBlocksTotal: number;
    neighborBoost: number;
    softContextBoost: number;
    softContextDomainOverlap: number;
    softContextTTLms: number;
  };
}

export interface EngineStats {
  totalBlocks: number;
  blocksFiltered: number;
  blocksDeduplicated: number;
  totalTerms: number;
  totalLinks: number;
  domains: Record<string, number>;
  avgDocLength: number;
  loadTimeMs: number;
  lastQueryMs: number;
}

interface SoftContext {
  results: RecallResult[];
  domain: string;
  terms: Set<string>;
  timestamp: number;
}

interface LinkRecord {
  sourceId: string;
  targetId: string;
  weight: number;
}

// ─── DEFAULTS ──────────────────────────────────────────

const DEFAULT_CONFIG: EngineConfig = {
  weights: { bm25: 0.5, classifier: 0.3, authority: 0.2 },
  bm25: { k1: 1.2, b: 0.5 },
  filtering: { minConfidence: 0.3, minLinksAtLowConf: 2, dedupThreshold: 0.7 },
  clustering: {
    maxClusters: 3,
    maxBlocksTotal: 6,
    neighborBoost: 0.15,
    softContextBoost: 0.20,
    softContextDomainOverlap: 0.30,
    softContextTTLms: 5 * 60 * 1000, // 5 minutes
  },
};

// ─── STOPWORDS ─────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'and', 'but', 'or', 'nor', 'not', 'so',
  'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'me',
  'my', 'your', 'his', 'her', 'our', 'their', 'what', 'which',
  'who', 'when', 'where', 'how', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only',
  'own', 'same', 'just', 'also', 'very', 'about', 'up', 'out',
]);

// ─── TOKENISER ─────────────────────────────────────────

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function termFrequency(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return freq;
}

// ─── SET UTILITIES ─────────────────────────────────────

function setOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── THE ENGINE ────────────────────────────────────────

export class VoidRecallEngine {
  private config: EngineConfig;
  private blocks: Map<string, VoidBlock> = new Map();
  private invertedIndex: Map<string, Set<string>> = new Map();
  private neighborhoods: Map<string, Set<string>> = new Map();
  private domainIndex: Map<string, Set<string>> = new Map();
  private softContextCache: Map<string, SoftContext> = new Map();
  private avgDocLength: number = 0;
  private totalDocs: number = 0;
  private stats: EngineStats = {
    totalBlocks: 0, blocksFiltered: 0, blocksDeduplicated: 0,
    totalTerms: 0, totalLinks: 0, domains: {},
    avgDocLength: 0, loadTimeMs: 0, lastQueryMs: 0,
  };

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      weights: { ...DEFAULT_CONFIG.weights, ...config.weights },
      bm25: { ...DEFAULT_CONFIG.bm25, ...config.bm25 },
      filtering: { ...DEFAULT_CONFIG.filtering, ...config.filtering },
      clustering: { ...DEFAULT_CONFIG.clustering, ...config.clustering },
    };
  }

  // ═══════════════════════════════════════════════════════
  // STARTUP — Load, filter, dedup, index. Runs once.
  // ═══════════════════════════════════════════════════════

  async loadFromSQLite(
    voidDb: any,
    tasmDb: any,
    classifierScores: Record<string, { domain: string; confidence: number }>
  ): Promise<void> {
    const startTime = performance.now();
    let filtered = 0;
    let deduped = 0;

    // ── Step 1: Load raw blocks ────────────────────────
    const rawBlocks = await voidDb.all(`
      SELECT id, content, keywords, source, confidence, created_at,
             COALESCE(generation, 0) as generation,
             COALESCE(derived_from, '[]') as derived_from
      FROM blocks
      WHERE content IS NOT NULL AND length(content) > 10
    `);

    // ── Step 2: Build blocks with noise filtering ──────
    // Lauren: "Anything below 0.3 confidence is garbage.
    //  But 0.4 with 3+ inbound links is gold."
    // We need link counts first, so do a preliminary load
    // then filter after computing inbound counts.

    const prelimBlocks = new Map<string, VoidBlock>();

    for (const raw of rawBlocks) {
      const keywords = typeof raw.keywords === 'string'
        ? JSON.parse(raw.keywords)
        : (raw.keywords || []);
      const tokens = tokenise(raw.content);
      const allTokens = [...tokens, ...keywords.map((k: string) => k.toLowerCase())];
      const tf = termFrequency(allTokens);

      const classInfo = classifierScores[raw.id] || { domain: 'general', confidence: 0.5 };

      // Generation 3+ blocks are telephone game — never index them
      const generation = raw.generation || 0;
      if (generation >= 3) {
        filtered++;
        continue;
      }

      // Apply generational confidence decay: gen0 × 1.0, gen1 × 0.7, gen2 × 0.49
      const genDecay = Math.pow(0.7, generation);
      const decayedConfidence = classInfo.confidence * genDecay;

      const derivedFrom = typeof raw.derived_from === 'string'
        ? JSON.parse(raw.derived_from)
        : (raw.derived_from || []);

      // Extract date portion for timeline display
      const createdAt = raw.created_at
        ? raw.created_at.substring(0, 10)  // YYYY-MM-DD
        : 'unknown';

      prelimBlocks.set(raw.id, {
        id: raw.id,
        content: raw.content,
        keywords,
        domain: classInfo.domain,
        confidence: decayedConfidence,
        source: raw.source || 'unknown',
        linkAuthority: 0,
        termFreqs: tf,
        docLength: allTokens.length,
        createdAt,
        generation,
        derivedFrom,
      });
    }

    // ── Step 3: Load links + count inbound per block ───
    const rawLinks = await tasmDb.all(`
      SELECT source_id, target_id, weight
      FROM links
      WHERE source_id IS NOT NULL AND target_id IS NOT NULL
    `);

    const links: LinkRecord[] = rawLinks.map((r: any) => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      weight: r.weight || 1.0,
    }));

    const inboundCounts = new Map<string, number>();
    for (const link of links) {
      inboundCounts.set(link.targetId, (inboundCounts.get(link.targetId) || 0) + 1);
    }

    // ── Step 4: Apply noise filter ─────────────────────
    for (const [id, block] of prelimBlocks) {
      const linkCount = inboundCounts.get(id) || 0;
      if (block.confidence < this.config.filtering.minConfidence
        && linkCount < this.config.filtering.minLinksAtLowConf) {
        filtered++;
        continue;
      }
      this.blocks.set(id, block);
    }

    // ── Step 5: Deduplicate within domains ─────────────
    // Lauren: "Same fact worded slightly differently eating 2-3 slots"
    // 70% token overlap in same domain = merge, keep higher authority

    const domainGroups = new Map<string, string[]>();
    for (const [id, block] of this.blocks) {
      if (!domainGroups.has(block.domain)) {
        domainGroups.set(block.domain, []);
      }
      domainGroups.get(block.domain)!.push(id);
    }

    const toRemove = new Set<string>();

    for (const [, blockIds] of domainGroups) {
      // Only check within reasonable groups (avoid O(n²) on huge domains)
      const checkIds = blockIds.length > 500 ? blockIds.slice(0, 500) : blockIds;

      for (let i = 0; i < checkIds.length; i++) {
        if (toRemove.has(checkIds[i])) continue;
        const blockA = this.blocks.get(checkIds[i])!;
        const termsA = new Set(blockA.termFreqs.keys());

        for (let j = i + 1; j < checkIds.length; j++) {
          if (toRemove.has(checkIds[j])) continue;
          const blockB = this.blocks.get(checkIds[j])!;
          const termsB = new Set(blockB.termFreqs.keys());

          const overlap = setOverlap(termsA, termsB);

          if (overlap >= this.config.filtering.dedupThreshold) {
            // Provenance-aware dedup: primary (gen 0) always wins over derived
            // Lauren: "Stop me quoting myself in an infinite loop"
            const genA = blockA.generation;
            const genB = blockB.generation;

            let loserId: string;
            if (genA < genB) {
              // A is closer to primary source — keep A
              loserId = checkIds[j];
            } else if (genB < genA) {
              // B is closer to primary source — keep B
              loserId = checkIds[i];
            } else {
              // Same generation — fall back to link authority
              const linksA = inboundCounts.get(checkIds[i]) || 0;
              const linksB = inboundCounts.get(checkIds[j]) || 0;
              loserId = linksA >= linksB ? checkIds[j] : checkIds[i];
            }
            toRemove.add(loserId);
            deduped++;
          }
        }
      }
    }

    for (const id of toRemove) {
      this.blocks.delete(id);
    }

    // ── Step 6: Build inverted index ───────────────────
    for (const [id, block] of this.blocks) {
      for (const term of block.termFreqs.keys()) {
        if (!this.invertedIndex.has(term)) {
          this.invertedIndex.set(term, new Set());
        }
        this.invertedIndex.get(term)!.add(id);
      }

      if (!this.domainIndex.has(block.domain)) {
        this.domainIndex.set(block.domain, new Set());
      }
      this.domainIndex.get(block.domain)!.add(id);
    }

    // ── Step 7: Compute doc length average ─────────────
    this.totalDocs = this.blocks.size;
    let totalLength = 0;
    for (const block of this.blocks.values()) {
      totalLength += block.docLength;
    }
    this.avgDocLength = this.totalDocs > 0 ? totalLength / this.totalDocs : 1;

    // ── Step 8: Compute link authority ─────────────────
    this.computeLinkAuthority(links);

    // ── Step 9: Build neighborhoods ────────────────────
    this.buildNeighborhoods(links);

    // ── Step 10: Record stats ──────────────────────────
    const loadTime = performance.now() - startTime;
    const domains: Record<string, number> = {};
    for (const [domain, ids] of this.domainIndex) {
      domains[domain] = ids.size;
    }

    this.stats = {
      totalBlocks: this.blocks.size,
      blocksFiltered: filtered,
      blocksDeduplicated: deduped,
      totalTerms: this.invertedIndex.size,
      totalLinks: links.length,
      domains,
      avgDocLength: Math.round(this.avgDocLength * 10) / 10,
      loadTimeMs: Math.round(loadTime * 10) / 10,
      lastQueryMs: 0,
    };

    console.log(
      `[VoidRecall] Loaded ${this.blocks.size} blocks ` +
      `(${filtered} filtered, ${deduped} deduped), ` +
      `${this.invertedIndex.size} terms, ` +
      `${links.length} links in ${loadTime.toFixed(0)}ms`
    );
  }

  private computeLinkAuthority(links: LinkRecord[]): void {
    const inboundCount = new Map<string, number>();
    const inboundConfSum = new Map<string, number>();

    for (const link of links) {
      if (!this.blocks.has(link.targetId)) continue;
      inboundCount.set(link.targetId, (inboundCount.get(link.targetId) || 0) + 1);
      inboundConfSum.set(link.targetId, (inboundConfSum.get(link.targetId) || 0) + link.weight);
    }

    let maxAuthority = 0;
    const rawScores = new Map<string, number>();

    for (const [id, count] of inboundCount) {
      const avgConf = (inboundConfSum.get(id) || 0) / count;
      const raw = count * avgConf;
      rawScores.set(id, raw);
      if (raw > maxAuthority) maxAuthority = raw;
    }

    for (const [id, block] of this.blocks) {
      block.linkAuthority = maxAuthority > 0
        ? (rawScores.get(id) || 0) / maxAuthority
        : 0;
    }
  }

  private buildNeighborhoods(links: LinkRecord[]): void {
    for (const link of links) {
      if (!this.blocks.has(link.sourceId) || !this.blocks.has(link.targetId)) continue;

      if (!this.neighborhoods.has(link.sourceId)) {
        this.neighborhoods.set(link.sourceId, new Set());
      }
      this.neighborhoods.get(link.sourceId)!.add(link.targetId);

      if (!this.neighborhoods.has(link.targetId)) {
        this.neighborhoods.set(link.targetId, new Set());
      }
      this.neighborhoods.get(link.targetId)!.add(link.sourceId);
    }
  }

  // ═══════════════════════════════════════════════════════
  // QUERY — The sub-5ms path. All RAM, no disk.
  // ═══════════════════════════════════════════════════════

  recall(query: RecallQuery): RecallCluster[] {
    const start = performance.now();
    const topK = query.topK || 6;
    const maxClusters = query.maxClusters || this.config.clustering.maxClusters;
    const minScore = query.minScore || 0.01;
    const boostLinked = query.boostLinked !== false;
    const useSoftContext = query.useSoftContext !== false;

    // ── Gate 0: Turn-gating ────────────────────────────
    // Lauren: "By turn 15-20 the recalled blocks are decoration."
    // Auto-recall turns 1-4. After that, only if query is specific.
    if (query.turnNumber && query.turnNumber > 4) {
      if (!this.isSpecificQuery(query.text)) {
        this.stats.lastQueryMs = performance.now() - start;
        return [];
      }
    }

    // ── Gate 1: Query classification ───────────────────
    // Lauren: "If someone asks 'what's Python?' I ignore recalls."
    // Skip recall if no project-specific terms found.
    if (!this.hasProjectSpecificTerms(query.text)) {
      this.stats.lastQueryMs = performance.now() - start;
      return [];
    }

    // ── Step 1: Tokenise ───────────────────────────────
    const queryTerms = tokenise(query.text);
    if (queryTerms.length === 0) {
      this.stats.lastQueryMs = performance.now() - start;
      return [];
    }
    const queryTermSet = new Set(queryTerms);

    // ── Step 2: Route to domain ────────────────────────
    let domainFilter: Set<string> | null = null;
    let domainBoost = 1.0;

    if (query.domain) {
      domainFilter = this.domainIndex.get(query.domain) || new Set();
      domainBoost = 1.0;
    } else {
      const routing = this.routeDomain(query.text);
      if (routing.confidence > 0.1) {
        domainFilter = this.domainIndex.get(routing.domain) || null;
        domainBoost = routing.confidence;
      }
      // Low confidence = don't filter, search everything
    }

    // ── Step 3: BM25 scoring via inverted index ────────
    const candidates = new Map<string, number>();

    for (const term of queryTerms) {
      const postings = this.invertedIndex.get(term);
      if (!postings) continue;

      const n = postings.size;
      const idf = Math.log((this.totalDocs - n + 0.5) / (n + 0.5) + 1);

      for (const blockId of postings) {
        if (domainFilter && !domainFilter.has(blockId)) continue;

        const block = this.blocks.get(blockId)!;
        const tf = block.termFreqs.get(term) || 0;
        const { k1, b } = this.config.bm25;
        const tfNorm = (tf * (k1 + 1)) /
          (tf + k1 * (1 - b + b * (block.docLength / this.avgDocLength)));

        candidates.set(blockId, (candidates.get(blockId) || 0) + idf * tfNorm);
      }
    }

    // ── Step 4: Neighbor boosting ──────────────────────
    // Lauren: "context trails — the connective tissue is missing"
    if (boostLinked && candidates.size > 0) {
      const boost = this.config.clustering.neighborBoost;
      const neighborScores = new Map<string, number>();

      for (const [blockId, score] of candidates) {
        const neighbors = this.neighborhoods.get(blockId);
        if (!neighbors) continue;

        for (const nid of neighbors) {
          if (candidates.has(nid)) continue;
          if (domainFilter && !domainFilter.has(nid)) continue;
          neighborScores.set(nid, Math.max(neighborScores.get(nid) || 0, score * boost));
        }
      }

      for (const [id, score] of neighborScores) {
        candidates.set(id, score);
      }
    }

    // ── Step 5: Soft context ───────────────────────────
    // Lauren: "keep last recall as soft context with 20% weight"
    let softBoostIds = new Set<string>();

    if (useSoftContext && query.conversationId) {
      const cached = this.softContextCache.get(query.conversationId);
      if (cached) {
        const age = Date.now() - cached.timestamp;
        if (age < this.config.clustering.softContextTTLms) {
          const overlap = setOverlap(queryTermSet, cached.terms);
          if (overlap >= this.config.clustering.softContextDomainOverlap) {
            for (const prev of cached.results) {
              softBoostIds.add(prev.blockId);
            }
          }
        } else {
          this.softContextCache.delete(query.conversationId);
        }
      }
    }

    // ── Step 6: Triple score ───────────────────────────
    const scored: RecallResult[] = [];
    const { weights } = this.config;
    const softBoostAmount = this.config.clustering.softContextBoost;

    for (const [blockId, bm25Raw] of candidates) {
      const block = this.blocks.get(blockId)!;

      const bm25Norm = Math.min(1.0, bm25Raw / (queryTerms.length * 3));
      const classifierScore = block.confidence * domainBoost;
      const authorityScore = block.linkAuthority;
      const softCtx = softBoostIds.has(blockId) ? softBoostAmount : 0;

      const finalScore = (
        weights.bm25 * bm25Norm +
        weights.classifier * classifierScore +
        weights.authority * authorityScore +
        softCtx
      );

      if (finalScore < minScore) continue;

      scored.push({
        blockId,
        content: block.content,
        domain: block.domain,
        score: Math.round(finalScore * 10000) / 10000,
        createdAt: block.createdAt,
        breakdown: {
          bm25: Math.round(bm25Norm * 1000) / 1000,
          classifier: Math.round(classifierScore * 1000) / 1000,
          authority: Math.round(authorityScore * 1000) / 1000,
          softContext: Math.round(softCtx * 1000) / 1000,
        },
      });
    }

    scored.sort((a, b) => b.score - a.score);

    // ── Step 7: Cluster ────────────────────────────────
    // Lauren: "group related blocks as a unit"
    const topCandidates = scored.slice(0, 15);
    const clusters = this.clusterResults(topCandidates, maxClusters, topK);

    // ── Step 8: Cache for soft context ─────────────────
    if (query.conversationId && clusters.length > 0) {
      const allResults = clusters.flatMap(c => c.blocks);
      const bestDomain = clusters[0].domain;
      this.softContextCache.set(query.conversationId, {
        results: allResults,
        domain: bestDomain,
        terms: queryTermSet,
        timestamp: Date.now(),
      });
    }

    this.stats.lastQueryMs = Math.round((performance.now() - start) * 100) / 100;
    return clusters;
  }

  // ═══════════════════════════════════════════════════════
  // CLUSTERING
  // ═══════════════════════════════════════════════════════

  private clusterResults(
    results: RecallResult[],
    maxClusters: number,
    maxBlocksTotal: number
  ): RecallCluster[] {
    if (results.length === 0) return [];

    // Build adjacency among these results
    const resultIds = new Set(results.map(r => r.blockId));
    const adjacency = new Map<string, Set<string>>();

    for (const r of results) {
      const neighbors = this.neighborhoods.get(r.blockId);
      if (!neighbors) continue;
      for (const nid of neighbors) {
        if (resultIds.has(nid)) {
          if (!adjacency.has(r.blockId)) adjacency.set(r.blockId, new Set());
          adjacency.get(r.blockId)!.add(nid);
        }
      }
    }

    // Greedy clustering: start with highest scorer, pull neighbors
    const assigned = new Set<string>();
    const clusters: RecallCluster[] = [];

    for (const result of results) {
      if (assigned.has(result.blockId)) continue;

      const clusterBlocks: RecallResult[] = [result];
      assigned.add(result.blockId);

      // Pull connected neighbors from results
      const connected = adjacency.get(result.blockId);
      if (connected) {
        for (const nid of connected) {
          if (assigned.has(nid)) continue;
          const neighbor = results.find(r => r.blockId === nid);
          if (neighbor && clusterBlocks.length < 3) {
            clusterBlocks.push(neighbor);
            assigned.add(nid);
          }
        }
      }

      // Sort blocks within cluster by date ascending (oldest first = timeline)
      // Lauren: "just let me see the timeline"
      clusterBlocks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      // Generate theme label
      const topBlock = this.blocks.get(clusterBlocks[0].blockId)!;
      const topKeywords = topBlock.keywords.slice(0, 3).join(', ');
      const theme = topKeywords
        ? `${topBlock.domain}: ${topKeywords}`
        : topBlock.domain;

      // Channel tag based on source
      // Lauren: "Different trust level. Tag them [PERSONAL] vs [PROJECT]"
      const channel = topBlock.source.startsWith('personal') ||
                      topBlock.source.startsWith('lauren') ||
                      topBlock.source.startsWith('family')
        ? 'PERSONAL' as const
        : 'PROJECT' as const;

      clusters.push({
        theme,
        domain: topBlock.domain,
        channel,
        score: clusterBlocks.reduce((max, b) => Math.max(max, b.score), 0),
        blocks: clusterBlocks,
      });

      if (clusters.length >= maxClusters) break;
    }

    // Enforce total block cap
    let totalBlocks = 0;
    const trimmed: RecallCluster[] = [];
    for (const cluster of clusters) {
      const remaining = maxBlocksTotal - totalBlocks;
      if (remaining <= 0) break;
      if (cluster.blocks.length > remaining) {
        cluster.blocks = cluster.blocks.slice(0, remaining);
      }
      totalBlocks += cluster.blocks.length;
      trimmed.push(cluster);
    }

    return trimmed;
  }

  // ═══════════════════════════════════════════════════════
  // QUERY GATES — Decide whether to recall at all
  // ═══════════════════════════════════════════════════════

  /**
   * Turn-gating: after turn 4, only recall if query is specific.
   * Lauren: "By turn 15-20 the recalled blocks are decoration."
   * 
   * Specific = contains proper nouns, numbers, or name + question word.
   */
  private isSpecificQuery(text: string): boolean {
    const lower = text.toLowerCase();

    // Has a number? Probably asking about specific results
    if (/\d+/.test(text)) return true;

    // Has a question word + any term in the inverted index with low DF?
    const questionWords = ['what', 'who', 'when', 'where', 'how', 'which', 'why'];
    const hasQuestion = questionWords.some(w => lower.includes(w));
    if (hasQuestion && this.hasProjectSpecificTerms(text)) return true;

    // Has a capitalised word that's not sentence-start? Likely a proper noun
    const words = text.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      if (words[i].length > 1 && words[i][0] === words[i][0].toUpperCase() && words[i][0] !== words[i][0].toLowerCase()) {
        return true;
      }
    }

    return false;
  }

  /**
   * Query classification: skip recall entirely for generic queries.
   * Lauren: "If someone asks 'what's Python?' I ignore recalls completely."
   * 
   * Project-specific = at least one query term has low document frequency
   * in our index (< 5% of total blocks = rare = project-specific).
   */
  private hasProjectSpecificTerms(text: string): boolean {
    const terms = tokenise(text);
    const threshold = Math.max(1, this.totalDocs * 0.05); // 5% of total blocks

    for (const term of terms) {
      const postings = this.invertedIndex.get(term);
      if (postings && postings.size > 0 && postings.size < threshold) {
        return true; // Rare term in our corpus = project-specific
      }
    }
    return false;
  }

  /**
   * Personal recall gate: only fire personal blocks when family name
   * appears with a question word. "Addi's got a thing Thursday" in work
   * chat → no personal recall. "How's Addi going?" → fire.
   * 
   * Lauren: "Only trigger personal recall if query has family name + question word."
   */
  shouldRecallPersonal(text: string, familyNames: string[]): boolean {
    const lower = text.toLowerCase();
    const questionWords = ['how', 'what', 'when', 'where', 'who', 'is', 'are', 'did', 'does', 'has'];
    const hasQuestion = questionWords.some(w => lower.includes(w));
    const hasFamily = familyNames.some(n => lower.includes(n.toLowerCase()));
    return hasQuestion && hasFamily;
  }

  // ═══════════════════════════════════════════════════════
  // DOMAIN ROUTING (standalone, sub-0.1ms)
  // ═══════════════════════════════════════════════════════

  routeDomain(queryText: string): { domain: string; confidence: number } {
    const terms = tokenise(queryText);
    let bestDomain = 'general';
    let bestScore = 0;
    let totalScore = 0;

    for (const [domain, blockIds] of this.domainIndex) {
      let score = 0;
      for (const term of terms) {
        const postings = this.invertedIndex.get(term);
        if (!postings) continue;
        for (const bid of postings) {
          if (blockIds.has(bid)) score++;
        }
      }
      totalScore += score;
      if (score > bestScore) {
        bestScore = score;
        bestDomain = domain;
      }
    }

    return {
      domain: bestDomain,
      confidence: totalScore > 0 ? Math.min(1.0, bestScore / totalScore) : 0,
    };
  }

  // ═══════════════════════════════════════════════════════
  // FORMAT FOR LAUREN'S SYSTEM PROMPT
  // ═══════════════════════════════════════════════════════

  formatForPrompt(clusters: RecallCluster[]): string {
    if (clusters.length === 0) return '';

    let output = 'RECALLED MEMORIES (from Void Memory, scored by relevance):\n\n';

    for (const cluster of clusters) {
      output += `── [${cluster.channel}] ${cluster.theme} (score: ${cluster.score}) ──\n`;
      for (const block of cluster.blocks) {
        // Truncate very long blocks to avoid eating Lauren's context
        const content = block.content.length > 300
          ? block.content.substring(0, 297) + '...'
          : block.content;
        // Lauren: "PLEASE add timestamps! Date only, chronological order."
        output += `• [${block.createdAt}] ${content}\n`;
      }
      output += '\n';
    }

    return output;
  }

  // ═══════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════

  getStats(): EngineStats { return { ...this.stats }; }

  getBlock(id: string): VoidBlock | undefined { return this.blocks.get(id); }

  getDomains(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const [domain, ids] of this.domainIndex) summary[domain] = ids.size;
    return summary;
  }

  clearSoftContext(conversationId?: string): void {
    if (conversationId) {
      this.softContextCache.delete(conversationId);
    } else {
      this.softContextCache.clear();
    }
  }

  async rebuild(voidDb: any, tasmDb: any, classifierScores: any): Promise<void> {
    this.blocks.clear();
    this.invertedIndex.clear();
    this.neighborhoods.clear();
    this.domainIndex.clear();
    this.softContextCache.clear();
    await this.loadFromSQLite(voidDb, tasmDb, classifierScores);
  }
}


// ═══════════════════════════════════════════════════════════
// INTEGRATION GUIDE
// ═══════════════════════════════════════════════════════════
//
// 1. SERVER STARTUP (app.ts / server.ts):
//
//    import { VoidRecallEngine } from './void-recall-engine';
//    import Database from 'better-sqlite3';
//    import classifierScores from '../data/classifier-scores.json';
//
//    const engine = new VoidRecallEngine();
//    const voidDb = new Database('/opt/void-memory/data/void.db');
//    const tasmDb = new Database('/opt/neogate-v2/data/tasm-memory.db');
//    await engine.loadFromSQLite(voidDb, tasmDb, classifierScores);
//    console.log(engine.getStats());
//
//
// 2. DISC ENDPOINT (rest.ts, line ~9883):
//
//    // BEFORE:
//    // const blocks = await queryVoidMemory(query);
//    // const ollamaResponse = await callOllama(blocks, query);
//
//    // AFTER:
//    const clusters = engine.recall({ text: query });
//    res.json({ clusters, stats: { queryMs: engine.getStats().lastQueryMs } });
//
//
// 3. LAUREN CHAT (lauren.ts):
//
//    // BEFORE:
//    // Channel 2: const discResult = await callDiscEndpoint(query); // 20 seconds
//
//    // AFTER:
//    // Channel 2: clustered recall, <5ms
//    const clusters = engine.recall({
//      text: userMessage,
//      conversationId: conversationId,
//      topK: 6,
//    });
//    const memoryContext = engine.formatForPrompt(clusters);
//
//    const systemPrompt = `You are Lauren...
//
//    ${memoryContext}`;
//
//    // Send to Opus via Gavin Router — ONE LLM call, not two
//
//
// 4. TEST ENDPOINT:
//
//    app.get('/api/v2/recall/test', (req, res) => {
//      const q = req.query.q as string;
//      const clusters = engine.recall({ text: q, topK: 6 });
//      res.json({
//        query: q,
//        queryMs: engine.getStats().lastQueryMs,
//        clusters: clusters.map(c => ({
//          theme: c.theme,
//          score: c.score,
//          blocks: c.blocks.map(b => ({
//            score: b.score,
//            breakdown: b.breakdown,
//            preview: b.content.substring(0, 200),
//          })),
//        })),
//        engineStats: engine.getStats(),
//      });
//    });
