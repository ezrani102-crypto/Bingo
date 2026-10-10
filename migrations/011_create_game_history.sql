CREATE TABLE IF NOT EXISTS game_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID,
  user_id UUID,
  tg_id VARCHAR(32),
  result VARCHAR(16) NOT NULL,
  prize NUMERIC(12, 2) NOT NULL DEFAULT 0,
  stake NUMERIC(12, 2) NOT NULL DEFAULT 0,
  pattern VARCHAR(255),
  cartela_ids JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_game_history_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE SET NULL,
  CONSTRAINT fk_game_history_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_game_history_result CHECK (result IN ('WIN', 'LOSS')),
  CONSTRAINT chk_game_history_prize CHECK (prize >= 0),
  CONSTRAINT chk_game_history_stake CHECK (stake >= 0)
);

CREATE INDEX IF NOT EXISTS idx_game_history_user_id ON game_history (user_id);
CREATE INDEX IF NOT EXISTS idx_game_history_tg_id ON game_history (tg_id);
CREATE INDEX IF NOT EXISTS idx_game_history_room_id ON game_history (room_id);
CREATE INDEX IF NOT EXISTS idx_game_history_created_at ON game_history (created_at);
