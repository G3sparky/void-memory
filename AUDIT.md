# Void Memory — Full System Audit

**Auditor:** Arch (Claude Opus 4.6)
**Date:** 2026-03-21
**Scope:** Complete memory system — engine, MCP server, harvester, dashboard, dream cycle, DB schema
**Standard:** Senior QA / Security / Code Review

---

## PHASE 1 — INVENTORY

### Core Engine (16 files, 3,967 LOC)

| # | File | Lines | Purpose | Risk |
|---|------|-------|---------|------|
| M1 | engine.ts | 517 | Core recall/store/stats — TF-IDF scoring, void marking, budget fit | CRITICAL |
| M2 | mcp-server.ts | 389 | MCP stdio server — void_recall, void_store, void_stats, etc. | HIGH |
| M3 | db.ts | 89 | SQLite schema and initialization | HIGH |
| M4 | dream.ts | 574 | Dream cycle — overnight pattern analysis | MEDIUM |
| M5 | harvester.ts | 222 | Watches tmux output, auto-stores blocks | HIGH |
| M6 | dashboard.ts | 209 | REST API dashboard (port 3219) | MEDIUM |
| M7 | inner-voice.ts | 346 | Internal monologue + session review tools | MEDIUM |
| M8 | self-test.ts | 435 | Self-test suite for recall quality | LOW |
| M9 | benchmark.ts | 169 | Performance benchmarks | LOW |
| M10 | seed.ts | 66 | Initial seed data | LOW |
| M11 | overnight.ts | 76 | Overnight maintenance runner | LOW |
| M12 | migrate.ts | 144 | TASM → Void migration | LOW |
| M13 | migrate-tasm.ts | 130 | TASM v2 migration | LOW |
| M14 | migrate-tron.ts | 406 | Tron memory migration | LOW |
| M15 | test.ts | 195 | Test runner | LOW |

### Data Layer

| # | Database | Size | Agent | Blocks |
|---|----------|------|-------|--------|
| D1 | data/void-memory.db | 4.2 MB | Arch | 4650 |
| D2 | data/tron/void-memory.db | 238 KB | Tron | 266 |
| D3 | data/flynn/void-memory.db | 64 KB | Flynn | 0 |
| D4 | data/nexus/void-memory.db | 2.8 MB | Nexus | ~3700 |

### Services

| Service | Port | Status | Type |
|---------|------|--------|------|
| void-memory-api | 3219 | active | REST dashboard |
| void-dashboard | - | active | Web dashboard |
| void-harvester | - | active | tmux watcher |

---

## PHASE 2 — AUDIT REGISTER

| ID | File | Unit | Type | Risk | Status | Result | Severity | Finding |
|----|------|------|------|------|--------|--------|----------|---------|
| M1a | engine.ts | recall() | Function | CRITICAL | REVIEWED | WARNING | MEDIUM | Loads ALL non-observed blocks into memory on every recall |
| M1b | engine.ts | store() | Function | HIGH | REVIEWED | WARNING | LOW | Dedup scans all blocks — O(n) per store |
| M1c | engine.ts | scoreBlock() | Function | HIGH | REVIEWED | PASS | NONE | Correct TF-IDF + confidence + recency scoring |
| M1d | engine.ts | clusterBlocks() | Function | MEDIUM | REVIEWED | PASS | NONE | Single-linkage Jaccard clustering works correctly |
| M1e | engine.ts | findScoreGap() | Function | MEDIUM | REVIEWED | PASS | NONE | Gap detection with 40% threshold is sound |
| M1f | engine.ts | voidZones() | Function | LOW | REVIEWED | WARNING | LOW | Calls recall() internally — double access count increment |
| M1g | engine.ts | stats() | Function | LOW | REVIEWED | PASS | NONE | Clean aggregate queries |
| M2a | mcp-server.ts | void_recall | MCP Tool | HIGH | REVIEWED | PASS | NONE | Correctly wraps engine.recall() |
| M2b | mcp-server.ts | void_store | MCP Tool | HIGH | REVIEWED | PASS | NONE | Quality gates enforced |
| M2c | mcp-server.ts | void_stats | MCP Tool | LOW | REVIEWED | PASS | NONE | Direct stats() call |
| M5a | harvester.ts | watch() | Function | HIGH | REVIEWED | WARNING | MEDIUM | Only watches arch-v2 session — misses tron/flynn |

---

## PHASE 3 — DETAILED REVIEW

### [UNIT AUDIT RECORD] M1a — recall()

