// src/services/mining.js
// Core mining engine — all balance math lives here, never in the client

import { db, getConfig, getTotalUsers } from '../db/index.js'

// ─── Upgrade definitions (must match frontend UPGRADES) ───────────────────────
export const UPGRADES = [
  { id: 1, name: 'Neural Boost',  baseCost: 500,    rateBonus: 0.5, maxLevel: 5 },
  { id: 2, name: 'Plasma Array',  baseCost: 2500,   rateBonus: 2.5, maxLevel: 5 },
  { id: 3, name: 'Quantum Forge', baseCost: 10000,  rateBonus: 8,   maxLevel: 4 },
  { id: 4, name: 'Dark Matter',   baseCost: 40000,  rateBonus: 25,  maxLevel: 3 },
  { id: 5, name: 'Singularity',   baseCost: 180000, rateBonus: 80,  maxLevel: 2 },
]

// ─── Halving: get current rate multiplier based on total users ────────────────
export async function getHalvingMultiplier() {
  const totalUsers = await getTotalUsers()
  const epochsJson = await getConfig('halving_epochs')
  const epochs = JSON.parse(epochsJson)

  let multiplier = epochs[0].rate
  for (let i = epochs.length - 1; i >= 0; i--) {
    if (totalUsers >= epochs[i].users) {
      multiplier = epochs[i].rate
      break
    }
  }
  return multiplier
}

// ─── Get user's upgrade levels ────────────────────────────────────────────────
export async function getUserUpgrades(userId) {
  const { rows } = await db.query(
    'SELECT upgrade_id, level FROM user_upgrades WHERE user_id=$1',
    [userId]
  )
  const map = {}
  for (const r of rows) map[r.upgrade_id] = r.level
  return map
}

// ─── Calculate effective mining rate for a user ───────────────────────────────
export async function calcRate(user, upgradeLevels, halvingMult) {
  const baseRate = parseFloat(await getConfig('base_rate') || '0.1')

  // Sum upgrade bonuses
  const upgradeBonus = UPGRADES.reduce((acc, u) => {
    return acc + u.rateBonus * (upgradeLevels[u.id] || 0)
  }, 0)

  // Permanent 2× multiplier
  const permMult = user.speed_perm ? 2 : 1

  // Apply halving to base + upgrades together
  const rate = (baseRate + upgradeBonus) * permMult * halvingMult

  return parseFloat(rate.toFixed(6))
}

// ─── Calculate pending earnings since mining_start ────────────────────────────
// This is the ONLY place earnings are computed. Never trust the client.
export async function calcPendingEarnings(user, upgradeLevels, halvingMult, boostMult = 1) {
  if (!user.mining_start) return 0

  const heartbeatTimeout = parseInt(await getConfig('heartbeat_timeout_sec') || '30')
  const hasAutomine = user.automine_lifetime ||
    (user.automine_until && new Date(user.automine_until) > new Date())

  let effectiveEnd
  if (hasAutomine) {
    // Automine: credit up to now regardless of heartbeat
    effectiveEnd = new Date()
  } else {
    // No automine: credit only while they were online
    // last_heartbeat + grace period = cutoff
    const lastHB = user.last_heartbeat ? new Date(user.last_heartbeat) : new Date(user.mining_start)
    effectiveEnd = new Date(lastHB.getTime() + heartbeatTimeout * 1000)
    if (effectiveEnd > new Date()) effectiveEnd = new Date()
  }

  const start = new Date(user.mining_start)
  const seconds = Math.max(0, (effectiveEnd - start) / 1000)

  // Cap automine offline earnings (default 8h)
  const offlineCap = parseInt(await getConfig('automine_offline_cap') || '28800')
  const cappedSeconds = hasAutomine ? Math.min(seconds, offlineCap) : seconds

  const rate = await calcRate(user, upgradeLevels, halvingMult)
  const earned = cappedSeconds * rate * boostMult

  return parseFloat(earned.toFixed(4))
}

// ─── Apply earnings to DB — returns new balance ───────────────────────────────
export async function applyEarnings(client, userId, earnedFrg, rate = 0.1) {
  const earnedInt = Math.floor(earnedFrg * 10000)
  const { rows } = await client.query(
    `UPDATE users
     SET balance       = balance + $2,
         total_mined   = total_mined + $2,
         mining_start  = NULL,
         last_heartbeat = NULL
     WHERE id = $1
     RETURNING balance, total_mined`,
    [userId, earnedInt]
  )
  // Block chance based on seconds mined
  const secondsMined = earnedFrg > 0 ? earnedFrg / Math.max(rate, 0.1) : 0
  const blockChance = Math.min(secondsMined / 625, 0.95)
  const blocksEarned = Math.random() < blockChance ? 1 : 0

  if (blocksEarned > 0) {
    await client.query(
      'UPDATE users SET blocks_found=blocks_found+$2 WHERE id=$1',
      [userId, blocksEarned]
    )
  }

  return {
    balance:      rows[0].balance / 10000,
    total_mined:  rows[0].total_mined / 10000,
    blocks_found: blocksEarned,
  }
}

// ─── Upgrade cost at a given level ────────────────────────────────────────────
export function upgradeCost(upgrade, currentLevel) {
  return Math.floor(upgrade.baseCost * Math.pow(2.2, currentLevel))
}

// ─── Pay referral commission ──────────────────────────────────────────────────
export async function payReferralCommission(client, earnedFrg, referrerId, pct) {
  if (!referrerId || earnedFrg <= 0) return
  const commission = Math.floor(earnedFrg * pct * 10000)
  if (commission <= 0) return
  await client.query(
    'UPDATE users SET balance=balance+$2 WHERE id=$1',
    [referrerId, commission]
  )
}

// ─── Full mining state snapshot for a user ────────────────────────────────────
export async function getMiningState(user) {
  const halvingMult = await getHalvingMultiplier()
  const upgradeLevels = await getUserUpgrades(user.id)
  const rate = await calcRate(user, upgradeLevels, halvingMult)
  const pending = await calcPendingEarnings(user, upgradeLevels, halvingMult)
  const hasAutomine = user.automine_lifetime ||
    (user.automine_until && new Date(user.automine_until) > new Date())

  return {
    balance:         user.balance / 10000,
    total_mined:     user.total_mined / 10000,
    blocks_found:    user.blocks_found,
    rate,
    pending,
    mining:          !!user.mining_start,
    mining_start:    user.mining_start,
    has_automine:    hasAutomine,
    automine_until:  user.automine_until,
    automine_lifetime: user.automine_lifetime,
    speed_perm:      user.speed_perm,
    upgrade_levels:  upgradeLevels,
    halving_mult:    halvingMult,
    boost: user.boost_active && user.boost_until && new Date(user.boost_until) > new Date()
      ? { type: user.boost_active, until: user.boost_until }
      : null,
    boost_charges:   user.boost_charges,
    turbo_charges:   user.turbo_charges,
  }
}
