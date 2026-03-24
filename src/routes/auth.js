// src/routes/auth.js
import { parseTelegramInitData } from '../middleware/auth.js'
import { db, getConfig, redis } from '../db/index.js'
import crypto from 'crypto'

function genRefCode(userId) {
  return `FRG${userId.toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`
}

export default async function authRoutes(app) {

  // POST /api/auth/login
  // Called on every app open. Creates user if new, returns full profile.
  app.post('/api/auth/login', async (req, reply) => {
    const initData = req.headers['x-telegram-init-data']
    const parsed = parseTelegramInitData(initData)

    if (!parsed) return reply.code(401).send({ error: 'Invalid Telegram auth' })

    const { user: tgUser } = parsed
    const open = await getConfig('registration_open')
    const maintenance = await getConfig('maintenance_mode')
    if (maintenance === 'true') return reply.code(503).send({ error: 'Maintenance mode' })

    // Referral: start_param in initData carries ref code
    const params = new URLSearchParams(initData)
    const startParam = params.get('start_param') || ''
    const refCode = startParam.startsWith('ref_') ? startParam.slice(4) : null

    return await db.tx(async (client) => {
      // Upsert user
      const { rows } = await client.query(
        `INSERT INTO users (id, username, first_name, last_name, photo_url, language_code)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           username=EXCLUDED.username,
           first_name=EXCLUDED.first_name,
           last_name=EXCLUDED.last_name,
           last_seen=NOW()
         RETURNING *`,
        [tgUser.id, tgUser.username, tgUser.first_name, tgUser.last_name, tgUser.photo_url, tgUser.language_code]
      )
      let user = rows[0]

      // Assign ref code if new
      if (!user.ref_code) {
        const code = genRefCode(user.id)
        await client.query('UPDATE users SET ref_code=$2 WHERE id=$1', [user.id, code])
        user.ref_code = code
      }

      // Apply referral if new user and valid ref code
      if (!user.referred_by && refCode && open !== 'false') {
        const { rows: refRows } = await client.query(
          'SELECT id FROM users WHERE ref_code=$1 AND id!=$2',
          [refCode, user.id]
        )
        if (refRows.length > 0) {
          const referrerId = refRows[0].id
          await client.query('UPDATE users SET referred_by=$2 WHERE id=$1', [user.id, referrerId])
          await client.query(
            `INSERT INTO referrals (referrer_id, referee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [referrerId, user.id]
          )
          // Bonus FRG to new user
          const bonusStr = await getConfig('referral_bonus_frg')
          const bonus = parseInt(bonusStr || '5000')
          await client.query(
            'UPDATE users SET balance=balance+$2 WHERE id=$1',
            [user.id, bonus * 10000]
          )
          // Notify referrer
          await client.query(
            `INSERT INTO notifications (user_id, type, title, body)
             VALUES ($1,'referral','New recruit joined!','${tgUser.first_name} joined using your link. +10% of all their mining goes to you.')`,
            [referrerId]
          )
        }
      }

      // Invalidate redis cache
      await redis.del(`user:${user.id}`)

      return reply.send({ ok: true, user: sanitizeUser(user) })
    })
  })
}

function sanitizeUser(u) {
  return {
    id:         u.id,
    username:   u.username,
    first_name: u.first_name,
    ref_code:   u.ref_code,
    is_admin:   u.is_admin,
  }
}
