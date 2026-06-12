#!/usr/bin/env node
// Exports all LLM responses for a domain into a multi-sheet Excel file.
// Sheet 1: Summary (visibility % by engine + bucket)
// Sheet 2: All responses (one row per prompt × engine)
// Sheet 3: Competitor mentions

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const domainArg = process.argv.indexOf('--domain');
if (domainArg === -1) { console.error('Usage: node export-responses.js --domain <domain>'); process.exit(1); }
const DOMAIN = process.argv[domainArg + 1];

const scanPath = path.join(__dirname, 'data', DOMAIN, 'latest_scan.json');
if (!fs.existsSync(scanPath)) { console.error('latest_scan.json not found'); process.exit(1); }

const scan    = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
const results = scan.results;
const engines = ['openai', 'serpapi_aio', 'claude', 'gemini'];
const labels  = { openai: 'OpenAI (gpt-4o)', serpapi_aio: 'Google AI Mode', claude: 'Claude Haiku 4.5', gemini: 'Gemini 2.0 Flash' };

// Load full responses from filesystem if available
const responsesBase = path.join(__dirname, 'data', DOMAIN, 'responses');
let fullResponseMap = {}; // prompt_id → { engine → full_text }
if (fs.existsSync(responsesBase)) {
  const scanDirs = fs.readdirSync(responsesBase).sort().reverse();
  if (scanDirs.length) {
    const latestDir = path.join(responsesBase, scanDirs[0]);
    for (const file of fs.readdirSync(latestDir)) {
      const promptId = file.replace('.json', '');
      try {
        const data = JSON.parse(fs.readFileSync(path.join(latestDir, file), 'utf8'));
        fullResponseMap[promptId] = data.responses || {};
      } catch {}
    }
  }
}

// ── Sheet 1: Summary ──────────────────────────────────────────────────────
const summaryRows = [['Metric', ...engines.map(e => labels[e])]];

// Visibility by engine
const visRow = ['Brand Visibility %'];
for (const e of engines) {
  const rows = results.filter(r => r.engines?.[e]);
  const hits = rows.filter(r => r.engines[e].brand_mentioned).length;
  visRow.push(`${Math.round(hits / rows.length * 100)}% (${hits}/${rows.length})`);
}
summaryRows.push(visRow);
summaryRows.push([]);

// By bucket
const buckets = [...new Set(results.map(r => r.topic_bucket))];
summaryRows.push(['Topic Bucket', ...engines.map(e => labels[e]), 'Overall']);
for (const b of buckets) {
  const bRows = results.filter(r => r.topic_bucket === b);
  const row = [b];
  let bTotal = 0, bHits = 0;
  for (const e of engines) {
    const hits = bRows.filter(r => r.engines?.[e]?.brand_mentioned).length;
    bTotal += bRows.length; bHits += hits;
    row.push(`${Math.round(hits / bRows.length * 100)}%`);
  }
  row.push(`${Math.round(bHits / bTotal * 100)}%`);
  summaryRows.push(row);
}

// ── Sheet 2: All responses ─────────────────────────────────────────────────
const responseRows = [[
  'Prompt ID', 'Topic Bucket', 'Query',
  'Engine', 'Brand Mentioned', 'Citation URL',
  'Pre-loaded Competitors', 'Detected Competitors',
  'Response (snippet)', 'Full Response',
]];

for (const r of results) {
  if (r.error) continue;
  for (const e of engines) {
    const eng = r.engines?.[e];
    if (!eng) continue;
    const fullText = fullResponseMap[r.prompt_id]?.[e] || eng.response_snippet || '';
    responseRows.push([
      r.prompt_id,
      r.topic_bucket,
      r.query,
      labels[e],
      eng.brand_mentioned ? 'YES' : 'no',
      eng.citation_url ? 'YES' : 'no',
      (eng.competitors_mentioned || []).join(', '),
      (eng.detected_competitors || []).join(', '),
      eng.response_snippet || '',
      fullText,
    ]);
  }
}

// ── Sheet 3: Competitor mentions ───────────────────────────────────────────
const compCounts = {};
for (const r of results) {
  for (const e of engines) {
    const eng = r.engines?.[e];
    if (!eng) continue;
    for (const c of [...(eng.competitors_mentioned||[]), ...(eng.detected_competitors||[])]) {
      if (!compCounts[c]) compCounts[c] = { total: 0, byEngine: {} };
      compCounts[c].total++;
      compCounts[c].byEngine[e] = (compCounts[c].byEngine[e] || 0) + 1;
    }
  }
}

const compRows = [['Competitor', 'Total Mentions', ...engines.map(e => labels[e]), 'Prompts Where Mentioned']];
for (const [comp, data] of Object.entries(compCounts).sort((a,b) => b[1].total - a[1].total)) {
  const promptsWithComp = results.filter(r =>
    engines.some(e => {
      const eng = r.engines?.[e];
      return [...(eng?.competitors_mentioned||[]), ...(eng?.detected_competitors||[])].includes(comp);
    })
  ).map(r => r.query.slice(0, 60)).join(' | ');

  compRows.push([
    comp, data.total,
    ...engines.map(e => data.byEngine[e] || 0),
    promptsWithComp,
  ]);
}

// ── Build workbook ────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();

const wsSummary   = XLSX.utils.aoa_to_sheet(summaryRows);
const wsResponses = XLSX.utils.aoa_to_sheet(responseRows);
const wsCompetitors = XLSX.utils.aoa_to_sheet(compRows);

// Column widths
wsResponses['!cols'] = [
  {wch:12},{wch:22},{wch:60},{wch:20},{wch:14},{wch:12},{wch:30},{wch:40},{wch:60},{wch:120}
];
wsCompetitors['!cols'] = [{wch:30},{wch:14},{wch:18},{wch:18},{wch:18},{wch:18},{wch:80}];
wsSummary['!cols'] = [{wch:28},{wch:20},{wch:20},{wch:20},{wch:20}];

XLSX.utils.book_append_sheet(wb, wsSummary,     'Summary');
XLSX.utils.book_append_sheet(wb, wsResponses,   'All Responses');
XLSX.utils.book_append_sheet(wb, wsCompetitors, 'Competitor Mentions');

const outPath = path.join(__dirname, 'data', DOMAIN, `${DOMAIN}-responses.xlsx`);
XLSX.writeFile(wb, outPath);
console.log(`Exported → ${outPath}`);
console.log(`  Summary: ${buckets.length} buckets`);
console.log(`  Responses: ${responseRows.length - 1} rows (${results.length} prompts × ${engines.length} engines)`);
console.log(`  Competitors: ${compRows.length - 1} unique`);
