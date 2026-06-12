#!/usr/bin/env node
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { scan } from './scanner.js';
import { generateReport } from './generate-report.js';
import { queue } from './queue.js';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));

// ── Auth ──────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const key = process.env.SCANNER_API_KEY;
  if (!key) return next();
  if (req.headers.authorization !== `Bearer ${key}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── POST /clients — register/update a client ──────────────────────────────
app.post('/clients', requireAuth, async (req, res) => {
  const { domain, prompts, client_config } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });
  if (!Array.isArray(prompts) || prompts.length === 0) return res.status(400).json({ error: 'prompts array is required' });

  // Write to filesystem
  const dir = path.join(__dirname, 'data', domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify(prompts, null, 2));
  if (client_config) fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify(client_config, null, 2));

  // Persist to PostgreSQL
  try {
    await db.upsertClient({
      domain,
      company_name:       client_config?.company_name,
      brand_terms:        client_config?.brand_terms,
      competitor_domains: client_config?.competitor_domains,
      prompts,
    });
  } catch (err) {
    console.error('DB upsert failed:', err.message);
  }

  res.json({ ok: true, domain, prompt_count: prompts.length });
});

// ── POST /scan ─────────────────────────────────────────────────────────────
app.post('/scan', requireAuth, async (req, res) => {
  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const promptsPath = path.join(__dirname, 'data', domain, 'prompts.json');
  if (!fs.existsSync(promptsPath)) {
    // Try loading from DB
    try {
      const client = await db.getClient(domain);
      if (!client?.prompts?.length) return res.status(404).json({ error: `No prompts found for domain: ${domain}` });
      fs.mkdirSync(path.dirname(promptsPath), { recursive: true });
      fs.writeFileSync(promptsPath, JSON.stringify(client.prompts, null, 2));
      if (client.brand_terms || client.competitor_domains) {
        fs.writeFileSync(path.join(__dirname, 'data', domain, 'client.json'), JSON.stringify({
          domain, company_name: client.company_name,
          brand_terms: client.brand_terms, competitor_domains: client.competitor_domains,
        }, null, 2));
      }
    } catch (err) {
      return res.status(404).json({ error: `No prompts found for domain: ${domain}` });
    }
  }

  const job_id  = crypto.randomUUID();
  const scan_id = new Date().toISOString().replace(/[:.]/g, '-');

  await queue.setStatus(job_id, {
    job_id, domain, scan_id, status: 'running',
    started_at: new Date().toISOString(), progress: 0, total: 0,
  });

  // Register scan row in DB
  try {
    await db.createScan({ domain, scan_id, engines_run: ['openai', 'serpapi_aio', 'claude', 'gemini'] });
  } catch (err) {
    console.error('DB createScan failed:', err.message);
  }

  // Load prompts count for progress tracking
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
  await queue.setStatus(job_id, { total: prompts.length });

  // Run scan in background
  scan(domain, {
    job_id,
    scan_id,
    onProgress: async (completed, total) => {
      await queue.setStatus(job_id, { progress: completed, total });
    },
  })
    .then(async () => {
      await queue.setStatus(job_id, { status: 'done', completed_at: new Date().toISOString() });
    })
    .catch(async (err) => {
      await queue.setStatus(job_id, { status: 'failed', error: err.message, completed_at: new Date().toISOString() });
      try { await db.failScan(scan_id); } catch {}
    });

  res.status(202).json({ job_id, scan_id, status: 'running', domain });
});

// ── GET /status/:job_id ────────────────────────────────────────────────────
app.get('/status/:job_id', requireAuth, async (req, res) => {
  const job = await queue.getStatus(req.params.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── GET /results/:domain — latest scan JSON ────────────────────────────────
app.get('/results/:domain', requireAuth, async (req, res) => {
  const domain   = req.params.domain;
  const scanPath = path.join(__dirname, 'data', domain, 'latest_scan.json');

  // Try filesystem first (fast)
  if (fs.existsSync(scanPath)) {
    try { return res.json(JSON.parse(fs.readFileSync(scanPath, 'utf8'))); } catch {}
  }

  // Fall back to DB
  try {
    const scan = await db.getLatestScan(domain);
    if (!scan) return res.status(404).json({ error: 'No scan results found' });
    res.json({ domain, scan_date: scan.scan_date, scan_id: scan.scan_id, results: scan.results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /history/:domain — week-by-week scan history ──────────────────────
app.get('/history/:domain', requireAuth, async (req, res) => {
  try {
    const rows = await db.getScanHistory(req.params.domain);
    res.json({ domain: req.params.domain, scans: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /report/:domain — generate and stream PDF ─────────────────────────
app.get('/report/:domain', requireAuth, async (req, res) => {
  const domain   = req.params.domain;
  const scanPath = path.join(__dirname, 'data', domain, 'latest_scan.json');

  // If no local scan file, restore from DB first
  if (!fs.existsSync(scanPath)) {
    try {
      const scan = await db.getLatestScan(domain);
      if (!scan) return res.status(404).json({ error: 'No scan results found — run a scan first' });
      fs.mkdirSync(path.join(__dirname, 'data', domain), { recursive: true });
      fs.writeFileSync(scanPath, JSON.stringify({
        domain, scan_date: scan.scan_date, scan_id: scan.scan_id,
        total_prompts: scan.prompts_tested, overall_pct: scan.overall_pct,
        engines_run: scan.engines_run, results: scan.results,
      }, null, 2));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const pdfPath = await generateReport(domain);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${domain}-visibility-report.pdf"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    console.error('Report failed:', err.message);
    res.status(500).json({ error: `Report generation failed: ${err.message}` });
  }
});

// ── GET /responses/:domain ─────────────────────────────────────────────────
app.get('/responses/:domain', requireAuth, (req, res) => {
  const responsesDir = path.join(__dirname, 'data', req.params.domain, 'responses');
  if (!fs.existsSync(responsesDir)) return res.json({ scans: [] });
  const scans = fs.readdirSync(responsesDir)
    .filter(d => fs.statSync(path.join(responsesDir, d)).isDirectory())
    .sort().reverse()
    .map(scanId => ({ scan_id: scanId, prompt_count: fs.readdirSync(path.join(responsesDir, scanId)).length }));
  res.json({ domain: req.params.domain, scans });
});

// ── GET /responses/:domain/:scan_id/:prompt_id ────────────────────────────
app.get('/responses/:domain/:scan_id/:prompt_id', requireAuth, (req, res) => {
  const { domain, scan_id, prompt_id } = req.params;
  const filePath = path.join(__dirname, 'data', domain, 'responses', scan_id, `${prompt_id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Response not found' });
  try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch { res.status(500).json({ error: 'Failed to read response' }); }
});

