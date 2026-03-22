/**
 * E2: Temporal Index for Void Memory
 * ===================================
 * Parses dates from block content, builds a temporal index,
 * and enhances recall with before/after/during awareness.
 *
 * Drop-in module: import and call from engine.ts recall path.
 *
 * Flynn — 2026-03-22
 */

import type Database from 'better-sqlite3';

// ── Schema migration ──

export function migrateTemporalIndex(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
      event_date TEXT NOT NULL,           -- ISO date: YYYY-MM-DD
      event_date_end TEXT,               -- optional end date for ranges
      date_precision TEXT NOT NULL DEFAULT 'day',  -- 'year', 'month', 'day'
      source_text TEXT NOT NULL,          -- the original text that was parsed
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_temporal_block ON temporal_events(block_id);
    CREATE INDEX IF NOT EXISTS idx_temporal_date ON temporal_events(event_date);
  `);
}

// ── Date parsing ──

interface ParsedDate {
  date: string;       // YYYY-MM-DD
  dateEnd?: string;    // for ranges
  precision: 'year' | 'month' | 'day';
  source: string;      // original matched text
}

/**
 * Extract dates from text content. Handles:
 * - ISO dates: 2026-03-22, 2025-11-20
 * - Written dates: March 22 2026, 22 March 2026
 * - Month-year: March 2026, September 2025
 * - Year only: in 2025, during 2024
 * - Relative markers in keywords: "date YYYY-MM-DD"
 */
const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', sept: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08', oct: '10', nov: '11', dec: '12',
};

export function parseDates(text: string): ParsedDate[] {
  const results: ParsedDate[] = [];
  const seen = new Set<string>();

  // ISO dates: 2024-01-15, 2026-03-22
  const isoRe = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
  let m;
  while ((m = isoRe.exec(text)) !== null) {
    const date = m[0];
    if (!seen.has(date)) {
      results.push({ date, precision: 'day', source: m[0] });
      seen.add(date);
    }
  }

  // Written dates: "March 22 2026", "March 22, 2026"
  const writtenRe = /\b(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|oct|nov|dec)\s+(\d{1,2}),?\s+(20\d{2})\b/gi;
  while ((m = writtenRe.exec(text)) !== null) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) continue;
    const day = m[2].padStart(2, '0');
    const date = `${m[3]}-${month}-${day}`;
    if (!seen.has(date)) {
      results.push({ date, precision: 'day', source: m[0] });
      seen.add(date);
    }
  }

  // Reverse written: "22 March 2026"
  const reverseRe = /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|sept|october|november|december)\s+(20\d{2})\b/gi;
  while ((m = reverseRe.exec(text)) !== null) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) continue;
    const day = m[1].padStart(2, '0');
    const date = `${m[3]}-${month}-${day}`;
    if (!seen.has(date)) {
      results.push({ date, precision: 'day', source: m[0] });
      seen.add(date);
    }
  }

  // Month-year: "March 2026", "September 2025"
  const monthYearRe = /\b(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|oct|nov|dec)\s+(20\d{2})\b/gi;
  while ((m = monthYearRe.exec(text)) !== null) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) continue;
    const date = `${m[2]}-${month}-01`;
    if (!seen.has(date)) {
      results.push({ date, precision: 'month', source: m[0] });
      seen.add(date);
    }
  }

  // Year references: "in 2025", "during 2024", standalone "2025"
  const yearRe = /\b(20[12]\d)\b/g;
  while ((m = yearRe.exec(text)) !== null) {
    const date = `${m[1]}-01-01`;
    // Only add if no more specific date for this year already found
    if (!seen.has(date) && ![...seen].some(d => d.startsWith(m![1]))) {
      results.push({ date, precision: 'year', source: m[0] });
      seen.add(date);
    }
  }

  return results;
}

// ── Temporal query detection ──

export interface TemporalQuery {
  type: 'before' | 'after' | 'during' | 'between' | 'range' | 'recent' | 'sequence' | null;
  dates: ParsedDate[];
  originalQuery: string;
}

/**
 * Detect temporal intent in a query.
 * "what happened before X" → before
 * "what happened after the crash" → after (+ date lookup)
 * "events in 2025" → during
 * "most recent" → recent
 * "what came first" → sequence
 */
export function detectTemporalQuery(query: string): TemporalQuery {
  const lower = query.toLowerCase();
  const dates = parseDates(query);

  // Before/after patterns
  if (/\b(before|prior to|preceding|earlier than)\b/i.test(lower)) {
    return { type: 'before', dates, originalQuery: query };
  }
  if (/\b(after|following|subsequent|since|later than)\b/i.test(lower)) {
    return { type: 'after', dates, originalQuery: query };
  }
  if (/\b(between|from\s+\d.*to\s+\d|during)\b/i.test(lower)) {
    return { type: 'during', dates, originalQuery: query };
  }
  if (/\b(most recent|latest|newest|last|current)\b/i.test(lower)) {
    return { type: 'recent', dates, originalQuery: query };
  }
  if (/\b(sequence|order|timeline|chronolog|first|came before|came after)\b/i.test(lower)) {
    return { type: 'sequence', dates, originalQuery: query };
  }

  // Has dates but no explicit temporal keyword — treat as "during"
  if (dates.length > 0) {
    return { type: 'during', dates, originalQuery: query };
  }

  return { type: null, dates: [], originalQuery: query };
}

// ── Index management ──

/**
 * Index a single block's temporal events.
 * Called on store and during backfill.
 */
export function indexBlockDates(db: Database.Database, blockId: number, content: string, keywords: string): number {
  const text = content + ' ' + keywords;
  const dates = parseDates(text);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO temporal_events (block_id, event_date, event_date_end, date_precision, source_text)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const d of dates) {
    insert.run(blockId, d.date, d.dateEnd || null, d.precision, d.source);
    count++;
  }
  return count;
}

/**
 * Backfill temporal index for all existing blocks.
 * Safe to run multiple times (uses INSERT OR IGNORE via unique constraint).
 */
export function backfillTemporalIndex(db: Database.Database): { indexed: number; events: number } {
  // Add unique constraint if not present (for idempotent backfill)
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_temporal_unique ON temporal_events(block_id, event_date, source_text)`);
  } catch {
    // Index may already exist
  }

  const blocks = db.prepare(`SELECT id, content, keywords FROM blocks WHERE state >= 0`).all() as Array<{
    id: number; content: string; keywords: string;
  }>;

  let totalEvents = 0;
  let blocksIndexed = 0;

  const txn = db.transaction(() => {
    for (const block of blocks) {
      const count = indexBlockDates(db, block.id, block.content, block.keywords);
      if (count > 0) {
        blocksIndexed++;
        totalEvents += count;
      }
    }
  });
  txn();

  return { indexed: blocksIndexed, events: totalEvents };
}

