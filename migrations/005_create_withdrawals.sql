CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  tg_id VARCHAR(32) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  name VARCHAR(255),
  destination VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  paid_by VARCHAR(32),
  rejected_by VARCHAR(32),
  CONSTRAINT fk_withdrawals_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_withdrawals_amount CHECK (amount > 0),
  CONSTRAINT chk_withdrawals_method CHECK (method IN ('Telebirr', 'CBE')),
  CONSTRAINT chk_withdrawals_status CHECK (status IN ('PENDING', 'PAID', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals (user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_tg_id ON withdrawals (tg_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals (status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_created_at ON withdrawals (created_at);
