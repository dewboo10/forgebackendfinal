# Forge Backend

Complete backend for the Forge Telegram Mini App — mining engine, payments, referrals, automine, halving, security circle, and admin panel.

---

## Stack

| Layer       | Tech                          |
|-------------|-------------------------------|
| Server      | Node.js + Fastify             |
| Database    | PostgreSQL                    |
| Cache/Queue | Redis + BullMQ                |
| Payments    | TON (TonAPI) + Telegram Stars |
| Bot         | node-telegram-bot-api         |

---

## Quick Start

### 1. Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+

### 2. Install

```bash
cd forge-backend
npm install
cp .env.example .env
# Fill in all values in .env
```

### 3. Database

```bash
npm run migrate    # Creates all tables + default config
```

### 4. Run

```bash
npm run dev        # Development (auto-restart)
npm start          # Production
```

Server starts on `PORT` (default 3001).
Admin panel available at `http://localhost:3001/admin`

---

## Environment Variables

| Key                  | Description                                      |
|----------------------|--------------------------------------------------|
| `DATABASE_URL`       | PostgreSQL connection string                     |
| `REDIS_URL`          | Redis URL                                        |
| `BOT_TOKEN`          | Telegram bot token from @BotFather               |
| `BOT_USERNAME`       | Your bot's username (without @)                  |
| `TON_WALLET`         | Your TON wallet address for receiving payments   |
| `TON_API_KEY`        | TonAPI key — get from tonapi.io                  |
| `TON_NETWORK`        | `mainnet` or `testnet`                           |
| `ADMIN_SECRET`       | Secret for signing admin JWT (32+ chars)         |
| `ADMIN_PASSWORD`     | Password for admin panel login                   |
| `JWT_SECRET`         | JWT secret                                       |
| `FRONTEND_URL`       | Your Telegram Mini App URL (for CORS)            |
| `DEV_USER_ID`        | (dev only) User id to bypass Telegram login during testing |

---

## API Routes

### Auth
| Method | Path                | Description                        |
|--------|---------------------|------------------------------------|
| POST   | /api/auth/login     | Validate Telegram initData, create/get user |

### Mining
| Method | Path                          | Description                     |
|--------|-------------------------------|---------------------------------|
| GET    | /api/mining/state             | Full mining state               |
| POST   | /api/mining/start             | Start session                   |
| POST   | /api/mining/stop              | Stop + settle earnings          |
| POST   | /api/mining/heartbeat         | Keep-alive ping (every 20s)     |
| POST   | /api/mining/claim-offline     | Claim automine offline earnings |
| GET    | /api/mining/upgrades          | Get upgrades + costs            |
| POST   | /api/mining/upgrades/buy      | Purchase upgrade with FRG       |

### Store
| Method | Path                    | Description                          |
|--------|-------------------------|--------------------------------------|
| GET    | /api/store/items        | All items + owned status             |
| GET    | /api/store/purchased    | User's active purchases              |
| GET    | /api/store/invoice      | Create Telegram Stars invoice link   |
| POST   | /api/store/verify       | Verify TON transaction + activate    |
| POST   | /api/store/stars-webhook| Telegram payment webhook             |

### Referrals
| Method | Path                    | Description                      |
|--------|-------------------------|----------------------------------|
| GET    | /api/referrals/info     | Ref code, count, earnings        |
| GET    | /api/referrals/list     | Full referral list               |
| GET    | /api/referrals/tiers    | Tier progress + claimed          |
| POST   | /api/referrals/claim    | Claim tier reward                |

### Profile & Social
| Method | Path                          | Description              |
|--------|-------------------------------|--------------------------|
| GET    | /api/profile                  | Full profile + rank      |
| GET    | /api/leaderboard              | Top miners               |
| GET    | /api/daily-reward             | Daily reward status      |
| POST   | /api/daily-reward/claim       | Claim daily reward       |
| GET    | /api/circle                   | Security circle + pending|
| POST   | /api/circle/invite            | Send circle invite       |
| POST   | /api/circle/accept            | Accept invite            |
| POST   | /api/circle/decline           | Decline invite           |
| DELETE | /api/circle/:memberId         | Remove from circle       |
| POST   | /api/wallet/link              | Link TON wallet          |
| GET    | /api/wallet                   | Get linked wallet        |
| GET    | /api/missions                 | All missions + progress  |
| POST   | /api/missions/claim           | Claim checkpoint reward  |
| GET    | /api/notifications            | All notifications        |
| PATCH  | /api/notifications/:id/read   | Mark read                |
| PATCH  | /api/notifications/read-all   | Mark all read            |

