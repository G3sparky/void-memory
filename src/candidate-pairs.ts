/**
 * Candidate Pair Logger — Autonomous Learning Loop Component
 *
 * Captures every query-route-recall-response-feedback cycle as structured
 * training data. User reaction IS the implicit label. Zero GPU, ~1ms per write.
 *
 * From Gavin's AUTONOMOUS-LEARNING-LOOP-SPEC.md:
 * - Every query is a training event hiding in plain sight
 * - Feedback inferred from user behavior (accepted/followup/corrected/ignored/negative)
 * - Dream cycle filters and generates LoRA training pairs overnight
 * - The system learns from being used
 *
 * Patent: Self-training ternary neural network with circadian consolidation
 */

import Database from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────

export interface CandidatePair {
  id?: string;
  query_text: string;
  query_intent?: string;
  cell_id?: number;
  domain_label?: string;
  classifier_confidence?: number;
  recalled_block_ids: number[];
  recall_scores?: number[];
  recall_time_ms?: number;
  cluster_count?: number;
  response_model?: string;
  response_length?: number;
  response_time_ms?: number;
  feedback_type: FeedbackType;
  followup_query?: string;
  correction_text?: string;
  time_to_react_ms?: number;
  agent?: string;
  conversation_id?: string;
  turn_number?: number;
  status: PairStatus;
}

export type FeedbackType = 'accepted' | 'followup' | 'corrected' | 'ignored' | 'negative' | 'unknown';
export type PairStatus = 'raw' | 'filtered' | 'trained' | 'discarded';

export interface FeedbackSignal {
  type: FeedbackType;
  followupQuery?: string;
  correctionText?: string;
  timeToReactMs?: number;
}

export interface DailyStats {
  total: number;
  accepted: number;
  followup: number;
  corrected: number;
  ignored: number;
  negative: number;
  unknown: number;
  filtered: number;
  trained: number;
}

// ── Migration ─────────────────────────────────────────────────

