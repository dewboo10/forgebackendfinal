// src/routes/auth.js
import { parseTelegramInitData } from '../middleware/auth.js'
import { db, getConfig, cacheDel } from '../db/index.js'
import crypto from 'crypto'

function genRefCode(userId) {
  return `FRG${userId.toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`
}

export default async function authRoutes(app) {

  // POST /api/auth/login
  app.post('/api/auth/login', async (req, reply) => {
    let tgUser
    let startParam = ''

    if (process.env.NODE_ENV !== 'production' && process.env.DEV_USER_ID) {
      const devId = Number(process.env.DEV_USER_ID)
      const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [devId])
      if (rows[0]) {
        tgUser = rows[0]
      } else {
        tgUser = {
          id: devId,
          username: 'dev_user',
          first_name: 'Dev',
          last_name: 'User',
          photo_url: null,
          language_code: 'en',
        }
      }

      const initData = req.headers['x-telegram-init-data']
      if (initData) {
        const params = new URLSearchParams(initData)
        startParam = params.get('start_param') || ''
      }
    } else {
      const initData = req.headers['x-telegram-init-data']
      const parsed = parseTelegramInitData(initData)

      if (!parsed) return reply.code(401).send({ error: 'Invalid Telegram auth' })
      tgUser = parsed.user

      const params = new URLSearchParams(initData)
      startParam = params.get('start_param') || ''
    }

    const open = await getConfig('registration_open')
    const maintenance = await getConfig('maintenance_mode')
    if (maintenance === 'true') return reply.code(503).send({ error: 'Maintenance mode' })

    // Also accept startParam from the request body — the frontend reads it from
    // initDataUnsafe.start_param which is more reliable than parsing the raw initData string
    if (!startParam && req.body?.startParam) {
      startParam = req.body.startParam
    }

    const refCode = startParam && startParam.startsWith('ref_') ? startParam.slice(4) : null

    // Log every login so we can see if start_param is being received
    console.log(`[login] user=${tgUser.id} start_param="${startParam}" refCode="${refCode || 'none'}"`)


    try {
      return await db.tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO users (id, username, first_name, last_name, photo_url, language_code)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE SET
             username=EXCLUDED.username,
             first_name=EXCLUDED.first_name,
             last_name=EXCLUDED.last_name,
             last_seen=NOW()
           RETURNING *, (xmax = 0) AS is_new_user`,
          [tgUser.id, tgUser.username, tgUser.first_name, tgUser.last_name, tgUser.photo_url, tgUser.language_code]
        )
        let user = rows[0]

        if (!user.ref_code) {
          const code = genRefCode(user.id)
          await client.query('UPDATE users SET ref_code=$2 WHERE id=$1', [user.id, code])
          user.ref_code = code
        }

        if (!user.referred_by && refCode && open !== 'false') {
          const { rows: refRows } = await client.query(
            'SELECT id FROM users WHERE ref_code=$1 AND id!=$2',
            [refCode, user.id]
          )
          if (refRows.length > 0) {
            const referrerId = refRows[0].id
            console.log(`[referral] user=${user.id} referred by ${referrerId} via code "${refCode}"`)
            await client.query('UPDATE users SET referred_by=$2 WHERE id=$1', [user.id, referrerId])
            await client.query(
              `INSERT INTO referrals (referrer_id, referee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [referrerId, user.id]
            )
            const bonusStr = await getConfig('referral_bonus_frg')
            const bonus = parseInt(bonusStr || '5000')
            await client.query(
              'UPDATE users SET balance=balance+$2 WHERE id=$1',
              [user.id, bonus * 10000]
            )
            await client.query(
              `INSERT INTO notifications (user_id, type, title, body)
               VALUES ($1,'referral','New recruit joined!',$2)`,
              [referrerId, `${tgUser.first_name} joined using your link. +10% of all their mining goes to you.`]
            )
          } else {
            console.log(`[referral] code "${refCode}" not found in DB — no referral recorded`)
          }
        } else if (refCode && user.referred_by) {
          console.log(`[referral] user=${user.id} already has a referrer — skipping`)
        }

        // Invalidate user cache
        cacheDel(`user:${user.id}`)

        return reply.send({ ok: true, user: sanitizeUser(user), isNewUser: rows[0].is_new_user })
      })
    } catch (e) {
      console.error(`[login] transaction failed for user=${tgUser.id}:`, e.message)
      return reply.code(500).send({ error: 'Login failed' })
    }
  })
}

function sanitizeUser(u) {
  return {
    id:                u.id,
    username:          u.username,
    first_name:        u.first_name,
    ref_code:          u.ref_code,
    is_admin:          u.is_admin,
    balance:           u.balance / 10000,
    totalMined:        u.total_mined / 10000,
    blocks_found:      u.blocks_found,
    mining_start:      u.mining_start,
    automine_until:    u.automine_until,
    automine_lifetime: u.automine_lifetime,
    speed_perm:        u.speed_perm,
    daily_streak:      u.daily_streak,
    daily_claimed_at:  u.daily_claimed_at,
    wallet_address:    u.wallet_address,
    miningStartedAt:   u.mining_start,
  }
}
