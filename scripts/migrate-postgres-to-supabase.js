'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

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

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function getCa(certificatePathVariable, certificateVariable) {
  const certificatePath = process.env[certificatePathVariable];
  if (certificatePath) return fs.readFileSync(path.resolve(certificatePath), 'utf8');
  const certificate = process.env[certificateVariable];
  return certificate ? certificate.replace(/\\n/g, '\n') : undefined;
}

async function tableExists(client, table) {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return result.rowCount > 0;
}

async function migrate() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL;
  if (!sourceUrl) throw new Error('Set SOURCE_DATABASE_URL to the existing PostgreSQL database URL.');
  if (!targetUrl) throw new Error('Set DATABASE_URL to the Supabase PostgreSQL connection URL.');
  if (sourceUrl === targetUrl) throw new Error('Source and target database URLs must be different.');

  const sourceCa = getCa('SOURCE_DATABASE_CA_CERT_PATH', 'SOURCE_DATABASE_CA_CERT');
  const targetCa = getCa('DATABASE_CA_CERT_PATH', 'DATABASE_CA_CERT');
  const source = new Pool({
    connectionString: sourceUrl,
    ssl: {
      rejectUnauthorized: true,
      ...(sourceCa ? { ca: sourceCa } : {}),
    },
    max: 1,
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  });
  const target = new Pool({
    connectionString: targetUrl,
    ssl: {
      rejectUnauthorized: true,
      ...(targetCa ? { ca: targetCa } : {}),
    },
    max: 1,
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  });
  let targetClient;

  try {
    const sourceClient = await source.connect();
    try {
      for (const table of TABLES) {
        if (!(await tableExists(sourceClient, table))) {
          throw new Error(`Source PostgreSQL database is missing table ${table}.`);
        }
      }
    } finally {
      sourceClient.release();
    }

    targetClient = await target.connect();
    for (const table of TABLES) {
      if (!(await tableExists(targetClient, table))) {
        throw new Error(`Apply all Supabase migrations first; missing table ${table}.`);
      }
      const count = await targetClient.query(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)}`);
      if (Number(count.rows[0].count) > 0) {
        throw new Error(`Migration target must be empty. Table ${table} already contains rows.`);
      }
    }

    const sourceRows = new Map();
    for (const table of TABLES) {
      const result = await source.query(`SELECT * FROM ${quoteIdentifier(table)}`);
      sourceRows.set(table, result.rows);
    }

    await targetClient.query('BEGIN');
    for (const table of TABLES) {
      const rows = sourceRows.get(table);
      if (!rows.length) {
        console.log(`[migration] ${table}: 0 rows copied`);
        continue;
      }

      const columns = Object.keys(rows[0]);
      const columnSql = columns.map(quoteIdentifier).join(', ');
      const chunkSize = Math.max(1, Math.floor(60000 / columns.length));

      for (let offset = 0; offset < rows.length; offset += chunkSize) {
        const chunk = rows.slice(offset, offset + chunkSize);
        const values = [];
        const tuples = chunk.map(row => {
          const placeholders = columns.map(column => {
            values.push(row[column]);
            return `$${values.length}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        await targetClient.query(
          `INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES ${tuples.join(', ')}`,
          values
        );
      }

      const targetCount = await targetClient.query(
        `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)}`
      );
      const actualCount = Number(targetCount.rows[0].count);
      if (actualCount !== rows.length) {
        throw new Error(`Row count mismatch for ${table}: expected ${rows.length}, found ${actualCount}.`);
      }
      console.log(`[migration] ${table}: ${actualCount} rows copied`);
    }
    await targetClient.query('COMMIT');
    console.log('[migration] completed; source PostgreSQL data was not modified');
  } catch (error) {
    if (targetClient) {
      try {
        await targetClient.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[migration] rollback failed:', rollbackError.message);
      }
    }
    throw error;
  } finally {
    if (targetClient) targetClient.release();
    await Promise.all([source.end(), target.end()]);
  }
}

migrate().catch(error => {
  console.error('[migration] failed:', error.message);
  process.exitCode = 1;
});
