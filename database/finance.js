const { transactional, query } = require('./db');

function decimal(value) {
  return Number(value || 0);
}

function getAvailableWalletBalance(user) {
  if (!user || typeof user !== 'object') {
    throw new Error('Wallet data is unavailable.');
  }

  const balanceValue = user.balance;
  const reservedBalanceValue = user.reservedBalance ?? user.reserved_balance;
  if (balanceValue == null || reservedBalanceValue == null) {
    throw new Error('Wallet data is incomplete.');
  }

  const balance = Number(balanceValue);
  const reservedBalance = Number(reservedBalanceValue);
  if (![balance, reservedBalance].every(Number.isFinite) || balance < 0 || reservedBalance < 0) {
    throw new Error('Wallet data is invalid.');
  }

  return Math.round(Math.max(0, balance - reservedBalance) * 100) / 100;
}

function normalizeTgId(tgId) {
  return String(tgId).trim();
}

async function ensureUserExistsByTgId(tgId) {
  const existing = await query('SELECT * FROM users WHERE tg_id = $1 LIMIT 1', [normalizeTgId(tgId)]);
  return existing.rows[0] || null;
}

async function findOrCreateUserByTgId({ tgId, firstName = null, lastName = null, username = null, language = 'am', phone = null }) {
  const normalizedTgId = normalizeTgId(tgId);

  return transactional(async (client) => {
    const existing = await client.query(
      'SELECT * FROM users WHERE tg_id = $1 FOR UPDATE',
      [normalizedTgId]
    );

    if (existing.rows[0]) {
      return { created: false, user: existing.rows[0] };
    }

    const created = await client.query(
      `INSERT INTO users (tg_id, first_name, last_name, username, phone, language, is_registered, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
       RETURNING *`,
      [normalizedTgId, firstName, lastName, username, phone, language]
    );

    return { created: true, user: created.rows[0] };
  });
}

async function updateUserProfile({ tgId, updates = {} }) {
  const normalizedTgId = normalizeTgId(tgId);
  const keys = Object.keys(updates || {});
  if (!keys.length) return null;

  const assignments = keys.map((key, index) => `${key} = $${index + 2}`).join(', ');
  const values = keys.map((key) => updates[key]);

  const result = await query(
    `UPDATE users
     SET ${assignments}, updated_at = NOW()
     WHERE tg_id = $1
     RETURNING *`,
    [normalizedTgId, ...values]
  );

  return result.rows[0] || null;
}

async function getUserWalletByTgId(tgId) {
  const wallet = await query(
    `SELECT wallets.*
     FROM wallets
     INNER JOIN users ON users.id = wallets.user_id
     WHERE users.tg_id = $1
     LIMIT 1`,
    [normalizeTgId(tgId)]
  );
  return wallet.rows[0] || null;
}

async function getUserBalance(tgId) {
  return transactional(async (client) => {
    const userResult = await client.query('SELECT * FROM users WHERE tg_id = $1 FOR UPDATE', [normalizeTgId(tgId)]);
    const user = userResult.rows[0];
    if (!user) return null;
    const walletResult = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [user.id]);
    let wallet = walletResult.rows[0];
    if (!wallet) {
      const inserted = await client.query(
        `INSERT INTO wallets (user_id, balance, play_balance, reserved_balance, updated_at)
         VALUES ($1, $2, $2, 0, NOW()) RETURNING *`,
        [user.id, Number(user.balance || 0)]
      );
      wallet = inserted.rows[0];
    }
    return wallet;
  });
}

