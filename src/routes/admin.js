// src/routes/admin.js — Full admin API
import { db, getConfig, setConfig, getAllConfig, getTotalUsers, cacheDel, cacheFlush } from '../db/index.js'
import crypto from 'crypto'
import TelegramBot from 'node-telegram-bot-api'

const bot = new TelegramBot(process.env.BOT_TOKEN)

function signAdminToken(secret) {
  const payload = { role: 'admin', ts: Date.now() }
  const str = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(str).digest('base64url')
  return `${str}.${sig}`
}

function verifyAdminToken(token, secret) {
  if (!token) return false
  const [str, sig] = token.split('.')
  if (!str || !sig) return false
  const expected = crypto.createHmac('sha256', secret).update(str).digest('base64url')
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false
  const payload = JSON.parse(Buffer.from(str, 'base64url').toString())
  return (Date.now() - payload.ts) < 86400000
}

async function adminGuard(req, reply) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!verifyAdminToken(token, process.env.ADMIN_SECRET)) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }
}

async function logAction(action, target, oldVal, newVal, ip) {
  await db.query(
    'INSERT INTO admin_logs (action, target, old_value, new_value, ip) VALUES ($1,$2,$3,$4,$5)',
    [action, target, String(oldVal ?? ''), String(newVal ?? ''), ip]
  )
}

