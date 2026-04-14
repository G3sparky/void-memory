/**
 * Inner Voice — Free Energy scoring and thought generation
 *
 * Scores incoming messages for importance using heuristic FE signals.
 * High-FE messages get auto-stored; medium ones queue as thoughts
 * for session review. Low ones are ignored.
 *
 * FE (Free Energy) signals:
 * - correction: "actually", "wrong", "fix", "no not" → high priority
 * - decision: "decided", "going to", "will", "chose" → important
 * - infrastructure: ports, IPs, paths, services → store as fact
 * - emotional: urgency, frustration, praise → context matters
 * - identity: agent names, roles, who does what → store
 * - temporal: dates, deadlines, schedules → store with urgency
 *
 * Patent Pending: AU 2026902541, AU 2026902542
 */

import type Database from 'better-sqlite3';

// ── Types ──

interface FEScore {
  score: number;           // 0-1 composite FE score
  signals: string[];       // which heuristics fired
  factors: FEFactor[];     // detailed breakdown
  category: string;        // suggested memory category
  keywords: string[];      // extracted keywords for storage
  urgency: 'low' | 'normal' | 'high' | 'critical';
}

interface FEFactor {
  name: string;
  weight: number;
  matched: boolean;
  detail?: string;
}

interface Thought {
  id: number;
  message: string;
  sender: string;
  thought: string;
  feScore: number;
  category: string;
  keywords: string[];
  stored: boolean;
  timestamp: string;
}

// ── State ──
let thoughtLog: Thought[] = [];
let thoughtIdCounter = 0;

// ── Stopwords ──
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','have','has','had',
  'do','does','did','will','would','could','should','may','might','can',
  'to','of','in','for','on','with','at','by','from','as','into','through',
  'and','but','or','not','so','what','which','who','how','when','where','why',
  'i','me','my','we','you','your','he','him','she','her','it','its',
  'they','them','their','this','that','these','those','just','also','very',
]);

// ── Signal patterns ──

const CORRECTION_PATTERNS = [
  /\b(actually|wrong|incorrect|fix|no not|don't do|stop doing|that's not|broken)\b/i,
  /\b(correction|corrected|should be|instead of|not that|changed to)\b/i,
];

