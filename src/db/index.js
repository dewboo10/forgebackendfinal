// src/db/index.js
import pg from 'pg'
import { createClient } from 'redis'
import 'dotenv/config'

// ─── Postgres Pool ────────────────────────────────────────────────────────────
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                    // max connections — tune up for production
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('error', (err) => console.error('PG pool error:', err))

export const db = {
  query: (text, params) => pool.query(text, params),
  async tx(fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }
}

// ─── Redis ────────────────────────────────────────────────────────────────────
export const redis = createClient({ url: process.env.REDIS_URL })
redis.on('error', (err) => console.error('Redis error:', err))
await redis.connect()

// ─── Config Cache (read from DB, cached in Redis 60s) ─────────────────────────
export async function getConfig(key) {
  const cacheKey = `config:${key}`
  const cached = await redis.get(cacheKey)
  if (cached !== null) return cached
  const { rows } = await db.query('SELECT value FROM config WHERE key=$1', [key])
  const value = rows[0]?.value ?? null
  if (value !== null) await redis.setEx(cacheKey, 60, value)
  return value
}

export async function setConfig(key, value) {
  await db.query(
    `INSERT INTO config (key, value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
    [key, String(value)]
  )
  await redis.del(`config:${key}`)
}

export async function getAllConfig() {
  const { rows } = await db.query('SELECT key, value FROM config ORDER BY key')
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// ─── User count cache (for halving — updates every 5 min) ─────────────────────
export async function getTotalUsers() {
  const cached = await redis.get('stat:total_users')
  if (cached) return parseInt(cached)
  const { rows } = await db.query('SELECT COUNT(*) FROM users WHERE is_banned=false')
  const count = parseInt(rows[0].count)
  await redis.setEx('stat:total_users', 300, String(count))
  return count
}
