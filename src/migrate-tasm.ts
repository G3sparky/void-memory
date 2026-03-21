/**
 * Migrate TASM v2 accessed blocks into Void Memory
 * Only migrates blocks with access_count > 0 (proven through use)
 * Preserves: content, category, keywords, access patterns
 * Maps TASM state to Void Memory state: state>=0 → active(1), state<0 → inhibitory(-1)
 */

import Database from 'better-sqlite3';
import { openDB } from './db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const tasmDb = new Database('/opt/tasm-v2/data/tasm.db', { readonly: true });
const voidDb = openDB();

interface TasmBlock {
  address: string;
  content: string;
  category: string;
  keywords: string;
  state: number;
  access_count: number;
  created_at: string;
  last_accessed: string | null;
  valence: number;
}

// Load accessed TASM blocks
const tasmBlocks = tasmDb.prepare(`
  SELECT address, content, category, keywords, state, access_count, created_at, last_accessed, valence
  FROM tasm_memory_blocks
  WHERE state >= 0 AND access_count > 0 AND LENGTH(content) > 20
  ORDER BY access_count DESC
`).all() as TasmBlock[];

console.log(`=== TASM → Void Memory Migration ===`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log(`TASM blocks with access_count > 0: ${tasmBlocks.length}\n`);

// Quality filters
let skipped = { short: 0, lowAlpha: 0, duplicate: 0 };
let migrated = 0;
let inhibitory = 0;

// Check existing Void Memory blocks for dedup
const existingKeywords = voidDb.prepare(`
  SELECT id, keywords FROM blocks WHERE state >= 0
`).all() as Array<{ id: number; keywords: string }>;

const existingKeywordSets = existingKeywords.map(e => ({
  id: e.id,
  keywords: new Set(e.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)),
}));

const insertBlock = voidDb.prepare(`
  INSERT INTO blocks (content, category, keywords, state, confidence, access_count, created_at, accessed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const migrate = voidDb.transaction(() => {
  for (const b of tasmBlocks) {
    // Quality gate: min length
    if (b.content.length < 20) { skipped.short++; continue; }

    // Quality gate: alpha ratio
    const alphaRatio = (b.content.match(/[a-zA-Z]/g) || []).length / b.content.length;
    if (alphaRatio < 0.3) { skipped.lowAlpha++; continue; }

    // Parse keywords
    const keywords = (b.keywords || '')
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0);
    const keywordStr = keywords.join(', ');
    const keywordSet = new Set(keywords);

    // Dedup: skip if >80% keyword overlap with existing block
    let isDup = false;
    for (const ex of existingKeywordSets) {
      if (ex.keywords.size === 0 || keywordSet.size === 0) continue;
      const overlap = [...keywordSet].filter(k => ex.keywords.has(k)).length;
      const ratio = overlap / Math.max(keywordSet.size, ex.keywords.size);
      if (ratio > 0.8) { isDup = true; break; }
    }
    if (isDup) { skipped.duplicate++; continue; }

    // Map state: TASM valence -1 or state < 0 → inhibitory
    const voidState = (b.valence === -1 || b.state < 0) ? -1 : 1;
    if (voidState === -1) inhibitory++;

    // Map confidence based on access count
    const confidence = b.access_count >= 3 ? 'confirmed'
      : b.access_count >= 1 ? 'accessed'
      : 'stored';

    if (!DRY_RUN) {
      insertBlock.run(
        b.content,
        b.category || 'fact',
        keywordStr,
        voidState,
        confidence,
        b.access_count,
        b.created_at || new Date().toISOString(),
        b.last_accessed
      );

      // Add to dedup set for subsequent blocks
      existingKeywordSets.push({ id: migrated, keywords: keywordSet });
    }

    migrated++;
  }
});

migrate();

console.log(`Migrated: ${migrated} blocks (${inhibitory} inhibitory)`);
console.log(`Skipped: ${skipped.short} short, ${skipped.lowAlpha} low-alpha, ${skipped.duplicate} duplicate`);

// Stats
if (!DRY_RUN) {
  const total = (voidDb.prepare('SELECT COUNT(*) as c FROM blocks').get() as any).c;
  const active = (voidDb.prepare('SELECT COUNT(*) as c FROM blocks WHERE state = 1').get() as any).c;
  const inhib = (voidDb.prepare('SELECT COUNT(*) as c FROM blocks WHERE state = -1').get() as any).c;
  const confirmed = (voidDb.prepare("SELECT COUNT(*) as c FROM blocks WHERE confidence = 'confirmed'").get() as any).c;
  console.log(`\nVoid Memory totals: ${total} blocks (${active} active, ${inhib} inhibitory, ${confirmed} confirmed)`);
}

tasmDb.close();
voidDb.close();