export function migrateCandidatePairs(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_pairs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      query_text TEXT NOT NULL,
      query_intent TEXT,
      cell_id INTEGER,
      domain_label TEXT,
      classifier_confidence REAL,
      recalled_block_ids TEXT NOT NULL DEFAULT '[]',
      recall_scores TEXT,
      recall_time_ms INTEGER,
      cluster_count INTEGER,
      response_model TEXT,
      response_length INTEGER,
      response_time_ms INTEGER,
      feedback_type TEXT NOT NULL DEFAULT 'unknown'
        CHECK(feedback_type IN ('accepted', 'followup', 'corrected', 'ignored', 'negative', 'unknown')),
      followup_query TEXT,
      correction_text TEXT,
      time_to_react_ms INTEGER,
      agent TEXT,
      conversation_id TEXT,
      turn_number INTEGER,
      provenance TEXT DEFAULT 'observation',
      generation INTEGER DEFAULT 0,
      status TEXT DEFAULT 'raw'
        CHECK(status IN ('raw', 'filtered', 'trained', 'discarded')),
      filtered_at TEXT,
      trained_at TEXT,
      discard_reason TEXT,
      entropy_flag INTEGER DEFAULT 0,
      entropy_score REAL,
      created_at TEXT DEFAULT (datetime('now')),
      created_date TEXT DEFAULT (date('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cp_date ON candidate_pairs(created_date);
    CREATE INDEX IF NOT EXISTS idx_cp_status ON candidate_pairs(status);
    CREATE INDEX IF NOT EXISTS idx_cp_feedback ON candidate_pairs(feedback_type);
    CREATE INDEX IF NOT EXISTS idx_cp_domain ON candidate_pairs(domain_label);
    CREATE INDEX IF NOT EXISTS idx_cp_conversation ON candidate_pairs(conversation_id);
  `);
}

// ── Feedback Classification ───────────────────────────────────

const ACCEPT_PATTERNS = /^(thanks|cheers|ta|got it|perfect|nice|ok|good|yep|yes|great|cool|awesome|exactly|right|correct|done|sorted)/i;
const CORRECT_PATTERNS = /^(no[,.]?\s|wrong|actually|that's not|incorrect|not quite|fix|change|should be|wait)/i;
const NEGATIVE_PATTERNS = /^(useless|terrible|that doesn't help|wtf|broken|rubbish|stupid|waste|horrible|awful)/i;
const QUESTION_PATTERNS = /^(what|how|why|when|where|who|can you|could you|is there|do you|does|should|would)/i;

export function classifyFeedback(
  responseTimestamp: number,
  nextUserMessage: string | null,
  nextMessageTimestamp: number | null,
  conversationEnded: boolean
): FeedbackSignal {
  if (conversationEnded || nextUserMessage === null) {
    return { type: 'ignored' };
  }

  const reactionTime = nextMessageTimestamp! - responseTimestamp;
  const msg = nextUserMessage.trim();

  if (ACCEPT_PATTERNS.test(msg)) {
    return { type: 'accepted', timeToReactMs: reactionTime };
  }

  if (CORRECT_PATTERNS.test(msg)) {
    return { type: 'corrected', correctionText: nextUserMessage, timeToReactMs: reactionTime };
  }

  if (NEGATIVE_PATTERNS.test(msg)) {
    return { type: 'negative', timeToReactMs: reactionTime };
  }

  if (msg.includes('?') || QUESTION_PATTERNS.test(msg)) {
    return { type: 'followup', followupQuery: nextUserMessage, timeToReactMs: reactionTime };
  }

  // Long gap = probably accepted and moved on
  if (reactionTime > 300000) {
    return { type: 'accepted', timeToReactMs: reactionTime };
  }

  return { type: 'unknown', timeToReactMs: reactionTime };
}

// ── Core Functions ────────────────────────────────────────────

/**
 * Log a candidate pair. Fire and forget — must never block the response.
 */
export function logCandidatePair(db: Database.Database, params: {
  query: string;
  cellId?: number;
  domain?: string;
  classifierConfidence?: number;
  recalledBlockIds: number[];
  recallScores?: number[];
  recallTimeMs?: number;
  clusterCount?: number;
  responseModel?: string;
  responseLength?: number;
  responseTimeMs?: number;
  agent?: string;
  conversationId?: string;
  turnNumber?: number;
}): string | null {
  try {
    const result = db.prepare(`
      INSERT INTO candidate_pairs (
        query_text, cell_id, domain_label, classifier_confidence,
        recalled_block_ids, recall_scores, recall_time_ms, cluster_count,
        response_model, response_length, response_time_ms,
        feedback_type, agent, conversation_id, turn_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)
    `).run(
      params.query,
      params.cellId || null,
      params.domain || null,
      params.classifierConfidence || null,
      JSON.stringify(params.recalledBlockIds),
      params.recallScores ? JSON.stringify(params.recallScores) : null,
      params.recallTimeMs || null,
      params.clusterCount || null,
      params.responseModel || null,
      params.responseLength || null,
      params.responseTimeMs || null,
      params.agent || null,
      params.conversationId || null,
      params.turnNumber || null
    );
    // Return the auto-generated ID
    const row = db.prepare('SELECT id FROM candidate_pairs ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined;
    return row?.id || null;
  } catch (err) {
    console.error('[CandidatePairLogger] Write failed:', err);
    return null;
  }
}

/**
 * Update the previous turn's feedback based on the user's next message.
 */
export function updateFeedback(db: Database.Database, conversationId: string, newMessage: string, newMessageTimestamp: number): void {
  try {
    const pending = db.prepare(`
      SELECT id, created_at FROM candidate_pairs
      WHERE conversation_id = ? AND feedback_type = 'unknown'
      ORDER BY created_at DESC LIMIT 1
    `).get(conversationId) as { id: string; created_at: string } | undefined;

    if (!pending) return;

    const responseTimestamp = new Date(pending.created_at).getTime();
    const feedback = classifyFeedback(responseTimestamp, newMessage, newMessageTimestamp, false);

    db.prepare(`
      UPDATE candidate_pairs
      SET feedback_type = ?, followup_query = ?, correction_text = ?, time_to_react_ms = ?
      WHERE id = ?
    `).run(
      feedback.type,
      feedback.followupQuery || null,
      feedback.correctionText || null,
      feedback.timeToReactMs || null,
      pending.id
    );
  } catch (err) {
    console.error('[CandidatePairLogger] Feedback update failed:', err);
  }
}

/**
 * Close out any unknown pairs when a conversation ends.
 */
export function closeConversation(db: Database.Database, conversationId: string): void {
  db.prepare(`
    UPDATE candidate_pairs
    SET feedback_type = 'ignored'
    WHERE conversation_id = ? AND feedback_type = 'unknown'
  `).run(conversationId);
}

/**
 * Get daily stats for the candidate pair logger.
 */
export function getDailyStats(db: Database.Database, date?: string): DailyStats {
  const d = date || new Date().toISOString().split('T')[0];
  const rows = db.prepare(`
    SELECT feedback_type, status, COUNT(*) as count
    FROM candidate_pairs
    WHERE created_date = ?
    GROUP BY feedback_type, status
  `).all(d) as { feedback_type: string; status: string; count: number }[];

  const stats: DailyStats = { total: 0, accepted: 0, followup: 0, corrected: 0, ignored: 0, negative: 0, unknown: 0, filtered: 0, trained: 0 };
  for (const row of rows) {
    stats.total += row.count;
    if (row.feedback_type in stats) (stats as any)[row.feedback_type] += row.count;
    if (row.status === 'filtered') stats.filtered += row.count;
    if (row.status === 'trained') stats.trained += row.count;
  }
  return stats;
}

/**
 * Flag high-entropy moments. When a correction or followup happens,
 * the PREVIOUS response was a high-entropy miss — the agent should have
 * reasoned more deeply. This is Think-Anywhere applied to our system.
 */
export function flagHighEntropyMoments(db: Database.Database, conversationId: string): number {
  // Find pairs where the feedback was corrected or followup (agent missed something)
  const misses = db.prepare(`
    SELECT id, recall_time_ms, cluster_count, classifier_confidence
    FROM candidate_pairs
    WHERE conversation_id = ? AND feedback_type IN ('corrected', 'followup')
      AND entropy_flag = 0
  `).all(conversationId) as { id: string; recall_time_ms: number | null; cluster_count: number | null; classifier_confidence: number | null }[];

  let flagged = 0;
  const flagStmt = db.prepare(`UPDATE candidate_pairs SET entropy_flag = 1, entropy_score = ? WHERE id = ?`);

  for (const miss of misses) {
    // Compute entropy score based on available signals
    let score = 0.5; // base: correction or followup always has some entropy

    // Low classifier confidence = high entropy
    if (miss.classifier_confidence !== null && miss.classifier_confidence < 0.5) {
      score += 0.2;
    }

    // Many clusters in recall = fragmented knowledge = high entropy
    if (miss.cluster_count !== null && miss.cluster_count > 3) {
      score += 0.1;
    }

    // Slow recall = complex query = potentially high entropy
    if (miss.recall_time_ms !== null && miss.recall_time_ms > 100) {
      score += 0.1;
    }

    score = Math.min(1.0, score);
    flagStmt.run(score, miss.id);
    flagged++;
  }

  return flagged;
}

/**
 * Get high-entropy pairs for dream cycle — these are the most valuable
 * training signals because they show WHERE the brain needs to reason harder.
 */
export function getHighEntropyPairs(db: Database.Database, date?: string): CandidatePair[] {
  const d = date || new Date().toISOString().split('T')[0];
  return db.prepare(`
    SELECT * FROM candidate_pairs
    WHERE created_date = ? AND entropy_flag = 1
    ORDER BY entropy_score DESC
  `).all(d) as CandidatePair[];
}

/**
 * Get raw pairs ready for dream cycle processing.
 */
export function getRawPairsForDreamCycle(db: Database.Database, date?: string): CandidatePair[] {
  const d = date || new Date().toISOString().split('T')[0];
  return db.prepare(`
    SELECT * FROM candidate_pairs
    WHERE created_date = ? AND status = 'raw' AND feedback_type != 'unknown'
    ORDER BY classifier_confidence DESC
  `).all(d) as CandidatePair[];
}

/**
 * Filter pairs for training — keep accepted/followup, extract corrections as negative examples.
 */
export function filterPairsForTraining(db: Database.Database, date?: string): {
  positive: CandidatePair[];
  negative: CandidatePair[];
  discarded: number;
} {
  const d = date || new Date().toISOString().split('T')[0];

  // Positive: accepted and followup with decent classifier confidence
  const positive = db.prepare(`
    SELECT * FROM candidate_pairs
    WHERE created_date = ? AND status = 'raw'
      AND feedback_type IN ('accepted', 'followup')
      AND (classifier_confidence > 0.5 OR classifier_confidence IS NULL)
    ORDER BY classifier_confidence DESC
  `).all(d) as CandidatePair[];

  // Negative: corrections (high value — tells us where routing was wrong)
  const negative = db.prepare(`
    SELECT * FROM candidate_pairs
    WHERE created_date = ? AND status = 'raw' AND feedback_type = 'corrected'
  `).all(d) as CandidatePair[];

  // Mark positive and negative as filtered
  const filterStmt = db.prepare(`UPDATE candidate_pairs SET status = 'filtered', filtered_at = datetime('now') WHERE id = ?`);
  for (const p of [...positive, ...negative]) {
    if (p.id) filterStmt.run(p.id);
  }

  // Discard negative and ignored
  const discardResult = db.prepare(`
    UPDATE candidate_pairs
    SET status = 'discarded', discard_reason = 'negative_or_ignored'
    WHERE created_date = ? AND status = 'raw' AND feedback_type IN ('negative', 'ignored')
  `).run(d);

  return { positive, negative, discarded: discardResult.changes };
}
