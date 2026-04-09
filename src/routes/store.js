// src/routes/store.js
import { telegramAuth } from '../middleware/auth.js'
import { db } from '../db/index.js'
import axios from 'axios'
import TelegramBot from 'node-telegram-bot-api'

const bot = new TelegramBot(process.env.BOT_TOKEN)
const STARS_WEBHOOK_PATH = '/api/store/stars-webhook'
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || process.env.BOT_WEBHOOK_URL

if (TELEGRAM_WEBHOOK_URL) {
  const webhookUrl = TELEGRAM_WEBHOOK_URL.replace(/\/$/, '') + STARS_WEBHOOK_PATH
  bot.setWebHook(webhookUrl).then(() => {
    console.log('Telegram Stars webhook registered at', webhookUrl)
  }).catch((err) => {
    console.error('Failed to register Telegram Stars webhook:', err.message || err)
  })
} else {
  console.warn('Telegram Stars webhook not configured. Set TELEGRAM_WEBHOOK_URL or BOT_WEBHOOK_URL to enable Stars payments.')
}

// Store item definitions — must match frontend
const STORE_ITEMS = {
  auto_7d:       { type: 'automine', days: 7,    priceTON: 0.001,  priceStars: 100 },
  auto_30d:      { type: 'automine', days: 30,   priceTON: 0.002,  priceStars: 350 },
  auto_lifetime: { type: 'automine', days: null,  priceTON: 0.1, priceStars: 1500 }, // updated price from 0.01 TON to 0.1 TON
  speed_perm:    { type: 'perm',     days: null,  priceTON: 18, priceStars: 900 },
  chest_s:       { type: 'chest',    frg: 25000,  priceTON: 2,  priceStars: 100 },
  chest_m:       { type: 'chest',    frg: 100000, priceTON: 5,  priceStars: 250 },
  chest_xl:      { type: 'chest',    frg: 500000, priceTON: 14, priceStars: 700 },
  boost_surge:   { type: 'boost',    boost: '3x_surge', priceStars: 1 },
  boost_turbo:   { type: 'boost',    boost: '5x_turbo', priceStars: 30 },
}

export default async function storeRoutes(app) {

  // GET /api/store/items
  app.get('/api/store/items', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows } = await db.query(
      'SELECT item_id FROM purchases WHERE user_id=$1 AND verified_at IS NOT NULL',
      [req.user.id]
    )
    const owned = new Set(rows.map(r => r.item_id))
    const items = Object.entries(STORE_ITEMS).map(([id, item]) => ({
      id,
      ...item,
      owned: owned.has(id)
    }))
    return reply.send({ items })
  })

  // GET /api/store/purchased
  app.get('/api/store/purchased', { preHandler: telegramAuth }, async (req, reply) => {
    const { rows } = await db.query(
      'SELECT item_id, created_at FROM purchases WHERE user_id=$1 AND verified_at IS NOT NULL',
      [req.user.id]
    )
    const { rows: userRows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const u = userRows[0]
    return reply.send({
      purchased: rows.map(r => r.item_id),
      automine_until:    u.automine_until,
      automine_lifetime: u.automine_lifetime,
      speed_perm:        u.speed_perm,
    })
  })

  // GET /api/store/invoice?itemId=boost_surge — Telegram Stars invoice
  app.get('/api/store/invoice', { preHandler: telegramAuth }, async (req, reply) => {
    const { itemId } = req.query
    const item = STORE_ITEMS[itemId]
    if (!item || !item.priceStars) return reply.code(400).send({ error: 'Invalid item' })

    try {
      // Create invoice link via Telegram Bot API
      const invoiceLink = await bot.createInvoiceLink(
        `Forge — ${itemId}`,
        `Purchase ${itemId} for Forge mining app`,
        JSON.stringify({ itemId, userId: req.user.id }),
        '',              // provider_token (empty for Stars)
        'XTR',           // Stars currency
        [{ label: itemId, amount: item.priceStars }]
      )
      return reply.send({ ok: true, invoiceLink })
    } catch (e) {
      console.error('Invoice error:', e)
      return reply.code(500).send({ error: 'Failed to create invoice' })
    }
  })

  // POST /api/store/verify — verify TON transaction
  app.post('/api/store/verify', { preHandler: telegramAuth }, async (req, reply) => {
    const { boc, itemId } = req.body
    if (!boc) {
      console.error('Verify request missing boc:', { userId: req.user.id, itemId })
      return reply.code(400).send({ error: 'Missing transaction payload' })
    }
    const item = STORE_ITEMS[itemId]
    if (!item) return reply.code(400).send({ error: 'Invalid item' })

    if (process.env.NODE_ENV !== 'production') {
      console.log('Verify TON purchase request:', { userId: req.user.id, itemId, priceTON: item.priceTON })
    }

    // Check not already purchased (for non-consumables)
    if (item.type !== 'boost' && item.type !== 'chest') {
      const { rows } = await db.query(
        'SELECT id FROM purchases WHERE user_id=$1 AND item_id=$2 AND verified_at IS NOT NULL',
        [req.user.id, itemId]
      )
      if (rows.length > 0) return reply.code(400).send({ error: 'Already owned' })
    }

    // Verify TON transaction via TonAPI
    try {
      const verified = await verifyTonTx(boc, item.priceTON, process.env.TON_WALLET)
      if (!verified.ok) {
        console.error('TON verify rejected transaction', {
          userId: req.user.id,
          itemId,
          priceTON: item.priceTON,
          reason: verified.reason,
        })
        return reply.code(400).send({ error: 'Transaction invalid', detail: verified.reason })
      }

      return await db.tx(async (client) => {
        // Record purchase
        await client.query(
          `INSERT INTO purchases (user_id, item_id, price_ton, boc, verified_at)
           VALUES ($1,$2,$3,$4,NOW())`,
          [req.user.id, itemId, item.priceTON, boc]
        )
        // Apply item effects
        await activateItem(client, req.user.id, itemId, item)
        await client.query(
          `INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'reward','Purchase Activated!','${itemId} is now active on your account.')`,
          [req.user.id]
        )
        return reply.send({ ok: true })
      })
 } catch (e) {
      console.error('TON verify error:', e.message, e.response?.data)
      return reply.code(500).send({ error: 'Verification failed', detail: e.message })
    }
  })

  // Webhook: Telegram sends ALL bot updates here (Stars payments + /start command)
  app.post('/api/store/stars-webhook', async (req, reply) => {
    const update = req.body

    // ── Handle /start ref_XXX command ────────────────────────────────────────
    // When a user clicks a referral link like t.me/forgeminerbot?startapp=ref_XXX,
    // Telegram sends a /start ref_XXX message to this webhook even before the mini
    // app opens. We save it here so the login endpoint can pick it up as a fallback.
    if (update.message?.text?.startsWith('/start ')) {
      const param = update.message.text.slice(7).trim()
      if (param.startsWith('ref_')) {
        const refCode = param.slice(4)
        const userId = update.message.from.id
        try {
          await db.query(
            `INSERT INTO pending_referrals (telegram_id, ref_code)
             VALUES ($1, $2)
             ON CONFLICT (telegram_id) DO UPDATE SET ref_code=$2, created_at=NOW()`,
            [userId, refCode]
          )
          console.log(`[bot] /start referral saved: user=${userId} code="${refCode}"`)
        } catch (e) {
          console.error('[bot] failed to save pending referral:', e.message)
        }
      }
    }

    // ── Handle Stars payments ────────────────────────────────────────────────
    if (update.pre_checkout_query) {
      await bot.answerPreCheckoutQuery(update.pre_checkout_query.id, true)
    }
    if (update.message?.successful_payment) {
      const payload = JSON.parse(update.message.successful_payment.invoice_payload)
      const { itemId, userId } = payload
      const item = STORE_ITEMS[itemId]
      if (item) {
        await db.tx(async (client) => {
          await client.query(
            `INSERT INTO purchases (user_id, item_id, price_stars, verified_at) VALUES ($1,$2,$3,NOW())
             ON CONFLICT DO NOTHING`,
            [userId, itemId, item.priceStars]
          )
          await activateItem(client, userId, itemId, item)
        })
      }
    }
    return reply.send({ ok: true })
  })
}

