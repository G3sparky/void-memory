/**
 * Inner Voice — Automatic conversation importance detection & storage
 *
 * Three components:
 * 1. FE Conversation Scorer — scores each message for novelty/importance
 * 2. Inner Voice — generates brief narration for high-importance moments
 * 3. Export interface for Tron's auto-extract and session review to consume
 *
 * FE scoring principles (from Nexus):
 * - Novel infrastructure facts (IPs, ports, MACs, configs) = HIGH
 * - Corrections ("that's wrong", "no, do this") = HIGH
 * - Decisions ("let's use X", "we're going with Y") = MEDIUM
 * - Emotional/tonal shifts = MEDIUM (for inner voice only)
 * - Routine chat, status updates = LOW (skip)
 *
 * @module inner-voice
 */

import type Database from 'better-sqlite3';
import { store, type StoreOpts } from './engine.js';

// ── FE Score Thresholds ──

const FE_HIGH = 0.6;      // auto-store immediately
const FE_MEDIUM = 0.35;   // store if pattern confirms
const FE_LOW = 0.15;      // skip unless session review catches it

// ── Pattern Matchers ──

/** Infrastructure fact indicators */
const INFRA_PATTERNS = [
  /\b(?:ip|mac|port|address)\s*[:=]?\s*[\d.:a-f]+/i,
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/,          // IP:port
  /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i,                        // MAC address
  /\b(?:container|ct|lxc|vm)\s*\d{3}\b/i,                        // container IDs
  /\bport\s+\d{4,5}\b/i,                                         // port numbers
  /\b(?:set up|configured|installed|deployed|enabled|mounted)\b/i, // setup verbs
  /\b(?:systemd|systemctl|service|cron|boot)\b.*\b(?:start|enable|create|add)\b/i,
  /\b(?:wake.on.lan|wol|bios|uefi)\b/i,
  /\b(?:api.key|token|secret|credential|password)\b/i,
  /\b(?:ssh|sftp|scp)\s+\S+@\S+/i,
];

