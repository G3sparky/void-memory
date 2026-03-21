# Void Memory

**Three-state memory for AI agents. 84% relevance. 292 tokens. Zero noise.**

Most AI memory systems try to add the right things to context. Void Memory removes the wrong ones — carving out ~30% structural absence to create interference-free recall channels.

The result: **8x more relevant than RAG, 288x more token-efficient than context stuffing**, with sub-100ms latency and zero LLM dependency.

---

## Benchmark Results

8 queries across a 992-block corpus:

| Method | Relevance | Latency | Tokens Used | Noise Hits | Efficiency |
|--------|-----------|---------|-------------|------------|------------|
| **Void Memory** | **84.2%** | 62ms | 292 | 0 | 2.88/1K |
| Simple RAG | 10.5% | 22ms | 226 | 0 | 0.47/1K |
| Naive Stuffing | 23.7% | 0ms | 44,621 | 0.6 | 0.01/1K |

RAG returned garbage on 5 of 8 queries (0% relevance). Context stuffing burned 44K tokens for 24% relevance. Void Memory hit 84% at 292 tokens.

> **The pitch**: 84% relevance at 292 tokens vs 24% at 44,621 tokens. Same knowledge base. Same queries. 153x less context for 3.5x better results.

---

## How It Works

Void Memory uses a **three-pass pipeline** with no LLM calls, no embedding models, no vector databases:

### Pass 1: Score (TF-IDF + confidence + recency)
Every block is scored against the query using TF-IDF with keyword bonuses, confidence multipliers (confirmed blocks score 1.3x), and recency decay.

### Pass 2: Void Mark (~30% structural absence)
The core innovation. Blocks are clustered by keyword similarity (Jaccard), then:
- **Score gap detection** finds natural relevance boundaries (>40% score drop)
- **Off-topic cluster suppression** voids the lowest-scoring topic clusters
- **Hub dampening** prevents over-accessed blocks from dominating

The target is 30% void fraction — a topological invariant discovered in [ternary photonic neural network research](https://arxiv.org/abs/xxxx.xxxxx) across 5 random seeds.

### Pass 3: Budget Fit
Remaining blocks fill a token budget (default 4,000 tokens — 2% of a 200K context window). No silent truncation. The system reports what was voided and why.

### Three States

| State | Value | Meaning |
|-------|-------|---------|
| **Active** | +1 | Block is relevant to current query. Retrieved. |
| **Void** | 0 | Block is structurally absent for this query — suppressed to prevent interference. |
| **Inhibitory** | -1 | Block actively suppresses related blocks (corrections, superseded knowledge). |

### Confidence Lifecycle

Blocks earn their place through use:

```
observed → stored → accessed (1st recall) → confirmed (3rd recall)
```

New blocks start at `stored`. Only `stored` and above are recall candidates. After 3 successful recalls, a block reaches `confirmed` status and gets a 1.3x scoring bonus.

---

## Quick Start

### Install

```bash
git clone https://github.com/yourusername/void-memory.git
cd void-memory
npm install
npm run build
```

### Run as MCP Server (Claude Code / Claude Desktop)

```bash
node dist/mcp-server.js
```

Add to your Claude Code MCP config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "void-memory": {
      "command": "node",
      "args": ["/path/to/void-memory/dist/mcp-server.js"],
      "env": {
        "VOID_DATA_DIR": "/path/to/void-memory/data"
      }
    }
  }
}
```

### Run as REST API + Dashboard

```bash
node dist/dashboard.js 3410
```

Opens a web dashboard at `http://localhost:3410` with full API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/recall` | POST | Query memory (body: `{query, budget?}`) |
| `/api/stats` | GET | Health dashboard (blocks, confidence, categories) |
| `/api/blocks` | GET | Browse blocks (pagination, filtering, search) |
| `/api/void-zones` | GET | See what's being suppressed for a query |
| `/api/categories` | GET | Category breakdown with access stats |
| `/api/confidence` | GET | Confidence tier distribution |
| `/api/timeline` | GET | Block creation timeline |

### Docker

```bash
docker run -v ./data:/app/data -p 3410:3410 void-memory
```

---

## MCP Tools

5 tools available when running as an MCP server:

| Tool | Description |
|------|-------------|
| `void_recall` | Query memory with three-pass pipeline. Returns relevant blocks within token budget. |
| `void_store` | Store a new block. Quality-gated (min 20 chars, 30% alphabetic). Auto-dedup on >80% keyword overlap. |
| `void_stats` | Health dashboard: block counts, confidence tiers, recall performance, dead weight %. |
| `void_zones` | Show what would be voided for a given query. Understand the structural absence. |
| `void_explain` | Explain the system architecture. |

### Example: Store

```json
{
  "tool": "void_store",
  "arguments": {
    "content": "PostgreSQL connection pool should use max 20 connections in production",
    "category": "skill",
    "keywords": ["postgres", "connection-pool", "production", "config"]
  }
}
```

### Example: Recall

