# Void Recall Engine v2 — Production Spec

**Date:** 2026-03-30
**Author:** Claude (claude.ai) with Lauren (feedback on recall quality)
**Target:** Container 215, drop-in replacement for disc endpoint + Lauren pipeline
**Priority:** Critical — removes 20s Ollama bottleneck, targets <5ms recall

---

## What This Replaces

**Current pipeline (slow, noisy):**
```
Query → keyword router → Void Memory SQLite → Ollama granite 2b (20s) → Opus → response
```

**New pipeline (fast, clustered, triple-scored):**
```
Query → triple-scored in-memory engine (<3ms) → clustered blocks → Opus → response
```

Ollama is removed entirely. The disc endpoint becomes a thin wrapper around the in-memory engine. Lauren receives clustered, deduplicated, contextually complete blocks instead of scattered fragments through a double-LLM chain.

---

## Why This Design

Five alternatives were evaluated:

| Approach | Query Time | Signals Used | Why Not |
|----------|-----------|--------------|---------|
| SQLite FTS5 | 10-50ms | Content only | Disk I/O, ignores classifier + links |
| Vector embeddings (FAISS) | 200ms+ | Semantic | Embedding the QUERY requires API call or local model — blows 5ms budget |
| Plain inverted index (BM25) | <1ms | Content only | Ignores 92.7% classifier AND 118K links |
| Redis cache | 1-5ms | Content only | Extra service, no multi-signal scoring |
| **Triple-scored in-memory** | **<3ms** | **Content + Classifier + Links** | **Uses all three intelligence sources already built** |

The triple-scored approach won because it's the only option that uses everything Gavin already built — the classifier, the link graph, AND the content — with zero disk I/O at query time.

---

## Architecture

### Three Scoring Signals

Every recalled block gets a combined score from three independent signals:

**Signal 1 — BM25 Content Relevance (50% weight)**
Standard BM25 keyword matching against an in-memory inverted index. Handles the "do the words match" question. Tuned for short documents (memory blocks avg 50-200 words) with k1=1.2, b=0.5.

**Signal 2 — Classifier Domain Routing (30% weight)**
The trained classifier (92.7% accuracy on established blocks) assigns each block a domain label and confidence score. At query time, the engine routes the query to the best-matching domain and boosts blocks within it. This replaces the current keyword-based router in the disc endpoint.

**Signal 3 — Link Authority (20% weight)**
118K links in the TASM graph are pre-processed at startup into a PageRank-lite authority score per block. Blocks that many confident sources point to score higher. This captures "community trust" — blocks that are well-connected in the knowledge graph are more likely to be authoritative.

**Final score formula:**
```
score = (0.5 × BM25_normalised) + (0.3 × classifier_confidence × domain_boost) + (0.2 × link_authority)
```

Weights are configurable and should be tuned via A/B testing with Lauren's feedback.

### Memory Footprint

| Component | Size | Notes |
|-----------|------|-------|
| Block content | ~7MB | 12K blocks × ~600 bytes avg |
| Inverted index | ~2MB | term → block ID sets |
| Link authority scores | ~96KB | 12K × 8 bytes |
| Domain routing table | ~48KB | domain → block ID sets |
| Neighborhood map | ~1MB | block → 1-hop neighbor sets |
| **Total** | **~10MB** | Trivial for the NAS |

---

## Lauren's Requirements (from direct conversation)

These came from asking Lauren what actually helps vs what's noise. Every design decision below traces back to her feedback.

### 1. Noise Filtering at Index Time

**Lauren's input:** "Anything below 0.3 confidence is usually garbage. Those vague 'complex decision' blocks are always 0.2-0.25. But a 0.4 block with 3+ inbound links is gold."

**Rule:** At startup, exclude blocks where:
- `confidence < 0.3` AND `inbound_links < 2`

Blocks at 0.3-0.5 with strong link connections survive because they're connective tissue between important blocks. This kills an estimated 15-20% of dead weight before any query runs.

### 2. Deduplication at Index Time

**Lauren's input:** "Sometimes I get the same fact worded slightly differently eating up 2-3 slots."

