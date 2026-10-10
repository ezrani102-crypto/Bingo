const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadDotEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = value;
  }
}

loadDotEnv();

const mysql = require('mysql2/promise');
const connectionString = process.env.TIDB_DATABASE_URL || process.env.DATABASE_URL || '';
let pool = null;
let configurationError = null;

if (!connectionString) {
  console.warn('[db] TIDB_DATABASE_URL or DATABASE_URL is not set.');
} else {
  try {
    const parsed = new URL(connectionString);
    if (parsed.protocol !== 'mysql:') {
      throw new Error('TiDB requires a MySQL-protocol connection string (mysql://).');
    }
    const ca = process.env.DATABASE_CA_CERT
      ? process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n')
      : undefined;
    pool = mysql.createPool({
      host: parsed.hostname,
      port: Number(parsed.port || 4000),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL_MAX || 2),
      queueLimit: 0,
      connectTimeout: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      dateStrings: false,
    });
  } catch (error) {
    configurationError = error;
    console.error('[db] invalid TiDB configuration:', error.message);
  }
}

function placeholdersToMysql(sql, params = [], prefixParams = []) {
  const orderedParams = prefixParams.slice();
  const statement = sql.replace(/\$(\d+)/g, (_match, index) => {
    const paramIndex = Number(index) - 1;
    if (paramIndex < 0 || paramIndex >= params.length) {
      throw new Error(`SQL parameter $${index} is out of range.`);
    }
    orderedParams.push(params[paramIndex]);
    return '?';
  });
  return { statement, params: orderedParams };
}

function mysqlSql(sql) {
  return sql
    .replace(/(\$\d+)::timestamptz\b/gi, 'CAST($1 AS DATETIME(3))')
    .replace(/::(?:jsonb|json|int|integer|timestamptz|timestamp)\b/gi, '')
    .replace(/INTERVAL\s+'(\d+)\s+milliseconds'/gi, (_match, milliseconds) => `INTERVAL ${Number(milliseconds) * 1000} MICROSECOND`)
    .replace(/INTERVAL\s+'(\d+)\s+seconds'/gi, 'INTERVAL $1 SECOND')
    .replace(/INTERVAL\s+'(\d+)\s+minutes'/gi, 'INTERVAL $1 MINUTE')
    .replace(/INTERVAL\s+'(\d+)\s+hours'/gi, 'INTERVAL $1 HOUR')
    .replace(/INTERVAL\s+'(\d+)\s+days'/gi, 'INTERVAL $1 DAY')
    .replace(/\)::int\b/gi, ')');
}

function splitReturning(sql) {
  const match = sql.match(/\s+RETURNING\s+(\*|[a-zA-Z_][\w]*(?:\s*,\s*[a-zA-Z_][\w]*)*)\s*;?\s*$/i);
  if (!match) return { statement: sql, columns: null };
  return {
    statement: sql.slice(0, match.index),
    columns: match[1].trim(),
  };
}