### Admin (all require Bearer token)
| Method | Path                                | Description                     |
|--------|-------------------------------------|---------------------------------|
| POST   | /api/admin/login                    | Get admin token                 |
| GET    | /api/admin/stats                    | Dashboard stats                 |
| GET    | /api/admin/growth                   | User growth chart data          |
| GET    | /api/admin/users                    | Paginated user list             |
| GET    | /api/admin/users/:id                | Full user detail                |
| PATCH  | /api/admin/users/:id/balance        | Adjust balance                  |
| PATCH  | /api/admin/users/:id/ban            | Ban / unban                     |
| PATCH  | /api/admin/users/:id/automine       | Grant automine                  |
| PATCH  | /api/admin/users/:id/speed-perm     | Toggle perm 2×                  |
| GET    | /api/admin/config                   | All config values               |
| PATCH  | /api/admin/config                   | Update single config            |
| PATCH  | /api/admin/config/bulk              | Update multiple configs         |
| GET    | /api/admin/halving                  | Halving status + history        |
| PATCH  | /api/admin/halving                  | Edit epochs                     |
| POST   | /api/admin/halving/trigger          | Manual trigger                  |
| GET    | /api/admin/purchases                | All purchases                   |
| POST   | /api/admin/purchases/manual         | Manual grant                    |
| POST   | /api/admin/broadcast/notification   | In-app notification             |
| POST   | /api/admin/broadcast/telegram       | Telegram bot message            |
| GET    | /api/admin/logs                     | Audit log                       |
| PATCH  | /api/admin/maintenance              | Toggle maintenance mode         |
| PATCH  | /api/admin/registration             | Toggle registration             |
| POST   | /api/admin/cache/flush              | Flush Redis                     |

---

## How Each Feature Works

### Mining
- Client calls `/start` → server records `mining_start = NOW()`
- Client pings `/heartbeat` every 20 seconds while app is open
- On app close, client calls `/stop` → server computes `elapsed × rate` and credits balance
- Server never trusts the client for any balance math

### AutoMine
- Subscribers: BullMQ job runs every 5 minutes, credits earnings for all users with active automine regardless of heartbeat
- Non-subscribers: heartbeat cleanup job detects stale sessions (heartbeat > 2× timeout) and auto-stops them
- Offline cap (default 8h) prevents unlimited accumulation

### Halving
- BullMQ job checks total user count every 10 minutes
- Compares against epochs in `config.halving_epochs` (editable from admin)
- When a new milestone is crossed: logs to `halving_history`, notifies all users, busts cache
- Rate multiplier applied in every balance calculation — fully automatic

### Referrals
- `start_param` in Telegram initData carries the referrer's code
- On first login, referee is linked and referrer gets notified
- 10% of all earnings paid to referrer in real time on each `/stop` and automine tick
- Tier rewards (automine days, FRG bonuses, perm 2×) claimed manually when milestones hit

### TON Payments
- Frontend creates transaction via TonConnect and gets a BOC (bag-of-cells)
- Sends BOC to `/api/store/verify`
- Backend verifies against TonAPI: correct destination wallet + correct amount
- Item activated in DB atomically

### Telegram Stars
- Frontend calls `/api/store/invoice?itemId=...`
- Backend creates invoice link via Bot API
- Telegram handles payment, sends `successful_payment` update to Stars webhook
- Backend activates item on receipt

### Security Circle
- Users invite each other by Telegram ID
- Invite stored as `pending` → target accepts/declines
- Accepted: both sides have each other in circle
- Separate from referrals — circle is a trusted network, referrals are recruitment

---

## Deployment

### Railway (recommended for solo dev)

```bash
railway login
railway init
railway add postgresql redis
railway deploy
```

Set all env vars in Railway dashboard.

### Manual VPS

```bash
# Install postgres, redis, node
# Clone repo, npm install
# Set up .env
# Use pm2 for process management
npm install -g pm2
pm2 start src/index.js --name forge-backend
pm2 save
```

### For 1M+ Users

- Add PgBouncer in front of Postgres (connection pooling)
- Scale to 3+ backend instances behind a load balancer (nginx / Cloudflare)
- Use Redis Cluster for the cache layer
- Move BullMQ workers to a separate process/machine
- Set `max` pool connections in pg Pool proportionally per instance
- Add read replicas for leaderboard and analytics queries
- Use Cloudflare in front for DDoS and rate limit protection

---

## Frontend Wiring

In your frontend `.env`:
```
VITE_API_URL=https://your-backend-domain.com
```

The `api.js` already sends `X-Telegram-Init-Data` header on every request.
Make sure your Telegram bot's webhook is set to `https://your-backend-domain.com/api/store/stars-webhook` for Stars payments.

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d '{"url":"https://your-domain.com/api/store/stars-webhook"}'
```
#   f o r g e b a c k e n d f i n a l 
 
 