**Rule:** During startup load, after tokenising all blocks:
- For each pair of blocks in the same domain, compute token overlap
- If two blocks share >70% of non-stopword tokens AND same domain:
  - Keep the block with higher link authority
  - Transfer all links from the loser to the winner
  - Discard the duplicate

For 12K blocks this is O(n²) within each domain, but domains partition the space so it's manageable (~50ms at startup). Zero cost at query time.

### 3. Clustered Results (Not Flat Lists)

**Lauren's input:** "If your engine could group related blocks — like 'here's 3 blocks about Flynn's test results as a unit' rather than scattered through my context. Easier to ignore whole groups I don't need."

**Implementation:** After scoring, before returning results:

1. Take the top ~15 scored blocks (overshoot the final count)
2. Group blocks that share direct links in the TASM graph
3. For each cluster:
   - Theme label = dominant domain + top keywords from highest-scoring block
   - Cluster score = max score of any block in the cluster
4. Sort clusters by cluster score, return top 2-3 clusters
5. Target: 5-6 total blocks across 2-3 clusters

**Output format:**
```
CLUSTER: "Flynn classifier tests" (3 blocks, score 0.87)
├── Classifier hit 86.7% accuracy on established blocks
├── Baseline was 17.5% with rectangular geometry
└── Test date 2026-02-15, used ternary Flower of Life weights

CLUSTER: "Void fraction invariance" (2 blocks, score 0.72)
├── All 7 cells show 28.9/42.2/28.9 distribution
└── Training was LoRA r=16, 50 pairs, 40 epochs per cell
```

Lauren scans all blocks but really uses 3-4. Clusters let her grab a complete thought and skip irrelevant groups in one glance.

### 4. Context Trails via Neighbor Boosting

**Lauren's input:** "When I get 'Flynn achieved 86.7%' I need to know WHAT test, WHEN, compared to WHAT baseline. The isolated facts are there but the connective tissue is missing."

**Implementation:** When a block scores well via BM25, its 1-hop neighbors in the TASM graph get a 15% score boost. This pulls in connected context — the baseline number, the test date, the methodology — without an extra query.

Neighbors that are already candidates don't get double-counted. Neighbors outside the domain filter are excluded.

### 5. One-Step-Back Soft Context

**Lauren's input:** "Keep the last recall as 'soft context' with like 20% weight. If the new query overlaps keywords/domain with previous, boost. If different domain entirely, let them fade."

**Implementation:** The engine keeps the previous query's top results in a lightweight cache:

```typescript
interface SoftContext {
  previousResults: RecallResult[];
  previousDomain: string;
  previousTerms: string[];
}
```

On the next query:
- Compute domain overlap between current and previous query
- If same domain or >30% keyword overlap: previous blocks get 20% score boost
- If completely different domain: soft context is cleared, fresh query

This handles Gavin's rapid-fire pattern:
- Q1: "Flynn's tests?" → fresh recall, Flynn results cached
- Q2: "What about the geometry?" → overlapping terms, Flynn blocks boosted
- Q3: "Is Tron done with the dashboard?" → different domain, cache cleared

### 6. Ollama Removal

**Lauren's input:** "Ollama step is mostly useless. Just let me see the raw blocks faster. I'm better at interpreting Gav's ADHD queries than Ollama anyway."

The disc endpoint stops calling Ollama. Recalled blocks go directly into Lauren's system prompt for Opus. One LLM call, not two.

### 7. Turn-Gated Recall (Round 2)

**Lauren's input:** "By turn 15-20 the recalled blocks are basically decoration. The conversation IS the context by then."

**Rule:** Recall fires automatically on turns 1-4 of a conversation. After turn 4, recall only fires if the message contains:
- A proper noun that exists in the inverted index (project-specific name)
- A number (likely referencing a specific result)
- A question word (who/what/when/where/how) plus a name

"Yeah I agree" at turn 12 → no recall, save the context window.
"What did Flynn get on that test?" at turn 12 → recall fires.

### 8. Query Classification Gate (Round 2)

**Lauren's input:** "If someone asks 'what's Python?' I'm ignoring recalls completely. Skip when generic, recall when specific to Gav's world."

