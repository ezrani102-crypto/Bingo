CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  tg_id VARCHAR(32),
  type VARCHAR(64) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  reason VARCHAR(255),
  reference VARCHAR(255),
  metadata JSONB,
  settlement_key VARCHAR(255) UNIQUE,
  game_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_transactions_amount CHECK (amount >= 0),
  CONSTRAINT chk_transactions_status CHECK (status IN ('PENDING', 'RESERVED', 'APPROVED', 'REJECTED', 'PAID', 'REFUNDED', 'SETTLED'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tg_id ON transactions (tg_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions (type);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions (created_at);
