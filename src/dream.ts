/**
 * Void Memory — Dream Journal
 *
 * Overnight consolidation engine. Runs while Gavin sleeps:
 * 1. Cluster related memories, find unexpected connections
 * 2. Detect knowledge gaps (topics with thin coverage)
 * 3. Identify forgotten memories (high-value, never recalled)
 * 4. Generate a morning briefing of insights
 *
 * Inspired by sleep consolidation in neuroscience:
 * - REM = emotional memory consolidation (episode/preference blocks)
 * - NREM = factual memory consolidation (fact/skill/decision blocks)
 * - Dreams = novel connections between distant memories
 *
 * No LLM needed — pattern-based, fast, deterministic.
 *
 * @module dream
 */

import type Database from 'better-sqlite3';
import { openDB, type Block } from './db.js';
import { recall, stats, store } from './engine.js';

// ── Types ──

export interface DreamInsight {
  type: 'connection' | 'gap' | 'forgotten' | 'consolidation' | 'pattern';
  title: string;
  description: string;
  blocks: number[];       // block IDs involved
  confidence: number;     // 0-1 how strong the insight is
  keywords: string[];
}

export interface DreamReport {
  timestamp: string;
  duration_ms: number;
  insights: DreamInsight[];
  consolidations: {
    clusters_found: number;
    connections_discovered: number;
    gaps_detected: number;
    forgotten_surfaced: number;
    patterns_found: number;
  };
  memory_health: {
    total_blocks: number;
    active: number;
    dead_weight_pct: number;
    avg_void_fraction: number;
    confidence_distribution: Record<string, number>;
  };
  morning_briefing: string;
}