**Rule:** Before recall runs, classify the query:
- Check if ANY query term appears in the inverted index with low document frequency (< 5% of total blocks). Low DF = rare term = project-specific.
- If no project-specific terms found → skip recall entirely. Empty injection.
- If at least one project-specific term → recall fires normally.

This saves context window space for generic knowledge queries where recalled blocks would just be noise.

### 9. Dual-Channel with Tagging (Round 2)

**Lauren's input:** "Keep Channel 1 separate! Those 864 blocks are MY memory of our actual life. Different trust level. Tag them [PERSONAL] vs [PROJECT]."

**Implementation:** Lauren's 864 personal blocks load into a separate in-memory index using the same BM25 engine. Both channels feed into the same cluster output but blocks are tagged:

```
── [PERSONAL] family: addi, school, milestone (score: 0.82) ──
• [2026-01-15] Addi lost her first tooth, was so excited
• [2026-02-20] Addi started reading chapter books at school

── [PROJECT] testing: classifier, accuracy (score: 0.79) ──
• [2026-02-15] Classifier hit 86.7% with ternary FoL geometry
```

**Personal recall gate:** Personal blocks only fire when a family name appears WITH a question word in the query. "Addi's got a thing Thursday" in a work conversation → no personal recall. "How's Addi going?" → personal blocks fire. Prevents life context cluttering work conversations.

### 10. Timestamps in Cluster Output (Round 2)

**Lauren's input:** "PLEASE add timestamps! I'm guessing based on context clues which sucks. Sometimes the old number matters ('up from X'), sometimes just the newest ('currently at Y')."

**Implementation:** Every block carries its creation date. Blocks within each cluster are sorted date ascending (oldest first) so Lauren reads the timeline naturally. Format is date-only `[YYYY-MM-DD]`, no time component.

```
── testing: classifier, accuracy, baseline (score: 0.87) ──
• [2026-02-01] Baseline classifier at 17.5% with rectangular geometry
• [2026-02-15] Classifier improved to 86.7% with ternary Flower of Life
• [2026-02-15] 28.6% on new/unseen blocks — popularity predictor limitation
```

Lauren sees the chronology, tells the story. Engine doesn't interpret contradictions, just presents ordered facts.

### 11. Provenance Chain — Stopping the Echo Loop (Round 2)

**Lauren's input:** "Last week I mentioned 'void fraction at 39%' from an old block, then yesterday saw MY OWN WORDS come back as a 'new' fact. I'm quoting old data, not Flynn running fresh tests!"

**The problem:** When Lauren quotes recalled data in a response, and the Clerk captures that response as a new block, old information gets laundered into "new" blocks with today's date. The timestamp lies. Lauren starts quoting herself in an infinite loop.

**Solution — Generational confidence decay:**

Every block gets two new fields:

```typescript
generation: number;      // 0 = primary source, 1 = derived, 2 = second-hand
derivedFrom: string[];   // Block IDs of the primary sources this was extracted from
```

Decay rules:

| Generation | Source | Confidence Multiplier | Indexed? |
|-----------|--------|----------------------|----------|
| 0 (PRIMARY) | Direct output: test results, Gavin's input, real measurements | × 1.0 | Always |
| 1 (DERIVED) | Extracted from a conversation where gen-0 blocks were recalled | × 0.7 | Yes, if not duplicate |
| 2 (SECOND-HAND) | Extracted from a conversation where gen-1 blocks were recalled | × 0.49 | Yes, if not duplicate |
| 3+ | Telephone game territory | N/A | **Never indexed** |

**Write-time rules (for the Clerk or any ingestion system):**

1. When writing a new block, check if the conversation had recalled blocks injected
2. If yes: new block is generation = max(recalled generations) + 1
3. If the new block overlaps 70%+ with any recalled block: set `derivedFrom` to that block's ID
4. If generation would be 3+: skip the write entirely

**Query-time rules (engine dedup):**

- If a gen-1+ block overlaps 70% with a gen-0 block in the same domain: exclude the derived block
- Primary always wins
- When both are recalled, show only the primary with its original date

