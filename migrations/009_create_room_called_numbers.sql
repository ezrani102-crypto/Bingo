CREATE TABLE IF NOT EXISTS room_called_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL,
  number INT NOT NULL,
  letter VARCHAR(1) NOT NULL,
  call_index INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_room_called_numbers_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT chk_room_called_numbers_number CHECK (number BETWEEN 1 AND 75),
  CONSTRAINT chk_room_called_numbers_call_index CHECK (call_index >= 0)
);

CREATE INDEX IF NOT EXISTS idx_room_called_numbers_room_id ON room_called_numbers (room_id);
CREATE INDEX IF NOT EXISTS idx_room_called_numbers_call_index ON room_called_numbers (room_id, call_index);