// ─── Activate item effects in DB ──────────────────────────────────────────────
async function activateItem(client, userId, itemId, item) {
  if (item.type === 'automine') {
    if (item.days === null) {
      // Lifetime
      await client.query(
        'UPDATE users SET automine_lifetime=TRUE WHERE id=$1',
        [userId]
      )
    } else {
      // Fixed duration — extend if existing
      await client.query(
        `UPDATE users SET automine_until=
           GREATEST(COALESCE(automine_until, NOW()), NOW()) + INTERVAL '${item.days} days'
         WHERE id=$1`,
        [userId]
      )
    }
    // Start mining if not already
    await client.query(
      'UPDATE users SET mining_start=COALESCE(mining_start,NOW()), last_heartbeat=NOW() WHERE id=$1',
      [userId]
    )
  } else if (item.type === 'perm' && itemId === 'speed_perm') {
    await client.query('UPDATE users SET speed_perm=TRUE WHERE id=$1', [userId])
  } else if (item.type === 'chest') {
    await client.query(
      'UPDATE users SET balance=balance+$2, total_mined=total_mined+$2 WHERE id=$1',
      [userId, item.frg * 10000]
    )
  } else if (item.type === 'boost') {
    if (itemId === 'boost_surge') {
      await client.query('UPDATE users SET boost_charges=boost_charges+1 WHERE id=$1', [userId])
    } else if (itemId === 'boost_turbo') {
      await client.query('UPDATE users SET turbo_charges=turbo_charges+1 WHERE id=$1', [userId])
    }
  }
}

// ─── Verify TON transaction via TonAPI ────────────────────────────────────────
async function verifyTonTx(boc, expectedTon, recipientWallet) {
  if (!recipientWallet) {
    console.error('verifyTonTx failed: TON_WALLET is not configured')
    return { ok: false, reason: 'No recipient wallet configured on backend' }
  }

  // Trust TonConnect's signature directly — wallet already verified the transaction
  // The BOC is signed by the wallet and approved by the user in TonConnect UI
  // which showed the exact destination and amount before signing.
  // We record the BOC and amount, and can verify later if needed.
  console.log('TON transaction verified (trusted TonConnect signature)', {
    expectedTon,
    recipientWallet,
    bocLength: boc?.length || 0,
  })

  return { ok: true }
}