**ID:** M1a
**File:** engine.ts:199-391
**Unit name:** recall()
**Unit type:** Core function
**Area:** Memory retrieval
**Purpose:** Three-pass recall: TF-IDF scoring → void marking → budget fit

**Inputs:** db (SQLite), query (string), budgetTokens (optional number)
**Outputs:** RecallResult with scored blocks, void zones, metrics
**Dependencies:** db.ts (Block type), SQLite
**Used by:** mcp-server.ts, dashboard.ts, inner-voice.ts, soul.ts

**Summary judgment:** WARNING
**Severity:** MEDIUM

**Checks:**
- **Logic correctness:** Core algorithm is sound. TF-IDF scoring + confidence multipliers + recency boost is a reasonable ranking system. Three-strategy void marking (gap, cluster, individual) with protected clusters is well-designed.
- **Edge cases:**
  - Empty query: tokenize returns [], all scores are 0, no results returned. Acceptable.
  - Single block: MIN_VOID_CANDIDATES (6) prevents void marking. Correct.
  - All blocks same keywords: clusterBlocks puts them all in one cluster, protects it. Correct.
- **Error handling:** No try-catch. If DB is corrupted, unhandled exception. Should have error boundary.
- **Security:** No SQL injection risk (parameterized queries). No user-facing input validation issue.
- **Performance:** **ISSUE** — Loads ALL non-observed blocks on every recall (`SELECT * FROM blocks WHERE state >= 0 AND confidence != 'observed'`). With 4650 blocks, this is ~4650 rows × ~500 bytes = ~2.3MB loaded into memory per recall. At 50ms avg this is acceptable NOW but will degrade as blocks grow. At 10,000 blocks this becomes a problem.
- **Maintainability:** Well-structured with clear pass separation. Comments explain intent. Good.
- **Test coverage:** self-test.ts covers basic recall quality but doesn't test edge cases (empty DB, single block, budget overflow).

**Problems found:**
1. Loads ALL blocks into memory on every recall — O(n) memory usage
2. computeIDF() iterates all blocks — O(n × avg_tokens) per recall
3. voidZones() calls recall() internally, causing double access_count increment and double recall_log entry

**Recommended fix:**
- Minimal: Add a pre-filter using FTS5 or keyword index to reduce candidate set before loading full blocks
- Long-term: Move to FTS5 virtual table for initial scoring, only load top N blocks for void marking