async function upsertUserWallet(userId, amountDelta, fields = {}) {
  return transactional(async (client) => {
    const wallet = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    if (!wallet.rows[0]) {
      const inserted = await client.query(
        `INSERT INTO wallets (user_id, balance, play_balance, reserved_balance, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING *`,
        [
          userId,
          Number(fields.balance || 0),
          Number(fields.play_balance || 0),
          Number(fields.reserved_balance || 0),
        ]
      );
      return inserted.rows[0];
    }

    const current = wallet.rows[0];
    const nextBalance = decimal(current.balance) + decimal(amountDelta.balance || 0);
    const nextPlayBalance = decimal(current.play_balance) + decimal(amountDelta.play_balance || 0);
    const nextReservedBalance = decimal(current.reserved_balance) + decimal(amountDelta.reserved_balance || 0);

    if (nextBalance < 0 || nextPlayBalance < 0 || nextReservedBalance < 0) {
      throw new Error('Insufficient wallet balance.');
    }

    const updated = await client.query(
      `UPDATE wallets
       SET balance = $2,
           play_balance = $3,
           reserved_balance = $4,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, nextBalance, nextPlayBalance, nextReservedBalance]
    );
    return updated.rows[0];
  });
}

async function reserveGameStake({ userId, amount, reason = 'GAME_STAKE' }) {
  if (!userId || Number(amount) <= 0) {
    throw new Error('Invalid stake amount.');
  }

  return transactional(async (client) => {
    const wallet = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    if (!wallet.rows[0]) {
      throw new Error('Wallet not found for user.');
    }

    const current = wallet.rows[0];
    if (decimal(current.play_balance) < decimal(amount)) {
      throw new Error('Insufficient balance.');
    }

    const nextPlay = decimal(current.play_balance) - decimal(amount);
    const nextReserved = decimal(current.reserved_balance) + decimal(amount);

    const updated = await client.query(
      `UPDATE wallets
       SET play_balance = $2,
           reserved_balance = $3,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, nextPlay, nextReserved]
    );

    const tx = await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, reason, created_at)
       VALUES ($1, 'GAME_STAKE', $2, 'RESERVED', $3, NOW())
       RETURNING *`,
      [userId, Number(amount), reason]
    );

    return { wallet: updated.rows[0], transaction: tx.rows[0] };
  });
}

async function releaseGameStake({ userId, amount, reason = 'GAME_STAKE_REFUND' }) {
  if (!userId || Number(amount) <= 0) {
    throw new Error('Invalid refund amount.');
  }

  return transactional(async (client) => {
    const wallet = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    if (!wallet.rows[0]) {
      throw new Error('Wallet not found for user.');
    }

    const current = wallet.rows[0];
    const nextPlay = decimal(current.play_balance) + decimal(amount);
    const nextReserved = Math.max(0, decimal(current.reserved_balance) - decimal(amount));

    const updated = await client.query(
      `UPDATE wallets
       SET play_balance = $2,
           reserved_balance = $3,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, nextPlay, nextReserved]
    );

    const tx = await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, reason, created_at)
       VALUES ($1, 'GAME_STAKE_REFUND', $2, 'REFUNDED', $3, NOW())
       RETURNING *`,
      [userId, Number(amount), reason]
    );

    return { wallet: updated.rows[0], transaction: tx.rows[0] };
  });
}

async function creditWalletBalance({ userId, amount, reason = 'CREDIT' }) {
  if (!userId || Number(amount) <= 0) {
    throw new Error('Invalid credit amount.');
  }

  return transactional(async (client) => {
    const wallet = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    if (!wallet.rows[0]) {
      throw new Error('Wallet not found for user.');
    }

    const current = wallet.rows[0];
    const nextBalance = decimal(current.balance) + decimal(amount);
    const nextPlay = decimal(current.play_balance) + decimal(amount);

    const updated = await client.query(
      `UPDATE wallets
       SET balance = $2,
           play_balance = $3,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, nextBalance, nextPlay]
    );

    const tx = await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, reason, created_at)
       VALUES ($1, 'WALLET_CREDIT', $2, 'SETTLED', $3, NOW())
       RETURNING *`,
      [userId, Number(amount), reason]
    );

    return { wallet: updated.rows[0], transaction: tx.rows[0] };
  });
}

async function insertDepositIfMissing({ userId, tgId, amount, method, reference, status = 'PENDING' }) {
  return transactional(async (client) => {
    const existing = await client.query(
      'SELECT id FROM deposits WHERE tg_id = $1 AND reference = $2 AND status IN (\'PENDING\', \'APPROVED\') FOR UPDATE',
      [String(tgId), String(reference)]
    );

    if (existing.rows[0]) {
      return { duplicate: true, id: existing.rows[0].id };
    }

    const inserted = await client.query(
      `INSERT INTO deposits (user_id, tg_id, amount, method, reference, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [userId, String(tgId), Number(amount), method, String(reference), status]
    );

    return { duplicate: false, record: inserted.rows[0] };
  });
}