// ── Temporal scoring boost ──

/**
 * Apply temporal scoring boost to recall candidates.
 * Blocks with dates matching the temporal query get score multiplied.
 *
 * Returns a Map of block_id → temporal_boost_multiplier.
 */
export function temporalBoost(
  db: Database.Database,
  query: TemporalQuery,
  candidateIds: number[]
): Map<number, number> {
  const boosts = new Map<number, number>();
  if (!query.type || candidateIds.length === 0) return boosts;

  // Get temporal events for all candidates
  const placeholders = candidateIds.map(() => '?').join(',');
  const events = db.prepare(`
    SELECT block_id, event_date, date_precision
    FROM temporal_events
    WHERE block_id IN (${placeholders})
    ORDER BY event_date
  `).all(...candidateIds) as Array<{ block_id: number; event_date: string; date_precision: string }>;

  if (events.length === 0) return boosts;

  // Build block → dates mapping
  const blockDates = new Map<number, string[]>();
  for (const e of events) {
    if (!blockDates.has(e.block_id)) blockDates.set(e.block_id, []);
    blockDates.get(e.block_id)!.push(e.event_date);
  }

  switch (query.type) {
    case 'before': {
      // Boost blocks with dates BEFORE the query date
      const refDate = query.dates[0]?.date;
      if (!refDate) {
        // No explicit date — try to find reference event in existing blocks
        // Just boost blocks that HAVE dates (they're temporal-aware)
        for (const [blockId] of blockDates) {
          boosts.set(blockId, 1.3);
        }
        break;
      }
      for (const [blockId, dates] of blockDates) {
        if (dates.some(d => d < refDate)) {
          boosts.set(blockId, 1.3); // Gentle boost for matching temporal constraint
        } else if (dates.some(d => d >= refDate)) {
          boosts.set(blockId, 0.7); // Mild suppress blocks AFTER the reference
        }
      }
      break;
    }

    case 'after': {
      const refDate = query.dates[0]?.date;
      if (!refDate) {
        for (const [blockId] of blockDates) {
          boosts.set(blockId, 1.3);
        }
        break;
      }
      for (const [blockId, dates] of blockDates) {
        if (dates.some(d => d > refDate)) {
          boosts.set(blockId, 1.3);
        } else if (dates.some(d => d <= refDate)) {
          boosts.set(blockId, 0.7);
        }
      }
      break;
    }

    case 'during': {
      // Boost blocks with dates IN the specified period
      for (const qDate of query.dates) {
        const year = qDate.date.substring(0, 4);
        const month = qDate.date.substring(0, 7);

        for (const [blockId, dates] of blockDates) {
          for (const d of dates) {
            let match = false;
            if (qDate.precision === 'year' && d.startsWith(year)) match = true;
            else if (qDate.precision === 'month' && d.startsWith(month)) match = true;
            else if (qDate.precision === 'day' && d === qDate.date) match = true;

            if (match) {
              boosts.set(blockId, Math.max(boosts.get(blockId) || 1, 1.3));
            }
          }
        }
      }
      break;
    }

    case 'recent': {
      // Boost blocks with the most recent dates
      let latestDate = '';
      for (const [, dates] of blockDates) {
        for (const d of dates) {
          if (d > latestDate) latestDate = d;
        }
      }
      if (latestDate) {
        // Graduated boost: most recent = 2.5x, older = less
        for (const [blockId, dates] of blockDates) {
          const maxDate = dates.sort().reverse()[0];
          const daysDiff = Math.abs(
            (new Date(latestDate).getTime() - new Date(maxDate).getTime()) / 86400000
          );
          if (daysDiff < 1) boosts.set(blockId, 1.4);
          else if (daysDiff < 7) boosts.set(blockId, 1.3);
          else if (daysDiff < 30) boosts.set(blockId, 1.2);
          else boosts.set(blockId, 0.9);
        }
      }
      break;
    }

    case 'sequence': {
      // Boost ALL blocks with dates (they're needed for ordering)
      for (const [blockId] of blockDates) {
        boosts.set(blockId, 1.2);
      }
      break;
    }
  }

  return boosts;
}