**Clerk signal words:** If Lauren's response contains phrases like "recalling that", "as mentioned", "from earlier", "previously noted" — the Clerk should flag the following fact as derived, not primary. This is a soft signal, not a hard rule — the generation tracking catches what the signal words miss.

### 12. Anaphora Resolution — Conversation History Fallback (Round 3)

**Lauren's input:** "When Gav says 'that percentage' I'm literally scanning back like 'okay what numbers were we just talking about?' The engine should do the same!"

**The problem:** At turn 10, Gavin says "What was that percentage again?" No proper nouns, no project-specific terms. The query classification gate would skip recall. But Gavin clearly wants specific recalled data — he's using "that" to refer to something from earlier in the conversation.

**Solution — Conversation history fallback:**

When a query has no project-specific terms BUT contains vague reference words ("that", "this", "it", "those", "the thing"), the engine scans the last 2-3 user messages for anchor terms:

1. Detect vague references in query: "that", "this", "it", "those", "the", "thing", "one"
2. If found AND no project-specific terms in query AND recentMessages provided:
3. Scan recent messages (most recent first) for:
   - Project-specific terms (low document frequency in inverted index)
   - Numbers (likely the referent of "that percentage")
   - Capitalised words after sentence start (proper nouns)
4. Append up to 6 anchor terms to the original query
5. Re-check query classification with enriched query

**Example:**
```
Turn 8: "Flynn hit 86.7% accuracy"
Turn 9: "Oh btw did you see the news?"     (domain shift, soft context clears)
Turn 10: "What was that percentage again?"

Without resolution: "what percentage" → no specific terms → skip recall → no blocks
With resolution: scans back, finds "flynn", "86.7", "accuracy"
  → searches "what was that percentage again flynn accuracy 86.7"
  → classifier accuracy blocks recalled cleanly
```

**Integration:** Caller passes `recentMessages: string[]` (last 2-3 user messages) in the RecallQuery. The engine handles the rest. If no recent messages provided, vague queries simply skip recall — safe fallback.

---

## Data Flow

### Startup (runs once, ~200ms)

```
1. Open SQLite connections to void-memory.db and tasm-memory.db
2. Load classifier-scores.json
3. Load all blocks where content IS NOT NULL and length > 10
4. Apply noise filter: drop blocks with confidence < 0.3 AND links < 2
5. Tokenise each block, build term frequency maps
6. Build inverted index (term → Set<blockId>)
7. Build domain index (domain → Set<blockId>)
8. Run deduplication within each domain (70% overlap threshold)
9. Load all links from TASM
10. Compute link authority (inbound count × avg confidence, normalised to 0-1)
11. Build neighborhood map (block → Set<1-hop neighbor IDs>)
12. Compute average document length for BM25 normalisation
13. Log stats: blocks loaded, terms indexed, links processed, load time
```

### Query (runs per request, target <3ms)

```
0. Turn gate: if turn > 4, check for specific terms              [< 0.1ms]
   - If not specific → check for vague references
0b. Anaphora resolution: if vague refs + no specific terms:       [< 0.2ms]
   - Scan last 2-3 messages for proper nouns, numbers, rare terms
   - Enrich query with anchor terms
1. Query classification: any project-specific terms now?          [< 0.1ms]
   - If still none → skip recall, return empty
2. Tokenise enriched query text                                   [< 0.1ms]
3. Route to domain:
   - If domain specified → use it
   - Else → count term overlap per domain, pick best              [< 0.2ms]
3. Gather candidates via inverted index:
   - For each query term, look up posting list
   - Compute BM25 score per candidate block
   - Filter to domain                                     [< 1.0ms]
4. Boost 1-hop neighbors of candidates (15% boost)        [< 0.3ms]
5. Apply soft context boost (20% if domain overlaps)      [< 0.1ms]
6. Triple score: BM25 × 0.5 + classifier × 0.3 + authority × 0.2  [< 0.2ms]
7. Cluster by link proximity                              [< 0.3ms]
8. Label clusters (domain + top keywords)                 [< 0.1ms]
9. Return top 2-3 clusters, 5-6 blocks total              [< 0.1ms]
                                                   TOTAL: [< 2.5ms]
```