// ── GET /clients ───────────────────────────────────────────────────────────
app.get('/clients', requireAuth, async (req, res) => {
  try {
    const rows = await db.listClients();
    res.json({ clients: rows });
  } catch {
    // Fallback to filesystem if DB unavailable
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) return res.json({ clients: [] });
    const clients = fs.readdirSync(dataDir)
      .filter(d => fs.existsSync(path.join(dataDir, d, 'prompts.json')))
      .map(domain => ({ domain, last_scan: null, overall_pct: null, status: 'idle' }));
    res.json({ clients });
  }
});

// ── GET /health ────────────────────────────────────────────────────────────
// ONE-TIME: recalculate overall_pct for all scans using per-prompt metric
app.post('/admin/recalc-pct', requireAuth, async (req, res) => {
  const { rows } = await db.query(`SELECT scan_id, domain, results FROM weekly_scans WHERE results IS NOT NULL`);
  const engines = ['openai','serpapi_aio','claude','gemini'];
  let updated = 0;
  for (const row of rows) {
    const results = typeof row.results === 'string' ? JSON.parse(row.results) : row.results;
    if (!Array.isArray(results)) continue;
    const hit = results.filter(r => !r.error && engines.some(k => r.engines?.[k]?.brand_mentioned)).length;
    const pct = results.length > 0 ? Math.round(hit / results.length * 100) : 0;
    await db.query(`UPDATE weekly_scans SET overall_pct = $1 WHERE scan_id = $2`, [pct, row.scan_id]);
    updated++;
  }
  res.json({ ok: true, updated });
});

app.get('/health', async (_req, res) => {
  const jobs = await queue.listRecentJobs(5).catch(() => []);
  res.json({ ok: true, recent_jobs: jobs.length });
});

