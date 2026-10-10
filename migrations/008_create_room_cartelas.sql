CREATE TABLE IF NOT EXISTS room_cartelas (
  id CHAR(36) NOT NULL PRIMARY KEY,
  room_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  tg_id VARCHAR(32) NOT NULL,
  cartela_id INT NOT NULL,
  card JSON NOT NULL,
  reserved_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_room_cartelas_room_cartela (room_id, cartela_id),
  UNIQUE KEY uq_room_cartelas_room_user_cartela (room_id, user_id, cartela_id),
  KEY idx_room_cartelas_user_id (user_id),
  KEY idx_room_cartelas_tg_id (tg_id),
  KEY idx_room_cartelas_cartela_id (cartela_id),
  CONSTRAINT fk_room_cartelas_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_room_cartelas_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_room_cartelas_id CHECK (cartela_id BETWEEN 1 AND 100)
) ENGINE=InnoDB;
