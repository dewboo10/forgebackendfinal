// src/routes/store.js
import { telegramAuth } from '../middleware/auth.js'
import { db } from '../db/index.js'
import axios from 'axios'
import TelegramBot from 'node-telegram-bot-api'

const bot = new TelegramBot(process.env.BOT_TOKEN)

// Store item definitions — must match frontend
const STORE_ITEMS = {
  auto_7d:       { type: 'automine', days: 7,    priceTON: 2,  priceStars: 100 },
  auto_30d:      { type: 'automine', days: 30,   priceTON: 7,  priceStars: 350 },
  auto_lifetime: { type: 'automine', days: null,  priceTON: 30, priceStars: 1500 },
  speed_perm:    { type: 'perm',     days: null,  priceTON: 18, priceStars: 900 },
  chest_s:       { type: 'chest',    frg: 25000,  priceTON: 2,  priceStars: 100 },
  chest_m:       { type: 'chest',    frg: 100000, priceTON: 5,  priceStars: 250 },
  chest_xl:      { type: 'chest',    frg: 500000, priceTON: 14, priceStars: 700 },
  boost_surge:   { type: 'boost',    boost: '3x_surge', priceStars: 20 },
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
    const item = STORE_ITEMS[itemId]
    if (!item) return reply.code(400).send({ error: 'Invalid item' })

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
      if (!verified.ok) return reply.code(400).send({ error: 'Transaction invalid', detail: verified.reason })

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
      console.error('TON verify error:', e)
      return reply.code(500).send({ error: 'Verification failed' })
    }
  })

  // Webhook: Telegram pays us for Stars purchases
  app.post('/api/store/stars-webhook', async (req, reply) => {
    // Telegram sends pre_checkout_query and successful_payment updates here
    const update = req.body
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
  try {
    const net = process.env.TON_NETWORK === 'testnet' ? 'testnet.' : ''
    const res = await axios.post(
      `https://${net}tonapi.io/v2/blockchain/message`,
      { boc },
      { headers: { Authorization: `Bearer ${process.env.TON_API_KEY}` }, timeout: 10000 }
    )
    const tx = res.data
    // Check destination wallet and amount
    // const destMatch = tx.in_msg?.destination?.address === recipientWallet

    const normalize = addr => {
  if (!addr) return ''
  return addr.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

const destMatch = normalize(tx.in_msg?.destination?.address) === normalize(recipientWallet)

    const tonAmount = tx.in_msg?.value / 1e9
    const amountOk = tonAmount >= expectedTon * 0.99  // 1% tolerance
    if (!destMatch) return { ok: false, reason: 'Wrong destination' }
    if (!amountOk)  return { ok: false, reason: `Amount too low: ${tonAmount} < ${expectedTon}` }
    return { ok: true }
  } catch (e) {
    console.error('TonAPI error:', e.response?.data || e.message)
    return { ok: false, reason: 'API error' }
  }
}
