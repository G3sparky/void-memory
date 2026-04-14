/**
 * Triple-Scored In-Memory Recall Engine
 *
 * Three intelligence signals combined at query time:
 * - BM25 keyword scoring (50% weight)
 * - Classifier domain confidence (30% weight)
 * - Link authority / access-based PageRank (20% weight)
 *
 * All in-memory. Target: < 3ms query, < 200ms startup.
 * Patent Pending: AU 2026902541, AU 2026902542
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ── Types ──

interface Block {
  id: number;
  content: string;
  keywords: string;
  category: string;
  state: number;
  confidence: string;
  access_count: number;
  tokens: string[];
  keywordSet: Set<string>;
}

interface ScoredBlock {
  id: number;
  content: string;
  keywords: string;
  category: string;
  confidence: string;
  score: number;
  bm25: number;
  classifier: number;
  authority: number;
}

interface RecallResult {
  blocks: ScoredBlock[];
  query_tokens: string[];
  blocks_scored: number;
  blocks_returned: number;
  void_fraction: number;
  duration_ms: number;
  channel: string;
}

// ── Constants ──

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','have','has','had',
  'do','does','did','will','would','could','should','may','might','can',
  'to','of','in','for','on','with','at','by','from','as','into','through',
  'and','but','or','not','so','what','which','who','how','when','where','why',
  'i','me','my','we','you','your','he','him','she','her','it','its',
  'they','them','their','this','that','these','those',
]);

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const W_BM25 = 0.50;
const W_CLASSIFIER = 0.30;
const W_AUTHORITY = 0.20;
const CHARS_PER_TOKEN = 4;
const VOID_TARGET = 0.30;
const MIN_SCORE = 0.01;

// ── Tokenizer ──

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

// ── Engine ──

export class RecallEngine {
  private blocks: Map<number, Block> = new Map();
  private invertedIndex: Map<string, Set<number>> = new Map();
  private classifierScores: Map<string, Record<string, number>> = new Map();
  private authority: Map<number, number> = new Map();
  private avgDocLen = 0;
  private docCount = 0;
  private idf: Map<string, number> = new Map();
  private ready = false;

  constructor(
    private dbPath: string,
    private classifierPath?: string,
  ) {}

  startup(): { blocks: number; terms: number; classified: number; duration_ms: number } {
    const start = Date.now();

    // Load blocks
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    const rows = db.prepare(
      'SELECT id, content, keywords, category, state, confidence, access_count FROM blocks WHERE state >= 0'
    ).all() as any[];

    let totalTokens = 0;
    for (const row of rows) {
      const tokens = tokenize(row.content.slice(0, 300) + ' ' + (row.keywords || ''));
      const keywordSet = new Set(tokenize(row.keywords || ''));
      const block: Block = { ...row, tokens, keywordSet };
      this.blocks.set(row.id, block);
      totalTokens += tokens.length;

      // Build inverted index
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          if (!this.invertedIndex.has(t)) this.invertedIndex.set(t, new Set());
          this.invertedIndex.get(t)!.add(row.id);
        }
      }
    }

    this.docCount = this.blocks.size;
    this.avgDocLen = this.docCount > 0 ? totalTokens / this.docCount : 1;

    // Compute IDF
    for (const [term, docs] of this.invertedIndex) {
      this.idf.set(term, Math.log((this.docCount - docs.size + 0.5) / (docs.size + 0.5) + 1));
    }

    // Compute authority from access_count (PageRank-lite)
    let maxAccess = 1;
    for (const block of this.blocks.values()) {
      if (block.access_count > maxAccess) maxAccess = block.access_count;
    }
    for (const block of this.blocks.values()) {
      // Confidence multiplier
      const confMult = block.confidence === 'confirmed' ? 1.3
        : block.confidence === 'accessed' ? 1.1
        : block.confidence === 'stored' ? 1.0
        : 0.7; // observed
      this.authority.set(block.id, (block.access_count / maxAccess) * confMult);
    }

    // Load inhibitions as negative authority
    const inhibitions = db.prepare('SELECT blocked_id FROM inhibitions').all() as any[];
    for (const inh of inhibitions) {
      this.authority.set(inh.blocked_id, -1);
    }

    db.close();

    // Load classifier scores
    if (this.classifierPath && existsSync(this.classifierPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.classifierPath, 'utf-8'));
        for (const [bid, info] of Object.entries(raw as Record<string, any>)) {
          this.classifierScores.set(bid, info.scores || {});
        }
      } catch {}
    }

    this.ready = true;
    const duration = Date.now() - start;

    return {
      blocks: this.blocks.size,
      terms: this.invertedIndex.size,
      classified: this.classifierScores.size,
      duration_ms: duration,
    };
  }

  recall(query: string, budget = 4000, domain?: string): RecallResult {
    const start = Date.now();
    if (!this.ready) this.startup();

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return { blocks: [], query_tokens: [], blocks_scored: 0, blocks_returned: 0, void_fraction: 0, duration_ms: 0, channel: 'empty' };
    }

    // Find candidate blocks via inverted index (union of all matching term sets)
    const candidateIds = new Set<number>();
    for (const qt of queryTokens) {
      const matches = this.invertedIndex.get(qt);
      if (matches) {
        for (const id of matches) candidateIds.add(id);
      }
    }

    // If no candidates from exact match, try partial matching
    if (candidateIds.size === 0) {
      for (const qt of queryTokens) {
        for (const [term, ids] of this.invertedIndex) {
          if (term.includes(qt) || qt.includes(term)) {
            for (const id of ids) candidateIds.add(id);
          }
        }
      }
    }

    // Score candidates
    const scored: ScoredBlock[] = [];

    for (const id of candidateIds) {
      const block = this.blocks.get(id);
      if (!block || block.state < 0) continue;

      // BM25
      let bm25 = 0;
      const docLen = block.tokens.length;
      for (const qt of queryTokens) {
        const tf = block.tokens.filter(t => t === qt).length;
        const idfVal = this.idf.get(qt) || 0;
        // Keyword field boost
        const kwBoost = block.keywordSet.has(qt) ? 2.0 : 1.0;
        bm25 += idfVal * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * docLen / this.avgDocLen))) * kwBoost;
      }

      // Classifier score for domain
      let classifierScore = 0.5; // neutral default
      if (domain) {
        const scores = this.classifierScores.get(String(id));
        if (scores) {
          classifierScore = scores[domain] || 0.5;
        }
      }

      // Authority
      const auth = this.authority.get(id) || 0;
      if (auth < 0) continue; // inhibited — skip entirely

      // Triple score
      const normalizedBm25 = Math.min(bm25 / 20, 1); // normalize to 0-1
      const score = (normalizedBm25 * W_BM25) + (classifierScore * W_CLASSIFIER) + (auth * W_AUTHORITY);

      if (score > MIN_SCORE) {
        scored.push({
          id: block.id,
          content: block.content,
          keywords: block.keywords,
          category: block.category,
          confidence: block.confidence,
          score: Math.round(score * 1000) / 1000,
          bm25: Math.round(normalizedBm25 * 1000) / 1000,
          classifier: Math.round(classifierScore * 1000) / 1000,
          authority: Math.round(auth * 1000) / 1000,
        });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Void marking: suppress bottom 30%
    const voidCount = Math.floor(scored.length * VOID_TARGET);
    const active = scored.slice(0, scored.length - voidCount);

    // Budget fit
    let usedTokens = 0;
    const result: ScoredBlock[] = [];
    for (const block of active) {
      const blockTokens = Math.ceil(block.content.length / CHARS_PER_TOKEN);
      if (usedTokens + blockTokens > budget) continue;
      usedTokens += blockTokens;
      result.push(block);
    }

    const duration = Date.now() - start;

    return {
      blocks: result,
      query_tokens: queryTokens,
      blocks_scored: candidateIds.size,
      blocks_returned: result.length,
      void_fraction: scored.length > 0 ? Math.round((voidCount / scored.length) * 100) / 100 : 0,
      duration_ms: duration,
      channel: 'triple',
    };
  }

  stats() {
    return {
      blocks: this.blocks.size,
      terms: this.invertedIndex.size,
      classified: this.classifierScores.size,
      ready: this.ready,
    };
  }
}

// ── Singleton ──

import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = process.env.VOID_DB || resolve(__dirname, '../data/void-memory.db');
const CLASSIFIER_PATH = process.env.CLASSIFIER_SCORES || resolve(__dirname, '../data/classifier-scores-all.json');

export const engine = new RecallEngine(DB_PATH, CLASSIFIER_PATH);

// Auto-start if run directly
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const result = engine.startup();
  console.log(`Recall Engine started: ${result.blocks} blocks, ${result.terms} terms, ${result.classified} classified in ${result.duration_ms}ms`);

  // Quick test
  const tests = [
    'Who is Gavin?',
    'What port does NeoGate run on?',
    'What is the void fraction?',
    'What happened in the February crash?',
    'What is the most important rule?',
    'What is BitNet?',
  ];

  for (const q of tests) {
    const r = engine.recall(q, 4000);
    console.log(`\nQ: ${q}`);
    console.log(`  ${r.blocks_returned} blocks in ${r.duration_ms}ms (scored ${r.blocks_scored}, voided ${Math.floor(r.blocks_scored * r.void_fraction)})`);
    if (r.blocks.length > 0) {
      console.log(`  Top: [${r.blocks[0].confidence}] score=${r.blocks[0].score} bm25=${r.blocks[0].bm25} cls=${r.blocks[0].classifier} auth=${r.blocks[0].authority}`);
      console.log(`  ${r.blocks[0].content.slice(0, 120)}...`);
    }
  }
}