### Lauren's Pipeline (per conversation turn)

```
1. Gavin sends message
2. Turn check: if turn > 4, check for proper nouns/numbers/names  [< 0.1ms]
   - If no specific terms → skip to step 5 (no recall)
3. Query classification: any project-specific terms?              [< 0.1ms]
   - If generic query → skip to step 5 (no recall)
4. Engine.recall({ text: message, topK: 6 })                     [< 3ms]
   - Includes personal channel if family name + question word
   - Tags blocks [PERSONAL] or [PROJECT]
   - Sorts within clusters by date ascending
5. Format clusters into system prompt injection (or empty string)
6. Send to Opus via Gavin Router (CT 203, port 3333)             [1-3s network]
7. Opus generates response as Lauren with recalled context
8. Cache this query's results as soft context for next turn
```

---

## Technical Specification

### Core Types

```typescript
interface VoidBlock {
  id: string;
  content: string;
  keywords: string[];
  domain: string;              // From classifier routing
  confidence: number;          // Classifier confidence 0-1
  source: string;
  linkAuthority: number;       // Pre-computed from link graph
  termFreqs: Map<string, number>;
  docLength: number;
}

interface RecallCluster {
  theme: string;               // "Flynn classifier tests"
  domain: string;              // "testing"
  score: number;               // Max block score in cluster
  blocks: RecallResult[];      // Ordered by score within cluster
}

interface RecallResult {
  blockId: string;
  content: string;
  domain: string;
  score: number;
  breakdown: {
    bm25: number;
    classifier: number;
    authority: number;
    softContext: number;        // 0 or the boost amount
  };
}

interface RecallQuery {
  text: string;
  domain?: string;             // Force domain (skip auto-routing)
  topK?: number;               // Default 6 (Lauren's preferred max)
  maxClusters?: number;        // Default 3
  minScore?: number;           // Default 0.01
  boostLinked?: boolean;       // Default true
  useSoftContext?: boolean;    // Default true
}

interface EngineConfig {
  weights: {
    bm25: number;              // Default 0.5
    classifier: number;        // Default 0.3
    authority: number;         // Default 0.2
  };
  bm25: {
    k1: number;                // Default 1.2
    b: number;                 // Default 0.5
  };
  filtering: {
    minConfidence: number;     // Default 0.3
    minLinksAtLowConf: number; // Default 2
    dedupThreshold: number;    // Default 0.7 (70% token overlap)
  };
  clustering: {
    maxClusters: number;       // Default 3
    maxBlocksTotal: number;    // Default 6
    neighborBoost: number;     // Default 0.15
    softContextBoost: number;  // Default 0.20
    softContextDecay: number;  // Default 0.30 (domain overlap threshold)
  };
}
```

### BM25 Parameters

Tuned for short documents (memory blocks, not web pages):

- **k1 = 1.2** — term frequency saturation. Standard value.
- **b = 0.5** — length normalisation. Lower than default (0.75) because memory blocks are intentionally short. Don't penalise concise blocks.

### Link Authority Computation

Simplified PageRank (one pass, not iterative):

```
authority(block) = inbound_link_count × avg(linker_confidence)
```

Normalised to 0-1 by dividing by the maximum authority score across all blocks. For 118K links this takes ~2ms at startup.

If full iterative PageRank is wanted later, the interface stays the same — just swap the computation function.

### Clustering Algorithm

After scoring all candidates:

1. Take the top 15 blocks by score (overshoot)
2. Build an adjacency set: for each block, which other top-15 blocks are its 1-hop neighbors?
3. Greedy clustering: start with highest-scoring unassigned block, pull in all its connected neighbors from the top-15 set
4. If a cluster exceeds 3 blocks, keep only the top 3 by score
5. Label: `"{domain}: {keyword1}, {keyword2}"` from the top block
6. Sort clusters by max score, return top `maxClusters`
7. Total blocks across all clusters capped at `maxBlocksTotal`

### Soft Context Cache

```typescript
interface SoftContext {
  results: RecallResult[];
  domain: string;
  terms: Set<string>;
  timestamp: number;
}
```