async function approveDepositIfPending({ depositId, approvedBy }) {
  return transactional(async (client) => {
    const depositResult = await client.query(
      'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
      [depositId]
    );
    const deposit = depositResult.rows[0];
    if (!deposit) {
      const error = new Error('DEPOSIT_NOT_FOUND');
      error.code = 'DEPOSIT_NOT_FOUND';
      throw error;
    }
    if (deposit.status !== 'PENDING') return { duplicate: true, deposit };

    const userResult = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [deposit.user_id]);
    if (!userResult.rows[0]) {
      const error = new Error('USER_NOT_FOUND');
      error.code = 'USER_NOT_FOUND';
      throw error;
    }
    const walletResult = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [deposit.user_id]);
    if (!walletResult.rows[0]) {
      const error = new Error('WALLET_NOT_FOUND');
      error.code = 'WALLET_NOT_FOUND';
      throw error;
    }
    const existingLedger = await client.query(
      `SELECT id FROM transactions
       WHERE type = 'DEPOSIT_APPROVED' AND reference = $1
       LIMIT 1 FOR UPDATE`,
      [String(deposit.id)]
    );
    if (existingLedger.rows[0]) return { duplicate: true, deposit };

    const wallet = walletResult.rows[0];
    const amount = Number(deposit.amount);
    const updatedWallet = await client.query(
      `UPDATE wallets
       SET balance = balance + $2,
           play_balance = play_balance + $2,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [deposit.user_id, amount]
    );
    await client.query(
      'UPDATE users SET balance = balance + $2, play_balance = play_balance + $2, updated_at = NOW() WHERE id = $1',
      [deposit.user_id, amount]
    );
    await client.query(
      `INSERT INTO transactions (user_id, tg_id, type, amount, status, reason, reference, metadata, created_at)
       VALUES ($1, $2, 'DEPOSIT_APPROVED', $3, 'SETTLED', 'DEPOSIT_APPROVED', $4, $5::jsonb, NOW())`,
      [deposit.user_id, deposit.tg_id, amount, String(deposit.id), JSON.stringify({ depositId: deposit.id })]
    );
    const updatedDeposit = await client.query(
      `UPDATE deposits
       SET status = 'APPROVED', approved_at = NOW(), approved_by = $2
       WHERE id = $1
       RETURNING *`,
      [deposit.id, String(approvedBy)]
    );
    return { duplicate: false, deposit: updatedDeposit.rows[0], wallet: updatedWallet.rows[0], previousWallet: wallet };
  });
}

async function insertWithdrawalIfMissing({ userId, tgId, amount, method, destination, status = 'PENDING' }) {
  return transactional(async (client) => {
    const existing = await client.query(
      'SELECT id FROM withdrawals WHERE tg_id = $1 AND destination = $2 AND amount = $3 AND status = \'PENDING\' FOR UPDATE',
      [String(tgId), String(destination), Number(amount)]
    );

    if (existing.rows[0]) {
      return { duplicate: true, id: existing.rows[0].id };
    }

    const inserted = await client.query(
      `INSERT INTO withdrawals (user_id, tg_id, amount, method, destination, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [userId, String(tgId), Number(amount), method, String(destination), status]
    );

    return { duplicate: false, record: inserted.rows[0] };
  });
}

async function settlePrizeIfMissing({ userId, tgId, gameId, settlementKey, amount }) {
  return transactional(async (client) => {
    const existing = await client.query(
      'SELECT id FROM transactions WHERE settlement_key = $1 FOR UPDATE',
      [String(settlementKey)]
    );

    if (existing.rows[0]) {
      return { duplicate: true, id: existing.rows[0].id };
    }

    const wallet = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    const current = wallet.rows[0];
    if (!current) {
      throw new Error('Wallet does not exist for user.');
    }

    const nextBalance = decimal(current.balance) + decimal(amount);
    const nextPlayBalance = decimal(current.play_balance) + decimal(amount);

    await client.query(
      `UPDATE wallets
       SET balance = $2,
           play_balance = $3,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, nextBalance, nextPlayBalance]
    );

    const inserted = await client.query(
      `INSERT INTO transactions (user_id, tg_id, type, amount, status, reason, settlement_key, game_id, metadata, created_at)
       VALUES ($1, $2, 'GAME_PRIZE', $3, 'SETTLED', 'BINGO_WIN', $4, $5, $6::jsonb, NOW())
       RETURNING *`,
      [userId, String(tgId), Number(amount), String(settlementKey), String(gameId), JSON.stringify({ source: 'bingo' })]
    );

    return { duplicate: false, record: inserted.rows[0] };
  });
}

module.exports = {
  decimal,
  getAvailableWalletBalance,
  normalizeTgId,
  ensureUserExistsByTgId,
  findOrCreateUserByTgId,
  updateUserProfile,
  getUserWalletByTgId,
  getUserBalance,
  upsertUserWallet,
  reserveGameStake,
  releaseGameStake,
  creditWalletBalance,
  insertDepositIfMissing,
  approveDepositIfPending,
  insertWithdrawalIfMissing,
  settlePrizeIfMissing,
};
