const { timingSafeEqual, createHash } = require("crypto");
const rateLimit = require("express-rate-limit");

// Lazily load db to avoid circular require at module load time
let _db;
function getDb() {
  if (!_db) _db = require("./db");
  return _db;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

// Session tokens are opaque, permanent (no expiry/rotation) and DB-backed — see
// the `sessions` table in db.js. Valid iff a non-revoked row exists whose hash
// matches and whose user is still active.
function requireAuth(req, res, next) {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token" });
  }
  const token = header.slice(7);
  const row = getDb().prepare(
    `SELECT s.id AS session_id, s.user_id, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL`
  ).get(hashToken(token));
  if (!row) return res.status(401).json({ error: "invalid_token" });
  if (row.status !== "active") return res.status(403).json({ error: "account_revoked" });
  req.userId = row.user_id;
  req.sessionId = row.session_id;
  next();
}

// Fails closed: no ADMIN_KEY → no admin API, in every environment.
function adminAuth(req, res, next) {
  if (!process.env.ADMIN_KEY) {
    return res.status(503).json({ error: "admin_not_configured" });
  }
  const given = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const expected = Buffer.from(process.env.ADMIN_KEY);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Rupee ceiling per user per day. The row cap alone bounds *count*, not *money*:
// /v1/sponsor-line is unlimited and returns payoutPaise in cleartext, so a scripted
// caller can re-roll the bid-weighted auction until the top-paying sponsor comes up,
// discard the rest, and redeem only the best token. That makes extraction
// 500 x max(payout) rather than 500 x average — i.e. onboarding a higher-bidding
// advertiser would directly raise what a farmed account earns. Capping paise makes
// the ceiling independent of what advertisers bid.
// 12500p = the old effective max (500 x 25p), so honest users see no change today.
const DAILY_EARNINGS_PAISE_CAP = Number(process.env.DAILY_EARNINGS_PAISE_CAP || 12500);

// DB-backed per-user impression limits — survives restarts, unlike an in-memory map.
// Floor of 25s between impressions (client rotates every 30s; scripted spam gets 429),
// 500/day row cap, and the rupee cap above. Both caps run off one query.
function rateLimitImpressions(req, res, next) {
  const row = getDb().prepare(
    `SELECT MAX(ts) AS last,
            COALESCE(SUM(ts > unixepoch('now', 'start of day')), 0) AS today,
            COALESCE(SUM(CASE WHEN ts > unixepoch('now', 'start of day')
                              THEN payout_paise END), 0) AS today_paise
     FROM impressions WHERE user_id = ?`
  ).get(req.userId);
  const now = Math.floor(Date.now() / 1000);
  if (row.last && now - row.last < 25) return res.status(429).json({ error: "too_fast" });
  if (row.today >= 500) return res.status(429).json({ error: "rate_limit_exceeded" });
  if (row.today_paise >= DAILY_EARNINGS_PAISE_CAP) return res.status(429).json({ error: "daily_earnings_cap" });
  next();
}

// Global IP-level rate limit for all /v1/ routes
const globalRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Tighter limit for credential endpoints (register/login) — slows
// invite-code brute force to uselessness.
const authRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// GitHub OAuth needs its own budget: one sign-in costs two requests (start +
// callback), so authRateLimit's 10/min locks out a shared office NAT after five
// people — and a 429 on the callback is unrecoverable, since GitHub's code is
// already spent. Neither endpoint takes a guessable credential (state is
// server-minted and single-use), so a looser limit costs nothing.
const oauthRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { requireAuth, adminAuth, rateLimitImpressions, globalRateLimit, authRateLimit, oauthRateLimit };
