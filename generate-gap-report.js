#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

export async function generateGapReport(domain, ahrefsData) {
  return _generate(domain, ahrefsData);
}

const domainArg = process.argv.indexOf('--domain');
const dataArg   = process.argv.indexOf('--gapdata');
const DOMAIN    = domainArg !== -1 ? process.argv[domainArg + 1] : null;
const GAPDATA   = dataArg   !== -1 ? process.argv[dataArg + 1]   : null;

if (DOMAIN) {
  const ahrefsData = GAPDATA ? JSON.parse(fs.readFileSync(GAPDATA, 'utf8')) : {};
  _generate(DOMAIN, ahrefsData).catch(err => { console.error(err); process.exit(1); });
}

async function _generate(DOMAIN, ahrefsData = {}) {
  const scanPath   = path.join(__dirname, 'data', DOMAIN, 'latest_scan.json');
  const clientPath = path.join(__dirname, 'data', DOMAIN, 'client.json');
  const outputPath = path.join(__dirname, 'data', DOMAIN, 'gap_report.pdf');
  const htmlPath   = path.join(__dirname, 'data', DOMAIN, 'gap_report.html');

  if (!fs.existsSync(scanPath)) throw new Error(`No scan data found for ${DOMAIN}. Run a scan first.`);

  const scan    = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
  const client  = fs.existsSync(clientPath) ? JSON.parse(fs.readFileSync(clientPath, 'utf8')) : {};
  const results = scan.results || [];

  const companyName  = client.company_name || DOMAIN;
  const competitors  = client.competitor_domains || [];
  const brandTerms   = client.brand_terms || [DOMAIN.replace('.', '').replace(/\..*$/, '')];
  const scanDate     = new Date(scan.scan_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const ENGINES      = ['openai', 'serpapi_aio', 'claude', 'gemini'];
  const ENGINE_LABELS = { openai: 'OpenAI', serpapi_aio: 'Google AI Mode', claude: 'Claude', gemini: 'Gemini' };

  function pct(n, d) { return d === 0 ? 0 : Math.round((n / d) * 100); }
  function badge(p) {
    if (p >= 80) return `<span class="badge green">${p}%</span>`;
    if (p >= 50) return `<span class="badge amber">${p}%</span>`;
    return `<span class="badge red">${p}%</span>`;
  }

  // ── Overall visibility ────────────────────────────────────────────────
  const overallHits = results.filter(r => ENGINES.some(e => r.engines?.[e]?.brand_mentioned)).length;
  const overallPct  = pct(overallHits, results.length);

  // ── Per-bucket gap analysis ───────────────────────────────────────────
  const bucketMap = {};
  for (const r of results) {
    const b = r.topic_bucket;
    if (!bucketMap[b]) bucketMap[b] = { total: 0, hits: 0, compMentions: {}, missedQueries: [] };
    bucketMap[b].total++;
    const mentioned = ENGINES.some(e => r.engines?.[e]?.brand_mentioned);
    if (mentioned) { bucketMap[b].hits++; continue; }
    bucketMap[b].missedQueries.push(r.query);
    for (const e of ENGINES) {
      const eng = r.engines?.[e];
      if (!eng) continue;
      for (const c of [...(eng.competitors_mentioned || []), ...(eng.detected_competitors || [])]) {
        if (brandTerms.some(t => c.includes(t))) continue;
        bucketMap[b].compMentions[c] = (bucketMap[b].compMentions[c] || 0) + 1;
      }
    }
  }

  const buckets = Object.entries(bucketMap)
    .map(([name, b]) => ({ name, ...b, pct: pct(b.hits, b.total) }))
    .sort((a, b) => a.pct - b.pct);

  // ── Global competitor gap mentions ────────────────────────────────────
  const globalGap = {};
  for (const b of buckets) {
    for (const [c, n] of Object.entries(b.compMentions)) {
      globalGap[c] = (globalGap[c] || 0) + n;
    }
  }
  const topGapSources = Object.entries(globalGap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  // ── Ahrefs competitor table ───────────────────────────────────────────
  const clientAhrefs = ahrefsData[DOMAIN] || {};
  const compRows = competitors.map(c => {
    const a = ahrefsData[c] || {};
    const drDelta = (a.dr && clientAhrefs.dr) ? a.dr - clientAhrefs.dr : null;
    const gapMentions = globalGap[c] || 0;
    return { domain: c, ...a, drDelta, gapMentions };
  }).sort((a, b) => (b.traffic || 0) - (a.traffic || 0));

  // ── Content GAPS — the most important section ─────────────────────────
  const contentGaps = buckets
    .filter(b => b.pct < 100 && b.missedQueries.length > 0)
    .map(b => {
      const topComps = Object.entries(b.compMentions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([c]) => c);
      const urgency = b.pct <= 40 ? 'critical' : b.pct <= 60 ? 'high' : 'medium';
      return { ...b, topComps, urgency };
    })
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2 };
      return order[a.urgency] - order[b.urgency];
    });

  // ── HTML ──────────────────────────────────────────────────────────────
  const bucketRowsHtml = buckets.map(b => {
    const topComps = Object.entries(b.compMentions).sort((a,c)=>c[1]-a[1]).slice(0,3).map(([c])=>c).join(', ') || '—';
    return `<tr>
      <td>${b.name}</td>
      <td>${badge(b.pct)}</td>
      <td>${b.hits}/${b.total}</td>
      <td class="dim">${b.missedQueries.length > 0 ? b.missedQueries.length + ' missed' : '—'}</td>
      <td class="dim small">${topComps}</td>
    </tr>`;
  }).join('');

  const compTableHtml = compRows.map(c => {
    const drCell = c.dr ? `${c.dr}${c.drDelta !== null ? ` <span class="${c.drDelta > 0 ? 'red' : 'green'}">(${c.drDelta > 0 ? '+' : ''}${c.drDelta})</span>` : ''}` : '—';
    const trafficCell = c.traffic ? c.traffic.toLocaleString() : '—';
    const kwCell = c.keywords ? c.keywords.toLocaleString() : '—';
    const gapCell = c.gapMentions > 0 ? `<span class="badge red">${c.gapMentions}×</span>` : '—';
    return `<tr><td class="bold">${c.domain}</td><td>${drCell}</td><td>${trafficCell}</td><td>${kwCell}</td><td>${gapCell}</td></tr>`;
  }).join('');

  const contentGapsHtml = contentGaps.map(b => {
    const urgencyLabel = b.urgency === 'critical' ? 'CRITICAL' : b.urgency === 'high' ? 'HIGH' : 'MEDIUM';
    const urgencyClass = b.urgency;
    const competitorNote = b.topComps.length
      ? `<div class="gap-comps">Appearing instead: <strong>${b.topComps.join(', ')}</strong></div>`
      : '';
    const queriesHtml = b.missedQueries.map(q => `<li>${q}</li>`).join('');
    return `
      <div class="gap-block ${urgencyClass}">
        <div class="gap-header">
          <span class="gap-badge ${urgencyClass}">${urgencyLabel}</span>
          <span class="gap-bucket">${b.name}</span>
          <span class="gap-pct">${b.pct}% visibility · ${b.missedQueries.length} unanswered prompt${b.missedQueries.length > 1 ? 's' : ''}</span>
        </div>
        <div class="gap-body">
          <div class="gap-write-about">
            <strong>Write about:</strong> Publish content that directly answers these exact queries —
            ${b.missedQueries.length === 1
              ? `<em>"${b.missedQueries[0]}"</em>.`
              : `starting with <em>"${b.missedQueries[0]}"</em> and <em>"${b.missedQueries[1] || ''}"</em>${b.missedQueries.length > 2 ? ` (+${b.missedQueries.length - 2} more)` : ''}.`
            }
          </div>
          ${competitorNote}
          <ul class="gap-queries">${queriesHtml}</ul>
        </div>
      </div>`;
  }).join('');

  const gapSourcesHtml = topGapSources
    .map(([c, n]) => `<span class="chip">${c} <strong>${n}×</strong></span>`)
    .join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;font-size:13px;color:#1a1a2e;background:#fff;padding:0}
  .page{padding:40px 48px}

  /* Header */
  .report-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:24px;border-bottom:2px solid #6366f1}
  .report-header h1{font-size:22px;font-weight:700;color:#0f0f23}
  .report-header .meta{font-size:11px;color:#6b7280;margin-top:4px}
  .header-badge{background:#6366f1;color:#fff;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600}

  /* Score strip */
  .score-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:32px}
  .score-card{background:#f8f9ff;border:1px solid #e8eaf0;border-radius:10px;padding:16px}
  .score-card.accent{background:#6366f1;border-color:#6366f1}
  .score-val{font-size:26px;font-weight:700;color:#0f0f23}
  .score-card.accent .score-val{color:#fff}
  .score-lbl{font-size:11px;color:#6b7280;margin-top:2px}
  .score-card.accent .score-lbl{color:rgba(255,255,255,.75)}

  /* Section titles */
  .section{margin-bottom:28px}
  .section-title{font-size:14px;font-weight:700;color:#0f0f23;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
  .section-sub{font-size:11px;color:#6b7280;margin-bottom:12px}

  /* Tables */
  table{width:100%;border-collapse:collapse}
  th{font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;border-bottom:1px solid #e8eaf0;text-align:left}
  td{padding:8px 10px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .bold{font-weight:600}
  .dim{color:#6b7280}
  .small{font-size:11px}
  .red{color:#dc2626}
  .green{color:#16a34a}

  /* Badges */
  .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
  .badge.green{background:#dcfce7;color:#15803d}
  .badge.amber{background:#fef3c7;color:#92400e}
  .badge.red{background:#fee2e2;color:#dc2626}

  /* Gap section — the hero */
  .gap-section{background:#fff;border:1px solid #e8eaf0;border-radius:12px;overflow:hidden;margin-bottom:28px}
  .gap-section-header{background:#0f0f23;color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
  .gap-section-header h2{font-size:14px;font-weight:700;letter-spacing:.3px}
  .gap-section-header span{font-size:11px;color:rgba(255,255,255,.6)}
  .gap-block{padding:16px 20px;border-bottom:1px solid #f0f0f0}
  .gap-block:last-child{border-bottom:none}
  .gap-block.critical{border-left:4px solid #dc2626}
  .gap-block.high{border-left:4px solid #d97706}
  .gap-block.medium{border-left:4px solid #2563eb}
  .gap-header{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
  .gap-badge{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
  .gap-badge.critical{background:#fee2e2;color:#dc2626}
  .gap-badge.high{background:#fef3c7;color:#92400e}
  .gap-badge.medium{background:#dbeafe;color:#1d4ed8}
  .gap-bucket{font-size:13px;font-weight:600;color:#0f0f23}
  .gap-pct{font-size:11px;color:#6b7280;margin-left:auto}
  .gap-body{padding-left:4px}
  .gap-write-about{font-size:12px;color:#374151;line-height:1.6;margin-bottom:8px;background:#f8f9ff;padding:8px 12px;border-radius:6px}
  .gap-comps{font-size:11px;color:#6b7280;margin-bottom:8px}
  .gap-queries{padding-left:16px;margin-top:6px}
  .gap-queries li{font-size:11px;color:#6b7280;margin-bottom:3px;font-style:italic}

  /* Gap sources chips */
  .chips-wrap{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:16px}
  .chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;font-size:11px}
  .chip strong{color:#374151}

  /* Competitor table */
  .comp-table-wrap{background:#fff;border:1px solid #e8eaf0;border-radius:10px;overflow:hidden}

  /* Footer */
  .footer{margin-top:32px;padding-top:16px;border-top:1px solid #e8eaf0;display:flex;justify-content:space-between;font-size:10px;color:#9ca3af}
</style>
</head><body>
<div class="page">

  <div class="report-header">
    <div>
      <h1>${companyName} — Competitor Gap Report</h1>
      <div class="meta">Scan date: ${scanDate} &nbsp;·&nbsp; ${results.length} prompts &nbsp;·&nbsp; ${competitors.length} competitors tracked</div>
    </div>
    <div class="header-badge">${overallPct}% AI visibility</div>
  </div>

  <div class="score-strip">
    <div class="score-card accent">
      <div class="score-val">${overallPct}%</div>
      <div class="score-lbl">Overall AI visibility</div>
    </div>
    <div class="score-card">
      <div class="score-val">${clientAhrefs.dr || '—'}</div>
      <div class="score-lbl">Domain rating</div>
    </div>
    <div class="score-card">
      <div class="score-val">${clientAhrefs.traffic ? clientAhrefs.traffic.toLocaleString() : '—'}</div>
      <div class="score-lbl">Organic traffic / mo</div>
    </div>
    <div class="score-card">
      <div class="score-val">${results.length - overallHits}</div>
      <div class="score-lbl">Missed prompts</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Visibility by topic bucket</div>
    <div class="section-sub">Per-prompt hit rate sorted from weakest to strongest. Missed prompts and who appeared instead.</div>
    <table>
      <thead><tr><th>Bucket</th><th>Visibility</th><th>Hits</th><th>Missed</th><th>Appearing instead</th></tr></thead>
      <tbody>${bucketRowsHtml}</tbody>
    </table>
  </div>

  <div class="gap-section">
    <div class="gap-section-header">
      <h2>Content gaps — what to start writing about</h2>
      <span>${contentGaps.length} buckets need content</span>
    </div>
    ${contentGapsHtml}
  </div>

  <div class="section">
    <div class="section-title">What appears in your blind spots</div>
    <div class="section-sub">Sources cited by AI engines across ${results.length - overallHits} missed prompts.</div>
    <div class="chips-wrap">${gapSourcesHtml}</div>
  </div>

  <div class="section">
    <div class="section-title">Competitor authority analysis</div>
    <div class="section-sub">DR delta vs ${companyName} (${clientAhrefs.dr || '?'}). Gap mentions = times competitor appeared when ${companyName} didn't.</div>
    <div class="comp-table-wrap">
      <table>
        <thead><tr><th>Competitor</th><th>DR (delta vs you)</th><th>Org traffic / mo</th><th>Org keywords</th><th>Gap mentions</th></tr></thead>
        <tbody>${compTableHtml}</tbody>
      </table>
    </div>
  </div>

  <div class="footer">
    <span>Generated by ESP AI Tracker &nbsp;·&nbsp; ${DOMAIN}</span>
    <span>${scanDate}</span>
  </div>

</div>
</body></html>`;

  fs.writeFileSync(htmlPath, html);

  const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    '/nix/var/nix/profiles/default/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const CHROME_PATH = CHROME_CANDIDATES.find(p => p && fs.existsSync(p));
  if (!CHROME_PATH) throw new Error('No Chrome/Chromium binary found. Set CHROME_PATH env var.');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
  await page.pdf({ path: outputPath, format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  await browser.close();
  console.log(`Gap report saved → ${outputPath}`);
  return outputPath;
}
