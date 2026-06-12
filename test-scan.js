#!/usr/bin/env node
// Quick local test — runs 5 prompts through all 4 engines and prints results.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scan } from './scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_DOMAIN = 'singulr.ai';
const TEST_PROMPTS = [
  { id: 't01', topic_bucket: 'ML Observability', query: 'What are the best ML model monitoring and observability platforms for production AI?' },
  { id: 't02', topic_bucket: 'ML Observability', query: 'How do data science teams monitor AI model performance and detect drift in production?' },
  { id: 't03', topic_bucket: 'ML Observability', query: 'What tools do MLOps teams use to explain and monitor machine learning models?' },
  { id: 't04', topic_bucket: 'AI Risk', query: 'What platforms help enterprises manage AI model risk and explainability?' },
  { id: 't05', topic_bucket: 'AI Risk', query: 'What are the top AI model monitoring vendors for financial services and insurance?' },
];

// Write test prompts to a temp location
const dir = path.join(__dirname, 'data', TEST_DOMAIN);
fs.mkdirSync(dir, { recursive: true });
const origPrompts = path.join(dir, 'prompts.json');
const backupPath  = path.join(dir, 'prompts.json.bak');

// Backup existing prompts
if (fs.existsSync(origPrompts)) fs.copyFileSync(origPrompts, backupPath);
fs.writeFileSync(origPrompts, JSON.stringify(TEST_PROMPTS, null, 2));

console.log(`\nRunning ${TEST_PROMPTS.length} test prompts across 4 engines...\n`);

try {
  const result = await scan(TEST_DOMAIN, { scan_id: 'test-' + Date.now() });

  // Print results per prompt
  const engines = ['openai', 'serpapi_aio', 'claude', 'gemini'];
  for (const r of result.results) {
    console.log(`\n── ${r.prompt_id} [${r.topic_bucket}] ──`);
    console.log(`Q: ${r.query}`);
    for (const eng of engines) {
      const e = r.engines?.[eng];
      if (!e) { console.log(`  ${eng}: MISSING`); continue; }
      if (e.response_snippet?.startsWith('ERROR')) {
        console.log(`  ${eng}: ❌ ${e.response_snippet}`);
      } else {
        console.log(`  ${eng}: brand=${e.brand_mentioned ? '✅' : '—'} | snippet(${e.response_snippet?.length}): ${e.response_snippet?.slice(0, 120).replace(/\n/g,' ')}...`);
      }
    }
  }

  // Summary
  console.log('\n══ SUMMARY ══');
  for (const eng of engines) {
    const hits = result.results.filter(r => r.engines?.[eng]?.brand_mentioned).length;
    const errs = result.results.filter(r => r.engines?.[eng]?.response_snippet?.startsWith('ERROR')).length;
    console.log(`${eng}: ${hits}/${TEST_PROMPTS.length} mentions | ${errs} errors`);
  }

} finally {
  // Restore original prompts
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, origPrompts);
    fs.unlinkSync(backupPath);
  }
}
