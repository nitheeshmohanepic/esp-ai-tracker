#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const domainArg = process.argv.indexOf('--domain');
const DOMAIN    = domainArg !== -1 ? process.argv[domainArg + 1] : 'epicslope.partners';
const scanPath  = path.join(__dirname, 'data', DOMAIN, 'latest_scan.json');
const outputPath = path.join(__dirname, 'data', DOMAIN, 'visibility_report.pdf');

const scan    = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
const results = scan.results;

// ── Engine config ─────────────────────────────────────────────────────────
const ENGINE_KEYS   = ['openai', 'serpapi_aio', 'claude', 'gemini'];
const ENGINE_LABELS = {
  openai:      'OpenAI (gpt-4o)',
  serpapi_aio: 'Google AI Overview',
  claude:      'Claude (Haiku 4.5)',
  gemini:      'Gemini (3.5 Flash)',
};

function pct(n, d) { return d === 0 ? 0 : Math.round((n / d) * 100); }

// ── Engine stats ─────────────────────────────────────────────────────────
const engineStats = ENGINE_KEYS.map(key => {
  const rows    = results.filter(p => p.engines[key]);
  const errors  = rows.filter(p => p.engines[key]?.response_snippet?.startsWith('ERROR')).length;
  const valid   = rows.length - errors;
  const mentions = rows.filter(p => p.engines[key]?.brand_mentioned).length;
  return { key, label: ENGINE_LABELS[key], mentions, valid, total: rows.length, errors, pct: pct(mentions, valid || rows.length) };
});

// ── Topic stats (service-based, combined across all engines) ─────────────
const topicMap = {};
for (const p of results) {
  const t = p.topic_bucket;
  if (!topicMap[t]) topicMap[t] = { total: 0, hits: 0, byEngine: {} };
  for (const key of ENGINE_KEYS) {
    const e = p.engines[key];
    if (!e || e.response_snippet?.startsWith('ERROR')) continue;
    topicMap[t].total++;
    if (e.brand_mentioned) topicMap[t].hits++;
    if (!topicMap[t].byEngine[key]) topicMap[t].byEngine[key] = { total: 0, hits: 0 };
    topicMap[t].byEngine[key].total++;
    if (e.brand_mentioned) topicMap[t].byEngine[key].hits++;
  }
}
const topicRows = Object.entries(topicMap)
  .map(([t, v]) => ({ topic: t, pct: pct(v.hits, v.total), hits: v.hits, total: v.total, byEngine: v.byEngine }))
  .sort((a, b) => b.pct - a.pct);

// ── Weak prompts (brand_mentioned = false across ALL engines) ───────────
const weakPrompts = results.filter(p =>
  ENGINE_KEYS.every(k => !p.engines[k]?.brand_mentioned)
).slice(0, 20);

