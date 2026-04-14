/**
 * Circadian Cycling — Cron-based dream consolidation for all agents
 *
 * Run via cron: node dist/circadian-cron.js
 * Recommended schedule: every 6 hours (4x daily, mimicking REM cycles)
 *
 * Sequentially processes each agent's database:
 * 1. Update storage tiers (hot/warm/cold)
 * 2. Check health (heteroplasmy/redox)
 * 3. Run limbic dream cycle
 * 4. Log results
 *
 * @module circadian-cron
 */

import { join } from 'path';
import { existsSync, readdirSync, appendFileSync, mkdirSync } from 'fs';
import { openDB } from './db.js';
import { circadianCycle, healthAdvisory, updateTiers, migrateTieredStorage } from './kruse.js';

const DATA_DIR = process.env.VOID_DATA_DIR || join(import.meta.dirname, '..', 'data');
const LOG_DIR = join(DATA_DIR, 'circadian-logs');

// Ensure log directory exists
mkdirSync(LOG_DIR, { recursive: true });

function log(msg: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  try {
    const logFile = join(LOG_DIR, `circadian-${timestamp.slice(0, 10)}.log`);
    appendFileSync(logFile, line + '\n');
  } catch {
    // Log write failed — don't crash
  }
}

/**
 * Discover all agents with databases
 */
function discoverAgents(): { name: string; dbPath: string | undefined }[] {
  const agents: { name: string; dbPath: string | undefined }[] = [];

  // Default (arch) database
  const defaultDb = join(DATA_DIR, 'void-memory.db');
  if (existsSync(defaultDb)) {
    agents.push({ name: 'arch', dbPath: undefined });
  }

  // Agent subdirectories
  try {
    const dirs = readdirSync(DATA_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory() && dir.name !== 'circadian-logs') {
        const agentDb = join(DATA_DIR, dir.name, 'void-memory.db');
        if (existsSync(agentDb)) {
          agents.push({ name: dir.name, dbPath: agentDb });
        }
      }
    }
  } catch {
    // Can't read dir — just use what we have
  }

  return agents;
}

/**
 * Run circadian cycle for all agents
 */
async function runCircadian(): Promise<void> {
  const startTime = Date.now();
  const agents = discoverAgents();

  log(`=== CIRCADIAN CYCLE START === ${agents.length} agents discovered: ${agents.map(a => a.name).join(', ')}`);

  const results = [];

  for (const agent of agents) {
    log(`[${agent.name}] Starting circadian cycle...`);

    try {
      const db = openDB(agent.dbPath);
      migrateTieredStorage(db);

      // Get pre-cycle advisory
      const advisory = healthAdvisory(db);
      log(`[${agent.name}] Health: ${advisory.status} | Heteroplasmy: ${advisory.heteroplasmy_rate}% | Redox: ${advisory.redox_score} | Tiers: H${advisory.tiers.hot}/W${advisory.tiers.warm}/C${advisory.tiers.cold}`);

      // Run the cycle
      const result = circadianCycle(db, agent.name);
      results.push(result);

      if (result.success) {
        log(`[${agent.name}] ✓ Dream cycle: ${result.duration_ms}ms | ${result.insights_count} insights | Merged: ${result.consolidations.merged} | Decayed: ${result.consolidations.decayed} | Confirmed: ${result.consolidations.confirmed}`);
        log(`[${agent.name}]   Health: heteroplasmy ${result.health_before.heteroplasmy}%→${result.health_after.heteroplasmy}% | redox ${result.health_before.redox}→${result.health_after.redox}`);
      } else {
        log(`[${agent.name}] ✗ FAILED: ${result.error}`);
      }

      db.close();
    } catch (err: any) {
      log(`[${agent.name}] ✗ FATAL: ${err.message}`);
      results.push({
        agent: agent.name,
        success: false,
        duration_ms: 0,
        insights_count: 0,
        consolidations: { merged: 0, decayed: 0, confirmed: 0 },
        health_before: { heteroplasmy: 0, redox: 50 },
        health_after: { heteroplasmy: 0, redox: 50 },
        error: err.message,
      });
    }
  }

  const totalMs = Date.now() - startTime;
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  log(`=== CIRCADIAN CYCLE COMPLETE === ${totalMs}ms | ${succeeded} succeeded, ${failed} failed`);
}

// Run
runCircadian().catch(err => {
  log(`FATAL ERROR: ${err.message}`);
  process.exit(1);
});
