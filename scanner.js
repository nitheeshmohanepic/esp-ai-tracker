#!/usr/bin/env node
// Unified 4-engine scanner — OpenAI, SerpAPI, Claude, Gemini run in parallel per prompt.
// Full LLM responses saved to data/<domain>/responses/<scan_id>/ for later verification.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env ──────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const SERPAPI_KEY       = process.env.SERPAPI_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;

// ── Args ───────────────────────────────────────────────────────────────────
const domainArg = process.argv.indexOf('--domain');
const DOMAIN    = domainArg !== -1 ? process.argv[domainArg + 1] : null;

// ── Rate limiter ───────────────────────────────────────────────────────────
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

const limiters = {
  openai:  new RateLimiter({ maxRPM: 30, maxConcurrent: 5 }),
  serpapi: new RateLimiter({ maxRPM: 10, maxConcurrent: 2 }),
  claude:  new RateLimiter({ maxRPM: 20, maxConcurrent: 3 }),
  gemini:  new RateLimiter({ maxRPM: 15, maxConcurrent: 3 }),
};

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// Matches "Company Name" patterns and domain-like strings in LLM text.
// Used to surface competitors the pre-loaded list doesn't cover.
const DOMAIN_RE = /\b([a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.(?:com|ai|io|co|net|org|dev))\b/gi;

// Well-known AI governance / security vendors not always listed as domains
const KNOWN_VENDOR_PATTERNS = [
  { name: 'lakera.ai',              pattern: /\blakera\b/i },
  { name: 'protectai.com',          pattern: /\bprotect\s*ai\b/i },
  { name: 'hiddenlayer.com',        pattern: /\bhiddenlayer\b/i },
  { name: 'calypsoai.com',          pattern: /\bcalypso\s*ai\b/i },
  { name: 'securiti.ai',            pattern: /\bsecuriti\b/i },
  { name: 'cranium.ai',             pattern: /\bcranium\b/i },
  { name: 'robustintelligence.com', pattern: /\brobust\s*intelligence\b/i },
  { name: 'credo.ai',               pattern: /\bcredo\.ai\b/i },
  { name: 'databricks.com',         pattern: /\bdatabricks\b/i },
  { name: 'collibra.com',           pattern: /\bcollibra\b/i },
  { name: 'dataiku.com',            pattern: /\bdataiku\b/i },
  { name: 'arize.com',              pattern: /\barize\b/i },
  { name: 'arthur.ai',              pattern: /\barthur\s*(ai|shield)?\b/i },
  { name: 'fiddler.ai',             pattern: /\bfiddler\b/i },
  { name: 'whylabs.ai',             pattern: /\bwhylabs\b/i },
  { name: 'aigovernance.com',       pattern: /\bai\s*governance\s*platform\b/i },
  { name: 'ibm.com',                pattern: /\bibm\s*(watson|openpages|cloud pak)?\b/i },
  { name: 'microsoft.com',          pattern: /\bmicrosoft\s*(purview|azure ai)?\b/i },
  { name: 'google.com',             pattern: /\bgoogle\s*(vertex|cloud ai)?\b/i },
];

// Domains to ignore when extracting from text (too generic)
const IGNORE_DOMAINS = new Set([
  'github.com','linkedin.com','twitter.com','youtube.com','google.com',
  'aws.com','azure.com','openai.com','anthropic.com','huggingface.co',
]);

function makeDetectors(brandTerms, competitorDomains) {
  return {
    detectBrand(text) {
      if (!text) return false;
      const lower = text.toLowerCase();
      return brandTerms.some(t => lower.includes(t.toLowerCase()));
    },
    detectCitationUrl(data) {
      if (!data) return false;
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      return brandTerms.some(t => str.toLowerCase().includes(t.toLowerCase()));
    },
    // Returns { preloaded: string[], detected: string[] }
    detectCompetitors(text) {
      if (!text) return { preloaded: [], detected: [] };

      // Pre-loaded list (exact match)
      const preloaded = competitorDomains.filter(d => text.toLowerCase().includes(d.toLowerCase()));

      // Detect additional vendors via known patterns
      const detectedSet = new Set();
      for (const { name, pattern } of KNOWN_VENDOR_PATTERNS) {
        if (pattern.test(text) && !competitorDomains.includes(name)) detectedSet.add(name);
      }
      // Extract bare domains from text
      for (const match of text.matchAll(DOMAIN_RE)) {
        const domain = match[1].toLowerCase();
        if (!IGNORE_DOMAINS.has(domain) && !competitorDomains.includes(domain) && !brandTerms.some(b => domain.includes(b.toLowerCase()))) {
          detectedSet.add(domain);
        }
      }

      return { preloaded, detected: [...detectedSet] };
    },
  };
}

function snippet(text, len = 2000) { return (text || '').slice(0, len); }

function nullResult(err) {
  return {
    brand_mentioned: false, citation_url: false,
    competitors_mentioned: [], detected_competitors: [],
    response_snippet: `ERROR: ${err?.message || 'unknown'}`, full_response: null,
  };
}

// ── Engine callers ─────────────────────────────────────────────────────────
function makeEngines(detect) {
  const { detectBrand, detectCitationUrl, detectCompetitors } = detect;

  async function queryOpenAI(query) {
    return limiters.openai.run(() => withRetry(async () => {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', tools: [{ type: 'web_search_preview' }], input: query }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        const err = new Error('OpenAI 429');
        err.retryAfterMs = parseFloat(res.headers.get('Retry-After') || '30') * 1000;
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
          for (const c of (item.content || [])) { if (c.type === 'output_text') text += c.text || ''; }
        }
      }
      const comps = detectCompetitors(JSON.stringify(data));
      return {
        brand_mentioned:       detectBrand(text),
        citation_url:          detectCitationUrl(text) || detectCitationUrl(data),
        competitors_mentioned: comps.preloaded,
        detected_competitors:  comps.detected,
        response_snippet:      snippet(text),
        full_response:         text,
      };
    }));
  }

  async function querySerpAPI(query) {
    return limiters.serpapi.run(() => withRetry(async () => {
      const params = new URLSearchParams({
        engine: 'google_ai_mode',
        q: query,
        hl: 'en',
        gl: 'us',
        google_domain: 'google.com',
        location: 'United States',
        api_key: SERPAPI_KEY,
      });
      const res = await fetch(`https://serpapi.com/search?${params}`, { signal: AbortSignal.timeout(30000) });
      if (res.status === 429) { const err = new Error('SerpAPI 429'); err.retryAfterMs = 60000; throw err; }
      if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
      const data = await res.json();

      // text_blocks is the AI Mode response, reconstructed_markdown is the full text
      const blocks = data.text_blocks || [];
      const aioText = data.reconstructed_markdown ||
        blocks.map(b => b.snippet || (b.list?.list || []).map(i => i.snippet || '').join('\n')).filter(Boolean).join('\n');

      const comps = detectCompetitors(aioText);
      return {
        brand_mentioned:       detectBrand(aioText),
        citation_url:          detectCitationUrl(aioText),
        competitors_mentioned: comps.preloaded,
        detected_competitors:  comps.detected,
        response_snippet:      snippet(aioText),
        full_response:         aioText || null,
      };
    }));
  }

  async function queryClaude(query) {
    return limiters.claude.run(() => withRetry(async () => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: query }] }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) {
        const err = new Error('Claude 429');
        err.retryAfterMs = parseFloat(res.headers.get('retry-after') || '60') * 1000;
        throw err;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        const err = new Error(`Claude HTTP ${res.status}: ${body}`);
        if (res.status === 400 || res.status === 404) err.noRetry = true;
        throw err;
      }
      const data = await res.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const comps = detectCompetitors(text);
      return {
        brand_mentioned:       detectBrand(text),
        citation_url:          detectCitationUrl(text),
        competitors_mentioned: comps.preloaded,
        detected_competitors:  comps.detected,
        response_snippet:      snippet(text),
        full_response:         text,
      };
    }));
  }

  async function queryGemini(query) {
    return limiters.gemini.run(() => withRetry(async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: query }] }], tools: [{ google_search: {} }] }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        const err = new Error('Gemini 429');
        err.retryAfterMs = parseFloat(res.headers.get('retry-after') || res.headers.get('Retry-After') || '60') * 1000;
        throw err;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        const err = new Error(`Gemini HTTP ${res.status}: ${body}`);
        if (res.status === 400 || res.status === 404) err.noRetry = true;
        if (res.status === 503) err.retryAfterMs = 15000;
        throw err;
      }
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text  = parts.map(p => p.text || '').join('');
      const groundingMeta = data.candidates?.[0]?.groundingMetadata || {};
      const allText = text + JSON.stringify(groundingMeta);
      const comps = detectCompetitors(allText);
      return {
        brand_mentioned:       detectBrand(allText),
        citation_url:          detectCitationUrl(allText),
        competitors_mentioned: comps.preloaded,
        detected_competitors:  comps.detected,
        response_snippet:      snippet(text),
        full_response:         text,
      };
    }));
  }

  return { queryOpenAI, querySerpAPI, queryClaude, queryGemini };
}

