// src/routes/social.js — referrals, circle, profile, leaderboard, daily, wallet, notifications
import { telegramAuth } from '../middleware/auth.js'
import { db, getConfig, getTotalUsers, cacheGet, cacheSet } from '../db/index.js'
// FIX: Import calcRate + getUserUpgrades so mission m4 (rate) checks
// the effective rate (base + upgrades + halving) rather than u.base_rate
// which is always 0.1 and never changes, making rate-based milestones
// impossible to reach for most users.
import { calcRate, getUserUpgrades, getHalvingMultiplier } from '../services/mining.js'

const REF_TIERS = [
  { refs: 1,   rewardType: 'speed',     frg: 5000,    days: 1,  label: 'First Blood' },
  { refs: 3,   rewardType: 'automine',  frg: 15000,   days: 3,  label: 'Spark Node' },
  { refs: 5,   rewardType: 'speed',     frg: 30000,   days: 7,  label: 'Live Wire' },
  { refs: 10,  rewardType: 'automine',  frg: 75000,   days: 30, label: 'Mining Node' },
  { refs: 25,  rewardType: 'permanent', frg: 200000,  days: null,label: 'Cluster Core' },
  { refs: 50,  rewardType: 'automine',  frg: 500000,  days: 60, label: 'Sovereign Node' },
  { refs: 100, rewardType: 'automine',  frg: 1000000, days: 60, label: 'Network Architect' },
  { refs: 200, rewardType: 'lifetime',  frg: 5000000, days: null,label: 'Genesis Architect' },
]

const MISSIONS = [
  { id: 'm1', key: 'total_mined', checkpoints: [1000,5000,20000,100000,500000,100000000,1000000000,10000000000,100000000000], rewards: [500,1500,5000,20000,80000,500000,2000000,10000000,50000000] },
  { id: 'm2', key: 'blocks_found',checkpoints: [1,5,20,50],                    rewards: [500,2500,8000,20000] },
  { id: 'm3', key: 'ref_count',   checkpoints: [1,5,10,25],                    rewards: [5000,30000,100000,500000] },
  { id: 'm4', key: 'rate',        checkpoints: [1,5,20,50],                    rewards: [500,3000,12000,30000] },
]

const DAILY_REWARDS = [500,1000,2000,3500,5000,8000,12000]

