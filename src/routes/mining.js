// src/routes/mining.js
import { telegramAuth } from '../middleware/auth.js'
import { db } from '../db/index.js'
import {
  getMiningState, calcPendingEarnings, applyEarnings,
  getUserUpgrades, calcRate, getHalvingMultiplier,
  UPGRADES, upgradeCost, payReferralCommission
} from '../services/mining.js'

export default async function miningRoutes(app) {

  // GET /api/mining/state
  app.get('/api/mining/state', { preHandler: telegramAuth }, async (req, reply) => {
    try {
      const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
      const state = await getMiningState(rows[0])
      // Include authoritative balance so frontend can sync
      state.balance = rows[0].balance / 10000
      state.totalMined = rows[0].total_mined / 10000
      return reply.send(state)
    } catch (e) {
      console.error('Mining state error:', e)
      return reply.code(500).send({ error: 'Database error', details: e.message })
    }
  })

  // POST /api/mining/start
  app.post('/api/mining/start', { preHandler: telegramAuth }, async (req, reply) => {
    const user = req.user

    if (user.mining_start) return reply.send({ ok: true, already: true })

    // Settle any previous pending (shouldn't be any, but safety)
    await db.query(
      `UPDATE users SET mining_start=NOW(), last_heartbeat=NOW() WHERE id=$1`,
      [user.id]
    )
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
      const earned = await calcPendingEarnings(user, upgrades, halvingMult)

      return await db.tx(async (client) => {
        const result = await applyEarnings(client, user.id, earned)
        // Pay referral commission
        if (user.referred_by) {
          await payReferralCommission(client, earned, user.referred_by)
        }
        return reply.send({ ok: true, earned, ...result })
      })
    } catch (e) {
      console.error('Mining stop error:', e)
      return reply.code(500).send({ error: 'Database error', details: e.message })
    }
  })

  // POST /api/mining/heartbeat — client pings every 20s while open
  app.post('/api/mining/heartbeat', { preHandler: telegramAuth }, async (req, reply) => {
    await db.query(
      'UPDATE users SET last_heartbeat=NOW(), last_seen=NOW() WHERE id=$1',
      [req.user.id]
    )
    return reply.send({ ok: true })
  })

  // POST /api/mining/claim-offline — claim automine earnings after being away
  app.post('/api/mining/claim-offline', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const user = rows[0]

    const hasAutomine = user.automine_lifetime ||
      (user.automine_until && new Date(user.automine_until) > new Date())
    if (!hasAutomine) return reply.code(403).send({ error: 'No automine active' })
    if (!user.mining_start) return reply.send({ ok: true, earned: 0 })

    const halvingMult = await getHalvingMultiplier()
    const upgrades = await getUserUpgrades(user.id)
    const earned = await calcPendingEarnings(user, upgrades, halvingMult)

    return await db.tx(async (client) => {
      const result = await applyEarnings(client, user.id, earned)
      // Restart mining from now
      await client.query(
        'UPDATE users SET mining_start=NOW(), last_heartbeat=NOW() WHERE id=$1',
        [user.id]
      )
      if (user.referred_by) await payReferralCommission(client, earned, user.referred_by)
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
}
