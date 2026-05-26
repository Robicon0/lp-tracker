-- DefiDesh historical P&L tracking schema
-- Run via Vercel Postgres dashboard or `psql $POSTGRES_URL -f scripts/setup-db.sql`

CREATE TABLE IF NOT EXISTS wallets (
  address      TEXT PRIMARY KEY,
  chain        TEXT NOT NULL DEFAULT 'evm',
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id                 SERIAL PRIMARY KEY,
  wallet_address     TEXT NOT NULL,
  total_value        NUMERIC(24, 6) NOT NULL DEFAULT 0,
  lp_value           NUMERIC(24, 6) NOT NULL DEFAULT 0,
  lending_value      NUMERIC(24, 6) NOT NULL DEFAULT 0,
  token_value        NUMERIC(24, 6) NOT NULL DEFAULT 0,
  total_fees_earned  NUMERIC(24, 6) NOT NULL DEFAULT 0,
  position_count     INTEGER NOT NULL DEFAULT 0,
  timestamp          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_wallet_time
  ON portfolio_snapshots (wallet_address, timestamp DESC);

CREATE TABLE IF NOT EXISTS position_snapshots (
  id                  SERIAL PRIMARY KEY,
  wallet_address      TEXT NOT NULL,
  position_id         TEXT NOT NULL,
  protocol            TEXT,
  chain               TEXT,
  token_pair          TEXT,
  value               NUMERIC(24, 6) NOT NULL DEFAULT 0,
  uncollected_fees    NUMERIC(24, 6) NOT NULL DEFAULT 0,
  claimed_fees        NUMERIC(24, 6) NOT NULL DEFAULT 0,
  status              TEXT,
  timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_position_snapshots_pid_time
  ON position_snapshots (position_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_position_snapshots_wallet_time
  ON position_snapshots (wallet_address, timestamp DESC);

-- Manual deposit/withdrawal entries for closed positions whose on-chain
-- history cannot be reconstructed from public RPCs (HyperEVM closed pos,
-- BNB Chain old positions, etc.). Users enter their amounts ONCE in the
-- analytics page and the values persist across sessions.
CREATE TABLE IF NOT EXISTS position_manual_entries (
  id              SERIAL PRIMARY KEY,
  wallet_address  TEXT NOT NULL,
  position_id     TEXT NOT NULL,
  deposit_usd     NUMERIC(24, 6) NOT NULL,
  withdrawal_usd  NUMERIC(24, 6) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_address, position_id)
);

CREATE INDEX IF NOT EXISTS idx_position_manual_entries_wallet
  ON position_manual_entries (wallet_address);
