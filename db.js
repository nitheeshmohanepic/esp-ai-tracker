// PostgreSQL connection pool (CockroachDB compatible)
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

export const db = {
  query: (text, params) => pool.query(text, params),

  // ── Clients ──────────────────────────────────────────────────────────────
  async upsertClient({ domain, company_name, brand_terms, competitor_domains, prompts }) {
    await db.query(`
      INSERT INTO clients (domain, company_name, brand_terms, competitor_domains, prompts, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (domain) DO UPDATE SET
        company_name       = EXCLUDED.company_name,
        brand_terms        = EXCLUDED.brand_terms,
        competitor_domains = EXCLUDED.competitor_domains,
        prompts            = EXCLUDED.prompts,
        updated_at         = NOW()
    `, [domain, company_name || domain, brand_terms || [], competitor_domains || [], JSON.stringify(prompts || [])]);
  },

  async getClient(domain) {
    const { rows } = await db.query('SELECT * FROM clients WHERE domain = $1', [domain]);
    return rows[0] || null;
  },

  async listClients() {
    const { rows } = await db.query(`
      SELECT c.domain, c.company_name, c.updated_at,
             w.scan_date, w.scan_status, w.overall_pct
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT scan_date, scan_status, overall_pct
        FROM weekly_scans WHERE domain = c.domain
        ORDER BY scan_date DESC LIMIT 1
      ) w ON TRUE
      ORDER BY c.domain
    `);
    return rows;
  },

  // ── Scans ─────────────────────────────────────────────────────────────────
  async createScan({ domain, scan_id, engines_run }) {
    await db.query(`
      INSERT INTO weekly_scans (domain, scan_id, engines_run, scan_status)
      VALUES ($1, $2, $3, 'running')
    `, [domain, scan_id, engines_run]);
  },

  async completeScan({ scan_id, results, overall_pct }) {
    const prompts_tested = results.filter(r => !r.error).length;
    await db.query(`
      UPDATE weekly_scans
      SET scan_status = 'done', prompts_tested = $2, overall_pct = $3,
          results = $4, scan_date = NOW()
      WHERE scan_id = $1
    `, [scan_id, prompts_tested, overall_pct, JSON.stringify(results)]);
  },

  async failScan(scan_id) {
    await db.query(`UPDATE weekly_scans SET scan_status = 'failed' WHERE scan_id = $1`, [scan_id]);
  },

  async getScanHistory(domain, limit = 12) {
    const { rows } = await db.query(`
      SELECT id, scan_id, scan_date, scan_status, prompts_tested, engines_run, overall_pct
      FROM weekly_scans WHERE domain = $1
      ORDER BY scan_date DESC LIMIT $2
    `, [domain, limit]);
    return rows;
  },

  async getLatestScan(domain) {
    const { rows } = await db.query(`
      SELECT * FROM weekly_scans WHERE domain = $1
      ORDER BY scan_date DESC LIMIT 1
    `, [domain]);
    return rows[0] || null;
  },

  // ── Prompt results ────────────────────────────────────────────────────────
  async insertPromptResults(scan_id, results) {
    if (!results.length) return;
    const engines = ['openai', 'serpapi_aio', 'claude', 'gemini'];
    const rows = [];
    for (const r of results) {
      for (const engine of engines) {
        const e = r.engines?.[engine];
        if (!e) continue;
        rows.push([
          scan_id, r.prompt_id, r.query, r.topic_bucket, engine,
          e.brand_mentioned, e.citation_url,
          e.competitors_mentioned || [],
          e.response_snippet, null, // full_response stored in filesystem
        ]);
      }
    }
    // Batch insert
    for (const row of rows) {
      await db.query(`
        INSERT INTO prompt_results
          (scan_id, prompt_id, query, topic_bucket, engine, brand_mentioned,
           citation_url, competitors_mentioned, response_snippet, full_response)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, row);
    }
  },

  async getPromptResults(scan_id) {
    const { rows } = await db.query(`
      SELECT * FROM prompt_results WHERE scan_id = $1 ORDER BY prompt_id, engine
    `, [scan_id]);
    return rows;
  },
};
