CREATE TABLE IF NOT EXISTS room_cartelas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL,
  user_id UUID NOT NULL,
  tg_id VARCHAR(32) NOT NULL,
  cartela_id INT NOT NULL,
  card JSONB NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_room_cartelas_room_cartela UNIQUE (room_id, cartela_id),
  CONSTRAINT uq_room_cartelas_room_user_cartela UNIQUE (room_id, user_id, cartela_id),
  CONSTRAINT fk_room_cartelas_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_room_cartelas_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_room_cartelas_id CHECK (cartela_id BETWEEN 1 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_room_cartelas_user_id ON room_cartelas (user_id);
CREATE INDEX IF NOT EXISTS idx_room_cartelas_tg_id ON room_cartelas (tg_id);
CREATE INDEX IF NOT EXISTS idx_room_cartelas_cartela_id ON room_cartelas (cartela_id);
