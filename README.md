# Shisho Bingo

Shisho Bingo is a Telegram bot and Mini App backed by PostgreSQL. Supabase PostgreSQL is the supported database.

## Requirements

- Node.js 24
- A Supabase project

## Configure the database

In Supabase, open **Connect** and copy a PostgreSQL URI. For Vercel, choose the shared **Transaction pooler** URI (port `6543`); it is designed for serverless connections. For local use on an IPv4-only network, choose the **Session pooler** URI (port `5432`). Keep the password private.

Set `DATABASE_URL` to the PostgreSQL URL. The app requires TLS and validates the server certificate. For local development, put it in the ignored `.env` file alongside the bot settings:

```text
DATABASE_URL=postgresql://...
BOT_TOKEN=...
BASE_URL=http://localhost:3000
SUPER_ADMIN_ID=...
CHANNEL_URL=...
SUPPORT_USERNAME=...
TELEBIRR_NUMBER=...
CBE_ACCOUNT=...
```

If the database connection reports a certificate-chain error, download the CA certificate from **Supabase Dashboard → Project Settings → Database → SSL Configuration**. Set `DATABASE_CA_CERT_PATH` to the local certificate file path; in Vercel, set `DATABASE_CA_CERT` to the PEM contents. Certificate validation stays enabled.

Do not commit `.env`, database credentials, bot tokens, or `shisho_bingo_data.json`. Remove any stale `TIDB_DATABASE_URL` setting; the runtime is PostgreSQL-only.

## Create the Supabase schema

In the Supabase Dashboard, open **SQL Editor → New query**. Execute each migration file in order, from `migrations/001_create_users.sql` through `migrations/011_create_game_history.sql`. Each file includes its table and indexes. They use PostgreSQL UUIDs, JSONB, checks, and foreign keys.

Verify that the tables were created in the `public` schema:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'users', 'wallets', 'transactions', 'deposits', 'withdrawals',
    'rooms', 'room_players', 'room_cartelas', 'room_called_numbers',
    'winners', 'game_history'
  )
ORDER BY table_name;
```

The app uses its own `public.users` table for Telegram identities; this is separate from Supabase Auth's `auth.users`.

## Preserve data from an existing PostgreSQL database

If the old app database contains users or wallet/game records, keep it available and pause writes while copying. First apply all schema migrations to a **new, empty Supabase project/database**. Set `SOURCE_DATABASE_URL` in local `.env` to the old PostgreSQL connection URL; `DATABASE_URL` must point to Supabase. Then run:

```powershell
npm install
npm run migrate:postgres-to-supabase
```

The importer requires all target tables to exist and be empty. It copies application rows in foreign-key order, checks row counts, and does not modify the source. Review the reported counts and compare wallet totals before switching traffic. Do not run the importer against a target with live data.

## Run and test locally

```powershell
npm install
npm test
npm start
```

Database integration tests are opt-in to avoid accidentally modifying a live database. Use a disposable Supabase project for those tests and explicitly set `RUN_DB_INTEGRATION_TESTS=1` before running `npm test`. Without that flag, the non-destructive unit tests run and DB integration tests are skipped.

## Deploy to Vercel

1. Import the GitHub repository into Vercel.
2. In **Project Settings → Environment Variables**, set `DATABASE_URL` to the Supabase PostgreSQL connection URL and configure `BOT_TOKEN`, `BASE_URL`, and the app's other needed settings.
3. Do not configure `SOURCE_DATABASE_URL` in Vercel; it is only for the one-time local import. Remove stale `TIDB_DATABASE_URL` variables.
4. Deploy a Preview first, verify `/health`, Telegram bot setup, Mini App authentication, and a controlled wallet/cartela flow, then promote to Production.

The Supabase database password and Telegram bot token must remain secret. If either has been exposed, rotate it before deploying.

## Wallet behavior and operational considerations

`wallets.balance` is the authoritative total used by the bot and Mini App. Available funds are calculated as `balance - reserved_balance`; legacy `users` balance columns do not overwrite an existing wallet. Mini App requests include Telegram `initData`, which the server verifies. Cartela reservations and refunds are persisted with wallet/transaction updates in one database transaction.

The game logic includes in-memory room timers and bot polling. Vercel serverless functions are not long-lived workers, so a successful HTTP deployment does not guarantee reliable game progression or polling. Verify the configured Telegram webhook and room lifecycle before relying on the deployment for live games or payments; a persistent worker may be needed for those processes.
