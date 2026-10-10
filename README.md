# Shisho Bingo

Shisho Bingo is a Telegram bot and Mini App backed by TiDB Cloud. The application uses the MySQL protocol; PostgreSQL connection strings are not valid for the runtime database.

## Requirements

- Node.js 24
- A TiDB Cloud cluster with a database created
- A MySQL-protocol connection URL from TiDB Cloud

## Configure the database

Set `TIDB_DATABASE_URL` to the TiDB Cloud connection URL (`mysql://...`). TiDB Cloud uses TLS; the application validates certificates by default. If the cluster requires a custom CA certificate, set `DATABASE_CA_CERT` to its PEM content (newlines may be represented as `\n`).

For local PowerShell development, create a private `.env` file:

```powershell
$env:TIDB_DATABASE_URL = "mysql://USER:PASSWORD@HOST:4000/DATABASE"
$env:BOT_TOKEN = "..."
$env:BASE_URL = "https://your-deployment.example"
$env:CHANNEL_URL = "..."
$env:SUPPORT_USERNAME = "..."
$env:TELEBIRR_NUMBER = "..."
$env:CBE_ACCOUNT = "..."
```

Do not commit `.env`, database credentials, bot tokens, or the local `shisho_bingo_data.json` file.

## Create the TiDB schema

In the TiDB Cloud SQL Editor, select the target database and execute the migration files in numeric order:

1. `migrations/001_create_users.sql`
2. `migrations/002_create_wallets.sql`
3. `migrations/003_create_transactions.sql`
4. `migrations/004_create_deposits.sql`
5. `migrations/005_create_withdrawals.sql`
6. `migrations/006_create_rooms.sql`
7. `migrations/007_create_room_players.sql`
8. `migrations/008_create_room_cartelas.sql`
9. `migrations/009_create_room_called_numbers.sql`
10. `migrations/010_create_winners.sql`
11. `migrations/011_create_game_history.sql`

These schema files create empty tables; they do not import records from PostgreSQL or the local JSON snapshot.

## Preserve existing PostgreSQL data

If migrating an existing deployment, first create the TiDB schema above, then use the one-time importer. The importer copies the application tables and refuses to run unless all corresponding TiDB tables are empty. It never modifies the PostgreSQL source.

Configure `SOURCE_DATABASE_URL` with the old PostgreSQL URL and `TIDB_DATABASE_URL` with the TiDB URL in a private local environment. Optionally configure `SOURCE_DATABASE_CA_CERT` for a PostgreSQL server using a private CA. Then run:

```powershell
npm install
npm run migrate:postgres-to-tidb
```

The importer checks row counts per table and aborts on a mismatch. Review its counts before pointing the bot or Mini App at TiDB. Keep the source database available until the new deployment has been validated.

## Run and test locally

```powershell
npm install
npm test
npm start
```

Database integration tests run only when a valid TiDB URL is configured. Without it, database-backed tests are skipped; adapter tests still run. Never point tests at a production database.

## Deploy to Vercel

1. Push the project to the intended GitHub repository and import that repository in Vercel.
2. In Vercel Project Settings → Environment Variables, configure `TIDB_DATABASE_URL`, `BOT_TOKEN`, and `BASE_URL` for the target environment. Add the optional support/payment variables as required by the app.
3. Deploy only after the TiDB schema is applied and any existing data has been imported and checked.

`BASE_URL` must be the public HTTPS URL for the deployment. If the Vercel project does not already have the correct bot webhook and deployment settings, configure those before switching traffic. Do not paste credentials into chat or commit them to Git.

## Data and wallet behavior

`wallets.balance` is the authoritative total used by the bot and Mini App. Available funds are calculated as `balance - reserved_balance`; legacy `users` balance columns do not overwrite an existing wallet. Mini App requests include Telegram `initData`, which the server verifies. Cartela reservations and refunds are persisted with wallet/transaction updates in one database transaction.

## Deployment considerations

The game logic includes in-memory room timers and bot polling. Those long-lived processes may not behave reliably in Vercel serverless functions; verify the bot webhook, room lifecycle, and scheduled work for the chosen Vercel deployment model before relying on it for live games.
