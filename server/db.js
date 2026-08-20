const Database = require("better-sqlite3");
const path = require("path");

if (process.env.NODE_ENV === "production" && !process.env.DB_PATH) {
  console.error(
    "[db] WARNING: NODE_ENV=production but DB_PATH is not set — SQLite is on ephemeral disk " +
    "and ALL DATA (users, earnings, withdrawals) WILL BE LOST on redeploy. Point DB_PATH at a persistent volume."
  );
}

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
    company          TEXT,
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
try { db.exec("ALTER TABLE sponsors ADD COLUMN budget_paise_total INTEGER"); } catch (_) {}

// Advertiser logo + slot/stack targeting (see GET /v1/sponsor-line).
// Existing rows keep slot_type NULL — the selector treats NULL as 'all'.
try { db.exec("ALTER TABLE sponsors ADD COLUMN logo_url TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sponsors ADD COLUMN slot_type TEXT DEFAULT 'all'"); } catch (_) {}
try { db.exec("ALTER TABLE sponsors ADD COLUMN target_stack TEXT"); } catch (_) {}

// Background-questions survey (see POST /v1/me/profile)
try { db.exec("ALTER TABLE users ADD COLUMN experience_level TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN primary_stack TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN country TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN profile_done_at INTEGER"); } catch (_) {}
// Mandatory company/university name — required at signup, backfilled via the
// extension onboarding survey for users who registered before this existed.
try { db.exec("ALTER TABLE users ADD COLUMN company TEXT"); } catch (_) {}

// Store payout_paise per impression so earnings survive sponsor deletion
try { db.exec("ALTER TABLE impressions ADD COLUMN payout_paise INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
// Backfill existing impressions that still have a live sponsor row
db.exec(`UPDATE impressions SET payout_paise = (
  SELECT COALESCE(s.payout_paise, 0) FROM sponsors s WHERE s.id = impressions.sponsor_id
) WHERE payout_paise = 0 AND sponsor_id IN (SELECT id FROM sponsors)`);

// Record the bid per impression (budgets are bid-denominated) + single-use token id (jti)
try { db.exec("ALTER TABLE impressions ADD COLUMN bid_paise INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE impressions ADD COLUMN jti TEXT"); } catch (_) {}
db.exec(`UPDATE impressions SET bid_paise = (
  SELECT COALESCE(s.bid_paise, 0) FROM sponsors s WHERE s.id = impressions.sponsor_id
) WHERE bid_paise = 0 AND sponsor_id IN (SELECT id FROM sponsors)`);

// 24h withdrawal lock after a UPI change (see POST /v1/withdraw)
try { db.exec("ALTER TABLE users ADD COLUMN upi_updated_at INTEGER"); } catch (_) {}

// Signup metadata + canonical email for dedupe (backfilled at startup in backend.js)
try { db.exec("ALTER TABLE beta_invites ADD COLUMN email_canonical TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE beta_invites ADD COLUMN role TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE beta_invites ADD COLUMN github TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE beta_invites ADD COLUMN source TEXT"); } catch (_) {}

// GitHub sign-in as an alternative to invite-code login (POST /v1/auth/github)
try { db.exec("ALTER TABLE users ADD COLUMN github_id TEXT"); } catch (_) {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id) WHERE github_id IS NOT NULL"); } catch (_) {}

// Single-use impression tokens + at most one pending withdrawal per user.
// try/catch: a legacy DB with duplicate rows would fail creation — warn, don't crash.
for (const sql of [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_impressions_jti ON impressions(jti) WHERE jti IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_pending ON withdrawals(user_id) WHERE status = 'pending'",
]) {
  try { db.exec(sql); } catch (e) { console.error("[db] index creation failed:", e.message); }
}

// Indexes for high-traffic queries (earnings, budget checks, token lookup)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_impressions_user    ON impressions(user_id);
  CREATE INDEX IF NOT EXISTS idx_impressions_ts      ON impressions(ts);
  CREATE INDEX IF NOT EXISTS idx_impressions_sponsor ON impressions(sponsor_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_clicks_user          ON clicks(user_id);
`);

// Advertiser inquiries submitted via the landing page
db.exec(`
  CREATE TABLE IF NOT EXISTS advertiser_inquiries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    company         TEXT NOT NULL,
    contact_name    TEXT NOT NULL,
    email           TEXT NOT NULL,
    website         TEXT,
    ad_text         TEXT NOT NULL,
    destination_url TEXT NOT NULL,
    budget_range    TEXT NOT NULL,
    slot_type       TEXT NOT NULL,
    product_type    TEXT,
    notes           TEXT,
    status          TEXT NOT NULL DEFAULT 'new',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Extension/dashboard changelog — posted from the admin panel (POST/PUT/DELETE /api/updates).
// notes is a JSON-encoded string array (SQLite has no array type).
db.exec(`
  CREATE TABLE IF NOT EXISTS changelog_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    version    TEXT NOT NULL,
    date       TEXT NOT NULL,
    title      TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '[]',
    critical   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

module.exports = db;
