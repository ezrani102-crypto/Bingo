CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_id VARCHAR(32) NOT NULL UNIQUE,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  username VARCHAR(255),
  phone VARCHAR(32),
  is_registered BOOLEAN NOT NULL DEFAULT FALSE,
  language VARCHAR(2) NOT NULL DEFAULT 'am',
  balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  play_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reserved_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  games_played INT NOT NULL DEFAULT 0,
  total_wins INT NOT NULL DEFAULT 0,
  total_winnings NUMERIC(12, 2) NOT NULL DEFAULT 0,
  cartelas_purchased INT NOT NULL DEFAULT 0,
  referral_earnings NUMERIC(12, 2) NOT NULL DEFAULT 0,
  registration_bonus_granted BOOLEAN NOT NULL DEFAULT FALSE,
  referral_bonus_granted BOOLEAN NOT NULL DEFAULT FALSE,
  referred_by VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_users_language CHECK (language IN ('am', 'en')),
  CONSTRAINT chk_users_balance CHECK (balance >= 0),
  CONSTRAINT chk_users_play_balance CHECK (play_balance >= 0),
  CONSTRAINT chk_users_reserved_balance CHECK (reserved_balance >= 0),
  CONSTRAINT chk_users_games_played CHECK (games_played >= 0),
  CONSTRAINT chk_users_total_wins CHECK (total_wins >= 0),
  CONSTRAINT chk_users_total_winnings CHECK (total_winnings >= 0),
  CONSTRAINT chk_users_cartelas_purchased CHECK (cartelas_purchased >= 0),
  CONSTRAINT chk_users_referral_earnings CHECK (referral_earnings >= 0)
);

CREATE INDEX IF NOT EXISTS idx_users_language ON users (language);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users (referred_by);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);
