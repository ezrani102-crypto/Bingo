'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const mysql = require('mysql2/promise');

const TABLES = [
  'users',
  'wallets',
  'transactions',
  'deposits',
  'withdrawals',
  'rooms',
  'room_players',
  'room_cartelas',
  'room_called_numbers',
  'winners',
  'game_history',
];

function readDatabaseUrls() {
  const configuredUrl = process.env.DATABASE_URL || '';
  const isPostgresUrl = /^postgres(?:ql)?:\/\//i.test(configuredUrl);
  const isMysqlUrl = /^mysql:\/\//i.test(configuredUrl);
  const sourceUrl = process.env.SOURCE_DATABASE_URL || (isPostgresUrl ? configuredUrl : '');
  const tidbUrl = process.env.TIDB_DATABASE_URL || (isMysqlUrl ? configuredUrl : '');

  if (!sourceUrl || !/^postgres(?:ql)?:\/\//i.test(sourceUrl)) {
    throw new Error('Set SOURCE_DATABASE_URL to the existing PostgreSQL database URL.');
  }
  if (!tidbUrl || !/^mysql:\/\//i.test(tidbUrl)) {
    throw new Error('Set TIDB_DATABASE_URL to the TiDB Cloud mysql:// connection URL.');
  }
  return { sourceUrl, tidbUrl };
}

function mysqlConfig(connectionString) {
  const parsed = new URL(connectionString);
  const ca = process.env.DATABASE_CA_CERT
    ? process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n')
    : undefined;
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 4000),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectTimeout: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
  };
}

async function migrate() {
  const { sourceUrl, tidbUrl } = readDatabaseUrls();
  const source = new Pool({
    connectionString: sourceUrl,
    ssl: process.env.SOURCE_DATABASE_CA_CERT
      ? { ca: process.env.SOURCE_DATABASE_CA_CERT.replace(/\\n/g, '\n') }
      : undefined,
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
    max: 1,
  });
  let target;

  try {
    target = await mysql.createConnection(mysqlConfig(tidbUrl));
    const targetTables = await target.query(
      `SELECT TABLE_NAME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN (${TABLES.map(() => '?').join(', ')})`,
      TABLES
    );
    const existingTables = new Set(targetTables[0].map(row => row.TABLE_NAME));
    const missingTables = TABLES.filter(table => !existingTables.has(table));
    if (missingTables.length) {
      throw new Error(`Apply all TiDB migrations first; missing tables: ${missingTables.join(', ')}.`);
    }

    const targetCounts = await Promise.all(TABLES.map(async table => {
      const [rows] = await target.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
      return { table, count: Number(rows[0].count) };
    }));
    const populated = targetCounts.filter(item => item.count > 0);
    if (populated.length) {
      throw new Error(`Migration target must be empty. Non-empty tables: ${populated.map(item => item.table).join(', ')}.`);
    }

    const sources = new Map();
    for (const table of TABLES) {
      const result = await source.query(`SELECT * FROM "${table}"`);
      sources.set(table, result.rows);
    }

    await target.beginTransaction();
    for (const table of TABLES) {
      const rows = sources.get(table);
      if (!rows.length) continue;

      const columns = Object.keys(rows[0]);
      const [jsonColumns] = await target.query(
        `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND DATA_TYPE = 'json'`,
        [table]
      );
      const jsonColumnNames = new Set(jsonColumns.map(row => row.COLUMN_NAME));
      const columnSql = columns.map(column => `\`${column}\``).join(', ');
      const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
      const chunkSize = Math.max(1, Math.floor(60000 / columns.length));

      for (let offset = 0; offset < rows.length; offset += chunkSize) {
        const chunk = rows.slice(offset, offset + chunkSize);
        const values = chunk.flatMap(row => columns.map(column => {
          const value = row[column];
          return value !== null && jsonColumnNames.has(column) && typeof value !== 'string'
            ? JSON.stringify(value)
            : value;
        }));
        const placeholders = chunk.map(() => rowPlaceholder).join(', ');
        await target.query(
          `INSERT INTO \`${table}\` (${columnSql}) VALUES ${placeholders}`,
          values
        );
      }

      const [countRows] = await target.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
      const actualCount = Number(countRows[0].count);
      if (actualCount !== rows.length) {
        throw new Error(`Row count mismatch for ${table}: expected ${rows.length}, found ${actualCount}.`);
      }
      console.log(`[migration] ${table}: ${actualCount} rows copied`);
    }
    await target.commit();
    console.log('[migration] completed; source PostgreSQL data was not modified');
  } catch (error) {
    if (target) await target.rollback();
    throw error;
  } finally {
    await source.end();
    if (target) await target.end();
  }
}

migrate().catch(error => {
  console.error('[migration] failed:', error.message);
  process.exitCode = 1;
});