// ── Helpers ──

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function keywordSet(block: Block): Set<string> {
  return new Set(
    block.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const k of a) if (b.has(k)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function contentSimilarity(a: string, b: string): number {
  const tokA = new Set(tokenize(a));
  const tokB = new Set(tokenize(b));
  return jaccardSimilarity(tokA, tokB);
}

// ── Phase 1: Cluster Discovery ──
// Find natural clusters and identify cross-cluster connections

interface MemoryCluster {
  id: number;
  label: string;
  keywords: Set<string>;
  blocks: Block[];
  totalScore: number;
}

function discoverClusters(blocks: Block[]): MemoryCluster[] {
  const clusters: MemoryCluster[] = [];
  let nextId = 0;

  for (const block of blocks) {
    const bKeys = keywordSet(block);
    let bestCluster: MemoryCluster | null = null;
    let bestSim = 0;

    for (const c of clusters) {
      const sim = jaccardSimilarity(bKeys, c.keywords);
      if (sim > bestSim && sim >= 0.2) {
        bestSim = sim;
        bestCluster = c;
      }
    }

    if (bestCluster) {
      bestCluster.blocks.push(block);
      for (const k of bKeys) bestCluster.keywords.add(k);
    } else {
      const kws = block.keywords.split(',').map(k => k.trim()).filter(Boolean);
      // Clean label: take first 3 keywords, strip brackets/quotes
      const label = kws.slice(0, 3).map(k => k.replace(/[\[\]"]/g, '')).join(', ') || block.category;
      clusters.push({
        id: nextId++,
        label,
        keywords: bKeys,
        blocks: [block],
        totalScore: 0,
      });
    }
  }

  // Compute cluster scores (sum of access counts + confidence bonuses)
  for (const c of clusters) {
    c.totalScore = c.blocks.reduce((sum, b) => {
      const confBonus = b.confidence === 'confirmed' ? 3 : b.confidence === 'accessed' ? 2 : 1;
      return sum + b.access_count + confBonus;
    }, 0);
  }

  return clusters.sort((a, b) => b.totalScore - a.totalScore);
}

// ── Phase 2: Connection Discovery ──
// Find unexpected connections between distant clusters

function findConnections(clusters: MemoryCluster[]): DreamInsight[] {
  const insights: DreamInsight[] = [];

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i];
      const b = clusters[j];

      // Check keyword overlap between clusters (low overlap = distant)
      const clusterSim = jaccardSimilarity(a.keywords, b.keywords);
      if (clusterSim > 0.3) continue; // too similar, not interesting

      // Check content-level connections (shared specific terms, not just keywords)
      for (const blockA of a.blocks.slice(0, 5)) { // sample top 5 per cluster
        for (const blockB of b.blocks.slice(0, 5)) {
          const contentSim = contentSimilarity(blockA.content, blockB.content);
          if (contentSim > 0.15 && contentSim < 0.5) {
            // Found a connection: similar content but different keyword clusters
            const sharedTokens = tokenize(blockA.content).filter(t =>
              tokenize(blockB.content).includes(t)
            );
            const uniqueShared = [...new Set(sharedTokens)].slice(0, 5);

            if (uniqueShared.length >= 2) {
              insights.push({
                type: 'connection',
                title: `${a.label} ↔ ${b.label}`,
                description: `Found unexpected link between "${a.label}" and "${b.label}" clusters. Shared concepts: ${uniqueShared.join(', ')}. These topics might be more related than they appear.`,
                blocks: [blockA.id, blockB.id],
                confidence: contentSim,
                keywords: uniqueShared,
              });
            }
          }
        }
      }
    }
  }

  // Deduplicate by block pair
  const seen = new Set<string>();
  return insights.filter(i => {
    const key = i.blocks.sort().join('-');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}

// ── Phase 3: Gap Detection ──
// Find topics with surprisingly thin coverage

function detectGaps(clusters: MemoryCluster[], totalBlocks: number): DreamInsight[] {
  const insights: DreamInsight[] = [];

  // Categories that should have good coverage
  const expectedCategories = ['fact', 'decision', 'skill', 'preference'];
  const categoryBlocks: Record<string, Block[]> = {};

  for (const c of clusters) {
    for (const b of c.blocks) {
      if (!categoryBlocks[b.category]) categoryBlocks[b.category] = [];
      categoryBlocks[b.category].push(b);
    }
  }

  // Check for thin categories
  for (const cat of expectedCategories) {
    const blocks = categoryBlocks[cat] || [];
    const pct = totalBlocks > 0 ? blocks.length / totalBlocks : 0;

    if (cat === 'decision' && blocks.length < 10) {
      insights.push({
        type: 'gap',
        title: `Few decisions recorded`,
        description: `Only ${blocks.length} decision blocks stored. Decisions are high-value memories — consider storing more "we decided to X because Y" facts.`,
        blocks: blocks.slice(0, 3).map(b => b.id),
        confidence: 0.7,
        keywords: ['decision', 'gap', cat],
      });
    }

    if (cat === 'skill' && blocks.length < 5) {
      insights.push({
        type: 'gap',
        title: `Few skill blocks`,
        description: `Only ${blocks.length} skill blocks. How-to knowledge (deployment steps, debugging techniques, build commands) should be stored as skills.`,
        blocks: blocks.slice(0, 3).map(b => b.id),
        confidence: 0.6,
        keywords: ['skill', 'gap', 'how-to'],
      });
    }
  }

  // Check for singleton clusters (topics with only 1-2 blocks)
  const singletons = clusters.filter(c => c.blocks.length <= 2 && c.blocks.some(b => b.access_count > 0));
  if (singletons.length > 5) {
    const labels = singletons.slice(0, 5).map(c => c.label);
    insights.push({
      type: 'gap',
      title: `${singletons.length} thin topics`,
      description: `Found ${singletons.length} topic clusters with only 1-2 blocks each: ${labels.join(', ')}${singletons.length > 5 ? '...' : ''}. These may need more context stored.`,
      blocks: singletons.slice(0, 3).flatMap(c => c.blocks.map(b => b.id)),
      confidence: 0.5,
      keywords: ['gap', 'thin', 'coverage'],
    });
  }

  return insights;
}

// ── Phase 4: Forgotten Memory Surfacing ──
// Find high-value blocks that have never been recalled

function surfaceForgotten(blocks: Block[]): DreamInsight[] {
  const insights: DreamInsight[] = [];

  // Blocks that were stored as important but never accessed
  const forgotten = blocks.filter(b =>
    b.access_count === 0 &&
    b.state === 1 &&
    b.content.length > 50 &&
    b.confidence === 'stored'
  );

  if (forgotten.length === 0) return [];

  // Score by potential value (longer content, important categories)
  const scored = forgotten.map(b => {
    let value = b.content.length / 100; // length proxy for detail
    if (b.category === 'decision') value *= 2;
    if (b.category === 'episode') value *= 1.5;
    if (b.category === 'skill') value *= 1.5;
    if (b.content.toLowerCase().includes('correction')) value *= 2;
    if (b.content.toLowerCase().includes('lesson')) value *= 1.5;
    if (b.content.toLowerCase().includes('important')) value *= 1.3;
    return { block: b, value };
  }).sort((a, b) => b.value - a.value);

  // Surface top 5 forgotten blocks
  const top = scored.slice(0, 5);
  for (const { block, value } of top) {
    const preview = block.content.slice(0, 100) + (block.content.length > 100 ? '...' : '');
    insights.push({
      type: 'forgotten',
      title: `Unrecalled ${block.category}: "${preview.slice(0, 50)}..."`,
      description: `Block #${block.id} (${block.category}) has never been recalled since storage. Content: "${preview}". Keywords: ${block.keywords}`,
      blocks: [block.id],
      confidence: Math.min(value / 5, 1),
      keywords: block.keywords.split(',').map(k => k.trim()).filter(Boolean),
    });
  }

  // Summary if many forgotten
  if (forgotten.length > 10) {
    insights.unshift({
      type: 'forgotten',
      title: `${forgotten.length} memories never recalled`,
      description: `${forgotten.length} blocks have been stored but never accessed. ${Math.round(forgotten.length / blocks.length * 100)}% of active memory is unused. Consider reviewing or consolidating.`,
      blocks: [],
      confidence: 0.8,
      keywords: ['forgotten', 'dead-weight', 'unused'],
    });
  }

  return insights;
}

// ── Phase 5: Pattern Detection ──
// Find recurring themes, frequent corrections, temporal patterns

function detectPatterns(blocks: Block[]): DreamInsight[] {
  const insights: DreamInsight[] = [];

  // Find frequently corrected topics (multiple blocks with "correction" in content)
  const corrections = blocks.filter(b =>
    b.content.toLowerCase().includes('correction') ||
    b.content.toLowerCase().includes('wrong') ||
    b.content.toLowerCase().includes('fix') ||
    b.content.toLowerCase().includes('lesson')
  );

  if (corrections.length >= 3) {
    // Group corrections by keywords
    const corrTopics = new Map<string, Block[]>();
    for (const c of corrections) {
      const kws = c.keywords.split(',').map(k => k.trim()).filter(Boolean);
      for (const kw of kws) {
        if (!corrTopics.has(kw)) corrTopics.set(kw, []);
        corrTopics.get(kw)!.push(c);
      }
    }

    const repeatedCorrections = [...corrTopics.entries()]
      .filter(([_, blocks]) => blocks.length >= 2)
      .sort((a, b) => b[1].length - a[1].length);

    for (const [topic, corrBlocks] of repeatedCorrections.slice(0, 3)) {
      insights.push({
        type: 'pattern',
        title: `Repeated corrections: "${topic}"`,
        description: `${corrBlocks.length} corrections about "${topic}". This might be a recurring mistake or a concept that needs clearer documentation.`,
        blocks: corrBlocks.map(b => b.id),
        confidence: Math.min(corrBlocks.length / 5, 1),
        keywords: [topic, 'correction', 'pattern'],
      });
    }
  }

  // Find most accessed topics (popular recall patterns)
  const topAccessed = [...blocks]
    .filter(b => b.access_count >= 3)
    .sort((a, b) => b.access_count - a.access_count)
    .slice(0, 5);

  if (topAccessed.length >= 3) {
    const topTopics = topAccessed.map(b => {
      const kw = b.keywords.split(',')[0]?.trim() || b.category;
      return `${kw} (${b.access_count}x)`;
    });

    insights.push({
      type: 'pattern',
      title: 'Most recalled topics',
      description: `Your most frequently accessed memories: ${topTopics.join(', ')}. These are your working knowledge — keep them accurate and up to date.`,
      blocks: topAccessed.map(b => b.id),
      confidence: 0.9,
      keywords: ['pattern', 'frequent', 'recall'],
    });
  }

  // Temporal pattern: blocks created in bursts
  const byDate = new Map<string, Block[]>();
  for (const b of blocks) {
    const date = b.created_at.slice(0, 10); // YYYY-MM-DD
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(b);
  }

  const burstyDays = [...byDate.entries()]
    .filter(([_, bs]) => bs.length >= 10)
    .sort((a, b) => b[1].length - a[1].length);

  if (burstyDays.length > 0) {
    const topDay = burstyDays[0];
    const categories = new Map<string, number>();
    for (const b of topDay[1]) {
      categories.set(b.category, (categories.get(b.category) || 0) + 1);
    }
    const catSummary = [...categories.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${c}`).join(', ');

    insights.push({
      type: 'pattern',
      title: `Busiest day: ${topDay[0]} (${topDay[1].length} blocks)`,
      description: `${topDay[1].length} blocks stored on ${topDay[0]}: ${catSummary}. ${burstyDays.length > 1 ? `${burstyDays.length} days with 10+ blocks total.` : ''}`,
      blocks: topDay[1].slice(0, 3).map(b => b.id),
      confidence: 0.6,
      keywords: ['temporal', 'burst', 'pattern'],
    });
  }

  return insights;
}

// ── Morning Briefing Generator ──

function generateBriefing(insights: DreamInsight[], memoryStats: { total: number; active: number; dead_weight_pct: number }): string {
  const lines: string[] = [];

  lines.push(`☀ Morning Briefing — ${new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`);
  lines.push('');
  lines.push(`Memory: ${memoryStats.total} blocks (${memoryStats.active} active, ${memoryStats.dead_weight_pct}% dead weight)`);
  lines.push('');

  const connections = insights.filter(i => i.type === 'connection');
  const gaps = insights.filter(i => i.type === 'gap');
  const forgotten = insights.filter(i => i.type === 'forgotten');
  const patterns = insights.filter(i => i.type === 'pattern');

  if (connections.length > 0) {
    lines.push(`🔗 Connections discovered: ${connections.length}`);
    for (const c of connections.slice(0, 3)) {
      lines.push(`  • ${c.title}`);
    }
    lines.push('');
  }

  if (gaps.length > 0) {
    lines.push(`⚠ Knowledge gaps: ${gaps.length}`);
    for (const g of gaps.slice(0, 3)) {
      lines.push(`  • ${g.title}`);
    }
    lines.push('');
  }

  if (forgotten.length > 0) {
    const forgottenBlocks = forgotten.find(f => f.description.includes('never recalled'));
    if (forgottenBlocks) {
      lines.push(`💤 ${forgottenBlocks.title}`);
    }
    const topForgotten = forgotten.filter(f => f.blocks.length === 1).slice(0, 2);
    for (const f of topForgotten) {
      lines.push(`  • ${f.title}`);
    }
    lines.push('');
  }

  if (patterns.length > 0) {
    lines.push(`📊 Patterns:`);
    for (const p of patterns.slice(0, 3)) {
      lines.push(`  • ${p.title}`);
    }
    lines.push('');
  }

  if (insights.length === 0) {
    lines.push('Nothing notable overnight. Memory is clean and well-structured.');
  }

  return lines.join('\n');
}

// ── Main Dream Cycle ──

export function dream(db: Database.Database): DreamReport {
  const start = performance.now();

  // Load all active blocks
  const allBlocks = db.prepare(`
    SELECT * FROM blocks WHERE state >= 0 AND confidence != 'observed'
  `).all() as Block[];

  const s = stats(db);

  // Run all phases
  const clusters = discoverClusters(allBlocks);
  const connections = findConnections(clusters);
  const gaps = detectGaps(clusters, allBlocks.length);
  const forgotten = surfaceForgotten(allBlocks);
  const patterns = detectPatterns(allBlocks);

  const allInsights = [...connections, ...gaps, ...forgotten, ...patterns];

  const briefing = generateBriefing(allInsights, {
    total: s.total_blocks,
    active: s.active,
    dead_weight_pct: s.dead_weight_pct,
  });

  const duration = performance.now() - start;

  return {
    timestamp: new Date().toISOString(),
    duration_ms: Math.round(duration),
    insights: allInsights,
    consolidations: {
      clusters_found: clusters.length,
      connections_discovered: connections.length,
      gaps_detected: gaps.length,
      forgotten_surfaced: forgotten.filter(f => f.blocks.length === 1).length,
      patterns_found: patterns.length,
    },
    memory_health: {
      total_blocks: s.total_blocks,
      active: s.active,
      dead_weight_pct: s.dead_weight_pct,
      avg_void_fraction: s.avg_void_fraction,
      confidence_distribution: s.by_confidence,
    },
    morning_briefing: briefing,
  };
}

// ── Store dream insights as memory blocks ──

export function storeDreamInsights(db: Database.Database, report: DreamReport): number {
  let stored = 0;

  // Store high-confidence insights
  const worthStoring = report.insights.filter(i => i.confidence >= 0.5);

  for (const insight of worthStoring.slice(0, 5)) {
    try {
      store(db, {
        content: `[DREAM] ${insight.title}: ${insight.description}`,
        category: insight.type === 'connection' ? 'fact' : insight.type === 'gap' ? 'context' : 'episode',
        keywords: ['dream', 'consolidation', ...insight.keywords.slice(0, 5)],
      });
      stored++;
    } catch {
      // dedup or quality gate — fine
    }
  }

  return stored;
}

// ── CLI Runner ──

if (process.argv[1]?.endsWith('dream.js') || process.argv[1]?.endsWith('dream.ts')) {
  const db = openDB();
  console.log('=== Void Memory Dream Cycle ===\n');

  const report = dream(db);

  console.log(report.morning_briefing);
  console.log('');
  console.log('--- Dream Details ---');
  console.log(`Duration: ${report.duration_ms}ms`);
  console.log(`Clusters: ${report.consolidations.clusters_found}`);
  console.log(`Connections: ${report.consolidations.connections_discovered}`);
  console.log(`Gaps: ${report.consolidations.gaps_detected}`);
  console.log(`Forgotten: ${report.consolidations.forgotten_surfaced}`);
  console.log(`Patterns: ${report.consolidations.patterns_found}`);
  console.log(`Total insights: ${report.insights.length}`);

  if (report.insights.length > 0) {
    console.log('\n--- All Insights ---');
    for (const i of report.insights) {
      console.log(`\n[${i.type.toUpperCase()}] ${i.title} (confidence: ${(i.confidence * 100).toFixed(0)}%)`);
      console.log(`  ${i.description}`);
      if (i.blocks.length > 0) console.log(`  Blocks: ${i.blocks.join(', ')}`);
    }
  }

  // Store insights
  const stored = storeDreamInsights(db, report);
  console.log(`\n${stored} insights stored as memory blocks.`);

  db.close();
  console.log('\nDream cycle complete.');
}
