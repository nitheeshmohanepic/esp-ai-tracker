#!/usr/bin/env node
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { scan } from './scanner.js';
import { generateReport } from './generate-report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));

// ── In-memory job store (Phase 1 — replaced by Redis in Phase 2) ──────────
const jobs = new Map();

// ── Auth ──────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const key = process.env.SCANNER_API_KEY;
  if (!key) return next();
  if (req.headers.authorization !== `Bearer ${key}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POST /clients — register/update a client ──────────────────────────────
app.post('/clients', requireAuth, (req, res) => {
  const { domain, prompts, client_config } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });
  if (!Array.isArray(prompts) || prompts.length === 0) return res.status(400).json({ error: 'prompts array is required' });

  const dir = path.join(__dirname, 'data', domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify(prompts, null, 2));
  if (client_config) fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify(client_config, null, 2));
  res.json({ ok: true, domain, prompt_count: prompts.length });
});

// ── POST /scan ─────────────────────────────────────────────────────────────
app.post('/scan', requireAuth, (req, res) => {
  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const promptsPath = path.join(__dirname, 'data', domain, 'prompts.json');
  if (!fs.existsSync(promptsPath)) return res.status(404).json({ error: `No prompts found for domain: ${domain}` });

  for (const [, job] of jobs) {
    if (job.domain === domain && job.status === 'running') {
      return res.status(409).json({ error: 'Scan already running', job_id: job.id });
    }
  }

  const job_id = crypto.randomUUID();
  const job = { id: job_id, domain, status: 'running', started_at: new Date().toISOString(), completed_at: null, error: null };
  jobs.set(job_id, job);

  scan(domain)
    .then(() => { job.status = 'done'; job.completed_at = new Date().toISOString(); })
    .catch(err => { job.status = 'failed'; job.error = err.message; job.completed_at = new Date().toISOString(); });

  res.status(202).json({ job_id, status: 'running', domain });
});

// ── GET /status/:job_id ────────────────────────────────────────────────────
app.get('/status/:job_id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job_id: job.id, status: job.status, domain: job.domain, started_at: job.started_at, completed_at: job.completed_at, error: job.error });
});

// ── GET /results/:domain ───────────────────────────────────────────────────
app.get('/results/:domain', requireAuth, (req, res) => {
  const scanPath = path.join(__dirname, 'data', req.params.domain, 'latest_scan.json');
  if (!fs.existsSync(scanPath)) return res.status(404).json({ error: 'No scan results found' });
  try { res.json(JSON.parse(fs.readFileSync(scanPath, 'utf8'))); }
  catch { res.status(500).json({ error: 'Failed to read scan results' }); }
});

// ── GET /report/:domain — generate and return PDF ─────────────────────────
app.get('/report/:domain', requireAuth, async (req, res) => {
  const domain = req.params.domain;
  const scanPath = path.join(__dirname, 'data', domain, 'latest_scan.json');
  if (!fs.existsSync(scanPath)) return res.status(404).json({ error: 'No scan results found — run a scan first' });

  try {
    const pdfPath = await generateReport(domain);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${domain}-visibility-report.pdf"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    console.error('Report generation failed:', err.message);
    res.status(500).json({ error: `Report generation failed: ${err.message}` });
  }
});

// ── GET /responses/:domain — list available response snapshots ────────────
app.get('/responses/:domain', requireAuth, (req, res) => {
  const responsesDir = path.join(__dirname, 'data', req.params.domain, 'responses');
  if (!fs.existsSync(responsesDir)) return res.json({ scans: [] });
  const scans = fs.readdirSync(responsesDir)
    .filter(d => fs.statSync(path.join(responsesDir, d)).isDirectory())
    .sort().reverse()
    .map(scanId => {
      const files = fs.readdirSync(path.join(responsesDir, scanId));
      return { scan_id: scanId, prompt_count: files.length };
    });
  res.json({ domain: req.params.domain, scans });
});

// ── GET /responses/:domain/:scan_id/:prompt_id — full LLM response ────────
app.get('/responses/:domain/:scan_id/:prompt_id', requireAuth, (req, res) => {
  const { domain, scan_id, prompt_id } = req.params;
  const filePath = path.join(__dirname, 'data', domain, 'responses', scan_id, `${prompt_id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Response not found' });
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch { res.status(500).json({ error: 'Failed to read response' }); }
});

// ── GET /clients ───────────────────────────────────────────────────────────
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
          const results = s.results || [];
          let mentioned = 0, total = 0;
          for (const r of results) for (const e of Object.values(r.engines || {})) { total++; if (e.brand_mentioned) mentioned++; }
          overall_pct = total > 0 ? Math.round((mentioned / total) * 100) : 0;
        } catch {}
      }
      const running = [...jobs.values()].find(j => j.domain === domain && j.status === 'running');
      return { domain, last_scan, overall_pct, status: running ? 'scanning' : 'idle' };
    });
  res.json({ clients });
});

// ── GET /health ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, jobs: jobs.size }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ESP AI Tracker API running on :${PORT}`));
