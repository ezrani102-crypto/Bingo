const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureUserExistsByTgId,
  findOrCreateUserByTgId,
  getAvailableWalletBalance,
  getUserBalance,
  upsertUserWallet,
  reserveGameStake,
  releaseGameStake,
  creditWalletBalance,
  insertDepositIfMissing,
  insertWithdrawalIfMissing,
  settlePrizeIfMissing,
} = require('../database/finance');

const { query, execute, databaseConfigured, mysqlSql, placeholdersToMysql, prepareStatement } = require('../database/db');
const { createRoom, getRoomById, getRoomCalledNumbers, progressRoom, reserveCartelaAtomic, releaseRoomCartelaAtomic } = require('../database/rooms');

const hasDb = databaseConfigured;
const testPrefix = `test-${process.pid}-${Date.now()}-`;
const testId = (suffix) => `${testPrefix}${suffix}`;

async function cleanupFixtures() {
  if (!hasDb) return;
  const roomFilter = `(SELECT id FROM rooms WHERE room_code LIKE $1)`;
  const userFilter = `(SELECT id FROM users WHERE tg_id LIKE $1)`;
  await query(`DELETE FROM game_history WHERE room_id IN ${roomFilter} OR user_id IN ${userFilter} OR tg_id LIKE $1`, [`${testPrefix}%`]);
  await query(`DELETE FROM winners WHERE room_id IN ${roomFilter} OR user_id IN ${userFilter} OR tg_id LIKE $1`, [`${testPrefix}%`]);
  await query(`DELETE FROM room_called_numbers WHERE room_id IN ${roomFilter}`, [`${testPrefix}%`]);
  await query(`DELETE FROM room_cartelas WHERE room_id IN ${roomFilter} OR user_id IN ${userFilter} OR tg_id LIKE $1`, [`${testPrefix}%`]);
  await query(`DELETE FROM room_players WHERE room_id IN ${roomFilter} OR user_id IN ${userFilter} OR tg_id LIKE $1`, [`${testPrefix}%`]);
  await query('DELETE FROM rooms WHERE room_code LIKE $1', [`${testPrefix}%`]);
  await query('DELETE FROM withdrawals WHERE tg_id LIKE $1', [`${testPrefix}%`]);
  await query('DELETE FROM deposits WHERE tg_id LIKE $1', [`${testPrefix}%`]);
  await query('DELETE FROM transactions WHERE tg_id LIKE $1', [`${testPrefix}%`]);
  await query('DELETE FROM wallets WHERE user_id IN (SELECT id FROM users WHERE tg_id LIKE $1)', [`${testPrefix}%`]);
  await query('DELETE FROM users WHERE tg_id LIKE $1', [`${testPrefix}%`]);
}

test('database helpers are present and callable', async () => {
    assert.equal(typeof getAvailableWalletBalance, 'function');
  assert.equal(typeof ensureUserExistsByTgId, 'function');
  assert.equal(typeof findOrCreateUserByTgId, 'function');
  assert.equal(typeof getUserBalance, 'function');
  assert.equal(typeof upsertUserWallet, 'function');
  assert.equal(typeof reserveGameStake, 'function');
  assert.equal(typeof releaseGameStake, 'function');
  assert.equal(typeof creditWalletBalance, 'function');
  assert.equal(typeof insertDepositIfMissing, 'function');
  assert.equal(typeof insertWithdrawalIfMissing, 'function');
  assert.equal(typeof settlePrizeIfMissing, 'function');
});

test('available wallet balance matches the amount cartela purchase can spend', () => {
  assert.equal(getAvailableWalletBalance({ balance: '240.00', play_balance: '0.00', reserved_balance: '0.00' }), 240);
  assert.equal(getAvailableWalletBalance({ balance: '240.00', play_balance: '240.00', reserved_balance: '10.00' }), 230);
  assert.throws(() => getAvailableWalletBalance({ play_balance: '240.00', reserved_balance: '0.00' }), /incomplete/i);
});

test('TiDB query adapter converts PostgreSQL placeholders, casts, and intervals safely', () => {
  const placeholderResult = placeholdersToMysql('SELECT $2, $1, $2', ['first', 'second']);
  assert.equal(placeholderResult.statement, 'SELECT ?, ?, ?');
  assert.deepEqual(placeholderResult.params, ['second', 'first', 'second']);
  assert.equal(
    mysqlSql("SELECT $1::timestamptz <= CURRENT_TIMESTAMP - INTERVAL '800 milliseconds'"),
    'SELECT CAST($1 AS DATETIME(3)) <= CURRENT_TIMESTAMP - INTERVAL 800000 MICROSECOND'
  );
});

