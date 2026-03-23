/**
 * Semantic Embedding Index for Void Memory — Enhancement E1
 * Adds semantic search alongside keyword-based TF-IDF recall.
 * JSONL stays as source of truth. Embeddings are secondary index.
 */

const Database = require('better-sqlite3');
const { join } = require('path');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const EMBED_DIM = 768;

class SemanticIndex {
  private db: any;
  private agent: string;

  constructor(dbPath: string, agent: string) {
    this.agent = agent;
    this.db = new Database(join(dbPath, `semantic-${agent}.db`));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        block_id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL,
        model TEXT DEFAULT '${EMBED_MODEL}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  async embed(text: string): Promise<Float32Array | null> {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const data = await r.json() as any;
      if (!data.embedding || data.embedding.length !== EMBED_DIM) return null;
      return new Float32Array(data.embedding);
    } catch { return null; }
  }

  async indexBlock(blockId: number, content: string): Promise<boolean> {
    const existing = this.db.prepare('SELECT block_id FROM embeddings WHERE block_id = ?').get(blockId);
    if (existing) return true;
    const embedding = await this.embed(content);
    if (!embedding) return false;
    this.db.prepare('INSERT OR REPLACE INTO embeddings (block_id, embedding) VALUES (?, ?)').run(blockId, Buffer.from(embedding.buffer));
    return true;
  }

  async search(query: string, limit: number = 20): Promise<Array<{ block_id: number; similarity: number }>> {
    const queryEmb = await this.embed(query);
    if (!queryEmb) return [];
    const rows = this.db.prepare('SELECT block_id, embedding FROM embeddings').all() as any[];
    const results: Array<{ block_id: number; similarity: number }> = [];
    for (const row of rows) {
      const blockEmb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, EMBED_DIM);
      const sim = cosineSimilarity(queryEmb, blockEmb);
      results.push({ block_id: row.block_id, similarity: sim });
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit).filter(r => r.similarity > 0.3);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM embeddings').get() as any).c;
  }

  async rebuildFromBlocks(blocks: Array<{ id: number; content: string }>): Promise<number> {
    let indexed = 0;
    for (const block of blocks) {
      if (await this.indexBlock(block.id, block.content)) indexed++;
      if (indexed % 50 === 0) await new Promise(r => setTimeout(r, 500));
    }
    return indexed;
  }

  close() { this.db.close(); }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = { SemanticIndex };
