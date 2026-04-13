// src/jobs/index.js — Background workers (no Redis / BullMQ)
import { db, getConfig, getTotalUsers, cacheDel } from '../db/index.js'
import { getHalvingMultiplier, calcPendingEarnings, applyEarnings, applyEarningsAndRestart, payReferralCommission, calcRate } from '../services/mining.js'

// ─── Bulk-fetch upgrades for many users in ONE query ─────────────────────────
// Instead of calling getUserUpgrades(userId) N times (N separate DB round-trips),
// we fetch all rows for all user IDs at once and build a lookup map.
async function getBulkUpgrades(userIds) {
  if (userIds.length === 0) return {}
  const { rows } = await db.query(
    'SELECT user_id, upgrade_id, level FROM user_upgrades WHERE user_id = ANY($1)',
    [userIds]
  )
  const map = {}
  for (const r of rows) {
    if (!map[r.user_id]) map[r.user_id] = {}
    map[r.user_id][r.upgrade_id] = r.level
  }
  return map
}

// ─── Process an array of items in parallel batches ───────────────────────────
// Runs `batchSize` items concurrently, waits for each batch to finish before
// starting the next. Prevents opening thousands of DB connections at once
// while still being far faster than sequential await-in-a-loop.
async function runInParallel(items, fn, batchSize = 20) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    await Promise.all(batch.map(fn))
  }
}

// ─── Automine Worker — runs every 5 min, credits all automine users ───────────
async function runAutomine() {
  try {
    console.log('[automine] Running...')
    const interval = 300  // 5 minutes in seconds

    const { rows: users } = await db.query(`
      SELECT * FROM users
      WHERE mining_start IS NOT NULL
        AND is_banned = FALSE
        AND (automine_lifetime = TRUE OR automine_until > NOW())
    `)

    console.log(`[automine] Processing ${users.length} automine users`)
    if (users.length === 0) return

    // ── Fetch shared values ONCE, not once per user ────────────────────────
    // halvingMult and refPct are the same for every user in this run.
    // Previously these were inside the loop, causing N redundant calls.
    const halvingMult = await getHalvingMultiplier()
    const refPct = parseFloat(await getConfig('referral_percent') || '0.1')

    // ── Fetch ALL upgrades in ONE query instead of N queries ───────────────
    const allUpgrades = await getBulkUpgrades(users.map(u => u.id))

    // ── Process 20 users at a time in parallel instead of one at a time ───
    await runInParallel(users, async (user) => {
      try {
        const upgrades = allUpgrades[user.id] || {}
        const rate = await calcRate(user, upgrades, halvingMult)
        const earnedPerInterval = await calcIntervalEarnings(user, upgrades, halvingMult, interval)
        if (earnedPerInterval <= 0) return

        await db.tx(async (client) => {
          // FIX FOR BUG #1: Use applyEarningsAndRestart instead of applyEarnings to keep automine alive.
          // This resets mining_start = NOW() so the 5-min cleanup job doesn't kill the session.
          await applyEarningsAndRestart(client, user.id, earnedPerInterval, rate)
          if (user.referred_by) {
            await payReferralCommission(client, earnedPerInterval, user.referred_by, refPct)
          }
        })
      } catch (e) {
        console.error(`[automine] Error for user ${user.id}:`, e.message)
      }
    }, 20)

    console.log('[automine] Done')
  } catch (e) {
    console.error('[automine] Error:', e.message)
  }
}

// ─── Halving Checker — runs every 10 min ──────────────────────────────────────
async function runHalvingCheck() {
  try {
    const totalUsers = await getTotalUsers()
    const epochsJson = await getConfig('halving_epochs')
    const epochs = JSON.parse(epochsJson)

    let currentEpoch = 0
    for (let i = epochs.length - 1; i >= 0; i--) {
      if (totalUsers >= epochs[i].users) { currentEpoch = i; break }
    }

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
      await db.query(`
        INSERT INTO notifications (user_id, type, title, body)
        SELECT id, 'halving', '⚡ Mining Halving!',
          'The mining rate has halved at ${totalUsers.toLocaleString()} users. Your earned FRG is safe.'
        FROM users WHERE is_banned=FALSE
      `)
      cacheDel('stat:halving_mult')
    }
  } catch (e) {
    console.error('[halving] Error:', e.message)
  }
}