// ── Competitor mentions ───────────────────────────────────────────────────
const competitorCount = {};
for (const p of results) {
  for (const e of Object.values(p.engines)) {
    for (const c of (e?.competitors_mentioned || [])) competitorCount[c] = (competitorCount[c] || 0) + 1;
  }
}
// Ensure known competitors show even at 0
const knownCompetitors = ['omniscientdigital.com','poweredbysearch.com','directiveconsulting.com','madx.digital','b2bseo.io','siegemedia.com','firstpagesage.com'];
for (const c of knownCompetitors) if (!competitorCount[c]) competitorCount[c] = 0;
const compRows = Object.entries(competitorCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
  .map(([domain, count]) => ({ domain, pct: pct(count, results.length * ENGINE_KEYS.length) }));

// ── Overall ───────────────────────────────────────────────────────────────
const overallHits  = results.filter(p => ENGINE_KEYS.some(k => p.engines[k]?.brand_mentioned)).length;
const overallPct   = pct(overallHits, results.length);
const scanDate     = new Date(scan.scan_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const totalEngines = ENGINE_KEYS.length;

// ── Action items ─────────────────────────────────────────────────────────
const actions = [
  {
    n: '01',
    title: 'Double down on SEO Migration — only service with any AI visibility',
    body: 'Gemini 3.5 Flash mentioned Epic Slope on 13% of SEO Migration prompts — the only positive signal across all services. This means some content or citation exists but isn\'t strong enough to surface consistently. Build 2–3 dedicated migration case study pages (with before/after traffic data) and a "SEO migration checklist" resource. This is the fastest path to increasing visibility from 13% toward 40%+.',
  },
  {
    n: '02',
    title: 'Create "best of" comparison pages for SaaS SEO and Enterprise SEO',
    body: 'SaaS SEO (12 prompts, 0%) and Enterprise SEO (27 prompts, 0–1%) are the two highest-volume service categories and are completely invisible. First Page Sage appeared in 10 responses; Directive in 8. Both are cited in roundup articles. Publishing a "Top B2B SaaS SEO Agencies" buyer\'s guide (with Epic Slope listed and reviewed) directly targets the prompt type AI engines pull from most.',
  },
  {
    n: '03',
    title: 'Get listed in 5+ agency directories and roundup articles',
    body: 'First Page Sage (10 mentions), Directive Consulting (8), and Siege Media (7) all appear because they are cited in high-authority roundup articles and directories that AI engines index as reference sources. Submit Epic Slope to G2, Clutch, DesignRush, and at least 3 editorial "best SaaS SEO agency" listicles. These citations feed directly into Gemini and OpenAI retrieval.',
  },
  {
    n: '04',
    title: 'Publish a pricing transparency page for each service line',
    body: 'Pricing prompts scored 0% across all 4 engines. A dedicated pricing page (or "how B2B SaaS SEO is priced" explainer) signals credibility and gives AI engines a structured, citable page. Competitors without pricing pages are consistently skipped when a pricing-aware source exists. Target the exact query phrasing from the weak prompts list: "how much does a SaaS link building agency charge" and "what should I expect to pay an enterprise SEO consultant".',
  },
  {
    n: '05',
    title: 'Build Link Building and B2B Marketing service pages targeting buyer questions',
    body: 'Link Building and B2B Marketing both scored 0% across all engines. Create dedicated landing pages that directly answer the natural-language questions from the weak prompts — structured with H2s matching exact query phrasing, a FAQ section, and at least one client result. Google AI Overview in particular pulls heavily from on-page FAQ schema markup.',
  },
  {
    n: '06',
    title: 'Increase co-citation signals: LinkedIn + guest posts + podcast mentions',
    body: 'AI engines build brand associations through co-citation — if "Epic Slope" consistently appears alongside "B2B SaaS SEO", "SaaS link building", and "SEO migration" across multiple domains, the brand enters retrieval context. Target 2 LinkedIn thought-leadership posts per week, 1 guest article per month on a DR 50+ SEO blog, and at least 2 podcast appearances on B2B marketing shows this quarter.',
  },
];

// ── HTML helpers ──────────────────────────────────────────────────────────
function bar(pctVal, color = '#e8304a') {
  const w = Math.max(pctVal, 1);
  return `<div class="bar-wrap"><div class="bar" style="width:${w}%;background:${color}"></div><span class="bar-label">${pctVal}%</span></div>`;
}
function badge(pctVal) {
  const color = pctVal === 0 ? '#e8304a' : pctVal < 15 ? '#f0742a' : '#2cb67d';
  return `<span class="badge" style="background:${color}">${pctVal}%</span>`;
}

// ── Engine table ──────────────────────────────────────────────────────────
const engineRowsHtml = engineStats.map(e => `
  <tr>
    <td class="col-label">${e.label}${e.errors > 0 ? `<span class="err-note"> · ${e.errors} timeouts</span>` : ''}</td>
    <td class="col-bar">${bar(e.pct)}</td>
  </tr>`).join('');

// ── Topic table with per-engine breakdown ────────────────────────────────
const topicRowsHtml = topicRows.map(t => {
  const engineBreakdown = ENGINE_KEYS.map(k => {
    const v = t.byEngine[k];
    if (!v) return '';
    const p = pct(v.hits, v.total);
    return `<span class="engine-tag">${ENGINE_LABELS[k].split(' ')[0]}: ${p}%</span>`;
  }).join('');
  return `
  <tr>
    <td class="col-label">${t.topic}<div class="engine-row">${engineBreakdown}</div></td>
    <td class="col-bar">${bar(t.pct)}</td>
  </tr>`;
}).join('');

// ── Weak prompts ─────────────────────────────────────────────────────────
const weakRowsHtml = weakPrompts.map(p => `
  <li>${badge(0)} <span class="weak-query">"${p.query}"</span> <span class="weak-bucket">${p.topic_bucket}</span></li>`
).join('');

// ── Competitor table ─────────────────────────────────────────────────────
const compRowsHtml = compRows.map(c => `
  <tr>
    <td class="col-label">${c.domain}</td>
    <td class="col-bar">${bar(c.pct, '#444')}</td>
  </tr>`).join('');

// ── Action items ─────────────────────────────────────────────────────────
const actionsHtml = actions.map(a => `
  <div class="action-item">
    <div class="action-header"><span class="action-num">${a.n}</span><span class="action-title">${a.title}</span></div>
    <p class="action-body">${a.body}</p>
  </div>`).join('');

// ── Full HTML ─────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; font-size:13px; color:#1a1a1a; background:#fff; padding:44px 52px; max-width:860px; margin:0 auto; }

.report-header { margin-bottom:32px; border-bottom:3px solid #e8304a; padding-bottom:18px; }
.report-header h1 { font-size:24px; font-weight:800; color:#111; }
.report-header .meta { font-size:11.5px; color:#666; margin-top:5px; }
.domain-pill { display:inline-block; background:#f3f4f6; border-radius:4px; padding:2px 10px; font-size:11.5px; color:#444; font-weight:600; margin-top:7px; }

.overall-score { display:flex; align-items:center; gap:20px; background:#111; color:#fff; border-radius:8px; padding:18px 26px; margin-bottom:32px; }
.score-number { font-size:50px; font-weight:800; color:#e8304a; line-height:1; }
.score-label { font-size:14px; font-weight:700; }
.score-sub { font-size:11px; color:#aaa; margin-top:3px; }

.section { margin-bottom:32px; }
.section-title { font-size:12px; font-weight:700; color:#fff; background:#1a1a1a; padding:7px 14px; border-radius:4px 4px 0 0; text-transform:uppercase; letter-spacing:0.05em; }
.section-subtitle { font-size:11px; color:#888; margin:5px 0 10px; padding:0 2px; font-style:italic; }

table { width:100%; border-collapse:collapse; }
tr { border-bottom:1px solid #f0f0f0; }
tr:last-child { border-bottom:none; }
td { padding:9px 14px; vertical-align:middle; }
.col-label { width:42%; font-size:12.5px; color:#333; font-weight:500; }
.col-bar { width:58%; }
.table-wrap { border:1px solid #e5e5e5; border-top:none; border-radius:0 0 4px 4px; overflow:hidden; }
tr:nth-child(even) { background:#fafafa; }

.bar-wrap { display:flex; align-items:center; gap:10px; }
.bar { height:18px; border-radius:3px; min-width:2px; }
.bar-label { font-size:12px; font-weight:700; color:#555; white-space:nowrap; }

.err-note { font-size:10.5px; color:#aaa; font-weight:400; }

.engine-row { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
.engine-tag { font-size:10px; background:#f0f0f0; color:#555; padding:1px 6px; border-radius:3px; white-space:nowrap; }

.badge { display:inline-block; color:#fff; font-size:11px; font-weight:700; padding:2px 7px; border-radius:3px; min-width:36px; text-align:center; margin-right:8px; flex-shrink:0; }
.weak-list { list-style:none; padding:10px 14px; border:1px solid #e5e5e5; border-top:none; border-radius:0 0 4px 4px; }
.weak-list li { display:flex; align-items:center; padding:5px 0; border-bottom:1px solid #f5f5f5; flex-wrap:wrap; gap:4px; }
.weak-list li:last-child { border-bottom:none; }
.weak-query { font-size:12px; color:#333; flex:1; }
.weak-bucket { font-size:10px; background:#f0f0f0; color:#777; padding:1px 7px; border-radius:3px; white-space:nowrap; }

.actions-wrap { border:1px solid #e5e5e5; border-top:none; border-radius:0 0 4px 4px; overflow:hidden; }
.action-item { padding:13px 18px; border-bottom:1px solid #f0f0f0; }
.action-item:last-child { border-bottom:none; }
.action-header { display:flex; align-items:baseline; gap:10px; margin-bottom:5px; }
.action-num { font-size:11px; font-weight:800; color:#e8304a; min-width:24px; }
.action-title { font-size:13px; font-weight:700; color:#111; }
.action-body { font-size:11.5px; color:#555; line-height:1.65; padding-left:34px; }

.footer { margin-top:36px; padding-top:14px; border-top:1px solid #eee; font-size:11px; color:#aaa; display:flex; justify-content:space-between; }
.footer strong { color:#e8304a; }
</style></head><body>

<div class="report-header">
  <h1>AI Visibility Report</h1>
  <div class="meta">Scan date: ${scanDate} &nbsp;·&nbsp; ${scan.total_prompts} prompts &nbsp;·&nbsp; ${totalEngines} engines</div>
  <div class="domain-pill">${DOMAIN}</div>
</div>

<div class="overall-score">
  <div class="score-number">${overallPct}%</div>
  <div>
    <div class="score-label">Overall AI Visibility</div>
    <div class="score-sub">% of prompts with at least one brand mention across all engines</div>
  </div>
</div>

<div class="section">
  <div class="section-title">Visibility by AI Engine</div>
  <div class="section-subtitle">% of valid (non-error) prompts where "Epic Slope" or "epicslope.partners" appeared</div>
  <div class="table-wrap"><table>${engineRowsHtml}</table></div>
</div>

<div class="section">
  <div class="section-title">Visibility by Service</div>
  <div class="section-subtitle">Brand mention rate per ESP service line, combined across all engines — with per-engine breakdown</div>
  <div class="table-wrap"><table>${topicRowsHtml}</table></div>
</div>

<div class="section">
  <div class="section-title">Weak &amp; Missing Prompts</div>
  <div class="section-subtitle">Queries where brand_mentioned = false across ALL 4 engines — highest-priority content gaps (top 20 shown)</div>
  <ul class="weak-list">${weakRowsHtml}</ul>
</div>

<div class="section">
  <div class="section-title">Competitor Comparison</div>
  <div class="section-subtitle">Competing domains appearing in AI responses — % of total prompt×engine pairs where they were cited</div>
  <div class="table-wrap"><table>${compRowsHtml}</table></div>
</div>

<div class="section">
  <div class="section-title">Action Items</div>
  <div class="section-subtitle">Prioritised by expected impact — referencing specific service gaps and query patterns from this scan</div>
  <div class="actions-wrap">${actionsHtml}</div>
</div>

<div class="footer">
  <span>Generated by <strong>ESP AI Tracker</strong> &nbsp;·&nbsp; ${DOMAIN}</span>
  <span>${scanDate}</span>
</div>

</body></html>`;

// ── Render PDF ────────────────────────────────────────────────────────────
const htmlPath = path.join(__dirname, 'data', DOMAIN, 'report.html');
fs.writeFileSync(htmlPath, html);
console.log('HTML written, launching Chrome...');

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
await page.pdf({ path: outputPath, format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
await browser.close();
console.log(`Report saved → ${outputPath}`);
