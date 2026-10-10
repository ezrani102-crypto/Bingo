'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Pool } = require('pg');
const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
let pool = null;
let configurationError = null;

function getDatabaseCa() {
  if (process.env.DATABASE_CA_CERT_PATH) {
    return fs.readFileSync(path.resolve(process.env.DATABASE_CA_CERT_PATH), 'utf8');
  }
  if (process.env.DATABASE_CA_CERT) {
    return process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n');
  }
  return undefined;
}

if (!connectionString) {
  console.warn('[db] DATABASE_URL or SUPABASE_DATABASE_URL is not set.');
} else {
  try {
    const parsed = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error('Supabase requires a PostgreSQL connection string.');
    }

    const ca = getDatabaseCa();
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
      max: Number(process.env.DB_POOL_MAX || 1),
      connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
      idleTimeoutMillis: 10000,
    });
    pool.on('error', (error) => {
      console.error('[db] idle PostgreSQL client error:', JSON.stringify({
        code: error.code || null,
        message: error.message,
      }));
    });
  } catch (error) {
    configurationError = error;
    console.error('[db] invalid PostgreSQL configuration:', error.message);
  }
}

function assertConfigured() {
  if (pool) return;
  if (configurationError) throw configurationError;
  const error = new Error('Database is not configured. Set DATABASE_URL to a PostgreSQL connection string.');
  error.code = 'DATABASE_UNAVAILABLE';
  throw error;
}

async function query(text, params = []) {
  assertConfigured();
  try {
    return await pool.query(text, params);
  } catch (error) {
    console.error('[db] query error:', JSON.stringify({
      code: error.code || null,
      message: error.message,
    }));
    throw error;
  }
}

async function transactional(work) {
  assertConfigured();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[db] rollback failed:', JSON.stringify({
        code: rollbackError.code || null,
        message: rollbackError.message,
      }));
    }
    throw error;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  try {
    await query('SELECT 1');
    console.log('[db:health] connected');
    return true;
  } catch (error) {
    console.error('[db:health] FAILED', JSON.stringify({
      code: error.code || null,
      message: error.message,
    }));
    return false;
  }
}

module.exports = {
  pool,
  query,
  transactional,
  healthCheck,
  databaseConfigured: !!pool,
};