// ── Main scan — exported for use by server.js ─────────────────────────────
export async function scan(domain, { job_id, scan_id: providedScanId, onProgress } = {}) {
  const promptsFile = path.join(__dirname, 'data', domain, 'prompts.json');
  const clientFile  = path.join(__dirname, 'data', domain, 'client.json');
  const outFile     = path.join(__dirname, 'data', domain, 'latest_scan.json');

  if (!fs.existsSync(promptsFile)) throw new Error(`prompts.json not found for ${domain}`);

  const prompts = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
  const client  = fs.existsSync(clientFile) ? JSON.parse(fs.readFileSync(clientFile, 'utf8')) : {};

  const brandTerms        = client.brand_terms        || [domain.replace(/\..+$/, ''), domain];
  const competitorDomains = client.competitor_domains || [];

  console.log(`[${domain}] ${prompts.length} prompts | brands: ${brandTerms.join(', ')}`);

  const detect  = makeDetectors(brandTerms, competitorDomains);
  const engines = makeEngines(detect);

  const scanId       = providedScanId || new Date().toISOString().replace(/[:.]/g, '-');
  const responsesDir = path.join(__dirname, 'data', domain, 'responses', scanId);
  fs.mkdirSync(responsesDir, { recursive: true });

  let completed = 0;
  const tasks = prompts.map(async (p) => {
    const [oai, serp, claude, gemini] = await Promise.allSettled([
      engines.queryOpenAI(p.query),
      engines.querySerpAPI(p.query),
      engines.queryClaude(p.query),
      engines.queryGemini(p.query),
    ]);

    completed++;
    process.stdout.write(`[${completed}/${prompts.length}] ${p.query.slice(0, 70)}\n`);
    if (onProgress) await onProgress(completed, prompts.length);

    const result = {
      openai:      oai.status    === 'fulfilled' ? oai.value    : nullResult(oai.reason),
      serpapi_aio: serp.status   === 'fulfilled' ? serp.value   : nullResult(serp.reason),
      claude:      claude.status === 'fulfilled' ? claude.value : nullResult(claude.reason),
      gemini:      gemini.status === 'fulfilled' ? gemini.value : nullResult(gemini.reason),
    };

    // Save full responses to filesystem for later verification
    fs.writeFileSync(
      path.join(responsesDir, `${p.id}.json`),
      JSON.stringify({
        prompt_id: p.id, query: p.query, topic_bucket: p.topic_bucket,
        responses: {
          openai:      result.openai.full_response,
          serpapi_aio: result.serpapi_aio.full_response,
          claude:      result.claude.full_response,
          gemini:      result.gemini.full_response,
        },
      }, null, 2)
    );

    // Strip full_response from scan JSON to keep it lean
    for (const e of Object.values(result)) delete e.full_response;

    return { prompt_id: p.id, query: p.query, topic_bucket: p.topic_bucket, engines: result };
  });

  const settled = await Promise.allSettled(tasks);
  const results = settled.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message });

  // Compute overall visibility % and aggregate competitor mentions
  const ENGINE_KEYS = ['openai', 'serpapi_aio', 'claude', 'gemini'];
  let mentioned = 0, total = 0;
  const competitorMentions = {}; // { domain: count } — all competitors seen across all engines

  for (const r of results) {
    if (r.error) continue;
    for (const k of ENGINE_KEYS) {
      const e = r.engines?.[k];
      if (!e) continue;
      total++;
      if (e.brand_mentioned) mentioned++;
      // Aggregate both pre-loaded and detected competitors
      const allComps = [...(e.competitors_mentioned || []), ...(e.detected_competitors || [])];
      for (const c of allComps) competitorMentions[c] = (competitorMentions[c] || 0) + 1;
    }
  }
  const overall_pct = total > 0 ? Math.round((mentioned / total) * 100) : 0;

  const output = {
    domain, scan_date: new Date().toISOString(), scan_id: scanId,
    total_prompts: prompts.length, engines_run: ENGINE_KEYS, overall_pct,
    competitor_mentions: competitorMentions, results,
  };

  // Write to filesystem (cache for report generation)
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  // Persist to PostgreSQL if available
  if (process.env.DATABASE_URL) {
    try {
      const { db } = await import('./db.js');
      await db.completeScan({ scan_id: scanId, results, overall_pct, competitor_mentions: competitorMentions });
      await db.insertPromptResults(scanId, results);
      console.log(`[${domain}] Saved to PostgreSQL`);
    } catch (err) {
      console.error(`[${domain}] DB write failed:`, err.message);
    }
  }

  console.log(`\nScan complete → ${outFile} | visibility: ${overall_pct}%`);
  return output;
}

// Run directly if called as a CLI script
if (DOMAIN) {
  scan(DOMAIN).catch(err => { console.error('Fatal:', err); process.exit(1); });
}
