/**
 * Void Memory Dashboard — HTTP API + static file server.
 * Serves the dashboard UI and provides JSON API for memory stats, recall, and block exploration.
 *
 * Usage: VOID_DATA_DIR=/opt/void-memory/data node dist/dashboard.js [port]
 * Default port: 3410
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { openDB } from './db.js';
import { recall, store, stats, voidZones, type RecallResult } from './engine.js';

const PORT = parseInt(process.argv[2] || '3410');
const PUBLIC_DIR = join(import.meta.url.replace('file://', '').replace('/dist/dashboard.js', '').replace('/src/dashboard.ts', ''), 'public');
const db = openDB();

interface BlockRow {
  id: number;
  content: string;
  category: string;
  keywords: string;
  state: number;
  confidence: string;
  access_count: number;
  created_at: string;
  accessed_at: string | null;
  supersedes: number | null;
}

// ── JSON helpers ──
function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

// ── API Routes ──
async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── API endpoints ──
  if (path === '/api/stats') {
    const s = stats(db);
    const recallLog = db.prepare(`
      SELECT query, blocks_returned, blocks_scored, blocks_voided, void_fraction, duration_ms, budget_tokens, created_at
      FROM recall_log ORDER BY id DESC LIMIT 50
    `).all();
    json(res, { ...s, recent_recalls: recallLog });
    return;
  }

  if (path === '/api/recall' && req.method === 'POST') {
    const body = JSON.parse(await parseBody(req));
    const result = recall(db, body.query, body.budget);
    json(res, {
      blocks: result.blocks,
      void_zones: result.void_zones,
      void_fraction: result.void_fraction,
      budget_used: result.budget_used,
      budget_max: result.budget_max,
      blocks_scored: result.blocks_scored,
      blocks_voided: result.blocks_voided,
      duration_ms: result.duration_ms,
    });
    return;
  }

  if (path === '/api/blocks') {
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
    const offset = (page - 1) * limit;
    const state = url.searchParams.get('state'); // 'active', 'inhibitory', 'all'
    const confidence = url.searchParams.get('confidence');
    const search = url.searchParams.get('q');

    let where = 'WHERE 1=1';
    const params: unknown[] = [];
    if (state === 'active') { where += ' AND state = 1'; }
    else if (state === 'inhibitory') { where += ' AND state = -1'; }
    if (confidence) { where += ' AND confidence = ?'; params.push(confidence); }
    if (search) { where += ' AND (content LIKE ? OR keywords LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const total = (db.prepare(`SELECT COUNT(*) as c FROM blocks ${where}`).get(...params) as any).c;
    const blocks = db.prepare(`SELECT * FROM blocks ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as BlockRow[];

    json(res, { blocks, total, page, limit, pages: Math.ceil(total / limit) });
    return;
  }

  if (path === '/api/block' && url.searchParams.get('id')) {
    const id = parseInt(url.searchParams.get('id')!);
    const block = db.prepare('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow | undefined;
    if (!block) { json(res, { error: 'Block not found' }, 404); return; }

    const inhibitions = db.prepare(`
      SELECT i.*, b.content as blocked_content, b.keywords as blocked_keywords
      FROM inhibitions i JOIN blocks b ON i.blocked_id = b.id
      WHERE i.blocker_id = ?
    `).all(id);

    const inhibitedBy = db.prepare(`
      SELECT i.*, b.content as blocker_content, b.keywords as blocker_keywords
      FROM inhibitions i JOIN blocks b ON i.blocker_id = b.id
      WHERE i.blocked_id = ?
    `).all(id);

    json(res, { block, inhibitions, inhibitedBy });
    return;
  }

  if (path === '/api/void-zones') {
    const query = url.searchParams.get('q') || '*';
    const zones = voidZones(db, query);
    json(res, zones);
    return;
  }

  if (path === '/api/categories') {
    const cats = db.prepare(`
      SELECT category, COUNT(*) as count,
        SUM(CASE WHEN state = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN state = -1 THEN 1 ELSE 0 END) as inhibitory,
        AVG(access_count) as avg_access
      FROM blocks GROUP BY category ORDER BY count DESC
    `).all();
    json(res, cats);
    return;
  }

  if (path === '/api/confidence') {
    const tiers = db.prepare(`
      SELECT confidence, COUNT(*) as count,
        AVG(access_count) as avg_access,
        MIN(created_at) as oldest,
        MAX(created_at) as newest
      FROM blocks WHERE state >= 0 GROUP BY confidence ORDER BY count DESC
    `).all();
    json(res, tiers);
    return;
  }

  if (path === '/api/timeline') {
    const timeline = db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as created,
        SUM(CASE WHEN state = -1 THEN 1 ELSE 0 END) as inhibited
      FROM blocks GROUP BY day ORDER BY day
    `).all();
    json(res, timeline);
    return;
  }

  // ── Static files ──
  let filePath = join(PUBLIC_DIR, path === '/' ? 'index.html' : path);
  if (existsSync(filePath)) {
    const ext = filePath.split('.').pop() || '';
    const types: Record<string, string> = {
      html: 'text/html', js: 'application/javascript', css: 'text/css',
      json: 'application/json', png: 'image/png', svg: 'image/svg+xml',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(readFileSync(filePath));
    return;
  }

  // Fallback to index.html for SPA routing
  if (!path.startsWith('/api/')) {
    const indexPath = join(PUBLIC_DIR, 'index.html');
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(readFileSync(indexPath));
      return;
    }
  }

  json(res, { error: 'Not found' }, 404);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('Request error:', err);
    json(res, { error: err.message }, 500);
  });
});

server.listen(PORT, () => {
  console.log(`Void Memory Dashboard running on http://localhost:${PORT}`);
  console.log(`API: /api/stats, /api/recall, /api/blocks, /api/void-zones, /api/categories, /api/confidence, /api/timeline`);
});
