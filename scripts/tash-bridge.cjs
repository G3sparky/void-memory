#!/usr/bin/env node
/**
 * TASH → Void Memory Bridge
 *
 * Syncs Lauren's health data from TASH app (CT 204) into a dedicated
 * Void Memory tenant. Runs periodically to capture new memories,
 * symptoms, and conversation insights.
 *
 * SAFE: Read-only access to TASH DB. Never modifies Lauren's data.
 * Bridge writes to Void Memory only.
 */

const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const { existsSync, mkdirSync } = require('fs');

const VOID_DB_DIR = '/opt/void-memory/data/lauren';
const VOID_DB_PATH = `${VOID_DB_DIR}/void-memory.db`;
const TASH_DB_LOCAL = '/tmp/tash-bridge-snapshot.db';
const COUNCIL_BUS = 'http://localhost:3216/api/council-bus/send';

// ── Pull TASH DB from CT 204 ──

function pullTashDb() {
  try {
    execSync('ssh root@192.168.1.200 "pct pull 204 /app/tash-health-coach/data/tash.db /tmp/tash-bridge.db"', { timeout: 10000 });
    execSync('scp root@192.168.1.200:/tmp/tash-bridge.db ' + TASH_DB_LOCAL, { timeout: 10000 });
    return true;
  } catch (err) {
    console.error('[tash-bridge] Failed to pull TASH DB:', err.message);
    return false;
  }
}

// ── Init Void Memory DB for Lauren ──

function initVoidDb() {
  if (!existsSync(VOID_DB_DIR)) mkdirSync(VOID_DB_DIR, { recursive: true });

  const db = new Database(VOID_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'fact',
      keywords TEXT DEFAULT '',
      state INTEGER DEFAULT 1,
      confidence TEXT DEFAULT 'stored',
      access_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      accessed_at TEXT,
      supersedes INTEGER REFERENCES blocks(id)
    );
    CREATE TABLE IF NOT EXISTS inhibitions (
      blocker_id INTEGER NOT NULL REFERENCES blocks(id),
      blocked_id INTEGER NOT NULL REFERENCES blocks(id),
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE TABLE IF NOT EXISTS recall_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT,
      blocks_scored INTEGER DEFAULT 0,
      blocks_returned INTEGER DEFAULT 0,
      blocks_voided INTEGER DEFAULT 0,
      void_fraction REAL DEFAULT 0,
      budget_tokens INTEGER DEFAULT 0,
      duration_ms REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      items_synced INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// ── Dedup check ──

function isDuplicate(voidDb, content, keywords) {
  // Check content similarity
  const existing = voidDb.prepare(
    "SELECT id, content, keywords FROM blocks WHERE state = 1 AND keywords LIKE ? LIMIT 10"
  ).all(`%${keywords.split(',')[0]}%`);

  for (const ex of existing) {
    // Simple content overlap check
    const words1 = new Set(content.toLowerCase().split(/\s+/));
    const words2 = new Set(ex.content.toLowerCase().split(/\s+/));
    const overlap = [...words1].filter(w => words2.has(w)).length;
    const ratio = overlap / Math.min(words1.size, words2.size);
    if (ratio > 0.7) return true;
  }
  return false;
}

// ── Store to void memory ──

function storeBlock(voidDb, content, category, keywords) {
  if (isDuplicate(voidDb, content, keywords)) return null;
  const result = voidDb.prepare(
    "INSERT INTO blocks (content, category, keywords, state, confidence, created_at) VALUES (?, ?, ?, 1, ?, datetime('now'))"
  ).run(content, category, keywords, 'stored');
  return result.lastInsertRowid;
}

// ── Sync memories ──

function syncMemories(tashDb, voidDb) {
  const memories = tashDb.prepare('SELECT * FROM memories ORDER BY importance DESC').all();
  let synced = 0;

  for (const m of memories) {
    const keywords = m.content.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 8)
      .join(',');

    const id = storeBlock(voidDb, `[HEALTH MEMORY] ${m.content}`, m.category || 'health', keywords);
    if (id) synced++;
  }
  return synced;
}

// ── Sync symptoms ──

function syncSymptoms(tashDb, voidDb) {
  const symptoms = tashDb.prepare('SELECT * FROM symptoms ORDER BY timestamp DESC').all();
  let synced = 0;

  for (const s of symptoms) {
    const date = s.timestamp ? s.timestamp.split('T')[0] : s.created_at?.split('T')[0] || 'unknown';
    const content = `[SYMPTOM ${date}] Type: ${s.type}, Severity: ${s.severity}/5. ${s.description}`;
    const keywords = `symptom,${s.type},${date},severity-${s.severity}`;

    const id = storeBlock(voidDb, content, 'health', keywords);
    if (id) synced++;
  }
  return synced;
}

// ── Sync food preferences ──

function syncFoodPrefs(tashDb, voidDb) {
  const prefs = tashDb.prepare('SELECT * FROM food_preferences').all();
  let synced = 0;

  for (const p of prefs) {
    const content = `[FOOD PREFERENCE] ${p.food_item}: ${p.sentiment}${p.notes ? ' — ' + p.notes : ''}`;
    const keywords = `food,preference,${p.food_item.toLowerCase()},${p.sentiment}`;

    const id = storeBlock(voidDb, content, 'preference', keywords);
    if (id) synced++;
  }
  return synced;
}

// ── Sync settings/profile ──

function syncProfile(tashDb, voidDb) {
  const settings = tashDb.prepare('SELECT key, value FROM settings').all();
  let synced = 0;

  const profile = {};
  for (const s of settings) profile[s.key] = s.value;

  if (profile.name) {
    const content = `[PROFILE] Name: ${profile.name}. Born: ${profile.birthday || 'unknown'}. Star sign: ${profile.star_sign || 'unknown'}. Goal calories: ${profile.goal_calories || 'unknown'}. Water goal: ${profile.water_goal || 'unknown'}ml. Cycle length: ${profile.cycle_length || 'unknown'} days.`;
    const id = storeBlock(voidDb, content, 'fact', 'lauren,profile,health,goals,calories,water');
    if (id) synced++;
  }

  return synced;
}

// ── Extract insights from recent conversations ──

function syncConversationInsights(tashDb, voidDb) {
  // Get messages from last 7 days that haven't been synced
  const lastSync = voidDb.prepare(
    "SELECT created_at FROM sync_log WHERE source = 'conversations' ORDER BY created_at DESC LIMIT 1"
  ).get();
  const since = lastSync?.created_at || '2000-01-01';

  const messages = tashDb.prepare(
    "SELECT role, content, created_at FROM messages WHERE created_at > ? ORDER BY created_at ASC"
  ).all(since);

  if (messages.length === 0) return 0;

  // Extract health-relevant user messages
  let synced = 0;
  const healthPatterns = [
    /\b(pain|hurt|ache|sore|cramp|bloat|tired|fatigue|exhausted|nausea|dizzy)\b/i,
    /\b(doctor|gp|test|blood|diagnos|medic|prescri|supplement|vitamin)\b/i,
    /\b(period|cycle|ovulat|iud|hormone|pcos|insulin|cortisol|thyroid)\b/i,
    /\b(weight|kg|kilo|diet|eat|food|meal|calori|fast|sugar|carb|protein)\b/i,
    /\b(sleep|insomnia|wake|energy|mood|anxie|depress|stress)\b/i,
    /\b(walk|exercise|gym|active|steps|workout)\b/i,
    /\b(iron|ferritin|b12|folate|magnesium|zinc|berberine|metformin)\b/i,
  ];

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (!msg.content || msg.content.length < 20) continue;

    const isHealthRelevant = healthPatterns.some(p => p.test(msg.content));
    if (!isHealthRelevant) continue;

    const date = msg.created_at ? msg.created_at.split('T')[0] : 'unknown';
    const content = `[CONVERSATION ${date}] Lauren said: "${msg.content.substring(0, 300)}"`;
    const keywords = msg.content.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !['that','this','have','been','just','with','from','about','what','when','them','they','would','could','should','really','don\'t','didn\'t','wasn\'t','can\'t'].includes(w))
      .slice(0, 8)
      .join(',');

    const id = storeBlock(voidDb, content, 'episode', `conversation,${date},${keywords}`);
    if (id) synced++;
  }

  return synced;
}

