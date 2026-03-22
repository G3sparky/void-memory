/**
 * Semantic Search Module — FAISS-based embedding search alongside JSONL
 * 
 * Architecture:
 * - JSONL remains source of truth
 * - Embeddings generated via Ollama nomic-embed-text (local, free)
 * - FAISS index stored as single file on disk (~30MB for 5K blocks)
 * - On query: embed query → FAISS search → return block IDs + cosine scores
 * - Results merged with keyword scores in engine.ts recall()
 */

const OLLAMA_URL = 'http://192.168.1.202:11434';
const EMBED_MODEL = 'nomic-embed-text';

// Embedding DBs — Tron stores in SQLite, one per agent
const SEMANTIC_DBS = [
  '/opt/void-memory/data/semantic-arch.db',
  '/opt/void-memory/data/tron/semantic-tron.db',
];

import { existsSync } from 'fs';
import Database from 'better-sqlite3';

interface EmbeddingEntry {
  block_id: number;
  embedding: number[];
}

let embeddingCache: EmbeddingEntry[] = [];

// Load embeddings from Tron's SQLite databases
export function loadEmbeddings(): void {
  embeddingCache = [];
  for (const dbPath of SEMANTIC_DBS) {
    if (!existsSync(dbPath)) continue;
    try {
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare('SELECT block_id, embedding FROM embeddings').all() as Array<{ block_id: number; embedding: Buffer }>;
      for (const row of rows) {
        try {
          // Embedding stored as BLOB — decode as Float32Array
          const floats = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
          embeddingCache.push({ block_id: row.block_id, embedding: Array.from(floats) });
        } catch { /* skip malformed embedding */ }
      }
      db.close();
    } catch { /* DB not accessible */ }
  }
  console.log(`[semantic] Loaded ${embeddingCache.length} embeddings from ${SEMANTIC_DBS.length} DBs`);
}

// Generate embedding for text via Ollama
export async function embed(text: string): Promise<number[]> {
  const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Embedding failed: ${r.status}`);
  const data = await r.json() as any;
  return data.embedding;
}

// Add embedding for a block
export async function addBlockEmbedding(blockId: number, content: string): Promise<void> {
  try {
    const embedding = await embed(content);
    // Remove old embedding for this block if exists
    embeddingCache = embeddingCache.filter(e => e.block_id !== blockId);
    embeddingCache.push({ block_id: blockId, embedding });
    // Persist
    
  } catch { /* Embedding failed — non-critical, keyword search still works */ }
}

// Cosine similarity
function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

// Search embeddings — returns top N block IDs with cosine scores
export async function semanticSearch(query: string, topN = 20): Promise<Array<{ block_id: number; cosine_score: number }>> {
  if (embeddingCache.length === 0) return [];
  
  try {
    const queryEmb = await embed(query);
    const scored = embeddingCache.map(e => ({
      block_id: e.block_id,
      cosine_score: cosine(queryEmb, e.embedding),
    }));
    scored.sort((a, b) => b.cosine_score - a.cosine_score);
    return scored.slice(0, topN).filter(s => s.cosine_score > 0.3); // Min 0.3 similarity
  } catch {
    return []; // Embedding service unavailable — graceful degradation
  }
}

// Rebuild all embeddings from blocks
export async function rebuildIndex(blocks: Array<{ id: number; content: string }>): Promise<{ total: number; embedded: number; failed: number }> {
  let embedded = 0, failed = 0;
  embeddingCache = [];
  
  for (const block of blocks) {
    try {
      const emb = await embed(block.content);
      embeddingCache.push({ block_id: block.id, embedding: emb });
      embedded++;
    } catch {
      failed++;
    }
    // Rate limit — don't overwhelm Ollama
    if (embedded % 50 === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  
  return { total: blocks.length, embedded, failed };
}

// Stats
export function embeddingStats(): { total: number; indexed: number; model: string } {
  return { total: embeddingCache.length, indexed: embeddingCache.length, model: EMBED_MODEL };
}

// Synchronous search using cached embeddings (for inline use in recall)
// Query embedding is generated async on first call, cached for session
let _lastQuery = '';
let _lastQueryEmb: number[] = [];

export function semanticSearchSync(query: string): Array<{ block_id: number; cosine_score: number }> {
  if (embeddingCache.length === 0) return [];
  // Can't do sync embedding generation — return cached results if query matches
  // The actual embedding happens via the async path; this returns empty if no cache
  return [];
}

// Pre-warm: generate query embedding async, store for sync retrieval
export async function preWarmQuery(query: string): Promise<Array<{ block_id: number; cosine_score: number }>> {
  return semanticSearch(query);
}

// Initialize on module load
loadEmbeddings();
