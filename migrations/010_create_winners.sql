CREATE TABLE IF NOT EXISTS winners (
  id CHAR(36) NOT NULL PRIMARY KEY,
  room_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  tg_id VARCHAR(32) NOT NULL,
  cartela_ids JSON NOT NULL,
  patterns JSON NOT NULL,
  prize_amount DECIMAL(12, 2) NOT NULL,
  settlement_key VARCHAR(255) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_winners_user_id (user_id),
  KEY idx_winners_tg_id (tg_id),
  KEY idx_winners_created_at (created_at),
  CONSTRAINT fk_winners_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_winners_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_winners_prize_amount CHECK (prize_amount >= 0)
) ENGINE=InnoDB;
