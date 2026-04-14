/**
 * Blink Compaction — Continuous incremental context management
 *
 * Biological analogy: Like eye blinking maintains corneal moisture through
 * frequent imperceptible pauses, Blink Compaction maintains context window
 * health through continuous micro-compressions timed to conversation rhythm.
 *
 * Instead of catastrophic auto-compact (surgery), Blink performs tiny 1-3%
 * compressions constantly (hygiene). The context window never fills because
 * maintenance is constant.
 *
 * Inventor: Gavin Saunders, 2026-03-28
 * Patent Pending (separate from AU 2026902541, AU 2026902542)
 */

// ── Types ──

export interface ContextChunk {
  id: string;
  content: string;
  tokens: number;
  timestamp: number;        // when added to context
  lastReferenced: number;   // last time this chunk was relevant
  source: 'user' | 'assistant' | 'system';
  dependencies: string[];   // IDs of chunks this one references
  supersededBy: string | null;  // ID of chunk that replaced this
  state: 'active' | 'void' | 'inhibitory';
  summary: string | null;   // compressed version (set when voided)
}

export interface BlinkResult {
  chunkId: string;
  action: 'skip' | 'void' | 'inhibit';
  reason: string;
  tokensFreed: number;
  bufferExpiry: number;     // timestamp when buffer copy expires
}

export interface BlinkStats {
  totalBlinks: number;
  skipped: number;
  voided: number;
  inhibited: number;
  bufferRecalls: number;    // times content was pulled back from buffer
  tokensFreed: number;
  avgBlinkMs: number;
  currentRate: number;      // blinks per minute
  contextUtilization: number; // 0-1
}

export interface BlinkConfig {
  contextWindowTokens: number;  // total context window size
  charsPerToken: number;        // estimate
  baseBlinkIntervalMs: number;  // relaxed rate (3000-4000ms)
  minBlinkIntervalMs: number;   // intense rate (1000ms)
  emergencyBlinkIntervalMs: number; // continuous (200ms)
  bufferExpiryMs: number;       // how long full text stays in buffer (300000 = 5min)
  maxChunkAge: number;          // ms before a chunk is considered stale
  forcedBlinkThreshold: number; // context utilization that triggers forced blink (0.95)
  emergencyThreshold: number;   // continuous blinking threshold (0.90)
  doubleRateThreshold: number;  // rate doubling threshold (0.70)
}

// ── Defaults ──

const DEFAULT_CONFIG: BlinkConfig = {
  contextWindowTokens: 200_000,
  charsPerToken: 4,
  baseBlinkIntervalMs: 3000,
  minBlinkIntervalMs: 1000,
  emergencyBlinkIntervalMs: 200,
  bufferExpiryMs: 5 * 60 * 1000,  // 5 minutes
  maxChunkAge: 30 * 60 * 1000,    // 30 minutes
  forcedBlinkThreshold: 0.95,
  emergencyThreshold: 0.90,
  doubleRateThreshold: 0.70,
};

// ── Blink Engine ──

export class BlinkEngine {
  private chunks: Map<string, ContextChunk> = new Map();
  private buffer: Map<string, { content: string; expiry: number }> = new Map();
  private config: BlinkConfig;
  private stats: BlinkStats;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private lastBlinkIndex = 0;  // round-robin through chunks
  private chunkIdCounter = 0;

  constructor(config?: Partial<BlinkConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = {
      totalBlinks: 0,
      skipped: 0,
      voided: 0,
      inhibited: 0,
      bufferRecalls: 0,
      tokensFreed: 0,
      avgBlinkMs: 0,
      currentRate: 0,
      contextUtilization: 0,
    };
  }

  // ── Context Management ──

  /** Add a new chunk to the context */
  addChunk(content: string, source: 'user' | 'assistant' | 'system', dependencies: string[] = []): string {
    const id = `chunk_${++this.chunkIdCounter}_${Date.now()}`;
    const tokens = Math.ceil(content.length / this.config.charsPerToken);

    this.chunks.set(id, {
      id,
      content,
      tokens,
      timestamp: Date.now(),
      lastReferenced: Date.now(),
      source,
      dependencies,
      supersededBy: null,
      state: 'active',
      summary: null,
    });

    // Update utilization
    this._updateUtilization();

    return id;
  }

  /** Mark a chunk as referenced (it was useful in the current context) */
  touch(id: string) {
    const chunk = this.chunks.get(id);
    if (chunk) chunk.lastReferenced = Date.now();
  }

