/**
 * Void Memory — Database Layer
 * SQLite store with three-state blocks (active/void/inhibitory)
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { migrateTemporalIndex } from "./temporal-index.js";

const DATA_DIR = process.env.VOID_DATA_DIR || join(import.meta.dirname, '..', 'data');

export interface Block {
  id: number;
  content: string;
  category: string;       // fact, preference, context, skill, episode, decision
  keywords: string;       // comma-separated
  state: number;          // 1=active, 0=void, -1=inhibitory
  confidence: string;     // observed, stored, accessed, confirmed
  access_count: number;
  created_at: string;
  accessed_at: string | null;
  supersedes: number | null;  // id of block this one replaces
}

export interface RecallEntry {
  id: number;
  query: string;
  blocks_scored: number;
  blocks_returned: number;
  blocks_voided: number;
  void_fraction: number;
  budget_tokens: number;
  duration_ms: number;
  created_at: string;
}

export function openDB(path?: string): Database.Database {
  mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path || join(DATA_DIR, 'void-memory.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  migrateTemporalIndex(db);
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'fact',
      keywords TEXT NOT NULL DEFAULT '',
      state INTEGER NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'stored',
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT,
      supersedes INTEGER REFERENCES blocks(id),
      CONSTRAINT valid_state CHECK (state IN (-1, 0, 1)),
      CONSTRAINT valid_confidence CHECK (confidence IN ('observed', 'stored', 'accessed', 'confirmed'))
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_state ON blocks(state);
    CREATE INDEX IF NOT EXISTS idx_blocks_category ON blocks(category);
    CREATE INDEX IF NOT EXISTS idx_blocks_confidence ON blocks(confidence);
    CREATE INDEX IF NOT EXISTS idx_blocks_keywords ON blocks(keywords);

    CREATE TABLE IF NOT EXISTS recall_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      blocks_scored INTEGER NOT NULL DEFAULT 0,
      blocks_returned INTEGER NOT NULL DEFAULT 0,
      blocks_voided INTEGER NOT NULL DEFAULT 0,
      void_fraction REAL NOT NULL DEFAULT 0,
      budget_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inhibitions (
      blocker_id INTEGER NOT NULL REFERENCES blocks(id),
      blocked_id INTEGER NOT NULL REFERENCES blocks(id),
      reason TEXT NOT NULL DEFAULT 'superseded',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );
  `);
}
