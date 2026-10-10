CREATE TABLE IF NOT EXISTS room_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL,
  user_id UUID NOT NULL,
  tg_id VARCHAR(32) NOT NULL,
  claim_attempts INT NOT NULL DEFAULT 0,
  cartela_count INT NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_room_players_room_user UNIQUE (room_id, user_id),
  CONSTRAINT uq_room_players_room_tg UNIQUE (room_id, tg_id),
  CONSTRAINT fk_room_players_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_room_players_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_room_players_claim_attempts CHECK (claim_attempts >= 0),
  CONSTRAINT chk_room_players_cartela_count CHECK (cartela_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_room_players_user_id ON room_players (user_id);
