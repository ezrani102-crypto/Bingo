CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  tg_id VARCHAR(32) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  name VARCHAR(255),
  reference VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  approved_by VARCHAR(32),
  rejected_by VARCHAR(32),
  CONSTRAINT uq_deposits_tg_reference UNIQUE (tg_id, reference),
  CONSTRAINT fk_deposits_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_deposits_amount CHECK (amount > 0),
  CONSTRAINT chk_deposits_method CHECK (method IN ('Telebirr', 'CBE')),
  CONSTRAINT chk_deposits_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits (user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_tg_id ON deposits (tg_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits (status);
CREATE INDEX IF NOT EXISTS idx_deposits_created_at ON deposits (created_at);