**Tests to add:**
- Empty database recall
- Single block recall (verify no void marking)
- Budget overflow (blocks that don't fit)
- Recall with all identical keywords
- Concurrent recall (race condition on access_count update)

**Confidence:** High

---

### [UNIT AUDIT RECORD] M1b — store()

**ID:** M1b
**File:** engine.ts:404-450
**Unit name:** store()
**Unit type:** Core function
**Area:** Memory storage
**Purpose:** Store new block with quality gates and dedup

**Inputs:** db, StoreOpts (content, category, keywords, state, confidence, supersedes)
**Outputs:** { id, deduped }
**Dependencies:** db.ts
**Used by:** mcp-server.ts, harvester.ts

**Summary judgment:** WARNING
**Severity:** LOW

**Checks:**
- **Logic correctness:** Quality gates (min 20 chars, 30% alpha) are correct. Dedup uses keyword Jaccard overlap >80% which is reasonable. Supersession correctly marks old block as inhibitory and creates inhibition link.
- **Edge cases:**
  - Empty keywords array: newKeywords is empty Set, overlap ratio is 0, no dedup triggered. Correct.
  - Supersedes non-existent ID: UPDATE runs but affects 0 rows. Harmless but should validate.
  - Content exactly 20 chars: passes gate. Correct.
- **Error handling:** Throws on quality gate failures. Good — caller must handle.
- **Security:** No injection risk. Content is stored as-is (no sanitization needed for SQLite TEXT).
- **Performance:** Dedup scans ALL blocks (`SELECT id, keywords, content FROM blocks WHERE state >= 0`) — O(n) per store. With 4650 blocks this loads ~4650 rows. Acceptable now but should use keyword index long-term.
- **Maintainability:** Clean, readable. Good.

**Problems found:**
1. Dedup loads ALL blocks to check overlap — inefficient at scale
2. When dedup triggers, it updates content but doesn't update category or confidence
3. Supersedes doesn't validate target block exists

**Recommended fix:**
- Minimal: Add WHERE clause to dedup query filtering by at least one matching keyword
- Better: Create keyword index table for O(1) keyword lookup

**Tests to add:**
- Store with exact duplicate keywords (verify dedup)
- Store with 79% keyword overlap (verify NOT deduped)
- Store with supersedes pointing to non-existent block
- Content edge cases: exactly 20 chars, exactly 30% alpha

**Confidence:** High

---

### [UNIT AUDIT RECORD] M5a — harvester watch()

**ID:** M5a
**File:** harvester.ts
**Unit name:** Harvester
**Unit type:** Background service
**Area:** Auto-storage
**Purpose:** Watches tmux output and auto-stores relevant blocks

**Summary judgment:** WARNING
**Severity:** MEDIUM

**Checks:**
- **Logic correctness:** Watches tmux pipe-pane output file. Parses for significant content.
- **Edge cases:** If tmux session dies, pipe-pane stops. Harvester keeps watching a stale file.
- **Error handling:** UNCERTAIN — need to review full file
- **Performance:** File watching with polling is adequate for low-volume output.

**Problems found:**
1. Only watches arch-v2 session — Tron and Flynn sessions are NOT harvested
2. If the output file grows unbounded, memory usage for parsing increases

**Recommended fix:**
- Configure harvester to watch multiple tmux sessions (arch-v2, arch, flynn)
- Add file rotation or truncation after processing

**Confidence:** Medium

---

## PHASE 4 — SUMMARY (Interim — engine.ts complete)

### Critical Issues
- None found

### High-Priority Issues
1. **M1a:** recall() loads ALL blocks into memory per call — degrades with scale
2. **M5a:** Harvester only watches arch-v2 — Tron/Flynn memories not auto-captured

### Security Issues
- None found — parameterized queries throughout, no user-facing input

### Edge Case Failures
1. **M1f:** voidZones() double-increments access counts
2. **M1b:** Supersedes doesn't validate target exists

### Maintainability Issues
1. **A1 (rest.ts):** 9,647 lines — needs splitting (not yet reviewed)

### Missing Tests
- Empty DB recall, single block recall, budget overflow
- Concurrent recall race conditions
- Dedup boundary cases (79% vs 81% overlap)
- Harvester multi-session support

### Unreviewed Items
- M3 (db.ts) — schema review pending
- M4 (dream.ts) — full review pending
- M6 (dashboard.ts) — API review pending
- M7 (inner-voice.ts) — review pending
- All frontend views (V1-V20) — review pending
- Backend routes (B1-B15, A1-A8) — review pending

---

*Audit continues. Next: db.ts schema, mcp-server.ts, then frontend core (app.ts, store.ts).*

---

### [UNIT AUDIT RECORD] M3 — db.ts (Schema)

**ID:** M3
**File:** db.ts:1-89
**Unit name:** openDB(), migrate()
**Unit type:** Database layer
**Summary judgment:** PASS
**Severity:** NONE

**Checks:**
- **Logic correctness:** Schema is clean. Three tables: blocks, recall_log, inhibitions. CHECK constraints enforce valid states and confidence values. Indexes on state, category, confidence, keywords.
- **Edge cases:** Keywords index is on full TEXT column — not useful for substring search. Acceptable since engine does in-memory matching.
- **Error handling:** openDB creates directory if missing. No explicit error handling on Database() constructor — will throw on permission issues.
- **Security:** No injection risk. WAL mode is correct for concurrent reads.
- **Performance:** Foreign keys enabled. Indexes appropriate. WAL mode good for read-heavy workload.
- **Maintainability:** Clean, minimal. 89 lines.

**Problems found:** None

**Tests to add:**
- Open DB with non-existent parent directory
- Open DB with read-only permissions
- Verify CHECK constraints reject invalid state/confidence

**Confidence:** High

---

### [UNIT AUDIT RECORD] M2 — mcp-server.ts

**ID:** M2
**File:** mcp-server.ts:1-389
**Unit name:** MCP stdio server
**Unit type:** Integration
**Summary judgment:** PASS
**Severity:** NONE

**Checks:**
- **Logic correctness:** 10 tools properly defined with JSON schemas. Each wraps the corresponding engine function correctly.
- **Edge cases:** Missing required fields return clear error messages. Budget is clamped by engine.
- **Error handling:** Each tool call is wrapped in try-catch, returns error text to MCP client.
- **Security:** Runs as stdio server — no network exposure. Only accessible from Claude Code MCP config.
- **Performance:** Single DB connection shared across all tool calls. Efficient.
- **Maintainability:** Well-structured tool definitions. Could benefit from extracting tool handlers into separate functions for testability.

**Problems found:** None significant

**Tests to add:**
- Tool invocation with missing required fields
- Tool invocation with invalid types
- Concurrent tool calls (stdio is sequential, so not a real risk)

**Confidence:** High
