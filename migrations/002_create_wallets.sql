CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  play_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reserved_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_wallets_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_wallets_balance CHECK (balance >= 0),
  CONSTRAINT chk_wallets_play_balance CHECK (play_balance >= 0),
  CONSTRAINT chk_wallets_reserved_balance CHECK (reserved_balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_wallets_updated_at ON wallets (updated_at);
