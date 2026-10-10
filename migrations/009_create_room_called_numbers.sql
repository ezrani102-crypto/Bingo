CREATE TABLE IF NOT EXISTS room_called_numbers (
  id CHAR(36) NOT NULL PRIMARY KEY,
  room_id CHAR(36) NOT NULL,
  number INT NOT NULL,
  letter VARCHAR(1) NOT NULL,
  call_index INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_room_called_numbers_room_id (room_id),
  KEY idx_room_called_numbers_call_index (room_id, call_index),
  CONSTRAINT fk_room_called_numbers_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT chk_room_called_numbers_number CHECK (number BETWEEN 1 AND 75),
  CONSTRAINT chk_room_called_numbers_call_index CHECK (call_index >= 0)
) ENGINE=InnoDB;
