#!/usr/bin/env node
/**
 * Morning Briefing — 7AM delivery
 * Posts to council bus so Gavin sees it when he opens Vortex.
 */

const COUNCIL_BUS = 'http://localhost:3216/api/council-bus/send';
const DISCORD_SEND = 'http://localhost:3216/api/v2/discord/send/home';

async function main() {
  // Check if overnight conversation ran (look for recent dream insights)
  let dreamInfo = '';
  try {
    const Database = require('better-sqlite3');
    const db = new Database('/opt/void-memory/data/void-memory.db', { readonly: true });

    const recentDream = db.prepare(
      "SELECT content FROM blocks WHERE category = 'dream-insight' AND created_at > datetime('now', '-12 hours') ORDER BY id DESC LIMIT 5"
    ).all();

    const stats = db.prepare('SELECT COUNT(*) as c FROM blocks WHERE state = 1').get();
    const totalBlocks = stats?.c || 0;

    if (recentDream.length > 0) {
      dreamInfo = `\n\nLast night's dream insights:\n${recentDream.map(r => `  - ${r.content.slice(0, 120)}`).join('\n')}`;
    }

    dreamInfo += `\n\nMemory: ${totalBlocks} active blocks.`;
    db.close();
  } catch (e) {
    dreamInfo = '\n\n(Could not read dream data)';
  }

  const briefing = `[MORNING BRIEFING] Good morning Gavin. Your systems are running.${dreamInfo}\n\nCheck the Council tab for the full overnight conversation.`;

  // Post to council bus
  try {
    const r = await fetch(COUNCIL_BUS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'arch', message: briefing }),
    });
    if (r.ok) console.log('Morning briefing sent to council.');
    else console.error('Council failed:', r.status);
  } catch (e) {
    console.error('Council bus unreachable:', e.message);
  }

  // Post to Discord #home
  try {
    const r = await fetch(DISCORD_SEND, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: briefing }),
    });
    if (r.ok) console.log('Morning briefing sent to Discord.');
    else console.error('Discord failed:', r.status);
  } catch (e) {
    console.error('Discord unreachable:', e.message);
  }
}

main();
