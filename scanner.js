#!/usr/bin/env node

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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERPAPI_KEY    = process.env.SERPAPI_KEY;

const BRAND_TERMS = ['epic slope', 'epicslope', 'epicslope.partners'];
const COMPETITOR_DOMAINS = [
  'omniscientdigital.com',
  'poweredbysearch.com',
  'directiveconsulting.com',
  'kalungi.com',
  'madx.digital',
  'b2bseo.io',
  'siegemedia.com',
  'firstpagesage.com',
  'ipullrank.com',
  'seerinteractive.com'
];

// --- arg parsing ---
const domainArg = process.argv.indexOf('--domain');
if (domainArg === -1) { console.error('Usage: node scanner.js --domain <domain>'); process.exit(1); }
const DOMAIN      = process.argv[domainArg + 1];
const promptsPath = path.join(__dirname, 'data', DOMAIN, 'prompts.json');
const outputPath  = path.join(__dirname, 'data', DOMAIN, 'latest_scan.json');

if (!fs.existsSync(promptsPath)) { console.error(`prompts.json not found at ${promptsPath}`); process.exit(1); }
const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
console.log(`Loaded ${prompts.length} prompts for ${DOMAIN}\n`);

// ---------------------------------------------------------------------------
// Rate limiter — token bucket per provider
// maxRPM:      hard ceiling on requests per minute
// maxConcurrent: max simultaneous in-flight calls to this provider
// ---------------------------------------------------------------------------
class RateLimiter {
  constructor({ maxRPM, maxConcurrent }) {
    this.intervalMs   = (60 / maxRPM) * 1000; // min ms between dispatches
    this.maxConcurrent = maxConcurrent;
    this.inFlight     = 0;
    this.queue        = [];
    this.lastDispatch = 0;
  }

  // Wrap a fn() in the rate limiter. Returns a Promise that resolves when fn() resolves.
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    if (this.queue.length === 0) return;
    if (this.inFlight >= this.maxConcurrent) return;

    const now      = Date.now();
    const wait     = Math.max(0, this.lastDispatch + this.intervalMs - now);

    setTimeout(() => {
      if (this.queue.length === 0) return;
      if (this.inFlight >= this.maxConcurrent) { this._drain(); return; }

      const { fn, resolve, reject } = this.queue.shift();
      this.inFlight++;
      this.lastDispatch = Date.now();

      fn()
        .then(v  => { this.inFlight--; resolve(v); this._drain(); })
        .catch(e => { this.inFlight--; reject(e);  this._drain(); });

      // Kick next if concurrency headroom remains
      if (this.inFlight < this.maxConcurrent) this._drain();
    }, wait);
  }
}

const limiters = {
  openai:  new RateLimiter({ maxRPM: 30, maxConcurrent: 5 }),
  serpapi: new RateLimiter({ maxRPM: 10, maxConcurrent: 2 }),
};

// ---------------------------------------------------------------------------
// Retry with exponential backoff + jitter, honouring Retry-After on 429s
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.noRetry || attempt === maxRetries) throw err;
      const base   = err.retryAfterMs ?? Math.pow(2, attempt + 1) * 1000;
      const jitter = Math.random() * 1000;
      const delay  = base + jitter;
      console.warn(`  [retry ${attempt + 1}/${maxRetries}] ${err.message} — waiting ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------
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

function snippet(text, len = 400) {
  return (text || '').slice(0, len);
}

function nullResult(err) {
  return { brand_mentioned: false, citation_url: false, competitors_mentioned: [], response_snippet: `ERROR: ${err?.message || 'unknown'}` };
}

// ---------------------------------------------------------------------------
// Engine callers — each wrapped in the appropriate rate limiter
// ---------------------------------------------------------------------------
async function queryOpenAI(query) {
  return limiters.openai.run(() => withRetry(async () => {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', tools: [{ type: 'web_search_preview' }], input: query }),
      signal: AbortSignal.timeout(60000),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      const err = new Error(`OpenAI 429 rate limited`);
      err.retryAfterMs = retryAfter ? parseFloat(retryAfter) * 1000 : 30000;
      throw err;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      const err = new Error(`OpenAI HTTP ${res.status}: ${body}`);
      if (res.status === 400 || res.status === 404) err.noRetry = true;
      throw err;
    }

    const data = await res.json();
    let text = '';
    for (const item of (data.output || [])) {
      if (item.type === 'message') {
        for (const c of (item.content || [])) {
          if (c.type === 'output_text') text += c.text || '';
        }
      }
    }
    return {
      brand_mentioned:      detectBrand(text),
      citation_url:         detectCitationUrl(text) || detectCitationUrl(data),
      competitors_mentioned: detectCompetitors(JSON.stringify(data)),
      response_snippet:     snippet(text),
    };
  }));
}

async function querySerpAPI(query) {
  return limiters.serpapi.run(() => withRetry(async () => {
    const url = `https://serpapi.com/search?engine=google&q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });

    if (res.status === 429) {
      const err = new Error(`SerpAPI 429 rate limited`);
      err.retryAfterMs = 60000;
      throw err;
    }
    if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const data    = await res.json();
    const aioText = data.ai_overview ? JSON.stringify(data.ai_overview) : '';
    return {
      brand_mentioned:      detectBrand(aioText),
      citation_url:         detectCitationUrl(aioText),
      competitors_mentioned: detectCompetitors(aioText),
      response_snippet:     snippet(aioText),
    };
  }));
}

// ---------------------------------------------------------------------------
// Main scan — all prompts × 3 engines dispatched immediately,
// each provider's rate limiter queues and throttles automatically
// ---------------------------------------------------------------------------
async function scan() {
  let completed = 0;
  const results = [];

  const tasks = prompts.map(async (p, idx) => {
    const [oai, serp] = await Promise.allSettled([
      queryOpenAI(p.query),
      querySerpAPI(p.query),
    ]);
    completed++;
    console.log(`[${completed}/${prompts.length}] ${p.query.slice(0, 70)}`);
    return {
      prompt_id: p.id,
      query:     p.query,
      topic_bucket: p.topic_bucket,
      engines: {
        openai:      oai.status  === 'fulfilled' ? oai.value  : nullResult(oai.reason),
        serpapi_aio: serp.status === 'fulfilled' ? serp.value : nullResult(serp.reason),
      },
    };
  });

  // Collect in order
  const settled = await Promise.allSettled(tasks);
  for (const r of settled) {
    results.push(r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
  }

  const output = {
    domain:        DOMAIN,
    scan_date:     new Date().toISOString(),
    total_prompts: prompts.length,
    results,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nScan complete — ${outputPath}`);
}

scan().catch(err => { console.error('Fatal:', err); process.exit(1); });
