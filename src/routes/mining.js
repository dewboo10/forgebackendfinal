// src/routes/mining.js
import { telegramAuth } from '../middleware/auth.js'
import { db, getConfig } from '../db/index.js'
import {
  getMiningState, calcPendingEarnings, applyEarnings,
  getUserUpgrades, calcRate, getHalvingMultiplier,
  UPGRADES, upgradeCost, payReferralCommission
} from '../services/mining.js'

// Read active boost multiplier from a user row (1 if none / expired)
function getBoostMult(user) {
  if (user.boost_active && user.boost_until && new Date(user.boost_until) > new Date()) {
    return user.boost_active === '5x_turbo' ? 5 : 3
  }
  return 1
}

export default async function miningRoutes(app) {

  // GET /api/mining/state
  app.get('/api/mining/state', { preHandler: telegramAuth }, async (req, reply) => {
    try {
      const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
      // getMiningState now returns all fields with correct keys including
      // 'upgrades' (not 'upgrade_levels') and 'totalMined' alias
      const state = await getMiningState(rows[0])
      return reply.send(state)
    } catch (e) {
      console.error('Mining state error:', e)
      return reply.code(500).send({ error: 'Database error', details: e.message })
    }
  })

  // POST /api/mining/start
  app.post('/api/mining/start', { preHandler: telegramAuth }, async (req, reply) => {
    const user = req.user

    if (user.mining_start) {
      console.log(`[mining:start] user=${user.id} already mining since ${user.mining_start}`)
      return reply.send({ ok: true, already: true })
    }

    await db.query(
      `UPDATE users SET mining_start=NOW(), last_heartbeat=NOW() WHERE id=$1`,
      [user.id]
    )
    console.log(`[mining:start] user=${user.id} session started`)
    return reply.send({ ok: true, mining_start: new Date() })
  })

  // POST /api/mining/stop
  app.post('/api/mining/stop', { preHandler: telegramAuth }, async (req, reply) => {
    try {
      const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
      const user = rows[0]
      if (!user.mining_start) return reply.send({ ok: true, earned: 0 })

      const halvingMult = await getHalvingMultiplier()
      const upgrades = await getUserUpgrades(user.id)
      const rate = await calcRate(user, upgrades, halvingMult)
      const boostMult = getBoostMult(user)
      const earned = await calcPendingEarnings(user, upgrades, halvingMult, boostMult)
      console.log(`[mining:stop] user=${user.id} earned=${earned} rate=${rate} boost=${boostMult}`)

      return await db.tx(async (client) => {
        const result = await applyEarnings(client, user.id, earned, rate)
        if (user.referred_by) {
          const refPct = parseFloat(await getConfig('referral_percent') || '0.1')
          await payReferralCommission(client, earned, user.referred_by, refPct)
        }
        console.log(`[mining:stop] user=${user.id} new_balance=${result.balance}`)
        return reply.send({ ok: true, earned, ...result })
      })
    } catch (e) {
      console.error('Mining stop error:', e)
      return reply.code(500).send({ error: 'Database error', details: e.message })
    }
  })

  // POST /api/mining/heartbeat — client pings every 20s while open
  // FIX: Now returns { ok, balance, blocks_found, mining_start } so the frontend
  // can sync its local balance and reset the pending-earnings timer. Previously
  // this returned only { ok: true }, causing frontend pendingEarnings to keep
  // accumulating from the original session start even after the DB had already
  // credited those earnings and reset mining_start to NOW().
  app.post('/api/mining/heartbeat', { preHandler: telegramAuth }, async (req, reply) => {
    try {
      const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
      const user = rows[0]

      if (!user.mining_start) {
        // Session was killed (heartbeat cleanup or stop) — tell frontend to restart
        console.log(`[heartbeat] user=${user.id} no active session, signaling frontend to restart`)
        return reply.send({ ok: true, mining: false })
      }

      const halvingMult = await getHalvingMultiplier()
      const upgrades = await getUserUpgrades(user.id)
      const rate = await calcRate(user, upgrades, halvingMult)
      const boostMult = getBoostMult(user)
      const earned = await calcPendingEarnings(user, upgrades, halvingMult, boostMult)

      console.log(`[heartbeat] user=${user.id} earned=${earned} rate=${rate}`)
      if (earned > 0) {
        const refPct = parseFloat(await getConfig('referral_percent') || '0.1')
        const result = await db.tx(async (client) => {
          const r = await applyEarnings(client, user.id, earned, rate)
          if (user.referred_by) {
            await payReferralCommission(client, earned, user.referred_by, refPct)
          }
          // Restart mining from now atomically in the same transaction
          await client.query(
            'UPDATE users SET mining_start=NOW(), last_heartbeat=NOW(), last_seen=NOW() WHERE id=$1',
            [user.id]
          )
          return r
        })
        // Return the synced state so frontend can reset its pending-earnings counter
        return reply.send({
          ok: true,
          balance:      result.balance,
          total_mined:  result.total_mined,
          blocks_found: result.blocks_found,  // total, not increment
          mining_start: new Date(),            // the new cycle start
        })
      } else {
        await db.query(
          'UPDATE users SET last_heartbeat=NOW(), last_seen=NOW() WHERE id=$1',
          [req.user.id]
        )
        return reply.send({ ok: true })
      }
    } catch(e) {
      // Silent fail — heartbeat should never crash the app
      console.error('Heartbeat error:', e)
      return reply.send({ ok: true })
    }
  })

  // POST /api/mining/claim-offline — claim automine earnings after being away
  app.post('/api/mining/claim-offline', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const user = rows[0]

    const hasAutomine = user.automine_lifetime ||
      (user.automine_until && new Date(user.automine_until) > new Date())
    if (!hasAutomine) return reply.code(403).send({ error: 'No automine active' })
    if (!user.mining_start) {
      console.log(`[claim-offline] user=${user.id} no session — nothing to claim`)
      return reply.send({ ok: true, earned: 0 })
    }

    const halvingMult = await getHalvingMultiplier()
    const upgrades = await getUserUpgrades(user.id)
    const rate = await calcRate(user, upgrades, halvingMult)
    const boostMult = getBoostMult(user)
    const earned = await calcPendingEarnings(user, upgrades, halvingMult, boostMult)
    console.log(`[claim-offline] user=${user.id} earned=${earned} rate=${rate}`)

    return await db.tx(async (client) => {
      const result = await applyEarnings(client, user.id, earned, rate)
      // Restart mining from now
      await client.query(
        'UPDATE users SET mining_start=NOW(), last_heartbeat=NOW() WHERE id=$1',
        [user.id]
      )
      if (user.referred_by) {
        const refPct = parseFloat(await getConfig('referral_percent') || '0.1')
        await payReferralCommission(client, earned, user.referred_by, refPct)
      }
      console.log(`[claim-offline] user=${user.id} new_balance=${result.balance}`)
      return reply.send({ ok: true, earned, ...result })
    })
  })

  // GET /api/mining/upgrades
  app.get('/api/mining/upgrades', { preHandler: telegramAuth }, async (req, reply) => {
    const upgradeLevels = await getUserUpgrades(req.user.id)
    const halvingMult = await getHalvingMultiplier()
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const user = rows[0]
    const balance = user.balance / 10000

    const items = UPGRADES.map(u => {
      const level = upgradeLevels[u.id] || 0
      const cost = upgradeCost(u, level)
      const maxed = level >= u.maxLevel
      return {
        ...u,
        level,
        cost,
        maxed,
        canAfford: balance >= cost,
        rate_preview: parseFloat((u.rateBonus * halvingMult).toFixed(4))
      }
    })

    return reply.send({ upgrades: items, balance })
  })

  // POST /api/mining/upgrades/buy
  app.post('/api/mining/upgrades/buy', { preHandler: telegramAuth }, async (req, reply) => {
    const { upgradeId } = req.body
    const upgrade = UPGRADES.find(u => u.id === parseInt(upgradeId))
    if (!upgrade) return reply.code(400).send({ error: 'Invalid upgrade' })

    return await db.tx(async (client) => {
      // Lock user row
      const { rows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.user.id])
      const user = rows[0]

      const { rows: upRows } = await client.query(
        'SELECT level FROM user_upgrades WHERE user_id=$1 AND upgrade_id=$2',
        [user.id, upgrade.id]
      )
      const currentLevel = upRows[0]?.level || 0
      if (currentLevel >= upgrade.maxLevel) return reply.code(400).send({ error: 'Already maxed' })

      const cost = upgradeCost(upgrade, currentLevel)
      const balance = user.balance / 10000
      if (balance < cost) return reply.code(400).send({ error: 'Insufficient balance' })

      // Deduct and upgrade
      await client.query(
        'UPDATE users SET balance=balance-$2 WHERE id=$1',
        [user.id, cost * 10000]
      )
      await client.query(
        `INSERT INTO user_upgrades (user_id, upgrade_id, level) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, upgrade_id) DO UPDATE SET level=$3`,
        [user.id, upgrade.id, currentLevel + 1]
      )

      const newBalance = (user.balance - cost * 10000) / 10000
      return reply.send({ ok: true, new_level: currentLevel + 1, balance: newBalance, newBalance })
    })
  })

  // POST /api/mining/boost/activate
  // Validates cooldown server-side before allowing boost activation.
  // This prevents bypass via page reload since timestamps live in the DB.
  app.post('/api/mining/boost/activate', { preHandler: telegramAuth }, async (req, reply) => {
    const { boostType } = req.body  // 'surge' or 'turbo'

    if (!['surge', 'turbo'].includes(boostType)) {
      return reply.code(400).send({ error: 'Invalid boost type' })
    }

    const chargeCol   = boostType === 'surge' ? 'boost_charges' : 'turbo_charges'
    const boostLabel  = boostType === 'surge' ? '3x_surge'     : '5x_turbo'
    const boostSecs   = boostType === 'surge' ? 60             : 90

    return await db.tx(async (client) => {
      // Lock row to prevent double-spending a charge on concurrent taps
      const { rows } = await client.query(
        'SELECT * FROM users WHERE id=$1 FOR UPDATE',
        [req.user.id]
      )
      const user = rows[0]
      const charges = user[chargeCol] || 0

      // No cooldown — purely charge-based. Users get 1 free on signup, buy more with Stars.
      if (charges <= 0) {
        return reply.code(400).send({ error: 'No charges available', needsBuy: true })
      }

      const newCharges = charges - 1
      await client.query(
        `UPDATE users
         SET ${chargeCol}=$2,
             boost_active=$3, boost_until=NOW() + ($4 || ' seconds')::interval
         WHERE id=$1`,
        [req.user.id, newCharges, boostLabel, boostSecs]
      )

      return reply.send({ ok: true, activatedAt: Date.now(), chargesLeft: newCharges })
    })
  })
}