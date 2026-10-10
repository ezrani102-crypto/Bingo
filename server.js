/**
 * SHISHO BINGO — ONE-FILE TELEGRAM BOT + MINI APP
 * v38 — Mobile audio, server-timeline sync, all bot buttons, Wallet split,
 *       Ranks removed, full deposit/withdraw flows with Name field.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const url = require('url');

const { query, transactional, pool, healthCheck, databaseConfigured } = require('./database/db');
const DATABASE_ENABLED = Boolean(process.env.TIDB_DATABASE_URL || process.env.DATABASE_URL);

const {
  createRoom,
  updateRoom,
  transitionRoomStatus,
  getRoomById,
  getActiveRoom,
  getRoomCalledNumbers,
  upsertRoomPlayer,
  removeRoomPlayer,
  addRoomCartela,
  reserveCartelaAtomic,
  releaseRoomCartelaAtomic,
  removeRoomCartela,
  appendGameHistory,
  recordWinner,
  getRoomPlayers,
  getRoomCartelas,
  resetRoomDbState,
  progressRoom,
} = require('./database/rooms');

const { findOrCreateUserByTgId, ensureUserExistsByTgId, getUserBalance, getAvailableWalletBalance, creditWalletBalance, insertDepositIfMissing, approveDepositIfPending, updateUserProfile, settlePrizeIfMissing } = require('./database/finance');

function resolveBaseUrl() {
  const candidates = [
    process.env.BASE_URL,
    process.env.PUBLIC_URL,
    process.env.APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
    process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : '',
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '',
  ];
  const value = candidates.find(candidate => typeof candidate === 'string' && candidate.trim());
  return String(value || '').trim().replace(/\/$/, '');
}

const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  ADMIN_TELEGRAM_ID: '7336477309',
  PORT: Number(process.env.PORT || 3000),
  BASE_URL: resolveBaseUrl(),
  CHANNEL_URL: process.env.CHANNEL_URL || 'https://t.me/shishobingo',
  SUPPORT_USERNAME: process.env.SUPPORT_USERNAME || '@bigbards',
  STAKE_PRICE: 10,
  MAX_CARTELAS_PER_PLAYER: 2,
  MAX_ROOM_CAPACITY: 20,
  HOUSE_FEE_PERCENT: 0.20,
  MIN_WITHDRAWAL: 50,
  MIN_RESERVE_BALANCE: 10,
  BALL_INTERVAL_MS: 4000,
  COUNTDOWN_SECONDS: 30,
  WINNER_DISPLAY_MS: 7000,
  IDEMPOTENCY_TTL_MS: 60000,
  WINNER_REPLAY_GRACE_MS: 2000,
  // Deposit payment instructions (edit to your real numbers)
  TELEBIRR_NUMBER: process.env.TELEBIRR_NUMBER || '+251900000000',
  CBE_ACCOUNT: process.env.CBE_ACCOUNT || '1000000000000',
};

if (!CONFIG.BOT_TOKEN) console.warn('⚠️ BOT_TOKEN not set.');

// ---------------------------------------------------------------------------
// DATA STORE
// ---------------------------------------------------------------------------
const DB = {
  users: new Map(),
  transactions: [],
  deposits: new Map(),
  withdrawals: new Map(),
  gameHistory: [],
  userGameHistory: new Map(),
  idempotency: new Map(),
  promotions: [],
};

const BOT_TRANSLATIONS = {
  am: {
    '🎮 Play': '🎮 ጨዋታ', '💰 Balance': '💰 ሂሳብ', '👤 Profile': '👤 መገለጫ',
    '💳 Deposit': '💳 ገንዘብ ያስገቡ', '💸 Withdraw': '💸 ገንዘብ ያውጡ',
    '🔗 Invite': '🔗 ጋብዝ', '💬 Support': '💬 ድጋፍ', '📢 Channel': '📢 ቻናል',
    '🌐 Language': '🌐 ቋንቋ', '👑 Admin Dashboard': '👑 የአስተዳዳሪ ዳሽቦርድ',
    'Your Wallet': 'የእርስዎ ቦርሳ', 'Available:': 'የሚገኝ:', 'Reserved:': 'የተያዘ:', 'Total:': 'ጠቅላላ:',
    'Your Profile': 'መገለጫዎ', 'Name:': 'ስም:', 'Username:': 'የተጠቃሚ ስም:', 'Games:': 'ጨዋታዎች:',
    'Wins:': 'ድሎች:', 'Winnings:': 'ያገኙት:', 'Balance:': 'ቀሪ ሂሳብ:',
    'Tap to open the game:': '🎯 ጨዋታውን ለመክፈት ይንኩ:', '🎮 Open Game': '🎮 ጨዋታ ክፈት',
    'Choose your language / ቋንቋዎን ይምረጡ:': '🌐 ቋንቋዎን ይምረጡ / Choose your language:',
    'Deposit': 'ገንዘብ ማስገባት', 'Withdraw': 'ገንዘብ ማውጣት', 'Choose payment method:': 'የክፍያ ዘዴ ይምረጡ:',
    'Choose withdrawal method:': 'የማውጣት ዘዴ ይምረጡ:', 'Enter the amount in BIRR (e.g. 100):': 'መጠኑን በብር ያስገቡ (ምሳሌ 100):',
    'Enter a valid deposit amount.': 'ትክክለኛ የማስገቢያ መጠን ያስገቡ።', 'Choose Telebirr or CBE.': 'ተለብር ወይም CBE ይምረጡ።',
    'Transaction reference is required.': 'የግብይት ማጣቀሻ ያስፈልጋል።', 'Cancel': 'ሰርዝ', 'Cancelled.': 'ተሰርዟል።',
    'Enter a valid amount.': 'ትክክለኛ መጠን ያስገቡ።', 'Please answer the current step or tap Cancel.': 'የአሁኑን እርምጃ ይመልሱ ወይም ሰርዝ ይጫኑ።',
    'This deposit has already been processed.': 'ይህ ማስገባት አስቀድሞ ተሰርቷል።', 'This withdrawal has already been processed.': 'ይህ ማውጣት አስቀድሞ ተሰርቷል።',
    'Your language has been set to Amharic.': 'ቋንቋዎ ወደ አማርኛ ተቀይሯል።', 'Language set to English.': 'ቋንቋ ወደ እንግሊዝኛ ተቀይሯል።',
    'Phone verified!': 'ስልክዎ ተረጋግጧል!', 'Please share your phone number first using /start.': 'እባክዎ መጀመሪያ /start በመጠቀም ስልክዎን ያጋሩ።',
    'Welcome back,': 'እንኳን ደህና መጡ፣', 'Your Wallet': 'የእርስዎ ቦርሳ', 'Minimum withdrawal is': 'ዝቅተኛው የማውጣት መጠን',
    'You can withdraw at most': 'ከፍተኛውን ማውጣት የሚችሉት', 'full name': 'ሙሉ ስም', 'Now send the': 'አሁን ይላኩ',
    'Withdrawal submitted': 'ማውጣት ተልኳል', 'Deposit submitted': 'ማስገባት ተልኳል', 'Balance will be credited after admin approval.': 'አስተዳዳሪው ካጸደቀ በኋላ ቀሪ ሂሳብዎ ይሞላል።',
    'Reserved until admin pays.': 'አስተዳዳሪው እስኪከፍል ድረስ ተይዟል።', 'Insufficient balance.': 'በቂ ቀሪ ሂሳብ የለም።',
    'Choose an option below.': 'ከታች አንዱን ይምረጡ።', 'Official Channel': 'ኦፊሴላዊ ቻናል', 'Support': 'ድጋፍ',
  },
};

function botText(tgId, text) {
  const user = DB.users.get(String(tgId));
  if (!user || user.language !== 'am') return text;
  let result = String(text);
  const replacements = BOT_TRANSLATIONS.am;
  Object.keys(replacements).sort((a, b) => b.length - a.length).forEach(key => {
    result = result.split(key).join(replacements[key]);
  });
  return result;
}

const DATA_FILE = path.join(__dirname, 'shisho_bingo_data.json');
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify({
        users: [...DB.users.values()],
        transactions: DB.transactions.slice(0, 5000),
        deposits: [...DB.deposits.entries()].slice(-500),
        withdrawals: [...DB.withdrawals.entries()].slice(-500),
        gameHistory: DB.gameHistory.slice(0, 2000),
        userGameHistory: [...DB.userGameHistory.entries()],
        promotions: DB.promotions.slice(-200),
      }, null, 2), 'utf8');
    } catch (e) { console.error('DB save error:', e.message); }
  }, 80);
}
function loadDB() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const payload = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const u of payload.users || []) DB.users.set(String(u.tgId), u);
    DB.transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
    DB.deposits = new Map(payload.deposits || []);
    DB.withdrawals = new Map(payload.withdrawals || []);
    DB.gameHistory = Array.isArray(payload.gameHistory) ? payload.gameHistory : [];
    DB.userGameHistory = new Map(payload.userGameHistory || []);
    DB.promotions = Array.isArray(payload.promotions) ? payload.promotions : [];
    console.log(`💾 Loaded ${DB.users.size} users.`);
  } catch (e) { console.error('DB load error:', e.message); }
}
function addGameHistory(entry) {
  DB.gameHistory.unshift(entry);
  const key = String(entry.tgId);
  if (!DB.userGameHistory.has(key)) DB.userGameHistory.set(key, []);
  DB.userGameHistory.get(key).unshift(entry);
  if (DB.userGameHistory.get(key).length > 200) DB.userGameHistory.get(key).length = 200;

  if (DATABASE_ENABLED) {
    void appendGameHistory({
      roomId: entry.roomId || null,
      userId: entry.userId || null,
      tgId: entry.tgId || null,
      result: entry.result || 'LOSS',
      prize: Number(entry.prize || 0),
      stake: Number(entry.stake || 0),
      pattern: entry.pattern || null,
      cartelaIds: Array.isArray(entry.cartelaIds) ? entry.cartelaIds : (entry.cardId ? String(entry.cardId).split(',').map(s => s.trim()).filter(Boolean) : null),
    }).catch(err => console.warn('[gameHistory:db] failed:', err.message));
  }

  saveDB();
}
function money(n) { return Math.round(Number(n || 0) * 100) / 100; }

loadDB();

// ---------------------------------------------------------------------------
// IDEMPOTENCY
// ---------------------------------------------------------------------------
function checkIdempotency(key) {
  if (!key) return null;
  const entry = DB.idempotency.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CONFIG.IDEMPOTENCY_TTL_MS) {
    DB.idempotency.delete(key);
    return null;
  }
  return entry.response;
}
function setIdempotency(key, response) {
  if (!key) return;
  DB.idempotency.set(key, { ts: Date.now(), response });
  if (DB.idempotency.size > 1000) {
    const cutoff = Date.now() - CONFIG.IDEMPOTENCY_TTL_MS;
    for (const [k, v] of DB.idempotency) {
      if (v.ts < cutoff) DB.idempotency.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// ATOMIC WALLET OPERATIONS
// ---------------------------------------------------------------------------
function syncAvailableWallet(user) {
  const mainBalance = Number(user.balance ?? 0);
  const playBalance = Number(user.playBalance ?? 0);
  const reserved = Math.max(0, Number(user.reservedBalance ?? 0));
  const walletFromMain = Number.isFinite(mainBalance) ? Math.max(0, mainBalance) : 0;
  const walletFromPlay = Number.isFinite(playBalance) ? Math.max(0, playBalance) + reserved : 0;
  const wallet = Math.max(walletFromMain, walletFromPlay);
  const available = getAvailableWalletBalance({ balance: wallet, reservedBalance: reserved });
  if (Number(user.reservedBalance) !== reserved) user.reservedBalance = money(reserved);
  if (Number(user.balance) !== Number(wallet)) user.balance = money(wallet);
  if (Number(user.playBalance) !== Number(available)) user.playBalance = available;
  return available;
}

function walletLogId(tgId) {
  const value = String(tgId);
  return process.env.WALLET_DEBUG_LOG_IDS === '1'
    ? value
    : crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function isDatabaseUnavailable(error) {
  const code = String(error?.code || '');
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'ENOTFOUND', 'EHOSTUNREACH', '57P01', '57P03', '08000', '08003', '08006'].includes(code)
    || /connection (terminated|timeout|refused)|timeout expired|server closed the connection/i.test(String(error?.message || ''));
}

function assertDatabaseConfigured() {
  if (process.env.VERCEL && !databaseConfigured) {
    const error = new Error('DATABASE_UNAVAILABLE');
    error.code = 'DATABASE_UNAVAILABLE';
    throw error;
  }
}

function logWalletDebug(label, tgId, details) {
  if (process.env.WALLET_DEBUG !== '1') return;
  console.log(label, JSON.stringify({ telegramId: walletLogId(tgId), ...details }));
}

function tryReserveStake(user, cartelaId, reason) {
  syncAvailableWallet(user);
  if (user.playBalance < CONFIG.STAKE_PRICE) return false;
  user.playBalance = money(user.playBalance - CONFIG.STAKE_PRICE);
  user.reservedBalance = money((user.reservedBalance || 0) + CONFIG.STAKE_PRICE);
  DB.transactions.unshift({
    id: crypto.randomUUID(), tgId: user.tgId, type: 'GAME_STAKE',
    amount: CONFIG.STAKE_PRICE, status: 'RESERVED',
    cartelaId, reason, createdAt: new Date().toISOString(),
  });
  saveDB();
  return true;
}

function refundStake(user, cartelaId, reason) {
  user.playBalance = money(user.playBalance + CONFIG.STAKE_PRICE);
  user.reservedBalance = money(Math.max(0, (user.reservedBalance || 0) - CONFIG.STAKE_PRICE));
  DB.transactions.unshift({
    id: crypto.randomUUID(), tgId: user.tgId, type: 'GAME_STAKE_REFUND',
    amount: CONFIG.STAKE_PRICE, status: 'REFUNDED',
    cartelaId, reason, createdAt: new Date().toISOString(),
  });
  saveDB();
}

function creditPrize(user, amount, reason, metadata = {}) {
  user.balance = money(user.balance + amount);
  user.playBalance = money(user.playBalance + amount);
  DB.transactions.unshift({
    id: crypto.randomUUID(), tgId: user.tgId, type: 'GAME_PRIZE',
    amount, reason, ...metadata, createdAt: new Date().toISOString(),
  });
  saveDB();
}

function consumeReservedStake(user, amount) {
  user.reservedBalance = money(Math.max(0, (user.reservedBalance || 0) - amount));
  saveDB();
}

function getOrCreateUser(tgId, from = {}) {
  const idStr = String(tgId);
  let user = DB.users.get(idStr);
  if (!user) {
    user = {
      id: crypto.randomUUID(), tgId: idStr,
      firstName: from.first_name || 'Player',
      lastName: from.last_name || '',
      username: from.username || '',
      phone: null, balance: 0, playBalance: 0, reservedBalance: 0,
      gamesPlayed: 0, totalWins: 0, totalWinnings: 0,
      cartelasPurchased: 0, referralEarnings: 0,
      registrationBonusGranted: false, referralBonusGranted: false,
      referredBy: null, registeredAt: new Date().toISOString(),
      isRegistered: false,
      language: 'am',
      settings: { audio: true, vibration: true, autoMark: true },
    };
    DB.users.set(idStr, user);
  } else {
    let migrated = false;
    if (from.first_name) user.firstName = from.first_name;
    if (from.last_name !== undefined) user.lastName = from.last_name || '';
    if (from.username !== undefined) user.username = from.username || '';
    if (!user.language) {
      user.language = user.settings?.language === 'en' ? 'en' : 'am';
      migrated = true;
    }
    if (user.language !== 'en' && user.language !== 'am') { user.language = 'am'; migrated = true; }
    if (!user.settings) { user.settings = { audio: true, vibration: true, autoMark: true }; migrated = true; }
    user.settings.autoMark = true;
    if (user.settings.language !== undefined) { delete user.settings.language; migrated = true; }
    if (migrated) saveDB();
  }
  syncAvailableWallet(user);
  return user;
}

// ---------------------------------------------------------------------------
// BINGO ENGINE
// ---------------------------------------------------------------------------
class ProvablyFairBingo {
  static generateSealedGame() {
    const sequence = Array.from({ length: 75 }, (_, i) => i + 1);
    const secretSeed = crypto.randomBytes(32).toString('hex');
    for (let i = sequence.length - 1; i > 0; i--) {
      const randomIndex = crypto.randomInt(i + 1);
      [sequence[i], sequence[randomIndex]] = [sequence[randomIndex], sequence[i]];
    }
    const hashCommitment = crypto.createHash('sha256')
      .update(`${secretSeed}:${JSON.stringify(sequence)}`).digest('hex');
    return { secretSeed, hashCommitment, drawSequence: sequence };
  }
}

class BingoEngine {
  static generateCartela(cartelaId, userId) {
    const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
    const columns = [];
    for (const [min, max] of ranges) {
      const pool = [];
      for (let n = min; n <= max; n++) pool.push(n);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      columns.push(pool.slice(0, 5));
    }
    const matrix = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, c) => columns[c][r]));
    matrix[2][2] = 0;
    return {
      id: `#${String(cartelaId).padStart(2, '0')}`,
      userId: String(userId),
      matrix,
      marked: Array.from({ length: 5 }, (_, r) =>
        Array.from({ length: 5 }, (_, c) => r === 2 && c === 2)),
    };
  }

  static markNumber(cartela, number) {
    cartela.marked[2][2] = true;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (cartela.matrix[r][c] === number) cartela.marked[r][c] = true;
      }
    }
  }

  static rebuildMarked(cartela, calledNumbers) {
    cartela.marked = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, c) => r === 2 && c === 2));
    for (const n of calledNumbers) this.markNumber(cartela, n);
  }

  static checkWinningPatterns(cartela) {
    const m = cartela.marked;
    m[2][2] = true;
    for (let r = 0; r < 5; r++) if (m[r].every(Boolean)) return { won: true, pattern: `Row ${r + 1}` };
    for (let c = 0; c < 5; c++) {
      let won = true;
      for (let r = 0; r < 5; r++) if (!m[r][c]) won = false;
      if (won) return { won: true, pattern: `Column ${'BINGO'[c]}` };
    }
    let d1 = true, d2 = true;
    for (let i = 0; i < 5; i++) {
      if (!m[i][i]) d1 = false;
      if (!m[i][4 - i]) d2 = false;
    }
    if (d1) return { won: true, pattern: 'Diagonal \\' };
    if (d2) return { won: true, pattern: 'Diagonal /' };
    if (m[0][0] && m[0][4] && m[4][0] && m[4][4]) return { won: true, pattern: 'Four Corners' };
    return { won: false, pattern: null };
  }

  static letterForNumber(number) {
    if (number <= 15) return 'B';
    if (number <= 30) return 'I';
    if (number <= 45) return 'N';
    if (number <= 60) return 'G';
    return 'O';
  }
}

// ---------------------------------------------------------------------------
// ROOM MANAGER — server-authoritative, mobile-safe
// ---------------------------------------------------------------------------
class RoomManager {
  constructor() {
    this.clients = new Set();
    this.lastFinishedEvent = null;
    this.lastFinishedAt = 0;
    this.lastFinishedGameId = null;
    this.initRoom();
  }

  initRoom() {
    if (this.callTimer) { clearInterval(this.callTimer); this.callTimer = null; }
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    if (this.newRoomTimer) { clearTimeout(this.newRoomTimer); this.newRoomTimer = null; }
    if (this.firstBallTimer) { clearTimeout(this.firstBallTimer); this.firstBallTimer = null; }

    const sealed = ProvablyFairBingo.generateSealedGame();
    const now = Date.now();
    this.room = {
      id: '1024',
      status: 'WAITING',
      stake: CONFIG.STAKE_PRICE,
      capacity: CONFIG.MAX_ROOM_CAPACITY,
      players: new Map(),
      reservations: new Map(),
      pot: 0,
      drawSequence: sealed.drawSequence,
      secretSeed: sealed.secretSeed,
      hashCommitment: sealed.hashCommitment,
      calledNumbers: [],
      currentIndex: 0,
      lastCallAt: null,
      nextCallAt: null,
      countdown: CONFIG.COUNTDOWN_SECONDS,
      countdownUpdatedAt: now,
      countdownEndsAt: now + CONFIG.COUNTDOWN_SECONDS * 1000,
      winners: [],
      winnerCards: [],
      winnerEndsAt: null,
      startedAt: null,
      finishedAt: null,
      dbId: null,
      _settled: false,
      _ballDrawInProgress: false,
      _starting: false,
      dbFailure: null,
    };
    // In production, countdown and progression are advanced by /api/state.
    // Keep the timer only for the file-backed local compatibility mode.
    if (!DATABASE_ENABLED) this.countdownTimer = setInterval(() => this.tickCountdown(), 250);
    void this.restoreActiveRoomFromDb().catch(() => {});
  }

  async restoreActiveRoomFromDb() {
    if (!DATABASE_ENABLED) {
      await this.persistRoomState();
      return;
    }

    try {
      const dbRoom = await getActiveRoom();
      if (!dbRoom) {
        await this.persistRoomState();
        return;
      }

      const calledNumbers = await getRoomCalledNumbers(dbRoom.id);
      const lastCalled = calledNumbers.length ? calledNumbers[calledNumbers.length - 1] : null;
      const roomPlayers = await getRoomPlayers(dbRoom.id);
      const roomCartelas = await getRoomCartelas(dbRoom.id);

      const players = new Map();
      const reservations = new Map();
      const cardByUser = new Map();

      for (const row of roomCartelas) {
        const card = row.card && typeof row.card === 'object' ? row.card : null;
        if (!card) continue;
        const tgId = String(row.tg_id || '');
        const user = DB.users.get(tgId) || getOrCreateUser(tgId, {});
        const entry = { tgId, user, card, selectedAt: Date.now() };
        if (row.user_id && String(row.user_id) === String(user.id || row.user_id)) {
          cardByUser.set(tgId, (cardByUser.get(tgId) || [])).push(card);
        }
        if (String(dbRoom.status) === 'RUNNING') {
          const player = players.get(tgId) || { user, cartelas: [], claimAttempts: 0 };
          player.cartelas.push(card);
          players.set(tgId, player);
        } else {
          reservations.set(Number(row.cartela_id), entry);
        }
      }

      for (const row of roomPlayers) {
        const tgId = String(row.tg_id || '');
        const user = DB.users.get(tgId) || getOrCreateUser(tgId, {});
        if (String(dbRoom.status) === 'RUNNING') {
          const existing = players.get(tgId) || { user, cartelas: [], claimAttempts: Number(row.claim_attempts || 0) };
          existing.claimAttempts = Number(row.claim_attempts || 0);
          if (!existing.cartelas.length) {
            const userCards = roomCartelas.filter(item => String(item.tg_id) === tgId).map(item => item.card).filter(Boolean);
            existing.cartelas.push(...userCards);
          }
          players.set(tgId, existing);
        }
      }

      this.room = {
        id: String(dbRoom.room_code || dbRoom.id || '1024'),
        status: String(dbRoom.status || 'WAITING'),
        stake: Number(dbRoom.stake || CONFIG.STAKE_PRICE),
        capacity: Number(dbRoom.capacity || CONFIG.MAX_ROOM_CAPACITY),
        players,
        reservations,
        pot: Number(dbRoom.pot || 0),
        drawSequence: Array.isArray(dbRoom.draw_sequence) ? dbRoom.draw_sequence : (this.room?.drawSequence || ProvablyFairBingo.generateSealedGame().drawSequence),
        secretSeed: dbRoom.secret_seed || this.room?.secretSeed || null,
        hashCommitment: dbRoom.hash_commitment || this.room?.hashCommitment || null,
        calledNumbers: (calledNumbers || []).map(n => Number(n.number)).filter(Number.isFinite),
        currentIndex: Number(dbRoom.current_index || (calledNumbers || []).length || 0),
        lastCallAt: lastCalled?.created_at ? Date.parse(lastCalled.created_at) : null,
        nextCallAt: lastCalled?.created_at ? Date.parse(lastCalled.created_at) + CONFIG.BALL_INTERVAL_MS : null,
        countdown: Number(dbRoom.countdown_seconds || CONFIG.COUNTDOWN_SECONDS),
        countdownUpdatedAt: Date.now(),
        countdownEndsAt: dbRoom.countdown_ends_at ? Date.parse(dbRoom.countdown_ends_at) : (Date.now() + (Number(dbRoom.countdown_seconds || CONFIG.COUNTDOWN_SECONDS) * 1000)),
        winners: [],
        winnerCards: [],
        winnerEndsAt: dbRoom.winner_ends_at ? Date.parse(dbRoom.winner_ends_at) : null,
        startedAt: dbRoom.started_at ? Date.parse(dbRoom.started_at) : null,
        finishedAt: dbRoom.finished_at ? Date.parse(dbRoom.finished_at) : null,
        dbId: dbRoom.id,
        _settled: String(dbRoom.status) === 'FINISHED',
        _ballDrawInProgress: false,
        _starting: false,
      };

      if (this.room.status === 'WAITING' && this.room.reservations.size === 0 && this.room.players.size === 0) {
        this.room.status = 'WAITING';
      }
      if (this.room.status === 'RUNNING') {
        this.room.currentIndex = this.room.calledNumbers.length;
      }

      this.room.dbFailure = null;

      console.log(`[Room] Restored DB room ${this.room.dbId} -> ${this.room.status} (${this.room.calledNumbers.length} numbers, ${this.room.players.size} players)`);
    } catch (error) {
      this.room.dbFailure = { code: error.code || 'DATABASE_UNAVAILABLE', message: error.message };
      console.error('[room:db] restore failed:', JSON.stringify({ code: error.code || null, message: error.message, stack: error.stack }));
      throw error;
    }
  }

  publicState() {
    const r = this.room;
    return {
      id: r.id,
      gameId: r.dbId || r.id,
      roomId: r.dbId || r.id,
      status: r.status,
      stake: r.stake,
      capacity: r.capacity,
      playerCount: r.players.size || new Set([...r.reservations.values()].map(x => String(x.tgId))).size,
      cartelaCount: [...r.players.values()].reduce((n, p) => n + p.cartelas.length, 0) + r.reservations.size,
      reservedCartelas: [...r.reservations.entries()].map(([id, x]) => ({ id: Number(id), tgId: String(x.tgId) })),
      grossPot: money(r.pot + r.reservations.size * CONFIG.STAKE_PRICE),
      houseFee: money((r.pot + r.reservations.size * CONFIG.STAKE_PRICE) * CONFIG.HOUSE_FEE_PERCENT),
      pot: money((r.pot + r.reservations.size * CONFIG.STAKE_PRICE) * (1 - CONFIG.HOUSE_FEE_PERCENT)),
      countdown: r.countdown,
      countdownUpdatedAt: r.countdownUpdatedAt,
      countdownEndsAt: r.countdownEndsAt,
      serverTime: Date.now(),
      calledNumbers: [...r.calledNumbers],
      currentNumber: r.calledNumbers[r.calledNumbers.length - 1] || null,
      currentIndex: r.currentIndex,
      callIndex: r.currentIndex,
      lastCallAt: r.lastCallAt,
      nextCallAt: r.nextCallAt,
      winners: r.winners,
      winnerCards: r.winnerCards,
      winnerEndsAt: r.winnerEndsAt,
      hashCommitment: r.hashCommitment,
      secretSeed: r.status === 'FINISHED' ? r.secretSeed : null,
      drawSequence: r.status === 'FINISHED' ? r.drawSequence : null,
      dbFailure: null,
    };
  }

  async resetRoomForNewRound() {
    const activeDbRoom = DATABASE_ENABLED ? await getActiveRoom().catch(() => null) : null;
    if (activeDbRoom && String(activeDbRoom.status) === 'WAITING') {
      this.room.players = new Map();
      this.room.reservations = new Map();
      this.room.status = 'WAITING';
      this.room.pot = Number(activeDbRoom.pot || 0);
      this.room.calledNumbers = [];
      this.room.currentIndex = 0;
      this.room.countdown = Number(activeDbRoom.countdown_seconds || CONFIG.COUNTDOWN_SECONDS);
      this.room.countdownUpdatedAt = Date.now();
      this.room.countdownEndsAt = Date.now() + this.room.countdown * 1000;
      this.room.startedAt = null;
      this.room.finishedAt = null;
      this.room.winnerEndsAt = null;
      this.room.winners = [];
      this.room.winnerCards = [];
      this.room._settled = false;
      this.room.dbId = activeDbRoom.id;
      this.room.id = String(activeDbRoom.room_code || activeDbRoom.id);
      this.broadcast('room:new', this.publicState());
      this.broadcast('room:update', this.publicState());
      return;
    }

    if (this.room.dbId) {
      await resetRoomDbState(this.room.dbId).catch(() => null);
    }

    this.initRoom();
    this.broadcast('room:new', this.publicState());
    this.broadcast('room:update', this.publicState());
  }

  async persistRoomState() {
    if (!DATABASE_ENABLED || !this.room) return;
    try {
      if (!this.room.dbId) {
        const generatedRoomCode = `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const created = await createRoom({
          roomCode: generatedRoomCode,
          status: this.room.status,
          stake: Number(this.room.stake || CONFIG.STAKE_PRICE),
          capacity: Number(this.room.capacity || CONFIG.MAX_ROOM_CAPACITY),
          pot: Number(this.room.pot || 0),
          currentIndex: Number(this.room.currentIndex || 0),
          countdownSeconds: Number(this.room.countdown || CONFIG.COUNTDOWN_SECONDS),
          hashCommitment: this.room.hashCommitment || null,
          secretSeed: this.room.secretSeed || null,
          drawSequence: this.room.drawSequence || null,
        });
        this.room.dbId = created.id;
        this.room.id = created.room_code;
      }

      await updateRoom(this.room.dbId, {
        status: this.room.status,
        stake: Number(this.room.stake || CONFIG.STAKE_PRICE),
        capacity: Number(this.room.capacity || CONFIG.MAX_ROOM_CAPACITY),
        pot: Number(this.room.pot || 0),
        current_index: Number(this.room.currentIndex || 0),
        countdown_seconds: Number(this.room.countdown || CONFIG.COUNTDOWN_SECONDS),
        countdown_ends_at: this.room.countdownEndsAt ? new Date(this.room.countdownEndsAt).toISOString() : null,
        started_at: this.room.startedAt ? new Date(this.room.startedAt).toISOString() : null,
        finished_at: this.room.finishedAt ? new Date(this.room.finishedAt).toISOString() : null,
        winner_ends_at: this.room.winnerEndsAt ? new Date(this.room.winnerEndsAt).toISOString() : null,
        hash_commitment: this.room.hashCommitment || null,
        secret_seed: this.room.secretSeed || null,
        draw_sequence: this.room.drawSequence ? JSON.stringify(this.room.drawSequence) : null,
        updated_at: new Date().toISOString(),
      });

      await query('DELETE FROM room_called_numbers WHERE room_id = $1', [this.room.dbId]);
      for (let index = 0; index < (this.room.calledNumbers || []).length; index++) {
        const number = Number(this.room.calledNumbers[index]);
        if (!Number.isFinite(number)) continue;
        await query(
          `INSERT INTO room_called_numbers (room_id, number, letter, call_index, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [this.room.dbId, number, BingoEngine.letterForNumber(number), index]
        );
      }

      for (const [playerKey, player] of this.room.players.entries()) {
        if (!player?.user?.id) continue;
        await upsertRoomPlayer({
          roomId: this.room.dbId,
          userId: player.user.id,
          tgId: String(player.user.tgId || playerKey),
          claimAttempts: Number(player.claimAttempts || 0),
          cartelaCount: Number(player.cartelas?.length || 0),
        }).catch(() => null);
      }

      const currentDbCartelas = await getRoomCartelas(this.room.dbId).catch(() => []);
      const currentIds = new Set(this.room.reservations ? [...this.room.reservations.keys()].map(Number) : []);
      for (const row of currentDbCartelas) {
        if (!currentIds.has(Number(row.cartela_id))) {
          await removeRoomCartela(this.room.dbId, row.cartela_id).catch(() => null);
        }
      }

      for (const [reservationId, reservation] of (this.room.reservations || new Map()).entries()) {
        if (!reservation?.card || !reservation?.user?.id) continue;
        const dbUser = await ensureUserExistsByTgId(reservation.tgId || reservation.user.tgId);
        if (!dbUser) throw new Error('DATABASE_USER_NOT_FOUND');
        await addRoomCartela({
          roomId: this.room.dbId,
          userId: dbUser.id,
          tgId: String(reservation.tgId || reservation.user.tgId || ''),
          cartelaId: Number(reservationId),
          card: reservation.card,
        });
      }
    } catch (error) {
      this.room.dbFailure = { code: error.code || 'DATABASE_UNAVAILABLE', message: error.message };
      console.error('[room:db] persist failed:', JSON.stringify({ code: error.code || null, message: error.message, stack: error.stack }));
      return false;
    }
  }

  async hydrateRoomFromDb() {
    if (!DATABASE_ENABLED || !this.room) return;
    try {
      const dbRoom = await getRoomById(this.room.dbId);
      if (!dbRoom) return;
      this.room.status = dbRoom.status || this.room.status;
      this.room.stake = Number(dbRoom.stake || this.room.stake || CONFIG.STAKE_PRICE);
      this.room.capacity = Number(dbRoom.capacity || this.room.capacity || CONFIG.MAX_ROOM_CAPACITY);
      this.room.pot = Number(dbRoom.pot || this.room.pot || 0);
      this.room.currentIndex = Number(dbRoom.current_index || this.room.currentIndex || 0);
      this.room.countdown = Number(dbRoom.countdown_seconds || this.room.countdown || CONFIG.COUNTDOWN_SECONDS);
      this.room.countdownEndsAt = dbRoom.countdown_ends_at ? Date.parse(dbRoom.countdown_ends_at) : this.room.countdownEndsAt;
      this.room.startedAt = dbRoom.started_at ? Date.parse(dbRoom.started_at) : this.room.startedAt;
      this.room.finishedAt = dbRoom.finished_at ? Date.parse(dbRoom.finished_at) : this.room.finishedAt;
      this.room.winnerEndsAt = dbRoom.winner_ends_at ? Date.parse(dbRoom.winner_ends_at) : this.room.winnerEndsAt;
      this.room.hashCommitment = dbRoom.hash_commitment || this.room.hashCommitment || null;
      this.room.secretSeed = dbRoom.secret_seed || this.room.secretSeed || null;
      this.room.drawSequence = dbRoom.draw_sequence || this.room.drawSequence || null;
    } catch (error) {
      console.warn('[room:db] hydrate failed:', error.message);
    }
  }

  subscribe(res) {
    this.clients.add(res);
    try {
      if (this.lastFinishedEvent && this.lastFinishedAt) {
        const age = Date.now() - this.lastFinishedAt;
        if (age < CONFIG.WINNER_DISPLAY_MS + CONFIG.WINNER_REPLAY_GRACE_MS) {
          const replay = Object.assign({}, this.lastFinishedEvent, {
            serverTime: Date.now(),
            replay: true,
          });
          res.write(`event: game:finished\ndata: ${JSON.stringify(replay)}\n\n`);
        }
      }
    } catch (e) {}
    res.on('close', () => this.clients.delete(res));
    res.on('error', () => this.clients.delete(res));
  }

  broadcast(type, payload) {
    const raw = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    let delivered = 0;
    for (const client of [...this.clients]) {
      try { client.write(raw); delivered++; } catch (error) {
        console.error('[SSE] delivery failed', JSON.stringify({ type, roomId: this.room?.dbId || this.room?.id, error: error.message, stack: error.stack }));
        this.clients.delete(client);
      }
    }
    if (type === 'game:ball') console.log('[SSE] call delivery', JSON.stringify({ type, roomId: this.room?.dbId || this.room?.id, callIndex: payload?.callIndex, number: payload?.number, delivered, clients: this.clients.size }));
  }

  getPlayer(tgId) { return this.room.players.get(String(tgId)) || null; }

  userReservations(tgId) {
    return [...this.room.reservations.entries()]
      .filter(([, r]) => String(r.tgId) === String(tgId))
      .map(([id]) => Number(id))
      .sort((a, b) => a - b);
  }

  tickCountdown() {
    const r = this.room;
    if (!['WAITING', 'COUNTDOWN'].includes(r.status)) {
      if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
      return;
    }
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil((r.countdownEndsAt - now) / 1000));
    const previous = Number(r.countdown);
    r.countdown = remaining;
    if (now >= r.countdownEndsAt) {
      if (r.reservations.size >= 3) {
        if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
        this.startGame();
        return;
      }
      r.countdownUpdatedAt = now;
      r.countdownEndsAt = now + CONFIG.COUNTDOWN_SECONDS * 1000;
      r.countdown = CONFIG.COUNTDOWN_SECONDS;
      this.broadcast('room:update', this.publicState());
      return;
    }
    if (remaining !== previous) {
      r.countdownUpdatedAt = now;
      this.broadcast('room:update', this.publicState());
    }
  }

  async reserveCartela(user, cartelaId) {
    const r = this.room;
    if (r.dbFailure) {
      const error = new Error('DATABASE_UNAVAILABLE');
      error.code = 'DATABASE_UNAVAILABLE';
      throw error;
    }
    if (!['WAITING', 'COUNTDOWN'].includes(r.status)) {
      const error = new Error(r.status === 'FINISHED' ? 'GAME_FINISHED' : 'GAME_ALREADY_STARTED');
      error.code = r.status === 'FINISHED' ? 'GAME_FINISHED' : 'GAME_ALREADY_STARTED';
      throw error;
    }
    const id = Number(cartelaId);
    if (!Number.isInteger(id) || id < 1 || id > 100) {
      const error = new Error('INVALID_CARTELA');
      error.code = 'INVALID_CARTELA';
      throw error;
    }
    if (DATABASE_ENABLED) {
      const dbUser = await findOrCreateUserByTgId({
        tgId: user.tgId,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        language: user.language === 'en' ? 'en' : 'am',
      });
      if (!dbUser?.user?.id) {
        const error = new Error('DATABASE_UNAVAILABLE');
        error.code = 'DATABASE_UNAVAILABLE';
        throw error;
      }
      if (!r.dbId) {
        try { await this.restoreActiveRoomFromDb(); } catch (error) {
          error.code = error.code || 'DATABASE_UNAVAILABLE';
          throw error;
        }
      }
      const card = BingoEngine.generateCartela(id, user.tgId);
      try {
        const result = await reserveCartelaAtomic({
          roomId: r.dbId,
          userId: dbUser.user.id,
          tgId: user.tgId,
          cartelaId: id,
          card,
          stake: CONFIG.STAKE_PRICE,
          maxCartelas: CONFIG.MAX_CARTELAS_PER_PLAYER,
        });
        const dbWallet = result.wallet;
        user.balance = money(dbWallet.balance);
        user.reservedBalance = money(dbWallet.reserved_balance);
        user.playBalance = getAvailableWalletBalance(dbWallet);
        r.status = String(result.room.status);
        r.pot = Number(result.room.pot);
        r.reservations.set(id, { tgId: String(user.tgId), user, card, selectedAt: Date.now() });
        r.dbFailure = null;
        this.broadcast('room:update', this.publicState());
        this.broadcast('wallet:update', {
          tgId: String(user.tgId),
          balance: money(user.balance),
          playBalance: money(user.playBalance),
          availableBalance: getAvailableWalletBalance(dbWallet),
          reservedBalance: money(user.reservedBalance || 0),
        });
        return {
          selected: true,
          cartelas: result.cartelas,
          balance: money(user.balance),
          playBalance: money(user.playBalance),
          availableBalance: getAvailableWalletBalance(dbWallet),
          reservedBalance: money(user.reservedBalance || 0),
          previewCartelas: result.cartelas.map(cartelaId => r.reservations.get(cartelaId)?.card).filter(Boolean),
          card,
          room: this.publicState(),
        };
      } catch (error) {
        console.error('[cartela:ERROR]', JSON.stringify({
          roomId: r.dbId || null,
          tgId: walletLogId(user.tgId),
          selectedCartelaIds: this.userReservations(user.tgId),
          existingCartelas: [...r.reservations.keys()],
          roomStatus: r.status,
          playerCount: r.players.size,
          errorName: error.name,
          errorCode: error.code || null,
          errorMessage: error.message,
          errorDetail: error.detail || null,
          errorConstraint: error.constraint || null,
        }));
        throw error;
      }
    }
    const existingPlayer = this.getPlayer(user.tgId);
    if (existingPlayer) throw new Error('You are already in the active game.');
    const owned = r.reservations.get(id);
    if (owned && String(owned.tgId) !== String(user.tgId)) {
      throw new Error(`Cartela #${String(id).padStart(2,'0')} was just selected by another player.`);
    }
    if (owned && String(owned.tgId) === String(user.tgId)) {
      return { selected: true, cartelas: this.userReservations(user.tgId),
        balance: money(user.balance), playBalance: money(user.playBalance),
        availableBalance: syncAvailableWallet(user), reservedBalance: money(user.reservedBalance || 0),
        room: this.publicState() };
    }
    const mine = this.userReservations(user.tgId);
    if (mine.length >= CONFIG.MAX_CARTELAS_PER_PLAYER) {
      throw new Error('Maximum 2 cartelas per player.');
    }
    syncAvailableWallet(user);
    if (!tryReserveStake(user, id, 'RESERVE')) {
      throw new Error(`Insufficient balance. You need ${CONFIG.STAKE_PRICE.toFixed(2)} BIRR.`);
    }
    const card = BingoEngine.generateCartela(id, user.tgId);
    r.reservations.set(id, { tgId: String(user.tgId), user, card, selectedAt: Date.now() });
    if (r.status === 'WAITING') r.status = 'COUNTDOWN';

    if (DATABASE_ENABLED) {
      try {
        if (!r.dbId) {
          const persisted = await this.persistRoomState();
          if (persisted === false) throw new Error('DATABASE_UNAVAILABLE');
        } else {
          const dbUser = await ensureUserExistsByTgId(user.tgId);
          if (!dbUser) throw new Error('DATABASE_USER_NOT_FOUND');
          const updatedRoom = await updateRoom(r.dbId, {
            status: r.status,
            countdown_seconds: Number(r.countdown || CONFIG.COUNTDOWN_SECONDS),
            countdown_ends_at: r.countdownEndsAt ? new Date(r.countdownEndsAt).toISOString() : null,
            pot: Number(r.pot || 0),
          });
          if (!updatedRoom) throw new Error('DATABASE_UNAVAILABLE');
          await addRoomCartela({
            roomId: r.dbId,
            userId: dbUser.id,
            tgId: String(user.tgId),
            cartelaId: id,
            card,
          });
        }
        r.dbFailure = null;
      } catch (error) {
        r.reservations.delete(id);
        refundStake(user, id, 'RESERVE_DB_FAILED');
        r.dbFailure = { code: error.code || 'DATABASE_UNAVAILABLE', message: error.message };
        const dbError = new Error('DATABASE_UNAVAILABLE');
        dbError.code = 'DATABASE_UNAVAILABLE';
        throw dbError;
      }
    }
    this.broadcast('room:update', this.publicState());
    this.broadcast('wallet:update', {
      tgId: String(user.tgId),
      balance: money(user.balance),
      playBalance: money(user.playBalance),
      availableBalance: syncAvailableWallet(user),
      reservedBalance: money(user.reservedBalance || 0),
    });

    return {
      selected: true, cartelas: this.userReservations(user.tgId),
      balance: money(user.balance), playBalance: money(user.playBalance),
      availableBalance: money(user.playBalance),
      reservedBalance: money(user.reservedBalance || 0),
      previewCartelas: this.userReservations(user.tgId).map(cid => r.reservations.get(cid)?.card).filter(Boolean),
      card,
      room: this.publicState(),
    };
  }

  async releaseCartela(user, cartelaId, idempotencyKey) {
    const r = this.room;
    const id = Number(cartelaId);
    if (!Number.isInteger(id) || id < 1 || id > 100) {
      const error = new Error('INVALID_CARTELA');
      error.code = 'INVALID_CARTELA';
      throw error;
    }

    if (DATABASE_ENABLED) {
      if (r.dbFailure || !r.dbId) await this.restoreActiveRoomFromDb();
      const databaseUser = await ensureUserExistsByTgId(user.tgId);
      if (!databaseUser) {
        const error = new Error('DATABASE_USER_NOT_FOUND');
        error.code = 'DATABASE_USER_NOT_FOUND';
        throw error;
      }
      const result = await releaseRoomCartelaAtomic({
        roomId: r.dbId,
        userId: databaseUser.id,
        tgId: user.tgId,
        cartelaId: id,
        stake: CONFIG.STAKE_PRICE,
        idempotencyKey,
      });
      const wallet = result.wallet;
      user.balance = money(wallet.balance);
      user.reservedBalance = money(wallet.reserved_balance);
      user.playBalance = getAvailableWalletBalance(wallet);
      r.status = String(result.room.status);
      r.pot = Number(result.room.pot || 0);
      if (!result.cartelas.includes(id)) r.reservations.delete(id);

      const player = r.players.get(String(user.tgId));
      if (player && !result.cartelas.includes(id)) {
        player.cartelas = (player.cartelas || []).filter(card => {
          const cardId = Number(String(card?.id || '').replace(/\D/g, ''));
          return cardId !== id;
        });
        if (!player.cartelas.length) r.players.delete(String(user.tgId));
      }

      const availableBalance = getAvailableWalletBalance(wallet);
      this.broadcast('room:update', this.publicState());
      this.broadcast('wallet:update', {
        tgId: String(user.tgId),
        balance: money(wallet.balance),
        playBalance: availableBalance,
        availableBalance,
        reservedBalance: money(wallet.reserved_balance),
      });
      return {
        selected: false,
        duplicate: result.duplicate,
        cartelas: result.cartelas,
        balance: money(wallet.balance),
        playBalance: availableBalance,
        availableBalance,
        reservedBalance: money(wallet.reserved_balance),
        previewCartelas: result.cartelas.map(cartelaId => r.reservations.get(cartelaId)?.card).filter(Boolean),
        room: this.publicState(),
      };
    }

    const reservation = r.reservations.get(id);
    if (!reservation) throw new Error(`Cartela #${String(id).padStart(2,'0')} is not currently selected.`);
    if (String(reservation.tgId) !== String(user.tgId)) {
      throw new Error(`Cartela #${String(id).padStart(2,'0')} is already selected by another player.`);
    }
    if (!['WAITING', 'COUNTDOWN'].includes(r.status)) {
      throw new Error('The game has already started.');
    }
    r.reservations.delete(id);
    refundStake(user, id, 'DESELECT');

    if (r.reservations.size > 0) r.status = 'COUNTDOWN';
    else r.status = 'WAITING';

    this.broadcast('room:update', this.publicState());
    this.broadcast('wallet:update', {
      tgId: String(user.tgId),
      balance: money(user.balance),
      playBalance: money(user.playBalance),
      availableBalance: money(user.playBalance),
      reservedBalance: money(user.reservedBalance || 0),
    });

    return {
      selected: false, cartelas: this.userReservations(user.tgId),
      balance: money(user.balance), playBalance: money(user.playBalance),
      availableBalance: money(user.playBalance),
      reservedBalance: money(user.reservedBalance || 0),
      previewCartelas: this.userReservations(user.tgId).map(cid => r.reservations.get(cid)?.card).filter(Boolean),
      room: this.publicState(),
    };
  }

  async syncRoomStatusFromDb() {
    if (!DATABASE_ENABLED || !this.room?.dbId) return;
    try {
      const dbRoom = await getRoomById(this.room.dbId);
      if (!dbRoom) return;
      const dbStatus = String(dbRoom.status || this.room.status);
      if (dbStatus !== String(this.room.status)) {
        this.room.status = dbStatus;
      }
      if (dbStatus === 'FINISHED') {
        this.room._settled = true;
        this.room.finishedAt = this.room.finishedAt || Date.parse(dbRoom.finished_at || new Date().toISOString());
        this.room.winnerEndsAt = this.room.winnerEndsAt || (dbRoom.winner_ends_at ? Date.parse(dbRoom.winner_ends_at) : Date.now() + CONFIG.WINNER_DISPLAY_MS);
      }
    } catch (error) {
      console.warn('[room:db] status sync failed:', error.message);
    }
  }

  async advanceProgressionFromDb() {
    if (this.room.status !== 'RUNNING' || this._settled) {
      console.log('[Progression] skipped', JSON.stringify({ roomId: this.room?.dbId || this.room?.id, status: this.room?.status, settled: this._settled }));
      return;
    }
    if (this.callTimer) {
      clearTimeout(this.callTimer);
      this.callTimer = null;
    }
    if (!DATABASE_ENABLED || !this.room.dbId) {
      console.warn('[Progression] no persisted room; refusing in-memory draw', JSON.stringify({ roomId: this.room?.id, status: this.room?.status }));
      return;
    }

    try {
      const beforeCount = this.room.calledNumbers.length;
      const progressed = await progressRoom(this.room.dbId);
      if (!progressed) return;
      const dbCalled = await getRoomCalledNumbers(this.room.dbId);
      const persistedNumbers = dbCalled.map(item => Number(item.number)).filter(Number.isFinite);
      this.room.status = String(progressed.status || this.room.status);
      this.room.calledNumbers = persistedNumbers;
      this.room.currentIndex = Number(progressed.current_index || persistedNumbers.length || 0);
      const lastPersistedCall = dbCalled.length ? dbCalled[dbCalled.length - 1] : null;
      this.room.lastCallAt = lastPersistedCall?.created_at ? Date.parse(lastPersistedCall.created_at) : null;
      this.room.nextCallAt = this.room.lastCallAt ? this.room.lastCallAt + CONFIG.BALL_INTERVAL_MS : null;
      this.room.startedAt = progressed.started_at ? Date.parse(progressed.started_at) : this.room.startedAt;
      this.room.finishedAt = progressed.finished_at ? Date.parse(progressed.finished_at) : this.room.finishedAt;
      this.room.winnerEndsAt = progressed.winner_ends_at ? Date.parse(progressed.winner_ends_at) : this.room.winnerEndsAt;
      console.log('[Progression] db result', JSON.stringify({ roomId: this.room.dbId, status: this.room.status, beforeCount, afterCount: persistedNumbers.length, currentIndex: this.room.currentIndex, inserted: progressed.__lastInsertedNumber?.number || null }));
      if (progressed.__lastInsertedNumber) {
        const number = persistedNumbers[persistedNumbers.length - 1];
        const payload = {
          gameId: this.room.id,
          callIndex: persistedNumbers.length,
          callSequence: persistedNumbers.length,
          number,
          letter: BingoEngine.letterForNumber(number),
          currentNumber: number,
          currentColumn: BingoEngine.letterForNumber(number),
          calledNumbers: persistedNumbers,
          roundIndex: persistedNumbers.length,
          calledAt: Date.now(),
          serverTime: Date.now(),
          nextCallAt: this.room.nextCallAt,
        };
        console.log('[Progression] delivering call', JSON.stringify({ roomId: this.room.dbId, callIndex: payload.callIndex, number, status: this.room.status, clients: this.clients.size }));
        this.broadcast('game:ball', payload);
        this.broadcast('room:update', this.publicState());
      }
    } catch (error) {
      console.error('[Progression] failed', JSON.stringify({ roomId: this.room?.dbId, status: this.room?.status, error: error.message, stack: error.stack }));
      return;
    }

    // Vercel does not guarantee a process lifetime after this request ends.
    // The next /api/state request advances the persisted room when due.
  }

  async startGame() {
    const r = this.room;
    if (r.status !== 'COUNTDOWN') return;
    if (r._starting) return;
    if (r.reservations.size < 3) {
      r.countdown = CONFIG.COUNTDOWN_SECONDS;
      r.countdownEndsAt = Date.now() + CONFIG.COUNTDOWN_SECONDS * 1000;
      r.status = 'COUNTDOWN';
      return;
    }

    if (this.room.dbId) {
      const dbTransition = await transitionRoomStatus({
        roomId: this.room.dbId,
        expectedStatus: 'COUNTDOWN',
        nextStatus: 'RUNNING',
        fields: {
          current_index: Number(r.currentIndex || 0),
          countdown_seconds: Number(r.countdown || CONFIG.COUNTDOWN_SECONDS),
          started_at: new Date(r.startedAt || Date.now()).toISOString(),
          pot: Number(r.pot || 0),
        },
      }).catch(() => null);
      if (!dbTransition) return;
    }

    r._starting = true;
    try {
      if (this.callTimer) { clearTimeout(this.callTimer); this.callTimer = null; }
      if (this.firstBallTimer) { clearTimeout(this.firstBallTimer); this.firstBallTimer = null; }
      if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }

      const grouped = new Map();
      for (const [id, reservation] of r.reservations.entries()) {
        const key = String(reservation.tgId);
        if (!grouped.has(key)) grouped.set(key, { user: reservation.user, cartelas: [], claimAttempts: 0 });
        grouped.get(key).cartelas.push(reservation.card);
      }
      r.players = grouped;
      r.reservations.clear();

      for (const player of r.players.values()) {
        const count = player.cartelas.length;
        player.user.cartelasPurchased += count;
        consumeReservedStake(player.user, count * CONFIG.STAKE_PRICE);
      }
      r.pot = money([...r.players.values()].reduce((sum, p) => sum + p.cartelas.length * CONFIG.STAKE_PRICE, 0));
      console.log('[GAME_STATUS]', JSON.stringify({ roomId: r.dbId || r.id, oldStatus: 'COUNTDOWN', newStatus: 'RUNNING', currentIndex: r.currentIndex, calledCount: r.calledNumbers.length, currentNumber: r.calledNumbers[r.calledNumbers.length - 1] || null, winnerReason: null, triggerSource: 'RoomManager.startGame' }));
      r.status = 'RUNNING';
      r.startedAt = Date.now();
      r._settled = false;
      r._ballDrawInProgress = false;
      r._starting = false;

      void this.persistRoomState();
      this.lastFinishedEvent = null;
      this.lastFinishedAt = 0;
      this.lastFinishedGameId = null;

      console.log(`[Room] STARTED. Players: ${r.players.size}, Pot: ${r.pot}`);
      this.broadcast('game:started', this.publicState());
      this.broadcast('room:update', this.publicState());

      void this.advanceProgressionFromDb();
    } catch (e) {
      r._starting = false;
      throw e;
    }
  }

  drawBall() {
    const r = this.room;
    if (r.status !== 'RUNNING') {
      if (this.callTimer) { clearTimeout(this.callTimer); this.callTimer = null; }
      if (this.firstBallTimer) { clearTimeout(this.firstBallTimer); this.firstBallTimer = null; }
      return;
    }
    if (r._ballDrawInProgress) return;
    if (r._settled) return;

    r._ballDrawInProgress = true;
    try {
      if (r.currentIndex >= r.drawSequence.length) {
        this.endWithoutWinner();
        return;
      }
      const number = r.drawSequence[r.currentIndex++];
      r.calledNumbers.push(number);
      void this.persistRoomState();
      for (const player of r.players.values()) {
        for (const card of player.cartelas) BingoEngine.markNumber(card, number);
      }
      const now = Date.now();
      const payload = {
        gameId: r.id,
        callIndex: r.currentIndex,
        callSequence: r.currentIndex,
        number,
        letter: BingoEngine.letterForNumber(number),
        currentNumber: number,
        currentColumn: BingoEngine.letterForNumber(number),
        calledNumbers: [...r.calledNumbers],
        roundIndex: r.currentIndex,
        calledAt: now,
        serverTime: now,
        nextCallAt: now + CONFIG.BALL_INTERVAL_MS,
      };
      console.log(`[Ball] ${payload.letter} ${number} (#${r.calledNumbers.length})`);
      this.broadcast('game:ball', payload);
      this.broadcast('room:update', this.publicState());
    } finally {
      r._ballDrawInProgress = false;
    }
  }

  async validateClaim(player) {
    await this.syncRoomStatusFromDb();
    const r = this.room;
    if (!this.room.dbId) {
      if (r.status !== 'RUNNING') throw new Error('The game is not running.');
    } else {
      const dbRoom = await getRoomById(this.room.dbId).catch(() => null);
      if (!dbRoom || String(dbRoom.status || '').toUpperCase() !== 'RUNNING') {
        throw new Error('The game is not running.');
      }
      const existingWinner = await query('SELECT id FROM winners WHERE room_id = $1 LIMIT 1', [this.room.dbId]).catch(() => ({ rows: [] }));
      if (existingWinner.rows.length) {
        throw new Error('This room has already been settled.');
      }
    }
    const winningCards = [];
    for (const card of player.cartelas) {
      const result = BingoEngine.checkWinningPatterns(card);
      console.log('[WINNER_CHECK]', JSON.stringify({ roomId: this.room.dbId || r.id, tgId: player.user.tgId, cartelaId: card.id, pattern: result.pattern || null, isWinner: !!result.won, calledNumbers: r.calledNumbers.length, reason: result.won ? 'completed-pattern' : 'no-completed-pattern' }));
      if (result.won) winningCards.push({ cartelaId: card.id, pattern: result.pattern });
    }
    if (winningCards.length === 0) {
      player.claimAttempts = Number(player.claimAttempts || 0) + 1;
      return { valid: false, winningCards: [], attempts: player.claimAttempts };
    }
    return { valid: true, winningCards, attempts: player.claimAttempts || 0 };
  }

  async settleNow(winnerPlayer, winningCards) {
    const r = this.room;
    await this.syncRoomStatusFromDb();
    if (this.room.dbId) {
      const dbRoom = await getRoomById(this.room.dbId).catch(() => null);
      if (!dbRoom || String(dbRoom.status || '').toUpperCase() !== 'RUNNING') return null;
      const existingWinner = await query('SELECT id FROM winners WHERE room_id = $1 LIMIT 1', [this.room.dbId]).catch(() => ({ rows: [] }));
      if (existingWinner.rows.length) return null;
    }
    if (r.status !== 'RUNNING') return null;
    if (r._settled) return null;

    console.log('[GAME_STATUS]', JSON.stringify({ roomId: r.dbId || r.id, oldStatus: 'RUNNING', newStatus: 'FINISHED', currentIndex: r.currentIndex, calledCount: r.calledNumbers.length, currentNumber: r.calledNumbers[r.calledNumbers.length - 1] || null, winnerReason: 'valid-winner', triggerSource: 'RoomManager.settleNow' }));

    const settlementFields = {
      pot: Number(r.pot || 0),
      current_index: Number(r.currentIndex || 0),
      finished_at: new Date(Date.now()).toISOString(),
      winner_ends_at: new Date(Date.now() + CONFIG.WINNER_DISPLAY_MS).toISOString(),
    };

    if (this.room.dbId) {
      const dbTransition = await transitionRoomStatus({
        roomId: this.room.dbId,
        expectedStatus: 'RUNNING',
        nextStatus: 'FINISHED',
        fields: settlementFields,
      }).catch(() => null);
      if (!dbTransition) return null;
    }

    r._settled = true;

    if (this.callTimer) { clearTimeout(this.callTimer); this.callTimer = null; }
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    if (this.firstBallTimer) { clearTimeout(this.firstBallTimer); this.firstBallTimer = null; }
    if (this.newRoomTimer) { clearTimeout(this.newRoomTimer); this.newRoomTimer = null; }

    r.status = 'FINISHED';
    r.finishedAt = Date.now();
    r.winnerEndsAt = Date.now() + CONFIG.WINNER_DISPLAY_MS;
    void this.persistRoomState();

    const houseFee = money(r.pot * CONFIG.HOUSE_FEE_PERCENT);
    const prizePool = money(r.pot - houseFee);
    const prize = prizePool;

    const user = DB.users.get(String(winnerPlayer.user.tgId));
    const dbUser = user ? { user: user } : await findOrCreateUserByTgId({
      tgId: winnerPlayer.user.tgId,
      firstName: winnerPlayer.user.firstName || 'Player',
      lastName: winnerPlayer.user.lastName || '',
      username: winnerPlayer.user.username || '',
      language: winnerPlayer.user.language === 'en' ? 'en' : 'am',
    });
    const finalUser = dbUser && dbUser.user ? dbUser.user : user;

    const settlementKey = `${r.id}:${winnerPlayer.user.tgId}:${Date.now()}`;
    const dbSettlement = finalUser && finalUser.id ? await settlePrizeIfMissing({
      userId: finalUser.id,
      tgId: finalUser.tgId || String(winnerPlayer.user.tgId),
      gameId: r.id,
      settlementKey,
      amount: prize,
    }).catch(() => ({ duplicate: true, record: null })) : { duplicate: false, record: null };

    if (finalUser && !dbSettlement.duplicate) {
      finalUser.gamesPlayed = Number(finalUser.gamesPlayed || 0) + 1;
      finalUser.totalWins = Number(finalUser.totalWins || 0) + 1;
      finalUser.totalWinnings = money(Number(finalUser.totalWinnings || 0) + Number(prize));
      if (!DB.transactions.some(entry => entry.type === 'GAME_PRIZE' && entry.settlementKey === settlementKey)) {
        creditPrize(finalUser, prize, 'BINGO_WIN', { settlementKey, gameId: r.id });
      }
    }

    if (finalUser) {
      await recordWinner({
        roomId: this.room.dbId,
        userId: finalUser.id,
        tgId: finalUser.tgId || String(winnerPlayer.user.tgId),
        cartelaIds: winningCards.map(w => w.cartelaId),
        patterns: winningCards.map(w => w.pattern),
        prizeAmount: prize,
      }).catch(() => null);
    }

    if (finalUser) {
      this.broadcast('wallet:update', {
        tgId: String(finalUser.tgId),
        balance: money(finalUser.balance),
        playBalance: money(finalUser.playBalance),
        availableBalance: money(finalUser.playBalance),
        reservedBalance: money(finalUser.reservedBalance || 0),
      });
      if (bot) {
        const language = finalUser.language === 'en' ? 'en' : 'am';
        const cards = winningCards.map(item => item.cartelaId).join(', ');
        const message = language === 'am'
          ? `🎉 እንኳን ደስ አለዎት!\n\n🏆 የShisho Bingo ጨዋታን አሸንፈዋል!\n\n🎟 ካርቴላ፦ ${cards}\n💰 ያሸነፉት፦ ${prize.toFixed(2)} BIRR\n\n💳 ${prize.toFixed(2)} BIRR ወደ ቦርሳዎ ተጨምሯል።\n\nመልካል እድል! 🎊`
          : `🎉 Congratulations!\n\n🏆 You won the Shisho Bingo game!\n\n🎟 Cartela: ${cards}\n💰 Prize: ${prize.toFixed(2)} BIRR\n\n💳 ${prize.toFixed(2)} BIRR has been added to your wallet.\n\nGood luck! 🎊`;
        bot.sendMessage(finalUser.tgId, message).catch(error => console.error('[Winner notification]', error.message));
      }
    }

    const winnerTgId = String(winnerPlayer.user.tgId);
    for (const player of r.players.values()) {
      if (String(player.user.tgId) === winnerTgId) continue;
      player.user.gamesPlayed = Number(player.user.gamesPlayed || 0) + 1;
      addGameHistory({
        id: `#${Math.floor(10000 + Math.random() * 90000)}`,
        tgId: player.user.tgId, user: player.user.firstName || 'Player',
        cardId: player.cartelas.map(c => c.id).join(', '),
        result: 'LOSS', prize: 0,
        stake: money(player.cartelas.length * CONFIG.STAKE_PRICE),
        pattern: null, timestamp: new Date().toISOString(),
      });
    }

    const winners = [{
      tgId: winnerPlayer.user.tgId,
      firstName: winnerPlayer.user.firstName || 'Player',
      cartelaIds: winningCards.map(w => w.cartelaId),
      patterns: winningCards.map(w => w.pattern),
      prize,
    }];

    const winnerCards = winnerPlayer.cartelas
      .filter(c => winningCards.some(w => w.cartelaId === c.id))
      .map(c => ({ id: c.id, matrix: c.matrix.map(row => [...row]), marked: c.marked.map(row => [...row]) }));

    r.winners = winners;
    r.winnerCards = winnerCards;
    r.finishedAt = Date.now();
    r.winnerEndsAt = Date.now() + CONFIG.WINNER_DISPLAY_MS;

    const result = {
      type: 'WINNER_ANNOUNCEMENT',
      gameId: r.id,
      winners,
      winnerCards,
      pot: money(r.pot),
      houseFee,
      prizePool,
      prizePerUser: prize,
      displayMs: CONFIG.WINNER_DISPLAY_MS,
      winnerEndsAt: r.winnerEndsAt,
      announcementEndsAt: r.winnerEndsAt,
      serverTime: Date.now(),
      hashCommitment: r.hashCommitment,
      calledNumbers: r.calledNumbers,
    };

    console.log(`[BINGO] ${winnerPlayer.user.firstName} | ${winningCards.map(w => w.cartelaId).join(', ')} | ${prize} BIRR`);
    console.log(`[BINGO] Broadcasting to ${this.clients.size} SSE clients`);

    this.lastFinishedEvent = result;
    this.lastFinishedAt = Date.now();
    this.lastFinishedGameId = r.id;

    this.broadcast('game:finished', result);
    this.broadcast('room:update', this.publicState());

    this.newRoomTimer = setTimeout(() => {
      console.log('[Room] Reset timer fired');
      void this.resetRoomForNewRound();
    }, CONFIG.WINNER_DISPLAY_MS);

    return result;
  }

  async endWithoutWinner() {
    const r = this.room;
    if (r._settled) return;
    r._settled = true;
    if (this.callTimer) { clearInterval(this.callTimer); this.callTimer = null; }
    if (this.firstBallTimer) { clearTimeout(this.firstBallTimer); this.firstBallTimer = null; }
    console.log('[GAME_STATUS]', JSON.stringify({ roomId: r.dbId || r.id, oldStatus: 'RUNNING', newStatus: 'FINISHED', currentIndex: r.currentIndex, calledCount: r.calledNumbers.length, currentNumber: r.calledNumbers[r.calledNumbers.length - 1] || null, winnerReason: 'draw-sequence-exhausted', triggerSource: 'RoomManager.endWithoutWinner' }));
    r.status = 'FINISHED';
    r.finishedAt = Date.now();
    r.winnerEndsAt = Date.now() + CONFIG.WINNER_DISPLAY_MS;
    if (this.room.dbId) {
      await transitionRoomStatus({
        roomId: this.room.dbId,
        expectedStatus: 'RUNNING',
        nextStatus: 'FINISHED',
        fields: {
          pot: Number(r.pot || 0),
          current_index: Number(r.currentIndex || 0),
          finished_at: new Date(r.finishedAt || Date.now()).toISOString(),
          winner_ends_at: new Date(r.winnerEndsAt || Date.now()).toISOString(),
        },
      }).catch(() => null);
    }
    void this.persistRoomState();
    const result = {
      type: 'WINNER_ANNOUNCEMENT',
      gameId: r.id,
      winners: [], winnerCards: [],
      pot: r.pot, prizePool: 0,
      houseFee: r.pot,
      displayMs: CONFIG.WINNER_DISPLAY_MS,
      winnerEndsAt: r.winnerEndsAt,
      announcementEndsAt: r.winnerEndsAt,
      serverTime: Date.now(),
      hashCommitment: r.hashCommitment,
      calledNumbers: r.calledNumbers,
    };
    this.lastFinishedEvent = result;
    this.lastFinishedAt = Date.now();
    this.lastFinishedGameId = r.id;
    this.broadcast('game:finished', result);
    this.broadcast('room:update', this.publicState());
    this.newRoomTimer = setTimeout(() => {
      void this.resetRoomForNewRound();
    }, CONFIG.WINNER_DISPLAY_MS);
  }

  leaveRoom(tgId) {
    const user = DB.users.get(String(tgId));
    if (!user) return { left: false, refund: 0 };
    const r = this.room;
    let refund = 0;
    for (const [id, reservation] of [...r.reservations.entries()]) {
      if (String(reservation.tgId) !== String(tgId)) continue;
      r.reservations.delete(id);
      refundStake(user, id, 'LEAVE');
      refund += CONFIG.STAKE_PRICE;
    }
    const player = this.getPlayer(tgId);
    if (player) {
      if (!['WAITING', 'COUNTDOWN'].includes(r.status)) {
        throw new Error('The game has already started.');
      }
      const playerRefund = money(player.cartelas.length * CONFIG.STAKE_PRICE);
      user.playBalance = money(user.playBalance + playerRefund);
      r.pot = money(r.pot - playerRefund);
      r.players.delete(String(tgId));
      refund = money(refund + playerRefund);
    }
    if (r.status === 'COUNTDOWN' && r.reservations.size === 0) {
      r.status = 'WAITING';
    }
    this.broadcast('room:update', this.publicState());
    this.broadcast('wallet:update', {
      tgId: String(user.tgId),
      balance: money(user.balance),
      playBalance: money(user.playBalance),
      availableBalance: money(user.playBalance),
      reservedBalance: money(user.reservedBalance || 0),
    });
    return { left: refund > 0, refund: money(refund) };
  }
}

const roomManager = new RoomManager();

// ---------------------------------------------------------------------------
// TELEGRAM BOT
// ---------------------------------------------------------------------------
class NativeTelegramBot {
  constructor(token) {
    this.token = token;
    this.offset = 0;
    this.botInfo = null;
    this.polling = false;
    this.webhookConfigured = false;
    this.pending = new Map();
  }

  api(method, payload = {}) {
    if (!this.token) return Promise.resolve({ ok: false });
    return new Promise(resolve => {
      const body = JSON.stringify(payload);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
      });
      req.on('error', () => resolve({ ok: false }));
      req.write(body); req.end();
    });
  }

  isAdmin(tgId) { return CONFIG.ADMIN_TELEGRAM_ID && String(tgId) === String(CONFIG.ADMIN_TELEGRAM_ID); }

  webAppUrl(screen) {
    const qs = new URLSearchParams({ v: 'shisho-v39' });
    if (screen) qs.set('screen', screen);
    return `${CONFIG.BASE_URL}/?${qs.toString()}`;
  }

  mainKeyboard(tgId) {
    const label = value => botText(tgId, value);
    const rows = [
      [{ text: label('🎮 Play'), web_app: { url: this.webAppUrl() } }],
      [{ text: label('💰 Balance') }, { text: label('👤 Profile') }],
      [{ text: label('💳 Deposit') }, { text: label('💸 Withdraw') }],
      [{ text: label('🔗 Invite') }, { text: label('💬 Support') }],
      [{ text: label('📢 Channel') }],
      [{ text: label('🌐 Language') }],
    ];
    if (this.isAdmin(tgId)) rows.push([{ text: label('👑 Admin Dashboard') }]);
    return { keyboard: rows, resize_keyboard: true, is_persistent: true };
  }

  async sendMessage(chatId, text, extra = {}) {
    return this.api('sendMessage', { chat_id: chatId, text: botText(chatId, text), ...extra });
  }

  async ensureWebhook() {
    if (!this.token) return false;
    if (this.webhookConfigured) return true;
    const baseUrl = String(CONFIG.BASE_URL || '').trim();
    if (!baseUrl || /localhost|127\.0\.0\.1/.test(baseUrl)) return false;
    try {
      const result = await this.api('setWebhook', {
        url: `${baseUrl}/api/telegram/webhook`,
        drop_pending_updates: true,
        allowed_updates: ['message', 'callback_query'],
      });
      this.webhookConfigured = !!result?.ok;
      if (this.webhookConfigured) console.log(`[Bot] Webhook configured for ${baseUrl}/api/telegram`);
      return this.webhookConfigured;
    } catch (error) {
      console.warn('[Bot] webhook setup failed:', error.message);
      return false;
    }
  }

  async init() {
    if (!this.token) return;
    const me = await this.api('getMe');
    if (me.ok) this.botInfo = me.result;
    console.log(`🤖 Bot: @${this.botInfo?.username || 'unknown'}`);
    const isServerlessRuntime = !!process.env.VERCEL || process.env.NODE_ENV === 'production';
    if (isServerlessRuntime) {
      await this.ensureWebhook();
      return;
    }
    this.startPolling();
  }

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    const loop = async () => {
      try {
        const response = await this.api('getUpdates', { offset: this.offset, timeout: 20 });
        if (response.ok && Array.isArray(response.result)) {
          for (const update of response.result) {
            this.offset = update.update_id + 1;
            try { await this.handleUpdate(update); } catch (e) { console.error('[Bot] handleUpdate error', e.message); }
          }
        }
      } catch (err) { console.error('Polling error:', err.message); }
      setTimeout(loop, 250);
    };
    loop();
  }

  formatBalanceMessage(user) {
    syncAvailableWallet(user);
    const available = getAvailableWalletBalance(user);
    const reserved = Number(user.reservedBalance || 0);
    const total = Number(user.balance || 0);
    return [
      `💰 *Your Wallet*`,
      ``,
      `Available:  *${available.toFixed(2)} BIRR*`,
      `Reserved:   ${reserved.toFixed(2)} BIRR`,
      `Total:      ${total.toFixed(2)} BIRR`,
    ].join('\n');
  }

  adminKeyboard() {
    return { inline_keyboard: [
      [{ text: '👥 Users', callback_data: 'adm:users' }, { text: '💰 Deposits', callback_data: 'adm:deposits' }],
      [{ text: '💸 Withdrawals', callback_data: 'adm:withdrawals' }, { text: '🎮 Games', callback_data: 'adm:games' }],
      [{ text: '📊 Statistics', callback_data: 'adm:stats' }, { text: '📢 Promotions', callback_data: 'adm:promotions' }],
      [{ text: '🔄 Refresh', callback_data: 'adm:home' }],
    ] };
  }

  adminBackKeyboard() {
    return { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'adm:home' }], [{ text: '🔄 Refresh', callback_data: 'adm:home' }]] };
  }

  adminHomeText() {
    const users = [...DB.users.values()];
    const pendingDeposits = [...DB.deposits.values()].filter(x => x.status === 'PENDING').length;
    const pendingWithdrawals = [...DB.withdrawals.values()].filter(x => x.status === 'PENDING').length;
    const room = roomManager.room;
    const active = ['COUNTDOWN', 'RUNNING'].includes(room.status);
    const players = room.players.size || room.reservations.size;
    return [
      '🎯 SHISHO BINGO', '━━━━━━━━━━━━━━━━', '👑 ADMIN DASHBOARD', '',
      `👥 Total Users: ${users.length}`,
      `💰 Pending Deposits: ${pendingDeposits}`,
      `💸 Pending Withdrawals: ${pendingWithdrawals}`, '',
      `🎮 Active Game: ${active ? 'Yes' : 'No'}`,
      `🎟️ Players: ${players}`,
      `💰 Current Pot: ${money(room.pot)} BIRR`,
      `📍 Status: ${room.status}`, '━━━━━━━━━━━━━━━━',
      `Last updated: ${new Date().toLocaleTimeString()}`,
    ].join('\n');
  }

  async showAdminDashboard(tgId) {
    if (!this.isAdmin(tgId)) return this.sendMessage(tgId, '⛔ Access denied.');
    return this.sendMessage(tgId, this.adminHomeText(), { reply_markup: this.adminKeyboard() });
  }

  async showAdminList(tgId, type) {
    if (!this.isAdmin(tgId)) return this.sendMessage(tgId, '⛔ Access denied.');
    if (type === 'users') {
      const users = [...DB.users.values()].slice(-20).reverse();
      const text = ['👥 USERS', '━━━━━━━━━━━━━━━━', ...users.map(u => `• ${u.firstName || 'Player'} ${u.username ? '@' + u.username : ''}\n  ID: ${u.tgId} | Balance: ${money(u.balance)} | ${u.language || 'am'}`), '', 'Showing latest 20 users.'].join('\n');
      return this.sendMessage(tgId, text, { reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'adm:users' }], [{ text: '⬅️ Back', callback_data: 'adm:home' }]] } });
    }
    if (type === 'deposits') {
      const items = [...DB.deposits.values()].filter(x => x.status === 'PENDING').slice(-20).reverse();
      const rows = [];
      let text = ['💰 PENDING DEPOSITS', '━━━━━━━━━━━━━━━━'];
      if (!items.length) text.push('No pending deposits.');
      for (const dep of items) {
        text.push(`💰 ${dep.id}\n👤 ${DB.users.get(String(dep.tgId))?.firstName || dep.tgId}\n💵 ${Number(dep.amount).toFixed(2)} BIRR · ${dep.method}\n🧾 ${dep.reference || '—'}`);
        rows.push([{ text: `✅ ${dep.id.slice(0, 8)}`, callback_data: `adm:dep:approve:${dep.id}` }, { text: '❌ Reject', callback_data: `adm:dep:reject:${dep.id}` }]);
      }
      rows.push([{ text: '🔄 Refresh', callback_data: 'adm:deposits' }, { text: '⬅️ Back', callback_data: 'adm:home' }]);
      return this.sendMessage(tgId, text.join('\n\n'), { reply_markup: { inline_keyboard: rows } });
    }
    if (type === 'withdrawals') {
      const items = [...DB.withdrawals.values()].filter(x => x.status === 'PENDING').slice(-20).reverse();
      const rows = [];
      let text = ['💸 PENDING WITHDRAWALS', '━━━━━━━━━━━━━━━━'];
      if (!items.length) text.push('No pending withdrawals.');
      for (const wd of items) {
        text.push(`💸 ${wd.id}\n👤 ${DB.users.get(String(wd.tgId))?.firstName || wd.tgId}\n💵 ${Number(wd.amount).toFixed(2)} BIRR · ${wd.method}\n👤 ${wd.name}\n📱 ${wd.destination}`);
        rows.push([{ text: `✅ Paid ${wd.id.slice(0, 8)}`, callback_data: `adm:wd:paid:${wd.id}` }, { text: '❌ Reject', callback_data: `adm:wd:reject:${wd.id}` }]);
      }
      rows.push([{ text: '🔄 Refresh', callback_data: 'adm:withdrawals' }, { text: '⬅️ Back', callback_data: 'adm:home' }]);
      return this.sendMessage(tgId, text.join('\n\n'), { reply_markup: { inline_keyboard: rows } });
    }
    if (type === 'games') {
      const room = roomManager.room;
      return this.sendMessage(tgId, `🎮 CURRENT GAME\n━━━━━━━━━━━━━━━━\nStatus: ${room.status}\nPlayers: ${room.players.size || room.reservations.size}\nCartelas: ${room.players.size ? [...room.players.values()].reduce((n, p) => n + p.cartelas.length, 0) : room.reservations.size}\nPot: ${money(room.pot)} BIRR\nCurrent Number: ${room.calledNumbers.length ? BingoEngine.letterForNumber(room.calledNumbers[room.calledNumbers.length - 1]) + ' ' + room.calledNumbers[room.calledNumbers.length - 1] : '—'}\nCalled: ${room.calledNumbers.length} / 75\nCountdown: ${room.countdown}s`, { reply_markup: this.adminBackKeyboard() });
    }
    if (type === 'promotions') {
      const items = DB.promotions.slice(-10).reverse();
      const text = ['📢 PROMOTIONS', '━━━━━━━━━━━━━━━━', 'Create and send announcements to users.', '', ...items.map(p => `#${p.id.slice(0, 8)} · ${p.language} · ${p.status}\n${p.titleAm || p.titleEn || 'Untitled'}\nSent: ${p.sentCount || 0} · Failed: ${p.failedCount || 0}`)].join('\n\n');
      return this.sendMessage(tgId, text, { reply_markup: { inline_keyboard: [
        [{ text: '➕ New Announcement', callback_data: 'adm:promo:new' }],
        [{ text: '📋 Previous Announcements', callback_data: 'adm:promotions' }],
        [{ text: '📊 Promotion Statistics', callback_data: 'adm:promo:stats' }],
        [{ text: '🔙 Back', callback_data: 'adm:home' }],
      ] } });
    }
    if (type === 'promo-stats') {
      const sent = DB.promotions.reduce((n, p) => n + Number(p.sentCount || 0), 0);
      const failed = DB.promotions.reduce((n, p) => n + Number(p.failedCount || 0), 0);
      return this.sendMessage(tgId, `📊 PROMOTION STATISTICS\n━━━━━━━━━━━━━━━━\nAnnouncements: ${DB.promotions.length}\n✅ Sent: ${sent}\n❌ Failed: ${failed}`, { reply_markup: this.adminBackKeyboard() });
    }
    const approvedDeposits = [...DB.deposits.values()].filter(x => x.status === 'APPROVED').reduce((n, x) => n + Number(x.amount || 0), 0);
    const paidWithdrawals = [...DB.withdrawals.values()].filter(x => x.status === 'PAID').reduce((n, x) => n + Number(x.amount || 0), 0);
    const gamesPlayed = [...DB.users.values()].reduce((n, x) => n + Number(x.gamesPlayed || 0), 0);
    const cardsSold = [...DB.users.values()].reduce((n, x) => n + Number(x.cartelasPurchased || 0), 0);
    const prizes = DB.transactions.filter(x => x.type === 'GAME_PRIZE').reduce((n, x) => n + Number(x.amount || 0), 0);
    return this.sendMessage(tgId, `📊 STATISTICS\n━━━━━━━━━━━━━━━━\n👥 Total Users: ${DB.users.size}\n💰 Approved Deposits: ${money(approvedDeposits)} BIRR\n💸 Paid Withdrawals: ${money(paidWithdrawals)} BIRR\n🎮 Games Played: ${gamesPlayed}\n🎟️ Cartelas Sold: ${cardsSold}\n🏆 Total Prize Paid: ${money(prizes)} BIRR\n💰 House Revenue: ${money(approvedDeposits - paidWithdrawals - prizes)} BIRR`, { reply_markup: this.adminBackKeyboard() });
  }

  async broadcastPromotion(tgId, promotion) {
    if (!this.isAdmin(tgId)) return this.sendMessage(tgId, '⛔ Access denied.');
    const users = [...DB.users.values()];
    let sent = 0;
    let failed = 0;
    for (const user of users) {
      const text = user.language === 'am' ? (promotion.titleAm ? `📢 ${promotion.titleAm}\n\n${promotion.messageAm || ''}` : `${promotion.titleEn}\n\n${promotion.messageEn || ''}`) : (promotion.titleEn ? `📢 ${promotion.titleEn}\n\n${promotion.messageEn || ''}` : `${promotion.titleAm}\n\n${promotion.messageAm || ''}`);
      try {
        const result = await this.sendMessage(user.tgId, text);
        if (result && result.ok) sent++; else failed++;
      } catch (e) { failed++; console.error('[Promotion] send failed:', user.tgId, e.message); }
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    promotion.sentCount = sent;
    promotion.failedCount = failed;
    promotion.status = 'SENT';
    promotion.sentAt = new Date().toISOString();
    saveDB();
    return this.sendMessage(tgId, `📢 BROADCAST COMPLETED\n\n👥 Total users: ${users.length}\n✅ Sent: ${sent}\n❌ Failed: ${failed}`, { reply_markup: this.adminBackKeyboard() });
  }

  async handleUpdate(update) {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const msg = update.message;
    if (!msg?.from) return;
    const tgId = String(msg.from.id);
    const user = getOrCreateUser(tgId, msg.from);
    const admin = this.isAdmin(tgId);
    const text = String(msg.text || '').trim();
    const pending = this.pending.get(tgId);

    if (admin && (text.includes('👑') || /^\/admin$/i.test(text))) {
      return this.showAdminDashboard(tgId);
    }
    if (!admin && (text.includes('👑 Admin') || text.includes('የአስተዳዳሪ'))) {
      return this.sendMessage(tgId, '⛔ Access denied.', { reply_markup: this.mainKeyboard(tgId) });
    }

    if (msg.contact) {
      user.phone = msg.contact.phone_number;
      user.isRegistered = true;
      let bonusText = '';
      if (!user.registrationBonusGranted) {
        user.registrationBonusGranted = true;
        user.balance = money(user.balance + 10);
        user.playBalance = money(user.playBalance + 10);
        saveDB();
        bonusText = '\n\n🎁 +10.00 BIRR bonus!';
      }
      return this.sendMessage(tgId, `🎉 Phone verified!${bonusText}`, { reply_markup: this.mainKeyboard(tgId) });
    }

    if (admin && pending?.type === 'promotion' && text) {
      if (pending.step === 'title' || pending.step === 'titleAm') {
        pending[pending.step] = text.slice(0, 200);
        pending.step = pending.language === 'both' ? (pending.step === 'titleAm' ? 'messageAm' : 'message') : 'message';
        return this.sendMessage(tgId, pending.step === 'messageAm' ? 'Send Amharic message:' : `Send ${pending.language === 'am' ? 'Amharic' : 'English'} message:`);
      }
      if (pending.step === 'message') {
        pending[pending.language === 'am' ? 'messageAm' : 'messageEn'] = text.slice(0, 4000);
        if (pending.language === 'both') { pending.step = 'titleEn'; return this.sendMessage(tgId, 'Send English title:'); }
        pending.step = 'preview';
      } else if (pending.step === 'messageAm') {
        pending.messageAm = text.slice(0, 4000);
        pending.step = 'titleEn';
        return this.sendMessage(tgId, 'Send English title:');
      } else if (pending.step === 'titleEn') {
        pending.titleEn = text.slice(0, 200);
        pending.step = 'messageEn';
        return this.sendMessage(tgId, 'Send English message:');
      } else if (pending.step === 'messageEn') {
        pending.messageEn = text.slice(0, 4000);
        pending.step = 'preview';
      }
      if (pending.step === 'preview') {
        const promotion = { id: crypto.randomUUID(), language: pending.language, titleAm: pending.titleAm, messageAm: pending.messageAm, titleEn: pending.titleEn, messageEn: pending.messageEn, createdAt: new Date().toISOString(), createdBy: tgId, status: 'DRAFT', sentCount: 0, failedCount: 0 };
        DB.promotions.push(promotion);
        this.pending.delete(tgId);
        saveDB();
        return this.sendMessage(tgId, `📢 ANNOUNCEMENT PREVIEW\n\n${promotion.titleAm || promotion.titleEn}\n\n${promotion.messageAm || promotion.messageEn}`, { reply_markup: { inline_keyboard: [[{ text: '📢 Send to Users', callback_data: `adm:promo:send:${promotion.id}` }], [{ text: '❌ Cancel', callback_data: 'adm:promotions' }]] } });
      }
    }

    // --- DEPOSIT state machine ---
    if (pending?.type === 'deposit') {
      if (pending.step === 'amount' && text) {
        const amount = Number(text.replace(/,/g, ''));
        if (!Number.isFinite(amount) || amount <= 0) {
          return this.sendMessage(tgId, '⚠️ Enter a valid deposit amount in BIRR.');
        }
        pending.amount = money(amount);
        pending.step = 'method';
        return this.sendMessage(tgId, `💳 *Deposit ${pending.amount.toFixed(2)} BIRR*\n\nChoose payment method:`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '📱 Telebirr', callback_data: 'dep:method:Telebirr' }],
            [{ text: '🏦 CBE',     callback_data: 'dep:method:CBE' }],
            [{ text: '❌ Cancel',  callback_data: 'flow:cancel' }],
          ] },
        });
      }
      if (pending.step === 'reference' && (text || msg.photo)) {
        const id = crypto.randomUUID();
        const reference = text || `PHOTO_${msg.photo[msg.photo.length - 1].file_id}`;
        DB.deposits.set(id, {
          id, tgId,
          amount: pending.amount,
          method: pending.method,
          name: '',
          reference,
          status: 'PENDING',
          createdAt: new Date().toISOString(),
        });
        this.pending.delete(tgId);
        saveDB();
        if (CONFIG.ADMIN_TELEGRAM_ID) {
          await this.sendMessage(CONFIG.ADMIN_TELEGRAM_ID,
            `🔔 *DEPOSIT REQUEST*\n\nUser:  ${user.firstName} (${tgId})\nAmount: ${pending.amount.toFixed(2)} BIRR\nMethod: ${pending.method}\nRef:   ${reference}\nID:    ${id}`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
              [{ text: '✅ Approve', callback_data: `dep:approve:${id}` }],
              [{ text: '❌ Reject',  callback_data: `dep:reject:${id}` }],
            ] } });
        }
        return this.sendMessage(tgId,
          `⏳ *Deposit submitted*\n\nAmount: ${pending.amount.toFixed(2)} BIRR\nMethod: ${pending.method}\nRef: ${reference}\n\nBalance will be credited after admin approval.`,
          { parse_mode: 'Markdown', reply_markup: this.mainKeyboard(tgId) });
      }
      return this.sendMessage(tgId, '⚠️ Please answer the current step or tap Cancel.', { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'flow:cancel' }]] } });
    }

    // --- WITHDRAW state machine ---
    if (pending?.type === 'withdraw') {
      if (pending.step === 'amount' && text) {
        const amount = Number(text.replace(/,/g, ''));
        if (!Number.isFinite(amount) || amount < CONFIG.MIN_WITHDRAWAL) {
          return this.sendMessage(tgId, `⚠️ Minimum withdrawal is ${CONFIG.MIN_WITHDRAWAL} BIRR.`);
        }
        syncAvailableWallet(user);
        const maxAllowed = money(user.playBalance);
        if (amount > maxAllowed) {
          return this.sendMessage(tgId, `⚠️ You can withdraw at most ${maxAllowed.toFixed(2)} BIRR.`);
        }
        pending.amount = money(amount);
        pending.step = 'name';
        return this.sendMessage(tgId, `💸 *Withdraw ${pending.amount.toFixed(2)} BIRR*\n\nSend the *full name* on the receiving account.`, { parse_mode: 'Markdown' });
      }
      if (pending.step === 'name' && text) {
        pending.name = text.slice(0, 100);
        pending.step = 'method';
        return this.sendMessage(tgId, `💸 Choose withdrawal method:`, {
          reply_markup: { inline_keyboard: [
            [{ text: '📱 Telebirr', callback_data: 'wd:method:Telebirr' }],
            [{ text: '🏦 CBE',     callback_data: 'wd:method:CBE' }],
            [{ text: '❌ Cancel',  callback_data: 'flow:cancel' }],
          ] },
        });
      }
      if (pending.step === 'destination' && text) {
        const id = crypto.randomUUID();
        const amount = pending.amount;
        syncAvailableWallet(user);
        if (user.playBalance < amount) {
          this.pending.delete(tgId);
          return this.sendMessage(tgId, '⚠️ Insufficient balance.', { reply_markup: this.mainKeyboard(tgId) });
        }
        user.playBalance = money(user.playBalance - amount);
        user.balance = money(user.balance - amount);
        user.reservedBalance = money((user.reservedBalance || 0) + amount);
        DB.withdrawals.set(id, {
          id, tgId,
          amount,
          method: pending.method,
          name: pending.name,
          destination: text,
          status: 'PENDING',
          createdAt: new Date().toISOString(),
        });
        this.pending.delete(tgId);
        saveDB();
        if (CONFIG.ADMIN_TELEGRAM_ID) {
          await this.sendMessage(CONFIG.ADMIN_TELEGRAM_ID,
            `🔔 *WITHDRAWAL REQUEST*\n\nUser:  ${user.firstName} (${tgId})\nName:  ${pending.name}\nAmount: ${amount.toFixed(2)} BIRR\nMethod: ${pending.method}\nDest:   ${text}\nID:    ${id}`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
              [{ text: '✅ Paid',   callback_data: `wd:paid:${id}` }],
              [{ text: '❌ Reject', callback_data: `wd:reject:${id}` }],
            ] } });
        }
        return this.sendMessage(tgId,
          `⏳ *Withdrawal submitted*\n\nAmount: ${amount.toFixed(2)} BIRR\nMethod: ${pending.method}\nTo: ${text}\n\nReserved until admin pays.`,
          { parse_mode: 'Markdown', reply_markup: this.mainKeyboard(tgId) });
      }
      return this.sendMessage(tgId, '⚠️ Please answer the current step or tap Cancel.', { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'flow:cancel' }]] } });
    }

    if (text.startsWith('/start')) {
      const payload = text.split(' ')[1] || '';
      if (payload.startsWith('ref_') && !user.referredBy) {
        user.referredBy = payload.slice(4);
        saveDB();
      }
      if (admin) return this.showAdminDashboard(tgId);
      if (!user.isRegistered) {
        return this.sendMessage(tgId, `👑 *SHISHO BINGO*\n\nShare your phone to get a *10 BIRR* welcome bonus.`, {
          parse_mode: 'Markdown',
          reply_markup: { keyboard: [[{ text: '📱 Share Phone', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
        });
      }
      return this.sendMessage(tgId, `👋 Welcome back, ${user.firstName}!`, { reply_markup: this.mainKeyboard(tgId) });
    }

    if (!admin && !user.isRegistered) {
      return this.sendMessage(tgId, '⚠️ Please share your phone number first using /start.', {
        reply_markup: { keyboard: [[{ text: '📱 Share Phone', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
      });
    }

    const isPlay      = text.includes('🎮') || /^play$/i.test(text);
    const isBalance   = text.includes('💰') || /balance|wallet/i.test(text);
    const isProfile   = text.includes('👤') || /^profile$/i.test(text);
    const isDeposit   = text.includes('💳') || /^deposit$/i.test(text);
    const isWithdraw  = text.includes('💸') || /^withdraw$/i.test(text);
    const isInvite    = text.includes('🔗') || /^invite$/i.test(text);
    const isSupport   = text.includes('💬') || /^support$/i.test(text);
    const isChannel   = text.includes('📢') || /^channel$/i.test(text);
    const isLanguage  = text.includes('🌐') || /^language$/i.test(text);

    if (isLanguage) {
      return this.sendMessage(tgId, '🌐 Choose your language / ቋንቋዎን ይምረጡ:', {
        reply_markup: { inline_keyboard: [
          [{ text: '🇪🇹 አማርኛ', callback_data: 'lang:set:am' }],
          [{ text: '🇬🇧 English', callback_data: 'lang:set:en' }],
        ] },
      });
    }

    if (isPlay) {
      return this.sendMessage(tgId, '🎯 Tap to open the game:', {
        reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game', web_app: { url: this.webAppUrl() } }]] },
      });
    }

    if (isBalance) {
      let balanceUser = user;
      if (DATABASE_ENABLED || process.env.VERCEL) {
        try {
          assertDatabaseConfigured();
          const persistedResult = await findOrCreateUserByTgId({
            tgId: user.tgId,
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            language: user.language === 'en' ? 'en' : 'am',
          });
          const databaseUser = persistedResult.user;
          const databaseWallet = await getUserBalance(user.tgId);
          if (!databaseUser || !databaseWallet) throw new Error('User wallet not found.');
          const availableBalance = getAvailableWalletBalance(databaseWallet);
          logWalletDebug('[BOT WALLET]', user.tgId, {
            databaseUserId: walletLogId(databaseUser.id),
            databaseBalance: databaseWallet.balance,
            databasePlayBalance: databaseWallet.play_balance,
            databaseReservedBalance: databaseWallet.reserved_balance,
            availableBalance,
            source: 'tidb',
          });
          balanceUser = {
            ...user,
            balance: Number(databaseWallet.balance),
            playBalance: availableBalance,
            reservedBalance: Number(databaseWallet.reserved_balance),
          };
        } catch (error) {
          console.error('[BOT WALLET] database lookup failed', JSON.stringify({ telegramId: walletLogId(user.tgId), message: error.message }));
          return this.sendMessage(tgId, 'Wallet temporarily unavailable. Please try again.');
        }
      } else {
        logWalletDebug('[BOT WALLET]', user.tgId, {
          databaseUserId: null,
          databaseBalance: user.balance,
          databasePlayBalance: user.playBalance,
          databaseReservedBalance: user.reservedBalance,
          availableBalance: getAvailableWalletBalance(user),
          source: 'local-json',
        });
      }
      return this.sendMessage(tgId, this.formatBalanceMessage(balanceUser), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '💳 Deposit', web_app: { url: this.webAppUrl('wallet') } }],
          [{ text: '💸 Withdraw', web_app: { url: this.webAppUrl('wallet') } }],
        ] },
      });
    }

    if (isProfile) {
      syncAvailableWallet(user);
      return this.sendMessage(tgId,
        `👤 *Your Profile*\n\nName:     ${user.firstName} ${user.lastName || ''}\nID:       ${user.tgId}\nUsername: ${user.username ? '@' + user.username : '—'}\nGames:    ${user.gamesPlayed || 0}\nWins:     ${user.totalWins || 0}\nWinnings: ${money(user.totalWinnings).toFixed(2)} BIRR\nBalance:  ${money(user.balance).toFixed(2)} BIRR`,
        { parse_mode: 'Markdown', reply_markup: this.mainKeyboard(tgId) });
    }

    if (isDeposit) {
      this.pending.set(tgId, { type: 'deposit', step: 'amount' });
      return this.sendMessage(tgId, `💳 *Deposit*\n\nEnter the amount in BIRR (e.g. 100):`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'flow:cancel' }]] },
      });
    }

    if (isWithdraw) {
      syncAvailableWallet(user);
      this.pending.set(tgId, { type: 'withdraw', step: 'amount' });
      return this.sendMessage(tgId,
        `💸 *Withdraw*\n\nAvailable: *${money(user.playBalance).toFixed(2)} BIRR*\nMinimum: ${CONFIG.MIN_WITHDRAWAL} BIRR\nMust retain: ${CONFIG.MIN_RESERVE_BALANCE} BIRR\n\nEnter the amount:`,
        { parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'flow:cancel' }]] } });
    }

    if (isInvite) {
      const botUsername = this.botInfo?.username || 'ShishoBingoBot';
      const link = `https://t.me/${botUsername}?start=ref_${tgId}`;
      const count = [...DB.users.values()].filter(u => String(u.referredBy) === String(tgId)).length;
      return this.sendMessage(tgId,
        `🔗 *Invite Friends*\n\nYour referral link:\n\`${link}\`\n\nPlayers who joined with your link: *${count}*`,
        { parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join me on Shisho Bingo!')}` },
          ]] } });
    }

    if (isSupport) {
      const support = String(CONFIG.SUPPORT_USERNAME || '@bigbards').replace(/^@/, '');
      return this.sendMessage(tgId, `💬 *Support*\n\nContact us: @${support}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '💬 Message Support', url: `https://t.me/${support}` }]] },
      });
    }

    if (isChannel) {
      return this.sendMessage(tgId, `📢 *Official Channel*\n\nJoin for announcements and updates.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '📢 Open Channel', url: CONFIG.CHANNEL_URL }]] },
      });
    }

    return this.sendMessage(tgId, '🎯 Choose an option below.', { reply_markup: this.mainKeyboard(tgId) });
  }

  async handleCallback(query) {
    const tgId = String(query.from.id);
    const data = String(query.data || '');
    await this.api('answerCallbackQuery', { callback_query_id: query.id });
    const admin = this.isAdmin(tgId);
    const user = DB.users.get(tgId);

    if (data.startsWith('adm:')) {
      if (!admin) return this.sendMessage(tgId, '⛔ Access denied.');
      if (data === 'adm:home') return this.showAdminDashboard(tgId);
      if (data === 'adm:users') return this.showAdminList(tgId, 'users');
      if (data === 'adm:deposits') return this.showAdminList(tgId, 'deposits');
      if (data === 'adm:withdrawals') return this.showAdminList(tgId, 'withdrawals');
      if (data === 'adm:games') return this.showAdminList(tgId, 'games');
      if (data === 'adm:stats') return this.showAdminList(tgId, 'stats');
      if (data === 'adm:promotions') return this.showAdminList(tgId, 'promotions');
      if (data === 'adm:promo:stats') return this.showAdminList(tgId, 'promo-stats');
      if (data === 'adm:promo:new') {
        this.pending.set(tgId, { type: 'promotion', step: 'language' });
        return this.sendMessage(tgId, '📢 New Announcement\n\nChoose language:', { reply_markup: { inline_keyboard: [
          [{ text: '🇪🇹 Amharic', callback_data: 'adm:promo:lang:am' }, { text: '🇬🇧 English', callback_data: 'adm:promo:lang:en' }],
          [{ text: '🌍 Both', callback_data: 'adm:promo:lang:both' }, { text: '🔙 Cancel', callback_data: 'adm:promotions' }],
        ] } });
      }
      if (data.startsWith('adm:promo:lang:')) {
        const language = data.split(':')[3];
        this.pending.set(tgId, { type: 'promotion', step: language === 'both' ? 'titleAm' : 'title', language });
        return this.sendMessage(tgId, language === 'both' ? 'Send Amharic title:' : `Send ${language === 'am' ? 'Amharic' : 'English'} title:`);
      }
      if (data.startsWith('adm:promo:send:')) {
        const id = data.split(':')[3];
        const promotion = DB.promotions.find(item => item.id === id && item.status === 'DRAFT');
        if (!promotion) return this.sendMessage(tgId, '⚠️ This announcement has already been sent.', { reply_markup: this.adminBackKeyboard() });
        promotion.status = 'SENDING';
        saveDB();
        return this.broadcastPromotion(tgId, promotion);
      }
      const [, kind, action, id] = data.split(':');
      if (kind === 'dep' || kind === 'wd') {
        let record = kind === 'dep' ? DB.deposits.get(id) : DB.withdrawals.get(id);
        if (!record && kind === 'dep' && DATABASE_ENABLED) {
          const depositRow = (await query('SELECT * FROM deposits WHERE id = $1 LIMIT 1', [id])).rows[0];
          if (depositRow) {
            record = {
              id: depositRow.id,
              tgId: depositRow.tg_id,
              amount: Number(depositRow.amount),
              method: depositRow.method,
              reference: depositRow.reference,
              status: depositRow.status,
            };
          }
        }
        if (!record || record.status !== 'PENDING') return this.sendMessage(tgId, '⚠️ This request has already been processed.', { reply_markup: this.adminBackKeyboard() });
        const target = DB.users.get(String(record.tgId)) || getOrCreateUser(record.tgId, {});
        if (!target) return this.sendMessage(tgId, '⚠️ User record not found.', { reply_markup: this.adminBackKeyboard() });
        if (action === 'reject') {
          record.status = 'REJECTED';
          record.rejectedAt = new Date().toISOString();
          record.rejectedBy = tgId;
          if (kind === 'wd') {
            target.reservedBalance = money(Math.max(0, Number(target.reservedBalance || 0) - Number(record.amount || 0)));
            target.balance = money(target.balance + Number(record.amount || 0));
            target.playBalance = money(target.playBalance + Number(record.amount || 0));
            DB.transactions.unshift({ id: crypto.randomUUID(), tgId: target.tgId, type: 'WITHDRAWAL_REFUND', amount: record.amount, status: 'REFUNDED', createdAt: new Date().toISOString() });
          }
          saveDB();
          await this.sendMessage(target.tgId, kind === 'dep' ? `❌ Deposit of ${Number(record.amount).toFixed(2)} BIRR was rejected.` : `❌ Withdrawal of ${Number(record.amount).toFixed(2)} BIRR was rejected and refunded.`, { reply_markup: this.mainKeyboard(target.tgId) });
          return this.showAdminList(tgId, kind === 'dep' ? 'deposits' : 'withdrawals');
        }
        if (kind === 'dep') {
          if (DATABASE_ENABLED) {
            const approved = await approveDepositIfPending({ depositId: id, approvedBy: tgId });
            if (approved.duplicate) return this.sendMessage(tgId, '⚠️ This deposit has already been processed.', { reply_markup: this.adminBackKeyboard() });
            target.balance = money(approved.wallet.balance);
            target.playBalance = money(approved.wallet.balance);
          } else {
            target.balance = money(target.balance + Number(record.amount || 0));
            target.playBalance = money(target.playBalance + Number(record.amount || 0));
          }
          record.status = 'APPROVED';
          record.approvedAt = new Date().toISOString();
          record.approvedBy = tgId;
          if (!DATABASE_ENABLED) DB.transactions.unshift({ id: crypto.randomUUID(), tgId: target.tgId, type: 'DEPOSIT_APPROVED', amount: record.amount, status: 'APPROVED', reference: record.reference, createdAt: new Date().toISOString() });
          saveDB();
          await this.sendMessage(target.tgId, `✅ Deposit Approved\n\n+${Number(record.amount).toFixed(2)} BIRR added.`, { reply_markup: this.mainKeyboard(target.tgId) });
          return this.showAdminList(tgId, 'deposits');
        }
        record.status = 'PAID';
        record.paidAt = new Date().toISOString();
        record.paidBy = tgId;
        target.reservedBalance = money(Math.max(0, Number(target.reservedBalance || 0) - Number(record.amount || 0)));
        DB.transactions.unshift({ id: crypto.randomUUID(), tgId: target.tgId, type: 'WITHDRAWAL_PAID', amount: record.amount, status: 'PAID', createdAt: new Date().toISOString() });
        saveDB();
        await this.sendMessage(target.tgId, `✅ Withdrawal Paid\n\n${Number(record.amount).toFixed(2)} BIRR has been sent to:\n${record.destination}`);
        return this.showAdminList(tgId, 'withdrawals');
      }
    }
    if (!admin && (data.startsWith('dep:approve:') || data.startsWith('dep:reject:') || data.startsWith('wd:paid:') || data.startsWith('wd:reject:'))) {
      return this.sendMessage(tgId, '⛔ Access denied.');
    }

    if (data === 'lang:set:am' || data === 'lang:set:en') {
      if (!user) return;
      user.language = data.endsWith(':am') ? 'am' : 'en';
      saveDB();
      return this.sendMessage(tgId, user.language === 'am' ? '✅ ቋንቋዎ ወደ አማርኛ ተቀይሯል።' : '✅ Language set to English.', { reply_markup: this.mainKeyboard(tgId) });
    }

    if (data === 'flow:cancel') {
      this.pending.delete(tgId);
      return this.sendMessage(tgId, '❌ Cancelled.', { reply_markup: this.mainKeyboard(tgId) });
    }

    if (data.startsWith('dep:method:')) {
      const method = data.split(':')[2];
      const pending = this.pending.get(tgId);
      if (!pending || pending.type !== 'deposit') return;
      pending.method = method;
      pending.step = 'reference';
      return this.sendMessage(tgId,
        `📱 *${method} Deposit*\n\nSend money to:\n` +
        (method === 'Telebirr' ? `• Telebirr: *${CONFIG.TELEBIRR_NUMBER}*` : `• CBE: *${CONFIG.CBE_ACCOUNT}*`) +
        `\n\nThen send us the *transaction ID / reference*.`,
        { parse_mode: 'Markdown' });
    }

    if (data.startsWith('wd:method:')) {
      const method = data.split(':')[2];
      const pending = this.pending.get(tgId);
      if (!pending || pending.type !== 'withdraw') return;
      pending.method = method;
      pending.step = 'destination';
      return this.sendMessage(tgId,
        `💸 *${method} Withdrawal*\n\nSend the ${method === 'Telebirr' ? 'phone number' : 'CBE account number'} to receive the money.`,
        { parse_mode: 'Markdown' });
    }

    if (!admin) return;

    if (data.startsWith('dep:')) {
      const [, action, id] = data.split(':');
      const dep = DB.deposits.get(id);
      if (!dep || dep.status !== 'PENDING') {
        return this.sendMessage(tgId, 'ℹ️ This deposit has already been processed.');
      }
      const target = DB.users.get(String(dep.tgId));
      if (!target) return;
      if (action === 'approve') {
        dep.status = 'APPROVED';
        dep.approvedAt = new Date().toISOString();
        dep.approvedBy = tgId;
        target.balance = money(target.balance + dep.amount);
        target.playBalance = money(target.playBalance + dep.amount);
        DB.transactions.unshift({ id: crypto.randomUUID(), tgId: target.tgId, type: 'DEPOSIT', amount: dep.amount, status: 'APPROVED', reference: dep.reference, createdAt: new Date().toISOString() });
        saveDB();
        await this.sendMessage(target.tgId,
          `✅ *Deposit Approved*\n\n+${dep.amount.toFixed(2)} BIRR added.\nNew balance: ${money(target.balance).toFixed(2)} BIRR`,
          { parse_mode: 'Markdown', reply_markup: this.mainKeyboard(target.tgId) });
        return this.sendMessage(tgId, `✅ Deposit approved.`);
      }
      dep.status = 'REJECTED';
      dep.rejectedAt = new Date().toISOString();
      saveDB();
      await this.sendMessage(target.tgId, `❌ Deposit of ${dep.amount.toFixed(2)} BIRR was rejected.`);
      return this.sendMessage(tgId, `❌ Deposit rejected.`);
    }

    if (data.startsWith('wd:')) {
      const [, action, id] = data.split(':');
      const wd = DB.withdrawals.get(id);
      if (!wd || wd.status !== 'PENDING') {
        return this.sendMessage(tgId, 'ℹ️ This withdrawal has already been processed.');
      }
      const target = DB.users.get(String(wd.tgId));
      if (!target) return;
      if (action === 'paid') {
        wd.status = 'PAID';
        wd.paidAt = new Date().toISOString();
        wd.paidBy = tgId;
        target.reservedBalance = money(Math.max(0, target.reservedBalance - wd.amount));
        DB.transactions.unshift({ id: crypto.randomUUID(), tgId: target.tgId, type: 'WITHDRAWAL_PAID', amount: wd.amount, status: 'PAID', createdAt: new Date().toISOString() });
        saveDB();
        await this.sendMessage(target.tgId,
          `✅ *Withdrawal Paid*\n\n${wd.amount.toFixed(2)} BIRR has been sent to:\n${wd.destination}`,
          { parse_mode: 'Markdown' });
        return this.sendMessage(tgId, `✅ Withdrawal marked paid.`);
      }
      wd.status = 'REJECTED';
      wd.rejectedAt = new Date().toISOString();
      target.reservedBalance = money(Math.max(0, target.reservedBalance - wd.amount));
      target.balance = money(target.balance + wd.amount);
      target.playBalance = money(target.playBalance + wd.amount);
      DB.transactions.unshift({ id: crypto.randomUUID(), tgId: target.tgId, type: 'WITHDRAWAL_REFUND', amount: wd.amount, status: 'REFUNDED', createdAt: new Date().toISOString() });
      saveDB();
      await this.sendMessage(target.tgId,
        `❌ *Withdrawal Rejected*\n\n${wd.amount.toFixed(2)} BIRR has been returned to your wallet.`,
        { parse_mode: 'Markdown', reply_markup: this.mainKeyboard(target.tgId) });
      return this.sendMessage(tgId, `❌ Withdrawal rejected and refunded.`);
    }
  }
}

const bot = new NativeTelegramBot(CONFIG.BOT_TOKEN);

// ---------------------------------------------------------------------------
// HTTP HELPERS
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function sendApiError(res, error) {
  const knownCodes = new Set([
    'DATABASE_UNAVAILABLE', 'TELEGRAM_AUTH_UNAVAILABLE', 'UNAUTHORIZED',
    'ROOM_NOT_FOUND', 'ROOM_STARTED', 'GAME_FINISHED', 'MAX_CARTELAS_REACHED',
    'INSUFFICIENT_BALANCE', 'INVALID_CARTELA', 'CARTELA_NOT_OWNED',
  ]);
  const databaseUnavailable = error.code === 'DATABASE_UNAVAILABLE' || isDatabaseUnavailable(error);
  const authUnavailable = error.code === 'TELEGRAM_AUTH_UNAVAILABLE';
  const unavailable = databaseUnavailable || authUnavailable;
  const databaseError = !!error.code && !knownCodes.has(error.code) && /^[0-9A-Z]{5}$/.test(String(error.code));
  const code = databaseUnavailable ? 'DATABASE_UNAVAILABLE'
    : authUnavailable ? 'TELEGRAM_AUTH_UNAVAILABLE'
    : knownCodes.has(error.code) ? error.code
      : databaseError ? 'DATABASE_ERROR' : 'REQUEST_FAILED';
  const status = unavailable ? 503 : code === 'UNAUTHORIZED' ? 401 : databaseError ? 500 : 400;
  const message = code === 'DATABASE_UNAVAILABLE'
    ? 'Database temporarily unavailable. Please try again.'
    : code === 'DATABASE_ERROR'
      ? 'Request could not be completed.'
      : code === 'TELEGRAM_AUTH_UNAVAILABLE'
      ? 'Telegram authentication is temporarily unavailable.'
      : error.message || 'Request failed.';
  console.error('[API] request failed', JSON.stringify({ code, errorName: error.name }));
  return sendJson(res, status, { ok: false, error: message, code, message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function configuredBotToken() {
  const token = String(CONFIG.BOT_TOKEN || '').trim();
  return token && !token.includes('PASTE_YOUR_') ? token : '';
}

function validateTelegramInitData(initData) {
  const token = configuredBotToken();
  if (!token) return { valid: false, user: null, reason: 'BOT_TOKEN not configured' };
  if (!initData || typeof initData !== 'string') return { valid: false, user: null, reason: 'Missing initData' };
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return { valid: false, user: null, reason: 'Missing hash' };
    const pairs = [];
    for (const [key, value] of params.entries()) if (key !== 'hash') pairs.push(`${key}=${value}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secretKey = crypto.createHmac('sha256', token).update('WebAppData').digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const a = Buffer.from(expectedHash, 'hex');
    const b = Buffer.from(receivedHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, user: null, reason: 'Invalid signature' };
    const authDate = Number(params.get('auth_date'));
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(authDate) || authDate <= 0 || authDate > nowSeconds + 60 || nowSeconds - authDate > 24 * 60 * 60) {
      return { valid: false, user: null, reason: 'Expired Telegram WebApp identity' };
    }
    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch {}
    if (!user?.id || !/^\d{1,20}$/.test(String(user.id))) return { valid: false, user: null, reason: 'No user' };
    return { valid: true, user };
  } catch (e) { return { valid: false, user: null, reason: e.message }; }
}

function authenticationError(message) {
  const error = new Error(message);
  error.code = /bot_token not configured/i.test(message) ? 'TELEGRAM_AUTH_UNAVAILABLE' : 'UNAUTHORIZED';
  return error;
}

function getUserFromRequest(parsed, request = null, options = {}) {
  const authHeader = request?.headers?.['x-telegram-init-data'];
  const initData = String((Array.isArray(authHeader) ? authHeader[0] : authHeader) || '');
  if (initData) {
    const verified = validateTelegramInitData(initData);
    if (verified.valid) return getOrCreateUser(String(verified.user.id), verified.user);
    logWalletDebug('[MINIAPP AUTH]', 'unverified', { authSource: 'initData', authValid: false, reason: verified.reason || 'invalid' });
    throw authenticationError(verified.reason || 'Invalid Telegram WebApp identity.');
  }
  if (options.requireInitData || DATABASE_ENABLED || process.env.VERCEL) throw authenticationError('Validated Telegram WebApp identity is required.');
  const tgId = String(parsed.query.tgId || '');
  if (!tgId) throw authenticationError('Missing Telegram user ID.');
  return getOrCreateUser(tgId, {
    first_name: parsed.query.firstName || '',
    last_name: parsed.query.lastName || '',
    username: parsed.query.username || '',
  });
}

async function getUserFromBody(body, request = null) {
  const authHeader = request?.headers?.['x-telegram-init-data'];
  const initData = String((Array.isArray(authHeader) ? authHeader[0] : authHeader) || body?.initData || '');
  if (initData) {
    const verified = validateTelegramInitData(initData);
    if (verified.valid) return getOrCreateUser(String(verified.user.id), verified.user);
    logWalletDebug('[MINIAPP AUTH]', 'unverified', { authSource: 'initData', authValid: false, reason: verified.reason || 'invalid' });
    throw authenticationError(verified.reason || 'Invalid Telegram WebApp identity.');
  }
  const tgId = String(body?.tgId || '');
  if (DATABASE_ENABLED || process.env.VERCEL || !tgId) {
    logWalletDebug('[MINIAPP AUTH]', 'unverified', { authSource: 'body-tgId', authValid: false, reason: 'verified initData required' });
    throw authenticationError('Validated Telegram WebApp identity is required.');
  }
  return getOrCreateUser(tgId, {
    first_name: body?.firstName || '',
    last_name: body?.lastName || '',
    username: body?.username || '',
  });
}

function renderStaticPickerGrid(bootstrap) {
  const user = bootstrap?.user || {};
  const room = bootstrap?.room || {};
  const selectedSet = new Set((bootstrap?.selectedCartelas || []).map(Number));
  const reservations = Array.isArray(room.reservedCartelas) ? room.reservedCartelas : [];
  const reserved = new Map(reservations.map(x => [Number(x.id), String(x.tgId)]));
  const tgId = String(user.tgId || '');
  const rawAvailable = Number(user.availableBalance);
  const balance = Number.isFinite(rawAvailable) ? rawAvailable : Math.max(0, Number(user.balance || 0) - Number(user.reservedBalance || 0));
  let html = '';
  for (let i = 1; i <= 100; i++) {
    const mine = selectedSet.has(i);
    const other = reserved.has(i) && reserved.get(i) !== tgId;
    const cls = 'card-option' + (mine ? ' selected' : '') + (other ? ' taken' : '') + (!mine && !other && balance < CONFIG.STAKE_PRICE ? ' unavailable' : '');
    html += `<button type="button" class="${cls}" data-cartela="${i}" ${other ? 'disabled' : ''}>${i}</button>`;
  }
  return html;
}

const MINI_APP_TRANSLATIONS = {
  en: {
    play: 'Play', wallet: 'Wallet', history: 'History', settings: 'Settings',
    join: 'JOIN +', room: 'Room', availableRoom: 'AVAILABLE ROOM', players: 'Players',
    pot: 'Pot BIRR', status: 'Status', waiting: 'WAITING', cartelas: 'CARTELAS',
    selectCartelas: 'SELECT CARTELAS', balance: 'Balance', cost: 'Cost', starts: 'Starts',
    selected: 'selected', leaveRoom: '← Leave Room', refresh: '↻ Refresh',
    deposit: '💳 Deposit', withdraw: '💸 Withdraw', historyTitle: 'GAME HISTORY',
    settingsTitle: 'SETTINGS', callerAudio: '🔊 Caller Audio', callerAudioHint: 'Hear each called number',
    vibration: '📳 Vibration', vibrationHint: 'Vibrate on each call & win',
    autoMark: '⚡ Auto-Marking', autoMarkHint: 'Numbers are marked automatically',
    language: '🌐 Language', languageHint: 'App display language', english: 'English', amharic: 'Amharic',
    winner: 'winner', verified: 'Verified BINGO', nextRound: 'Next round in',
    static: {},
  },
  am: {
    play: 'ጨዋታ', wallet: 'ቦርሳ', history: 'ታሪክ', settings: 'ቅንብሮች',
    join: 'ተቀላቀል +', room: 'ክፍል', availableRoom: 'ያለ ክፍል', players: 'ተጫዋቾች',
    pot: 'ጠቅላላ ብር', status: 'ሁኔታ', waiting: 'በመጠበቅ', cartelas: 'ካርቴላዎች',
    selectCartelas: 'ካርቴላ ይምረጡ', balance: 'ቀሪ ሂሳብ', cost: 'ወጪ', starts: 'ይጀምራል',
    selected: 'ተመርጧል', leaveRoom: '← ክፍሉን ተው', refresh: '↻ አድስ',
    deposit: '💳 ገንዘብ ያስገቡ', withdraw: '💸 ገንዘብ ያውጡ', historyTitle: 'የጨዋታ ታሪክ',
    settingsTitle: 'ቅንብሮች', callerAudio: '🔊 የጠሪ ድምፅ', callerAudioHint: 'እያንዳንዱን የተጠራ ቁጥር ይስሙ',
    vibration: '📳 ንዝረት', vibrationHint: 'በእያንዳንዱ ጥሪ እና ድል ይንዝር',
    autoMark: '⚡ ራስ-ምልክት', autoMarkHint: 'ቁጥሮች በራስ-ሰር ምልክት ይደረጋሉ',
    language: '🌐 ቋንቋ', languageHint: 'የመተግበሪያ ቋንቋ', english: 'English', amharic: 'አማርኛ',
    winner: 'አሸናፊ', verified: 'የተረጋገጠ ቢንጎ', nextRound: 'ቀጣዩ ዙር በ',
    static: {
      'Play. Win. Enjoy!': 'ይጫወቱ። ያሸንፉ። ይደሰቱ!',
      '🏆 REAL-TIME': '🏆 በቀጥታ', '🎟 MULTIPLE ROOMS': '🎟 ብዙ ክፍሎች', '💰 INSTANT REWARDS': '💰 ፈጣን ሽልማት',
      '75-Ball Classic • Max 20 Players': '75 ኳስ ክላሲክ • ከፍተኛ 20 ተጫዋቾች',
      '🎁 PLAY SMART': '🎁 በጥበብ ይጫወቱ', 'Choose up to 2 cartelas. Each cartela costs 10 BIRR.': 'እስከ 2 ካርቴላ ይምረጡ። እያንዳንዱ ካርቴላ 10 ብር ነው።',
      'Select 1–2': '1–2 ይምረጡ', 'selected': 'ተመርጧል', 'Tap a selected cartela again to refund 10 BIRR': 'የተመረጠ ካርቴላን እንደገና ይንኩ 10 ብር ለመመለስ',
      'Recent calls': 'የቅርብ ጥሪዎች', 'Waiting...': 'በመጠበቅ ላይ...', '75-BALL': '75 ኳስ', 'YOUR CARTELAS': 'የእርስዎ ካርቴላዎች',
      'AUTO-MARK': 'ራስ-ምልክት', 'WATCHING ONLY': 'በመመልከት ብቻ', 'This round has already started.': 'ይህ ዙር አስቀድሞ ተጀምሯል።',
      'BINGO!': 'ቢንጎ!', 'Pot': 'ጠቅላላ ብር', 'MONEY ACTIONS': 'የገንዘብ እርምጃዎች', 'PENDING REQUESTS': 'በመጠባበቅ ላይ ያሉ ጥያቄዎች',
      'No pending requests.': 'በመጠባበቅ ላይ ጥያቄ የለም።', 'AVAILABLE BALANCE': 'የሚገኝ ቀሪ ሂሳብ', 'Reserved': 'የተያዘ', 'Total': 'ጠቅላላ',
      'Profile': 'መገለጫ', 'Games': 'ጨዋታዎች', 'Wins': 'ድሎች', 'Winnings': 'ያገኙት', 'Cards': 'ካርቴላዎች',
      'PREFERENCES': 'ምርጫዎች', 'We have a ': 'አሸናፊ አለን ', 'winner': 'አሸናፊ', 'Next round in': 'ቀጣዩ ዙር በ',
      'Play': 'ጨዋታ', 'Wallet': 'ቦርሳ', 'History': 'ታሪክ', 'Settings': 'ቅንብሮች', 'JOIN +': 'ተቀላቀል +',
      'Room': 'ክፍል', 'Players': 'ተጫዋቾች', 'Status': 'ሁኔታ', 'WAITING': 'በመጠበቅ', 'Balance': 'ቀሪ ሂሳብ',
      'Cost': 'ወጪ', 'Starts': 'ይጀምራል', 'selected': 'ተመርጧል', '← Leave Room': '← ክፍሉን ተው',
      '💳 Deposit': '💳 ገንዘብ ያስገቡ', '💸 Withdraw': '💸 ገንዘብ ያውጡ', 'Deposit': 'ገንዘብ ያስገቡ',
      'Withdraw': 'ገንዘብ ያውጡ', 'GAME HISTORY': 'የጨዋታ ታሪክ', 'SETTINGS': 'ቅንብሮች',
      'Caller Audio': 'የጠሪ ድምፅ', 'Hear each called number': 'እያንዳንዱን የተጠራ ቁጥር ይስሙ',
      'Vibration': 'ንዝረት', 'Vibrate on each call & win': 'በእያንዳንዱ ጥሪ እና ድል ይንዝር',
      'Auto-Marking': 'ራስ-ምልክት', 'Numbers are marked automatically': 'ቁጥሮች በራስ-ሰር ምልክት ይደረጋሉ',
      'Language': 'ቋንቋ', 'App display language': 'የመተግበሪያ ቋንቋ', 'Money Actions': 'የገንዘብ እርምጃዎች',
      'MONEY ACTIONS': 'የገንዘብ እርምጃዎች', 'PENDING REQUESTS': 'በመጠባበቅ ላይ ያሉ ጥያቄዎች',
      'No pending requests.': 'በመጠባበቅ ላይ ጥያቄ የለም።', 'AVAILABLE BALANCE': 'የሚገኝ ቀሪ ሂሳብ',
      'Reserved': 'የተያዘ', 'Total': 'ጠቅላላ', 'Stake': 'ውርርድ', 'Call #': 'ጥሪ #',
      '🚪 Leave': '🚪 ተው', '↻ Refresh': '↻ አድስ', '🎮 Open Game': '🎮 ጨዋታ ክፈት',
      'Verified BINGO': 'የተረጋገጠ ቢንጎ', 'Pot': 'ጠቅላላ ብር', 'No game history yet.': 'እስካሁን የጨዋታ ታሪክ የለም።',
      'Round already started.': 'ዙሩ አስቀድሞ ተጀምሯል።', 'You are not in the active game.': 'ንቁ ጨዋታ ውስጥ አይደሉም።',
      'The game is not running.': 'ጨዋታው እየሰራ አይደለም።', 'Incorrect BINGO.': 'የተሳሰተ ቢንጎ።',
      'Could not deselect': 'መምረጥን መሰረዝ አልተቻለም', 'Could not select cartela': 'ካርቴላ መምረጥ አልተቻለም',
      '⚠️ Maximum 2 cartelas allowed.': '⚠️ ቢበዛ 2 ካርቴላ ብቻ።', '⚠️ Insufficient balance. You need 10.00 BIRR.': '⚠️ ቀሪ ሂሳብ በቂ አይደለም። 10.00 ብር ያስፈልጋል።',
      '🎉 Valid BINGO!': '🎉 ትክክለኛ ቢንጎ!', 'You left the room.': 'ክፍሉን ለቀዋል።', '↩ Left. Refunded.': '↩ ለቀዋል። ተመላሽ ተደርጓል።',
      '🎮 New room ready!': '🎮 አዲስ ክፍል ዝግጁ ነው!', '🔴 Game started!': '🔴 ጨዋታው ተጀምሯል!',
      'Telegram user ID is missing.': 'የቴሌግራም ተጠቃሚ መለያ ጠፍቷል።', 'Could not load your balance.': 'ቀሪ ሂሳብዎን መጫን አልተቻለም።',
      '💳 DEPOSIT': '💳 ገንዘብ ማስገባት', '💸 WITHDRAW': '💸 ገንዘብ ማውጣት', 'PAYMENT METHOD': 'የክፍያ ዘዴ',
      'AMOUNT (BIRR)': 'መጠን (ብር)', 'TRANSACTION ID / SMS': 'የግብይት መለያ / SMS',
      'SUBMIT FOR APPROVAL': 'ለማጽደቅ ላክ', 'WITHDRAWABLE BALANCE': 'የሚወጣ ቀሪ ሂሳብ', 'FULL NAME': 'ሙሉ ስም',
      'DESTINATION / ACCOUNT': 'መድረሻ / ሂሳብ', 'SUBMIT WITHDRAWAL': 'ማውጣት ላክ', '← Wallet': '← ቦርሳ',
      'WIN': 'ድል', 'LOSS': 'ሽንፈት', 'No pattern': 'ንድፍ የለም', 'No winner': 'አሸናፊ የለም',
      'Games:': 'ጨዋታዎች:', 'Wins:': 'ድሎች:', 'Winnings:': 'ያገኙት:', 'Cards:': 'ካርቴላዎች:',
    },
  },
};

async function renderMiniAppHtml(parsed) {
  let bootstrap = null;
  try {
    if (parsed?.query?.tgId || parsed?.query?.initData) {
      const user = getUserFromRequest(parsed);
      const player = roomManager.getPlayer(user.tgId);
      let databaseUser = null;
      let wallet = {
        balance: user.balance,
        playBalance: user.playBalance,
        reservedBalance: user.reservedBalance,
      };
      if (DATABASE_ENABLED) {
        const persistedResult = await findOrCreateUserByTgId({
          tgId: user.tgId,
          firstName: user.firstName,
          lastName: user.lastName,
          username: user.username,
          language: user.language === 'en' ? 'en' : 'am',
        });
        databaseUser = persistedResult.user;
        if (!databaseUser || String(databaseUser.tg_id) !== String(user.tgId)) {
          throw new Error('Authenticated database user was not found.');
        }
        wallet = await getUserBalance(user.tgId);
        if (!wallet || wallet.balance == null || wallet.play_balance == null || wallet.reserved_balance == null) {
          throw new Error('Authenticated user wallet was not found or is incomplete.');
        }
        user.balance = money(wallet.balance);
        user.playBalance = money(wallet.play_balance);
        user.reservedBalance = money(wallet.reserved_balance);
      } else {
        syncAvailableWallet(user);
      }
      const availableBalance = getAvailableWalletBalance(wallet);
      logWalletDebug('[MINIAPP BALANCE DEBUG]', user.tgId, {
        authenticated: true,
        databaseUserFound: true,
        databaseUserId: databaseUser ? walletLogId(databaseUser.id) : null,
        databaseTgIdMatches: true,
        databaseBalance: wallet.balance,
        databasePlayBalance: wallet.play_balance ?? wallet.playBalance,
        databaseReservedBalance: wallet.reserved_balance ?? wallet.reservedBalance,
        availableBalanceReturned: availableBalance,
        source: DATABASE_ENABLED ? 'tidb' : 'memory',
      });
      logWalletDebug('[BOOTSTRAP DEBUG]', user.tgId, {
        authenticated: true,
        userFound: true,
        balance: wallet.balance,
        availableBalance,
      });
      bootstrap = {
        user: {
          tgId: user.tgId, firstName: user.firstName, lastName: user.lastName, username: user.username,
          balance: money(wallet.balance),
          playBalance: money(wallet.play_balance ?? wallet.playBalance),
          availableBalance,
          reservedBalance: money(wallet.reserved_balance ?? wallet.reservedBalance),
          gamesPlayed: user.gamesPlayed || 0, totalWins: user.totalWins || 0,
          totalWinnings: money(user.totalWinnings || 0),
          cartelasPurchased: user.cartelasPurchased || 0,
          referralEarnings: money(user.referralEarnings || 0),
          isRegistered: !!user.isRegistered,
          accountStatus: user.isRegistered ? 'ACTIVE' : 'UNVERIFIED',
          language: user.language === 'en' ? 'en' : 'am',
          settings: user.settings || { audio: true, vibration: true, autoMark: true },
        },
        room: roomManager.publicState(),
        cartelas: player ? player.cartelas : [],
        selectedCartelas: roomManager.userReservations(user.tgId),
        previewCartelas: roomManager.userReservations(user.tgId).map(id => roomManager.room.reservations.get(id)?.card).filter(Boolean),
        lastWinnerEvent: (roomManager.lastFinishedEvent && (Date.now() - roomManager.lastFinishedAt) < (CONFIG.WINNER_DISPLAY_MS + CONFIG.WINNER_REPLAY_GRACE_MS))
          ? roomManager.lastFinishedEvent : null,
        history: (DB.userGameHistory.get(String(user.tgId)) || []).slice(0, 20),
        ranks: [], // Ranks removed in v38
      };
    }
  } catch (e) {
    console.warn('[Bootstrap] user bootstrap unavailable', JSON.stringify({ error: e.message }));
  }

  const startScreen = ['lobby', 'history', 'settings', 'picker', 'game', 'wallet', 'deposit', 'withdraw'].includes(String(parsed?.query?.screen || ''))
    ? String(parsed.query.screen) : 'lobby';

  const json = JSON.stringify(bootstrap || null).replace(/</g, '\\u003c');
  const translations = JSON.stringify(MINI_APP_TRANSLATIONS).replace(/</g, '\\u003c');
  const payment = JSON.stringify({ telebirrNumber: CONFIG.TELEBIRR_NUMBER, cbeAccount: CONFIG.CBE_ACCOUNT });
  const config = `<script>window.__SHISHO_BOOTSTRAP__=${json};window.__SHISHO_TRANS__=${translations};window.__SHISHO_PAYMENT__=${payment};window.__SHISHO_START_SCREEN__=${JSON.stringify(startScreen)};window.__SHISHO_WALLET_DEBUG__=${process.env.WALLET_DEBUG === '1'};</script>`;
  let html = MINI_APP_HTML.replace('</head>', config + '</head>');
  html = html.replace('__PICKER_GRID__', renderStaticPickerGrid(bootstrap));
  return html;
}

// ---------------------------------------------------------------------------
// MINI APP HTML
// ---------------------------------------------------------------------------
const MINI_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#0b0517">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<title>Shisho Bingo</title>
<style>
:root{--bg:#07030f;--panel:#130923;--border:#392061;--gold:#ffd43b;--text:#f8f4ff;--muted:#a99bc2;--green:#22d37d;--red:#ef4b62;--blue:#38a7ff;--purple:#8d4cff}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;width:100%;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
body{min-height:100dvh;overflow:hidden;touch-action:manipulation;overscroll-behavior:none}
button{border:0;cursor:pointer;font:inherit}
a{text-decoration:none;color:inherit}
img,svg{display:block}
.app{height:100dvh;display:flex;flex-direction:column;background:radial-gradient(circle at 20% 0%,rgba(100,44,180,.22),transparent 32%),radial-gradient(circle at 100% 35%,rgba(255,194,38,.08),transparent 28%),var(--bg)}
.header{height:56px;flex:0 0 56px;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;background:rgba(8,3,17,.95);border-bottom:1px solid #281743;position:relative;z-index:20;padding-top:max(8px,env(safe-area-inset-top))}
.brand{display:flex;align-items:center;gap:8px;min-width:0}
.brand-logo{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(145deg,#ffd94a,#d79513);color:#170b27;font-size:17px}
.brand-name{font-weight:1000;font-size:11px;letter-spacing:.8px;color:#ffd83f;line-height:1.1}
.brand-sub{font-size:8px;color:#9f92b8;margin-top:2px}
.wallet{display:flex;align-items:center;gap:5px;border:1px solid #422567;background:#170d29;border-radius:999px;padding:5px 9px;color:#ffd63c;font-weight:900;font-size:10px;white-space:nowrap}
.wallet small{font-size:7px;color:#a696bf}
.content{flex:1;overflow-y:auto;overflow-x:hidden;padding:10px 10px calc(70px + env(safe-area-inset-bottom));-webkit-overflow-scrolling:touch}
.screen{display:none;min-height:100%}
.screen.active{display:block}
.panel{background:linear-gradient(145deg,rgba(25,12,44,.98),rgba(14,7,26,.98));border:1px solid var(--border);border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.22)}
.panel.gold{border-color:#725119}
.section-title{font-size:9px;letter-spacing:1.3px;color:#9b77d0;font-weight:1000;text-transform:uppercase;margin:4px 3px 7px}
.btn-gold{background:linear-gradient(135deg,#ffdc45,#e6a818);color:#1a0c26;font-weight:1000;border-radius:11px;min-height:40px;padding:0 15px;touch-action:manipulation;font-size:12px}
.btn-dark{background:#1b0e31;color:#cfc4df;border:1px solid #352052;border-radius:11px;min-height:40px;padding:0 13px;font-weight:900;touch-action:manipulation;font-size:12px}
.btn-red{background:#5f1930;color:#fff;border:1px solid #a33a52;border-radius:11px;min-height:40px;padding:0 13px;font-weight:900;touch-action:manipulation;font-size:12px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}
.stat{padding:8px 4px;text-align:center;background:#100820;border:1px solid #30204d;border-radius:11px}
.stat-label{font-size:6.5px;color:#8e7ba9;font-weight:900;text-transform:uppercase}
.stat-value{font-size:12px;font-weight:1000;margin-top:2px}
.gold-text{color:var(--gold)}
.green-text{color:var(--green)}
.room{padding:13px;margin-bottom:8px;position:relative;overflow:hidden}
.room:before{content:"";position:absolute;width:100px;height:100px;right:-45px;top:-45px;border-radius:50%;background:rgba(255,207,54,.07)}
.room-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.room-icon{width:43px;height:43px;border-radius:13px;display:grid;place-items:center;background:#211135;border:1px solid #6c4a17;font-size:20px;flex-shrink:0}
.room-name{font-size:12px;font-weight:1000}
.room-desc{font-size:8px;color:#998bab;margin-top:3px}
.room-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:10px}
.meta-box{padding:7px 4px;background:#0e071b;border:1px solid #281942;border-radius:9px;text-align:center}
.meta-box b{display:block;font-size:10px;color:#fff}
.meta-box span{font-size:6.5px;color:#877a9a;text-transform:uppercase}
.hero{padding:16px 14px;text-align:center;margin-bottom:10px;background:radial-gradient(circle at 50% 0%,rgba(145,73,255,.2),transparent 58%),linear-gradient(145deg,#180a2d,#0c0617);border-color:#3e2163}
.hero-crown{font-size:31px}
.hero-title{font-size:19px;font-weight:1000;letter-spacing:1px}
.hero-title span{color:#ffd43b}
.hero-sub{font-size:10px;color:#b4a5c9;margin-top:4px}
.hero-pills{display:flex;justify-content:center;gap:6px;margin-top:12px;flex-wrap:wrap}
.pill{padding:5px 8px;border:1px solid #402465;border-radius:999px;background:#110820;color:#cbbbe0;font-size:7px;font-weight:900}
.selected-preview-wrap{border-top:1px solid #291941;padding:10px;background:rgba(8,3,20,.35)}
.preview-title{display:flex;justify-content:space-between;align-items:center;font-size:8px;font-weight:1000;color:#c8b5df;margin-bottom:8px}
.selected-preview-list{display:grid;gap:9px}
.preview-card{background:#0e071b;border:1px solid #4a2b72;border-radius:14px;padding:9px}
.preview-card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
.preview-card-title{font-size:9px;font-weight:1000;color:#ffd43b}
.preview-card-note{font-size:7px;color:#8f819f}
.preview-bingo-head,.preview-bingo-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.preview-bingo-head div{font-size:8px;font-weight:1000;text-align:center;padding:4px 0;color:#ffd43b}
.preview-bingo-grid div{min-height:29px;display:flex;align-items:center;justify-content:center;border-radius:7px;background:#1a0d2b;border:1px solid #2f1a4c;font-size:9px;font-weight:900;color:#eee7f7}
.preview-bingo-grid .free{background:#ffd43b;color:#170d20;border-color:#ffd43b}
.balance-after{font-size:8px;color:#9b8cab}
.balance-after b{color:#ffd43b}
  .picker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(48px,1fr));gap:7px;padding:10px;max-height:58vh;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch}
.picker-grid .card-form{min-width:0;margin:0}
.picker-grid .card-option{width:100%;min-width:0}
.card-option.unavailable{opacity:.28;filter:saturate(.35);cursor:not-allowed}
.card-option{aspect-ratio:1;border-radius:10px;background:#170b2a;border:1px solid #30204a;color:#a99cb9;font-weight:1000;font-size:11px;touch-action:manipulation}
.card-option.selected{background:linear-gradient(145deg,#27c66d,#159447);color:#07150d;border-color:#61f09a;box-shadow:0 0 13px rgba(39,198,109,.25)}
.card-option.taken{background:linear-gradient(145deg,#8e2638,#5d1425);border-color:#e44d68;color:#ffdce2;cursor:not-allowed;opacity:.9}

.game-shell{display:flex;flex-direction:column;gap:6px}
.game-top{position:sticky;top:-10px;z-index:8;padding-bottom:1px;background:linear-gradient(var(--bg),rgba(7,3,15,.92))}
.live-row{display:flex;align-items:center;justify-content:space-between;gap:6px}
.live-badge{display:flex;align-items:center;gap:5px;color:#ff5669;font-size:8px;font-weight:1000}
.dot{width:6px;height:6px;border-radius:50%;background:#ff4058;box-shadow:0 0 9px #ff4058}
.ball-strip{display:flex;gap:6px;align-items:center;overflow-x:auto;padding:6px;-webkit-overflow-scrolling:touch}
.current-ball{width:46px;height:46px;flex:0 0 46px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 32% 27%,#fff07c,#ffb900 52%,#d98600);color:#241000;font-size:14px;font-weight:1000}
.recent{display:flex;gap:4px;overflow:hidden;flex-wrap:nowrap}
.recent-ball{width:24px;height:24px;flex:0 0 24px;border-radius:50%;display:grid;place-items:center;background:#211037;border:1px solid #57367c;color:#e7dcf5;font-size:7px;font-weight:1000}
.recent-ball.latest{border-color:#ffd43b;color:#ffd43b}

.game-board-layout{display:grid;grid-template-columns:1fr;gap:6px;align-items:start}
@media(min-width:420px){
  .game-board-layout{grid-template-columns:minmax(0,0.85fr) minmax(0,1.15fr)}
}
.caller{padding:6px}
.caller-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.caller-letters{display:grid;grid-template-columns:repeat(5,1fr);gap:2px;margin-bottom:3px}
.caller-letters span{text-align:center;font-size:7px;font-weight:1000;color:#ffd43b}
.caller-title{font-size:7px;font-weight:1000;color:#c5b8d8}
.caller-count{font-size:7px;font-weight:1000;color:#ffd43b}
.caller-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:2px}
.caller-cell{height:19px;border-radius:4px;background:#0e0719;border:1px solid #211337;color:#5c4c70;display:grid;place-items:center;font-size:6.5px;font-weight:900}
.caller-cell.called{background:#22b875;color:#071b11;border-color:#5de6aa}
.caller-cell.current{background:#ffd43b;color:#180b24;border-color:#fff09a}

.cartela-panel{padding:6px}
.cartela-multi{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;width:100%}
.cartela-multi.single{grid-template-columns:1fr;max-width:180px;margin:0 auto}
.game-card-wrap{background:#0d0618;border:1px solid #3b2359;border-radius:10px;padding:6px;min-width:0;overflow:hidden}
.game-card-wrap .card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.game-card-wrap .card-head .card-id{font-size:7px;font-weight:1000;color:#ffd43b}
.game-card-wrap .card-head .card-auto{font-size:6px;color:#22d37d;font-weight:1000}
.game-card-wrap .bingo-head{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;margin-bottom:3px}
.game-card-wrap .bingo-head span{text-align:center;font-size:8px;font-weight:1000;line-height:1}
.game-card-wrap .bingo-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px}
.game-card-wrap .bingo-cell{aspect-ratio:1;min-width:0;padding:0;border-radius:5px;background:#120922;border:1px solid #2e1c48;display:flex;align-items:center;justify-content:center;font-size:clamp(7px,2.1vw,10px);font-weight:1000;color:#e9e0f2;line-height:1;overflow:hidden}
.game-card-wrap .bingo-cell.marked{background:linear-gradient(145deg,#38d58a,#13a964);color:#062014;border-color:#6af0ae}
.game-card-wrap .bingo-cell.free{background:#ffd43b;color:#211000;border-color:#ffe993;font-size:clamp(5px,1.7vw,7px)}

.bingo-action-bar{display:flex;justify-content:center;margin-top:2px}
.bingo-claim-btn{width:100%;max-width:340px;min-height:50px;border-radius:12px;background:linear-gradient(135deg,#ff5a6e,#c7203e);border:1px solid #ff8a97;color:#fff;font-size:14px;font-weight:1000;letter-spacing:1.5px;box-shadow:0 8px 22px rgba(220,43,75,.28);touch-action:manipulation}
.bingo-claim-btn:disabled{opacity:.4;cursor:not-allowed;box-shadow:none;background:linear-gradient(135deg,#4a2230,#2e1420);border-color:#553045;color:#8c6b7c}
.bingo-claim-btn.ready{animation:bingoPulse 1.4s ease-in-out infinite}
@keyframes bingoPulse{0%,100%{box-shadow:0 8px 22px rgba(220,43,75,.28)}50%{box-shadow:0 8px 32px rgba(255,90,110,.55)}}

.watch{padding:16px;text-align:center}
.watch-icon{font-size:27px}
.watch-title{font-size:11px;font-weight:1000;color:#ffd43b;margin-top:4px}
.watch-copy{font-size:8px;color:#998ba9;margin-top:4px;line-height:1.5}

.profile-card{padding:14px;display:flex;gap:11px;align-items:center}
.avatar{width:45px;height:45px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(145deg,#ffd93d,#c98b11);color:#1b0d27;font-size:18px;font-weight:1000;flex-shrink:0}
.profile-name{font-size:13px;font-weight:1000}
.profile-id{font-size:8px;color:#9586a9;margin-top:3px}
.profile-bal{font-size:9px;margin-top:4px}
.setting{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid #25173a;font-size:10px}
.setting:last-child{border-bottom:0}
.setting-label{display:flex;align-items:center;gap:8px;color:#e8dcf5;font-weight:900}
.setting-hint{font-size:7px;color:#7d6f92;margin-top:2px;font-weight:400}
.switch{width:34px;height:20px;border-radius:99px;background:#30213f;position:relative;transition:.2s;flex-shrink:0}
.switch:after{content:"";width:16px;height:16px;border-radius:50%;background:#8c7d9d;position:absolute;top:2px;left:2px;transition:.2s}
.switch.on{background:#5a4014}
.switch.on:after{left:16px;background:#ffd43b}
.switch.locked{opacity:.85;cursor:not-allowed}

.app.in-picker .bottom-nav{display:none}
.app.in-game .bottom-nav{display:none}
.bottom-nav{position:fixed;bottom:0;left:0;right:0;height:56px;padding:6px 5px calc(6px + env(safe-area-inset-bottom));background:rgba(10,5,20,.97);border-top:1px solid #281743;display:grid;grid-template-columns:repeat(4,1fr);z-index:30}
.nav-btn{background:none;color:#806f99;font-size:7px;font-weight:1000;display:flex;flex-direction:column;align-items:center;gap:3px;touch-action:manipulation}
.nav-btn .ico{font-size:16px}
.nav-btn.active{color:#ffd43b}

#winner-overlay{
  position:fixed;inset:0;z-index:9999;display:none;flex-direction:column;align-items:center;
  padding:calc(20px + env(safe-area-inset-top)) 12px calc(20px + env(safe-area-inset-bottom));
  overflow-y:auto;-webkit-overflow-scrolling:touch;
  background:radial-gradient(circle at 50% 12%,rgba(145,73,255,.35),transparent 55%),
             radial-gradient(circle at 50% 100%,rgba(255,190,40,.10),transparent 55%),
             linear-gradient(180deg,#0f0723,#07030f);
}
#winner-overlay.show{display:flex}
.winner-crown-big{
  width:clamp(60px,20vw,90px);height:clamp(60px,20vw,90px);border-radius:50%;
  display:grid;place-items:center;flex-shrink:0;
  background:radial-gradient(circle at 40% 35%,#2a1748,#150a2b);
  border:2px solid #8b631d;
  box-shadow:0 0 40px rgba(255,190,40,.35),inset 0 0 30px rgba(255,190,40,.15);
  font-size:clamp(28px,9vw,44px);
  filter:drop-shadow(0 0 12px rgba(255,212,59,.6));
  animation:crownPop .6s cubic-bezier(.2,1.4,.5,1) both;
}
@keyframes crownPop{0%{transform:scale(.3);opacity:0}100%{transform:scale(1);opacity:1}}
.winner-headline{
  font-size:clamp(30px,10vw,46px);font-weight:1000;letter-spacing:clamp(2px,1vw,5px);margin-top:14px;
  background:linear-gradient(180deg,#ffe07a 0%,#ffb800 60%,#ff8c00 100%);
  -webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;
  line-height:1;text-align:center;
  filter:drop-shadow(0 0 20px rgba(255,180,0,.5));
}
.winner-subline{font-size:clamp(10px,3vw,12px);color:#c7b8dc;letter-spacing:.5px;margin-top:10px;text-align:center}
.winner-subline .em{color:#ffd43b}
.winner-pot-line{
  display:inline-flex;align-items:center;gap:8px;margin-top:14px;
  padding:6px 16px;border-radius:999px;max-width:calc(100vw - 32px);
  background:linear-gradient(135deg,#1c0d33,#0e0619);
  border:1px solid #8b631d;
  box-shadow:0 8px 30px rgba(255,180,0,.15);
  font-size:clamp(14px,5vw,20px);font-weight:1000;color:#fff;
  flex-wrap:nowrap;white-space:nowrap;
}
.winner-pot-line .pot-emoji{font-size:clamp(12px,4vw,16px)}
.winner-pot-line .pot-amount{color:#ffd43b;font-weight:1000;text-shadow:0 0 12px rgba(255,212,59,.45)}
.winner-pot-line .pot-label{font-size:clamp(7px,2.5vw,9px);color:#a99bc2;font-weight:900;letter-spacing:1px;margin-left:2px}

.winner-ticket{
  width:100%;max-width:340px;margin-top:18px;
  border-radius:20px;overflow:hidden;
  background:linear-gradient(160deg,#2a1546,#150a2b 60%,#0d0618);
  border:1.5px solid #8b631d;
  box-shadow:0 20px 60px rgba(0,0,0,.55),inset 0 0 40px rgba(255,180,0,.06);
  animation:ticketPop .55s cubic-bezier(.2,1.3,.5,1) both;
}
@keyframes ticketPop{0%{transform:scale(.85);opacity:0}100%{transform:scale(1);opacity:1}}
.winner-ticket-head{
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:10px 12px;
  background:linear-gradient(180deg,rgba(255,212,59,.15),transparent);
}
.winner-ticket-name{display:flex;align-items:center;gap:8px;font-size:clamp(12px,4vw,15px);font-weight:1000;color:#fff;min-width:0;flex:1}
.winner-ticket-name .ticket-crown{font-size:clamp(13px,4vw,16px)}
.winner-ticket-name .winner-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.winner-ticket-badge{
  font-size:clamp(9px,3vw,11px);font-weight:1000;color:#1b0d27;flex-shrink:0;
  background:linear-gradient(135deg,#ffd93d,#c98b11);
  padding:4px 10px;border-radius:8px;letter-spacing:.5px;
  box-shadow:0 2px 8px rgba(201,139,17,.4);
}
.winner-ticket-grid{
  display:grid;grid-template-columns:repeat(5,1fr);
  gap:clamp(2px,1vw,4px);
  padding:10px 10px 6px;
  width:100%;
  filter:none !important;opacity:1 !important;backdrop-filter:none !important;
}
.winner-ticket-grid .wt-head{
  aspect-ratio:1;display:grid;place-items:center;
  font-size:clamp(10px,3vw,12px);font-weight:1000;border-radius:8px;background:transparent;
  filter:none !important;opacity:1 !important;min-width:0;
}
.winner-ticket-grid .wt-head.b{color:#38a7ff}
.winner-ticket-grid .wt-head.i{color:#ff4d68}
.winner-ticket-grid .wt-head.n{color:#ffd43b}
.winner-ticket-grid .wt-head.g{color:#22d37d}
.winner-ticket-grid .wt-head.o{color:#bb7cff}
.winner-ticket-grid .wt-cell{
  aspect-ratio:1;display:grid;place-items:center;
  border-radius:clamp(5px,1.5vw,9px);
  font-size:clamp(10px,3.2vw,14px);font-weight:1000;
  background:#1e1035;color:#ffffff;
  border:1px solid #2f1a4c;
  filter:none !important;opacity:1 !important;text-shadow:none;min-width:0;
}
.winner-ticket-grid .wt-cell.hit-green{
  background:linear-gradient(145deg,#27c66d,#159447);
  color:#062014;border-color:#61f09a;
  box-shadow:0 0 10px rgba(39,198,109,.45);
}
.winner-ticket-grid .wt-cell.hit-gold{
  background:linear-gradient(145deg,#ffd93d,#e5a712);
  color:#1b0d27;border-color:#ffe07a;
  box-shadow:0 0 10px rgba(255,212,59,.45);
}
.winner-ticket-grid .wt-cell.hit-blue{
  background:linear-gradient(145deg,#5b8cff,#2a51c9);
  color:#ffffff;border-color:#93b1ff;
  box-shadow:0 0 10px rgba(91,140,255,.45);
}
.winner-ticket-grid .wt-cell.free{
  background:linear-gradient(145deg,#ffd93d,#e5a712);
  color:#1b0d27;border-color:#ffe07a;
  font-size:clamp(8px,2.6vw,11px);
}
.winner-ticket-foot{
  display:flex;align-items:center;justify-content:center;gap:8px;
  padding:10px 12px 14px;
  border-top:1px solid rgba(139,99,29,.35);
  font-size:clamp(9px,3vw,10px);color:#22d37d;font-weight:1000;
}
.winner-check-icon{
  width:16px;height:16px;border-radius:50%;flex-shrink:0;
  background:linear-gradient(145deg,#27c66d,#159447);
  display:grid;place-items:center;color:#fff;font-size:11px;
}
.winner-more{
  margin-top:12px;width:100%;max-width:340px;
  display:flex;flex-direction:column;gap:10px;
}
.winner-extra-ticket{
  border-radius:16px;overflow:hidden;
  background:linear-gradient(160deg,#2a1546,#150a2b 60%,#0d0618);
  border:1.5px solid #8b631d;
  padding:8px 10px 4px;
}
.winner-extra-ticket .et-head{
  display:flex;align-items:center;justify-content:space-between;gap:6px;
  padding-bottom:6px;font-size:clamp(10px,3vw,12px);font-weight:1000;color:#fff;
}
.winner-extra-ticket .et-head .et-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.winner-extra-ticket .et-badge{
  font-size:clamp(8px,2.6vw,10px);font-weight:1000;color:#1b0d27;flex-shrink:0;
  background:linear-gradient(135deg,#ffd93d,#c98b11);
  padding:3px 8px;border-radius:7px;
}
.winner-extra-ticket .et-grid{
  display:grid;grid-template-columns:repeat(5,1fr);
  gap:clamp(2px,1vw,4px);
  padding-bottom:8px;
  filter:none !important;opacity:1 !important;
}
.winner-extra-ticket .et-grid .wt-cell{
  aspect-ratio:1;display:grid;place-items:center;border-radius:clamp(4px,1.5vw,8px);
  font-size:clamp(9px,3vw,12px);font-weight:1000;
  background:#1e1035;color:#fff;
  border:1px solid #2f1a4c;min-width:0;
  filter:none !important;opacity:1 !important;
}
.winner-extra-ticket .et-grid .wt-cell.free{background:linear-gradient(145deg,#ffd93d,#e5a712);color:#1b0d27;border-color:#ffe07a}
.winner-extra-ticket .et-grid .wt-cell.hit-green{background:linear-gradient(145deg,#27c66d,#159447);color:#062014;border-color:#61f09a}
.winner-extra-ticket .et-grid .wt-cell.hit-gold{background:linear-gradient(145deg,#ffd93d,#e5a712);color:#1b0d27;border-color:#ffe07a}
.winner-extra-ticket .et-grid .wt-cell.hit-blue{background:linear-gradient(145deg,#5b8cff,#2a51c9);color:#fff;border-color:#93b1ff}
.winner-extra-ticket .et-grid .wt-head{aspect-ratio:1;display:grid;place-items:center;font-size:clamp(9px,3vw,11px);font-weight:1000;background:transparent;min-width:0}

.winner-next{
  text-align:center;font-size:clamp(10px,3vw,11px);color:#a99bc2;
  margin-top:16px;letter-spacing:.5px;
}
.winner-next b{color:#ffd43b;font-weight:1000}

.toast{position:fixed;left:50%;bottom:calc(70px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;background:#211332;border:1px solid #573778;color:#fff;padding:9px 12px;border-radius:10px;font-size:9px;font-weight:900;z-index:10000;transition:.2s;white-space:nowrap;max-width:90%;overflow:hidden;text-overflow:ellipsis}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.wallet-load-status{display:none;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;background:#211332;border-bottom:1px solid #573778;color:#f0d57a;font-size:11px}
.wallet-load-status.visible{display:flex}
.wallet-load-status button{flex:0 0 auto;padding:4px 8px;border:1px solid #78602e;border-radius:4px;background:#302314;color:#ffe28a;font:inherit;font-weight:800}

@media(max-width:359px){
  .picker-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
  .caller-cell{height:16px;font-size:6px}
  .game-card-wrap .bingo-cell{font-size:7px}
  .card-option{font-size:10px}
}
</style>
</head>
<body>
<div class="app">
<header class="header">
  <div class="brand"><div class="brand-logo">👑</div><div><div class="brand-name">SHISHO BINGO</div><div class="brand-sub" id="header-user">Player</div></div></div>
  <div class="wallet">💰 <span id="header-balance">Loading...</span> <small>BIRR</small></div>
</header>
<div id="wallet-load-status" class="wallet-load-status" role="status"><span id="wallet-load-message">Checking wallet...</span><button id="wallet-retry" type="button">Retry</button></div>
<script src="https://telegram.org/js/telegram-web-app.js"></script>

<main class="content" id="content">
  <section id="screen-lobby" class="screen active">
    <div class="hero panel gold">
      <div class="hero-crown">👑</div>
      <div class="hero-title">SHISHO <span>BINGO</span></div>
      <div class="hero-sub">Play. Win. Enjoy!</div>
      <div class="hero-pills"><span class="pill">🏆 REAL-TIME</span><span class="pill">🎟 MULTIPLE ROOMS</span><span class="pill">💰 INSTANT REWARDS</span></div>
    </div>
    <div class="section-title">AVAILABLE ROOM</div>
    <div id="lobby-room" class="panel room gold">
      <div class="room-row">
        <div style="display:flex;align-items:center;gap:9px;min-width:0"><div class="room-icon">🎱</div><div style="min-width:0"><div class="room-name">Room #<span id="lobby-room-id">1024</span></div><div class="room-desc">75-Ball Classic • Max 20 Players</div></div></div>
        <button id="join-btn" type="button" class="btn-gold">JOIN +</button>
      </div>
      <div class="room-meta">
        <div class="meta-box"><b id="lobby-pot">0</b><span>Pot BIRR</span></div>
        <div class="meta-box"><b id="lobby-players">0/20</b><span>Players</span></div>
        <div class="meta-box"><b id="lobby-status" class="green-text">WAITING</b><span>Status</span></div>
      </div>
    </div>
    <div class="panel" style="padding:12px;margin-top:8px">
      <div style="display:flex;align-items:center;justify-content:space-between"><div><div style="font-size:10px;font-weight:1000;color:#ffd43b">🎁 PLAY SMART</div><div style="font-size:8px;color:#9b8da9;margin-top:3px">Choose up to 2 cartelas. Each cartela costs 10 BIRR.</div></div><div style="font-size:24px">🎟️</div></div>
    </div>
    <div class="section-title" style="margin-top:12px">HOW TO PLAY</div>
    <div class="panel" style="padding:14px 8px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;text-align:center">
      <div><div style="font-size:24px;line-height:1.2">1️⃣</div><div style="font-size:8px;color:#a99bc2;margin-top:5px">Pick a room</div></div>
      <div><div style="font-size:24px;line-height:1.2">2️⃣</div><div style="font-size:8px;color:#a99bc2;margin-top:5px">Choose cards</div></div>
      <div><div style="font-size:24px;line-height:1.2">3️⃣</div><div style="font-size:8px;color:#a99bc2;margin-top:5px">Auto-mark &amp; win</div></div>
    </div>
  </section>

  <section id="screen-picker" class="screen">
    <div class="section-title">SELECT CARTELAS</div>
    <div class="stats panel" style="padding:5px;margin-bottom:7px">
      <div class="stat"><div class="stat-label">Balance</div><div class="stat-value" id="pick-balance">Loading...</div></div>
      <div class="stat"><div class="stat-label">Cost</div><div class="stat-value gold-text" id="pick-cost">0</div></div>
      <div class="stat"><div class="stat-label">Pot</div><div class="stat-value gold-text" id="pick-pot">0</div></div>
      <div class="stat"><div class="stat-label">Starts</div><div class="stat-value" id="pick-countdown">30s</div></div>
    </div>
    <div id="pick-start-note" class="balance-after" style="padding:2px 4px 8px">3 cartelas left to start the game</div>
    <div class="panel" style="overflow:hidden">
      <div style="padding:10px 10px 4px;display:flex;justify-content:space-between;align-items:center"><div style="font-size:10px;font-weight:1000">🎟 CARTELA NUMBERS <span id="cartela-pool-count" style="font-size:8px;color:#ffd43b">(100 AVAILABLE)</span></div><div style="font-size:8px;color:#9b8cab">Select 1–2</div></div>
      <div id="picker-grid" class="picker-grid">__PICKER_GRID__</div>
      <div id="selected-preview-wrap" class="selected-preview-wrap" style="display:none"><div class="preview-title"><span>🎟️ SELECTED CARTELA PREVIEW</span><span id="preview-cost-note" class="gold-text"></span></div><div id="selected-preview-list" class="selected-preview-list"></div></div>
      <div style="border-top:1px solid #291941;padding:9px;display:flex;align-items:center;justify-content:space-between;gap:8px"><div style="font-size:8px;color:#a99ab7"><b id="selected-count" class="gold-text">0/2</b> selected</div><div style="font-size:7px;color:#8f819f;text-align:right">Tap a selected cartela again to refund 10 BIRR</div></div>
    </div>
    <button class="btn-dark" style="width:100%;margin-top:8px" onclick="goLobby()">← Leave Room</button>
  </section>

  <section id="screen-game" class="screen">
    <div class="game-shell">
      <div class="game-top">
        <div class="live-row" style="margin-bottom:6px"><button class="btn-dark" style="min-height:30px;padding:0 9px;font-size:8px" onclick="goLobby()">←</button><div class="live-badge"><span class="dot"></span><span id="game-state-label">WAITING</span></div><div style="font-size:8px;color:#9e90ae">ROOM #<span id="game-room-id">1024</span></div></div>
        <div class="stats panel" style="padding:5px">
          <div class="stat"><div class="stat-label">Pot</div><div class="stat-value gold-text" id="game-pot">0</div></div>
          <div class="stat"><div class="stat-label">Players</div><div class="stat-value" id="game-players">0</div></div>
          <div class="stat"><div class="stat-label">Stake</div><div class="stat-value">10</div></div>
          <div class="stat"><div class="stat-label">Call #</div><div class="stat-value" id="game-call">0</div></div>
        </div>
      </div>
      <div class="ball-strip panel">
        <div class="current-ball" id="current-ball">--</div>
        <div style="min-width:0;flex:1"><div style="font-size:6.5px;color:#8f7fa4;font-weight:1000;text-transform:uppercase">Recent calls</div><div id="recent-balls" class="recent" style="margin-top:4px"><span style="font-size:7px;color:#6e607e;font-style:italic">Waiting...</span></div></div>
      </div>
      <div class="game-board-layout">
        <div class="panel caller">
          <div class="caller-head"><div class="caller-title">75-BALL</div><div class="caller-count"><span id="called-count">0</span>/75</div></div>
          <div class="caller-letters"><span>B</span><span>I</span><span>N</span><span>G</span><span>O</span></div>
          <div class="caller-grid" id="caller-grid"></div>
        </div>
        <div id="my-game-panel" class="panel cartela-panel" style="display:none">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px"><div style="font-size:7.5px;color:#a595b6;font-weight:1000">YOUR CARTELAS</div><div style="font-size:6px;color:#22d37d;font-weight:1000">AUTO-MARK</div></div>
          <div id="cartela-view" class="cartela-multi"></div>
        </div>
      </div>
      <div id="watching-panel" class="panel watch" style="display:none">
        <div class="watch-icon">👀</div><div class="watch-title">WATCHING ONLY</div><div class="watch-copy">This round has already started.</div>
      </div>
      <div class="bingo-action-bar" id="bingo-action-bar" style="display:none">
        <button type="button" class="bingo-claim-btn" id="main-bingo-btn" disabled>📣 BINGO!</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px">
        <button class="btn-red" onclick="leaveGame()">🚪 Leave</button>
        <button class="btn-dark" onclick="syncState()">↻ Refresh</button>
      </div>
    </div>
  </section>

  <section id="screen-wallet" class="screen">
    <div class="section-title">💰 WALLET</div>
    <div class="panel" style="padding:16px;background:radial-gradient(circle at 80% 0%,rgba(255,212,59,.14),transparent 55%),linear-gradient(145deg,#1b0d33,#0d0619);border-color:#8b631d">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:9px;color:#a99bc2;letter-spacing:1.4px;font-weight:1000">AVAILABLE BALANCE</div>
          <div style="font-size:28px;font-weight:1000;color:#ffd43b;margin-top:6px;line-height:1.05"><span id="wallet-available">Loading...</span> <small style="font-size:12px;color:#a99bc2">BIRR</small></div>
        </div>
        <div style="font-size:34px">💰</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <div style="flex:1;padding:8px 6px;background:#0e071b;border:1px solid #281942;border-radius:10px;text-align:center">
          <div style="font-size:7px;color:#8e7ba9;text-transform:uppercase;font-weight:1000">Reserved</div>
          <div style="font-size:12px;font-weight:1000;color:#fff;margin-top:3px"><span id="wallet-reserved">Loading...</span></div>
        </div>
        <div style="flex:1;padding:8px 6px;background:#0e071b;border:1px solid #281942;border-radius:10px;text-align:center">
          <div style="font-size:7px;color:#8e7ba9;text-transform:uppercase;font-weight:1000">Total</div>
          <div style="font-size:12px;font-weight:1000;color:#ffd43b;margin-top:3px"><span id="wallet-total">Loading...</span></div>
        </div>
      </div>
    </div>
    <div class="panel" style="padding:12px;margin-top:10px">
      <div class="section-title" style="margin:0 0 8px">MONEY ACTIONS</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button type="button" class="btn-gold" style="min-height:52px;font-size:13px" id="wallet-deposit-btn">💳 Deposit</button>
        <button type="button" class="btn-dark" style="min-height:52px;font-size:13px" id="wallet-withdraw-btn">💸 Withdraw</button>
      </div>
    </div>
    <div class="panel" style="padding:12px;margin-top:10px">
      <div class="section-title" style="margin:0 0 8px">PENDING REQUESTS</div>
      <div id="wallet-pending-list" style="font-size:9px;color:#9b8da9">No pending requests.</div>
    </div>
  </section>

  <section id="screen-deposit" class="screen">
    <div class="section-title">💳 DEPOSIT</div>
    <div class="panel" style="padding:14px">
      <div class="section-title" style="margin:0 0 8px">PAYMENT METHOD</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button type="button" class="btn-dark wallet-method" data-method="Telebirr">📱 Telebirr</button>
        <button type="button" class="btn-dark wallet-method" data-method="CBE">🏦 CBE</button>
      </div>
      <div id="deposit-instructions" class="panel" style="display:none;padding:10px;margin-top:10px;font-size:10px;line-height:1.5"></div>
      <label style="display:block;margin-top:10px;font-size:9px;color:#cfc4df">AMOUNT (BIRR)<input id="deposit-amount" type="number" min="1" step="0.01" style="display:block;width:100%;margin-top:5px;padding:10px;border-radius:10px;background:#0e071b;border:1px solid #352052;color:#fff"></label>
      <label style="display:block;margin-top:10px;font-size:9px;color:#cfc4df">TRANSACTION ID / SMS<textarea id="deposit-reference" rows="4" style="display:block;width:100%;margin-top:5px;padding:10px;border-radius:10px;background:#0e071b;border:1px solid #352052;color:#fff"></textarea></label>
      <button type="button" class="btn-gold" id="deposit-submit" style="width:100%;margin-top:10px">SUBMIT FOR APPROVAL</button>
      <button type="button" class="btn-dark" id="deposit-back" style="width:100%;margin-top:8px">← Wallet</button>
    </div>
  </section>

  <section id="screen-withdraw" class="screen">
    <div class="section-title">💸 WITHDRAW</div>
    <div class="panel" style="padding:14px">
      <div style="font-size:10px;color:#cfc4df">WITHDRAWABLE BALANCE <b id="withdraw-available" class="gold-text">Loading...</b></div>
      <label style="display:block;margin-top:10px;font-size:9px;color:#cfc4df">AMOUNT (BIRR)<input id="withdraw-amount" type="number" min="50" step="0.01" style="display:block;width:100%;margin-top:5px;padding:10px;border-radius:10px;background:#0e071b;border:1px solid #352052;color:#fff"></label>
      <label style="display:block;margin-top:10px;font-size:9px;color:#cfc4df">FULL NAME<input id="withdraw-name" type="text" style="display:block;width:100%;margin-top:5px;padding:10px;border-radius:10px;background:#0e071b;border:1px solid #352052;color:#fff"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        <button type="button" class="btn-dark withdraw-method" data-method="Telebirr">📱 Telebirr</button>
        <button type="button" class="btn-dark withdraw-method" data-method="CBE">🏦 CBE</button>
      </div>
      <label style="display:block;margin-top:10px;font-size:9px;color:#cfc4df">DESTINATION / ACCOUNT<input id="withdraw-destination" type="text" style="display:block;width:100%;margin-top:5px;padding:10px;border-radius:10px;background:#0e071b;border:1px solid #352052;color:#fff"></label>
      <button type="button" class="btn-gold" id="withdraw-submit" style="width:100%;margin-top:10px">SUBMIT WITHDRAWAL</button>
      <button type="button" class="btn-dark" id="withdraw-back" style="width:100%;margin-top:8px">← Wallet</button>
    </div>
  </section>

  <section id="screen-settings" class="screen">
    <div class="section-title">SETTINGS</div>
    <div class="panel profile-card">
      <div id="avatar" class="avatar">P</div>
      <div style="min-width:0;flex:1">
        <div id="profile-name" class="profile-name">Player</div>
        <div id="profile-id" class="profile-id">ID: --</div>
        <div class="profile-bal">Balance <b class="gold-text" id="profile-balance">Loading...</b> BIRR</div>
      </div>
    </div>
    <div class="stats panel" style="padding:5px;margin-top:8px">
      <div class="stat"><div class="stat-label">Games</div><div class="stat-value" id="profile-games">0</div></div>
      <div class="stat"><div class="stat-label">Wins</div><div class="stat-value green-text" id="profile-wins">0</div></div>
      <div class="stat"><div class="stat-label">Winnings</div><div class="stat-value gold-text" id="profile-winnings">0</div></div>
      <div class="stat"><div class="stat-label">Cards</div><div class="stat-value" id="profile-cards">0</div></div>
    </div>
    <div class="panel" style="padding:14px;margin-top:8px">
      <div class="section-title" style="margin:0 0 4px">PREFERENCES</div>
      <div class="setting" id="setting-audio" role="button" tabindex="0">
        <div><div class="setting-label">🔊 Caller Audio</div><div class="setting-hint">Hear each called number</div></div>
        <div class="switch on" id="switch-audio"></div>
      </div>
      <div class="setting" id="setting-vibration" role="button" tabindex="0">
        <div><div class="setting-label">📳 Vibration</div><div class="setting-hint">Vibrate on each call &amp; win</div></div>
        <div class="switch on" id="switch-vibration"></div>
      </div>
      <div class="setting">
        <div><div class="setting-label">⚡ Auto-Marking</div><div class="setting-hint">Numbers are marked automatically</div></div>
        <div class="switch on locked" id="switch-automark"></div>
      </div>
      <div class="setting" id="setting-language" role="button" tabindex="0">
        <div><div class="setting-label">🌐 Language</div><div class="setting-hint">App display language</div></div>
        <div style="display:flex;align-items:center;gap:6px">
          <b id="setting-language-value" style="color:#ffd43b;font-size:9px">English</b>
          <span style="color:#7d6f92;font-size:10px">▾</span>
        </div>
      </div>
    </div>
  </section>

  <section id="screen-history" class="screen">
    <div class="section-title">GAME HISTORY</div>
    <div id="history-list"></div>
  </section>
</main>

<nav class="bottom-nav" id="bottom-nav">
  <button id="nav-play" type="button" class="nav-btn active"><span class="ico">🎮</span>Play</button>
  <button id="nav-wallet" type="button" class="nav-btn"><span class="ico">💰</span>Wallet</button>
  <button id="nav-history" type="button" class="nav-btn"><span class="ico">📜</span>History</button>
  <button id="nav-settings" type="button" class="nav-btn"><span class="ico">👤</span>Profile</button>
</nav>
</div>

<div id="winner-overlay">
  <div class="winner-crown-big">👑</div>
  <div class="winner-headline">BINGO!</div>
  <div class="winner-subline">We have a <span class="em">winner</span>! 🎉</div>
  <div class="winner-pot-line">
    <span class="pot-emoji">💰</span>
    <span class="pot-amount" id="wo-prize">0 BIRR</span>
    <span class="pot-label">Pot</span>
  </div>
  <div class="winner-ticket">
    <div class="winner-ticket-head">
      <div class="winner-ticket-name"><span class="ticket-crown">👑</span><span class="winner-name-text" id="wo-name">Player</span></div>
      <div class="winner-ticket-badge" id="wo-card">#00</div>
    </div>
    <div class="winner-ticket-grid" id="wo-grid"></div>
    <div class="winner-ticket-foot">
      <span class="winner-check-icon">✓</span>
      <span>Verified BINGO</span>
    </div>
  </div>
  <div class="winner-more" id="wo-more" style="display:none"></div>
  <div class="winner-next">Next round in <b id="wo-countdown">7s</b></div>
</div>

<input id="deposit-proof-file" type="file" accept="image/*" style="display:none">
<div id="toast" class="toast"></div>

<script>
(function(){
  'use strict';

  var WINNER_FALLBACK_MS = 7000;

  // Telegram init
  var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
  if (tg) {
    try { tg.ready(); } catch(e){}
    try { tg.expand(); } catch(e){}
    try { if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor('#0b0517'); } catch(e){}
    try { if (typeof tg.setBackgroundColor === 'function') tg.setBackgroundColor('#07030f'); } catch(e){}
    try { if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes(); } catch(e){}
  }

  var params = new URLSearchParams(location.search);
  var tgUser = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) ? tg.initDataUnsafe.user : null;
  var tgId = tgUser ? String(tgUser.id) : (params.get('tgId') || '');
  var identity = {
    firstName: params.get('firstName') || (tgUser && tgUser.first_name) || '',
    lastName:  params.get('lastName')  || (tgUser && tgUser.last_name)  || '',
    username:  params.get('username')  || (tgUser && tgUser.username)   || ''
  };
  var telegramInitData = (tg && typeof tg.initData === 'string') ? tg.initData : '';
  var state = window.__SHISHO_BOOTSTRAP__ || {
    user: null, room: null, cartelas: [], history: [], ranks: [],
    previewCartelas: [], selectedCartelas: [], lastWinnerEvent: null,
    pendingRequests: []
  };
  var selected = new Set((state.selectedCartelas || []).map(Number));
  var currentScreen = window.__SHISHO_START_SCREEN__ || 'lobby';
  var sse = null;
  var sseReconnectTimer = null;
  var sseWatchdogTimer = null;
  var reconnectScheduled = false;
  var pollTimer = null;
  var rafTimer = null;
  var lastRoomJson = '';
  var lastBallCount = 0;
  var lastBallNumber = null;
  var lastSpokenCallSequence = 0;
  var lastSeenBallKey = '';
  var selectionDirtyAt = 0;
  var pickerBusy = false;
  var winnerCountdownInterval = null;
  var winnerAutoRedirectTimer = null;
  var winnerEndTime = 0;
  var lastFinishedKey = '';
  var audioUnlocked = false;
  var serverTimeOffset = 0;
  var sseConnected = false;
  var lastSSEMessageAt = 0;
  var winnerVisibleFor = '';
  var resumeInFlight = false;
  var ballRenderTimer = null;
  var stateRequestSequence = 0;
  var acceptedStateRequestSequence = 0;
  var stateSyncPromise = null;
  var walletLoaded = false;
  var walletError = null;
  var lastWalletRequestAt = 0;
  var walletDiagnostics = window.__SHISHO_WALLET_DEBUG__ === true;

  var prefs = { audio: true, vibration: true, autoMark: true, language: 'am' };
  var TRANS = window.__SHISHO_TRANS__ || { en: {}, am: {} };

  function tr(key) {
    var lang = prefs.language === 'en' ? 'en' : 'am';
    return (TRANS[lang] && TRANS[lang][key]) || (TRANS[lang] && TRANS[lang].static && TRANS[lang].static[key]) || (TRANS.en && TRANS.en[key]) || key;
  }

  function walletDebug(level, details) {
    if (!walletDiagnostics) return;
    console[level]('[MINIAPP STATE DEBUG]', JSON.stringify(details));
  }

  function applyLanguage() {
    var lang = prefs.language === 'en' ? 'en' : 'am';
    var dict = (TRANS[lang] && TRANS[lang].static) || {};
    var walker = document.createTreeWalker(document.body, 4);
    var node;
    while ((node = walker.nextNode())) {
      if (!node.__shishoOriginal) node.__shishoOriginal = String(node.nodeValue || '').trim();
      var value = node.__shishoOriginal;
      var translated = lang === 'en' ? value : (dict[value] || value);
      if (value) node.nodeValue = node.nodeValue.replace(String(node.nodeValue || '').trim(), translated);
    }
    var languageValue = $('setting-language-value');
    if (languageValue) languageValue.textContent = lang === 'am' ? tr('amharic') : tr('english');
    var audioSwitch = $('switch-audio');
    var vibrationSwitch = $('switch-vibration');
    if (audioSwitch) audioSwitch.setAttribute('aria-label', tr('callerAudio'));
    if (vibrationSwitch) vibrationSwitch.setAttribute('aria-label', tr('vibration'));
  }

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function(m){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[m];
    });
  }
  function money(n) { return Number(n || 0).toFixed(2); }
  function now() { return Date.now() + serverTimeOffset; }

  // -----------------------------------------------------------------------
  // AUDIO — mobile hardened
  // -----------------------------------------------------------------------
  var audioCtx = null;
  var ttsPrimed = true;
  var lastSpokenKey = '';
  var pendingSpeak = null;
  var speechQueue = [];
  var speechBusy = false;
  var remoteCallerAudio = null;
  var remoteAudioBusy = false;
  var speechAttemptId = 0;
  var cachedVoices = [];
  var voicesLoaded = false;
  var audioBaselineReady = false;

  function audioLog() {
    try { console.log.apply(console, ['[BINGO AUDIO]'].concat([].slice.call(arguments))); } catch(e){}
  }

  var AM_NUMBER_WORDS = {
    1:'አንድ', 2:'ሁለት', 3:'ሶስት', 4:'አራት', 5:'አምስት', 6:'ስድስት', 7:'ሰባት', 8:'ስምንት', 9:'ዘጠኝ', 10:'አስር',
    11:'አስራ አንድ', 12:'አስራ ሁለት', 13:'አስራ ሶስት', 14:'አስራ አራት', 15:'አስራ አምስት', 16:'አስራ ስድስት', 17:'አስራ ሰባት', 18:'አስራ ስምንት', 19:'አስራ ዘጠኝ', 20:'ሃያ',
    21:'ሃያ አንድ', 22:'ሃያ ሁለት', 23:'ሃያ ሶስት', 24:'ሃያ አራት', 25:'ሃያ አምስት', 26:'ሃያ ስድስት', 27:'ሃያ ሰባት', 28:'ሃያ ስምንት', 29:'ሃያ ዘጠኝ', 30:'ሰላሳ',
    31:'ሰላሳ አንድ', 32:'ሰላሳ ሁለት', 33:'ሰላሳ ሶስት', 34:'ሰላሳ አራት', 35:'ሰላሳ አምስት', 36:'ሰላሳ ስድስት', 37:'ሰላሳ ሰባት', 38:'ሰላሳ ስምንት', 39:'ሰላሳ ዘጠኝ', 40:'አርባ',
    41:'አርባ አንድ', 42:'አርባ ሁለት', 43:'አርባ ሶስት', 44:'አርባ አራት', 45:'አርባ አምስት', 46:'አርባ ስድስት', 47:'አርባ ሰባት', 48:'አርባ ስምንት', 49:'አርባ ዘጠኝ', 50:'ሃምሳ',
    51:'ሃምሳ አንድ', 52:'ሃምሳ ሁለት', 53:'ሃምሳ ሶስት', 54:'ሃምሳ አራት', 55:'ሃምሳ አምስት', 56:'ሃምሳ ስድስት', 57:'ሃምሳ ሰባት', 58:'ሃምሳ ስምንት', 59:'ሃምሳ ዘጠኝ', 60:'ስልሳ',
    61:'ስልሳ አንድ', 62:'ስልሳ ሁለት', 63:'ስልሳ ሶስት', 64:'ስልሳ አራት', 65:'ስልሳ አምስት', 66:'ስልሳ ስድስት', 67:'ስልሳ ሰባት', 68:'ስልሳ ስምንት', 69:'ስልሳ ዘጠኝ', 70:'ሰባ',
    71:'ሰባ አንድ', 72:'ሰባ ሁለት', 73:'ሰባ ሶስት', 74:'ሰባ አራት', 75:'ሰባ አምስት'
  };
  var AM_COLUMN_WORDS = { B:'ቢ', I:'አይ', N:'ኤን', G:'ጂ', O:'ኦ' };

  function loadVoices() {
    if (!('speechSynthesis' in window)) { audioLog('speechSynthesis supported:', false); return; }
    try {
      var v = window.speechSynthesis.getVoices() || [];
      if (v.length) { cachedVoices = v; voicesLoaded = true; }
      audioLog('voices available:', v.length, v.map(function(voice){ return voice.name + ' [' + voice.lang + ']'; }));
    } catch(e){ audioLog('getVoices error:', e); }
  }
  if ('speechSynthesis' in window) {
    loadVoices();
    try { window.speechSynthesis.onvoiceschanged = loadVoices; } catch(e){}
  }

  function pickVoice(language) {
    if (!cachedVoices.length) loadVoices();
    if (language === 'am') {
      for (var a = 0; a < cachedVoices.length; a++) if (/^(am|am[-_]ET)/i.test(cachedVoices[a].lang || '')) return cachedVoices[a];
      return null;
    }
    for (var i = 0; i < cachedVoices.length; i++) {
      var v = cachedVoices[i];
      if (/^en[-_]US/i.test(v.lang)) return v;
    }
    for (var j = 0; j < cachedVoices.length; j++) {
      var w = cachedVoices[j];
      if (/^en/i.test(w.lang)) return w;
    }
    return cachedVoices[0] || null;
  }

  function callerPhrase(letter, number, language) {
    if (language === 'am') return (AM_COLUMN_WORDS[letter] || letter) + ' ' + (AM_NUMBER_WORDS[number] || number);
    var englishColumns = { B:'B', I:'I', N:'N', G:'G', O:'O' };
    return (englishColumns[letter] || letter) + ' ' + String(number);
  }

  function currentAudioLanguage() {
    return prefs.language === 'en' ? 'en' : 'am';
  }

  function gestureWarmup() {
    try {
      if (!('speechSynthesis' in window)) return;
      var synth = window.speechSynthesis;
      if (synth.paused) synth.resume();
      ttsPrimed = true;
      audioLog('speech engine resumed from gesture; no warmup utterance queued');
    } catch(e){ audioLog('speech gesture resume failure:', e); }
  }

  function unlockWebAudio() {
    try {
      if (!audioCtx) {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        if (Ctor) audioCtx = new Ctor();
      }
      audioLog('AudioContext state before resume:', audioCtx ? audioCtx.state : 'unavailable');
      if (audioCtx && audioCtx.state !== 'running') {
        var resumeResult = audioCtx.resume();
        if (resumeResult && resumeResult.then) resumeResult.then(function(){ audioLog('resume success; state:', audioCtx.state); }, function(error){ audioLog('resume failure:', error); });
      }
      if (audioCtx && audioCtx.createOscillator) {
        var oscillator = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        gain.gain.value = 0;
        oscillator.connect(gain);
        gain.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.01);
      }
    } catch(e){ audioLog('AudioContext failure:', e); }
  }

  function unlockAudio() {
    unlockWebAudio();
    gestureWarmup();
    try {
      if (!remoteCallerAudio) {
        remoteCallerAudio = new Audio();
        remoteCallerAudio.preload = 'auto';
        remoteCallerAudio.volume = 1;
        remoteCallerAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
      }
      var unlockPlay = remoteCallerAudio.play();
      audioLog('audio.play() started for unlock');
      if (unlockPlay && unlockPlay.then) unlockPlay.then(function(){ audioLog('audio.play() resolved for unlock'); }, function(error){ audioLog('audio.play() rejected for unlock:', error); });
    } catch(e){ audioLog('HTMLAudio unlock failure:', e); }
    audioUnlocked = true;
    if (pendingSpeak) {
      var p = pendingSpeak;
      pendingSpeak = null;
      enqueueSpeech(p.letter, p.number, p.language);
    }
  }

  ['touchstart','touchend','pointerdown','pointerup','click','keydown'].forEach(function(evt){
    document.addEventListener(evt, unlockAudio, { passive: true });
  });
  document.addEventListener('visibilitychange', function(){
    if (!document.hidden) { unlockWebAudio(); onResume(); }
  });
  if (tg && typeof tg.onEvent === 'function') {
    try {
      tg.onEvent('viewportChanged', function(){});
      tg.onEvent('activated', function(){ unlockWebAudio(); onResume(); });
    } catch(e){}
  }

  function speakCallInternal(letter, number, fromGesture, requestedLanguage) {
    if (!prefs.audio) return;
    if (!('speechSynthesis' in window)) return;
    var language = requestedLanguage === 'en' || requestedLanguage === 'am' ? requestedLanguage : currentAudioLanguage();
    var text = callerPhrase(String(letter || '').trim(), number, language);
    if (tg && /Android/i.test(navigator.userAgent || '')) {
      audioLog('Android Telegram: using same-origin caller audio:', text);
      playRemoteCallerAudio(text, language);
      return;
    }
    var attemptId = ++speechAttemptId;
    var started = false;
    var fallbackTimer = null;
    var finishSpeech = function(){
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      speechBusy = false;
      drainSpeechQueue();
    };
    audioLog('speech text:', text, 'language:', language, 'queue length:', speechQueue.length, 'supported:', 'speechSynthesis' in window);
    try {
      var synth = window.speechSynthesis;
      audioLog('voices available before speak:', cachedVoices.length);
      if (synth.paused) synth.resume();
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1; u.pitch = 1; u.volume = 1;
      var voice = pickVoice(language);
      if (language === 'am' && !voice) {
        audioLog('No Amharic TTS voice available; attempting remote Amharic audio:', text);
        speechBusy = false;
        playRemoteCallerAudio(text, language);
        return;
      }
      audioLog('selected voice:', voice ? voice.name + ' [' + voice.lang + ']' : 'none');
      if (voice) u.voice = voice;
      u.lang = (voice && voice.lang) || (language === 'am' ? 'am-ET' : 'en-US');
      u.onstart = function(){ started = true; audioLog('utterance.onstart:', text); };
      u.onpause = function(){ audioLog('utterance.onpause:', text); };
      u.onresume = function(){ audioLog('utterance.onresume:', text); };
      u.onend = function(){ audioLog('utterance.onend:', text); finishSpeech(); };
      u.onerror = function(event){
        audioLog('utterance.onerror:', event && event.error, event);
        finishSpeech();
        playRemoteCallerAudio(text, language);
      };
      audioLog('calling speechSynthesis.speak()');
      synth.speak(u);
      speechBusy = true;
      fallbackTimer = setTimeout(function(){
        if (attemptId !== speechAttemptId || started) return;
        audioLog('utterance produced no onstart; falling back after timeout:', text);
        try { synth.cancel(); } catch(error) { audioLog('speech cancel failure:', error); }
        finishSpeech();
        playRemoteCallerAudio(text, language);
      }, 1800);
    } catch(e){ audioLog('speechSynthesis exception:', e); playRemoteCallerAudio(text, language); }
  }

  function playRemoteCallerAudio(text, language) {
    if (!audioUnlocked || remoteAudioBusy) { audioLog('HTMLAudio skipped; unlocked:', audioUnlocked, 'busy:', remoteAudioBusy); return; }
    try {
      if (!remoteCallerAudio) remoteCallerAudio = new Audio();
      remoteAudioBusy = true;
      speechBusy = true;
      remoteCallerAudio.onended = function(){ remoteAudioBusy = false; speechBusy = false; drainSpeechQueue(); };
      remoteCallerAudio.onerror = function(){
        remoteAudioBusy = false;
        speechBusy = false;
        audioLog('audio error event:', text);
        drainSpeechQueue();
      };
      var locale = language === 'am' ? 'am' : 'en';
      remoteCallerAudio.src = '/api/caller-audio?lang=' + locale + '&text=' + encodeURIComponent(text);
      audioLog('HTMLAudio source:', remoteCallerAudio.src, 'volume:', remoteCallerAudio.volume, 'muted:', remoteCallerAudio.muted);
      remoteCallerAudio.load();
      var playResult = remoteCallerAudio.play();
      audioLog('audio.play() started');
      if (playResult && playResult.then) playResult.then(function(){ audioLog('audio.play() resolved'); }, function(error){
        remoteAudioBusy = false;
        speechBusy = false;
        audioLog('audio.play() rejected:', error);
        drainSpeechQueue();
      });
      audioLog('audio readyState:', remoteCallerAudio.readyState, 'networkState:', remoteCallerAudio.networkState, 'duration:', remoteCallerAudio.duration);
    } catch(e) {
      remoteAudioBusy = false;
      speechBusy = false;
      audioLog('HTMLAudio exception:', e);
      drainSpeechQueue();
    }
  }

  function drainSpeechQueue() {
    if (speechBusy || !speechQueue.length || !audioUnlocked) return;
    var next = speechQueue.shift();
    speakCallInternal(next.letter, next.number, false, next.language);
  }

  function cancelCurrentSpeech() {
    speechAttemptId++;
    speechQueue = [];
    pendingSpeak = null;
    lastSpokenKey = '';
    speechBusy = false;
    remoteAudioBusy = false;
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch(e) { audioLog('speech cancel failure:', e); }
    try {
      if (remoteCallerAudio) {
        remoteCallerAudio.pause();
        remoteCallerAudio.currentTime = 0;
      }
    } catch(e) { audioLog('audio reset failure:', e); }
  }

  function enqueueSpeech(letter, number, language) {
    if (!prefs.audio) return;
    language = language === 'en' || language === 'am' ? language : currentAudioLanguage();
    var key = String(letter || '').trim() + ':' + String(number);
    var languageKey = language + ':' + key;
    if (languageKey === lastSpokenKey || speechQueue.some(function(item){ return item.key === languageKey; })) return;
    lastSpokenKey = languageKey;
    speechQueue.push({ key: languageKey, letter: letter, number: number, language: language });
    audioLog('queued call audio:', JSON.stringify({ language: language, letter: letter, number: number, text: callerPhrase(letter, number, language), queueLength: speechQueue.length }));
    drainSpeechQueue();
  }

  function speakCall(letter, number) {
    if (!prefs.audio) return;
    if (!('speechSynthesis' in window)) {
      audioLog('speechSynthesis supported:', false);
      playRemoteCallerAudio(callerPhrase(letter, number, currentAudioLanguage()), currentAudioLanguage());
      return;
    }
    if (!audioUnlocked) {
      pendingSpeak = { letter: letter, number: number, language: currentAudioLanguage() };
      try { window.speechSynthesis.getVoices(); } catch(e){}
      return;
    }
    speakCallInternal(letter, number, false);
  }

  window.testBingoAudio = function(language) {
    language = language === 'en' || language === 'am' ? language : currentAudioLanguage();
    audioUnlocked = true;
    unlockWebAudio();
    audioLog('TEST AUDIO gesture; Telegram.WebApp:', !!tg, 'userAgent:', navigator.userAgent, 'language:', language);
    if (!('speechSynthesis' in window)) {
      audioLog('speechSynthesis supported:', false);
      playRemoteCallerAudio(language === 'am' ? 'ቢ አስራ ሁለት' : 'Bingo, B twelve', language);
      return;
    }
    loadVoices();
    var voice = pickVoice(language);
    if (language === 'am' && !voice) {
      audioLog('No Amharic TTS voice is available on this device/browser.');
      showToast('No Amharic TTS voice is available on this device/browser.');
    }
    var text = language === 'am' ? 'ቢ አስራ ሁለት' : 'Bingo, B twelve';
    showToast(language === 'am' ? 'Testing Amharic audio...' : 'Testing English audio...');
    if (tg && /Android/i.test(navigator.userAgent || '')) {
      audioLog('TEST Android Telegram: using same-origin caller audio:', text);
      playRemoteCallerAudio(text, language);
      return;
    }
    var utterance = new SpeechSynthesisUtterance(text);
    var testStarted = false;
    var testFallbackTimer = null;
    utterance.volume = 1;
    utterance.rate = 1;
    if (voice) utterance.voice = voice;
    utterance.lang = voice ? voice.lang : (language === 'am' ? 'am-ET' : 'en-US');
    utterance.onstart = function(){ testStarted = true; if (testFallbackTimer) clearTimeout(testFallbackTimer); audioLog('TEST utterance.onstart:', text); showToast('Audio started.'); };
    utterance.onpause = function(){ audioLog('TEST utterance.onpause:', text); };
    utterance.onresume = function(){ audioLog('TEST utterance.onresume:', text); };
    utterance.onend = function(){ audioLog('TEST utterance.onend:', text); };
    utterance.onerror = function(event){
      audioLog('TEST utterance.onerror:', event && event.error, event);
      showToast('Audio error: ' + ((event && event.error) || 'unknown'));
      playRemoteCallerAudio(text, language);
    };
    audioLog('TEST voices available:', cachedVoices.length, 'selected voice:', voice ? voice.name + ' [' + voice.lang + ']' : 'none');
    try {
      window.speechSynthesis.cancel();
      audioLog('TEST calling speechSynthesis.speak()');
      window.speechSynthesis.speak(utterance);
      testFallbackTimer = setTimeout(function(){
        if (testStarted) return;
        audioLog('TEST utterance produced no onstart; falling back after timeout:', text);
        try { window.speechSynthesis.cancel(); } catch(error) { audioLog('TEST speech cancel failure:', error); }
        playRemoteCallerAudio(text, language);
      }, 1800);
    } catch(error) { audioLog('TEST speech exception:', error); }
  };

  // VIBRATION
  var vibrationSupported = false;
  try { vibrationSupported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'; }
  catch(e) { vibrationSupported = false; }

  function vibrateCall() {
    if (!prefs.vibration) return;
    try { if (vibrationSupported) { navigator.vibrate(60); return; } } catch(e){}
    try { if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light'); } catch(e){}
  }
  function vibrateWin() {
    if (!prefs.vibration) return;
    try { if (vibrationSupported) { navigator.vibrate([120,60,120,60,240]); return; } } catch(e){}
    try { if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success'); } catch(e){}
  }

  function apiRequest(path, options) {
    options = options || {};
    var opts = { headers: Object.assign({}, options.headers || {}) };
    if (telegramInitData) opts.headers['X-Telegram-Init-Data'] = telegramInitData;
    opts.method = (options.method || 'GET').toUpperCase();
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      opts.body = JSON.stringify(Object.assign({}, options.body, { tgId: tgId }));
      opts.headers['Content-Type'] = 'application/json';
    } else if (!options.body && opts.method !== 'GET') {
      opts.body = JSON.stringify({ tgId: tgId });
      opts.headers['Content-Type'] = 'application/json';
    }
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, 12000);
    opts.signal = controller.signal;
    opts.cache = 'no-store';
    return fetch(path, opts).then(function(res){
      return res.text().then(function(text){
        var data = {};
        try { data = text ? JSON.parse(text) : {}; }
        catch(e) { throw new Error('Invalid server response'); }
        if (!res.ok || data.error || data.ok === false) {
          var apiError = new Error(data.message || data.error || ('Request failed (' + res.status + ')'));
          apiError.code = data.code || data.error || ('HTTP_' + res.status);
          apiError.status = res.status;
          throw apiError;
        }
        return data;
      });
    }).catch(function(e){
      if (e.name === 'AbortError') throw new Error('Request timed out.');
      throw e;
    }).finally(function(){ clearTimeout(timer); });
  }

  function buildStateUrl() {
    return '/api/state' + (telegramInitData ? '' : '?tgId=' + encodeURIComponent(tgId));
  }

  function showToast(message) {
    var el = $('toast');
    if (!el) return;
    el.textContent = tr(String(message));
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function(){ el.classList.remove('show'); }, 2600);
  }
  window.showToast = showToast;

  function renderWalletLoadStatus() {
    var status = $('wallet-load-status');
    var message = $('wallet-load-message');
    var retry = $('wallet-retry');
    if (!status) return;
    status.classList.toggle('visible', !walletLoaded);
    if (message) message.textContent = walletError
      ? (!tgId ? 'Telegram identity unavailable. Reopen this app from the bot.' : 'Wallet unavailable. Tap Retry.')
      : 'Checking wallet...';
    if (retry) retry.hidden = !tgId;
  }

  var SCREENS = ['lobby', 'picker', 'game', 'settings', 'wallet', 'deposit', 'withdraw', 'history'];

  function showScreen(name) {
    if (SCREENS.indexOf(name) === -1) name = 'lobby';
    var target = $('screen-' + name);
    if (!target) return false;
    currentScreen = name;
    SCREENS.forEach(function(s){
      var el = $('screen-' + s);
      if (el) el.classList.toggle('active', s === name);
    });
    var app = document.querySelector('.app');
    if (app) {
      app.classList.toggle('in-picker', name === 'picker');
      app.classList.toggle('in-game', name === 'game');
    }
    ['play', 'wallet', 'history', 'settings'].forEach(function(navName){
      var el = $('nav-' + navName);
      if (!el) return;
      var active =
        name === navName ||
        (name === 'lobby' && navName === 'play') ||
        (name === 'picker' && navName === 'play') ||
        (name === 'game' && navName === 'play');
      el.classList.toggle('active', active);
    });
    var content = $('content');
    if (content) content.scrollTop = 0;
    if (name === 'history') renderHistory();
    if (name === 'settings') renderSettings();
    if (name === 'wallet') renderWallet();
    if (name === 'withdraw') renderWithdrawPage();
    if (name === 'picker') renderPicker();
    return true;
  }
  window.showScreen = showScreen;

  function ensureVisibleScreen() {
    if (document.querySelector('.screen.active')) return;
    currentScreen = 'lobby';
    showScreen('lobby');
  }

  function goLobby() {
    selected = new Set();
    if (state) { state.selectedCartelas = []; state.previewCartelas = []; }
    showScreen('lobby');
    syncState(true).catch(function(){});
    return false;
  }
  window.goLobby = goLobby;

  function countdownText(room) {
    if (!room || ['WAITING', 'COUNTDOWN'].indexOf(room.status) === -1) return '0s';
    var end = Number(room.countdownEndsAt || 0);
    var remaining = end > 0 ? Math.max(0, Math.ceil((end - now()) / 1000)) : Number(room.countdown || 30);
    return remaining + 's';
  }

  function startRAF() {
    if (rafTimer) return;
    var tick = function(){
      var el = $('pick-countdown');
      if (el && state && state.room) el.textContent = countdownText(state.room);
      rafTimer = requestAnimationFrame(tick);
    };
    rafTimer = requestAnimationFrame(tick);
  }

  function renderPicker() {
    var grid = $('picker-grid');
    if (!grid) return;
    var u = (state && state.user) ? state.user : {};
    var room = (state && state.room) ? state.room : {};
    var walletBalance   = Number(u.balance || 0);
    var reservedBalance = Number(u.reservedBalance || 0);
    var rawAvailable    = Number(u.availableBalance);
    var rawPlay         = Number(u.playBalance);
    var balance = Number.isFinite(rawAvailable) ? rawAvailable
      : (Number.isFinite(rawPlay) ? rawPlay : Math.max(0, walletBalance - reservedBalance));

    var reservations = Array.isArray(room.reservedCartelas) ? room.reservedCartelas : [];
    var reservedMap = new Map(reservations.map(function(x){ return [Number(x.id), String(x.tgId)]; }));

    grid.innerHTML = '';
    for (var i = 1; i <= 100; i++) {
      var mine = selected.has(i);
      var takenByOther = reservedMap.has(i) && reservedMap.get(i) !== String(tgId);
      var canAfford = walletLoaded && balance >= 10;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-option'
        + (mine ? ' selected' : '')
        + (takenByOther ? ' taken' : '')
        + (!mine && !takenByOther && !canAfford ? ' unavailable' : '');
      btn.textContent = String(i);
      btn.dataset.cartela = String(i);
      btn.disabled = takenByOther || (!mine && !canAfford);
      grid.appendChild(btn);
    }

    var count = selected.size;
    if ($('selected-count')) $('selected-count').textContent = count + '/2';
    if ($('pick-cost'))      $('pick-cost').textContent = (count * 10).toFixed(0);
    if ($('pick-balance'))   $('pick-balance').textContent = walletLoaded ? money(balance) : 'Loading...';
    if ($('header-balance')) $('header-balance').textContent = walletLoaded ? money(balance) : 'Loading...';
    if ($('pick-pot'))       $('pick-pot').textContent = money(room.pot);
    if ($('pick-countdown')) $('pick-countdown').textContent = countdownText(room);
    if ($('cartela-pool-count')) $('cartela-pool-count').textContent = '(100 AVAILABLE)';

    var roomCards = Number(room.cartelaCount || 0);
    var note = $('pick-start-note');
    if (note) {
      if (roomCards >= 3) { note.textContent = ''; note.style.display = 'none'; }
      else {
        var left = Math.max(0, 3 - roomCards);
        note.textContent = left + ' cartela' + (left === 1 ? '' : 's') + ' left to start the game';
        note.style.display = 'block';
      }
    }
    var costNote = $('preview-cost-note');
    if (costNote) costNote.textContent = count
      ? ('Reserved now: ' + (count * 10) + ' BIRR · Available: ' + money(balance) + ' BIRR')
      : 'Select a cartela to reserve it.';
    renderSelectedPreviews();
  }

  function renderSelectedPreviews() {
    var wrap = $('selected-preview-wrap');
    var list = $('selected-preview-list');
    if (!wrap || !list) return;
    if (!selected.size) { wrap.style.display = 'none'; list.innerHTML = ''; return; }
    wrap.style.display = 'block';
    list.innerHTML = '';
    var cards = state.previewCartelas || [];
    Array.from(selected).sort(function(a,b){ return a-b; }).forEach(function(id){
      var c = cards.find(function(x){ return String(x.id) === '#' + String(id).padStart(2, '0'); });
      if (!c) return;
      var html = '<div class="preview-card">';
      html += '<div class="preview-card-head"><div class="preview-card-title">🎟 CARTELA ' + esc(c.id) + '</div>';
      html += '<div class="preview-card-note">RESERVED · AUTO-MARK ON</div></div>';
      html += '<div class="preview-bingo-head"><div>B</div><div>I</div><div>N</div><div>G</div><div>O</div></div>';
      html += '<div class="preview-bingo-grid">';
      for (var r = 0; r < 5; r++) {
        for (var col = 0; col < 5; col++) {
          var free = (r === 2 && col === 2);
          html += '<div class="' + (free ? 'free' : '') + '">' + (free ? 'FREE' : esc(c.matrix[r][col])) + '</div>';
        }
      }
      html += '</div></div>';
      list.insertAdjacentHTML('beforeend', html);
    });
  }

  function renderCaller(called, current) {
    var grid = $('caller-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var set = new Set(called || []);
    for (var r = 0; r < 15; r++) {
      for (var c = 0; c < 5; c++) {
        var n = c * 15 + r + 1;
        var cell = document.createElement('div');
        cell.className = 'caller-cell' + (set.has(n) ? ' called' : '') + (n === current ? ' current' : '');
        cell.textContent = String(n);
        grid.appendChild(cell);
      }
    }
    var cc = $('called-count');
    if (cc) cc.textContent = String((called || []).length);
  }

  function renderRecent(called) {
    var el = $('recent-balls');
    if (!el) return;
    el.innerHTML = '';
    var arr = (called || []).slice(-5).reverse();
    if (!arr.length) {
      el.innerHTML = '<span style="font-size:7px;color:#6e607e;font-style:italic">Waiting...</span>';
      return;
    }
    arr.forEach(function(n, i){
      var x = document.createElement('div');
      x.className = 'recent-ball' + (i === 0 ? ' latest' : '');
      x.textContent = String(n);
      el.appendChild(x);
    });
  }

  function applyBallEvent(d) {
    if (!d) return;
    var callKey = String(d.callSequence || d.callIndex || 0) + ':' + String(d.currentNumber || d.number || 0);
    if (callKey === lastSeenBallKey) return;
    lastSeenBallKey = callKey;
    audioLog('Server number received:', d.currentColumn || d.letter, d.currentNumber || d.number, 'Call sequence:', d.callSequence || d.callIndex, 'Language:', currentAudioLanguage());
    var incomingLen = (d.calledNumbers || []).length;
    var existingLen = (state.room && state.room.calledNumbers) ? state.room.calledNumbers.length : 0;
    if (incomingLen < existingLen) return;
    if (incomingLen === existingLen && state.room && state.room.currentNumber === d.number) return;

    renderBall(d);
  }

  function renderBall(d) {
    if (!state.room) state.room = {};
    var existingLen = (state.room.calledNumbers || []).length;
    var incomingLen = (d.calledNumbers || []).length;
    if (incomingLen < existingLen) return;
    if (incomingLen === existingLen && state.room.currentNumber === d.number) return;
    state.room.calledNumbers = d.calledNumbers;
    state.room.currentNumber = d.number;
    state.room.currentIndex = d.callIndex || incomingLen;
    state.room.lastCallAt = d.calledAt || state.room.lastCallAt || null;
    state.room.nextCallAt = d.nextCallAt || state.room.nextCallAt || null;
    lastBallCount = incomingLen;
    lastBallNumber = d.number;
    if ($('current-ball')) $('current-ball').textContent = d.currentNumber || d.number;
    renderCaller(d.calledNumbers || [], d.currentNumber || d.number);
    renderRecent(d.calledNumbers || []);
    var callSequence = Number(d.callSequence || d.callIndex || incomingLen);
    if (callSequence > lastSpokenCallSequence) {
      lastSpokenCallSequence = callSequence;
      cancelCurrentSpeech();
      speakCall(d.currentColumn || d.letter, d.currentNumber || d.number);
    }
    updateUI();
    vibrateCall();
  }

  function renderGameCards() {
    var room = state.room || {};
    var running = room.status === 'RUNNING';
    var has = Array.isArray(state.cartelas) && state.cartelas.length > 0;
    var isSpectator = running && !has;

    var watchPanel = $('watching-panel');
    var myPanel = $('my-game-panel');
    var bingoBar = $('bingo-action-bar');
    if (watchPanel) watchPanel.style.display = isSpectator ? 'block' : 'none';
    if (myPanel)    myPanel.style.display = has ? 'block' : 'none';
    if (bingoBar)   bingoBar.style.display = has ? 'flex' : 'none';
    if (!has) return;

    var wrap = $('cartela-view');
    if (!wrap) return;
    wrap.className = 'cartela-multi' + (state.cartelas.length === 1 ? ' single' : '');
    wrap.innerHTML = '';

    state.cartelas.forEach(function(c){
      var html = '<div class="game-card-wrap">';
      html += '<div class="card-head"><span class="card-id">🎟 ' + esc(c.id) + '</span><span class="card-auto">AUTO</span></div>';
      html += '<div class="bingo-head">' +
        '<span style="color:#38a7ff">B</span><span style="color:#ff4d68">I</span><span style="color:#ffd43b">N</span><span style="color:#22d37d">G</span><span style="color:#bb7cff">O</span>' +
        '</div><div class="bingo-grid">';
      for (var r = 0; r < 5; r++) {
        for (var col = 0; col < 5; col++) {
          var free = (r === 2 && col === 2);
          var marked = free || !!(c.marked && c.marked[r] && c.marked[r][col]);
          html += '<div class="bingo-cell ' + (free ? 'free' : (marked ? 'marked' : '')) + '">' +
                  (free ? '★' : esc(c.matrix[r][col])) + '</div>';
        }
      }
      html += '</div></div>';
      wrap.insertAdjacentHTML('beforeend', html);
    });

    var bingoBtn = $('main-bingo-btn');
    if (bingoBtn) {
      bingoBtn.disabled = !running;
      bingoBtn.classList.toggle('ready', running);
      bingoBtn.textContent = '📣 BINGO!';
    }
  }

  function renderHistory() {
    var el = $('history-list');
    if (!el) return;
    el.innerHTML = '';
    var list = state.history || [];
    if (!list.length) {
      el.innerHTML = '<div class="panel" style="padding:20px;text-align:center;color:#8f819f;font-size:9px">No game history yet.</div>';
      return;
    }
    list.forEach(function(h){
      var win = h.result === 'WIN';
      var d = document.createElement('div');
      d.className = 'panel';
      d.style.cssText = 'padding:10px;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;gap:10px';
      d.innerHTML =
        '<div style="min-width:0;flex:1"><div style="font-size:9px;font-weight:1000">🎮 Game ' + esc(h.id) + ' · ' + (win ? 'WIN' : 'LOSS') + '</div>' +
        '<div style="font-size:7px;color:#9688a6;margin-top:3px;word-break:break-word">Cartela ' + esc(h.cardId) + ' · ' + esc(h.pattern || 'No pattern') + '</div></div>' +
        '<b style="font-size:10px;color:' + (win ? '#ffd43b' : '#9b90a8') + ';white-space:nowrap">' + (win ? '+' : '') + money(h.prize) + ' BIRR</b>';
      el.appendChild(d);
    });
  }

  function renderWallet() {
    var u = state.user || {};
    var mainBalance = Number(u.balance || 0);
    var reservedBalance = Number(u.reservedBalance || 0);
    var rawAvailable = Number(u.availableBalance);
    var available = Number.isFinite(rawAvailable) ? rawAvailable : Math.max(0, mainBalance - reservedBalance);

    if ($('wallet-available')) $('wallet-available').textContent = walletLoaded ? money(available) : 'Loading...';
    if ($('wallet-reserved'))  $('wallet-reserved').textContent  = walletLoaded ? money(reservedBalance) : 'Loading...';
    if ($('wallet-total'))     $('wallet-total').textContent     = walletLoaded ? money(mainBalance) : 'Loading...';

    var list = $('wallet-pending-list');
    if (!list) return;
    var pendingItems = Array.isArray(state.pendingRequests) ? state.pendingRequests : [];
    if (!pendingItems.length) {
      list.innerHTML = '<div style="padding:8px 0;text-align:center;color:#7d6f92">No pending requests.</div>';
      return;
    }
    list.innerHTML = '';
    pendingItems.forEach(function(p) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #25173a';
      row.innerHTML =
        '<div><div style="font-size:9px;font-weight:1000;color:#e8dcf5">' + (p.type === 'deposit' ? '💳 Deposit' : '💸 Withdrawal') + '</div>' +
        '<div style="font-size:7px;color:#8f819f;margin-top:2px">' + esc(p.id ? String(p.id).slice(0, 8) : '') + ' · ' + esc(p.method || '') + '</div></div>' +
        '<div style="text-align:right"><div style="font-size:10px;font-weight:1000;color:#ffd43b">' + money(p.amount) + ' BIRR</div>' +
        '<div style="font-size:7px;color:#ffb84d;margin-top:2px">PENDING</div></div>';
      list.appendChild(row);
    });
  }

  function renderSettings() {
    var u = state.user || {};
    if ($('profile-name'))    $('profile-name').textContent = ((u.firstName || 'Player') + ' ' + (u.lastName || '')).trim();
    if ($('profile-id'))      $('profile-id').textContent = 'ID: ' + (u.tgId || '--');
    if ($('profile-balance')) $('profile-balance').textContent = walletLoaded ? money(u.balance) : 'Loading...';
    if ($('profile-games'))   $('profile-games').textContent = u.gamesPlayed || 0;
    if ($('profile-wins'))    $('profile-wins').textContent = u.totalWins || 0;
    if ($('profile-winnings'))$('profile-winnings').textContent = money(u.totalWinnings);
    if ($('profile-cards'))   $('profile-cards').textContent = u.cartelasPurchased || 0;
    if ($('avatar'))          $('avatar').textContent = (u.firstName || 'P').charAt(0).toUpperCase();
    if ($('switch-audio'))     $('switch-audio').classList.toggle('on', prefs.audio);
    if ($('switch-vibration')) $('switch-vibration').classList.toggle('on', prefs.vibration);
    if ($('switch-automark'))  $('switch-automark').classList.add('on', 'locked');
    if ($('setting-language-value')) $('setting-language-value').textContent = 'English';
  }

  // WINNER OVERLAY
  function buildTicketGridHtml(card) {
    var colPalette = ['hit-gold','hit-green','hit-gold','hit-blue','hit-green'];
    var html = '';
    ['B','I','N','G','O'].forEach(function(h){
      html += '<div class="wt-head ' + h.toLowerCase() + '">' + h + '</div>';
    });
    if (card && Array.isArray(card.matrix)) {
      for (var r = 0; r < 5; r++) {
        for (var c = 0; c < 5; c++) {
          var free = (r === 2 && c === 2);
          var marked = free || !!(card.marked && card.marked[r] && card.marked[r][c]);
          var cls = 'wt-cell';
          if (free) cls += ' free';
          else if (marked) cls += ' ' + colPalette[c];
          var val = free ? '★' : String(card.matrix[r][c]);
          html += '<div class="' + cls + '">' + val + '</div>';
        }
      }
    } else {
      for (var i = 0; i < 25; i++) {
        var isFree = (i === 12);
        html += '<div class="wt-cell' + (isFree ? ' free' : '') + '">' + (isFree ? '★' : '') + '</div>';
      }
    }
    return html;
  }

  function showWinnerOverlay(d) {
    if (!d) return;
    var key = String(d.gameId || d.winnerEndsAt || '') + ':' + String(d.winnerEndsAt || '');
    if (winnerVisibleFor !== key) winnerVisibleFor = key;

    var winners = Array.isArray(d.winners) ? d.winners : [];
    var prizePool = Number(d.prizePool || 0);
    var winnerEndsAt = Number(d.winnerEndsAt || (now() + WINNER_FALLBACK_MS));
    if (!Number.isFinite(winnerEndsAt)) winnerEndsAt = now() + WINNER_FALLBACK_MS;

    var overlay = $('winner-overlay');
    if (!overlay) return;

    if ($('wo-prize')) $('wo-prize').textContent = money(prizePool) + ' BIRR';

    if (!winners.length) {
      if ($('wo-name')) $('wo-name').textContent = 'No winner';
      if ($('wo-card')) $('wo-card').textContent = '--';
      if ($('wo-grid')) $('wo-grid').innerHTML = '';
      if ($('wo-more')) $('wo-more').style.display = 'none';
    } else {
      var primary = winners.find(function(w){ return String(w.tgId) === String(tgId); }) || winners[0];
      if ($('wo-name')) $('wo-name').textContent = primary.firstName || 'Player';
      if ($('wo-card')) $('wo-card').textContent = (primary.cartelaIds || []).join(' + ');

      var winningCards = Array.isArray(d.winnerCards) ? d.winnerCards : [];
      var primaryCards = winningCards.filter(function(c){ return (primary.cartelaIds || []).indexOf(c.id) !== -1; });
      var mainCard = primaryCards[0] || null;
      if ($('wo-grid')) $('wo-grid').innerHTML = buildTicketGridHtml(mainCard);

      var moreEl = $('wo-more');
      if (moreEl) {
        var extras = [];
        for (var i = 1; i < primaryCards.length; i++) {
          extras.push({ label: primary.firstName || 'Player', card: primaryCards[i], isMe: String(primary.tgId) === String(tgId) });
        }
        winners.forEach(function(w){
          if (String(w.tgId) === String(primary.tgId)) return;
          var myCards = winningCards.filter(function(c){ return (w.cartelaIds || []).indexOf(c.id) !== -1; });
          myCards.forEach(function(card){
            extras.push({ label: w.firstName || 'Player', card: card, isMe: String(w.tgId) === String(tgId) });
          });
        });
        if (extras.length) {
          moreEl.style.display = 'flex';
          var html = '';
          extras.forEach(function(ex){
            html += '<div class="winner-extra-ticket">';
            html += '<div class="et-head"><span class="et-name">👑 ' + esc(ex.label) + (ex.isMe ? ' <span style="color:#22d37d;font-size:9px">YOU</span>' : '') + '</span>';
            html += '<span class="et-badge">' + esc(ex.card.id) + '</span></div>';
            html += '<div class="et-grid">' + buildTicketGridHtml(ex.card) + '</div>';
            html += '</div>';
          });
          moreEl.innerHTML = html;
        } else {
          moreEl.style.display = 'none';
          moreEl.innerHTML = '';
        }
      }
    }

    overlay.classList.add('show');

    if (winnerCountdownInterval) clearInterval(winnerCountdownInterval);
    winnerEndTime = winnerEndsAt;
    var cdEl = $('wo-countdown');
    var tick = function(){
      var remaining = Math.max(0, Math.ceil((winnerEndTime - now()) / 1000));
      if (cdEl) cdEl.textContent = remaining + 's';
      if (remaining <= 0) {
        clearInterval(winnerCountdownInterval);
        winnerCountdownInterval = null;
        onWinnerWindowEnded();
      }
    };
    tick();
    winnerCountdownInterval = setInterval(tick, 200);

    if (winnerAutoRedirectTimer) clearTimeout(winnerAutoRedirectTimer);
    var msUntilEnd = Math.max(0, winnerEndsAt - now());
    winnerAutoRedirectTimer = setTimeout(onWinnerWindowEnded, msUntilEnd);
  }

  function hideWinnerOverlay() {
    var overlay = $('winner-overlay');
    if (overlay) overlay.classList.remove('show');
    if (winnerCountdownInterval) { clearInterval(winnerCountdownInterval); winnerCountdownInterval = null; }
    if (winnerAutoRedirectTimer) { clearTimeout(winnerAutoRedirectTimer); winnerAutoRedirectTimer = null; }
    winnerVisibleFor = '';
  }

  function onWinnerWindowEnded() {
    hideWinnerOverlay();
    state.cartelas = [];
    state.selectedCartelas = [];
    state.previewCartelas = [];
    selected = new Set();
    lastFinishedKey = '';
    lastBallCount = 0;
    lastBallNumber = null;
    syncState(true).then(function(){
      var room = state.room || {};
      if (room.status === 'RUNNING') {
        showScreen('game');
      } else {
        openPicker().catch(function(){ showScreen('lobby'); });
      }
    }).catch(function(){ showScreen('lobby'); });
  }

  function checkFinishedFromPoll(room) {
    if (!room || room.status !== 'FINISHED' || !room.winnerEndsAt) return;
    var endTs = Number(room.winnerEndsAt);
    if (!Number.isFinite(endTs)) return;
    if (now() > endTs) return;
    var key = String(room.id) + ':' + String(endTs);
    if (key === lastFinishedKey) return;
    lastFinishedKey = key;
    var winners = (room.winners || []).map(function(w){
      return { tgId: w.tgId, firstName: w.firstName, cartelaIds: w.cartelaIds, patterns: w.patterns, prize: w.prize };
    });
    var winnerCards = Array.isArray(room.winnerCards) ? room.winnerCards : [];
    var prizePool = winners.length ? winners[0].prize : 0;
    showWinnerOverlay({
      gameId: room.id,
      winners: winners, winnerCards: winnerCards, pot: room.pot, prizePool: prizePool,
      displayMs: Math.max(0, endTs - now()),
      winnerEndsAt: endTs,
      serverTime: room.serverTime
    });
  }

  function updateUI() {
    var u = state.user || {};
    var r = state.room || {};
    var mainBalance = Number(u.balance || 0);
    var reservedBalance = Number(u.reservedBalance || 0);
    var available = Number.isFinite(Number(u.availableBalance))
      ? Number(u.availableBalance)
      : Math.max(0, mainBalance - reservedBalance);

    if ($('header-user'))    $('header-user').textContent = u.firstName || identity.firstName || 'Player';
    if ($('header-balance')) $('header-balance').textContent = walletLoaded ? money(available) : 'Loading...';

    if ($('lobby-room-id'))  $('lobby-room-id').textContent = r.id || '1024';
    if ($('lobby-pot'))      $('lobby-pot').textContent = money(r.pot);
    if ($('lobby-players'))  $('lobby-players').textContent = (r.playerCount || 0) + '/' + (r.capacity || 20);
    if ($('lobby-status')) {
      $('lobby-status').textContent = r.status || 'WAITING';
      $('lobby-status').className = (r.status === 'RUNNING' ? 'gold-text' : 'green-text');
    }

    if ($('pick-balance'))   $('pick-balance').textContent = walletLoaded ? money(available) : 'Loading...';
    if ($('pick-pot'))       $('pick-pot').textContent = money(r.pot);
    if ($('pick-countdown')) $('pick-countdown').textContent = countdownText(r);

    if ($('game-pot'))       $('game-pot').textContent = money(r.pot);
    if ($('game-players'))   $('game-players').textContent = r.playerCount || 0;
    if ($('current-ball'))   $('current-ball').textContent = r.currentNumber || '--';
    if ($('game-call'))      $('game-call').textContent = (r.calledNumbers || []).length;
    if ($('game-state-label'))$('game-state-label').textContent = r.status || 'WAITING';
    if ($('game-room-id'))   $('game-room-id').textContent = r.id || '1024';

    var called = Array.isArray(r.calledNumbers) ? r.calledNumbers : [];
    if (!ballRenderTimer) {
      if (called.length > lastBallCount) {
        var newN = called[called.length - 1];
        var currentSequence = Number(r.currentIndex || called.length);
        if (newN !== lastBallNumber && currentSequence > lastSpokenCallSequence) {
          lastBallNumber = newN;
          var letter = newN <= 15 ? 'B' : newN <= 30 ? 'I' : newN <= 45 ? 'N' : newN <= 60 ? 'G' : 'O';
          lastSpokenCallSequence = currentSequence;
          audioLog('Server number received via state poll:', letter, newN, 'Call sequence:', currentSequence, 'Language:', currentAudioLanguage());
          speakCall(letter, newN);
          vibrateCall();
        }
      }
    }
    lastBallCount = called.length;

    renderCaller(called, r.currentNumber);
    renderRecent(called);
    renderGameCards();
    if (currentScreen === 'settings') renderSettings();
    if (currentScreen === 'wallet')   renderWallet();
    if (currentScreen === 'withdraw') renderWithdrawPage();
    if (currentScreen === 'picker')   renderPicker();
    applyLanguage();
    checkFinishedFromPoll(r);
  }

  function applySelectionSnapshot(nextState) {
    if (!nextState) return;
    var serverSelected = Array.isArray(nextState.selectedCartelas) ? nextState.selectedCartelas : [];
    var serverPreview = Array.isArray(nextState.previewCartelas) ? nextState.previewCartelas : [];
    var staleSelectionWindow = Date.now() - selectionDirtyAt < 4000;
    if (serverSelected.length) {
      selected = new Set(serverSelected.map(Number));
      state.selectedCartelas = serverSelected.slice();
    } else if (currentScreen === 'picker' && selected.size && staleSelectionWindow) {
      state.selectedCartelas = Array.from(selected).slice();
    } else {
      selected = new Set();
      state.selectedCartelas = [];
    }
    if (serverPreview.length) {
      state.previewCartelas = serverPreview.slice();
    } else if (currentScreen === 'picker' && (state.previewCartelas || []).length && staleSelectionWindow) {
      state.previewCartelas = state.previewCartelas.slice();
    } else {
      state.previewCartelas = [];
    }
  }

  function applyGameState(nextState, source) {
    if (!nextState || !nextState.room) return false;
    var incoming = nextState.room;
    var current = state && state.room ? state.room : {};
    var incomingCalls = Array.isArray(incoming.calledNumbers) ? incoming.calledNumbers : null;
    var currentCalls = Array.isArray(current.calledNumbers) ? current.calledNumbers : [];
    var incomingIndex = Number(incoming.callIndex ?? incoming.currentIndex ?? (incomingCalls || []).length);
    var currentIndex = Number(current.callIndex ?? current.currentIndex ?? currentCalls.length);
    var bootstrapState = currentIndex === 0 && currentCalls.length === 0 && current.status !== 'RUNNING';
    var sameGame = bootstrapState || !current.gameId || !incoming.gameId || String(current.gameId) === String(incoming.gameId);
    if (!sameGame) {
      audioLog('[CLIENT] rejected state:', JSON.stringify({ source: source, reason: 'different-game', incomingGameId: incoming.gameId, currentGameId: current.gameId }));
      return false;
    }
    if (!Number.isInteger(incomingIndex) || incomingIndex < 0) {
      audioLog('[CLIENT] rejected state:', JSON.stringify({ source: source, reason: 'invalid-call-index', incomingIndex: incomingIndex }));
      return false;
    }
    if (incomingIndex < currentIndex || (incomingCalls && incomingCalls.length < currentCalls.length)) {
      audioLog('[CLIENT] rejected state:', JSON.stringify({ source: source, reason: 'stale', incomingIndex: incomingIndex, currentIndex: currentIndex, incomingCount: incomingCalls ? incomingCalls.length : null, currentCount: currentCalls.length }));
      return false;
    }
    var mergedCalls = incomingCalls && incomingCalls.length >= currentCalls.length ? incomingCalls.slice() : currentCalls.slice();
    var mergedRoom = Object.assign({}, current, incoming, {
      calledNumbers: mergedCalls,
      currentIndex: Math.max(currentIndex, incomingIndex),
      callIndex: Math.max(currentIndex, incomingIndex),
      currentNumber: incoming.currentNumber != null ? incoming.currentNumber : (current.currentNumber != null ? current.currentNumber : (mergedCalls.length ? mergedCalls[mergedCalls.length - 1] : null)),
      lastCallAt: incoming.lastCallAt || current.lastCallAt || null,
      nextCallAt: incoming.nextCallAt || current.nextCallAt || null,
    });
    state = Object.assign({}, state, nextState, { room: mergedRoom });
    audioLog('[CLIENT] accepted state:', JSON.stringify({ source: source, callIndex: mergedRoom.callIndex, currentNumber: mergedRoom.currentNumber, calledCount: mergedCalls.length }));
    updateUI();
    return true;
  }

  function syncState(silent) {
    if (!tgId) {
      walletError = 'Telegram identity unavailable.';
      renderWalletLoadStatus();
      walletDebug('error', { tgId: null, stateLoaded: false, userLoaded: !!state.user, initDataPresent: !!telegramInitData, error: walletError });
      if (!silent) showToast('Telegram identity unavailable. Reopen the Mini App from the bot.');
      return Promise.resolve(false);
    }
    if (stateSyncPromise) return stateSyncPromise;
    var requestSequence = ++stateRequestSequence;
    lastWalletRequestAt = Date.now();
    walletError = null;
    renderWalletLoadStatus();
    walletDebug('info', { tgId: tgId, stateLoaded: walletLoaded, userLoaded: !!state.user, initDataPresent: !!telegramInitData, requestSequence: requestSequence });
    audioLog('state request start:', JSON.stringify({ requestSequence: requestSequence, screen: currentScreen }));
    stateSyncPromise = apiRequest(buildStateUrl()).then(function(d){
      audioLog('state response:', JSON.stringify({ requestSequence: requestSequence, source: 'poll' }));
      if (requestSequence < acceptedStateRequestSequence) return true;
      if (!d.user || d.user.availableBalance == null || !Number.isFinite(Number(d.user.availableBalance))) {
        throw new Error('Authenticated wallet data is unavailable.');
      }
      acceptedStateRequestSequence = requestSequence;
      state.user = d.user;
      walletLoaded = true;
      walletError = null;
      walletDebug('info', { tgId: tgId, stateLoaded: true, userLoaded: true, balance: d.user.balance, availableBalance: d.user.availableBalance, playBalance: d.user.playBalance, requestSequence: requestSequence });
      renderWalletLoadStatus();
      if (d.room && typeof d.room.serverTime === 'number') {
        serverTimeOffset = d.room.serverTime - Date.now();
      }
      var preservedSelection = Array.isArray(state.selectedCartelas) ? state.selectedCartelas.slice() : [];
      var preservedPreview = Array.isArray(state.previewCartelas) ? state.previewCartelas.slice() : [];
      if (currentScreen === 'picker' && !Array.isArray(d.selectedCartelas) && preservedSelection.length) {
        d.selectedCartelas = preservedSelection.slice();
      }
      if (currentScreen === 'picker' && !Array.isArray(d.previewCartelas) && preservedPreview.length) {
        d.previewCartelas = preservedPreview.slice();
      }
      if (!applyGameState(d, 'poll')) { updateUI(); return true; }
      if (!audioBaselineReady) {
        var initialCalled = state.room && Array.isArray(state.room.calledNumbers) ? state.room.calledNumbers : [];
        lastBallCount = initialCalled.length;
        lastBallNumber = initialCalled.length ? initialCalled[initialCalled.length - 1] : null;
        lastSpokenCallSequence = Number(state.room && state.room.currentIndex || initialCalled.length);
        audioBaselineReady = true;
      }
      if (!Array.isArray(state.previewCartelas)) state.previewCartelas = state.previewCartelas || [];
      if (!Array.isArray(state.pendingRequests)) state.pendingRequests = state.pendingRequests || [];
      if (currentScreen === 'picker') applySelectionSnapshot(state);
      if (state.user && state.user.settings) {
        prefs.audio = !!state.user.settings.audio;
        prefs.vibration = !!state.user.settings.vibration;
        prefs.autoMark = true;
        prefs.language = state.user.language === 'en' ? 'en' : 'am';
      }
      updateUI();
      applyLanguage();
      if (state.lastWinnerEvent) {
        var endTs = Number(state.lastWinnerEvent.winnerEndsAt || 0);
        if (endTs && now() < endTs) showWinnerOverlay(state.lastWinnerEvent);
      }
      if (currentScreen === 'picker' && (state.selectedCartelas || []).length && !state.previewCartelas.length) {
        loadSelectedPreviews().catch(function(){});
      }
      if (state.cartelas && state.cartelas.length && state.room && state.room.status === 'RUNNING' && currentScreen === 'picker') {
        showScreen('game');
      }
      return true;
    }).catch(function(e){
      walletLoaded = false;
      walletError = e.message || 'Unable to load wallet.';
      walletDebug('error', { tgId: tgId, stateLoaded: false, userLoaded: !!state.user, balance: null, availableBalance: null, playBalance: null, error: walletError, code: e.code || null, status: e.status || null });
      renderWalletLoadStatus();
      ensureVisibleScreen();
      updateUI();
      if (!silent) showToast('Wallet unavailable. Tap Retry.');
      return false;
    }).finally(function(){ stateSyncPromise = null; });
    return stateSyncPromise;
  }
  window.syncState = syncState;

  function savePrefs() {
    return apiRequest('/api/settings', { method: 'POST', body: {
      audio: prefs.audio, vibration: prefs.vibration, language: prefs.language
    }}).catch(function(){});
  }

  function toggleCard(n) {
    if (!walletLoaded) { showToast('Could not load your balance.'); return Promise.resolve(); }
    if (selected.has(n)) {
      var idempotencyKey = window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
      return apiRequest('/api/deselect-cartela', { method: 'POST', body: { cartelaId: n, idempotencyKey: idempotencyKey } }).then(function(d){
        selected = new Set((d.cartelas || []).map(Number));
        state.selectedCartelas = Array.from(selected);
        selectionDirtyAt = Date.now();
        state.user = state.user || {};
        if (d.playBalance !== undefined)      state.user.playBalance = d.playBalance;
        if (d.balance !== undefined)          state.user.balance = d.balance;
        if (d.availableBalance !== undefined) state.user.availableBalance = d.availableBalance;
        if (d.reservedBalance !== undefined)  state.user.reservedBalance = d.reservedBalance;
        if (d.room) state.room = d.room;
        state.previewCartelas = Array.isArray(d.previewCartelas) ? d.previewCartelas : [];
        renderPicker();
        syncState(true).catch(function(){});
        showToast('↩ Cartela #' + String(n).padStart(2, '0') + ' released');
      }).catch(function(e){ showToast(e.message || 'Could not deselect'); });
    }
    if (selected.size >= 2) { showToast('⚠️ Maximum 2 cartelas allowed.'); return Promise.resolve(); }
    var u = state.user || {};
    var balRaw = Number(u.availableBalance);
    var balance = Number.isFinite(balRaw) ? balRaw : (Number.isFinite(Number(u.balance)) ? Number(u.balance) : 0);
    if (balance < 10) { showToast('⚠️ Insufficient balance. You need 10.00 BIRR.'); return Promise.resolve(); }
    return apiRequest('/api/select-cartela', { method: 'POST', body: { cartelaId: n } }).then(function(d){
      selected = new Set((d.cartelas || []).map(Number));
      state.selectedCartelas = Array.from(selected);
      selectionDirtyAt = Date.now();
      state.user = state.user || {};
      if (d.playBalance !== undefined)      state.user.playBalance = d.playBalance;
      if (d.balance !== undefined)          state.user.balance = d.balance;
      if (d.availableBalance !== undefined) state.user.availableBalance = d.availableBalance;
      if (d.reservedBalance !== undefined)  state.user.reservedBalance = d.reservedBalance;
      if (d.room) state.room = d.room;
      state.previewCartelas = Array.isArray(d.previewCartelas) ? d.previewCartelas : (d.card ? [d.card] : []);
      renderPicker();
      syncState(true).catch(function(){});
      showToast('🎟 Cartela #' + String(n).padStart(2, '0') + ' selected');
    }).catch(function(e){
      renderPicker();
      var selectionMessages = {
        CARTELA_ALREADY_TAKEN: 'This cartela is already selected.',
        INSUFFICIENT_BALANCE: 'Insufficient Play Balance.',
        MAX_CARTELAS_REACHED: 'Maximum 2 cartelas.',
        ROOM_STARTED: 'This game has already started.',
        GAME_FINISHED: 'This game has finished.',
        DATABASE_UNAVAILABLE: 'Database temporarily unavailable. Please try again.',
      };
      showToast('⚠️ ' + (selectionMessages[e.code] || e.message || 'Could not select cartela'));
    });
  }
  window.toggleCartela = toggleCard;

  function openPicker() {
    if (!tgId) { showToast('Telegram user ID is missing.'); return Promise.resolve(false); }
    if (state.room && state.room.status === 'RUNNING' && state.cartelas && state.cartelas.length) {
      showScreen('game');
      showToast('Round already started.');
      return Promise.resolve(true);
    }
    selected = new Set((state.selectedCartelas || []).map(Number));
    showScreen('picker');
    renderPicker();
    syncState(!walletLoaded).catch(function(){});
    return Promise.resolve(true);
  }
  window.openPicker = openPicker;

  function loadSelectedPreviews() {
    if (!selected.size) { state.previewCartelas = []; renderSelectedPreviews(); return Promise.resolve(); }
    return apiRequest('/api/preview', { method: 'POST', body: {} }).then(function(d){
      state.previewCartelas = d.cartelas || [];
      renderSelectedPreviews();
    }).catch(function(){ renderSelectedPreviews(); });
  }

  function claimBingo() {
    if (!state.user || !state.cartelas || !state.cartelas.length) { showToast('You are not in the active game.'); return; }
    if (!state.room || state.room.status !== 'RUNNING') { showToast('The game is not running.'); return; }
    unlockAudio();
    return apiRequest('/api/claim', { method: 'POST', body: {} }).then(function(d){
      if (d.valid) {
        showToast('🎉 Valid BINGO!');
      } else {
        showToast(d.message || 'Incorrect BINGO.');
        if (d.eliminated) {
          state.cartelas = [];
          return syncState(true).then(function(){ showScreen('lobby'); });
        }
      }
    }).catch(function(e){ showToast(e.message || 'Unable to submit BINGO claim.'); });
  }
  window.claimBingo = claimBingo;

  function leaveGame() {
    return apiRequest('/api/leave', { method: 'POST', body: {} }).then(function(d){
      state.cartelas = [];
      state.selectedCartelas = [];
      selected = new Set();
      showScreen('lobby');
      return syncState(true).then(function(){
        showToast(d.refund > 0 ? '↩ Left. Refunded.' : 'You left the room.');
      });
    }).catch(function(e){ showToast(e.message || 'Could not leave room'); });
  }
  window.leaveGame = leaveGame;

  // DEPOSIT FLOW (Mini App)
  function depositFlow() {
    showScreen('deposit');
    return false;
  }

  // WITHDRAW FLOW (Mini App)
  function withdrawFlow() {
    showScreen('withdraw');
    return false;
  }

  var depositMethod = '';
  var withdrawMethod = '';
  function renderWithdrawPage() {
    var u = state.user || {};
    var available = Number(u.availableBalance);
    if (!Number.isFinite(available)) available = Number(u.playBalance || 0);
    var el = $('withdraw-available');
    if (el) el.textContent = walletLoaded ? money(available) + ' BIRR' : 'Loading...';
  }
  function submitDepositPage() {
    var amount = Number(($('deposit-amount') || {}).value);
    var reference = String(($('deposit-reference') || {}).value || '').trim();
    if (!depositMethod) return showToast('⚠️ Choose Telebirr or CBE.');
    if (!Number.isFinite(amount) || amount <= 0) return showToast('⚠️ Enter a valid deposit amount in BIRR.');
    if (!reference) return showToast('⚠️ Reference is required.');
    apiRequest('/api/deposit', { method: 'POST', body: { amount: amount, method: depositMethod, name: '', reference: reference, proof: '' } })
      .then(function(){ showToast('⏳ Deposit submitted — pending admin approval.'); return syncState(true); })
      .then(function(){ showScreen('wallet'); })
      .catch(function(e){ showToast(e.message || 'Could not submit deposit.'); });
  }
  function submitWithdrawPage() {
    var amount = Number(($('withdraw-amount') || {}).value);
    var name = String(($('withdraw-name') || {}).value || '').trim();
    var destination = String(($('withdraw-destination') || {}).value || '').trim();
    var u = state.user || {};
    var available = Number(u.availableBalance);
    if (!Number.isFinite(available)) available = Number(u.playBalance || 0);
    if (!withdrawMethod) return showToast('⚠️ Choose Telebirr or CBE.');
    if (!Number.isFinite(amount) || amount < 50 || amount > available) return showToast('⚠️ Invalid withdrawal amount.');
    if (!name) return showToast('⚠️ Name is required.');
    if (!destination) return showToast('⚠️ Destination is required.');
    apiRequest('/api/withdraw', { method: 'POST', body: { amount: amount, method: withdrawMethod, name: name, destination: destination } })
      .then(function(){ showToast('⏳ Withdrawal submitted — pending admin approval.'); return syncState(true); })
      .then(function(){ showScreen('wallet'); })
      .catch(function(e){ showToast(e.message || 'Could not submit withdrawal.'); });
  }

  function togglePref(key) {
    if (key === 'autoMark') { showToast('⚡ Auto-Marking is always ON.'); return; }
    prefs[key] = !prefs[key];
    if (key === 'audio') {
      var sw = $('switch-audio'); if (sw) sw.classList.toggle('on', prefs.audio);
      showToast('🔊 Caller Audio ' + (prefs.audio ? 'ON' : 'OFF'));
      if (prefs.audio) unlockAudio();
    } else if (key === 'vibration') {
      var sv = $('switch-vibration'); if (sv) sv.classList.toggle('on', prefs.vibration);
      showToast('📳 Vibration ' + (prefs.vibration ? 'ON' : 'OFF'));
      if (prefs.vibration) vibrateCall();
    }
    savePrefs();
  }

  function languageFlow() {
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch(e){}
    }
    speechQueue = [];
    pendingSpeak = null;
    speechBusy = false;
    lastSpokenKey = '';
    remoteAudioBusy = false;
    ttsPrimed = false;
    prefs.language = prefs.language === 'am' ? 'en' : 'am';
    if (state.user) state.user.language = prefs.language;
    applyLanguage();
    showToast(prefs.language === 'am' ? '🌐 ቋንቋ ወደ አማርኛ ተቀይሯል።' : '🌐 Language changed to English.');
    return savePrefs();
  }

  function scheduleReconnect(delay) {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = setTimeout(function(){
      reconnectScheduled = false;
      connectSSE();
    }, delay || 300);
  }

  function connectSSE() {
    try { if (sse) { sse.close(); sse = null; } } catch(e){}
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
    reconnectScheduled = false;
    clearTimeout(sseWatchdogTimer);
    sseWatchdogTimer = null;

    try {
      sse = new EventSource('/api/stream');
      sseConnected = false;

      sse.addEventListener('open', function(){
        sseConnected = true;
        lastSSEMessageAt = Date.now();
        syncState(true).catch(function(){});
      });

      sse.addEventListener('room:update', function(e){
        lastSSEMessageAt = Date.now();
        try {
          var room = JSON.parse(e.data);
          if (room && typeof room.serverTime === 'number') {
            serverTimeOffset = room.serverTime - Date.now();
          }
          var json = JSON.stringify(room);
          if (json === lastRoomJson) return;
          lastRoomJson = json;
          var currentRoom = state && state.room ? state.room : {};
          var currentIndex = Number(currentRoom.currentIndex || (currentRoom.calledNumbers || []).length || 0);
          var incomingCalls = Array.isArray(room.calledNumbers) ? room.calledNumbers : null;
          var incomingIndex = Number(room.currentIndex || (incomingCalls || []).length || 0);
          if (incomingIndex < currentIndex || (incomingCalls && incomingCalls.length < (currentRoom.calledNumbers || []).length)) {
            audioLog('room:update rejected as stale:', JSON.stringify({ currentIndex: currentIndex, incomingIndex: incomingIndex, currentCalls: (currentRoom.calledNumbers || []).length, incomingCalls: incomingCalls ? incomingCalls.length : null }));
            return;
          }
          var prevSelection = Array.isArray(state.selectedCartelas) ? state.selectedCartelas.slice() : [];
          var prevPreview = Array.isArray(state.previewCartelas) ? state.previewCartelas.slice() : [];
          if (currentScreen === 'picker' && !Array.isArray(room.selectedCartelas) && prevSelection.length) {
            room.selectedCartelas = prevSelection.slice();
          }
          if (currentScreen === 'picker' && !Array.isArray(room.previewCartelas) && prevPreview.length) {
            room.previewCartelas = prevPreview.slice();
          }
          applyGameState({ room: room }, 'sse-room-update');
          if (currentScreen === 'picker') {
            if (Array.isArray(state.selectedCartelas) && state.selectedCartelas.length) {
              selected = new Set(state.selectedCartelas.map(Number));
            }
            renderPicker();
          } else {
            updateUI();
          }
          checkFinishedFromPoll(room);
        } catch(err){}
      });

      sse.addEventListener('wallet:update', function(e){
        lastSSEMessageAt = Date.now();
        try {
          var d = JSON.parse(e.data);
          if (String(d.tgId) !== String(tgId) || !state.user) return;
          if (d.balance !== undefined)          state.user.balance = d.balance;
          if (d.playBalance !== undefined)      state.user.playBalance = d.playBalance;
          if (d.availableBalance !== undefined) state.user.availableBalance = d.availableBalance;
          if (d.reservedBalance !== undefined)  state.user.reservedBalance = d.reservedBalance;
          updateUI();
        } catch(err){}
      });

      sse.addEventListener('room:new', function(e){
        lastSSEMessageAt = Date.now();
        try {
          applyGameState({ room: JSON.parse(e.data) }, 'sse-room-new');
          state.cartelas = [];
          state.selectedCartelas = [];
          selected = new Set();
          lastFinishedKey = '';
          lastBallCount = 0;
          lastBallNumber = null;
          lastSpokenCallSequence = 0;
          lastSpokenKey = '';
          speechQueue = [];
          winnerVisibleFor = '';
          hideWinnerOverlay();
          showScreen('lobby');
          updateUI();
          showToast('🎮 New room ready!');
        } catch(err){}
      });

      sse.addEventListener('game:started', function(e){
        lastSSEMessageAt = Date.now();
        try {
          applyGameState({ room: JSON.parse(e.data) }, 'sse-game-started');
          selected = new Set();
          state.selectedCartelas = [];
          state.previewCartelas = [];
          lastSpokenKey = '';
          lastSpokenCallSequence = 0;
          speechQueue = [];
          winnerVisibleFor = '';
          hideWinnerOverlay();
          showScreen('game');
          syncState(true).catch(function(){});
          updateUI();
          showToast('🔴 Game started!');
        } catch(err){}
      });

      sse.addEventListener('game:ball', function(e){
        lastSSEMessageAt = Date.now();
        try {
          var d = JSON.parse(e.data);
          if (typeof d.serverTime === 'number') {
            serverTimeOffset = d.serverTime - Date.now();
          }
          applyBallEvent(d);
        } catch(err){}
      });

      sse.addEventListener('game:finished', function(e){
        lastSSEMessageAt = Date.now();
        try {
          var d = JSON.parse(e.data);
          if (typeof d.serverTime === 'number') {
            serverTimeOffset = d.serverTime - Date.now();
          }
          vibrateWin();
          showWinnerOverlay(d);
        } catch(err){}
      });

      sse.onerror = function(){
        sseConnected = false;
        try { if (sse) sse.close(); sse = null; } catch(e){}
        syncState(true).catch(function(){});
        scheduleReconnect(1500);
      };

      sseWatchdogTimer = setInterval(function(){
        if (sse && !sseConnected && lastSSEMessageAt && Date.now() - lastSSEMessageAt > 8000) {
          try { sse.close(); } catch(e){}
          sse = null;
          sseConnected = false;
          scheduleReconnect(0);
        }
      }, 3000);

    } catch (e) {
      scheduleReconnect(1500);
    }
  }

  function onResume() {
    if (resumeInFlight) return;
    resumeInFlight = true;
    syncState(true).catch(function(){}).then(function(){ resumeInFlight = false; });
    if (!sse || sse.readyState === EventSource.CLOSED || sse.readyState === EventSource.CONNECTING) {
      scheduleReconnect(200);
    }
  }

  function bindUI() {
    var walletRetry = $('wallet-retry');
    if (walletRetry && !walletRetry.dataset.bound) {
      walletRetry.dataset.bound = '1';
      walletRetry.addEventListener('click', function(){
        walletError = null;
        renderWalletLoadStatus();
        syncState(false).catch(function(){});
      });
    }
    var joinBtn = $('join-btn');
    if (joinBtn && !joinBtn.dataset.bound) {
      joinBtn.dataset.bound = '1';
      joinBtn.addEventListener('click', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        unlockAudio();
        openPicker().catch(function(err){ showToast(err && err.message ? err.message : 'Unable to open picker'); });
      }, false);
    }

    [['nav-play', 'lobby'], ['nav-wallet', 'wallet'], ['nav-history', 'history'], ['nav-settings', 'settings']].forEach(function(pair){
      var id = pair[0], screen = pair[1];
      var el = $(id);
      if (!el || el.dataset.bound) return;
      el.dataset.bound = '1';
      el.addEventListener('click', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        if (currentScreen === 'game' && screen !== 'lobby') {
          showToast('⚠️ Finish the round first.');
          return;
        }
        showScreen(screen);
        syncState(true).catch(function(){});
      }, false);
    });

    var grid = $('picker-grid');
    if (grid && !grid.dataset.bound) {
      grid.dataset.bound = '1';
      grid.addEventListener('click', function(ev){
        var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-cartela]') : null;
        if (!btn || !grid.contains(btn) || pickerBusy) return;
        ev.preventDefault();
        ev.stopPropagation();
        unlockAudio();
        var n = Number(btn.dataset.cartela);
        if (!Number.isInteger(n)) return;
        pickerBusy = true;
        Promise.resolve(toggleCard(n)).finally(function(){ pickerBusy = false; });
      }, false);
    }

    var bingoBtn = $('main-bingo-btn');
    if (bingoBtn && !bingoBtn.dataset.bound) {
      bingoBtn.dataset.bound = '1';
      bingoBtn.addEventListener('click', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        if (bingoBtn.disabled) return;
        unlockAudio();
        claimBingo();
      }, false);
    }

    var setAudio = $('setting-audio');
    if (setAudio && !setAudio.dataset.bound) {
      setAudio.dataset.bound = '1';
      setAudio.addEventListener('click', function(ev){ ev.preventDefault(); unlockAudio(); togglePref('audio'); });
    }
    var setVib = $('setting-vibration');
    if (setVib && !setVib.dataset.bound) {
      setVib.dataset.bound = '1';
      setVib.addEventListener('click', function(ev){ ev.preventDefault(); togglePref('vibration'); });
    }
    var setLang = $('setting-language');
    if (setLang && !setLang.dataset.bound) {
      setLang.dataset.bound = '1';
      setLang.addEventListener('click', function(ev){ ev.preventDefault(); languageFlow(); });
    }
    var testAudio = $('test-audio-btn');
    if (testAudio && !testAudio.dataset.bound) {
      testAudio.dataset.bound = '1';
      var lastTestAudioGesture = 0;
      var runTestAudio = function(ev){
        ev.preventDefault();
        var timestamp = Date.now();
        if (timestamp - lastTestAudioGesture < 500) return;
        lastTestAudioGesture = timestamp;
        audioLog('TEST AUDIO button gesture:', ev.type);
        unlockAudio();
        window.testBingoAudio();
      };
      testAudio.addEventListener('touchend', runTestAudio, false);
      testAudio.addEventListener('click', runTestAudio, false);
    } else if (!testAudio) {
      audioLog('TEST AUDIO button not found during bindUI');
    }
    [['test-english-audio-btn', 'en'], ['test-amharic-audio-btn', 'am']].forEach(function(pair){
      var button = $(pair[0]);
      if (!button || button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('touchend', function(ev){ ev.preventDefault(); unlockAudio(); window.testBingoAudio(pair[1]); }, false);
      button.addEventListener('click', function(ev){ ev.preventDefault(); unlockAudio(); window.testBingoAudio(pair[1]); }, false);
    });

    var wdep = $('wallet-deposit-btn');
    if (wdep && !wdep.dataset.bound) {
      wdep.dataset.bound = '1';
      wdep.addEventListener('click', function(ev){ ev.preventDefault(); depositFlow(); });
    }
    var wwd = $('wallet-withdraw-btn');
    if (wwd && !wwd.dataset.bound) {
      wwd.dataset.bound = '1';
      wwd.addEventListener('click', function(ev){ ev.preventDefault(); withdrawFlow(); });
    }
    Array.prototype.forEach.call(document.querySelectorAll('.wallet-method'), function(button){
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', function(){
        depositMethod = button.dataset.method || '';
        document.querySelectorAll('.wallet-method').forEach(function(item){ item.classList.toggle('selected', item === button); });
        var instructions = $('deposit-instructions');
        if (instructions) {
          instructions.style.display = 'block';
          var payment = window.__SHISHO_PAYMENT__ || {};
          instructions.textContent = depositMethod === 'Telebirr'
            ? 'Send money to Telebirr: ' + (payment.telebirrNumber || '+251900000000')
            : 'Send money to CBE: ' + (payment.cbeAccount || '1000000000000');
        }
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.withdraw-method'), function(button){
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', function(){
        withdrawMethod = button.dataset.method || '';
        document.querySelectorAll('.withdraw-method').forEach(function(item){ item.classList.toggle('selected', item === button); });
      });
    });
    var depositSubmit = $('deposit-submit');
    if (depositSubmit) depositSubmit.addEventListener('click', submitDepositPage);
    var withdrawSubmit = $('withdraw-submit');
    if (withdrawSubmit) withdrawSubmit.addEventListener('click', submitWithdrawPage);
    var depositBack = $('deposit-back');
    if (depositBack) depositBack.addEventListener('click', function(){ showScreen('wallet'); });
    var withdrawBack = $('withdraw-back');
    if (withdrawBack) withdrawBack.addEventListener('click', function(){ showScreen('wallet'); });
  }

  function start() {
    if (state.user && state.user.availableBalance != null && Number.isFinite(Number(state.user.availableBalance))) {
      walletLoaded = true;
      walletError = null;
    }
    if (state.user) prefs.language = state.user.language === 'en' ? 'en' : 'am';
    try { bindUI(); } catch(e){ audioLog('bindUI failure:', e); }
    try { showScreen(currentScreen); } catch(e){ audioLog('showScreen failure:', e); }
    try { ensureVisibleScreen(); } catch(e){ audioLog('screen recovery failure:', e); }
    try { updateUI(); } catch(e){ audioLog('updateUI failure:', e); }
    try { applyLanguage(); } catch(e){ audioLog('applyLanguage failure:', e); }
    // Live game synchronization uses one request-driven poll on Vercel.
    // SSE remains available for diagnostics but is not a second state source.
    try { startRAF(); } catch(e){ audioLog('startRAF failure:', e); }

    syncState(false).catch(function(){});

    if (state.lastWinnerEvent) {
      var endTs = Number(state.lastWinnerEvent.winnerEndsAt || 0);
      if (endTs && now() < endTs) {
        try { showWinnerOverlay(state.lastWinnerEvent); } catch(e){}
      }
    }

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function(){
      if (document.hidden) return;
      if (!walletLoaded) {
        if (!stateSyncPromise && Date.now() - lastWalletRequestAt > 8000) syncState(true).catch(function(){});
        return;
      }
      var ov = $('winner-overlay');
      if (ov && ov.classList.contains('show')) return;
      if (currentScreen === 'picker' || currentScreen === 'game' || currentScreen === 'wallet') {
        syncState(true).catch(function(){});
      }
    }, 2500);
  }

  window.addEventListener('focus', function(){ onResume(); });
  window.addEventListener('online', function(){ onResume(); });
  window.addEventListener('pageshow', function(){ onResume(); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
</script>
</div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP SERVER / API
// ---------------------------------------------------------------------------
async function handleHttpRequest(req, res) {
  const parsed = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  if (configuredBotToken() && !bot.webhookConfigured && !/localhost|127\.0\.0\.1/.test(String(CONFIG.BASE_URL || ''))) {
    void bot.ensureWebhook().catch(() => {});
  }

  if ((parsed.pathname === '/api/telegram' || parsed.pathname === '/api/telegram/webhook') && req.method === 'POST') {
    try {
      const body = await readJson(req);
      if (body && body.message) {
        await bot.handleUpdate(body);
      } else if (body && body.callback_query) {
        await bot.handleUpdate(body);
      }
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('[Bot] webhook error:', error.message);
      return sendJson(res, 400, { ok: false, error: error.message });
    }
  }

  if (parsed.pathname === '/api/caller-audio' && req.method === 'GET') {
    const text = String(parsed.query.text || '').trim().slice(0, 120);
    const language = parsed.query.lang === 'am' ? 'am' : 'en';
    if (!text) return sendJson(res, 400, { error: 'Missing caller text.' });
    const upstream = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${language}&q=${encodeURIComponent(text)}`;
    https.get(upstream, upstreamRes => {
      res.writeHead(upstreamRes.statusCode === 200 ? 200 : 502, {
        'Content-Type': upstreamRes.headers['content-type'] || 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      upstreamRes.pipe(res);
    }).on('error', error => {
      console.error('[CallerAudio] upstream error:', error.message);
      if (!res.headersSent) sendJson(res, 502, { error: 'Caller audio unavailable.' });
      else res.destroy(error);
    });
    return;
  }

  if (parsed.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (e) {}
    }, 15000);
    res.on('close', () => clearInterval(heartbeat));
    roomManager.subscribe(res);
    return;
  }

  if (parsed.pathname === '/api/state' && req.method === 'GET') {
    const requestId = crypto.randomUUID();
    try {
      const user = getUserFromRequest(parsed, req, { requireInitData: DATABASE_ENABLED });
      let availableBalance;
      let roomStateError = null;
      if (DATABASE_ENABLED || process.env.VERCEL) {
        assertDatabaseConfigured();
        const persistedResult = await findOrCreateUserByTgId({
          tgId: user.tgId,
          firstName: user.firstName,
          lastName: user.lastName,
          username: user.username,
          language: user.language === 'en' ? 'en' : 'am',
        });
        const persistedUser = persistedResult.user;
        logWalletDebug('[MINIAPP AUTH]', user.tgId, {
          authSource: req.headers['x-telegram-init-data'] ? 'validated-initData-header' : 'development-tgId',
          initDataTgId: req.headers['x-telegram-init-data'] ? walletLogId(user.tgId) : null,
          databaseTgId: persistedUser ? walletLogId(persistedUser.tg_id) : null,
          databaseUserId: persistedUser ? walletLogId(persistedUser.id) : null,
          databaseUserFound: !!persistedUser,
          databaseTgIdMatches: persistedUser ? String(persistedUser.tg_id) === String(user.tgId) : false,
        });
        if (!persistedUser || String(persistedUser.tg_id) !== String(user.tgId)) {
          throw new Error('Authenticated database user was not found.');
        }
        if (persistedUser?.language === 'en' || persistedUser?.language === 'am') {
          user.language = persistedUser.language;
        }
        const wallet = await getUserBalance(user.tgId);
        if (!wallet) {
          throw new Error('Authenticated user wallet was not found.');
        }
        if (wallet.play_balance == null || wallet.reserved_balance == null || wallet.balance == null) {
          throw new Error('Authenticated user wallet data is incomplete.');
        }
        availableBalance = getAvailableWalletBalance(wallet);
        user.balance = money(wallet.balance);
        user.playBalance = money(wallet.play_balance);
        user.reservedBalance = money(wallet.reserved_balance);
        logWalletDebug('[MINIAPP BALANCE DEBUG]', user.tgId, {
          authenticated: true,
          databaseUserFound: true,
          databaseUserId: walletLogId(persistedUser.id),
          databaseTgIdMatches: String(persistedUser.tg_id) === String(user.tgId),
          databaseBalance: wallet.balance,
          databasePlayBalance: wallet.play_balance,
          databaseReservedBalance: wallet.reserved_balance,
          availableBalance: availableBalance,
          stateResponse: 'SUCCESS',
        });
      } else {
        availableBalance = getAvailableWalletBalance(user);
      }
      if (DATABASE_ENABLED && !roomManager.room.dbId) {
        try {
          await roomManager.restoreActiveRoomFromDb();
        } catch (error) {
          console.error('[State] room restore unavailable', JSON.stringify({ requestId, code: error.code || null, message: error.message, stack: error.stack }));
          roomStateError = 'DATABASE_UNAVAILABLE';
        }
      }
      if (DATABASE_ENABLED && !roomManager.room.dbId) {
        console.error('[State] no persisted room available', JSON.stringify({ requestId }));
        roomStateError = roomStateError || 'ROOM_UNAVAILABLE';
      }
      if (DATABASE_ENABLED && roomManager.room.dbId && !roomStateError) {
        let authoritative;
        try {
          authoritative = await progressRoom(roomManager.room.dbId);
        } catch (error) {
          console.error('[State] progression read failed', JSON.stringify({ requestId, roomId: roomManager.room.dbId, error: error.message, stack: error.stack }));
          roomStateError = isDatabaseUnavailable(error) ? 'DATABASE_UNAVAILABLE' : 'ROOM_STATE_UNAVAILABLE';
        }
        if (!authoritative && !roomStateError) {
          console.error('[State] missing authoritative room', JSON.stringify({ requestId, roomId: roomManager.room.dbId }));
          roomStateError = 'ROOM_STATE_UNAVAILABLE';
        }
        try {
          if (!authoritative) throw new Error('Authoritative room state unavailable.');
          const dbCalled = await getRoomCalledNumbers(roomManager.room.dbId);
          roomManager.room.status = String(authoritative.status || roomManager.room.status);
          roomManager.room.currentIndex = Number(authoritative.current_index || dbCalled.length || roomManager.room.currentIndex || 0);
          roomManager.room.calledNumbers = dbCalled.map(item => Number(item.number)).filter(Number.isFinite);
          const lastCall = dbCalled.length ? dbCalled[dbCalled.length - 1] : null;
          roomManager.room.lastCallAt = lastCall?.created_at ? Date.parse(lastCall.created_at) : null;
          roomManager.room.nextCallAt = roomManager.room.lastCallAt ? roomManager.room.lastCallAt + CONFIG.BALL_INTERVAL_MS : null;
          roomManager.room.countdown = Number(authoritative.countdown_seconds || roomManager.room.countdown || CONFIG.COUNTDOWN_SECONDS);
          roomManager.room.countdownEndsAt = authoritative.countdown_ends_at ? Date.parse(authoritative.countdown_ends_at) : roomManager.room.countdownEndsAt;
          roomManager.room.startedAt = authoritative.started_at ? Date.parse(authoritative.started_at) : roomManager.room.startedAt;
          roomManager.room.finishedAt = authoritative.finished_at ? Date.parse(authoritative.finished_at) : roomManager.room.finishedAt;
          roomManager.room.winnerEndsAt = authoritative.winner_ends_at ? Date.parse(authoritative.winner_ends_at) : roomManager.room.winnerEndsAt;
          roomManager.room.pot = Number(authoritative.pot || roomManager.room.pot || 0);
        } catch (error) {
          console.error('[State] called-number read failed', JSON.stringify({ requestId, roomId: roomManager.room.dbId, error: error.message, stack: error.stack }));
          roomStateError = roomStateError || (isDatabaseUnavailable(error) ? 'DATABASE_UNAVAILABLE' : 'ROOM_STATE_UNAVAILABLE');
        }
      }
      const player = roomManager.getPlayer(user.tgId);
      const lastWinnerEvent = (roomManager.lastFinishedEvent && (Date.now() - roomManager.lastFinishedAt) < (CONFIG.WINNER_DISPLAY_MS + CONFIG.WINNER_REPLAY_GRACE_MS))
        ? roomManager.lastFinishedEvent : null;

      const pendingRequests = [];
      for (const dep of DB.deposits.values()) {
        if (String(dep.tgId) === String(user.tgId) && dep.status === 'PENDING') {
          pendingRequests.push({ id: dep.id, type: 'deposit', amount: dep.amount, method: dep.method, createdAt: dep.createdAt });
        }
      }
      for (const wd of DB.withdrawals.values()) {
        if (String(wd.tgId) === String(user.tgId) && wd.status === 'PENDING') {
          pendingRequests.push({ id: wd.id, type: 'withdraw', amount: wd.amount, method: wd.method, createdAt: wd.createdAt });
        }
      }
      pendingRequests.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

      const response = {
        user: {
          tgId: user.tgId, firstName: user.firstName, lastName: user.lastName, username: user.username,
          balance: money(user.balance), playBalance: money(user.playBalance),
          availableBalance,
          reservedBalance: money(user.reservedBalance || 0),
          gamesPlayed: user.gamesPlayed, totalWins: user.totalWins,
          totalWinnings: money(user.totalWinnings), cartelasPurchased: user.cartelasPurchased,
          isRegistered: !!user.isRegistered,
          referralEarnings: money(user.referralEarnings || 0),
          accountStatus: user.isRegistered ? 'ACTIVE' : 'UNVERIFIED',
          language: user.language === 'en' ? 'en' : 'am',
          settings: user.settings || { audio: true, vibration: true, autoMark: true },
        },
        room: roomManager.publicState(),
        cartelas: player ? player.cartelas : [],
        selectedCartelas: roomManager.userReservations(user.tgId),
        previewCartelas: roomManager.userReservations(user.tgId).map(id => roomManager.room.reservations.get(id)?.card).filter(Boolean),
        lastWinnerEvent,
        pendingRequests,
        roomStateError,
        history: (DB.userGameHistory.get(String(user.tgId)) || []).slice(0, 20),
        ranks: [],
      };
      console.log('[State] response', JSON.stringify({ requestId, roomId: response.room?.id, status: response.room?.status, currentIndex: response.room?.currentIndex, currentNumber: response.room?.currentNumber, calledCount: response.room?.calledNumbers?.length || 0, lastCallAt: response.room?.lastCallAt || null, nextCallAt: response.room?.nextCallAt || null, source: DATABASE_ENABLED ? 'tidb' : 'memory' }));
      return sendJson(res, 200, response);
    } catch (e) {
      console.error('[State] request failed', JSON.stringify({ requestId, error: e.message, stack: e.stack }));
      const databaseUnavailable = e.code === 'DATABASE_UNAVAILABLE' || (DATABASE_ENABLED && isDatabaseUnavailable(e));
      const authFailure = e.code === 'UNAUTHORIZED' || /initdata|telegram webapp identity|telegram user id|missing hash|invalid signature|no user/i.test(String(e.message || ''));
      const authServiceUnavailable = /bot_token not configured|token not configured/i.test(String(e.message || ''));
      const missingRecord = /database user was not found|wallet was not found|wallet data is incomplete/i.test(String(e.message || ''));
      const status = databaseUnavailable || authServiceUnavailable ? 503 : authFailure ? 401 : missingRecord ? 404 : 500;
      const code = databaseUnavailable ? 'DATABASE_UNAVAILABLE' : authServiceUnavailable ? 'TELEGRAM_AUTH_UNAVAILABLE' : authFailure ? 'UNAUTHORIZED' : missingRecord ? 'USER_OR_WALLET_NOT_FOUND' : 'STATE_UNAVAILABLE';
      const message = databaseUnavailable ? 'Wallet service temporarily unavailable. Tap Retry.' : e.message;
      logWalletDebug('[MINIAPP BALANCE DEBUG]', 'unavailable', { authenticated: !authFailure, stateResponse: code, databaseUnavailable, userOrWalletMissing: missingRecord });
      return sendJson(res, status, { error: code, message, requestId });
    }
  }

  if (parsed.pathname === '/api/settings' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const user = await getUserFromBody(body, req);
      if (!user.settings) user.settings = { audio: true, vibration: true, autoMark: true };
      if (typeof body.audio === 'boolean') user.settings.audio = body.audio;
      if (typeof body.vibration === 'boolean') user.settings.vibration = body.vibration;
      user.settings.autoMark = true;
      if (body.language === 'am' || body.language === 'en') {
        user.language = body.language;
        if (DATABASE_ENABLED) {
          await findOrCreateUserByTgId({
            tgId: user.tgId,
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            language: body.language,
          });
          await updateUserProfile({ tgId: user.tgId, updates: { language: body.language } });
        }
      }
      saveDB();
      return sendJson(res, 200, { success: true, language: user.language, settings: user.settings });
    } catch (e) { return sendApiError(res, e); }
  }

  if (parsed.pathname === '/api/select-cartela' && req.method === 'POST') {
    const requestId = crypto.randomUUID();
    try {
      const body = await readJson(req);
      const user = await getUserFromBody(body, req);
      assertDatabaseConfigured();
      if (DATABASE_ENABLED && (roomManager.room.dbFailure || !roomManager.room.dbId)) {
        try {
          await roomManager.restoreActiveRoomFromDb();
        } catch (error) {
          console.error('[Cartela] room restore unavailable', JSON.stringify({ code: error.code || null, message: error.message, stack: error.stack }));
            return sendJson(res, 503, { ok: false, code: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable. Please try again.', requestId });
        }
      }
      const idemp = body.idempotencyKey ? checkIdempotency('sel:' + user.tgId + ':' + body.idempotencyKey) : null;
      if (idemp) return sendJson(res, 200, idemp);
      syncAvailableWallet(user);
      const result = await roomManager.reserveCartela(user, body.cartelaId);
      const response = { success: true, ...result };
      if (body.idempotencyKey) setIdempotency('sel:' + user.tgId + ':' + body.idempotencyKey, response);
      return sendJson(res, 200, response);
    } catch (e) {
      console.error('[cartela:ERROR]', JSON.stringify({ requestId, errorName: e.name, errorCode: e.code || null, errorMessage: e.message, errorDetail: e.detail || null, errorConstraint: e.constraint || null }));
      const connectionFailure = isDatabaseUnavailable(e);
      const databaseError = /^[0-9A-Z]{5}$/.test(String(e.code || ''))
        && !['23505', '40001', '40P01'].includes(e.code)
        && !connectionFailure;
      const code = e.code === 'TELEGRAM_AUTH_UNAVAILABLE'
        ? 'TELEGRAM_AUTH_UNAVAILABLE'
        : e.code === 'UNAUTHORIZED'
        ? 'UNAUTHORIZED'
        : e.code === '23505'
        ? 'CARTELA_ALREADY_TAKEN'
        : e.code === '40001' || e.code === '40P01'
          ? 'TRANSACTION_CONFLICT'
          : databaseError
            ? 'DATABASE_ERROR'
          : connectionFailure || e.code === 'DATABASE_UNAVAILABLE'
            ? 'DATABASE_UNAVAILABLE'
            : ['ROOM_NOT_FOUND', 'ROOM_STARTED', 'GAME_ALREADY_STARTED', 'GAME_FINISHED', 'MAX_CARTELAS_REACHED', 'INSUFFICIENT_BALANCE', 'INVALID_CARTELA', 'WALLET_NOT_FOUND'].includes(e.code)
              ? (e.code === 'GAME_ALREADY_STARTED' ? 'ROOM_STARTED' : e.code)
              : e.message === 'CARTELA_ALREADY_TAKEN' ? 'CARTELA_ALREADY_TAKEN' : 'CARTELA_SELECTION_FAILED';
      const messages = {
        CARTELA_ALREADY_TAKEN: 'This cartela is already selected.',
        ROOM_NOT_FOUND: 'The room is no longer available.',
        INSUFFICIENT_BALANCE: 'Insufficient Play Balance.',
        MAX_CARTELAS_REACHED: 'You can select a maximum of 2 cartelas.',
        ROOM_STARTED: 'This game has already started.',
        GAME_FINISHED: 'This game has finished.',
        TRANSACTION_CONFLICT: 'Please try selecting the cartela again.',
        DATABASE_UNAVAILABLE: 'Database temporarily unavailable. Please try again.',
        DATABASE_ERROR: 'Cartela could not be reserved. Please retry.',
        WALLET_NOT_FOUND: 'Wallet temporarily unavailable. Please try again.',
        INVALID_CARTELA: 'Invalid cartela number.',
        UNAUTHORIZED: 'Open the Mini App from Telegram and retry.',
        TELEGRAM_AUTH_UNAVAILABLE: 'Wallet service is not configured. Please try again later.',
      };
      const status = code === 'DATABASE_UNAVAILABLE' || code === 'TELEGRAM_AUTH_UNAVAILABLE' ? 503 : code === 'DATABASE_ERROR' ? 500 : code === 'UNAUTHORIZED' ? 401 : code === 'TRANSACTION_CONFLICT' || code === 'CARTELA_ALREADY_TAKEN' ? 409 : code === 'WALLET_NOT_FOUND' ? 404 : 400;
      return sendJson(res, status, { ok: false, code, message: messages[code] || (code === 'CARTELA_SELECTION_FAILED' ? e.message : 'Could not select cartela.'), requestId });
    }
  }

  if (parsed.pathname === '/api/deselect-cartela' && req.method === 'POST') {
    const requestId = crypto.randomUUID();
    try {
      const body = await readJson(req);
      const user = await getUserFromBody(body, req);
      assertDatabaseConfigured();
      const idempotencyKey = String(body.idempotencyKey || crypto.randomUUID());
      const idemp = checkIdempotency('desel:' + user.tgId + ':' + idempotencyKey);
      if (idemp) return sendJson(res, 200, idemp);
      if (DATABASE_ENABLED && (roomManager.room.dbFailure || !roomManager.room.dbId)) {
        await roomManager.restoreActiveRoomFromDb();
      }
      syncAvailableWallet(user);
      const result = await roomManager.releaseCartela(user, body.cartelaId, idempotencyKey);
      const response = { success: true, ...result };
      setIdempotency('desel:' + user.tgId + ':' + idempotencyKey, response);
      return sendJson(res, 200, response);
    } catch (e) {
      console.error('[cartela:deselect:error]', JSON.stringify({ requestId, errorCode: e.code || null, errorMessage: e.message }));
      const unavailable = isDatabaseUnavailable(e) || e.code === 'DATABASE_UNAVAILABLE';
      const databaseError = /^[0-9A-Z]{5}$/.test(String(e.code || '')) && !unavailable;
      const code = unavailable ? 'DATABASE_UNAVAILABLE'
        : databaseError ? 'DATABASE_ERROR'
          : ['UNAUTHORIZED', 'TELEGRAM_AUTH_UNAVAILABLE', 'ROOM_NOT_FOUND', 'ROOM_STARTED', 'GAME_FINISHED', 'CARTELA_NOT_OWNED', 'INVALID_CARTELA', 'INVALID_IDEMPOTENCY_KEY', 'WALLET_NOT_FOUND'].includes(e.code)
          ? e.code
          : e.message === 'The game has already started.' ? 'ROOM_STARTED'
            : e.message.includes('not currently selected') || e.message.includes('already selected by another player.')
              ? 'CARTELA_NOT_OWNED' : 'CARTELA_RELEASE_FAILED';
      const status = unavailable || code === 'TELEGRAM_AUTH_UNAVAILABLE' ? 503 : code === 'DATABASE_ERROR' ? 500 : code === 'UNAUTHORIZED' ? 401 : code === 'ROOM_STARTED' || code === 'GAME_FINISHED' || code === 'CARTELA_NOT_OWNED' ? 409 : code === 'WALLET_NOT_FOUND' ? 404 : 400;
      const messages = {
        DATABASE_UNAVAILABLE: 'Database temporarily unavailable. Please try again.',
        DATABASE_ERROR: 'Cartela could not be released. Please retry.',
        TELEGRAM_AUTH_UNAVAILABLE: 'Wallet service is not configured. Please try again later.',
        ROOM_NOT_FOUND: 'The room is no longer available.',
        ROOM_STARTED: 'This game has already started.',
        GAME_FINISHED: 'This game has finished.',
        CARTELA_NOT_OWNED: 'This cartela is not selected by your account.',
        INVALID_CARTELA: 'Invalid cartela number.',
        INVALID_IDEMPOTENCY_KEY: 'Invalid cartela request. Please retry.',
        WALLET_NOT_FOUND: 'Wallet temporarily unavailable. Please try again.',
      };
      return sendJson(res, status, { ok: false, code, message: messages[code] || 'Could not release cartela.', requestId });
    }
  }

  if (parsed.pathname === '/api/preview' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const user = await getUserFromBody(body, req);
      const ids = roomManager.userReservations(user.tgId);
      const cards = ids.map(id => roomManager.room.reservations.get(id)?.card).filter(Boolean);
      return sendJson(res, 200, { success: true, cartelas: cards });
    } catch (e) { return sendApiError(res, e); }
  }

  if (parsed.pathname === '/api/leave' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const user = await getUserFromBody(body, req);
      assertDatabaseConfigured();
      const result = roomManager.leaveRoom(user.tgId);
      return sendJson(res, 200, { success: true, ...result });
    } catch (e) { return sendApiError(res, e); }
  }

  if (parsed.pathname === '/api/deposit' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const user = await getUserFromBody(body, req);
      assertDatabaseConfigured();
      const amount = money(body.amount);
      const method = String(body.method || '').trim();
      const reference = String(body.reference || '').trim();
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid deposit amount.');
      if (!['Telebirr', 'CBE'].includes(method)) throw new Error('Choose Telebirr or CBE.');
      if (!reference) throw new Error('Transaction reference is required.');
      const id = crypto.randomUUID();
      const dbUser = await findOrCreateUserByTgId({ tgId: user.tgId, firstName: user.firstName, lastName: user.lastName, username: user.username, language: user.language === 'en' ? 'en' : 'am' });
      const depositResult = DATABASE_ENABLED
        ? await insertDepositIfMissing({ userId: dbUser.user.id, tgId: user.tgId, amount, method, reference })
        : { duplicate: false, record: { id } };
      if (depositResult.duplicate) throw new Error('This deposit reference has already been submitted.');
      const depositId = depositResult.record?.id || id;
      DB.deposits.set(String(depositId), { id: depositId, tgId: user.tgId, amount, method, name: '', reference, status: 'PENDING', createdAt: new Date().toISOString() });
      saveDB();
      if (CONFIG.ADMIN_TELEGRAM_ID && bot.token) {
        console.log('[Telegram] deposit notification', JSON.stringify({ adminId: CONFIG.ADMIN_TELEGRAM_ID, depositId }));
        await bot.sendMessage(CONFIG.ADMIN_TELEGRAM_ID,
          `🔔 *SHISHO BINGO — NEW DEPOSIT*\n\nUser:  ${user.firstName}\nUsername: @${user.username || '—'}\nTelegram ID: ${user.tgId}\n\nMethod: ${method}\nAmount: ${amount.toFixed(2)} BIRR\nTransaction ID: ${reference}\nStatus: PENDING`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '✅ Approve', callback_data: `adm:dep:approve:${depositId}` }],
            [{ text: '❌ Reject',  callback_data: `adm:dep:reject:${depositId}` }],
          ] } });
      }
      return sendJson(res, 200, { success: true, status: 'PENDING', id: depositId });
    } catch (e) { return sendApiError(res, e); }
  }

  if (parsed.pathname === '/api/withdraw' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const user = await getUserFromBody(body, req);
      assertDatabaseConfigured();
      const amount = money(body.amount);
      const method = String(body.method || '').trim();
      const destination = String(body.destination || '').trim();
      const name = String(body.name || '').trim().slice(0, 100);
      if (!Number.isFinite(amount) || amount < CONFIG.MIN_WITHDRAWAL) throw new Error(`Minimum ${CONFIG.MIN_WITHDRAWAL} BIRR.`);
      syncAvailableWallet(user);
      if (amount > user.playBalance) throw new Error(`Maximum ${money(user.playBalance).toFixed(2)} BIRR.`);
      if (!['Telebirr', 'CBE'].includes(method)) throw new Error('Choose Telebirr or CBE.');
      const id = crypto.randomUUID();
      user.playBalance = money(user.playBalance - amount);
      user.balance = money(user.balance - amount);
      user.reservedBalance = money((user.reservedBalance || 0) + amount);
      DB.withdrawals.set(id, { id, tgId: user.tgId, amount, method, name, destination, status: 'PENDING', createdAt: new Date().toISOString() });
      saveDB();
      if (CONFIG.ADMIN_TELEGRAM_ID && bot.token) {
        await bot.sendMessage(CONFIG.ADMIN_TELEGRAM_ID,
          `🔔 *WITHDRAWAL (Mini App)*\n\nUser:  ${user.firstName} (${user.tgId})\nName:  ${name}\nAmount: ${amount.toFixed(2)} BIRR\nMethod: ${method}\nDest:   ${destination}\nID:    ${id}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '✅ Paid',   callback_data: `wd:paid:${id}` }],
            [{ text: '❌ Reject', callback_data: `wd:reject:${id}` }],
          ] } });
      }
      return sendJson(res, 200, { success: true, status: 'PENDING', id });
    } catch (e) { return sendApiError(res, e); }
  }

  if (parsed.pathname === '/api/claim' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const claimUser = await getUserFromBody(body, req);
      assertDatabaseConfigured();
      const idemp = body.idempotencyKey ? checkIdempotency('claim:' + claimUser.tgId + ':' + body.idempotencyKey) : null;
      if (idemp) return sendJson(res, 200, idemp);
      const player = roomManager.getPlayer(claimUser.tgId);
      if (!player) throw new Error('You are not in the active game.');
      if (roomManager.room.status !== 'RUNNING') throw new Error('The game is not running.');
      if (roomManager.room.calledNumbers.length < 4) throw new Error('BINGO is available after 4 numbers.');

      const validation = await roomManager.validateClaim(player);
      if (validation.valid) {
        await roomManager.settleNow(player, validation.winningCards);
        const response = { success: true, valid: true, winningCards: validation.winningCards, message: '🎉 Valid BINGO!' };
        if (body.idempotencyKey) setIdempotency('claim:' + claimUser.tgId + ':' + body.idempotencyKey, response);
        return sendJson(res, 200, response);
      }

      if (player.claimAttempts >= 2) {
        roomManager.room.players.delete(String(player.user.tgId));
        saveDB();
        roomManager.broadcast('room:update', roomManager.publicState());
        return sendJson(res, 200, { success: false, valid: false, eliminated: true, attempts: player.claimAttempts, message: '❌ Incorrect BINGO twice. Removed.' });
      }
      return sendJson(res, 200, { success: false, valid: false, eliminated: false, attempts: player.claimAttempts, attemptsLeft: 1, message: '⚠️ Incorrect BINGO. 1 attempt remaining.' });
    } catch (e) { return sendApiError(res, e); }
  }

  if (parsed.pathname === '/health') {
    const database = DATABASE_ENABLED ? await healthCheck() : false;
    return sendJson(res, database ? 200 : 503, {
      ok: database,
      service: 'shisho-bingo',
      database: database ? 'connected' : 'unavailable',
      clients: roomManager.clients.size,
      status: roomManager.room.status,
    });
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(await renderMiniAppHtml(parsed));
}

const server = http.createServer(handleHttpRequest);

function startLocalServer() {
  server.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log('=================================================');
    console.log('🎯 SHISHO BINGO ONLINE — v38');
    console.log('📡 Port:', CONFIG.PORT);
    console.log('🌐 Base URL:', CONFIG.BASE_URL);
    console.log('🎮 Mini App:', `${CONFIG.BASE_URL}/`);
    console.log('=================================================');
    if (configuredBotToken()) bot.init();
    else console.warn('⚠️ BOT_TOKEN not configured.');
  });
}

if (require.main === module) {
  startLocalServer();
}

module.exports = handleHttpRequest;