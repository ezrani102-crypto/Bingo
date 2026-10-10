CREATE TABLE IF NOT EXISTS winners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL,
  user_id UUID NOT NULL,
  tg_id VARCHAR(32) NOT NULL,
  cartela_ids JSONB NOT NULL,
  patterns JSONB NOT NULL,
  prize_amount NUMERIC(12, 2) NOT NULL,
  settlement_key VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_winners_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_winners_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_winners_prize_amount CHECK (prize_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_winners_user_id ON winners (user_id);
CREATE INDEX IF NOT EXISTS idx_winners_tg_id ON winners (tg_id);
CREATE INDEX IF NOT EXISTS idx_winners_created_at ON winners (created_at);
