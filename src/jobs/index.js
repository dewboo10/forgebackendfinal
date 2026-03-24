// src/jobs/index.js — BullMQ background workers
import { Queue, Worker } from 'bullmq'
import { db, getConfig, getTotalUsers, redis, setConfig } from '../db/index.js'
import { getHalvingMultiplier, getUserUpgrades, calcPendingEarnings, applyEarnings, payReferralCommission } from '../services/mining.js'

const connection = { url: process.env.REDIS_URL }

// ─── Queues ───────────────────────────────────────────────────────────────────
export const automineQueue = new Queue('automine', { connection })
export const halvingQueue  = new Queue('halving',  { connection })

// ─── Automine Worker — runs every 5 min, credits all automine users ───────────
new Worker('automine', async () => {
  console.log('[automine] Running...')
  const interval = 300  // 5 minutes in seconds

  // Get all users with automine active and currently mining
  const { rows: users } = await db.query(`
    SELECT * FROM users
    WHERE mining_start IS NOT NULL
      AND is_banned = FALSE
      AND (automine_lifetime = TRUE OR automine_until > NOW())
  `)

  console.log(`[automine] Processing ${users.length} automine users`)

  for (const user of users) {
    try {
      const halvingMult = await getHalvingMultiplier()
      const upgrades = await getUserUpgrades(user.id)

      // Only credit the interval, not the full pending (that's for claim)
      // We do a micro-settle: apply interval earnings, restart timer
      const earnedPerInterval = await calcIntervalEarnings(user, upgrades, halvingMult, interval)
      if (earnedPerInterval <= 0) continue

      await db.tx(async (client) => {
        const earnedInt = Math.floor(earnedPerInterval * 10000)
        await client.query(
          `UPDATE users SET
             balance      = balance + $2,
             total_mined  = total_mined + $2,
             last_heartbeat = NOW()
           WHERE id = $1`,
          [user.id, earnedInt]
        )
        if (user.referred_by) {
          await payReferralCommission(client, earnedPerInterval, user.referred_by)
        }
      })
    } catch (e) {
      console.error(`[automine] Error for user ${user.id}:`, e.message)
    }
  }
  console.log('[automine] Done')
}, { connection })

// ─── Halving Checker — runs every 10 min, checks user milestones ──────────────
new Worker('halving', async () => {
  const totalUsers = await getTotalUsers()
  const epochsJson = await getConfig('halving_epochs')
  const epochs = JSON.parse(epochsJson)

  // Find current epoch index
  let currentEpoch = 0
  for (let i = epochs.length - 1; i >= 0; i--) {
    if (totalUsers >= epochs[i].users) { currentEpoch = i; break }
  }

  // Check if a new halving just happened (not recorded yet)
  const { rows: lastHalving } = await db.query(
    'SELECT epoch_index FROM halving_history ORDER BY triggered_at DESC LIMIT 1'
  )
  const lastEpoch = lastHalving[0]?.epoch_index ?? -1

  if (currentEpoch > lastEpoch) {
    console.log(`[halving] NEW HALVING! Epoch ${lastEpoch} → ${currentEpoch}, users: ${totalUsers}`)
    await db.query(
      'INSERT INTO halving_history (epoch_index, users_at_time) VALUES ($1,$2)',
      [currentEpoch, totalUsers]
    )
    // Notify all active users
    await db.query(`
      INSERT INTO notifications (user_id, type, title, body)
      SELECT id, 'halving', '⚡ Mining Halving!',
        'The mining rate has halved at ${totalUsers.toLocaleString()} users. Your earned FRG is safe.'
      FROM users WHERE is_banned=FALSE
    `)
    // Bust rate cache
    await redis.del('stat:halving_mult')
  }
}, { connection })

// ─── Stop stale sessions — non-automine users who closed app ─────────────────
new Worker('heartbeat-cleanup', async () => {
  const timeout = parseInt(await getConfig('heartbeat_timeout_sec') || '30')
  const cutoff = new Date(Date.now() - timeout * 1000 * 2)  // 2× grace

  // Find non-automine users whose heartbeat is stale
  const { rows: stale } = await db.query(`
    SELECT * FROM users
    WHERE mining_start IS NOT NULL
      AND last_heartbeat < $1
      AND automine_lifetime = FALSE
      AND (automine_until IS NULL OR automine_until < NOW())
  `, [cutoff])

  for (const user of stale) {
    try {
      const halvingMult = await getHalvingMultiplier()
      const upgrades = await getUserUpgrades(user.id)
      const earned = await calcPendingEarnings(user, upgrades, halvingMult)
      await db.tx(async (client) => {
        await applyEarnings(client, user.id, earned)
        if (user.referred_by) await payReferralCommission(client, earned, user.referred_by)
      })
    } catch (e) {
      console.error(`[cleanup] Error for user ${user.id}:`, e.message)
    }
  }
  if (stale.length > 0) console.log(`[cleanup] Stopped ${stale.length} stale sessions`)
}, { connection })

// ─── Schedule recurring jobs ───────────────────────────────────────────────────
export async function scheduleJobs() {
  await automineQueue.upsertJobScheduler('automine-tick', { every: 5 * 60 * 1000 }, { name: 'tick' })
  await halvingQueue.upsertJobScheduler('halving-check',  { every: 10 * 60 * 1000 }, { name: 'check' })

  const cleanupQueue = new Queue('heartbeat-cleanup', { connection })
  await cleanupQueue.upsertJobScheduler('cleanup-tick', { every: 60 * 1000 }, { name: 'tick' })

  console.log('✅ Background jobs scheduled')
}

// ─── Helper: earnings for a fixed interval ────────────────────────────────────
async function calcIntervalEarnings(user, upgradeLevels, halvingMult, seconds) {
  const { calcRate } = await import('../services/mining.js')
  const rate = await calcRate(user, upgradeLevels, halvingMult)
  const offlineCap = parseInt(await getConfig('automine_offline_cap') || '28800')

  // Check how long they've been mining to respect the cap
  const miningStart = new Date(user.mining_start)
  const totalMiningSeconds = (Date.now() - miningStart) / 1000
  if (totalMiningSeconds > offlineCap) return 0

  return rate * seconds
}