function injectInsertId(sql) {
  const match = sql.match(/^\s*INSERT\s+INTO\s+([`"]?[\w]+[`"]?)\s*\(([^)]*)\)\s*VALUES\s*\(/i);
  if (!match || match[2].split(',').some(column => column.trim().replace(/[`"]/g, '').toLowerCase() === 'id')) {
    return { sql, ids: [] };
  }

  const columnsStart = match.index + match[0].indexOf('(');
  const columnsEnd = sql.indexOf(')', columnsStart);
  const valuesMatch = /\bVALUES\s*\(/i.exec(sql.slice(columnsEnd + 1));
  if (!valuesMatch) return { sql, ids: [] };

  const firstTupleStart = columnsEnd + 1 + valuesMatch.index + valuesMatch[0].lastIndexOf('(');
  const insertions = [{ index: columnsStart + 1, text: 'id, ' }];
  const ids = [];
  let tupleStart = firstTupleStart;

  while (sql[tupleStart] === '(') {
    let depth = 0;
    let quote = null;
    let tupleEnd = -1;
    for (let index = tupleStart; index < sql.length; index += 1) {
      const character = sql[index];
      if (quote) {
        if (character === quote && sql[index + 1] === quote) {
          index += 1;
        } else if (character === quote && sql[index - 1] !== '\\') {
          quote = null;
        }
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        quote = character;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          tupleEnd = index;
          break;
        }
      }
    }
    if (tupleEnd === -1) throw new Error('Unable to parse INSERT values while generating row IDs.');

    const id = crypto.randomUUID();
    ids.push(id);
    insertions.push({ index: tupleStart + 1, text: `'${id}', ` });
    let next = tupleEnd + 1;
    while (/\s/.test(sql[next] || '')) next += 1;
    if (sql[next] !== ',') break;
    next += 1;
    while (/\s/.test(sql[next] || '')) next += 1;
    if (sql[next] !== '(') break;
    tupleStart = next;
  }

  let updated = sql;
  for (const insertion of insertions.reverse()) {
    updated = `${updated.slice(0, insertion.index)}${insertion.text}${updated.slice(insertion.index)}`;
  }
  return { sql: updated, ids };
}

function prepareStatement(text, params = []) {
  const { columns, statement: statementWithoutReturning } = splitReturning(String(text));
  const sql = mysqlSql(statementWithoutReturning);
  const insert = /^\s*INSERT\s+INTO\s+([`"]?[\w]+[`"]?)/i.exec(sql);
  const withId = insert ? injectInsertId(sql) : { sql, ids: [] };
  const prepared = placeholdersToMysql(withId.sql, params);
  return {
    ...prepared,
    returning: columns,
    insertId: withId.ids[0] || null,
    insertIds: withId.ids,
    insertTable: insert ? insert[1].replace(/[`"]/g, '') : null,
  };
}

async function execute(client, text, params = []) {
  const prepared = prepareStatement(text, params);
  const { returning: columns, statement: sql, insertTable, insertIds } = prepared;
  const insert = /^\s*INSERT\s+INTO\s+([`"]?[\w]+[`"]?)/i.exec(sql);
  const sqlWithPlaceholders = String(text);
  const { statement: originalWithoutReturning } = splitReturning(sqlWithPlaceholders);
  const originalSql = mysqlSql(originalWithoutReturning);
  const update = /^\s*UPDATE\s+([`"]?[\w]+[`"]?)[\s\S]*?\sWHERE\s([\s\S]+)$/i.exec(originalSql);
  const deletion = /^\s*DELETE\s+FROM\s+([`"]?[\w]+[`"]?)\s+WHERE\s([\s\S]+)$/i.exec(originalSql);
  let rowsBeforeDelete = [];
  let updateIds = [];
  let targetTable = null;

  if (columns && deletion) {
    targetTable = deletion[1].replace(/[`"]/g, '');
    const whereClause = deletion[2];
    const selectionQuery = placeholdersToMysql(
      `SELECT ${columns} FROM ${targetTable} WHERE ${whereClause}`,
      params
    );
    const selection = await client.query(selectionQuery.statement, selectionQuery.params);
    rowsBeforeDelete = selection[0];
  } else if (columns && update) {
    targetTable = update[1].replace(/[`"]/g, '');
    const whereClause = update[2].replace(/\s+RETURNING\s+[\s\S]*$/i, '');
    const selectionQuery = placeholdersToMysql(
      `SELECT id FROM ${targetTable} WHERE ${whereClause}`,
      params
    );
    const selection = await client.query(selectionQuery.statement, selectionQuery.params);
    updateIds = selection[0].map(row => row.id);
  }

  const [result] = await client.query(sql, prepared.params);

  if (columns && insert && insertIds.length) {
    const placeholders = insertIds.map(() => '?').join(', ');
    const selected = await client.query(
      `SELECT ${columns} FROM ${insertTable} WHERE id IN (${placeholders})`,
      insertIds
    );
    return { rows: selected[0], rowCount: selected[0].length, command: 'INSERT' };
  }

  if (columns && update && updateIds.length) {
    const placeholders = updateIds.map(() => '?').join(', ');
    const selected = await client.query(
      `SELECT ${columns} FROM ${targetTable} WHERE id IN (${placeholders})`,
      updateIds
    );
    return { rows: selected[0], rowCount: selected[0].length, command: 'UPDATE' };
  }

  if (columns && deletion) return { rows: rowsBeforeDelete, rowCount: rowsBeforeDelete.length, command: 'DELETE' };
  if (Array.isArray(result)) return { rows: result, rowCount: result.length, command: 'SELECT' };
  return { rows: [], rowCount: Number(result.affectedRows || 0), command: result.warningStatus === undefined ? 'UPDATE' : 'INSERT' };
}

function assertConfigured() {
  if (pool) return;
  if (configurationError) throw configurationError;
  const error = new Error('TiDB is not configured. Set TIDB_DATABASE_URL or DATABASE_URL to a mysql:// connection string.');
  error.code = 'DATABASE_UNAVAILABLE';
  throw error;
}

function connection() {
  assertConfigured();
  return pool.getConnection();
}

async function query(text, params = []) {
  const client = await connection();
  try {
    return await execute(client, text, params);
  } catch (error) {
    console.error('[db] query error:', JSON.stringify({ code: error.code || null, message: error.message }));
    throw error;
  } finally {
    client.release();
  }
}

async function transactional(work) {
  const client = await connection();
  const wrappedClient = {
    query: (text, params = []) => execute(client, text, params),
  };
  try {
    await client.beginTransaction();
    const result = await work(wrappedClient);
    await client.commit();
    return result;
  } catch (error) {
    await client.rollback();
    throw error;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  try {
    assertConfigured();
    await pool.query('SELECT 1');
    console.log('[db:health] connected');
    return true;
  } catch (error) {
    console.error('[db:health] FAILED', JSON.stringify({ code: error.code || null, message: error.message }));
    return false;
  }
}

module.exports = {
  pool,
  query,
  execute,
  transactional,
  healthCheck,
  placeholdersToMysql,
  mysqlSql,
  prepareStatement,
  databaseConfigured: !!pool,
};
