// src/db/index.js
import pg from 'pg'
import 'dotenv/config'

// ─── Postgres Pool ────────────────────────────────────────────────────────────
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
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

// ─── In-Memory Cache (replaces Redis) ────────────────────────────────────────
const memCache = new Map()

export function cacheSet(key, value, ttlSeconds) {
  memCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  })
}

export function cacheGet(key) {
  const entry = memCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key)
    return null
  }
  return entry.value
}

export function cacheDel(key) {
  memCache.delete(key)
}

export function cacheFlush() {
  memCache.clear()
}

// ─── Config Cache (read from DB, cached in memory 60s) ────────────────────────
export async function getConfig(key) {
  const cacheKey = `config:${key}`
  const cached = cacheGet(cacheKey)
  if (cached !== null) return cached
  const { rows } = await db.query('SELECT value FROM config WHERE key=$1', [key])
  const value = rows[0]?.value ?? null
  if (value !== null) cacheSet(cacheKey, value, 60)
  return value
}

export async function setConfig(key, value) {
  await db.query(
    `INSERT INTO config (key, value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
    [key, String(value)]
  )
  cacheDel(`config:${key}`)
}

export async function getAllConfig() {
  const { rows } = await db.query('SELECT key, value FROM config ORDER BY key')
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// ─── User count cache (updates every 5 min) ───────────────────────────────────
export async function getTotalUsers() {
  const cached = cacheGet('stat:total_users')
  if (cached !== null) return parseInt(cached)
  const { rows } = await db.query('SELECT COUNT(*) FROM users WHERE is_banned=false')
  const count = parseInt(rows[0].count)
  cacheSet('stat:total_users', String(count), 300)
  return count
}