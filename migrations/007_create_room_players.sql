CREATE TABLE IF NOT EXISTS room_players (
  id CHAR(36) NOT NULL PRIMARY KEY,
  room_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  tg_id VARCHAR(32) NOT NULL,
  claim_attempts INT NOT NULL DEFAULT 0,
  cartela_count INT NOT NULL DEFAULT 0,
  joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_room_players_room_user (room_id, user_id),
  UNIQUE KEY uq_room_players_room_tg (room_id, tg_id),
  KEY idx_room_players_user_id (user_id),
  CONSTRAINT fk_room_players_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_room_players_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_room_players_claim_attempts CHECK (claim_attempts >= 0),
  CONSTRAINT chk_room_players_cartela_count CHECK (cartela_count >= 0)
) ENGINE=InnoDB;
