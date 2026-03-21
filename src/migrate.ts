/**
 * Binah → Void Memory Migration Script
 * Migrates TASM v2 valence=-1 blocks into Void Memory as inhibitory blocks
 * with auto-generated inhibition links based on keyword overlap.
 *
 * Usage: npx tsx /opt/arch-v2/migrate-binah-to-void.ts [--dry-run]
 */
import Database from 'better-sqlite3';
import { openDB } from './db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const TASM_DB = '/opt/tasm-v2/data/tasm.db';
const VOID_DB = '/opt/void-memory/data/void-memory.db';
const KEYWORD_OVERLAP_THRESHOLD = 0.4; // 40% overlap to create inhibition link

interface TasmBlock {
  address: string;
  content: string;
  category: string;
  keywords: string;
  access_count: number;
  created_at: string;
}

interface VoidBlock {
  id: number;
  content: string;
  keywords: string;
  state: number;
}

function parseKeywords(kw: string): Set<string> {
  try {
    // TASM stores as JSON array string
    const parsed = JSON.parse(kw);
    if (Array.isArray(parsed)) return new Set(parsed.map((k: string) => k.toLowerCase().trim()));
  } catch { /* not JSON */ }
  // Fallback: comma-separated
  return new Set(kw.split(',').map(k => k.toLowerCase().trim()).filter(Boolean));
}

function keywordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter(k => b.has(k)).length;
  return intersection / Math.max(a.size, b.size);
}

function main() {
  console.log(`Binah → Void Memory Migration ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`  TASM source: ${TASM_DB}`);
  console.log(`  Void target: ${VOID_DB}\n`);

  const tasm = new Database(TASM_DB, { readonly: true });
  const voidDb = openDB(VOID_DB);

  // Get Binah blocks from TASM
  const binahBlocks = tasm.prepare(`
    SELECT address, content, category, keywords, access_count, created_at
    FROM tasm_blocks
    WHERE valence = -1 AND state = 1 AND length(content) >= 20
  `).all() as TasmBlock[];

  console.log(`Found ${binahBlocks.length} Binah blocks in TASM\n`);

  // Get existing active blocks from Void Memory (for inhibition link generation)
  const activeBlocks = voidDb.prepare(`
    SELECT id, content, keywords, state FROM blocks WHERE state >= 0
  `).all() as VoidBlock[];

  console.log(`Found ${activeBlocks.length} active blocks in Void Memory\n`);

  const insertBlock = voidDb.prepare(`
    INSERT INTO blocks (content, category, keywords, state, confidence, access_count, created_at)
    VALUES (?, ?, ?, -1, 'confirmed', ?, ?)
  `);

  const insertInhibition = voidDb.prepare(`
    INSERT OR IGNORE INTO inhibitions (blocker_id, blocked_id, reason)
    VALUES (?, ?, ?)
  `);

  let blocksInserted = 0;
  let inhibitionsCreated = 0;

  const migrate = voidDb.transaction(() => {
    for (const binah of binahBlocks) {
      const kwSet = parseKeywords(binah.keywords);
      const kwString = [...kwSet].join(', ');

      // Insert the inhibitory block
      const result = insertBlock.run(
        binah.content,
        binah.category || 'fact',
        kwString,
        binah.access_count || 0,
        binah.created_at || new Date().toISOString(),
      );
      const newId = result.lastInsertRowid as number;
      blocksInserted++;

      console.log(`  [+] #${newId} (${binah.address}): ${binah.content.slice(0, 80)}...`);

      // Generate inhibition links
      for (const active of activeBlocks) {
        const activeKw = parseKeywords(active.keywords);
        const overlap = keywordOverlap(kwSet, activeKw);

        if (overlap >= KEYWORD_OVERLAP_THRESHOLD) {
          const reason = `binah-migration: ${Math.round(overlap * 100)}% keyword overlap`;
          insertInhibition.run(newId, active.id, reason);
          inhibitionsCreated++;
          console.log(`    → inhibits #${active.id} (${Math.round(overlap * 100)}% overlap)`);
        }
      }
    }
  });

  if (DRY_RUN) {
    console.log('\n--- DRY RUN — no changes made ---');
    console.log(`Would insert: ${binahBlocks.length} inhibitory blocks`);
    // Preview inhibition links
    let previewLinks = 0;
    for (const binah of binahBlocks) {
      const kwSet = parseKeywords(binah.keywords);
      for (const active of activeBlocks) {
        const activeKw = parseKeywords(active.keywords);
        if (keywordOverlap(kwSet, activeKw) >= KEYWORD_OVERLAP_THRESHOLD) {
          previewLinks++;
        }
      }
    }
    console.log(`Would create: ~${previewLinks} inhibition links`);
  } else {
    migrate();
    console.log(`\n=== Migration Complete ===`);
    console.log(`  Blocks inserted: ${blocksInserted}`);
    console.log(`  Inhibitions created: ${inhibitionsCreated}`);
  }

  tasm.close();
  voidDb.close();
}

main();
