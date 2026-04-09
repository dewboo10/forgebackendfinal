// src/db/migrate.js — Run once to create all tables
import pg from 'pg'
import 'dotenv/config'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const SCHEMA = `
-- ─── USERS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                BIGINT PRIMARY KEY,        -- Telegram user ID
  username          TEXT,
  first_name        TEXT,
  last_name         TEXT,
  photo_url         TEXT,
  language_code     TEXT DEFAULT 'en',
  referred_by       BIGINT REFERENCES users(id),
  ref_code          TEXT UNIQUE,               -- user's own referral code
  wallet_address    TEXT,                      -- linked TON wallet

  -- balances (stored as integers × 10000 for precision)
  balance           BIGINT DEFAULT 0,          -- FRG balance ×10000
  total_mined       BIGINT DEFAULT 0,          -- lifetime mined ×10000
  blocks_found      INT DEFAULT 0,

  -- mining state
  mining_start      TIMESTAMPTZ,              -- NULL = not mining
  last_heartbeat    TIMESTAMPTZ,              -- last ping from client
  base_rate         NUMERIC(12,6) DEFAULT 0.1,-- FRG/s before upgrades

  -- subscription / automine
  automine_until    TIMESTAMPTZ,              -- NULL = no automine
  automine_lifetime BOOLEAN DEFAULT FALSE,

  -- boosts
  boost_active      TEXT,                     -- '3x_surge' | '5x_turbo' | NULL
  boost_until       TIMESTAMPTZ,
  surge_used_at     TIMESTAMPTZ,             -- last surge activation (for cooldown)
  turbo_used_at     TIMESTAMPTZ,             -- last turbo activation (for cooldown)
  boost_charges     INT DEFAULT 0,
  turbo_charges     INT DEFAULT 0,

  -- permanent flags
  speed_perm        BOOLEAN DEFAULT FALSE,    -- permanent 2× core

  -- misc
  daily_claimed_at  TIMESTAMPTZ,
  daily_streak      INT DEFAULT 0,
  is_banned         BOOLEAN DEFAULT FALSE,
  is_admin          BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  last_seen         TIMESTAMPTZ DEFAULT NOW()
);

-- ─── UPGRADES ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_upgrades (
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  upgrade_id  INT NOT NULL,
  level       INT DEFAULT 0,
  PRIMARY KEY (user_id, upgrade_id)
);

-- ─── PURCHASES ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id          SERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL,
  price_ton   NUMERIC(12,4),
  price_stars INT,
  tx_hash     TEXT,                           -- TON transaction hash
  boc         TEXT,                           -- TON bag-of-cells
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── REFERRALS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id          SERIAL PRIMARY KEY,
  referrer_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  referee_id  BIGINT REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  bonus_paid  BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ref_tier_claims (
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  tier_refs   INT NOT NULL,                   -- milestone (1,3,5,10...)
  claimed_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, tier_refs)
);

-- ─── SECURITY CIRCLE ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS circle_invites (
  id          SERIAL PRIMARY KEY,
  from_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  to_id       BIGINT REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'pending',         -- pending | accepted | declined
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_id, to_id)
);

CREATE TABLE IF NOT EXISTS circle_members (
  id          SERIAL PRIMARY KEY,
  owner_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
  member_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,
  trusted     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(owner_id, member_id)
);

-- ─── MISSIONS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_claims (
  user_id           BIGINT REFERENCES users(id) ON DELETE CASCADE,
  mission_id        TEXT NOT NULL,
  checkpoint_index  INT NOT NULL,
  claimed_at        TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, mission_id, checkpoint_index)
);

-- ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                  -- 'system'|'reward'|'referral'|'halving'
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  read        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── HALVING ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS halving_history (
  id            SERIAL PRIMARY KEY,
  epoch_index   INT NOT NULL,
  users_at_time INT NOT NULL,
  triggered_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── GLOBAL CONFIG (editable from admin) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ADMIN AUDIT LOG ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_logs (
  id          SERIAL PRIMARY KEY,
  action      TEXT NOT NULL,
  target      TEXT,                           -- 'user:123' | 'config:base_rate'
  old_value   TEXT,
  new_value   TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INDEXES ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_ref_code       ON users(ref_code);
CREATE INDEX IF NOT EXISTS idx_users_total_mined    ON users(total_mined DESC);
CREATE INDEX IF NOT EXISTS idx_users_mining_start   ON users(mining_start) WHERE mining_start IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_referrer   ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_purchases_user       ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_circle_owner         ON circle_members(owner_id);

-- ─── DEFAULT CONFIG ───────────────────────────────────────────────────────────
INSERT INTO config (key, value) VALUES
  ('base_rate',             '0.1'),
  ('halving_epochs',        '[{"users":0,"label":"Genesis","rate":1.0},{"users":1000,"label":"1K","rate":0.5},{"users":10000,"label":"10K","rate":0.25},{"users":100000,"label":"100K","rate":0.125},{"users":1000000,"label":"1M","rate":0.0625},{"users":100000000,"label":"100M","rate":0.03125}]'),
  ('automine_offline_cap',  '28800'),
  ('referral_bonus_frg',    '5000'),
  ('referral_percent',      '0.1'),
  ('daily_reward_base',     '1000'),
  ('maintenance_mode',      'false'),
  ('registration_open',     'true'),
  ('max_circle_size',       '5'),
  ('heartbeat_timeout_sec', '30')
ON CONFLICT (key) DO NOTHING;
`

async function migrate() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running migrations...')
    await client.query(SCHEMA)
    console.log('✅ Migration complete')
  } finally {
    client.release()
    await pool.end()
  }
}

migrate().catch(e => { console.error(e); process.exit(1) })
