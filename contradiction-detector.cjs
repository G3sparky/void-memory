/**
 * E3: Automatic Contradiction Detector
 *
 * On every write, compares new block against existing blocks with overlapping keywords.
 * If contradiction detected, auto-generates an inhibitory block.
 * Uses GPT-5.4-nano for classification (fraction of a cent per check).
 *
 * Run async — never blocks the write operation.
 */

const ROUTER = 'http://192.168.1.203:3333/v1/chat/completions';
const MODEL = 'gpt-5.4-nano';
const DB_PATH = '/opt/void-memory/data/void-memory.db';

async function detectContradictions(newContent, newKeywords, newBlockId) {
  // Dynamic import for ESM/CJS compatibility
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: false });

  try {
    // Find existing blocks with overlapping keywords
    const kwList = (newKeywords || '').split(',').map(k => k.trim()).filter(k => k.length > 2);
    if (kwList.length === 0) return { contradictions: 0 };

    // Build keyword search — find blocks that share keywords
    const candidates = [];
    for (const kw of kwList.slice(0, 5)) { // Top 5 keywords
      const rows = db.prepare(
        "SELECT id, content, keywords, created_at FROM blocks WHERE state = 1 AND id != ? AND keywords LIKE ? LIMIT 10"
      ).all(newBlockId, `%${kw}%`);
      for (const row of rows) {
        if (!candidates.find(c => c.id === row.id)) {
          candidates.push(row);
        }
      }
    }

    if (candidates.length === 0) return { contradictions: 0 };

    // Take top 5 most relevant candidates
    const top5 = candidates.slice(0, 5);
    let contradictionsFound = 0;

    for (const existing of top5) {
      // Ask LLM if they contradict
      try {
        const res = await fetch(ROUTER, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              {
                role: 'system',
                content: 'Compare two memory blocks. Respond with ONLY one word: NO_CONFLICT, UPDATED, or CONTRADICTS.'
              },
              {
                role: 'user',
                content: `EXISTING (id ${existing.id}): ${existing.content.slice(0, 200)}\n\nNEW (id ${newBlockId}): ${newContent.slice(0, 200)}`
              }
            ],
            max_completion_tokens: 10,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(3000),
        });

        if (!res.ok) continue;
        const data = await res.json();
        const verdict = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();

        if (verdict === 'UPDATED' || verdict === 'CONTRADICTS') {
          // Auto-generate inhibitory block
          db.prepare(
            "UPDATE blocks SET state = -1 WHERE id = ?"
          ).run(existing.id);

          contradictionsFound++;
          console.log(`[contradiction-detector] Block ${existing.id} inhibited by new block ${newBlockId} (${verdict})`);
        }
      } catch {
        // LLM call failed — skip this candidate
      }
    }

    return { contradictions: contradictionsFound, candidates: candidates.length };
  } finally {
    db.close();
  }
}

// Test
async function test() {
  console.log("Contradiction Detector — Test");
  console.log("=" .repeat(40));

  // Simulate: new block says "NeoGate runs on port 3220"
  // Should find existing "NeoGate runs on port 3216" and detect contradiction
  const result = await detectContradictions(
    "NeoGate has been moved to port 3220",
    "neogate,port,3220",
    99999 // fake block id
  );

  console.log(`Result: ${JSON.stringify(result)}`);
}

if (require.main === module) {
  test().catch(console.error);
}

module.exports = { detectContradictions };
