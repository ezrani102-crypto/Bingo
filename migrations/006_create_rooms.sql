CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(16) NOT NULL DEFAULT 'WAITING',
  stake NUMERIC(12, 2) NOT NULL,
  capacity INT NOT NULL DEFAULT 20,
  pot NUMERIC(12, 2) NOT NULL DEFAULT 0,
  current_index INT NOT NULL DEFAULT 0,
  countdown_seconds INT NOT NULL DEFAULT 30,
  countdown_ends_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  winner_ends_at TIMESTAMPTZ,
  hash_commitment VARCHAR(255),
  secret_seed VARCHAR(255),
  draw_sequence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_rooms_status CHECK (status IN ('WAITING', 'COUNTDOWN', 'RUNNING', 'FINISHED')),
  CONSTRAINT chk_rooms_stake CHECK (stake > 0),
  CONSTRAINT chk_rooms_capacity CHECK (capacity > 0),
  CONSTRAINT chk_rooms_pot CHECK (pot >= 0),
  CONSTRAINT chk_rooms_current_index CHECK (current_index >= 0),
  CONSTRAINT chk_rooms_countdown CHECK (countdown_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms (status);
CREATE INDEX IF NOT EXISTS idx_rooms_updated_at ON rooms (updated_at);