  /** Get the current context (all active chunks, ordered) */
  getContext(): ContextChunk[] {
    return [...this.chunks.values()]
      .filter(c => c.state === 'active')
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Get total active tokens */
  getActiveTokens(): number {
    return [...this.chunks.values()]
      .filter(c => c.state === 'active')
      .reduce((sum, c) => sum + c.tokens, 0);
  }

  /** Try to recall content from the retrieval buffer (afterimage) */
  recallFromBuffer(id: string): string | null {
    const entry = this.buffer.get(id);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.buffer.delete(id);
      return null;
    }

    // Successful buffer recall — restore to active context
    this.stats.bufferRecalls++;
    const chunk = this.chunks.get(id);
    if (chunk) {
      chunk.state = 'active';
      chunk.content = entry.content;
      chunk.tokens = Math.ceil(entry.content.length / this.config.charsPerToken);
      chunk.lastReferenced = Date.now();
      chunk.summary = null;
    }
    this.buffer.delete(id);
    return entry.content;
  }

  // ── Blink Cycle ──

  /** Execute a single blink — evaluate and optionally compress one chunk */
  blink(): BlinkResult | null {
    const start = performance.now();
    const activeChunks = [...this.chunks.values()]
      .filter(c => c.state === 'active')
      .sort((a, b) => a.timestamp - b.timestamp);

    if (activeChunks.length === 0) return null;

    // Round-robin: pick the next unchecked chunk (oldest first)
    this.lastBlinkIndex = this.lastBlinkIndex % activeChunks.length;
    const chunk = activeChunks[this.lastBlinkIndex];
    this.lastBlinkIndex++;

    // Score the chunk
    const score = this._scoreChunk(chunk);
    const utilization = this._getUtilization();

    let result: BlinkResult;

    if (chunk.supersededBy) {
      // Superseded — inhibit
      chunk.state = 'inhibitory';
      this._moveToBuffer(chunk);
      result = {
        chunkId: chunk.id,
        action: 'inhibit',
        reason: `superseded by ${chunk.supersededBy}`,
        tokensFreed: chunk.tokens,
        bufferExpiry: Date.now() + this.config.bufferExpiryMs,
      };
      this.stats.inhibited++;
      this.stats.tokensFreed += chunk.tokens;
    } else if (score < 0.3 || (utilization > this.config.doubleRateThreshold && score < 0.5)) {
      // Low relevance — void (compress to summary)
      const summary = this._summarize(chunk);
      this._moveToBuffer(chunk);
      chunk.state = 'void';
      chunk.summary = summary;
      chunk.content = summary;
      const oldTokens = chunk.tokens;
      chunk.tokens = Math.ceil(summary.length / this.config.charsPerToken);
      const freed = oldTokens - chunk.tokens;
      result = {
        chunkId: chunk.id,
        action: 'void',
        reason: `score ${score.toFixed(2)} below threshold`,
        tokensFreed: freed,
        bufferExpiry: Date.now() + this.config.bufferExpiryMs,
      };
      this.stats.voided++;
      this.stats.tokensFreed += freed;
    } else {
      // High relevance — skip
      result = {
        chunkId: chunk.id,
        action: 'skip',
        reason: `score ${score.toFixed(2)} — still relevant`,
        tokensFreed: 0,
        bufferExpiry: 0,
      };
      this.stats.skipped++;
    }

    // Update stats
    this.stats.totalBlinks++;
    const elapsed = performance.now() - start;
    this.stats.avgBlinkMs = (this.stats.avgBlinkMs * (this.stats.totalBlinks - 1) + elapsed) / this.stats.totalBlinks;
    this._updateUtilization();

    // Clean expired buffer entries
    this._cleanBuffer();

    return result;
  }

  /** Execute a forced blink (involuntary reflex) — compresses 5-10% */
  forcedBlink(): BlinkResult[] {
    const results: BlinkResult[] = [];
    const target = Math.ceil(this.chunks.size * 0.07); // ~7% of chunks

    for (let i = 0; i < target; i++) {
      const result = this.blink();
      if (result) results.push(result);
    }

    return results;
  }

  // ── Scoring ──