const DECISION_PATTERNS = [
  /\b(decided|decision|going to|will|chose|choosing|approved|confirmed|agreed)\b/i,
  /\b(let's|plan is|strategy|approach will be|we'll|i'll)\b/i,
];

const INFRA_PATTERNS = [
  /\b(port \d+|localhost:\d+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/,
  /\b(container|service|systemctl|restart|deploy|build|server|database)\b/i,
  /\/(opt|etc|home|mnt|var|tmp)\/\S+/,
  /\b(CT \d+|VM \d+|VMID)\b/i,
];

const IDENTITY_PATTERNS = [
  /\b(arch|tron|flynn|grid|beck|claw|gavin|lauren)\b/i,
  /\b(your role|my role|responsible for|in charge of|team lead)\b/i,
  /\b(who (is|are|am)|i am|you are)\b/i,
];

const TEMPORAL_PATTERNS = [
  /\b(deadline|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
  /\b(tomorrow|tonight|today|this week|next week|by end of)\b/i,
  /\b(\d{4}-\d{2}-\d{2}|march|april|may|june|july|august)\b/i,
  /\b(urgent|asap|immediately|right now|critical)\b/i,
];

const EMOTIONAL_PATTERNS = [
  /\b(amazing|love it|perfect|great job|well done|thank you)\b/i,
  /\b(frustrated|annoyed|angry|hate|terrible|awful|broken again)\b/i,
  /\b(worried|concerned|scared|nervous|afraid)\b/i,
  /!{2,}/,  // Multiple exclamation marks
];

const KNOWLEDGE_PATTERNS = [
  /\b(learned|discovered|found out|realized|turns out|TIL)\b/i,
  /\b(the reason|because|caused by|root cause|the issue was)\b/i,
  /\b(remember|don't forget|important:|note:)\b/i,
];

// ── Score a message ──

export function scoreMessage(msg: string, sender: string): FEScore {
  const factors: FEFactor[] = [];
  const signals: string[] = [];
  const keywords: string[] = [];
  let totalScore = 0;

  // Sender weight: Gavin's messages are always high priority, Grid alerts too
  const sLower = sender.toLowerCase();
  const senderWeight = sLower === 'gavin' ? 0.2 : sLower === 'grid' ? 0.1 : 0.05;
  factors.push({ name: 'sender', weight: senderWeight, matched: true, detail: sender });
  totalScore += senderWeight;

  // Correction signals (highest weight — learning from mistakes)
  const correctionMatch = CORRECTION_PATTERNS.some(p => p.test(msg));
  factors.push({ name: 'correction', weight: 0.25, matched: correctionMatch });
  if (correctionMatch) { totalScore += 0.25; signals.push('correction'); }

  // Decision signals
  const decisionMatch = DECISION_PATTERNS.some(p => p.test(msg));
  factors.push({ name: 'decision', weight: 0.15, matched: decisionMatch });
  if (decisionMatch) { totalScore += 0.15; signals.push('decision'); }

  // Infrastructure facts
  const infraMatch = INFRA_PATTERNS.some(p => p.test(msg));
  factors.push({ name: 'infrastructure', weight: 0.15, matched: infraMatch });
  if (infraMatch) { totalScore += 0.15; signals.push('infrastructure'); }

  // Identity information
  const identityMatch = IDENTITY_PATTERNS.some(p => p.test(msg));
  factors.push({ name: 'identity', weight: 0.1, matched: identityMatch });
  if (identityMatch) { totalScore += 0.1; signals.push('identity'); }

  // Temporal/urgency
  const temporalMatch = TEMPORAL_PATTERNS.some(p => p.test(msg));
  factors.push({ name: 'temporal', weight: 0.1, matched: temporalMatch });
  if (temporalMatch) { totalScore += 0.1; signals.push('temporal'); }

  // Emotional content
  const emotionalMatch = EMOTIONAL_PATTERNS.some(p => p.test(msg));
  factors.push({ name: 'emotional', weight: 0.05, matched: emotionalMatch });
  if (emotionalMatch) { totalScore += 0.05; signals.push('emotional'); }

  // Knowledge/learning
  const knowledgeMatch = KNOWLEDGE_PATTERNS.some(p => p.test(msg));
  factors.push({ name: 'knowledge', weight: 0.15, matched: knowledgeMatch });
  if (knowledgeMatch) { totalScore += 0.15; signals.push('knowledge'); }

  // Message length bonus (longer = more content = more important)
  const lengthBonus = Math.min(msg.length / 500, 0.1);
  factors.push({ name: 'length', weight: lengthBonus, matched: msg.length > 50, detail: `${msg.length} chars` });
  if (msg.length > 50) totalScore += lengthBonus;

  // Cap at 1.0
  totalScore = Math.min(totalScore, 1.0);

  // Extract keywords
  const words = msg.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/);
  for (const w of words) {
    if (w.length > 3 && !STOPWORDS.has(w) && keywords.length < 10) {
      keywords.push(w);
    }
  }

  // Determine category
  let category = 'observation';
  if (correctionMatch) category = 'pattern';
  else if (decisionMatch) category = 'decision';
  else if (infraMatch) category = 'infrastructure';
  else if (identityMatch) category = 'fact';
  else if (knowledgeMatch) category = 'fact';
  else if (temporalMatch) category = 'episode';

  // Urgency
  let urgency: 'low' | 'normal' | 'high' | 'critical' = 'low';
  if (totalScore >= 0.7) urgency = 'critical';
  else if (totalScore >= 0.5) urgency = 'high';
  else if (totalScore >= 0.3) urgency = 'normal';

  return { score: Math.round(totalScore * 100) / 100, signals, factors, category, keywords, urgency };
}

// ── Process a message (score + optionally store) ──

export function processMessage(
  db: Database.Database,
  msg: string,
  sender: string,
  opts?: { autoStore?: boolean; context?: string },
): { stored: boolean; feScore: number; thought: string; blockId?: number; category: string; keywords: string[] } {
  const fe = scoreMessage(msg, sender);
  const autoStore = opts?.autoStore ?? false;
  const STORE_THRESHOLD = 0.4;
  const THOUGHT_THRESHOLD = 0.2;

  // Generate thought (condensed version of the message)
  const thought = `[${sender}] ${msg.slice(0, 200)}${msg.length > 200 ? '...' : ''} (FE: ${fe.score}, signals: ${fe.signals.join(', ')})`;

  // Record thought
  const id = ++thoughtIdCounter;
  const entry: Thought = {
    id,
    message: msg,
    sender,
    thought,
    feScore: fe.score,
    category: fe.category,
    keywords: fe.keywords,
    stored: false,
    timestamp: new Date().toISOString(),
  };

  if (fe.score >= THOUGHT_THRESHOLD) {
    thoughtLog.push(entry);
    // Cap thought log at 100
    if (thoughtLog.length > 100) thoughtLog = thoughtLog.slice(-80);
  }

  // Auto-store high-FE messages
  if (autoStore && fe.score >= STORE_THRESHOLD) {
    try {
      const content = fe.signals.includes('correction')
        ? `[CORRECTION from ${sender}] ${msg}`
        : `[${fe.category.toUpperCase()} from ${sender}] ${msg}`;

      const result = db.prepare(
        'INSERT INTO blocks (content, category, keywords, state, confidence, created_at) VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)'
      ).run(content, fe.category, fe.keywords.join(','), 'stored');

      entry.stored = true;
      return {
        stored: true,
        feScore: fe.score,
        thought,
        blockId: Number(result.lastInsertRowid),
        category: fe.category,
        keywords: fe.keywords,
      };
    } catch {
      // Dedup gate or other issue
    }
  }

  return { stored: false, feScore: fe.score, thought, category: fe.category, keywords: fe.keywords };
}

// ── Thought access ──

export function getRecentThoughts(): Thought[] {
  return [...thoughtLog].reverse().slice(0, 20);
}

export function getUnstoredThoughts(): Thought[] {
  return thoughtLog.filter(t => !t.stored && t.feScore >= 0.3);
}

export function clearThoughts() {
  thoughtLog = [];
  thoughtIdCounter = 0;
}

// ── Session summary ──

export function generateSessionSummary(db?: Database.Database): string {
  if (thoughtLog.length === 0) return 'No thoughts recorded this session.';

  const total = thoughtLog.length;
  const stored = thoughtLog.filter(t => t.stored).length;
  const highFE = thoughtLog.filter(t => t.feScore >= 0.5).length;
  const corrections = thoughtLog.filter(t => t.feScore >= 0.4 && t.thought.includes('CORRECTION')).length;

  const topThoughts = [...thoughtLog]
    .sort((a, b) => b.feScore - a.feScore)
    .slice(0, 5)
    .map(t => `  - [FE ${t.feScore.toFixed(2)}] ${t.thought.slice(0, 120)}`)
    .join('\n');

  const categories = new Map<string, number>();
  for (const t of thoughtLog) {
    categories.set(t.category, (categories.get(t.category) || 0) + 1);
  }
  const catSummary = [...categories.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `${cat}: ${count}`)
    .join(', ');

  return [
    `Session: ${total} thoughts, ${stored} stored, ${highFE} high-FE, ${corrections} corrections.`,
    `Categories: ${catSummary}`,
    `Top thoughts:`,
    topThoughts,
  ].join('\n');
}
