// Redis job queue using Upstash (rediss:// TLS)
import Redis from 'ioredis';

let redis;

export function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      tls: {},
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    redis.on('error', (err) => console.error('Redis error:', err.message));
  }
  return redis;
}

const JOB_TTL = 60 * 60 * 24; // 24h

export const queue = {
  // Store job status in Redis hash
  async setStatus(job_id, fields) {
    const r = getRedis();
    await r.hset(`scan:status:${job_id}`, fields);
    await r.expire(`scan:status:${job_id}`, JOB_TTL);
  },

  async getStatus(job_id) {
    const r = getRedis();
    const data = await r.hgetall(`scan:status:${job_id}`);
    if (!data || !data.job_id) return null;
    // Parse numeric fields
    if (data.progress) data.progress = parseInt(data.progress);
    if (data.total) data.total = parseInt(data.total);
    return data;
  },

  async incrementProgress(job_id) {
    const r = getRedis();
    const val = await r.hincrby(`scan:status:${job_id}`, 'progress', 1);
    return val;
  },

  async listRecentJobs(limit = 50) {
    const r = getRedis();
    const keys = await r.keys('scan:status:*');
    if (!keys.length) return [];
    const jobs = await Promise.all(
      keys.slice(0, limit).map(k => r.hgetall(k))
    );
    return jobs.filter(Boolean).sort((a, b) =>
      (b.started_at || '').localeCompare(a.started_at || '')
    );
  },
};
