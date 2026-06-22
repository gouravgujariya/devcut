const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(process.env.DB_PATH || path.join(__dirname, "kickback.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS sponsors (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    text                TEXT NOT NULL,
    url                 TEXT NOT NULL,
    payout_paise        INTEGER NOT NULL DEFAULT 25,
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    bid_paise           INTEGER NOT NULL DEFAULT 42,
    budget_paise_daily  INTEGER
  );

  CREATE TABLE IF NOT EXISTS beta_invites (
    code             TEXT PRIMARY KEY,
    email            TEXT NOT NULL,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    used_at          INTEGER,
    used_by_user_id  TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    invite_code  TEXT NOT NULL,
    upi_id       TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    status       TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS teams (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    owner_id    TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (team_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS impressions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    sponsor_id TEXT NOT NULL,
    task_type  TEXT,
    ip         TEXT,
    ts         INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS clicks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    sponsor_id TEXT NOT NULL,
    ts         INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    upi_id      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    ref         TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked_at INTEGER
  );
`);

// Seed with two default sponsors if table is empty
// payout_paise = 25 (60% of ₹41.67 at beta ₹1500 CPM, rounded down for demo)
const count = db.prepare("SELECT COUNT(*) as n FROM sponsors").get();
if (count.n === 0) {
  const insert = db.prepare(
    "INSERT INTO sponsors (id, name, text, url, payout_paise, bid_paise) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insert.run("sponsor-1", "Postman", "Postman — test your APIs in seconds", "https://www.postman.com", 25, 42);
  insert.run("sponsor-2", "Hasura", "Hasura — instant GraphQL APIs on your DB", "https://hasura.io", 25, 42);
}

// ─── Migrations for existing databases ───────────────────────────────────────
// ALTER TABLE is idempotent here because we catch "duplicate column" errors.
const migrations = [
  "ALTER TABLE impressions ADD COLUMN task_type TEXT",
  "ALTER TABLE impressions ADD COLUMN ip TEXT",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

try { db.exec("ALTER TABLE sponsors ADD COLUMN bid_paise INTEGER NOT NULL DEFAULT 42"); } catch (_) {}
try { db.exec("ALTER TABLE sponsors ADD COLUMN budget_paise_daily INTEGER"); } catch (_) {}

module.exports = db;