export default async function socialRoutes(app) {

  // ─── STATS ──────────────────────────────────────────────────────────────────

  app.get('/api/stats', { preHandler: telegramAuth }, async (req, reply) => {
    const total = await getTotalUsers()
    return reply.send({ total_users: total })
  })

  // ─── REFERRALS ──────────────────────────────────────────────────────────────

  app.get('/api/referrals/info', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows } = await db.query(
      `SELECT r.*, u.username, u.first_name, u.total_mined
       FROM referrals r JOIN users u ON r.referee_id=u.id
       WHERE r.referrer_id=$1 ORDER BY r.created_at DESC`,
      [req.user.id]
    )
    const refPct = await getConfig('referral_percent')
    // Config stores the rate as a decimal fraction (0.1 = 10%) — do NOT divide by 100 again
    const pct = parseFloat(refPct)
    const referralEarnings = rows.reduce((sum, r) => sum + (r.total_mined / 10000) * pct, 0)
    return reply.send({
      ref_code:          req.user.ref_code,
      ref_count:         rows.length,
      ref_pct:           parseFloat(refPct),
      referral_earnings: Math.floor(referralEarnings),
      bot_username:      process.env.BOT_USERNAME,
    })
  })

  app.get('/api/referrals/list', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.first_name, u.total_mined, r.created_at
       FROM referrals r JOIN users u ON r.referee_id=u.id
       WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT 100`,
      [req.user.id]
    )
    return reply.send({ refs: rows.map(r => ({
      id: r.id, name: r.first_name || r.username,
      total_mined: r.total_mined / 10000, joined_at: r.created_at
    }))})
  })

  app.get('/api/referrals/tiers', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows: refRows } = await db.query(
      'SELECT COUNT(*) FROM referrals WHERE referrer_id=$1', [req.user.id]
    )
    const { rows: claimedRows } = await db.query(
      'SELECT tier_refs FROM ref_tier_claims WHERE user_id=$1', [req.user.id]
    )
    const claimed = new Set(claimedRows.map(r => r.tier_refs))
    const refCount = parseInt(refRows[0].count)
    return reply.send({ ref_count: refCount, tiers: REF_TIERS.map(t => ({
      ...t, claimed: claimed.has(t.refs), unlocked: refCount >= t.refs
    }))})
  })

  app.post('/api/referrals/claim', { preHandler: telegramAuth }, async (req, reply) => {
    const { refs } = req.body
    const tier = REF_TIERS.find(t => t.refs === refs)
    if (!tier) return reply.code(400).send({ error: 'Invalid tier' })

    const { rows: refRows } = await db.query(
      'SELECT COUNT(*) FROM referrals WHERE referrer_id=$1', [req.user.id]
    )
    if (parseInt(refRows[0].count) < tier.refs)
      return reply.code(400).send({ error: 'Not enough referrals' })

    return await db.tx(async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO ref_tier_claims (user_id, tier_refs) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.user.id, refs]
      )
      if (rowCount === 0) return reply.code(400).send({ error: 'Already claimed' })
      await client.query(
        'UPDATE users SET balance=balance+$2 WHERE id=$1',
        [req.user.id, tier.frg * 10000]
      )
      if (tier.rewardType === 'automine' && tier.days) {
        await client.query(
          `UPDATE users SET automine_until=
             GREATEST(COALESCE(automine_until,NOW()),NOW()) + INTERVAL '${tier.days} days'
           WHERE id=$1`, [req.user.id]
        )
      } else if (tier.rewardType === 'speed' && tier.days) {
        // Speed boost: activate a temporary multiplier using the boost system
        await client.query(
          `UPDATE users SET boost_active='3x_surge',
             boost_until=NOW() + INTERVAL '${tier.days} days'
           WHERE id=$1`, [req.user.id]
        )
      } else if (tier.rewardType === 'lifetime') {
        await client.query('UPDATE users SET automine_lifetime=TRUE WHERE id=$1', [req.user.id])
      } else if (tier.rewardType === 'permanent') {
        await client.query('UPDATE users SET speed_perm=TRUE WHERE id=$1', [req.user.id])
      }
      return reply.send({ ok: true, frg: tier.frg, reward: tier.rewardType })
    })
  })

  // ─── SECURITY CIRCLE ────────────────────────────────────────────────────────

  app.get('/api/circle', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows: members } = await db.query(
      `SELECT cm.*, u.username, u.first_name FROM circle_members cm
       JOIN users u ON cm.member_id=u.id WHERE cm.owner_id=$1`,
      [req.user.id]
    )
    const { rows: incoming } = await db.query(
      `SELECT ci.*, u.username, u.first_name FROM circle_invites ci
       JOIN users u ON ci.from_id=u.id
       WHERE ci.to_id=$1 AND ci.status='pending'`,
      [req.user.id]
    )
    return reply.send({ members, incoming_requests: incoming })
  })

  app.post('/api/circle/invite', { preHandler: telegramAuth }, async (req, reply) => {
    const { telegramId } = req.body
    if (!telegramId) return reply.code(400).send({ error: 'telegramId required' })

    const maxSize = parseInt(await getConfig('max_circle_size') || '5')
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) FROM circle_members WHERE owner_id=$1', [req.user.id]
    )
    if (parseInt(countRows[0].count) >= maxSize)
      return reply.code(400).send({ error: 'Circle full' })

    // Accept either a numeric Telegram ID or a @username / plain username
    const input = String(telegramId).replace(/^@/, '').trim()
    const isNumeric = /^\d+$/.test(input)
    const { rows: targetRows } = await db.query(
      isNumeric
        ? 'SELECT id, first_name, username FROM users WHERE id=$1'
        : 'SELECT id, first_name, username FROM users WHERE LOWER(username)=LOWER($1)',
      [isNumeric ? parseInt(input) : input]
    )
    if (!targetRows.length) return reply.code(404).send({ error: 'User not found' })
    const target = targetRows[0]

    if (target.id === req.user.id)
      return reply.code(400).send({ error: 'Cannot invite yourself' })

    const { rowCount } = await db.query(
      `INSERT INTO circle_invites (from_id, to_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.user.id, target.id]
    )
    if (rowCount === 0) return reply.code(400).send({ error: 'Invite already sent' })

    await db.query(
      `INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'system','Circle Invite',$2)`,
      [target.id, `${req.user.first_name || 'Someone'} invited you to their Security Circle.`]
    )
    return reply.send({ ok: true, invitedName: target.first_name || target.username })
  })

  app.post('/api/circle/accept', { preHandler: telegramAuth }, async (req, reply) => {
    const { requestId } = req.body
    const { rows } = await db.query(
      `UPDATE circle_invites SET status='accepted' WHERE id=$1 AND to_id=$2 AND status='pending' RETURNING *`,
      [requestId, req.user.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Request not found' })
    const invite = rows[0]
    // trusted=TRUE: the person accepted, meaning they verified the relationship
    await db.query(
      `INSERT INTO circle_members (owner_id, member_id, trusted) VALUES ($1,$2,TRUE)
       ON CONFLICT (owner_id, member_id) DO UPDATE SET trusted=TRUE`,
      [invite.from_id, invite.to_id]
    )
    // Notify the inviter that their request was accepted
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'system','Circle Request Accepted',$2)`,
      [invite.from_id, `${req.user.first_name || 'Someone'} accepted your Security Circle invite.`]
    )
    return reply.send({ ok: true })
  })

  app.post('/api/circle/decline', { preHandler: telegramAuth }, async (req, reply) => {
    await db.query(
      `UPDATE circle_invites SET status='declined' WHERE id=$1 AND to_id=$2`,
      [req.body.requestId, req.user.id]
    )
    return reply.send({ ok: true })
  })

  app.delete('/api/circle/:memberId', { preHandler: telegramAuth }, async (req, reply) => {
    await db.query(
      'DELETE FROM circle_members WHERE owner_id=$1 AND member_id=$2',
      [req.user.id, req.params.memberId]
    )
    return reply.send({ ok: true })
  })

  // ─── PROFILE & LEADERBOARD ──────────────────────────────────────────────────

  app.get('/api/profile', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const u = rows[0]
    const { rows: rank } = await db.query(
      'SELECT COUNT(*)+1 AS rank FROM users WHERE total_mined>$1 AND is_banned=false',
      [u.total_mined]
    )
    const { rows: refCount } = await db.query(
      'SELECT COUNT(*) FROM referrals WHERE referrer_id=$1', [u.id]
    )
    return reply.send({
      id: u.id, username: u.username, first_name: u.first_name,
      balance: u.balance / 10000,
      total_mined: u.total_mined / 10000,
      blocks_found: u.blocks_found,
      rank: parseInt(rank[0].rank),
      ref_count: parseInt(refCount[0].count),
      ref_code: u.ref_code,
      automine_lifetime: u.automine_lifetime,
      automine_until: u.automine_until,
      speed_perm: u.speed_perm,
      daily_streak: u.daily_streak,
      joined_at: u.created_at,
    })
  })

  app.get('/api/leaderboard', { preHandler: telegramAuth }, async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 100)
    const cacheKey = `leaderboard:${limit}`
    const cached = cacheGet(cacheKey)

    const { rows: rankRows } = await db.query(
      'SELECT COUNT(*)+1 AS rank FROM users WHERE total_mined>(SELECT total_mined FROM users WHERE id=$1) AND is_banned=false',
      [req.user.id]
    )
    const yourRank = parseInt(rankRows[0].rank)

    if (cached) {
      return reply.send({ ...JSON.parse(cached), yourRank })
    }

    const { rows } = await db.query(
      `SELECT id, username, first_name, total_mined, blocks_found
       FROM users WHERE is_banned=false ORDER BY total_mined DESC LIMIT $1`,
      [limit]
    )
    const result = { leaderboard: rows.map((u, i) => ({
      rank: i + 1, id: u.id,
      name: u.first_name || u.username || 'Miner',
      totalMined: u.total_mined / 10000,
      blocks_found: u.blocks_found,
      isYou: u.id === req.user.id,
    }))}
    cacheSet(cacheKey, JSON.stringify(result), 60)
    return reply.send({ ...result, yourRank })
  })

  // ─── DAILY REWARD ───────────────────────────────────────────────────────────

  app.get('/api/daily-reward', { preHandler: telegramAuth }, async (req, reply) => {
    const u = req.user
    const lastClaim = u.daily_claimed_at ? new Date(u.daily_claimed_at) : null
    const now = new Date()
    const msInDay = 86400000
    const claimedToday = lastClaim && (now - lastClaim) < msInDay
    const missedDay = lastClaim && (now - lastClaim) > msInDay * 2
    const streak = missedDay ? 0 : (u.daily_streak || 0)
    const nextReward = DAILY_REWARDS[Math.min(streak, DAILY_REWARDS.length - 1)]
    return reply.send({ claimedToday, streak, next_reward: nextReward, rewards: DAILY_REWARDS })
  })

  app.post('/api/daily-reward/claim', { preHandler: telegramAuth }, async (req, reply) => {
    return await db.tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.user.id])
      const u = rows[0]
      const now = new Date()
      const lastClaim = u.daily_claimed_at ? new Date(u.daily_claimed_at) : null
      if (lastClaim && (now - lastClaim) < 86400000)
        return reply.code(400).send({ error: 'Already claimed today' })
      const missedDay = lastClaim && (now - lastClaim) > 86400000 * 2
      const newStreak = missedDay ? 1 : (u.daily_streak || 0) + 1
      const reward = DAILY_REWARDS[Math.min(newStreak - 1, DAILY_REWARDS.length - 1)]
      await client.query(
        `UPDATE users SET balance=balance+$2, daily_streak=$3, daily_claimed_at=NOW() WHERE id=$1`,
        [u.id, reward * 10000, newStreak]
      )
      return reply.send({ ok: true, reward, streak: newStreak })
    })
  })

  // ─── WALLET ─────────────────────────────────────────────────────────────────

  app.post('/api/wallet/link', { preHandler: telegramAuth }, async (req, reply) => {
    const { address } = req.body
    if (!address || !/^[A-Za-z0-9_-]{48}$/.test(address))
      return reply.code(400).send({ error: 'Invalid TON address' })
    const alreadyLinked = !!req.user.wallet_address
    await db.query('UPDATE users SET wallet_address=$2 WHERE id=$1', [req.user.id, address])
    if (!alreadyLinked) {
      await db.query(
        'UPDATE users SET balance=balance+$2 WHERE id=$1',
        [req.user.id, 10000 * 10000]
      )
    }
    return reply.send({ ok: true, bonus: alreadyLinked ? 0 : 10000 })
  })

  app.get('/api/wallet', { preHandler: telegramAuth }, async (req, reply) => {
    return reply.send({
      wallet: req.user.wallet_address,
      bonusClaimed: !!req.user.wallet_address
    })
  })

  // ─── MISSIONS ───────────────────────────────────────────────────────────────

  // FIX: Both GET and POST now calculate the effective mining rate (base + upgrades
  // + halving) for mission m4 progress. The old code used u.base_rate which is
  // always 0.1, making the rate-based checkpoints (1/s, 5/s, 20/s, 50/s) impossible
  // to unlock because no user's base_rate column ever updates.

  app.get('/api/missions', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows: userRows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const u = userRows[0]
    const { rows: refCount } = await db.query(
      'SELECT COUNT(*) FROM referrals WHERE referrer_id=$1', [u.id]
    )
    const { rows: claimed } = await db.query(
      'SELECT mission_id, checkpoint_index FROM mission_claims WHERE user_id=$1', [u.id]
    )

    // Calculate actual effective rate including upgrades
    const halvingMult = await getHalvingMultiplier()
    const upgradeLevels = await getUserUpgrades(u.id)
    const effectiveRate = await calcRate(u, upgradeLevels, halvingMult)

    const claimedSet = new Set(claimed.map(c => `${c.mission_id}:${c.checkpoint_index}`))
    const progress = {
      total_mined:  u.total_mined / 10000,
      blocks_found: u.blocks_found,
      ref_count:    parseInt(refCount[0].count),
      rate:         effectiveRate,  // FIX: was u.base_rate (always 0.1)
    }
    return reply.send({ missions: MISSIONS.map(m => ({
      ...m,
      progress: progress[m.key],
      checkpoints: m.checkpoints.map((at, i) => ({
        at, reward: m.rewards[i], index: i,
        unlocked: progress[m.key] >= at,
        claimed: claimedSet.has(`${m.id}:${i}`)
      }))
    }))})
  })

  app.post('/api/missions/claim', { preHandler: telegramAuth }, async (req, reply) => {
    const { missionId, checkpointIndex } = req.body
    const mission = MISSIONS.find(m => m.id === missionId)
    if (!mission) return reply.code(400).send({ error: 'Invalid mission' })
    const cp = mission.checkpoints[checkpointIndex]
    if (cp === undefined) return reply.code(400).send({ error: 'Invalid checkpoint' })

    return await db.tx(async (client) => {
      const { rows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.user.id])
      const u = rows[0]
      const { rows: refRows } = await client.query(
        'SELECT COUNT(*) FROM referrals WHERE referrer_id=$1', [u.id]
      )

      // Calculate actual effective rate for m4 validation
      const halvingMult = await getHalvingMultiplier()
      const upgradeLevels = await getUserUpgrades(u.id)
      const effectiveRate = await calcRate(u, upgradeLevels, halvingMult)

      const progress = {
        total_mined:  u.total_mined / 10000,
        blocks_found: u.blocks_found,
        ref_count:    parseInt(refRows[0].count),
        rate:         effectiveRate,  // FIX: was u.base_rate (always 0.1)
      }

      if (progress[mission.key] < cp)
        return reply.code(400).send({ error: 'Not reached yet' })

      const { rowCount } = await client.query(
        `INSERT INTO mission_claims (user_id, mission_id, checkpoint_index) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [u.id, missionId, checkpointIndex]
      )
      if (rowCount === 0) return reply.code(400).send({ error: 'Already claimed' })

      const reward = mission.rewards[checkpointIndex]
      const { rows: updated } = await client.query(
        'UPDATE users SET balance=balance+$2, total_mined=total_mined+$2 WHERE id=$1 RETURNING balance',
        [u.id, reward * 10000]
      )
      return reply.send({ ok: true, reward, newBalance: updated[0].balance / 10000 })
    })
  })

  // ─── NOTIFICATIONS ──────────────────────────────────────────────────────────

  app.get('/api/notifications', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows } = await db.query(
      'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    )
    return reply.send({ notifications: rows })
  })

  app.patch('/api/notifications/:id/read', { preHandler: telegramAuth }, async (req, reply) => {
    await db.query(
      'UPDATE notifications SET read=TRUE WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    return reply.send({ ok: true })
  })

  app.patch('/api/notifications/read-all', { preHandler: telegramAuth }, async (req, reply) => {
    await db.query('UPDATE notifications SET read=TRUE WHERE user_id=$1', [req.user.id])
    return reply.send({ ok: true })
  })
}