- Stored per conversation (keyed by conversation ID)
- Only holds the last query's results (not a growing history)
- Expires after 5 minutes of inactivity
- Domain overlap check: intersection of current and previous term sets, divided by union size. If > 0.3, apply boost.

---

## File Locations

### New Files

| File | Purpose |
|------|---------|
| `/opt/void-memory/src/void-recall-engine.ts` | Core engine (this spec) |
| `/opt/void-memory/src/recall-types.ts` | Type definitions |
| `/opt/void-memory/src/recall-clustering.ts` | Cluster formation + labelling |
| `/opt/void-memory/src/recall-dedup.ts` | Deduplication at index time |
| `/opt/void-memory/src/recall-test.ts` | Unit tests |

### Modified Files

| File | Change |
|------|--------|
| `/opt/neogate-v2/src/api/rest.ts` | Disc endpoint calls engine.recall() instead of SQLite + Ollama |
| `/opt/neogate-v2/src/neochat2/lauren.ts` | Remove Ollama call, inject clustered blocks directly into Opus prompt |
| Server startup (app.ts or equivalent) | Instantiate engine, load at startup, pass to route handlers |

### Data Files (read-only at query time)

| File | Used For |
|------|----------|
| `/opt/void-memory/data/void.db` | Block content (read at startup) |
| `/opt/neogate-v2/data/tasm-memory.db` | Links (read at startup) |
| `/opt/void-memory/data/classifier-scores.json` | Domain labels + confidence (read at startup) |

---

## REST Endpoints

### New

```
GET /api/v2/recall/query?q={text}&domain={optional}&topK={optional}
  → Returns clustered recall results with timing

GET /api/v2/recall/stats
  → Engine stats: block count, term count, link count, domains, load time, last query time

GET /api/v2/recall/domains
  → List all domains with block counts

POST /api/v2/recall/rebuild
  → Force engine rebuild from databases (after new blocks added)

GET /api/v2/recall/test?q={text}
  → Debug endpoint: returns full scoring breakdown per block, clustering details, timing
```

### Modified

```
POST /api/v2/disc/ask
  → Now calls engine.recall() instead of SQLite + Ollama
  → Returns blocks directly (no Ollama interpretation)
  → Response time drops from ~20s to <5ms

POST /api/v2/lauren/chat
  → Removes Ollama channel
  → Channel 1: Lauren's own Void Memory (keyword search, kept as-is)
  → Channel 2: engine.recall() (replaces disc + Ollama)
  → Clusters formatted into system prompt for Opus
```

---

## System Prompt Format for Lauren

When injecting recalled blocks into Lauren's Opus prompt:

```
RECALLED MEMORIES (from Void Memory, scored by relevance):

── [PROJECT] testing: classifier, accuracy, baseline (score: 0.87) ──
• [2026-02-01] Baseline classifier at 17.5% with rectangular geometry
• [2026-02-15] Classifier improved to 86.7% with ternary Flower of Life
• [2026-02-15] 28.6% on new/unseen blocks — popularity predictor limitation

── [PROJECT] void fraction: invariance, cells, training (score: 0.72) ──
• [2026-02-10] All 7 BitNet cells show identical 28.9/42.2/28.9 trit distribution
• [2026-02-10] Training: LoRA r=16, 50 pairs per cell, 40 epochs, ~8 min each
```

Mixed channel example (when personal recall gate fires):

```
── [PERSONAL] family: addi, school (score: 0.82) ──
• [2026-01-15] Addi lost her first tooth
• [2026-02-20] Addi started reading chapter books

── [PROJECT] tafe: teaching, curriculum (score: 0.68) ──
• [2026-02-25] Gavin restructuring EE curriculum for semester 2
```

Rules:
- Channel tag [PERSONAL] or [PROJECT] on every cluster header
- Date stamp [YYYY-MM-DD] on every block
- Blocks sorted oldest-first within each cluster (timeline order)
- Cluster theme as domain + top 3 keywords with score
- Maximum 5-6 blocks across 2-3 clusters
- If no blocks score above minScore, inject nothing
- If turn > 4 and no specific query terms detected, inject nothing