// ── Main sync ──

async function main() {
  console.log('[tash-bridge] Starting sync...');

  if (!pullTashDb()) {
    console.error('[tash-bridge] Cannot reach TASH DB. Aborting.');
    process.exit(1);
  }

  const tashDb = new Database(TASH_DB_LOCAL, { readonly: true });
  const voidDb = initVoidDb();

  const results = {
    memories: syncMemories(tashDb, voidDb),
    symptoms: syncSymptoms(tashDb, voidDb),
    foodPrefs: syncFoodPrefs(tashDb, voidDb),
    profile: syncProfile(tashDb, voidDb),
    conversations: syncConversationInsights(tashDb, voidDb),
  };

  const total = Object.values(results).reduce((a, b) => a + b, 0);

  // Log sync
  voidDb.prepare(
    "INSERT INTO sync_log (source, items_synced) VALUES ('full-sync', ?)"
  ).run(total);

  // Also log conversation sync time
  voidDb.prepare(
    "INSERT INTO sync_log (source, items_synced) VALUES ('conversations', ?)"
  ).run(results.conversations);

  console.log(`[tash-bridge] Synced ${total} blocks:`, results);

  // Stats
  const stats = voidDb.prepare('SELECT COUNT(*) as c FROM blocks WHERE state = 1').get();
  console.log(`[tash-bridge] Lauren's Void Memory: ${stats.c} active blocks`);

  // Notify on council bus
  try {
    await fetch(COUNCIL_BUS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'arch',
        message: `[TASH BRIDGE] Synced ${total} new blocks to Lauren's Void Memory. Memories: ${results.memories}, Symptoms: ${results.symptoms}, Food: ${results.foodPrefs}, Conversations: ${results.conversations}. Total: ${stats.c} active blocks.`,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}

  tashDb.close();
  voidDb.close();
  console.log('[tash-bridge] Done.');
}

main().catch(err => {
  console.error('[tash-bridge] Error:', err);
  process.exit(1);
});