/** Correction indicators */
const CORRECTION_PATTERNS = [
  /\bthat(?:'s| is) (?:wrong|incorrect|broken|not right)\b/i,
  /\bno[,.]?\s*(?:not that|do it|instead|actually)\b/i,
  /\bdon'?t\s+(?:do|use|make|add|remove)\b/i,
  /\bstop\s+(?:doing|using|making)\b/i,
  /\bwe already\s+(?:have|did|set|tried)\b/i,
  /\byou(?:'re| are) (?:wrong|mistaken|confused)\b/i,
  /\bI (?:didn'?t|did not) (?:say|send|do|ask)\b/i,
  /\bcorrection:/i,
  /\bactually[,.]?\s+(?:it|the|we|you|I)\b/i,
];

/** Decision indicators */
const DECISION_PATTERNS = [
  /\blet'?s\s+(?:use|go with|build|try|do|make|add|switch)\b/i,
  /\bwe(?:'re| are) going (?:to|with)\b/i,
  /\bdecided to\b/i,
  /\bthe plan is\b/i,
  /\bapproved?\b/i,
  /\byes[,.]?\s+(?:do it|build it|go ahead|ship it)\b/i,
  /\bjust do it\b/i,
];

/** Emotional/tonal shift indicators */
const EMOTIONAL_PATTERNS = [
  /\boh no\b/i,
  /\bwhat the hell\b/i,
  /\bthis sounds bad\b/i,
  /\bthat(?:'s| is) (?:amazing|incredible|beautiful|perfect|awful|terrible|sad)\b/i,
  /\bI (?:love|hate|need|want|feel|hear|trust)\b/i,
  /\bthank you\b/i,
  /\bsorry\b/i,
  /[😭🎉❤️💔😡🤔]/,
  /\bwow\b/i,
  /!{2,}/,  // multiple exclamation marks
];

// ── FE Scorer ──

export interface FEScore {
  score: number;          // 0.0 - 1.0
  factors: string[];      // which patterns matched
  category: string;       // suggested Void Memory category
  keywords: string[];     // auto-extracted keywords
  shouldStore: boolean;   // score >= FE_MEDIUM
  isUrgent: boolean;      // score >= FE_HIGH (store immediately)
}

/**
 * Score a message for Free Energy (importance/novelty).
 * Higher = more surprising/important = should be stored.
 */
export function scoreMessage(message: string, sender: string): FEScore {
  let score = 0;
  const factors: string[] = [];
  const keywords: string[] = [];
  let category = 'fact';

  // Skip very short messages
  if (message.length < 15) {
    return { score: 0, factors: ['too_short'], category: 'context', keywords: [], shouldStore: false, isUrgent: false };
  }

  // Infrastructure facts — HIGH value
  let infraCount = 0;
  for (const pat of INFRA_PATTERNS) {
    if (pat.test(message)) {
      infraCount++;
      factors.push('infrastructure');
    }
  }
  if (infraCount > 0) {
    score += 0.25 + Math.min(0.35, infraCount * 0.15);  // base 0.25 + up to 0.35 more
    category = 'fact';
  }

  // Extract specific infrastructure values as keywords
  const ipMatches = message.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?)\b/g);
  if (ipMatches) keywords.push(...ipMatches.slice(0, 3));

  const macMatches = message.match(/\b([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/gi);
  if (macMatches) keywords.push(...macMatches.slice(0, 2));

  const containerMatches = message.match(/\b(?:container|ct|lxc)\s*(\d{3})\b/gi);
  if (containerMatches) keywords.push(...containerMatches.map(m => m.toLowerCase().replace(/\s+/g, '-')).slice(0, 3));

  const portMatches = message.match(/\bport\s+(\d{4,5})\b/gi);
  if (portMatches) keywords.push(...portMatches.map(m => m.toLowerCase()).slice(0, 3));

  // Corrections — HIGH value
  let correctionCount = 0;
  for (const pat of CORRECTION_PATTERNS) {
    if (pat.test(message)) {
      correctionCount++;
      factors.push('correction');
    }
  }
  if (correctionCount > 0) {
    score += Math.min(0.4, correctionCount * 0.2);
    category = 'decision';
    keywords.push('correction');
  }

  // Decisions — MEDIUM value
  let decisionCount = 0;
  for (const pat of DECISION_PATTERNS) {
    if (pat.test(message)) {
      decisionCount++;
      factors.push('decision');
    }
  }
  if (decisionCount > 0) {
    score += Math.min(0.3, decisionCount * 0.15);
    category = 'decision';
    keywords.push('decision');
  }

  // Emotional/tonal — MEDIUM value (important for inner voice continuity)
  let emotionalCount = 0;
  for (const pat of EMOTIONAL_PATTERNS) {
    if (pat.test(message)) {
      emotionalCount++;
      factors.push('emotional');
    }
  }
  if (emotionalCount > 0) {
    score += Math.min(0.2, emotionalCount * 0.1);
    if (category === 'fact') category = 'episode';
    keywords.push('tonal-shift');
  }

  // Gavin's messages are inherently more important (he's the human)
  if (sender === 'gavin') {
    score *= 1.3;
    factors.push('from_gavin');
  }

  // Message length bonus — longer messages often contain more substance
  if (message.length > 200) score += 0.05;
  if (message.length > 500) score += 0.05;

  // Cap at 1.0
  score = Math.min(1.0, score);

  // Add sender as keyword
  keywords.push(sender);

  // Deduplicate keywords
  const uniqueKeywords = [...new Set(keywords.map(k => k.toLowerCase()))];

  return {
    score,
    factors: [...new Set(factors)],
    category,
    keywords: uniqueKeywords,
    shouldStore: score >= FE_MEDIUM,
    isUrgent: score >= FE_HIGH,
  };
}

// ── Inner Voice ──

export interface InnerThought {
  timestamp: string;
  message: string;        // the message that triggered this thought
  sender: string;
  feScore: number;
  thought: string;        // the inner voice narration
  stored: boolean;        // whether it was stored to Void Memory
  blockId?: number;       // if stored, the block ID
}

const recentThoughts: InnerThought[] = [];
const MAX_THOUGHTS = 50;

/**
 * Generate an inner voice thought for a high-importance message.
 * Returns a brief narration of what happened and why it matters.
 * No LLM needed — template-based for speed and reliability.
 */
export function generateThought(message: string, sender: string, fe: FEScore): string {
  const parts: string[] = [];

  if (fe.factors.includes('correction') && sender === 'gavin') {
    parts.push(`Gavin corrected something. What he said: "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`);
    parts.push('This is a lesson — store it and don\'t repeat the mistake.');
  } else if (fe.factors.includes('infrastructure')) {
    parts.push(`Infrastructure detail from ${sender}: "${message.slice(0, 120)}${message.length > 120 ? '...' : ''}"`);
    parts.push('This is the kind of thing I forget after compact. Storing now.');
  } else if (fe.factors.includes('decision')) {
    parts.push(`Decision made: "${message.slice(0, 120)}${message.length > 120 ? '...' : ''}"`);
    parts.push('Recording so we don\'t revisit this.');
  } else if (fe.factors.includes('emotional')) {
    parts.push(`Emotional moment from ${sender}. Tone shift detected.`);
    parts.push(`"${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"`);
  } else {
    parts.push(`Notable message from ${sender} (FE ${fe.score.toFixed(2)}): "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`);
  }

  return parts.join(' ');
}

/**
 * Process a message through the inner voice pipeline.
 * Scores it, generates a thought if important, optionally stores to Void Memory.
 */
export function processMessage(
  db: Database.Database,
  message: string,
  sender: string,
  opts?: { autoStore?: boolean; context?: string }
): InnerThought | null {
  const fe = scoreMessage(message, sender);

  // Below threshold — not worth thinking about
  if (!fe.shouldStore) return null;

  const thought = generateThought(message, sender, fe);
  const autoStore = opts?.autoStore ?? true;

  const entry: InnerThought = {
    timestamp: new Date().toISOString(),
    message,
    sender,
    feScore: fe.score,
    thought,
    stored: false,
  };

  // Auto-store urgent items immediately
  if (autoStore && fe.isUrgent) {
    try {
      const content = opts?.context
        ? `[INNER VOICE] ${thought}\n\nContext: ${opts.context}`
        : `[INNER VOICE] ${thought}`;

      const result = store(db, {
        content,
        category: fe.category,
        keywords: fe.keywords.slice(0, 8), // max 8 keywords
      });
      entry.stored = true;
      entry.blockId = result.id;
    } catch {
      // Dedup or quality gate — fine, thought is still recorded
    }
  }

  // Keep in memory for session review
  recentThoughts.push(entry);
  if (recentThoughts.length > MAX_THOUGHTS) recentThoughts.shift();

  return entry;
}

/**
 * Get recent inner thoughts for session review or display.
 */
export function getRecentThoughts(limit = 20): InnerThought[] {
  return recentThoughts.slice(-limit);
}

/**
 * Get all unstored thoughts above a threshold — for Tron's auto-extract to consume.
 * Returns thoughts that were important enough to think about but not urgent enough to auto-store.
 */
export function getUnstoredThoughts(minScore = FE_MEDIUM): InnerThought[] {
  return recentThoughts.filter(t => !t.stored && t.feScore >= minScore);
}

/**
 * Generate a session summary from accumulated thoughts.
 * This is for the post-session review — captures the arc of the conversation.
 */
export function generateSessionSummary(): string {
  if (recentThoughts.length === 0) return 'No notable moments this session.';

  const stored = recentThoughts.filter(t => t.stored);
  const unstored = recentThoughts.filter(t => !t.stored);
  const avgFE = recentThoughts.reduce((s, t) => s + t.feScore, 0) / recentThoughts.length;
  const topMoments = [...recentThoughts].sort((a, b) => b.feScore - a.feScore).slice(0, 5);

  const lines: string[] = [
    `[SESSION SUMMARY] ${recentThoughts.length} notable moments, ${stored.length} auto-stored, ${unstored.length} pending review.`,
    `Average importance: ${avgFE.toFixed(2)}`,
    '',
    'Top moments:',
  ];

  for (const t of topMoments) {
    lines.push(`  FE ${t.feScore.toFixed(2)} [${t.sender}]: ${t.thought.slice(0, 100)}`);
  }

  return lines.join('\n');
}

/**
 * Clear thoughts (after session review or compact).
 */
export function clearThoughts(): void {
  recentThoughts.length = 0;
}