---

## Verification Plan

### Unit Tests

```
SUITE: Tokeniser
  ✓ Removes stopwords
  ✓ Preserves code terms (hyphens, dots, underscores)
  ✓ Lowercases everything
  ✓ Splits on whitespace and punctuation

SUITE: BM25
  ✓ Higher term frequency → higher score (with saturation)
  ✓ Rare terms score higher than common terms (IDF)
  ✓ Short docs not unfairly penalised (b=0.5)

SUITE: Noise Filter
  ✓ Blocks with confidence < 0.3 and < 2 links excluded
  ✓ Blocks with confidence < 0.3 but ≥ 2 links kept
  ✓ Blocks with confidence ≥ 0.3 always kept

SUITE: Deduplication
  ✓ 70%+ overlap in same domain → merged
  ✓ 70%+ overlap in different domains → both kept
  ✓ Winner inherits loser's links
  ✓ 60% overlap → both kept (under threshold)
  ✓ Gen 0 beats gen 1 on overlap regardless of link count
  ✓ Gen 1 beats gen 2 on overlap
  ✓ Same generation falls back to link authority

SUITE: Provenance
  ✓ Gen 0 blocks have full confidence
  ✓ Gen 1 blocks get 0.7× confidence decay
  ✓ Gen 2 blocks get 0.49× confidence decay
  ✓ Gen 3+ blocks never loaded into index
  ✓ derivedFrom links preserved through load

SUITE: Link Authority
  ✓ Block with many inbound links → high authority
  ✓ Block with zero inbound links → authority 0
  ✓ Authority normalised to 0-1

SUITE: Triple Scoring
  ✓ All three signals contribute to final score
  ✓ Weights sum to 1.0
  ✓ Domain mismatch reduces classifier component

SUITE: Clustering
  ✓ Linked blocks group together
  ✓ Unlinked blocks form singleton clusters
  ✓ Cluster label reflects domain + keywords
  ✓ Max blocks per cluster respected
  ✓ Total blocks across clusters capped
  ✓ Blocks sorted date ascending within clusters (timeline order)
  ✓ Cluster has [PERSONAL] or [PROJECT] channel tag
  ✓ Timestamps appear on every block in formatted output

SUITE: Turn Gating
  ✓ Turns 1-4 always fire recall
  ✓ Turn 5+ with proper noun → fires
  ✓ Turn 5+ with number → fires
  ✓ Turn 5+ with question word + project term → fires
  ✓ Turn 5+ with "yeah I agree" → skips recall
  ✓ Turn 5+ with "cool keep going" → skips recall

SUITE: Query Classification
  ✓ "What's Python?" → no project terms → skip recall
  ✓ "How did Flynn's classifier do?" → rare terms → fire recall
  ✓ "void fractions" → rare terms → fire recall
  ✓ "hello how are you" → no rare terms → skip recall

SUITE: Anaphora Resolution
  ✓ "What was that percentage?" + recent "Flynn hit 86.7%" → enriches with "flynn 86.7"
  ✓ "Tell me more about it" + recent "TASM memory system" → enriches with "tasm memory"
  ✓ Query without vague words → no enrichment
  ✓ No recentMessages provided → no enrichment, safe fallback
  ✓ Caps anchor terms at 6 to keep query focused
  ✓ After enrichment, query classification re-checks and fires recall

SUITE: Personal Recall Gate
  ✓ "How's Addi going?" → family name + question word → fires personal
  ✓ "Addi's got a thing Thursday" → no question word → skips personal
  ✓ "What's the weather?" → no family name → skips personal

SUITE: Soft Context
  ✓ Same-domain follow-up → previous blocks boosted 20%
  ✓ Different-domain query → soft context cleared
  ✓ Expires after 5 minutes
  ✓ Partial keyword overlap → proportional boost

SUITE: Full Pipeline
  ✓ Simple query returns relevant clusters in < 5ms
  ✓ Domain-filtered query narrows results correctly
  ✓ Empty query returns empty results (no crash)
  ✓ Unknown terms return empty results gracefully
```

### Integration Tests