  private _scoreChunk(chunk: ContextChunk): number {
    const now = Date.now();
    let score = 0;

    // Recency: recently referenced chunks score high
    const msSinceRef = now - chunk.lastReferenced;
    if (msSinceRef < 30_000) score += 0.4;       // last 30s
    else if (msSinceRef < 120_000) score += 0.3;  // last 2min
    else if (msSinceRef < 300_000) score += 0.2;  // last 5min
    else if (msSinceRef < 600_000) score += 0.1;  // last 10min
    // older: 0

    // Source weight: system prompts and recent user messages are more important
    if (chunk.source === 'system') score += 0.3;
    else if (chunk.source === 'user') score += 0.2;
    else score += 0.1; // assistant

    // Dependency: chunks that other active chunks depend on are protected
    const dependents = [...this.chunks.values()]
      .filter(c => c.state === 'active' && c.dependencies.includes(chunk.id));
    if (dependents.length > 0) score += 0.3;

    // Age penalty: very old chunks score lower
    const age = now - chunk.timestamp;
    if (age > this.config.maxChunkAge) score -= 0.2;

    return Math.max(0, Math.min(1, score));
  }

  // ── Compression ──

  private _summarize(chunk: ContextChunk): string {
    // Fast heuristic summary — no LLM needed
    const lines = chunk.content.split('\n').filter(l => l.trim());

    if (lines.length <= 1) {
      // Already short — truncate
      return chunk.content.slice(0, 100) + (chunk.content.length > 100 ? '...' : '');
    }

    // Keep first line (usually the topic/header) + key indicators
    const firstLine = lines[0].slice(0, 100);
    const hasCode = chunk.content.includes('```') || chunk.content.includes('function ');
    const hasDecision = /\b(decided|chose|approved|changed|fixed)\b/i.test(chunk.content);

    let summary = `[blinked] ${firstLine}`;
    if (hasCode) summary += ' [contained code]';
    if (hasDecision) summary += ' [contained decision]';

    return summary;
  }

  // ── Buffer ──

  private _moveToBuffer(chunk: ContextChunk) {
    this.buffer.set(chunk.id, {
      content: chunk.content,
      expiry: Date.now() + this.config.bufferExpiryMs,
    });
  }

  private _cleanBuffer() {
    const now = Date.now();
    for (const [id, entry] of this.buffer) {
      if (now > entry.expiry) this.buffer.delete(id);
    }
  }

  // ── Rate Adaptation ──

  /** Get the current blink interval based on context utilization */
  getCurrentInterval(): number {
    const util = this._getUtilization();

    if (util >= this.config.forcedBlinkThreshold) {
      return this.config.emergencyBlinkIntervalMs; // continuous
    }
    if (util >= this.config.emergencyThreshold) {
      return this.config.emergencyBlinkIntervalMs; // continuous
    }
    if (util >= this.config.doubleRateThreshold) {
      return this.config.baseBlinkIntervalMs / 2; // doubled rate
    }
    if (util < 0.5) {
      return this.config.baseBlinkIntervalMs * 2; // relaxed
    }
    return this.config.baseBlinkIntervalMs;
  }

  // ── Auto-blink (background timer) ──

  startAutoBlinking() {
    if (this.blinkTimer) return;
    this._scheduleNextBlink();
  }

  stopAutoBlinking() {
    if (this.blinkTimer) {
      clearTimeout(this.blinkTimer);
      this.blinkTimer = null;
    }
  }

  private _scheduleNextBlink() {
    const interval = this.getCurrentInterval();
    this.blinkTimer = setTimeout(() => {
      const util = this._getUtilization();

      // Forced blink at 95%+
      if (util >= this.config.forcedBlinkThreshold) {
        this.forcedBlink();
      } else {
        this.blink();
      }

      this.stats.currentRate = 60_000 / interval;
      this._scheduleNextBlink();
    }, interval);
  }

  // ── Utilization ──

  private _getUtilization(): number {
    return this.getActiveTokens() / this.config.contextWindowTokens;
  }

  private _updateUtilization() {
    this.stats.contextUtilization = this._getUtilization();
  }

  // ── Public Stats ──

  getStats(): BlinkStats {
    return { ...this.stats };
  }

  getBufferSize(): number {
    return this.buffer.size;
  }

  /** Signal that a conversation pause occurred — good time to blink */
  onConversationPause() {
    // Blink during natural pauses (like timing blinks to sentence endings)
    this.blink();
  }

  /** Signal that the user sent a short acknowledgement — perfect blink moment */
  onAcknowledgement() {
    // Two blinks during acks — extra maintenance on low-info messages
    this.blink();
    this.blink();
  }
}

// ── Factory ──

export function createBlinkEngine(contextWindowTokens = 200_000): BlinkEngine {
  return new BlinkEngine({ contextWindowTokens });
}
