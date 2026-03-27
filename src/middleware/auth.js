// src/middleware/auth.js
import crypto from 'crypto'
import { db, cacheGet, cacheSet, cacheDel } from '../db/index.js'

// ─── Validate Telegram WebApp initData ────────────────────────────────────────
export function parseTelegramInitData(initData) {
  if (!initData) return null
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null

  params.delete('hash')
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest()

  const expectedHash = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex')

  if (expectedHash !== hash) return null

  const authDate = parseInt(params.get('auth_date') || '0')
  if (Date.now() / 1000 - authDate > 86400) return null

  try {
    const user = JSON.parse(params.get('user') || '{}')
    return { user, authDate }
  } catch {
    return null
  }
}

// ─── Fastify preHandler: attach req.user from initData ────────────────────────
export async function telegramAuth(req, reply) {
    // DEV ONLY — remove before production
  if (process.env.NODE_ENV !== 'production' && process.env.DEV_USER_ID) {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [process.env.DEV_USER_ID])
    if (rows[0]) { req.user = rows[0]; return }
  }
  
  
  const initData = req.headers['x-telegram-init-data']
  if (!initData) return reply.code(401).send({ error: 'Missing auth' })

  const cacheKey = `auth:${crypto.createHash('md5').update(initData).digest('hex')}`
  const cached = cacheGet(cacheKey)
  if (cached) {
    req.user = JSON.parse(cached)
    return
  }

  const parsed = parseTelegramInitData(initData)
  if (!parsed) return reply.code(401).send({ error: 'Invalid Telegram auth' })

  const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [parsed.user.id])
  const dbUser = rows[0]

  if (!dbUser) return reply.code(401).send({ error: 'User not registered' })
  if (dbUser.is_banned) return reply.code(403).send({ error: 'Account banned' })

  req.user = dbUser
  cacheSet(cacheKey, JSON.stringify(dbUser), 300)  // cache for 5 min
}

// ─── Admin JWT auth ───────────────────────────────────────────────────────────
export async function adminAuth(req, reply) {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return reply.code(401).send({ error: 'Missing token' })
    req.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'Invalid token' })
  }
}

// ─── Invalidate user cache (call after mutations) ─────────────────────────────
export async function invalidateUserCache(userId) {
  cacheDel(`user:${userId}`)
}