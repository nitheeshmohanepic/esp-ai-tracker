#!/usr/bin/env node
import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ── In-memory job store (Phase 1 — replaced by Redis in Phase 2) ──
const jobs = new Map(); // job_id → { status, domain, started_at, completed_at, error, engines }

// ── Auth middleware ──
function requireAuth(req, res, next) {
  const key = process.env.SCANNER_API_KEY;
  if (!key) return next(); // no key configured = open (dev mode)
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${key}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POST /scan — kick off a scan ──
app.post('/scan', requireAuth, (req, res) => {
  const { domain, engines } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const promptsPath = path.join(__dirname, 'data', domain, 'prompts.json');
  if (!fs.existsSync(promptsPath)) {
    return res.status(404).json({ error: `No prompts found for domain: ${domain}` });
  }

  // Reject if a scan is already running for this domain
  for (const [, job] of jobs) {
    if (job.domain === domain && job.status === 'running') {
      return res.status(409).json({ error: 'A scan is already running for this domain', job_id: job.id });
    }
  }

  const job_id = crypto.randomUUID();
  const job = { id: job_id, domain, status: 'running', started_at: new Date().toISOString(), completed_at: null, error: null, engines: engines || ['openai', 'serpapi', 'claude', 'gemini'] };
  jobs.set(job_id, job);

  // Run scanners in background
  runScan(job_id, domain, job.engines).catch(err => {
    const j = jobs.get(job_id);
    if (j) { j.status = 'failed'; j.error = err.message; j.completed_at = new Date().toISOString(); }
  });

  res.status(202).json({ job_id, status: 'running', domain });
});

// ── GET /status/:job_id ──
app.get('/status/:job_id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job_id: job.id, status: job.status, domain: job.domain, started_at: job.started_at, completed_at: job.completed_at, error: job.error });
});

// ── GET /results/:domain — latest scan JSON ──
app.get('/results/:domain', requireAuth, (req, res) => {
  const scanPath = path.join(__dirname, 'data', req.params.domain, 'latest_scan.json');
  if (!fs.existsSync(scanPath)) return res.status(404).json({ error: 'No scan results found for this domain' });
  try {
    res.json(JSON.parse(fs.readFileSync(scanPath, 'utf8')));
  } catch {
    res.status(500).json({ error: 'Failed to read scan results' });
  }
});

// ── GET /clients — list domains that have a prompts.json ──
app.get('/clients', requireAuth, (req, res) => {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) return res.json({ clients: [] });
  const clients = fs.readdirSync(dataDir)
    .filter(d => fs.existsSync(path.join(dataDir, d, 'prompts.json')))
    .map(domain => {
      const scanPath = path.join(dataDir, domain, 'latest_scan.json');
      let last_scan = null, overall_pct = null;
      if (fs.existsSync(scanPath)) {
        try {
          const s = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
          last_scan = s.scan_date;
          // Compute overall brand mention %
          const results = s.results || [];
          let mentioned = 0, total = 0;
          for (const r of results) {
            for (const e of Object.values(r.engines || {})) {
              total++;
              if (e.brand_mentioned) mentioned++;
            }
          }
          overall_pct = total > 0 ? Math.round((mentioned / total) * 100) : 0;
        } catch {}
      }
      // Find any running job
      const running = [...jobs.values()].find(j => j.domain === domain && j.status === 'running');
      return { domain, last_scan, overall_pct, status: running ? 'scanning' : 'idle' };
    });
  res.json({ clients });
});

// ── GET /health ──
app.get('/health', (_req, res) => res.json({ ok: true, jobs: jobs.size }));

// ── Background scan runner ──
async function runScan(job_id, domain, engines) {
  const runEngineSet = (script, args) => new Promise((resolve, reject) => {
    console.log(`[${job_id}] Starting ${script} for ${domain}`);
    const child = spawn('node', [path.join(__dirname, script), '--domain', domain, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => process.stdout.write(`[${job_id}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[${job_id}] ${d}`));
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });

  const needsOpenAI  = engines.includes('openai')  || engines.includes('serpapi');
  const needsNew     = engines.includes('claude')   || engines.includes('gemini');

  // Always run scanner.js first (writes latest_scan.json), then scan-new-engines.js merges into it
  if (needsOpenAI) await runEngineSet('scanner.js', []);
  if (needsNew)    await runEngineSet('scan-new-engines.js', []);

  const job = jobs.get(job_id);
  if (job) { job.status = 'done'; job.completed_at = new Date().toISOString(); }
  console.log(`[${job_id}] Scan complete for ${domain}`);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ESP AI Tracker API running on :${PORT}`));
