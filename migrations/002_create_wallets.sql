CREATE TABLE IF NOT EXISTS wallets (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL UNIQUE,
  balance DECIMAL(12, 2) NOT NULL DEFAULT 0,
  play_balance DECIMAL(12, 2) NOT NULL DEFAULT 0,
  reserved_balance DECIMAL(12, 2) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_wallets_updated_at (updated_at),
  CONSTRAINT fk_wallets_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_wallets_balance CHECK (balance >= 0),
  CONSTRAINT chk_wallets_play_balance CHECK (play_balance >= 0),
  CONSTRAINT chk_wallets_reserved_balance CHECK (reserved_balance >= 0)
) ENGINE=InnoDB;
