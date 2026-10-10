const { getAvailableWalletBalance } = require('./finance');
const { query, transactional } = require('./db');

function normalizeRoomCode(roomCode) {
  return String(roomCode || '').trim();
}

function buildSetClause(fields) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return '';
  return keys.map((key, index) => `${key} = $${index + 2}`).join(', ');
}

async function createRoom({ roomCode, status = 'WAITING', stake = 10, capacity = 20, pot = 0, currentIndex = 0, countdownSeconds = 30, hashCommitment = null, secretSeed = null, drawSequence = null }) {
  const code = normalizeRoomCode(roomCode);
  if (!code) throw new Error('Room code is required.');

  const result = await query(
    `INSERT INTO rooms (
      room_code,
      status,
      stake,
      capacity,
      pot,
      current_index,
      countdown_seconds,
      hash_commitment,
      secret_seed,
      draw_sequence,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW(), NOW())
     RETURNING *`,
    [code, status, Number(stake), Number(capacity), Number(pot), Number(currentIndex), Number(countdownSeconds), hashCommitment, secretSeed, JSON.stringify(drawSequence ?? null)]
  );

  return result.rows[0];
}

async function getRoomByCode(roomCode) {
  const code = normalizeRoomCode(roomCode);
  if (!code) return null;

  const result = await query('SELECT * FROM rooms WHERE room_code = $1 LIMIT 1', [code]);
  return result.rows[0] || null;
}

async function getActiveRoom() {
  const result = await query(
    `SELECT *
     FROM rooms
     WHERE status IN ('WAITING', 'COUNTDOWN', 'RUNNING')
       AND room_code LIKE 'prod-%'
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  const activeRoom = result.rows[0] || null;
  console.log('[room:active]', JSON.stringify(activeRoom ? {
    roomId: activeRoom.id,
    roomCode: activeRoom.room_code,
    status: activeRoom.status,
    currentIndex: activeRoom.current_index,
  } : { roomId: null, roomCode: null, status: null }));
  return activeRoom;
}

async function getRoomById(roomId) {
  if (!roomId) return null;
  const result = await query('SELECT * FROM rooms WHERE id = $1 LIMIT 1', [roomId]);
  return result.rows[0] || null;
}

async function updateRoom(roomId, fields = {}) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return null;

  const setClause = keys.map((key, index) => `${key} = $${index + 2}`).join(', ');
  const params = [roomId, ...keys.map((key) => fields[key])];

  const result = await query(
    `UPDATE rooms
     SET ${setClause}, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    params
  );

  return result.rows[0] || null;
}

async function transitionRoomStatus({ roomId, expectedStatus = null, nextStatus, fields = {} }) {
  if (!roomId || !nextStatus) return null;

  const fieldEntries = Object.entries(fields || {});
  const params = [roomId];

  if (expectedStatus !== null && expectedStatus !== undefined) {
    params.push(expectedStatus);
  }

  params.push(nextStatus);
  const assignments = fieldEntries.map(([key, value], index) => {
    params.push(value);
    return `${key} = $${params.length}`;
  });

  const statusParamIndex = expectedStatus !== null && expectedStatus !== undefined ? 2 : 1;
  const queryText = `
    UPDATE rooms
    SET status = $${statusParamIndex + 1}${assignments.length ? `, ${assignments.join(', ')}` : ''}, updated_at = NOW()
    WHERE id = $1${expectedStatus !== null && expectedStatus !== undefined ? ` AND status = $2` : ''}
    RETURNING *
  `;

  const result = await query(queryText, params);
  return result.rows[0] || null;
}

