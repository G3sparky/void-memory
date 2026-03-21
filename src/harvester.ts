/**
 * Void Memory Output Harvester
 * Watches Arch's tmux session, captures substantive output, stores in Void Memory.
 *
 * Design principles:
 * - Captures Arch's responses, not tool output or raw terminal noise
 * - Quality gates: min 50 chars, 40% alpha, dedup via engine
 * - Runs as systemd service, polls every 30s
 * - Stores with category "observation" and confidence "observed"
 */

import { execSync } from 'child_process';
import { openDB } from './db.js';
import { store } from './engine.js';

const TMUX_SESSION = process.argv[2] || 'arch-v2';
const POLL_INTERVAL = 30_000; // 30 seconds
const HISTORY_LINES = 500;    // capture last 500 lines each poll
const MIN_CHUNK_LENGTH = 50;
const MIN_ALPHA_RATIO = 0.4;
const MAX_PER_CYCLE = 5;      // max blocks stored per harvest cycle

const db = openDB();
let lastHash = '';  // track last captured content to avoid re-processing

function captureTmux(): string {
  try {
    return execSync(
      `tmux capture-pane -t ${TMUX_SESSION} -p -S -${HISTORY_LINES}`,
      { encoding: 'utf8', timeout: 5000 }
    );
  } catch {
    return '';
  }
}

/**
 * Extract Arch's response blocks from tmux output.
 * Claude Code output pattern: response text appears between prompt lines (❯)
 * and tool call markers (⎿, ●, ✻, etc.)
 */
function extractResponses(raw: string): string[] {
  const lines = raw.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let inResponse = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines at start
    if (!trimmed && !inResponse) continue;

    // Terminal/tool markers — end of response block
    if (
      trimmed.startsWith('❯') ||
      trimmed.startsWith('⎿') ||
      trimmed.startsWith('●') ||
      trimmed.startsWith('✻') ||
      trimmed.startsWith('✶') ||
      trimmed.startsWith('$') ||
      trimmed.startsWith('root@') ||
      trimmed.match(/^─{5,}/) ||
      trimmed === '? for shortcuts' ||
      trimmed === 'esc to interrupt'
    ) {
      if (inResponse && current.length > 0) {
        chunks.push(current.join('\n').trim());
        current = [];
      }
      inResponse = false;
      continue;
    }

    // Tool call output markers — skip
    if (
      trimmed.startsWith('Read(') ||
      trimmed.startsWith('Edit(') ||
      trimmed.startsWith('Write(') ||
      trimmed.startsWith('Bash(') ||
      trimmed.startsWith('Glob(') ||
      trimmed.startsWith('Grep(')
    ) {
      inResponse = false;
      if (current.length > 0) {
        chunks.push(current.join('\n').trim());
        current = [];
      }
      continue;
    }

    // If we have text content, we're in a response
    if (trimmed.length > 0) {
      inResponse = true;
      current.push(trimmed);
    } else if (inResponse) {
      // blank line within response — keep it as paragraph break
      current.push('');
    }
  }

  // Flush last chunk
  if (current.length > 0) {
    chunks.push(current.join('\n').trim());
  }

  return chunks;
}

/**
 * Extract keywords from text using simple frequency analysis.
 */
function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    'the', 'is', 'at', 'in', 'on', 'to', 'a', 'an', 'and', 'or', 'but',
    'for', 'of', 'with', 'that', 'this', 'it', 'not', 'are', 'was', 'were',
    'be', 'been', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
    'can', 'could', 'should', 'may', 'might', 'shall', 'from', 'by', 'as',
    'if', 'then', 'than', 'so', 'no', 'yes', 'just', 'more', 'also', 'very',
    'its', 'my', 'your', 'we', 'they', 'he', 'she', 'you', 'me', 'him', 'her',
    'our', 'their', 'all', 'each', 'every', 'some', 'any', 'what', 'which',
    'who', 'when', 'where', 'how', 'why', 'there', 'here', 'about', 'into',
    'out', 'up', 'down', 'over', 'under', 'between', 'through', 'after',
    'before', 'during', 'without', 'within', 'along', 'across', 'behind',
    'beyond', 'like', 'only', 'other', 'new', 'old', 'first', 'last', 'long',
    'great', 'little', 'own', 'same', 'big', 'small', 'right', 'still',
    'because', 'while', 'both', 'between', 'being', 'don', 'doesn', 'didn',
    'won', 'isn', 'aren', 'wasn', 'weren', 'hasn', 'haven', 'hadn', 've',
  ]);

  const words = text.toLowerCase().match(/[a-z][a-z'-]+/g) || [];
  const freq = new Map<string, number>();

  for (const w of words) {
    if (w.length < 3 || stopwords.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);
}

/**
 * Simple hash to detect content changes.
 */
function quickHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function harvest() {
  const raw = captureTmux();
  if (!raw) return;

  // Check if content changed
  const hash = quickHash(raw);
  if (hash === lastHash) return;
  lastHash = hash;

  const chunks = extractResponses(raw);
  let stored = 0;
  let skipped = 0;

  for (const chunk of chunks) {
    // Quality gates
    if (chunk.length < MIN_CHUNK_LENGTH) { skipped++; continue; }

    const alphaRatio = (chunk.match(/[a-zA-Z]/g) || []).length / chunk.length;
    if (alphaRatio < MIN_ALPHA_RATIO) { skipped++; continue; }

    // Skip if it looks like a code block, tool output, or terminal UI noise
    if (chunk.startsWith('{') || chunk.startsWith('[') || chunk.startsWith('<')) {
      skipped++;
      continue;
    }
    if (/^[✢✻✶·●⎿]|Moonwalking|Baked for|Cooked for|Percolating|ctrl\+[a-z]/.test(chunk)) {
      skipped++;
      continue;
    }

    const keywords = extractKeywords(chunk);
    if (keywords.length < 2) { skipped++; continue; }

    try {
      const result = store(db, {
        content: chunk.slice(0, 2000), // cap at 2000 chars
        category: 'observation',
        keywords,
        confidence: 'observed',  // lowest tier — invisible to recall until promoted
      });
      if (result.deduped) {
        skipped++;
      } else {
        stored++;
        if (stored >= MAX_PER_CYCLE) break;  // rate limit
      }
    } catch {
      // Quality gate rejection — expected
      skipped++;
    }
  }

  if (stored > 0) {
    const now = new Date().toISOString().slice(0, 19);
    console.log(`[${now}] Harvested ${stored} blocks from ${TMUX_SESSION} (${skipped} skipped)`);
  }
}

// ── Main loop ──
console.log(`Void Memory Harvester started — watching tmux session "${TMUX_SESSION}"`);
console.log(`Poll interval: ${POLL_INTERVAL / 1000}s | Min chunk: ${MIN_CHUNK_LENGTH} chars`);

// Initial harvest
harvest();

// Poll loop
setInterval(harvest, POLL_INTERVAL);