// ─── Heartbeat cleanup — runs every 1 min ─────────────────────────────────────
async function runHeartbeatCleanup() {
  try {
    const timeout = parseInt(await getConfig('heartbeat_timeout_sec') || '30')
    const cutoff = new Date(Date.now() - timeout * 1000 * 2)

    const { rows: stale } = await db.query(`
      SELECT * FROM users
      WHERE mining_start IS NOT NULL
        AND last_heartbeat < $1
        AND automine_lifetime = FALSE
        AND (automine_until IS NULL OR automine_until < NOW())
    `, [cutoff])

    if (stale.length > 0) {
      // ── Fetch shared values ONCE for the whole batch ───────────────────
      const halvingMult = await getHalvingMultiplier()
      const refPct = parseFloat(await getConfig('referral_percent') || '0.1')

      // ── Fetch all stale-user upgrades in ONE query ─────────────────────
      const allUpgrades = await getBulkUpgrades(stale.map(u => u.id))

      // ── Process 20 stale users in parallel instead of one at a time ───
      await runInParallel(stale, async (user) => {
        try {
          const upgrades = allUpgrades[user.id] || {}
          const rate = await calcRate(user, upgrades, halvingMult)
          const earned = await calcPendingEarnings(user, upgrades, halvingMult)
          await db.tx(async (client) => {
            await applyEarnings(client, user.id, earned, rate)
            if (user.referred_by) await payReferralCommission(client, earned, user.referred_by, refPct)
          })
        } catch (e) {
          console.error(`[cleanup] Error for user ${user.id}:`, e.message)
        }
      }, 20)

      console.log(`[cleanup] Stopped ${stale.length} stale sessions`)
    }

    // FIX FOR BUG #2: After stopping stale non-automine sessions, recover any
    // automine orphans (sessions that died but automine is still active).
    // This ensures automine never stays dead when the user is not online.
    await restartAutomineOrphans()
  } catch (e) {
    console.error('[cleanup] Error:', e.message)
  }
}

// ─── Schedule recurring jobs ───────────────────────────────────────────────────
// ─── Automine orphan recovery — restart sessions that died while automine active ───
// FIX FOR BUG #2: When automine session dies (heartbeat stale), we need to detect
// and restart it if automine is still active. Without this, when the automine job
// writes earnings, mining_start is NULL so no session exists. User has to open the
// app to get earnings flowing again. This block restarts all orphaned automine.
async function restartAutomineOrphans() {
  try {
    const { rows: orphans } = await db.query(`
      SELECT * FROM users
      WHERE mining_start IS NULL
        AND is_banned = FALSE
        AND (automine_lifetime = TRUE OR (automine_until IS NOT NULL AND automine_until > NOW()))
    `)

    for (const user of orphans) {
      try {
        await db.query(
          'UPDATE users SET mining_start=NOW(), last_heartbeat=NOW() WHERE id=$1',
          [user.id]
        )
        console.log(`[cleanup] Restarted orphaned automine for user ${user.id}`)
      } catch(e) {
        console.error(`[cleanup] Failed to restart ${user.id}:`, e.message)
      }
    }
    if (orphans.length > 0) console.log(`[cleanup] Recovered ${orphans.length} orphaned automine sessions`)
  } catch (e) {
    console.error('[cleanup] Orphan recovery error:', e.message)
  }
}

// ─── Schedule recurring jobs ────────────────────────────────────────────────────
export async function scheduleJobs() {
  // Run immediately on startup, then on interval
  runAutomine()
  runHalvingCheck()
  runHeartbeatCleanup()

  setInterval(runAutomine,         5  * 60 * 1000)  // every 5 min
  setInterval(runHalvingCheck,     10 * 60 * 1000)  // every 10 min
  setInterval(runHeartbeatCleanup, 1  * 60 * 1000)  // every 1 min

  console.log('✅ Background jobs scheduled')
}

// ─── Helper: earnings for a fixed interval ────────────────────────────────────
async function calcIntervalEarnings(user, upgradeLevels, halvingMult, seconds) {
  const { calcRate } = await import('../services/mining.js')
  const rate = await calcRate(user, upgradeLevels, halvingMult)
  const offlineCap = parseInt(await getConfig('automine_offline_cap') || '28800')

  const miningStart = new Date(user.mining_start)
  const totalMiningSeconds = (Date.now() - miningStart) / 1000
  if (totalMiningSeconds > offlineCap) return 0

  return rate * seconds
}