const { verifyAccessToken } = require("./auth");
const { timingSafeEqual } = require("crypto");
const rateLimit = require("express-rate-limit");

// Lazily load db to avoid circular require at module load time
let _db;
function getDb() {
  if (!_db) _db = require("./db");
  return _db;
}

function requireAuth(req, res, next) {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token" });
  }
  const token = header.slice(7);
  try {
    const claims = verifyAccessToken(token);
    const user = getDb().prepare("SELECT status FROM users WHERE id = ?").get(claims.sub);
    if (!user) return res.status(401).json({ error: "user_not_found" });
    if (user.status !== "active") return res.status(403).json({ error: "account_revoked" });
    req.userId = claims.sub;
    next();
  } catch (e) {
    const code = e.name === "TokenExpiredError" ? "token_expired" : "invalid_token";
    return res.status(401).json({ error: code });
  }
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

// DB-backed per-user impression limits — survives restarts, unlike an in-memory map.
// Floor of 25s between impressions (client rotates every 30s; scripted spam gets 429)
// and 500/day hard cap.
function rateLimitImpressions(req, res, next) {
  const row = getDb().prepare(
    `SELECT MAX(ts) AS last,
            COALESCE(SUM(ts > unixepoch('now', 'start of day')), 0) AS today
     FROM impressions WHERE user_id = ?`
  ).get(req.userId);
  const now = Math.floor(Date.now() / 1000);
  if (row.last && now - row.last < 25) return res.status(429).json({ error: "too_fast" });
  if (row.today >= 500) return res.status(429).json({ error: "rate_limit_exceeded" });
  next();
}

// Global IP-level rate limit for all /v1/ routes
const globalRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Tighter limit for credential endpoints (register/login/refresh) — slows
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