test('TiDB query adapter injects UUIDs and emulates insert RETURNING', () => {
  const prepared = prepareStatement(
    'INSERT INTO transactions (user_id, amount, metadata) VALUES ($1, $2, $3::jsonb) RETURNING *',
    ['user-1', 10, '{"source":"test"}']
  );
  assert.match(prepared.statement, new RegExp(`^INSERT INTO transactions \\(id, user_id, amount, metadata\\) VALUES \\('${prepared.insertId}', \\?, \\?, \\?\\)$`));
  assert.match(prepared.insertId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(prepared.params, ['user-1', 10, '{"source":"test"}']);
  assert.equal(prepared.returning, '*');
});

test('TiDB query adapter injects a UUID for each row in a multi-row insert', () => {
  const prepared = prepareStatement(
    'INSERT INTO room_called_numbers (room_id, number, letter) VALUES ($1, 1, $2), ($1, 2, $2), ($1, 3, $2)',
    ['room-1', 'B']
  );
  assert.equal(prepared.insertIds.length, 3);
  assert.equal((prepared.statement.match(/'[\da-f-]{36}'/gi) || []).length, 3);
  assert.deepEqual(prepared.params, ['room-1', 'B', 'room-1', 'B', 'room-1', 'B']);
});

test('TiDB query adapter emulates UPDATE RETURNING using selected row IDs', async () => {
  const calls = [];
  const client = {
    async query(statement, params) {
      calls.push({ statement, params });
      if (statement.startsWith('SELECT id FROM wallets')) return [[{ id: 'wallet-1' }], []];
      if (statement.startsWith('UPDATE wallets')) return [{ affectedRows: 1 }, []];
      if (statement.startsWith('SELECT * FROM wallets')) return [[{ id: 'wallet-1', balance: '25.00' }], []];
      throw new Error(`Unexpected SQL in adapter test: ${statement}`);
    },
  };

  const result = await execute(
    client,
    'UPDATE wallets SET balance = $1 WHERE user_id = $2 RETURNING *',
    ['25.00', 'user-1']
  );
  assert.deepEqual(result.rows, [{ id: 'wallet-1', balance: '25.00' }]);
  assert.equal(result.rowCount, 1);
  assert.deepEqual(calls.map(call => call.statement), [
    'SELECT id FROM wallets WHERE user_id = ?',
    'UPDATE wallets SET balance = ? WHERE user_id = ?',
    'SELECT * FROM wallets WHERE id IN (?)',
  ]);
  assert.deepEqual(calls.map(call => call.params), [
    ['user-1'],
    ['25.00', 'user-1'],
    ['wallet-1'],
  ]);
});

if (!hasDb) {
  test('DB integration tests skipped: a TiDB mysql:// URL is not configured', () => {
    assert.ok(true);
  });
} else {
  test('user creation and balance retrieval work with TiDB', async () => {
    await cleanupFixtures();
    const tgId = testId('user-1001');

    const created = await findOrCreateUserByTgId({ tgId, firstName: 'Test', lastName: 'User', username: 'tester' });
    assert.equal(created.created, true);

    const user = await ensureUserExistsByTgId(tgId);
    assert.ok(user);
    assert.equal(user.tg_id, tgId);

    const wallet = await getUserBalance(tgId);
    assert.ok(wallet);
    assert.equal(Number(wallet.balance), 0);
    assert.equal(Number(wallet.play_balance), 0);
  });

  test('an existing zero wallet is not re-credited from the legacy users balance mirror', async () => {
    const tgId = testId('legacy-wallet-mirror');
    const user = await findOrCreateUserByTgId({ tgId, firstName: 'Legacy', lastName: 'Mirror', username: 'legacymirror' });
    const wallet = await getUserBalance(tgId);
    assert.equal(Number(wallet.balance), 0);

    await query('UPDATE users SET balance = 75 WHERE id = $1', [user.user.id]);
    const reread = await getUserBalance(tgId);
    assert.equal(Number(reread.balance), 0);
  });

  test('deposit recording and duplicate prevention work', async () => {
    const tgId = testId('user-1002');
    const user = await findOrCreateUserByTgId({ tgId, firstName: 'Tester', lastName: 'Two', username: 'tester2' });
    assert.ok(user.user);

    const reference = testId('deposit-reference');
    const first = await insertDepositIfMissing({ userId: user.user.id, tgId, amount: 100, method: 'Telebirr', reference });
    assert.equal(first.duplicate, false);

    const second = await insertDepositIfMissing({ userId: user.user.id, tgId, amount: 100, method: 'Telebirr', reference });
    assert.equal(second.duplicate, true);
  });

  test('atomic wallet debit and insufficient balance are rejected', async () => {
    const tgId = testId('user-1003');
    const user = await findOrCreateUserByTgId({ tgId, firstName: 'Tester', lastName: 'Three', username: 'tester3' });

    await upsertUserWallet(user.user.id, { balance: 0, play_balance: 0, reserved_balance: 0 }, {
      balance: 50,
      play_balance: 50,
      reserved_balance: 0,
    });

    const reserved = await reserveGameStake({ userId: user.user.id, amount: 10, reason: 'TEST_STAKE' });
    assert.ok(reserved.wallet);

    await assert.rejects(async () => {
      await reserveGameStake({ userId: user.user.id, amount: 1000, reason: 'TEST_STAKE_FAIL' });
    });

    const refund = await releaseGameStake({ userId: user.user.id, amount: 10, reason: 'TEST_REFUND' });
    assert.ok(refund.wallet);
  });

  test('wallet credit and prize settlement are idempotent-safe', async () => {
    const tgId = testId('user-1004');
    const user = await findOrCreateUserByTgId({ tgId, firstName: 'Tester', lastName: 'Four', username: 'tester4' });

    await upsertUserWallet(user.user.id, { balance: 0, play_balance: 0, reserved_balance: 0 }, {
      balance: 0,
      play_balance: 0,
      reserved_balance: 0,
    });

    const credited = await creditWalletBalance({ userId: user.user.id, amount: 25, reason: 'TEST_CREDIT' });
    assert.ok(credited.wallet);

    const settlementKey = testId('settlement');
    const prize = await settlePrizeIfMissing({ userId: user.user.id, tgId, gameId: testId('game-1'), settlementKey, amount: 25 });
    assert.ok(prize.record);

    const dup = await settlePrizeIfMissing({ userId: user.user.id, tgId, gameId: testId('game-2'), settlementKey, amount: 25 });
    assert.equal(dup.duplicate, true);
  });

  test('cartela purchases debit authoritative wallet balance and enforce two-card limit', async () => {
    const tgId = testId('cartela-wallet');
    const user = await findOrCreateUserByTgId({ tgId, firstName: 'Cartela', lastName: 'Wallet', username: 'cartelawallet' });
    await upsertUserWallet(user.user.id, { balance: 0, play_balance: 0, reserved_balance: 0 }, {
      balance: 242,
      play_balance: 0,
      reserved_balance: 0,
    });
    const room = await createRoom({ roomCode: testId('cartela-room'), status: 'WAITING', stake: 10, capacity: 20, drawSequence: Array.from({ length: 75 }, (_, index) => index + 1) });
    const card = (id) => ({ id: `#${String(id).padStart(2, '0')}`, matrix: [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13, 14, 15], [16, 17, 18, 19, 20], [21, 22, 23, 24, 25]], marked: [] });

    const first = await reserveCartelaAtomic({ roomId: room.id, userId: user.user.id, tgId, cartelaId: 13, card: card(13), stake: 10 });
    assert.equal(Number(first.wallet.balance), 232);
    const second = await reserveCartelaAtomic({ roomId: room.id, userId: user.user.id, tgId, cartelaId: 14, card: card(14), stake: 10 });
    assert.equal(Number(second.wallet.balance), 222);
    await assert.rejects(
      reserveCartelaAtomic({ roomId: room.id, userId: user.user.id, tgId, cartelaId: 15, card: card(15), stake: 10 }),
      (error) => error.code === 'MAX_CARTELAS_REACHED'
    );
  });

  test('cartela deselection refunds once and repeated requests remain idempotent', async () => {
    const tgId = testId('cartela-refund');
    const user = await findOrCreateUserByTgId({ tgId, firstName: 'Cartela', lastName: 'Refund', username: 'cartelarefund' });
    await upsertUserWallet(user.user.id, { balance: 0, play_balance: 0, reserved_balance: 0 }, {
      balance: 240,
      play_balance: 240,
      reserved_balance: 0,
    });
    const room = await createRoom({
      roomCode: testId('cartela-refund-room'),
      status: 'WAITING',
      stake: 10,
      capacity: 20,
      drawSequence: Array.from({ length: 75 }, (_, index) => index + 1),
    });
    const card = { id: '#16', matrix: [[1, 2, 3, 4, 5]], marked: [] };

    const reservation = await reserveCartelaAtomic({
      roomId: room.id, userId: user.user.id, tgId, cartelaId: 16, card, stake: 10,
    });
    assert.equal(Number(reservation.wallet.balance), 230);

    const refund = await releaseRoomCartelaAtomic({
      roomId: room.id, userId: user.user.id, tgId, cartelaId: 16, stake: 10, idempotencyKey: 'refund-1',
    });
    assert.equal(refund.duplicate, false);
    assert.equal(Number(refund.wallet.balance), 240);
    assert.equal(Number(refund.wallet.play_balance), 240);
    assert.deepEqual(refund.cartelas, []);

    const repeated = await releaseRoomCartelaAtomic({
      roomId: room.id, userId: user.user.id, tgId, cartelaId: 16, stake: 10, idempotencyKey: 'refund-1',
    });
    assert.equal(repeated.duplicate, true);
    assert.equal(Number(repeated.wallet.balance), 240);
    assert.deepEqual(repeated.cartelas, []);
  });

  test('countdown recovery transitions a waiting room after expiry', async () => {
    const user = await findOrCreateUserByTgId({
      tgId: testId('user-countdown-1'),
      firstName: 'Countdown',
      lastName: 'Tester',
      username: 'countdowntester',
    });

    const room = await createRoom({
      roomCode: testId('countdown-room'),
      status: 'WAITING',
      stake: 10,
      capacity: 20,
      pot: 0,
      currentIndex: 0,
      countdownSeconds: 30,
      drawSequence: [1, 2, 3, 4, 5, 6, 7],
    });

    const cardTemplate = JSON.stringify({
      id: '#01',
      matrix: [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5]],
      marked: [[false, false, false, false, false], [false, false, false, false, false], [false, false, false, false, false], [false, false, false, false, false], [false, false, false, false, false]],
    });

    const userId = user.user.id;
    await query(
      `INSERT INTO room_cartelas (room_id, user_id, tg_id, cartela_id, card, reserved_at)
       VALUES ($1, $2, $3, 1, $4::jsonb, NOW()), ($1, $2, $3, 2, $4::jsonb, NOW()), ($1, $2, $3, 3, $4::jsonb, NOW())`,
      [room.id, userId, testId('user-countdown-1'), cardTemplate]
    );

    await query(
      `UPDATE rooms
       SET countdown_ends_at = NOW() - INTERVAL '1 second', updated_at = NOW()
       WHERE id = $1`,
      [room.id]
    );

    const progressed = await progressRoom(room.id);
    assert.ok(progressed);
    assert.equal(String(progressed.status), 'RUNNING');
  });

  test('number progression advances exactly one call once per due window', async () => {
    const room = await createRoom({
      roomCode: testId('progress-room'),
      status: 'RUNNING',
      stake: 10,
      capacity: 20,
      pot: 100,
      currentIndex: 0,
      countdownSeconds: 30,
      drawSequence: [11, 22, 33, 44],
    });

    await query(
      `UPDATE rooms
       SET started_at = NOW() - INTERVAL '10 seconds', updated_at = NOW()
       WHERE id = $1`,
      [room.id]
    );

    const first = await progressRoom(room.id);
    const second = await progressRoom(room.id);
    const called = await getRoomCalledNumbers(room.id);

    assert.ok(first);
    assert.ok(second);
    assert.equal(called.length, 1);
    assert.equal(Number(first.current_index || 0), 1);
  });

  test('concurrent progression does not duplicate the same next number', async () => {
    const room = await createRoom({
      roomCode: testId('concurrent-room'),
      status: 'RUNNING',
      stake: 10,
      capacity: 20,
      pot: 100,
      currentIndex: 0,
      countdownSeconds: 30,
      drawSequence: [7, 8, 9, 10],
    });

    await query(
      `UPDATE rooms
       SET started_at = NOW() - INTERVAL '10 seconds', updated_at = NOW()
       WHERE id = $1`,
      [room.id]
    );

    await Promise.all([progressRoom(room.id), progressRoom(room.id)]);
    const called = await getRoomCalledNumbers(room.id);
    assert.equal(called.length, 1);
    const refreshed = await getRoomById(room.id);
    assert.equal(Number(refreshed.current_index), 1);
  });
}
