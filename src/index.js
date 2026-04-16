// src/index.js — Main server
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import 'dotenv/config'

import { scheduleJobs } from './jobs/index.js'   // ✅ removed redis import

import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

import authRoutes    from './routes/auth.js'
import miningRoutes  from './routes/mining.js'
import storeRoutes   from './routes/store.js'
import socialRoutes  from './routes/social.js'
import adminRoutes   from './routes/admin.js'
import { db } from './db/index.js'

// ─── ONE-TIME DATA FIXES ──────────────────────────────────────────────────────
// Fix referral_percent: was '0.1' (meant 10% but code divides by 100 → 0.1%).
// Correct value is '10' so that 10 / 100 = 0.1 = 10%.
await db.query(`UPDATE config SET value='10' WHERE key='referral_percent' AND value='0.1'`)

const app = Fastify({
  logger: process.env.NODE_ENV !== 'production',
  trustProxy: true,
})

// ─── CORS ─────────────────────────────────────────────────────────────────────
await app.register(cors, {
  origin: [
    process.env.FRONTEND_URL,
    'https://web.telegram.org',
    /\.telegram\.org$/,
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Init-Data'],
})

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
await app.register(rateLimit, {
  global: true,
  max: 120,           // 120 req/min per IP — enough for normal use
  timeWindow: 60000,
  // ✅ removed redis — uses in-memory store by default
  keyGenerator: (req) => req.headers['x-telegram-init-data']?.slice(0, 40) || req.ip,
  errorResponseBuilder: () => ({ error: 'Too many requests', retryAfter: 60 }),
})

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', async () => ({ ok: true, ts: Date.now() }))

// ─── ADMIN PANEL (static) ─────────────────────────────────────────────────────
await app.register(fastifyStatic, {
  root: path.join(__dirname, '../admin'),
  prefix: '/admin/',
})

// Redirect /admin → /admin/ so the browser loads index.html correctly
app.get('/admin', (req, reply) => reply.redirect('/admin/'))

// ─── ROUTES ───────────────────────────────────────────────────────────────────
await app.register(authRoutes)
await app.register(miningRoutes)
await app.register(storeRoutes)
await app.register(socialRoutes)
await app.register(adminRoutes)

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
app.setErrorHandler((err, req, reply) => {
  console.error('Unhandled error:', err)
  if (err.statusCode === 429) return reply.code(429).send({ error: 'Too many requests' })
  reply.code(500).send({ error: 'Internal server error' })
})

// ─── START ────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await app.listen({ port: parseInt(process.env.PORT || '3001'), host: '0.0.0.0' })
    console.log(`🚀 Forge backend running on port ${process.env.PORT || 3001}`)
    await scheduleJobs()

    // FIX FOR BUG #4: Keep-alive ping for Render free tier
    // Render puts free apps to sleep after 15 min of inactivity.
    // Ping ourselves every 14 min to stay awake. Without this, in-flight
    // heartbeats get killed, making the backend think users disconnected,
    // which kills their mining sessions. This prevents cold starts.
    if (process.env.NODE_ENV === 'production') {
      const keepaliveInterval = setInterval(async () => {
        try {
          const hostname = process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'
          const url = `https://${hostname}/health`
          await fetch(url)
          console.log('[keepalive] pinged')
        } catch(e) {
          console.warn('[keepalive] ping failed:', e.message)
        }
      }, 14 * 60 * 1000)  // every 14 minutes (Render sleeps after 15)
      console.log('[keepalive] Renderer keep-alive scheduled')
    }
  } catch (err) {
    console.error('Startup error:', err)
    process.exit(1)
  }
}

start()