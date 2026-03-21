/**
 * Query Expander v2 — NAS-aware, fast
 * Two strategies:
 * 1. Local synonym map (instant, no API cost)
 * 2. LLM fallback for unknown terms (only when local map misses)
 */

const ROUTER = 'http://192.168.1.203:3333/v1/chat/completions';

// ── Local synonym/alias map — zero latency, zero cost ──
const ALIASES = {
  // People
  boss: 'gavin saunders leader owner',
  gavin: 'saunders boss leader electrician tafe',
  lauren: 'tash wife family',
  
  // Agents
  tron: 'safety officer builder deployer',
  arch: 'architect designer frontend memory',
  flynn: 'advocate compute gpu testing devil',
  claw: 'watchdog monitor heartbeat safety',
  
  // Infrastructure
  gpu: 'rtx 4060 cuda nvidia g4inspirepc compute',
  nas: 'ct215 proxmox container 192.168.1.215',
  neogate: 'vortex port 3216 express api backend',
  neochat: 'legacy backup port 3217',
  router: 'gavin 203 3333 proxy openai anthropic gemini',
  ollama: 'ct202 11434 local llm model',
  tailscale: 'vpn remote access funnel 100.93',
  
  // Apps
  tafe: 'teaching ueeel0018 electrical wiring moodle learn',
  playground: 'playgroundai images reddit comfyui lora tory 3006',
  neohub: 'dashboard mudita launcher watchdog 3220',
  crm: 'rle river living electrical invoice client',
  tash: 'lauren period tracking health 3050 204',
  brain: 'flower 269 cells topology neural',
  
  // Concepts
  patent: 'ip provisional filing publish arxiv paper',
  pnn: 'photonic neural ternary bitnet void fraction',
  void: 'memory tasm blocks recall 30 percent absence',
  soul: 'bot chat personality identity',
  council: 'bus messages relay agents communication',
  
  // Events
  crash: 'refresh loop broken phone 2am night',
  crisis: 'trust bot lying fake bash commands',
  audit: 'security review check vulnerability',
  
  // Tech
  sqlite: 'database db wal storage persistence',
  express: 'server http api rest createserver',
  lit: 'web components frontend vite typescript',
  pm2: 'process manager restart crash recovery',
  systemd: 'service restart daemon',
  
  // Adjectives/verbs mapped to context
  live: 'location home address reside',
  broke: 'crash error bug broken failure',
  fast: 'latency speed performance milliseconds',
  cost: 'price money budget subscription monthly',
  port: 'http service endpoint number',
};

function expandLocal(query) {
  const words = query.toLowerCase().split(/\s+/);
  const expansions = new Set(words);
  
  for (const word of words) {
    if (ALIASES[word]) {
      for (const alias of ALIASES[word].split(' ')) {
        expansions.add(alias);
      }
    }
    // Also check partial matches
    for (const [key, vals] of Object.entries(ALIASES)) {
      if (word.includes(key) || key.includes(word)) {
        for (const v of vals.split(' ')) expansions.add(v);
      }
    }
  }
  
  return [...expansions].join(' ');
}

async function expandWithLLM(query) {
  try {
    const res = await fetch(ROUTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-nano',
        messages: [
          {
            role: 'system',
            content: 'You expand search queries for a NAS knowledge base about AI agents (Tron, Arch, Flynn), electrical work (TAFE, Gavin Saunders), and software projects (NeoGate, Vortex, Void Memory, PNN research). Output ONLY 5-8 additional search keywords. No explanations.'
          },
          { role: 'user', content: query }
        ],
        max_completion_tokens: 30,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch { return ''; }
}

async function expandQuery(query) {
  // Strategy 1: Local aliases (instant)
  const local = expandLocal(query);
  
  // If local expansion added enough terms, skip LLM
  const originalWordCount = query.split(/\s+/).length;
  const expandedWordCount = local.split(/\s+/).length;
  
  if (expandedWordCount > originalWordCount * 2) {
    return local; // Good enough expansion from local map
  }
  
  // Strategy 2: LLM fallback for unknown terms
  const llmTerms = await expandWithLLM(query);
  return `${local} ${llmTerms}`.trim();
}

// ── Test ──
async function test() {
  const tests = [
    "where does the boss live",
    "what GPU does the compute agent use",
    "which app crashed at 2am",
    "the percentage where structural absence settles",
    "pedagogical content delivery platform",
    "who reviews specs before building",
    "what model won the comparison test",
    "how many cells in the neural network",
  ];

  console.log("Query Expander v2 — Test Results:");
  console.log("=".repeat(60));
  
  for (const q of tests) {
    const start = Date.now();
    const expanded = await expandQuery(q);
    const ms = Date.now() - start;
    console.log(`\n[${ms}ms] "${q}"`);
    console.log(`  → "${expanded}"`);
  }
}

// Export for use by Void Memory
if (typeof module !== 'undefined') {
  module.exports = { expandQuery, expandLocal };
}

test().catch(console.error);