async function upsertRoomPlayer({ roomId, userId, tgId, claimAttempts = 0, cartelaCount = 0 }) {
  return transactional(async (client) => {
    const existing = await client.query(
      `SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2 FOR UPDATE`,
      [roomId, userId]
    );

    if (existing.rows[0]) {
      const updated = await client.query(
        `UPDATE room_players
         SET claim_attempts = $3,
             cartela_count = $4,
             tg_id = $5,
             joined_at = NOW()
         WHERE room_id = $1 AND user_id = $2
         RETURNING *`,
        [roomId, userId, Number(claimAttempts), Number(cartelaCount), String(tgId)]
      );
      return updated.rows[0];
    }

    const inserted = await client.query(
      `INSERT INTO room_players (room_id, user_id, tg_id, claim_attempts, cartela_count, joined_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [roomId, userId, String(tgId), Number(claimAttempts), Number(cartelaCount)]
    );

    return inserted.rows[0];
  });
}

async function removeRoomPlayer(roomId, userId) {
  const result = await query(
    'DELETE FROM room_players WHERE room_id = $1 AND user_id = $2 RETURNING *',
    [roomId, userId]
  );
  return result.rows[0] || null;
}

async function addRoomCartela({ roomId, userId, tgId, cartelaId, card }) {
  return transactional(async (client) => {
    const existing = await client.query(
      `SELECT * FROM room_cartelas WHERE room_id = $1 AND user_id = $2 AND cartela_id = $3 FOR UPDATE`,
      [roomId, userId, Number(cartelaId)]
    );

    if (existing.rows[0]) {
      const updated = await client.query(
        `UPDATE room_cartelas
         SET card = $4,
             reserved_at = NOW()
         WHERE room_id = $1 AND user_id = $2 AND cartela_id = $3
         RETURNING *`,
        [roomId, userId, Number(cartelaId), JSON.stringify(card)]
      );
      return updated.rows[0];
    }

    const inserted = await client.query(
      `INSERT INTO room_cartelas (room_id, user_id, tg_id, cartela_id, card, reserved_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       RETURNING *`,
      [roomId, userId, String(tgId), Number(cartelaId), JSON.stringify(card)]
    );

    return inserted.rows[0];
  });
}

async function reserveCartelaAtomic({ roomId, userId, tgId, cartelaId, card, stake = 10, maxCartelas = 2 }) {
  return transactional(async (client) => {
    const roomResult = await client.query(
      'SELECT * FROM rooms WHERE id = $1 FOR UPDATE',
      [roomId]
    );
    const room = roomResult.rows[0];
    if (!room) {
      const error = new Error('ROOM_NOT_FOUND');
      error.code = 'ROOM_NOT_FOUND';
      throw error;
    }
    if (!['WAITING', 'COUNTDOWN'].includes(String(room.status))) {
      const error = new Error('ROOM_STARTED');
      error.code = room.status === 'FINISHED' ? 'GAME_FINISHED' : 'ROOM_STARTED';
      throw error;
    }

    const playerCountResult = await client.query(
      'SELECT COUNT(DISTINCT user_id)::int AS count FROM room_players WHERE room_id = $1',
      [roomId]
    );
    const existingCartelasResult = await client.query(
      'SELECT cartela_id FROM room_cartelas WHERE room_id = $1 AND user_id = $2 FOR UPDATE',
      [roomId, userId]
    );
    if (existingCartelasResult.rows.length >= Number(maxCartelas)) {
      const error = new Error('MAX_CARTELAS_REACHED');
      error.code = 'MAX_CARTELAS_REACHED';
      throw error;
    }

    const walletResult = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const wallet = walletResult.rows[0];
    if (!wallet || getAvailableWalletBalance(wallet) < Number(stake)) {
      const error = new Error('INSUFFICIENT_BALANCE');
      error.code = 'INSUFFICIENT_BALANCE';
      throw error;
    }

    const insertedCartela = await client.query(
      `INSERT INTO room_cartelas (room_id, user_id, tg_id, cartela_id, card, reserved_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       RETURNING *`,
      [roomId, userId, String(tgId), Number(cartelaId), JSON.stringify(card)]
    );

    const nextPlayerCartelaCount = existingCartelasResult.rows.length + 1;
    const playerResult = await client.query(
      'SELECT id FROM room_players WHERE room_id = $1 AND user_id = $2 FOR UPDATE',
      [roomId, userId]
    );
    if (playerResult.rows[0]) {
      await client.query(
        `UPDATE room_players
         SET cartela_count = $3, tg_id = $4
         WHERE room_id = $1 AND user_id = $2`,
        [roomId, userId, nextPlayerCartelaCount, String(tgId)]
      );
    } else {
      await client.query(
        `INSERT INTO room_players (room_id, user_id, tg_id, claim_attempts, cartela_count, joined_at)
         VALUES ($1, $2, $3, 0, $4, NOW())`,
        [roomId, userId, String(tgId), nextPlayerCartelaCount]
      );
    }

    const updatedWallet = await client.query(
      `UPDATE wallets
       SET balance = balance - $2,
           updated_at = NOW()
      WHERE user_id = $1 AND balance - reserved_balance >= $2
       RETURNING *`,
      [userId, Number(stake)]
    );
    if (!updatedWallet.rows[0]) {
      const error = new Error('INSUFFICIENT_BALANCE');
      error.code = 'INSUFFICIENT_BALANCE';
      throw error;
    }
    await client.query(
      'UPDATE users SET balance = GREATEST(0, balance - $2), play_balance = GREATEST(0, play_balance - $2), updated_at = NOW() WHERE id = $1',
      [userId, Number(stake)]
    );

    await client.query(
      `INSERT INTO transactions (user_id, tg_id, type, amount, status, reason, created_at)
       VALUES ($1, $2, 'GAME_STAKE', $3, 'RESERVED', 'CARTELA_RESERVE', NOW())`,
      [userId, String(tgId), Number(stake)]
    );
    const updatedRoom = await client.query(
      `UPDATE rooms
       SET status = CASE WHEN status = 'WAITING' THEN 'COUNTDOWN' ELSE status END,
           pot = pot + $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [roomId, Number(stake)]
    );

    return {
      room: updatedRoom.rows[0],
      wallet: updatedWallet.rows[0],
      cartela: insertedCartela.rows[0],
      cartelas: [...existingCartelasResult.rows.map(row => Number(row.cartela_id)), Number(cartelaId)].sort((a, b) => a - b),
      playerCount: Number(playerCountResult.rows[0]?.count || 0) + (nextPlayerCartelaCount === 1 ? 1 : 0),
    };
  });
}

async function releaseRoomCartelaAtomic({ roomId, userId, tgId, cartelaId, stake = 10, idempotencyKey }) {
  return transactional(async (client) => {
    const roomResult = await client.query(
      'SELECT * FROM rooms WHERE id = $1 FOR UPDATE',
      [roomId]
    );
    const room = roomResult.rows[0];
    if (!room) {
      const error = new Error('ROOM_NOT_FOUND');
      error.code = 'ROOM_NOT_FOUND';
      throw error;
    }

    const key = String(idempotencyKey || '').trim();
    if (!key || key.length > 128) {
      const error = new Error('INVALID_IDEMPOTENCY_KEY');
      error.code = 'INVALID_IDEMPOTENCY_KEY';
      throw error;
    }
    const settlementKey = `CARTELA_REFUND:${roomId}:${userId}:${Number(cartelaId)}:${key}`;
    const previousRefund = await client.query(
      'SELECT id FROM transactions WHERE settlement_key = $1 LIMIT 1',
      [settlementKey]
    );
    if (previousRefund.rows[0]) {
      const walletResult = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (!walletResult.rows[0]) {
        const error = new Error('WALLET_NOT_FOUND');
        error.code = 'WALLET_NOT_FOUND';
        throw error;
      }
      const cartelasResult = await client.query(
        'SELECT cartela_id FROM room_cartelas WHERE room_id = $1 AND user_id = $2 ORDER BY cartela_id',
        [roomId, userId]
      );
      return {
        duplicate: true,
        room,
        wallet: walletResult.rows[0],
        cartelas: cartelasResult.rows.map(row => Number(row.cartela_id)),
      };
    }

    if (!['WAITING', 'COUNTDOWN'].includes(String(room.status))) {
      const error = new Error('ROOM_STARTED');
      error.code = room.status === 'FINISHED' ? 'GAME_FINISHED' : 'ROOM_STARTED';
      throw error;
    }

    const cartelaResult = await client.query(
      `SELECT * FROM room_cartelas
       WHERE room_id = $1 AND user_id = $2 AND cartela_id = $3
       FOR UPDATE`,
      [roomId, userId, Number(cartelaId)]
    );
    if (!cartelaResult.rows[0]) {
      const error = new Error('CARTELA_NOT_OWNED');
      error.code = 'CARTELA_NOT_OWNED';
      throw error;
    }

    const walletResult = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (!walletResult.rows[0]) {
      const error = new Error('WALLET_NOT_FOUND');
      error.code = 'WALLET_NOT_FOUND';
      throw error;
    }

    await client.query(
      'DELETE FROM room_cartelas WHERE room_id = $1 AND user_id = $2 AND cartela_id = $3',
      [roomId, userId, Number(cartelaId)]
    );

    const updatedWalletResult = await client.query(
      `UPDATE wallets
       SET balance = balance + $2,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, Number(stake)]
    );
    await client.query(
      `UPDATE users
       SET balance = balance + $2,
           play_balance = play_balance + $2,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, Number(stake)]
    );
    await client.query(
      `INSERT INTO transactions (user_id, tg_id, type, amount, status, reason, settlement_key, game_id, metadata, created_at)
       VALUES ($1, $2, 'GAME_STAKE_REFUND', $3, 'REFUNDED', 'CARTELA_DESELECT', $4, $5, $6::jsonb, NOW())`,
      [userId, String(tgId), Number(stake), settlementKey, String(roomId), JSON.stringify({ cartelaId: Number(cartelaId) })]
    );

    const cartelasResult = await client.query(
      `SELECT cartela_id FROM room_cartelas
       WHERE room_id = $1 AND user_id = $2
       ORDER BY cartela_id`,
      [roomId, userId]
    );
    const cartelas = cartelasResult.rows.map(row => Number(row.cartela_id));
    if (cartelas.length) {
      await client.query(
        `UPDATE room_players SET cartela_count = $3, tg_id = $4
         WHERE room_id = $1 AND user_id = $2`,
        [roomId, userId, cartelas.length, String(tgId)]
      );
    } else {
      await client.query(
        'DELETE FROM room_players WHERE room_id = $1 AND user_id = $2',
        [roomId, userId]
      );
    }

    const updatedRoomResult = await client.query(
      `UPDATE rooms
       SET status = CASE WHEN $2 = 0 THEN 'WAITING' ELSE status END,
           countdown_ends_at = CASE WHEN $2 = 0 THEN NULL ELSE countdown_ends_at END,
           pot = GREATEST(0, pot - $3),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [roomId, cartelas.length, Number(stake)]
    );

    return {
      duplicate: false,
      room: updatedRoomResult.rows[0],
      wallet: updatedWalletResult.rows[0],
      cartelas,
    };
  });
}

async function removeRoomCartela(roomId, cartelaId) {
  const result = await query(
    'DELETE FROM room_cartelas WHERE room_id = $1 AND cartela_id = $2 RETURNING *',
    [roomId, Number(cartelaId)]
  );

  return result.rows[0] || null;
}

async function addRoomCalledNumber({ roomId, number }) {
  const result = await query(
    `INSERT INTO room_called_numbers (room_id, number, created_at)
     VALUES ($1, $2, NOW())
     RETURNING *`,
    [roomId, Number(number)]
  );

  return result.rows[0];
}

async function getRoomCalledNumbers(roomId) {
  const result = await query(
    `SELECT number, created_at
     FROM room_called_numbers
     WHERE room_id = $1
     ORDER BY created_at ASC, id ASC`,
    [roomId]
  );

  return result.rows;
}

async function recordWinner({ roomId, userId, tgId, cartelaIds, patterns, prizeAmount }) {
  const result = await query(
    `INSERT INTO winners (room_id, user_id, tg_id, cartela_ids, patterns, prize_amount, settlement_key, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, NOW())
     RETURNING *`,
    [roomId, userId, String(tgId), JSON.stringify(cartelaIds || []), JSON.stringify(patterns || []), Number(prizeAmount), `${roomId}:${userId}:${Date.now()}`]
  );

  return result.rows[0];
}

async function appendGameHistory({ roomId = null, userId = null, tgId = null, result, prize = 0, stake = 0, pattern = null, cartelaIds = null }) {
  const resultRow = await query(
    `INSERT INTO game_history (room_id, user_id, tg_id, result, prize, stake, pattern, cartela_ids, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
     RETURNING *`,
    [roomId, userId, tgId ? String(tgId) : null, result, Number(prize), Number(stake), pattern, JSON.stringify(cartelaIds || null)]
  );

  return resultRow.rows[0];
}

async function getRoomPlayers(roomId) {
  const result = await query('SELECT * FROM room_players WHERE room_id = $1 ORDER BY joined_at ASC', [roomId]);
  return result.rows;
}

async function getRoomCartelas(roomId) {
  const result = await query('SELECT * FROM room_cartelas WHERE room_id = $1 ORDER BY cartela_id ASC', [roomId]);
  return result.rows;
}

function getLetterForNumber(number) {
  if (number <= 15) return 'B';
  if (number <= 30) return 'I';
  if (number <= 45) return 'N';
  if (number <= 60) return 'G';
  return 'O';
}

async function progressRoom(roomId) {
  if (!roomId) return null;

  return transactional(async (client) => {
    const roomResult = await client.query('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    const room = roomResult.rows[0];
    if (!room) return null;

    const logContext = {
      roomId: String(roomId),
      status: room.status,
      currentIndex: Number(room.current_index || 0),
    };
    console.log('[DB progression] locked room', JSON.stringify(logContext));

    let currentRoom = room;

    const reservationCount = Number((await client.query(
      'SELECT COUNT(*)::int AS count FROM room_cartelas WHERE room_id = $1',
      [roomId]
    )).rows[0].count || 0);

    if (['WAITING', 'COUNTDOWN'].includes(String(room.status || 'WAITING')) && room.countdown_ends_at) {
      const countdownExpired = await client.query(
        'SELECT $1::timestamptz <= CURRENT_TIMESTAMP AS expired',
        [room.countdown_ends_at]
      );
      if (countdownExpired.rows[0].expired) {
        if (reservationCount >= 3) {
          const started = await client.query(
            `UPDATE rooms
             SET status = 'RUNNING',
                 started_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [roomId]
          );
          currentRoom = started.rows[0] || currentRoom;
          console.log('[GAME_STATUS]', JSON.stringify({ roomId, oldStatus: room.status, newStatus: 'RUNNING', currentIndex: Number(currentRoom.current_index || 0), calledCount: 0, currentNumber: null, winnerReason: null, triggerSource: 'progressRoom:countdown' }));
        } else {
          const reset = await client.query(
            `UPDATE rooms
             SET status = 'WAITING',
                 countdown_seconds = 30,
                 countdown_ends_at = NOW() + INTERVAL '30 seconds',
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [roomId]
          );
          currentRoom = reset.rows[0] || currentRoom;
          console.log('[GAME_STATUS]', JSON.stringify({ roomId, oldStatus: room.status, newStatus: 'WAITING', currentIndex: Number(currentRoom.current_index || 0), calledCount: 0, currentNumber: null, winnerReason: 'countdown-expired-with-fewer-than-three-cartelas', triggerSource: 'progressRoom:countdown' }));
        }
      }
    }

    if (String(currentRoom.status || 'WAITING') === 'RUNNING') {
      let drawSequence = currentRoom.draw_sequence;
      if (typeof drawSequence === 'string') {
        try { drawSequence = JSON.parse(drawSequence); } catch (error) { drawSequence = []; }
      }
      if (!Array.isArray(drawSequence)) drawSequence = [];
      const nextIndex = Number(currentRoom.current_index || 0);
      const lastCalledResult = await client.query(
        `SELECT number, call_index, created_at
         FROM room_called_numbers
         WHERE room_id = $1
         ORDER BY call_index DESC, created_at DESC
         LIMIT 1`,
        [roomId]
      );
      const lastCalled = lastCalledResult.rows[0] || null;
      const dueResult = await client.query(
        lastCalled
          ? `SELECT $1::timestamptz <= CURRENT_TIMESTAMP - INTERVAL '4 seconds' AS due`
          : `SELECT $1::timestamptz <= CURRENT_TIMESTAMP - INTERVAL '800 milliseconds' AS due`,
        [lastCalled ? lastCalled.created_at : currentRoom.started_at]
      );

      if (drawSequence.length > 0 && nextIndex < drawSequence.length && dueResult.rows[0].due) {
        const number = Number(drawSequence[nextIndex]);
        if (Number.isFinite(number)) {
          const letter = getLetterForNumber(number);
          const inserted = await client.query(
            `INSERT INTO room_called_numbers (room_id, number, letter, call_index, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             RETURNING *`,
            [roomId, number, letter, nextIndex]
          );
          const afterCall = await client.query(
            `UPDATE rooms
             SET current_index = $2,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [roomId, nextIndex + 1]
          );
          currentRoom = afterCall.rows[0] || currentRoom;
          currentRoom.__lastInsertedNumber = inserted.rows[0];
          console.log('[DB progression] committed call', JSON.stringify({
            ...logContext,
            status: currentRoom.status,
            callIndex: nextIndex,
            number,
            persistedIndex: Number(currentRoom.current_index || 0),
            insertedId: inserted.rows[0]?.id || null,
          }));
        } else {
          console.error('[DB progression] invalid draw number', JSON.stringify({ ...logContext, callIndex: nextIndex, number }));
        }
      } else {
        console.log('[DB progression] no call due', JSON.stringify({
          ...logContext,
          status: currentRoom.status,
          sequenceLength: drawSequence.length,
          lastCall: lastCalled ? { number: lastCalled.number, callIndex: lastCalled.call_index, createdAt: lastCalled.created_at } : null,
          due: !!dueResult.rows[0].due,
        }));
      }

      if (drawSequence.length > 0 && Number(currentRoom.current_index || 0) >= drawSequence.length) {
        console.log('[GAME_STATUS]', JSON.stringify({ roomId, oldStatus: currentRoom.status, newStatus: 'FINISHED', currentIndex: Number(currentRoom.current_index || 0), calledCount: Number(currentRoom.current_index || 0), currentNumber: lastCalled?.number || null, winnerReason: 'draw-sequence-exhausted', triggerSource: 'progressRoom:sequence-exhausted' }));
        const finished = await client.query(
          `UPDATE rooms
           SET status = 'FINISHED',
               finished_at = NOW(),
               winner_ends_at = NOW() + INTERVAL '7 seconds',
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [roomId]
        );
        currentRoom = finished.rows[0] || currentRoom;
      }
    }

    return currentRoom;
  });
}

async function resetRoomDbState(roomId) {
  if (!roomId) return null;

  return transactional(async (client) => {
    await client.query('DELETE FROM room_called_numbers WHERE room_id = $1', [roomId]);
    await client.query('DELETE FROM room_cartelas WHERE room_id = $1', [roomId]);
    await client.query('DELETE FROM room_players WHERE room_id = $1', [roomId]);
    const updated = await client.query(
      `UPDATE rooms
       SET status = 'WAITING',
           pot = 0,
           current_index = 0,
           countdown_seconds = $2,
           started_at = NULL,
           finished_at = NULL,
           winner_ends_at = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [roomId, Number(30)]
    );
    return updated.rows[0] || null;
  });
}

module.exports = {
  createRoom,
  getRoomByCode,
  getActiveRoom,
  getRoomById,
  updateRoom,
  transitionRoomStatus,
  upsertRoomPlayer,
  removeRoomPlayer,
  addRoomCartela,
  reserveCartelaAtomic,
  releaseRoomCartelaAtomic,
  removeRoomCartela,
  addRoomCalledNumber,
  getRoomCalledNumbers,
  recordWinner,
  appendGameHistory,
  getRoomPlayers,
  getRoomCartelas,
  resetRoomDbState,
  progressRoom,
};