// ── Dashboard ──────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Epic@2026!';
const dashboardSessions = new Set();

function parseCookies(req) {
  const out = {};
  for (const c of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = c.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('=').trim());
  }
  return out;
}

function requireDashboard(req, res, next) {
  if (dashboardSessions.has(parseCookies(req).ds)) return next();
  res.redirect('/dashboard/login');
}

app.use('/dashboard/static', express.static(path.join(__dirname, 'public')));

app.get('/dashboard/login', (req, res) => {
  const err = req.query.error ? '<p class="err">Wrong password</p>' : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ESP Login</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0f1117;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif}
.box{background:#1a1d27;border:1px solid #2a2d3e;border-radius:12px;padding:40px;width:360px;text-align:center}
h1{color:#fff;font-size:20px;margin-bottom:6px}.sub{color:#6b7280;font-size:14px;margin-bottom:28px}
input{width:100%;padding:11px 14px;background:#0f1117;border:1px solid #2a2d3e;border-radius:8px;color:#fff;font-size:15px;margin-bottom:14px;outline:none}
input:focus{border-color:#6366f1}button{width:100%;padding:12px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600}
button:hover{background:#5254cc}.err{color:#ef4444;font-size:13px;margin-bottom:12px}</style></head>
<body><div class="box"><h1>ESP AI Tracker</h1><p class="sub">Enter your password to continue</p>
${err}<form method="POST" action="/dashboard/login">
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Sign In</button></form></div></body></html>`);
});

app.post('/dashboard/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    const token = crypto.randomUUID();
    dashboardSessions.add(token);
    res.setHeader('Set-Cookie', `ds=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return res.redirect('/dashboard');
  }
  res.redirect('/dashboard/login?error=1');
});

app.get('/dashboard/logout', (req, res) => {
  dashboardSessions.delete(parseCookies(req).ds);
  res.clearCookie('ds');
  res.redirect('/dashboard/login');
});

app.get('/dashboard', requireDashboard, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Dashboard data endpoints (session-protected, no API key needed)
app.get('/dashboard/api/clients', requireDashboard, async (req, res) => {
  try {
    res.json({ clients: await db.listClients() });
  } catch (err) {
    const dataDir = path.join(__dirname, 'data');
    const clients = fs.existsSync(dataDir)
      ? fs.readdirSync(dataDir).filter(d => fs.existsSync(path.join(dataDir, d, 'prompts.json')))
          .map(domain => ({ domain, company_name: domain, overall_pct: null, scan_status: 'idle' }))
      : [];
    res.json({ clients });
  }
});

app.get('/dashboard/api/results/:domain', requireDashboard, async (req, res) => {
  const domain = req.params.domain;
  const scanPath = path.join(__dirname, 'data', domain, 'latest_scan.json');
  if (fs.existsSync(scanPath)) {
    try { return res.json(JSON.parse(fs.readFileSync(scanPath, 'utf8'))); } catch {}
  }
  try {
    const scan = await db.getLatestScan(domain);
    if (!scan) return res.status(404).json({ error: 'No results' });
    res.json({ domain, scan_date: scan.scan_date, scan_id: scan.scan_id, results: scan.results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard/api/history/:domain', requireDashboard, async (req, res) => {
  try {
    res.json({ scans: await db.getScanHistory(req.params.domain, 24) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard/report/:domain', requireDashboard, async (req, res) => {
  const domain = req.params.domain;
  const scanPath = path.join(__dirname, 'data', domain, 'latest_scan.json');
  if (!fs.existsSync(scanPath)) {
    try {
      const scan = await db.getLatestScan(domain);
      if (!scan) return res.status(404).send('No scan results found — run a scan first');
      fs.mkdirSync(path.join(__dirname, 'data', domain), { recursive: true });
      fs.writeFileSync(scanPath, JSON.stringify({
        domain, scan_date: scan.scan_date, scan_id: scan.scan_id,
        total_prompts: scan.prompts_tested, overall_pct: scan.overall_pct,
        engines_run: scan.engines_run, results: scan.results,
      }, null, 2));
    } catch (err) { return res.status(500).send(err.message); }
  }
  try {
    const pdfPath = await generateReport(domain);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${domain}-visibility-report.pdf"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    res.status(500).send(`Report generation failed: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ESP AI Tracker API running on :${PORT}`));