// ── API endpoint handler ──

export interface TemporalStats {
  total_events: number;
  blocks_with_dates: number;
  date_range: { earliest: string; latest: string } | null;
  by_precision: Record<string, number>;
  by_year: Record<string, number>;
}

export function temporalStats(db: Database.Database): TemporalStats {
  const total = (db.prepare(`SELECT COUNT(*) as c FROM temporal_events`).get() as any)?.c || 0;
  const blocksWithDates = (db.prepare(`SELECT COUNT(DISTINCT block_id) as c FROM temporal_events`).get() as any)?.c || 0;

  const range = db.prepare(`SELECT MIN(event_date) as earliest, MAX(event_date) as latest FROM temporal_events`).get() as any;

  const precisionRows = db.prepare(`SELECT date_precision, COUNT(*) as c FROM temporal_events GROUP BY date_precision`).all() as any[];
  const byPrecision: Record<string, number> = {};
  for (const r of precisionRows) byPrecision[r.date_precision] = r.c;

  const yearRows = db.prepare(`SELECT substr(event_date, 1, 4) as year, COUNT(*) as c FROM temporal_events GROUP BY year ORDER BY year`).all() as any[];
  const byYear: Record<string, number> = {};
  for (const r of yearRows) byYear[r.year] = r.c;

  return {
    total_events: total,
    blocks_with_dates: blocksWithDates,
    date_range: range?.earliest ? { earliest: range.earliest, latest: range.latest } : null,
    by_precision: byPrecision,
    by_year: byYear,
  };
}
