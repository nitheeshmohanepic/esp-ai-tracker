#!/usr/bin/env node
// Scans only Claude and Gemini, then merges results into latest_scan.json

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;

const BRAND_TERMS = ['epic slope', 'epicslope', 'epicslope.partners'];
const COMPETITOR_DOMAINS = [
  'omniscientdigital.com', 'poweredbysearch.com', 'directiveconsulting.com',
  'kalungi.com', 'madx.digital', 'b2bseo.io',
  'siegemedia.com', 'firstpagesage.com', 'ipullrank.com', 'seerinteractive.com'
];

// --- arg parsing ---
const domainArg = process.argv.indexOf('--domain');
if (domainArg === -1) { console.error('Usage: node scan-new-engines.js --domain <domain>'); process.exit(1); }
const DOMAIN      = process.argv[domainArg + 1];
const promptsPath = path.join(__dirname, 'data', DOMAIN, 'prompts.json');
const scanPath    = path.join(__dirname, 'data', DOMAIN, 'latest_scan.json');

if (!fs.existsSync(promptsPath)) { console.error('prompts.json not found'); process.exit(1); }
if (!fs.existsSync(scanPath))    { console.error('latest_scan.json not found — run scanner.js first'); process.exit(1); }

const prompts  = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
const existing = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
console.log(`Loaded ${prompts.length} prompts. Running Claude + Gemini...\n`);

// --- helpers ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function detectBrand(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BRAND_TERMS.some(t => lower.includes(t));
}
function detectCitationUrl(data) {
  if (!data) return false;
  return JSON.stringify(data).toLowerCase().includes('epicslope.partners');
}
function detectCompetitors(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return COMPETITOR_DOMAINS.filter(d => lower.includes(d));
}
function snippet(text, len = 400) { return (text || '').slice(0, len); }
function nullResult(err) {
  return { brand_mentioned: false, citation_url: false, competitors_mentioned: [], response_snippet: `ERROR: ${err?.message || 'unknown'}` };
}

// --- Rate limiter (token bucket) ---
class RateLimiter {
  constructor({ maxRPM, maxConcurrent }) {
    this.intervalMs    = (60 / maxRPM) * 1000;
    this.maxConcurrent = maxConcurrent;
    this.inFlight      = 0;
    this.queue         = [];
    this.lastDispatch  = 0;
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }
  _drain() {
    if (!this.queue.length || this.inFlight >= this.maxConcurrent) return;
    const wait = Math.max(0, this.lastDispatch + this.intervalMs - Date.now());
    setTimeout(() => {
      if (!this.queue.length || this.inFlight >= this.maxConcurrent) { this._drain(); return; }
      const { fn, resolve, reject } = this.queue.shift();
      this.inFlight++;
      this.lastDispatch = Date.now();
      fn()
        .then(v  => { this.inFlight--; resolve(v); this._drain(); })
        .catch(e => { this.inFlight--; reject(e);  this._drain(); });
      if (this.inFlight < this.maxConcurrent) this._drain();
    }, wait);
  }
}

async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (err) {
      if (err.noRetry || attempt === maxRetries) throw err;
      const base  = err.retryAfterMs ?? Math.pow(2, attempt + 1) * 1000;
      const delay = base + Math.random() * 1000;
      console.warn(`  [retry ${attempt+1}/${maxRetries}] ${err.message} — waiting ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}

const limiters = {
  claude: new RateLimiter({ maxRPM: 20, maxConcurrent: 3 }),
  gemini: new RateLimiter({ maxRPM: 15, maxConcurrent: 3 }),
};

// --- Claude Haiku 4.5 ---
async function queryClaude(query) {
  return limiters.claude.run(() => withRetry(async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: query }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const err = new Error('Claude 429 rate limited');
      err.retryAfterMs = retryAfter ? parseFloat(retryAfter) * 1000 : 60000;
      throw err;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const err = new Error(`Claude HTTP ${res.status}: ${body}`);
      if (res.status === 400 || res.status === 404) err.noRetry = true;
      throw err;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    return {
      brand_mentioned:       detectBrand(text),
      citation_url:          detectCitationUrl(text),
      competitors_mentioned: detectCompetitors(text),
      response_snippet:      snippet(text),
    };
  }));
}

// --- Gemini 3.5 Flash with Google Search grounding ---
async function queryGemini(query) {
  return limiters.gemini.run(() => withRetry(async () => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after') || res.headers.get('Retry-After');
      const err = new Error('Gemini 429 rate limited');
      err.retryAfterMs = retryAfter ? parseFloat(retryAfter) * 1000 : 60000;
      throw err;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const err = new Error(`Gemini HTTP ${res.status}: ${body}`);
      if (res.status === 400 || res.status === 404) err.noRetry = true;
      if (res.status === 503) err.retryAfterMs = 15000; // back off longer on overload
      throw err;
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text  = parts.map(p => p.text || '').join('');
    const groundingMeta = data.candidates?.[0]?.groundingMetadata || {};
    const allText = text + JSON.stringify(groundingMeta);
    return {
      brand_mentioned:       detectBrand(allText),
      citation_url:          detectCitationUrl(allText),
      competitors_mentioned: detectCompetitors(allText),
      response_snippet:      snippet(text),
    };
  }));
}

// --- Main ---
async function run() {
  let completed = 0;
  const newEngineResults = new Map(); // prompt_id -> { claude, gemini }

  const tasks = prompts.map(async (p) => {
    const [claude, gemini] = await Promise.allSettled([
      queryClaude(p.query),
      queryGemini(p.query),
    ]);
    completed++;
    process.stdout.write(`[${completed}/${prompts.length}] ${p.query.slice(0, 72)}\n`);
    return {
      id: p.id,
      claude:  claude.status  === 'fulfilled' ? claude.value  : nullResult(claude.reason),
      gemini:  gemini.status  === 'fulfilled' ? gemini.value  : nullResult(gemini.reason),
    };
  });

  const settled = await Promise.allSettled(tasks);
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      newEngineResults.set(r.value.id, { claude: r.value.claude, gemini: r.value.gemini });
    }
  }

  // Merge into existing scan — also refresh topic_bucket from updated prompts
  const promptMap = new Map(prompts.map(p => [p.id, p]));
  const merged = existing.results.map(row => {
    const extra    = newEngineResults.get(row.prompt_id) || {};
    const updated  = promptMap.get(row.prompt_id);
    return {
      ...row,
      topic_bucket: updated?.topic_bucket ?? row.topic_bucket,
      engines: {
        ...row.engines,
        ...(extra.claude ? { claude: extra.claude } : {}),
        ...(extra.gemini ? { gemini: extra.gemini } : {}),
      },
    };
  });

  const output = {
    ...existing,
    scan_date: new Date().toISOString(),
    engines_run: ['openai', 'serpapi_aio', 'claude_haiku_4_5', 'gemini_3_5_flash'],
    results: merged,
  };

  fs.writeFileSync(scanPath, JSON.stringify(output, null, 2));
  console.log(`\nMerge complete → ${scanPath}`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
