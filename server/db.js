const Database = require("better-sqlite3");
const path = require("path");

if (process.env.NODE_ENV === "production" && !process.env.DB_PATH) {
  console.error(
    "[db] WARNING: NODE_ENV=production but DB_PATH is not set — SQLite is on ephemeral disk " +
    "and ALL DATA (users, earnings, withdrawals) WILL BE LOST on redeploy. Point DB_PATH at a persistent volume."
  );
}

const db = new Database(process.env.DB_PATH || path.join(__dirname, "kickback.db"));

// better-sqlite3 is synchronous, so every commit blocks the event loop. The
// defaults (journal_mode=delete, synchronous=FULL) measured ~2.8ms per write on
// local SSD and are far worse on a network-backed volume; WAL + NORMAL measured
// ~0.02ms. NORMAL under WAL cannot corrupt the DB — the worst case is losing the
// last few commits on a hard power loss, which is the right trade for ad impressions.
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

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

  -- Opaque permanent session tokens (replaces JWT access + rotating refresh
  -- tokens). Raw token is never stored — only its SHA-256 hex hash. A session
  -- stays valid until revoked_at is set (logout, account deletion, per-session
  -- revoke). See server/middleware.js requireAuth.
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
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

// Store payout_paise / bid_paise per impression so earnings survive sponsor deletion.
//
// The backfill runs INSIDE the try, so it only executes on the one boot that
// actually adds the column. It used to run unconditionally on every startup,
// which quietly re-priced history: `WHERE payout_paise = 0` cannot tell "column
// did not exist yet" from "this impression really was worth 0 paise" (an idle
// slot rounding to 0, or a sponsor serving at 0), so every redeploy rewrote
// those rows to the sponsor's *current* price. A user's past earnings are a
// settled fact — see the migration-safety block in server/test-api.js, which
// boots db.js a second time against a seeded ledger and fails if a paise moves.
try {
  db.exec("ALTER TABLE impressions ADD COLUMN payout_paise INTEGER NOT NULL DEFAULT 0");
  db.exec(`UPDATE impressions SET payout_paise = (
    SELECT COALESCE(s.payout_paise, 0) FROM sponsors s WHERE s.id = impressions.sponsor_id
  ) WHERE sponsor_id IN (SELECT id FROM sponsors)`);
} catch (_) { /* column already exists — history is already priced, leave it alone */ }

// Record the bid per impression (budgets are bid-denominated) + single-use token id (jti)
try {
  db.exec("ALTER TABLE impressions ADD COLUMN bid_paise INTEGER NOT NULL DEFAULT 0");
  db.exec(`UPDATE impressions SET bid_paise = (
    SELECT COALESCE(s.bid_paise, 0) FROM sponsors s WHERE s.id = impressions.sponsor_id
  ) WHERE sponsor_id IN (SELECT id FROM sponsors)`);
} catch (_) { /* see above */ }
try { db.exec("ALTER TABLE impressions ADD COLUMN jti TEXT"); } catch (_) {}

// ── Impression lifecycle: reserved -> rendered -> viewable -> settled ────────
// An impression used to be a single INSERT at credit time, with no evidence the
// ad was ever on screen. It is now a row created when the line is *minted*
// (GET /v1/sponsor-line) and promoted as evidence arrives.
//
// The column DEFAULTS are the entire backfill: the instant the column exists,
// every historic row reads as state='settled', billable=1 — already earned,
// already final — so no UPDATE pass touches money. (An UPDATE here is precisely
// the bug the migration-safety test in server/test-api.js exists to catch.)
//
// billable is what earnings/analytics sum on; state is what the lifecycle moves.
// They are separate because a row can be non-void and still unearned (reserved
// holds advertiser budget but pays nobody).
for (const sql of [
  "ALTER TABLE impressions ADD COLUMN state       TEXT    NOT NULL DEFAULT 'settled'",
  "ALTER TABLE impressions ADD COLUMN rendered_at INTEGER",                      // unixepoch seconds, like ts
  "ALTER TABLE impressions ADD COLUMN visible_ms  INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE impressions ADD COLUMN focused_ms  INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE impressions ADD COLUMN settled_at  INTEGER",
  "ALTER TABLE impressions ADD COLUMN billable    INTEGER NOT NULL DEFAULT 1",
]) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}
// The sweeper that expires stale reservations (and the budget checks) scan by
// state within a time window; ts leads because every state is time-bounded.
db.exec("CREATE INDEX IF NOT EXISTS idx_impressions_state_ts ON impressions(state, ts)");

// 24h withdrawal lock after a UPI change (see POST /v1/withdraw)
try { db.exec("ALTER TABLE users ADD COLUMN upi_updated_at INTEGER"); } catch (_) {}

// Signup metadata + canonical email for dedupe (backfilled at startup in backend.js)
try { db.exec("ALTER TABLE beta_invites ADD COLUMN email_canonical TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE beta_invites ADD COLUMN role TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE beta_invites ADD COLUMN github TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE beta_invites ADD COLUMN source TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE beta_invites ADD COLUMN ip TEXT"); } catch (_) {}

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
  CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_clicks_user          ON clicks(user_id);
  -- POST /v1/clicks checks "was this user served this sponsor" and "did they already
  -- click it" on every request; both filter user_id + sponsor_id together.
  CREATE INDEX IF NOT EXISTS idx_clicks_user_sponsor   ON clicks(user_id, sponsor_id, ts);
  CREATE INDEX IF NOT EXISTS idx_impressions_user_spon ON impressions(user_id, sponsor_id, ts);
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

// Funnel counters, keyed `<event>:<YYYY-MM-DD>` — a daily series without a row
// per event. This DB lives on a Railway volume (see the DB_PATH warning above),
// so aggregates only: nothing here is worth the write volume of raw events.
db.exec(`
  CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)
`);

module.exports = db;