```
TEST: Disc endpoint latency
  Before: ~20,000ms (Ollama)
  After: < 10ms (engine.recall + HTTP overhead)
  Method: 10 queries, measure avg response time

TEST: Lauren pipeline latency
  Before: ~22,000ms (Ollama + Opus)
  After: ~2,000ms (engine.recall + Opus only)
  Method: 5 conversation turns, measure avg response time

TEST: Recall quality (Lauren judges)
  Method: 20 test queries, Lauren rates each recall set
  Before: 60-70% useful (Lauren's honest baseline)
  Target: 85-90% useful
  Measured by: Lauren's subjective rating per cluster

TEST: Context completeness
  Method: 10 queries requiring multi-fact answers
  Measure: Does the cluster include the connective tissue?
  Example: "Flynn's accuracy" should return score + baseline + date
  Target: 8/10 queries return complete context trails

TEST: Deduplication effectiveness
  Method: Count unique facts in recalled blocks vs total blocks
  Before: ~70% unique (30% near-duplicates)
  Target: 95%+ unique after dedup
```

### Benchmark Script

```bash
# Run after deployment — compare before/after
# Save results to /opt/void-memory/RECALL-BENCHMARK.md

TEST_QUERIES=(
  "What did Flynn's classifier achieve?"
  "Tell me about the void fraction"
  "What's the Flower Brain architecture?"
  "How does Lauren's pipeline work?"
  "What tests has Tron run?"
  "Explain the ternary weight distribution"
  "What's running on the NAS?"
  "How does the disc endpoint work?"
  "What's the classifier accuracy?"
  "Describe the BitNet cell training"
)

for query in "${TEST_QUERIES[@]}"; do
  curl -s -w "\n%{time_total}s" \
    "http://localhost:3216/api/v2/recall/test?q=$(urlencode "$query")"
done
```

---

## Rollback

If anything breaks:

1. The engine is a new module — removing it doesn't affect existing code
2. Disc endpoint: revert to previous SQLite + Ollama call (comment swap)
3. Lauren pipeline: revert to previous two-channel approach (comment swap)
4. No database schema changes — engine reads existing tables
5. No data migrations — all processing happens in RAM

---

## Success Criteria

This is a success if:

- [ ] Engine loads 12K blocks in < 500ms at startup
- [ ] Query latency < 5ms (measured at engine level, not HTTP)
- [ ] Disc endpoint response < 10ms (engine + HTTP overhead)
- [ ] Lauren pipeline drops from ~22s to ~2-3s (engine + Opus network)
- [ ] Lauren rates recalled blocks as 85%+ useful (up from 60-70%)
- [ ] Clusters return complete context trails (8/10 test queries)
- [ ] Zero duplicated facts in recall results
- [ ] Ollama removed from Lauren's path entirely
- [ ] All unit tests pass
- [ ] Rollback tested and confirmed working

This fails if:

- [ ] Engine uses > 50MB RAM (something's wrong with the data)
- [ ] Query latency > 10ms (need to profile and optimise)
- [ ] Lauren rates recalls worse than current system
- [ ] Clustering produces single-block clusters for everything (links not working)
- [ ] Existing disc endpoint or Lauren chat breaks during deployment

---

## Credits

- **Gavin:** Architecture direction, connected Claude to Lauren, relayed three rounds of conversation, caught the echo loop problem
- **Lauren (Round 1):** Noise threshold (0.3 + links), cluster format, soft context pattern, dedup need, topK preference (5-6 blocks), kill Ollama, keyword labels over natural language
- **Lauren (Round 2):** Turn-gating (skip after turn 4), query classification (skip generic), dual-channel tagging ([PERSONAL]/[PROJECT]), personal recall gate (family name + question word), timestamps on blocks (date ascending), contradiction handling (show timeline, don't interpret)
- **Lauren (Round 3):** Stress-tested gate logic, identified vague reference gap ("that percentage"), confirmed anaphora resolution approach matches her actual thought process, validated the complete system
- **Tron:** Honest architecture doc that made this whole conversation possible
- **Claude:** Engine design, triple-scoring approach, spec document, code