export default async function adminRoutes(app) {

  app.post('/api/admin/login', async (req, reply) => {
    const { password } = req.body
    if (password !== process.env.ADMIN_PASSWORD)
      return reply.code(401).send({ error: 'Wrong password' })
    const token = signAdminToken(process.env.ADMIN_SECRET)
    return reply.send({ token })
  })

  const A = { preHandler: adminGuard }

  // ─── DASHBOARD STATS ──────────────────────────────────────────────────────

  app.get('/api/admin/stats', A, async (req, reply) => {
    const [
      { rows: totals },
      { rows: today },
      { rows: mining },
      { rows: revenue },
      { rows: topUsers },
    ] = await Promise.all([
      db.query(`SELECT COUNT(*) total, SUM(total_mined)/10000.0 total_mined, SUM(balance)/10000.0 total_balance FROM users WHERE is_banned=FALSE`),
      db.query(`SELECT COUNT(*) new_users FROM users WHERE created_at > NOW()-INTERVAL '1 day'`),
      db.query(`SELECT COUNT(*) active FROM users WHERE mining_start IS NOT NULL`),
      db.query(`SELECT SUM(price_ton) ton, COUNT(*) purchases FROM purchases WHERE verified_at IS NOT NULL AND created_at > NOW()-INTERVAL '30 days'`),
      db.query(`SELECT id, username, first_name, total_mined/10000.0 mined, balance/10000.0 bal FROM users ORDER BY total_mined DESC LIMIT 5`),
    ])
    return reply.send({
      total_users:    parseInt(totals[0].total),
      total_mined:    parseFloat(totals[0].total_mined || 0),
      total_balance:  parseFloat(totals[0].total_balance || 0),
      new_today:      parseInt(today[0].new_users),
      active_mining:  parseInt(mining[0].active),
      revenue_30d_ton: parseFloat(revenue[0].ton || 0),
      purchases_30d:  parseInt(revenue[0].purchases),
      top_users:      topUsers,
    })
  })

  app.get('/api/admin/growth', A, async (req, reply) => {
    const { rows } = await db.query(`
      SELECT DATE(created_at) day, COUNT(*) users
      FROM users GROUP BY day ORDER BY day DESC LIMIT 30
    `)
    return reply.send({ growth: rows.reverse() })
  })

  // ─── USERS ────────────────────────────────────────────────────────────────

  app.get('/api/admin/users', A, async (req, reply) => {
    const page = parseInt(req.query.page || '1')
    const limit = parseInt(req.query.limit || '50')
    const search = req.query.search || ''
    const offset = (page - 1) * limit

    const where = search ? `WHERE (username ILIKE $3 OR first_name ILIKE $3 OR id::text=$4)` : ''
    const params = search ? [limit, offset, `%${search}%`, search] : [limit, offset]

    const { rows } = await db.query(
      `SELECT id, username, first_name, balance/10000.0 balance, total_mined/10000.0 total_mined,
              blocks_found, is_banned, automine_lifetime, automine_until, speed_perm,
              mining_start, last_seen, created_at, ref_code, daily_streak
       FROM users ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params
    )
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM users ${where}`,
      search ? [`%${search}%`, search] : []
    )
    return reply.send({ users: rows, total: parseInt(countRows[0].count), page, limit })
  })

  app.get('/api/admin/users/:id', A, async (req, reply) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'User not found' })
    const u = rows[0]
    const { rows: upgrades } = await db.query('SELECT * FROM user_upgrades WHERE user_id=$1', [u.id])
    const { rows: purchases } = await db.query('SELECT * FROM purchases WHERE user_id=$1 ORDER BY created_at DESC', [u.id])
    const { rows: refs } = await db.query('SELECT COUNT(*) FROM referrals WHERE referrer_id=$1', [u.id])
    return reply.send({ user: u, upgrades, purchases, ref_count: parseInt(refs[0].count) })
  })

  app.patch('/api/admin/users/:id/balance', A, async (req, reply) => {
    const { amount, reason } = req.body
    const { rows } = await db.query('SELECT balance FROM users WHERE id=$1', [req.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })
    const old = rows[0].balance / 10000
    await db.query('UPDATE users SET balance=GREATEST(0,balance+$2) WHERE id=$1', [req.params.id, Math.floor(amount * 10000)])
    await logAction('adjust_balance', `user:${req.params.id}`, old, old + amount, req.ip)
    if (reason) await db.query(
      `INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'system','Balance Adjusted',$2)`,
      [req.params.id, reason]
    )
    return reply.send({ ok: true })
  })

  app.patch('/api/admin/users/:id/ban', A, async (req, reply) => {
    const { banned, reason } = req.body
    await db.query('UPDATE users SET is_banned=$2, mining_start=NULL WHERE id=$1', [req.params.id, banned])
    await logAction(banned ? 'ban' : 'unban', `user:${req.params.id}`, !banned, banned, req.ip)
    return reply.send({ ok: true })
  })

  app.patch('/api/admin/users/:id/automine', A, async (req, reply) => {
    const { days, lifetime } = req.body
    if (lifetime) {
      await db.query('UPDATE users SET automine_lifetime=TRUE WHERE id=$1', [req.params.id])
    } else {
      await db.query(
        `UPDATE users SET automine_until=GREATEST(COALESCE(automine_until,NOW()),NOW())+INTERVAL '${parseInt(days)} days' WHERE id=$1`,
        [req.params.id]
      )
    }
    await logAction('grant_automine', `user:${req.params.id}`, null, lifetime ? 'lifetime' : `${days}d`, req.ip)
    return reply.send({ ok: true })
  })

  app.patch('/api/admin/users/:id/speed-perm', A, async (req, reply) => {
    await db.query('UPDATE users SET speed_perm=$2 WHERE id=$1', [req.params.id, req.body.enabled])
    return reply.send({ ok: true })
  })

  app.delete('/api/admin/users/:id/upgrades', A, async (req, reply) => {
    await db.query('DELETE FROM user_upgrades WHERE user_id=$1', [req.params.id])
    await logAction('reset_upgrades', `user:${req.params.id}`, null, null, req.ip)
    return reply.send({ ok: true })
  })

  // ─── CONFIG ───────────────────────────────────────────────────────────────

  app.get('/api/admin/config', A, async (req, reply) => {
    const config = await getAllConfig()
    return reply.send({ config })
  })

  app.patch('/api/admin/config', A, async (req, reply) => {
    const { key, value } = req.body
    const old = await getConfig(key)
    await setConfig(key, value)
    await logAction('config_update', `config:${key}`, old, value, req.ip)
    return reply.send({ ok: true })
  })

  app.patch('/api/admin/config/bulk', A, async (req, reply) => {
    const { changes } = req.body
    for (const [key, value] of Object.entries(changes)) {
      const old = await getConfig(key)
      await setConfig(key, value)
      await logAction('config_bulk', `config:${key}`, old, value, req.ip)
    }
    return reply.send({ ok: true })
  })

  // ─── HALVING ──────────────────────────────────────────────────────────────

  app.get('/api/admin/halving', A, async (req, reply) => {
    const epochsJson = await getConfig('halving_epochs')
    const epochs = JSON.parse(epochsJson)
    const totalUsers = await getTotalUsers()
    const { rows: history } = await db.query('SELECT * FROM halving_history ORDER BY triggered_at DESC')
    return reply.send({ epochs, total_users: totalUsers, history })
  })

  app.patch('/api/admin/halving', A, async (req, reply) => {
    const { epochs } = req.body
    const old = await getConfig('halving_epochs')
    await setConfig('halving_epochs', JSON.stringify(epochs))
    await logAction('halving_update', 'halving_epochs', old, JSON.stringify(epochs), req.ip)
    return reply.send({ ok: true })
  })

  app.post('/api/admin/halving/trigger', A, async (req, reply) => {
    const totalUsers = await getTotalUsers()
    await db.query('INSERT INTO halving_history (epoch_index, users_at_time) VALUES ($1,$2)', [req.body.epoch, totalUsers])
    cacheDel('stat:total_users')
    return reply.send({ ok: true })
  })

  // ─── BROADCASTS ───────────────────────────────────────────────────────────

  app.post('/api/admin/broadcast/notification', A, async (req, reply) => {
    const { title, body, user_id } = req.body
    if (user_id) {
      await db.query(
        'INSERT INTO notifications (user_id, type, title, body) VALUES ($1,$2,$3,$4)',
        [user_id, 'system', title, body]
      )
    } else {
      await db.query(
        `INSERT INTO notifications (user_id, type, title, body)
         SELECT id, 'system', $1, $2 FROM users WHERE is_banned=FALSE`,
        [title, body]
      )
    }
    await logAction('broadcast_notification', user_id ? `user:${user_id}` : 'all', null, title, req.ip)
    return reply.send({ ok: true })
  })

  app.post('/api/admin/broadcast/telegram', A, async (req, reply) => {
    const { message, user_id } = req.body
    if (user_id) {
      await bot.sendMessage(user_id, message, { parse_mode: 'HTML' })
    } else {
      const { rows } = await db.query('SELECT id FROM users WHERE is_banned=FALSE LIMIT 1000')
      let sent = 0, failed = 0
      for (const u of rows) {
        try {
          await bot.sendMessage(u.id, message, { parse_mode: 'HTML' })
          sent++
          await new Promise(r => setTimeout(r, 50))
        } catch { failed++ }
      }
      await logAction('broadcast_telegram', 'all', null, message.slice(0, 50), req.ip)
      return reply.send({ ok: true, sent, failed })
    }
    return reply.send({ ok: true })
  })

  // ─── STORE ────────────────────────────────────────────────────────────────

  app.get('/api/admin/purchases', A, async (req, reply) => {
    const { rows } = await db.query(`
      SELECT p.*, u.username, u.first_name
      FROM purchases p JOIN users u ON p.user_id=u.id
      ORDER BY p.created_at DESC LIMIT 200
    `)
    return reply.send({ purchases: rows })
  })

  app.post('/api/admin/purchases/manual', A, async (req, reply) => {
    const { user_id, item_id } = req.body
    await db.query(
      `INSERT INTO purchases (user_id, item_id, verified_at) VALUES ($1,$2,NOW())`,
      [user_id, item_id]
    )
    await logAction('manual_purchase', `user:${user_id}`, null, item_id, req.ip)
    return reply.send({ ok: true })
  })

  // ─── AUDIT LOG ────────────────────────────────────────────────────────────

  app.get('/api/admin/logs', A, async (req, reply) => {
    const { rows } = await db.query(
      'SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 200'
    )
    return reply.send({ logs: rows })
  })

  // ─── MAINTENANCE ──────────────────────────────────────────────────────────

  app.patch('/api/admin/maintenance', A, async (req, reply) => {
    await setConfig('maintenance_mode', req.body.enabled ? 'true' : 'false')
    await logAction('maintenance', 'maintenance_mode', null, req.body.enabled, req.ip)
    return reply.send({ ok: true })
  })

  app.patch('/api/admin/registration', A, async (req, reply) => {
    await setConfig('registration_open', req.body.open ? 'true' : 'false')
    return reply.send({ ok: true })
  })

  // ─── CACHE FLUSH ──────────────────────────────────────────────────────────

  app.post('/api/admin/cache/flush', A, async (req, reply) => {
    cacheFlush()
    await logAction('cache_flush', 'memory', null, null, req.ip)
    return reply.send({ ok: true })
  })
}