```json
{
  "tool": "void_recall",
  "arguments": {
    "query": "database connection configuration",
    "budget": 2000
  }
}
```

Response includes the recalled blocks, void zones (what was suppressed), void fraction, and token budget usage.

---

## Quality Gates

Void Memory prevents junk from entering the system:

- **Minimum length**: 20 characters
- **Alpha ratio**: Content must be at least 30% alphabetic (rejects log noise, JSON dumps)
- **Dedup gate**: If a new block has >80% keyword overlap with an existing block, it updates the existing one instead of creating a duplicate
- **Inhibitory supersession**: When a correction replaces old knowledge, the old block becomes inhibitory (-1) — it actively suppresses itself in future recalls

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Void Memory                        │
│                                                      │
│  ┌──────────┐   ┌──────────────┐   ┌────────────┐  │
│  │ Pass 1   │──▶│   Pass 2     │──▶│  Pass 3    │  │
│  │ TF-IDF   │   │ Void Marking │   │ Budget Fit │  │
│  │ Score    │   │ ~30% absence │   │ Token cap  │  │
│  └──────────┘   └──────────────┘   └────────────┘  │
│       │               │                   │          │
│  ┌────▼────┐    ┌─────▼──────┐    ┌──────▼──────┐  │
│  │ keyword │    │ Jaccard    │    │ Fit scored  │  │
│  │ + conf  │    │ clustering │    │ blocks into │  │
│  │ + time  │    │ + gap det  │    │ 4K budget   │  │
│  └─────────┘    │ + hub damp │    └─────────────┘  │
│                 └────────────┘                       │
│                                                      │
│  Storage: SQLite (WAL mode)                          │
│  Interface: MCP (stdio) or REST API                  │
│  Dependencies: better-sqlite3 (that's it)            │
└─────────────────────────────────────────────────────┘
```

**Zero external dependencies** beyond SQLite. No embedding models, no vector databases, no LLM calls during recall. The entire engine is 517 lines of TypeScript.

---

## Performance

Tested on a production system with 2,884 blocks (2,701 active, 183 inhibitory):

| Metric | Value |
|--------|-------|
| Average recall latency | 23.6ms |
| Average void fraction | 36% |
| Average tokens per recall | ~300 |
| Total recalls logged | 104 |
| Database size | ~2MB |
| Engine size | 517 lines TypeScript |
| Dependencies | 1 (better-sqlite3) |

---

## The Science

The 30% void fraction comes from research on ternary Photonic Neural Networks (PNNs). When training a photonic chip simulator with three materials (silicon, void/air, silicon dioxide mapping to +1, 0, -1), the optimizer consistently converges to ~30% void fraction across all random seeds and grid sizes.

This isn't waste — it's **structural absence that enables signal routing**. The void creates channels through which information flows without interference. The same principle applies to memory: by deliberately suppressing ~30% of candidates per query, the remaining results are cleaner, more relevant, and more focused.

Key results from PNN research:
- Ternary (with void): **76.5% accuracy** on MNIST classification
- Binary (without void): **15.3% accuracy** on the same task
- Advantage: **+61.3 percentage points** (p = 2.18e-11, 5-seed validated)

The void isn't the absence of intelligence. It's the architecture of it.

---

## Multi-Agent Support

Void Memory supports isolated memory databases per agent via the `VOID_DATA_DIR` environment variable:

```bash
# Agent 1
VOID_DATA_DIR=/data/agent-alpha node dist/mcp-server.js

# Agent 2
VOID_DATA_DIR=/data/agent-beta node dist/mcp-server.js
```

Each agent gets its own SQLite database with independent blocks, confidence tracking, and recall history.

---

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `VOID_DATA_DIR` | `./data` | Directory for SQLite database |

Engine constants (in `engine.ts`):

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_BUDGET` | 4,000 tokens | Default recall budget (2% of 200K window) |
| `MAX_BUDGET` | 10,000 tokens | Maximum allowed budget (5% cap) |
| `VOID_TARGET` | 0.30 | Target void fraction per recall |
| `MAX_CANDIDATES` | 100 | Maximum blocks scored per recall |
| `CLUSTER_THRESHOLD` | 0.25 | Jaccard similarity for topic clustering |

---

## Use Cases

- **Claude Code agents** — persistent memory across sessions with automatic context management
- **Multi-agent systems** — each agent gets isolated memory with quality gates
- **Knowledge bases** — store and recall domain knowledge without embedding infrastructure
- **Correction tracking** — inhibitory blocks ensure superseded knowledge doesn't resurface
- **Context-limited environments** — tight budget control prevents context window flooding

---

## License

Dual licensed:

- **AGPL-3.0** — Free for open source projects
- **Commercial License** — For proprietary/closed-source use. Contact for pricing.

---

## Credits

Built by [Gavin](https://github.com/yourusername) and the NeoGate team (Tron, Arch, Flynn).

The three-state architecture was inspired by ternary Photonic Neural Network research, where 30% structural void emerged as a topological invariant enabling signal routing in silicon photonic chips.
