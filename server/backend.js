const express = require("express");
const path = require("path");
const { randomUUID, randomInt } = require("crypto");
const { z } = require("zod");
const db = require("./db");
const { signAccessToken, getPublicJwk, signImpressionToken, verifyImpressionToken } = require("./auth");
const { requireAuth, adminAuth, rateLimitImpressions, globalRateLimit, authRateLimit } = require("./middleware");
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) console.warn("[startup] RESEND_API_KEY not set — all emails disabled");

// Escape user-supplied strings before interpolating into email/admin HTML
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// zod's .url() accepts javascript: and data: — and advertiser URLs arrive on an
// unauthenticated form, then reach vscode.env.openExternal() in the extension and
// href/src in two dashboards. Reject non-http(s) here, at the one boundary they
// all enter through, rather than in each renderer.
// Regex, not new URL(): zod still runs a refinement after .url() already failed,
// so constructing a URL here throws a raw TypeError on junk input and turns a
// 400 into a 500.
const httpUrl = z.string().url().refine(
  (u) => /^https?:\/\//i.test(u),
  { message: "url must be http(s)" }
);

// Dev's share of each advertiser bid — payout_paise is always derived from this, never client-set
const PAYOUT_SHARE = 0.6;

// Canonical email for dedupe: lowercase, strip +tag from the local part; gmail ignores dots too
function canonicalEmail(email) {
  const [local = "", domain = ""] = String(email).toLowerCase().trim().split("@");
  let l = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") l = l.replace(/\./g, "");
  return `${l}@${domain}`;
}
// Backfill canonical emails for invites created before the column existed
{
  const upd = db.prepare("UPDATE beta_invites SET email_canonical = ? WHERE code = ?");
  for (const r of db.prepare("SELECT code, email FROM beta_invites WHERE email_canonical IS NULL").all()) {
    upd.run(canonicalEmail(r.email), r.code);
  }
}

const app = express();
// Behind Railway's proxy — makes req.ip the real client IP so rate limits key correctly
app.set("trust proxy", 1);

// CORS — /v1 only (landing page + browser clients). The admin /api stays
// same-origin so browsers can't be scripted into it cross-site.
const corsMw = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
};

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// Landing pages at /site/ — doesn't collide with admin panel at /
app.use("/site", express.static(path.join(__dirname, "..", "landing")));

// ─── Public extension API (/v1/) ──────────────────────────────────────────────

app.use("/v1", corsMw, globalRateLimit);

// GET /v1/jwks  — public key for client-side token verification
app.get("/v1/jwks", (req, res) => {
  res.json({ keys: [getPublicJwk()] });
});

// POST /v1/register  — exchange invite code for access + refresh tokens
app.post("/v1/register", authRateLimit, (req, res) => {
  const parse = z.object({ inviteCode: z.string().min(1) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "inviteCode required" });

  const code = parse.data.inviteCode.toUpperCase().trim();
  const invite = db.prepare(
    "SELECT * FROM beta_invites WHERE code = ? AND used_at IS NULL"
  ).get(code);

  if (!invite) return res.status(403).json({ error: "invalid_or_used_code" });

  const userId = randomUUID();
  const refreshToken = randomUUID();

  try {
    db.transaction(() => {
      db.prepare("INSERT INTO users (id, email, invite_code, company) VALUES (?, ?, ?, ?)").run(userId, invite.email, invite.code, invite.company || null);
      db.prepare("UPDATE beta_invites SET used_at = ?, used_by_user_id = ? WHERE code = ?").run(Math.floor(Date.now() / 1000), userId, invite.code);
      db.prepare("INSERT INTO refresh_tokens (id, user_id) VALUES (?, ?)").run(refreshToken, userId);
    })();
  } catch (e) {
    console.error("[register] DB error:", e.message);
    return res.status(500).json({ error: "registration_failed" });
  }

  console.log(`[register] new user ${userId} via code ${code}`);
  res.json({ accessToken: signAccessToken(userId), refreshToken, userId });
});

// POST /v1/login  — sign in again using an already-used invite code
app.post("/v1/login", authRateLimit, (req, res) => {
  const parse = z.object({ inviteCode: z.string().min(1) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "inviteCode required" });

  const code = parse.data.inviteCode.toUpperCase().trim();
  const invite = db.prepare(
    "SELECT * FROM beta_invites WHERE code = ? AND used_by_user_id IS NOT NULL"
  ).get(code);
  if (!invite) return res.status(403).json({ error: "invalid_code" });

  const user = db.prepare("SELECT status FROM users WHERE id = ?").get(invite.used_by_user_id);
  if (!user || user.status !== "active") return res.status(403).json({ error: "account_revoked" });

  const refreshToken = randomUUID();
  db.prepare("INSERT INTO refresh_tokens (id, user_id) VALUES (?, ?)").run(refreshToken, invite.used_by_user_id);

  console.log(`[login] user=${invite.used_by_user_id} via code ${code}`);
  res.json({ accessToken: signAccessToken(invite.used_by_user_id), refreshToken, userId: invite.used_by_user_id });
});

// GET /v1/me  — lightweight token validation + profile
app.get("/v1/me", requireAuth, (req, res) => {
  const user = db.prepare(
    `SELECT id, email, upi_id, created_at, company,
            experience_level, primary_stack, country, profile_done_at
     FROM users WHERE id = ?`
  ).get(req.userId);
  const team = db.prepare(
    "SELECT t.id, t.name, t.code FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ?"
  ).get(req.userId);
  res.json({ user, team: team || null });
});

// POST /v1/token/refresh  — exchange refresh token for new access + refresh tokens
// No Authorization header needed — the refresh token IS the credential here.
app.post("/v1/token/refresh", authRateLimit, (req, res) => {
  const parse = z.object({ refreshToken: z.string().uuid() }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "refreshToken required" });

  const record = db.prepare(
    "SELECT user_id, revoked_at, created_at FROM refresh_tokens WHERE id = ?"
  ).get(parse.data.refreshToken);
  if (!record) return res.status(401).json({ error: "invalid_refresh_token" });

  // A rotated token coming back = theft signal — nuke the whole session family.
  if (record.revoked_at != null) {
    db.prepare("UPDATE refresh_tokens SET revoked_at = unixepoch() WHERE user_id = ? AND revoked_at IS NULL")
      .run(record.user_id);
    console.warn(`[token-refresh] REUSE DETECTED user=${record.user_id} — all refresh tokens revoked`);
    return res.status(401).json({ error: "refresh_reuse_detected" });
  }

  // Refresh tokens live 30 days from issue; after that, log in again.
  if (record.created_at < Math.floor(Date.now() / 1000) - 30 * 86400) {
    return res.status(401).json({ error: "refresh_expired" });
  }

  const user = db.prepare("SELECT status FROM users WHERE id = ?").get(record.user_id);
  if (!user || user.status !== "active") return res.status(403).json({ error: "account_revoked" });

  // Rotate: revoke the used token, issue a brand new one.
  // If an attacker steals + uses a refresh token, the real user's next refresh fails — detectable.
  const newRefreshToken = randomUUID();
  db.prepare("UPDATE refresh_tokens SET revoked_at = unixepoch() WHERE id = ?")
    .run(parse.data.refreshToken);
  db.prepare("INSERT INTO refresh_tokens (id, user_id) VALUES (?, ?)")
    .run(newRefreshToken, record.user_id);

  console.log(`[token-refresh] user=${record.user_id}`);
  res.json({ accessToken: signAccessToken(record.user_id), refreshToken: newRefreshToken });
});

// DELETE /v1/logout  — revoke refresh token (sign out)
app.delete("/v1/logout", requireAuth, (req, res) => {
  const parse = z.object({ refreshToken: z.string().uuid() }).safeParse(req.body);
  if (parse.success) {
    db.prepare("UPDATE refresh_tokens SET revoked_at = unixepoch() WHERE id = ? AND user_id = ?")
      .run(parse.data.refreshToken, req.userId);
  }
  res.json({ ok: true });
});

// PUT /v1/profile/upi  — set/update UPI ID (starts a 24h withdrawal lock, see /v1/withdraw)
app.put("/v1/profile/upi", requireAuth, (req, res) => {
  const parse = z.object({ upiId: z.string().regex(/^[\w.\-]{2,64}@[a-zA-Z]{2,32}$/) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid upiId" });
  db.prepare("UPDATE users SET upi_id = ?, upi_updated_at = unixepoch() WHERE id = ?").run(parse.data.upiId, req.userId);
  res.json({ ok: true });
});

// DELETE /v1/me  — account deletion: anonymise PII, keep money rows for accounting
app.delete("/v1/me", requireAuth, (req, res) => {
  db.transaction(() => {
    db.prepare("UPDATE users SET status = 'deleted', email = ?, upi_id = NULL, company = NULL, country = NULL WHERE id = ?")
      .run(`deleted-${req.userId}@deleted.invalid`, req.userId);
    db.prepare("UPDATE refresh_tokens SET revoked_at = unixepoch() WHERE user_id = ? AND revoked_at IS NULL")
      .run(req.userId);
  })();
  console.log(`[delete-me] user=${req.userId}`);
  res.json({ ok: true });
});

// POST /v1/me/profile  — "small background questions" survey (all fields optional)
app.post("/v1/me/profile", requireAuth, (req, res) => {
  const parse = z.object({
    experienceLevel: z.enum(["student", "junior", "mid", "senior"]).optional(),
    primaryStack:    z.enum(["node", "python", "go", "java", "rust", "php", "other"]).optional(),
    country:         z.string().max(64).optional(),
    company:         z.string().min(1).max(120).optional(),
  }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body", details: parse.error.flatten() });

  const { experienceLevel, primaryStack, country, company } = parse.data;
  // COALESCE keeps previously answered questions when the client sends a partial survey
  db.prepare(
    `UPDATE users SET experience_level = COALESCE(?, experience_level),
                      primary_stack    = COALESCE(?, primary_stack),
                      country          = COALESCE(?, country),
                      company          = COALESCE(?, company),
                      profile_done_at  = unixepoch()
     WHERE id = ?`
  ).run(experienceLevel ?? null, primaryStack ?? null, country?.trim() || null, company?.trim() || null, req.userId);

  console.log(`[profile] user=${req.userId} level=${experienceLevel || "-"} stack=${primaryStack || "-"} company=${company || "-"}`);
  res.json({ ok: true });
});

// GET /v1/me/analytics  — per-user earnings breakdown for the web dashboard
app.get("/v1/me/analytics", requireAuth, (req, res) => {
  const totals = db.prepare(
    `SELECT COALESCE(SUM(payout_paise), 0) AS total_paise, COUNT(*) AS impression_count, MIN(ts) AS first_ts
     FROM impressions WHERE user_id = ?`
  ).get(req.userId);
  const clickCount = db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE user_id = ?").get(req.userId).n;
  const withdrawn = db.prepare(
    `SELECT COALESCE(SUM(amount_paise), 0) AS total_paise
     FROM withdrawals WHERE user_id = ? AND status IN ('pending', 'completed')`
  ).get(req.userId).total_paise;

  const daily = db.prepare(
    `SELECT date(ts, 'unixepoch') AS day,
            COALESCE(SUM(payout_paise), 0) AS paise,
            COUNT(*) AS impressions
     FROM impressions
     WHERE user_id = ? AND ts > unixepoch() - 30 * 86400
     GROUP BY day ORDER BY day`
  ).all(req.userId);

  const byTaskType = db.prepare(
    `SELECT task_type, COUNT(*) AS n, COALESCE(SUM(payout_paise), 0) AS paise
     FROM impressions WHERE user_id = ? AND task_type IS NOT NULL
     GROUP BY task_type ORDER BY n DESC`
  ).all(req.userId);

  const bySponsor = db.prepare(
    `SELECT i.sponsor_id, COALESCE(s.name, i.sponsor_id) AS name,
            COUNT(*) AS n, COALESCE(SUM(i.payout_paise), 0) AS paise
     FROM impressions i LEFT JOIN sponsors s ON s.id = i.sponsor_id
     WHERE i.user_id = ? GROUP BY i.sponsor_id ORDER BY paise DESC`
  ).all(req.userId);

  // Rank among earning devs; a dev with nothing yet counts as one extra entrant
  const earners = db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM impressions").get().n;
  const ahead = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT user_id FROM impressions GROUP BY user_id HAVING SUM(payout_paise) > ?
     )`
  ).get(totals.total_paise).n;

  res.json({
    totalPaise: totals.total_paise,
    impressionCount: totals.impression_count,
    clickCount,
    availablePaise: totals.total_paise - withdrawn,
    withdrawnPaise: withdrawn,
    daily,
    byTaskType,
    bySponsor,
    firstEarnedAt: totals.first_ts,
    rank: { position: ahead + 1, outOf: earners + (totals.impression_count ? 0 : 1) },
  });
});

// Keeps a preference filter from emptying the auction pool — narrows only if something matches
function prefer(pool, fn) {
  const narrowed = pool.filter(fn);
  return narrowed.length ? narrowed : pool;
}

// Per-sponsor spend in one GROUP BY (bid-denominated — budgets cap what advertisers pay,
// not what devs are paid), instead of a query per sponsor.
function spendBySponsor(todayOnly) {
  return db.prepare(
    `SELECT sponsor_id, COALESCE(SUM(bid_paise), 0) AS spend FROM impressions
     ${todayOnly ? "WHERE ts > unixepoch('now', 'start of day')" : ""}
     GROUP BY sponsor_id`
  ).all().reduce((m, r) => (m[r.sponsor_id] = r.spend, m), {});
}

// GET /v1/sponsor-line  — fetch current ad using highest-bidder auction (authenticated)
app.get("/v1/sponsor-line", requireAuth, (req, res) => {
  const taskType = req.query.taskType || null;
  const idle = req.query.idle === "1" || req.query.idle === "true";

  // Company/university name is mandatory — no ad (no earnings) until it's filled in.
  // Reuses the existing "no sponsor available" contract; the client already
  // treats a null response as "nothing to show", so no client changes needed.
  const { company } = db.prepare("SELECT company FROM users WHERE id = ?").get(req.userId) || {};
  if (!company) return res.json(null);

  const allSponsors = db.prepare("SELECT * FROM sponsors WHERE active = 1").all();
  if (allSponsors.length === 0) return res.json(null);

  const todaySpend = spendBySponsor(true);
  const totalSpend = spendBySponsor(false);

  // Filter out sponsors that have exceeded their daily or lifetime budget
  let eligible = allSponsors.filter(s => {
    if (s.budget_paise_daily != null && (todaySpend[s.id] || 0) >= s.budget_paise_daily) return false;
    if (s.budget_paise_total != null && (totalSpend[s.id] || 0) >= s.budget_paise_total) return false;
    return true;
  });

  if (eligible.length === 0) return res.json(null);

  // Strict slot filter — legacy rows have slot_type NULL, which means "any slot".
  // ponytail: coarse slot mapping — any non-idle tracked task satisfies 'build'/'install',
  // 'test' needs "test" in taskType; a real taskType→slot map is the upgrade path.
  eligible = eligible.filter(s => {
    const slot = s.slot_type || "all";
    if (slot === "all") return true;
    if (slot === "idle") return idle;
    if (idle || !taskType) return false; // build/test/install require an active tracked task
    return slot === "test" ? String(taskType).toLowerCase().includes("test") : true;
  });

  if (eligible.length === 0) return res.json(null);

  // Stack targeting — CSV of stacks/task types; untargeted sponsors stay in as fallback
  const wants = [db.prepare("SELECT primary_stack FROM users WHERE id = ?").get(req.userId)?.primary_stack, taskType]
    .filter(Boolean).map(s => String(s).toLowerCase());
  if (wants.length) {
    eligible = prefer(eligible, s => (s.target_stack || "").split(",").some(t => wants.includes(t.trim().toLowerCase())));
  }

  // Bid-weighted lottery — higher bidders win more often, but not every user
  // converges on the single top bidder (different ads for different users).
  const totalBid = eligible.reduce((sum, s) => sum + s.bid_paise, 0);
  let r = Math.random() * totalBid;
  const sponsor = eligible.find(s => (r -= s.bid_paise) < 0) ?? eligible[eligible.length - 1];

  // Idle slots pay half. The impression token pins the served payout + bid, so what
  // /v1/impressions credits always matches what the user was shown.
  const payoutPaise = idle ? Math.round(sponsor.payout_paise * IDLE_PAYOUT_MULT) : sponsor.payout_paise;
  const impressionToken = signImpressionToken({
    sponsorId: sponsor.id, userId: req.userId, payoutPaise, bidPaise: sponsor.bid_paise,
  });

  console.log(`[sponsor-line] served "${sponsor.id}" (bid=${sponsor.bid_paise}p payout=${payoutPaise}p) to ${req.userId} task_type=${taskType} idle=${idle}`);
  res.json({
    id: sponsor.id,
    text: sponsor.text,
    advertiser: sponsor.name,
    url: sponsor.url,
    payoutPaise,
    logoUrl: sponsor.logo_url || null,
    impressionToken,
  });
});

// POST /v1/impressions — credit an impression using the signed token from /v1/sponsor-line
app.post("/v1/impressions", requireAuth, rateLimitImpressions, (req, res) => {
  const parse = z.object({
    token: z.string(),
    taskType: z.string().max(32).optional(),
  }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body" });

  let claims;
  try {
    claims = verifyImpressionToken(parse.data.token);
  } catch (_) {
    return res.status(400).json({ error: "invalid_impression_token" });
  }
  if (claims.sub !== req.userId) return res.status(403).json({ error: "token_user_mismatch" });

  const sponsor = db.prepare("SELECT * FROM sponsors WHERE id = ? AND active = 1").get(claims.spn);
  if (!sponsor) return res.status(400).json({ error: "unknown_sponsor" });

  const ip = req.ip || req.headers["x-forwarded-for"] || null;
  try {
    // Budget re-check + insert are atomic — the serve-time eligibility check can race
    const exhausted = db.transaction(() => {
      // Replayed token → 409 even when the budget is also gone (unique index is the race backstop)
      if (db.prepare("SELECT 1 FROM impressions WHERE jti = ?").get(claims.jti)) {
        const err = new Error("duplicate jti");
        err.code = "SQLITE_CONSTRAINT_UNIQUE";
        throw err;
      }
      const today = db.prepare(
        `SELECT COALESCE(SUM(bid_paise), 0) AS spend FROM impressions
         WHERE sponsor_id = ? AND ts > unixepoch('now', 'start of day')`
      ).get(sponsor.id).spend;
      const total = db.prepare(
        "SELECT COALESCE(SUM(bid_paise), 0) AS spend FROM impressions WHERE sponsor_id = ?"
      ).get(sponsor.id).spend;
      if ((sponsor.budget_paise_daily != null && today + sponsor.bid_paise > sponsor.budget_paise_daily) ||
          (sponsor.budget_paise_total != null && total + sponsor.bid_paise > sponsor.budget_paise_total)) {
        return true;
      }
      db.prepare("INSERT INTO impressions (user_id, sponsor_id, task_type, ip, payout_paise, bid_paise, jti) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(req.userId, sponsor.id, parse.data.taskType || null, ip, claims.pay, claims.bid, claims.jti);
      return false;
    })();
    if (exhausted) return res.status(410).json({ error: "budget_exhausted" });
  } catch (e) {
    // Unique jti index — the same token can only ever credit once
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "duplicate_impression" });
    throw e;
  }

  console.log(`[impression] user=${req.userId} sponsor=${sponsor.id} type=${parse.data.taskType}`);
  res.json({ ok: true });
});

// POST /v1/clicks
app.post("/v1/clicks", requireAuth, (req, res) => {
  const parse = z.object({ lineId: z.string().regex(/^sponsor-[a-z0-9-]+$/) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body" });

  db.prepare("INSERT INTO clicks (user_id, sponsor_id) VALUES (?, ?)").run(req.userId, parse.data.lineId);
  console.log(`[click] user=${req.userId} sponsor=${parse.data.lineId}`);
  res.json({ ok: true });
});

// GET /v1/earnings  — server-verified earnings + withdrawable balance
app.get("/v1/earnings", requireAuth, (req, res) => {
  const row = db.prepare(
    `SELECT COALESCE(SUM(payout_paise), 0) AS total_paise, COUNT(*) AS impression_count
     FROM impressions WHERE user_id = ?`
  ).get(req.userId);
  const withdrawn = db.prepare(
    `SELECT COALESCE(SUM(amount_paise), 0) AS total_paise
     FROM withdrawals WHERE user_id = ? AND status IN ('pending', 'completed')`
  ).get(req.userId).total_paise;
  const pending = db.prepare(
    "SELECT 1 FROM withdrawals WHERE user_id = ? AND status = 'pending'"
  ).get(req.userId);
  res.json({
    totalPaise: row.total_paise,
    impressionCount: row.impression_count,
    withdrawnPaise: withdrawn,
    availablePaise: row.total_paise - withdrawn,
    pendingWithdrawal: !!pending,
    minWithdrawPaise: MIN_WITHDRAWAL_PAISE,
  });
});

// GET /v1/stats  — quick sanity check (unauthenticated, aggregate only)
app.get("/v1/stats", (req, res) => {
  const impressions = db.prepare("SELECT COUNT(*) as n FROM impressions").get().n;
  const clicks = db.prepare("SELECT COUNT(*) as n FROM clicks").get().n;
  res.json({ impressions, clicks });
});

// ─── UPI Withdrawal ──────────────────────────────────────────────────────────

const MIN_WITHDRAWAL_PAISE = 5000; // ₹50
const IDLE_PAYOUT_MULT = 0.5;      // idle-slot impressions pay half (see /v1/sponsor-line)
const PENDING_MSG = "A withdrawal is already being processed.";

// POST /v1/withdraw  — request a UPI payout
app.post("/v1/withdraw", requireAuth, (req, res) => {
  const user = db.prepare("SELECT upi_id, upi_updated_at FROM users WHERE id = ?").get(req.userId);
  if (!user?.upi_id) {
    return res.status(400).json({ error: "upi_not_set", message: "Set your UPI ID first via the extension command." });
  }

  // 24h cool-off after any UPI change (including the first set) — blunts account-takeover → drain
  if (user.upi_updated_at && user.upi_updated_at > Math.floor(Date.now() / 1000) - 86400) {
    return res.status(400).json({ error: "upi_recently_changed", message: "UPI ID was changed recently. Withdrawals unlock 24h after a UPI change." });
  }

  // Balance check + insert are atomic; the partial unique index on pending
  // withdrawals catches the race two concurrent requests would otherwise win.
  let out;
  try {
    out = db.transaction(() => {
      const earned = db.prepare(
        "SELECT COALESCE(SUM(payout_paise), 0) AS total_paise FROM impressions WHERE user_id = ?"
      ).get(req.userId).total_paise;
      const withdrawn = db.prepare(
        `SELECT COALESCE(SUM(amount_paise), 0) AS total_paise
         FROM withdrawals WHERE user_id = ? AND status IN ('pending', 'completed')`
      ).get(req.userId).total_paise;
      const available = earned - withdrawn;

      if (available < MIN_WITHDRAWAL_PAISE) {
        return { status: 400, body: {
          error: "insufficient_balance",
          available,
          minimum: MIN_WITHDRAWAL_PAISE,
          message: `Need ₹${MIN_WITHDRAWAL_PAISE / 100} to withdraw. You have ₹${(available / 100).toFixed(2)}.`,
        } };
      }

      const pending = db.prepare(
        "SELECT id FROM withdrawals WHERE user_id = ? AND status = 'pending'"
      ).get(req.userId);
      if (pending) return { status: 400, body: { error: "withdrawal_pending", message: PENDING_MSG } };

      db.prepare("INSERT INTO withdrawals (user_id, amount_paise, upi_id) VALUES (?, ?, ?)")
        .run(req.userId, available, user.upi_id);

      console.log(`[withdraw] user=${req.userId} amount=₹${(available / 100).toFixed(2)} upi=${user.upi_id}`);
      return { status: 200, body: {
        ok: true,
        amountPaise: available,
        upiId: user.upi_id,
        message: `Withdrawal of ₹${(available / 100).toFixed(2)} requested to ${user.upi_id}. Processed within 7 days.`,
      } };
    })();
  } catch (e) {
    if (e.code !== "SQLITE_CONSTRAINT_UNIQUE") throw e;
    out = { status: 400, body: { error: "withdrawal_pending", message: PENDING_MSG } };
  }
  res.status(out.status).json(out.body);
});

// GET /v1/withdraw/history  — payout history for authenticated user
app.get("/v1/withdraw/history", requireAuth, (req, res) => {
  const history = db.prepare(
    "SELECT id, amount_paise, upi_id, status, ref, created_at, resolved_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
  ).all(req.userId);
  res.json(history);
});

// ─── Team Earnings Pool ────────────────────────────────────────────────────────

function generateTeamCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join("");
}

// POST /v1/teams  — create a new team pool
app.post("/v1/teams", requireAuth, (req, res) => {
  const parse = z.object({ name: z.string().min(2).max(64) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "name required (2-64 chars)" });

  // Leave any existing team first
  const existing = db.prepare(
    "SELECT team_id FROM team_members WHERE user_id = ?"
  ).get(req.userId);
  if (existing) {
    return res.status(400).json({ error: "already_in_team", message: "Leave your current team before creating a new one." });
  }

  const teamId = "team-" + randomUUID().slice(0, 8);
  let code;
  let attempts = 0;
  do {
    code = generateTeamCode();
    attempts++;
  } while (db.prepare("SELECT id FROM teams WHERE code = ?").get(code) && attempts < 10);

  db.prepare("INSERT INTO teams (id, name, code, owner_id) VALUES (?, ?, ?, ?)")
    .run(teamId, parse.data.name.trim(), code, req.userId);
  db.prepare("INSERT INTO team_members (team_id, user_id) VALUES (?, ?)")
    .run(teamId, req.userId);

  console.log(`[team-create] user=${req.userId} team=${teamId} code=${code}`);
  res.json({ ok: true, teamId, code, name: parse.data.name.trim() });
});

// POST /v1/teams/join  — join a team pool with a code
app.post("/v1/teams/join", requireAuth, (req, res) => {
  const parse = z.object({ code: z.string().length(6) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "6-char team code required" });

  const team = db.prepare("SELECT * FROM teams WHERE code = ?").get(parse.data.code.toUpperCase());
  if (!team) return res.status(404).json({ error: "team_not_found" });

  const alreadyMember = db.prepare(
    "SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?"
  ).get(team.id, req.userId);
  if (alreadyMember) return res.status(400).json({ error: "already_member" });

  const inOtherTeam = db.prepare("SELECT team_id FROM team_members WHERE user_id = ?").get(req.userId);
  if (inOtherTeam) {
    return res.status(400).json({ error: "already_in_team", message: "Leave your current team first." });
  }

  db.prepare("INSERT INTO team_members (team_id, user_id) VALUES (?, ?)").run(team.id, req.userId);
  console.log(`[team-join] user=${req.userId} team=${team.id}`);
  res.json({ ok: true, teamId: team.id, name: team.name });
});

// DELETE /v1/teams/leave  — leave current team
app.delete("/v1/teams/leave", requireAuth, (req, res) => {
  db.prepare("DELETE FROM team_members WHERE user_id = ?").run(req.userId);
  res.json({ ok: true });
});

// GET /v1/teams/me  — my team info + leaderboard
app.get("/v1/teams/me", requireAuth, (req, res) => {
  const membership = db.prepare("SELECT team_id FROM team_members WHERE user_id = ?").get(req.userId);
  if (!membership) return res.json(null);

  const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(membership.team_id);
  const leaderboard = db.prepare(
    `SELECT tm.user_id,
            COALESCE(SUM(i.payout_paise), 0) AS total_paise,
            COUNT(i.id)                        AS impression_count
     FROM   team_members tm
     LEFT JOIN impressions i ON i.user_id = tm.user_id
     WHERE  tm.team_id = ?
     GROUP  BY tm.user_id
     ORDER  BY total_paise DESC`
  ).all(membership.team_id);

  const teamTotal = leaderboard.reduce((sum, r) => sum + r.total_paise, 0);

  res.json({
    team: { id: team.id, name: team.name, code: team.code, ownerId: team.owner_id },
    leaderboard,
    teamTotalPaise: teamTotal,
    memberCount: leaderboard.length,
  });
});

// ─── Public Stats Dashboard ───────────────────────────────────────────────────

// GET /v1/public/stats  — shareable dashboard numbers (no auth, aggregate only)
app.get("/v1/public/stats", (req, res) => {
  const totalImpressions = db.prepare("SELECT COUNT(*) as n FROM impressions").get().n;
  // Accrued earnings (what devs have racked up) — used for the per-dev average
  // and the 7-day pace below, not for "paid out" (that's actual withdrawals).
  const totalEarned = db.prepare(
    "SELECT COALESCE(SUM(payout_paise), 0) AS total_paise FROM impressions"
  ).get().total_paise;
  // Money that has actually left the building — completed withdrawals only.
  const totalPaidOut = db.prepare(
    "SELECT COALESCE(SUM(amount_paise), 0) AS paise FROM withdrawals WHERE status = 'completed'"
  ).get().paise;
  const activeDevs = db.prepare(
    "SELECT COUNT(DISTINCT user_id) as n FROM impressions WHERE ts > unixepoch() - 86400"
  ).get().n;
  const totalDevs = db.prepare("SELECT COUNT(*) as n FROM users WHERE status = 'active'").get().n;
  const totalSignups = db.prepare("SELECT COUNT(*) as n FROM beta_invites").get().n;
  const topTaskTypes = db.prepare(
    `SELECT task_type, COUNT(*) as n FROM impressions
     WHERE task_type IS NOT NULL GROUP BY task_type ORDER BY n DESC LIMIT 5`
  ).all();
  const totalClicks = db.prepare("SELECT COUNT(*) as n FROM clicks").get().n;
  const paidLast7d = db.prepare(
    "SELECT COALESCE(SUM(payout_paise), 0) AS paise FROM impressions WHERE ts > unixepoch() - 7 * 86400"
  ).get().paise;
  // "Active dev" here = any dev who has ever earned, so the average doesn't swing on a quiet day
  const earningDevs = db.prepare("SELECT COUNT(DISTINCT user_id) as n FROM impressions").get().n;
  const dailyImpressions = db.prepare(
    `SELECT date(ts, 'unixepoch') AS day, COUNT(*) AS n FROM impressions
     WHERE ts > unixepoch() - 14 * 86400 GROUP BY day ORDER BY day`
  ).all();

  res.json({
    totalImpressions,
    totalPaidRupees: (totalPaidOut / 100).toFixed(2),
    activeDevsToday: activeDevs,
    totalDevs,
    totalSignups,
    topTaskTypes,
    totalClicks,
    avgPerActiveDevRupees: (earningDevs ? totalEarned / earningDevs / 100 : 0).toFixed(2),
    paidLast7dRupees: (paidLast7d / 100).toFixed(2),
    dailyImpressions,
    lastUpdated: new Date().toISOString(),
  });
});

// ─── Public Signup → generate invite + send email ────────────────────────────

function buildInviteEmail(rawName, code) {
  const name = rawName ? escapeHtml(rawName) : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your DevCut invite code</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid #21262d;">
            <div style="font-size:22px;font-weight:900;letter-spacing:-.03em;color:#fff;">
              ⚡ <span style="color:#58a6ff;">Dev</span>Cut
            </div>
            <div style="font-size:13px;color:#8b949e;margin-top:4px;">Get paid while you wait on builds</div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 40px;">
            <p style="margin:0 0 16px;font-size:16px;color:#c9d1d9;">
              Hey ${name ? name.split(' ')[0] : 'dev'} 👋
            </p>
            <p style="margin:0 0 24px;font-size:15px;color:#8b949e;line-height:1.6;">
              You're in. Here's your personal DevCut invite code — it activates the VS Code extension and starts earning you money during every build, install, and deploy.
            </p>

            <!-- Invite code box -->
            <div style="background:#0d1117;border:2px solid #58a6ff;border-radius:10px;padding:24px;text-align:center;margin:0 0 28px;">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#8b949e;margin-bottom:10px;">Your Invite Code</div>
              <div style="font-size:28px;font-weight:900;letter-spacing:.08em;color:#58a6ff;font-family:monospace;">${code}</div>
              <div style="font-size:12px;color:#3d4451;margin-top:8px;">One-time use · Keep this safe</div>
            </div>

            <!-- Steps -->
            <p style="margin:0 0 14px;font-size:14px;font-weight:700;color:#e2e8f0;text-transform:uppercase;letter-spacing:.08em;">How to activate</p>
            <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:28px;">
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid #21262d;">
                  <span style="display:inline-block;width:24px;height:24px;background:#58a6ff;color:#0d1117;border-radius:50%;font-size:12px;font-weight:700;text-align:center;line-height:24px;margin-right:12px;">1</span>
                  <span style="color:#c9d1d9;font-size:14px;">Open VS Code → Extensions (<code style="background:#21262d;padding:1px 6px;border-radius:4px;font-size:12px;">Ctrl+Shift+X</code>) → search <strong style="color:#fff;">DevCut</strong> → Install</span>
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid #21262d;">
                  <span style="display:inline-block;width:24px;height:24px;background:#58a6ff;color:#0d1117;border-radius:50%;font-size:12px;font-weight:700;text-align:center;line-height:24px;margin-right:12px;">2</span>
                  <span style="color:#c9d1d9;font-size:14px;">Open Command Palette (<code style="background:#21262d;padding:1px 6px;border-radius:4px;font-size:12px;">Ctrl+Shift+P</code>) → type <strong style="color:#fff;">DevCut: Activate</strong></span>
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0;">
                  <span style="display:inline-block;width:24px;height:24px;background:#58a6ff;color:#0d1117;border-radius:50%;font-size:12px;font-weight:700;text-align:center;line-height:24px;margin-right:12px;">3</span>
                  <span style="color:#c9d1d9;font-size:14px;">Paste your invite code above → start earning on your next build</span>
                </td>
              </tr>
            </table>

            <!-- CTA -->
            <div style="text-align:center;margin-bottom:28px;">
              <a href="https://marketplace.visualstudio.com/items?itemName=gouravgujariya.devcut"
                 style="display:inline-block;background:#58a6ff;color:#0d1117;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px;text-decoration:none;letter-spacing:.01em;">
                Install DevCut Extension →
              </a>
            </div>

            <p style="margin:0;font-size:13px;color:#3d4451;line-height:1.6;">
              Once activated, DevCut shows a single sponsored line in your VS Code status bar while you wait on long-running tasks. You earn ₹ every time an ad is shown. Set your UPI ID to withdraw earnings anytime.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px;border-top:1px solid #21262d;text-align:center;">
            <p style="margin:0;font-size:12px;color:#3d4451;">
              © 2026 DevCut · <a href="https://devcut.co.in" style="color:#58a6ff;text-decoration:none;">devcut.co.in</a>
              · <a href="mailto:techsupport@devcut.co.in" style="color:#58a6ff;text-decoration:none;">techsupport@devcut.co.in</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// POST /v1/public/signup  — waitlist signup: generate invite code + send email
app.post("/v1/public/signup", async (req, res) => {
  const parse = z.object({
    name:    z.string().min(1).max(120),
    email:   z.string().email(),
    role:    z.string().max(64).optional(),
    github:  z.string().max(64).optional().nullable(),
    company: z.string().min(1).max(120),
    source:  z.string().max(64).optional(),
  }).safeParse(req.body);

  if (!parse.success) return res.status(400).json({ error: "invalid_body" });

  const { name, email, role, github, company, source } = parse.data;
  const normalizedEmail = email.toLowerCase().trim();
  const canonical = canonicalEmail(email);
  console.log(`[signup] meta role=${role || "-"} github=${github || "-"} company=${company} source=${source || "-"}`);

  // Dedupe on canonical email (dev+tag@gmail.com == d.e.v@gmail.com); fall back
  // to exact email for legacy rows that predate the canonical column.
  const existing = db.prepare(
    "SELECT code FROM beta_invites WHERE email_canonical = ? OR (email_canonical IS NULL AND email = ?)"
  ).get(canonical, normalizedEmail);
  if (existing) {
    // Resend their code
    let email_sent = false;
    if (resend) {
      const result = await resend.emails.send({
        from: "DevCut <techsupport@devcut.co.in>",
        to: normalizedEmail,
        subject: "Your DevCut invite code (resent)",
        html: buildInviteEmail(name, existing.code),
      }).catch(err => { console.error("[signup] resend error:", err.message); return null; });
      email_sent = !!(result && !result.error);
    }
    return res.json({ ok: true, resent: true, email_sent });
  }

  // Generate new invite code (crypto-secure: the code doubles as the login credential)
  const code = generateInviteCode();

  try {
    db.prepare("INSERT INTO beta_invites (code, email, email_canonical, company, role, github, source) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(code, normalizedEmail, canonical, company.trim(), role || null, github || null, source || null);
  } catch (e) {
    console.error("[signup] db error:", e.message);
    return res.status(500).json({ error: "signup_failed" });
  }

  // Send invite email via Resend
  let email_sent = false;
  if (resend) {
    const { error } = await resend.emails.send({
      from: "DevCut <techsupport@devcut.co.in>",
      to: normalizedEmail,
      subject: "Your DevCut invite code is here ⚡",
      html: buildInviteEmail(name, code),
    }).catch(err => ({ error: err }));

    if (error) {
      console.error("[signup] resend error:", error?.message || error);
    } else {
      email_sent = true;
    }
  } else {
    console.warn("[signup] RESEND_API_KEY not set — email not sent for", normalizedEmail, code);
  }

  console.log(`[signup] new signup email=${normalizedEmail} code=${code}`);
  res.json({ ok: true, email_sent, ...(!email_sent && { note: "Email delivery pending" }) });
});

// POST /v1/public/advertiser-inquiry  — advertiser sign-up form (no auth)
app.post("/v1/public/advertiser-inquiry", async (req, res) => {
  const parse = z.object({
    company:         z.string().min(1).max(120),
    contact_name:    z.string().min(1).max(120),
    email:           z.string().email(),
    website:         httpUrl.optional().or(z.literal("")),
    ad_text:         z.string().min(5).max(160),
    destination_url: httpUrl,
    budget_range:    z.enum(["500-1000", "1000-5000", "5000-20000", "20000+"]),
    slot_type:       z.enum(["build", "test", "install", "all"]),
    product_type:    z.string().max(64).optional(),
    notes:           z.string().max(1000).optional(),
  }).safeParse(req.body);

  if (!parse.success) return res.status(400).json({ error: "invalid_body", details: parse.error.flatten() });

  const d = parse.data;
  // HTML-escaped copy for interpolation into the notification emails below
  const h = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v == null ? v : escapeHtml(v)]));

  try {
    db.prepare(`
      INSERT INTO advertiser_inquiries
        (company, contact_name, email, website, ad_text, destination_url, budget_range, slot_type, product_type, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(d.company, d.contact_name, d.email, d.website || null, d.ad_text, d.destination_url, d.budget_range, d.slot_type, d.product_type || null, d.notes || null);
  } catch (e) {
    console.error("[advertiser-inquiry] db error:", e.message);
    return res.status(500).json({ error: "db_error" });
  }

  // Notify admin
  if (resend) {
    resend.emails.send({
      from: "DevCut <techsupport@devcut.co.in>",
      to: "er.gouravgujariya@gmail.com",
      subject: `[DevCut] New advertiser: ${d.company} (${d.budget_range}/mo)`,
      html: `<div style="font-family:monospace;background:#0d1117;color:#e2e8f0;padding:24px;border-radius:8px;">
        <h2 style="color:#58a6ff;margin-bottom:16px;">New Advertiser Inquiry</h2>
        <table style="border-collapse:collapse;width:100%;">
          <tr><td style="color:#8b949e;padding:6px 12px 6px 0;">Company</td><td style="color:#fff;font-weight:700;">${h.company}</td></tr>
          <tr><td style="color:#8b949e;padding:6px 12px 6px 0;">Contact</td><td>${h.contact_name} &lt;${h.email}&gt;</td></tr>
          <tr><td style="color:#8b949e;padding:6px 12px 6px 0;">Website</td><td>${h.website || "—"}</td></tr>
          <tr><td style="color:#8b949e;padding:6px 12px 6px 0;">Budget</td><td style="color:#00e676;font-weight:700;">₹${h.budget_range}/mo</td></tr>
          <tr><td style="color:#8b949e;padding:6px 12px 6px 0;">Slot</td><td>${h.slot_type}</td></tr>
          <tr><td style="color:#8b949e;padding:6px 12px 6px 0;">Product type</td><td>${h.product_type || "—"}</td></tr>
          <tr><td style="color:#8b949e;padding:6px 12px 6px 0;">Destination URL</td><td>${h.destination_url}</td></tr>
          <tr><td style="color:#8b949e;padding:6px 12px 6px 0;vertical-align:top;">Ad text</td><td style="color:#00e676;font-style:italic;">"${h.ad_text}"</td></tr>
          <tr><td style="color:#8b949e;padding:6px 12px 6px 0;vertical-align:top;">Notes</td><td>${h.notes || "—"}</td></tr>
        </table>
        <div style="margin-top:20px;padding:12px;background:#161b22;border-radius:6px;color:#8b949e;font-size:12px;">Add to admin dashboard: https://waitwage-production.up.railway.app/admin</div>
      </div>`,
    }).catch(err => console.error("[advertiser-inquiry] resend error:", err.message));

    // Confirmation to advertiser
    resend.emails.send({
      from: "DevCut <techsupport@devcut.co.in>",
      to: d.email,
      subject: `We got your DevCut inquiry, ${d.contact_name.split(' ')[0]}!`,
      html: `<div style="font-family:-apple-system,sans-serif;background:#0d1117;color:#e2e8f0;padding:32px;border-radius:12px;max-width:520px;">
        <div style="font-size:20px;font-weight:900;margin-bottom:4px;"><span style="color:#58a6ff;">Dev</span>Cut</div>
        <div style="color:#8b949e;font-size:13px;margin-bottom:24px;">Advertising for developers</div>
        <p style="margin-bottom:16px;">Hi ${h.contact_name.split(' ')[0]},</p>
        <p style="color:#8b949e;line-height:1.6;margin-bottom:20px;">
          We've received your inquiry for <strong style="color:#fff;">${h.company}</strong>.
          We'll review your ad copy and budget and get back to you within 24 hours with next steps.
        </p>
        <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px;">
          <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px;">Your ad preview</div>
          <div style="color:#58a6ff;font-size:13px;font-family:monospace;">📣 ${h.ad_text}</div>
        </div>
        <p style="color:#8b949e;font-size:13px;">Questions? Reply to this email or reach us at <a href="mailto:techsupport@devcut.co.in" style="color:#58a6ff;">techsupport@devcut.co.in</a></p>
      </div>`,
    }).catch(err => console.error("[advertiser-inquiry] confirmation email error:", err.message));
  }

  console.log(`[advertiser-inquiry] company=${d.company} email=${d.email} budget=${d.budget_range}`);
  res.json({ ok: true });
});

// ─── Admin API ────────────────────────────────────────────────────────────────

app.use("/api", adminAuth);

app.get("/api/sponsors", (req, res) => {
  const sponsors = db.prepare("SELECT * FROM sponsors ORDER BY created_at DESC").all();
  const impressionCounts = db.prepare("SELECT sponsor_id, COUNT(*) as n FROM impressions GROUP BY sponsor_id")
    .all().reduce((acc, r) => { acc[r.sponsor_id] = r.n; return acc; }, {});
  const clickCounts = db.prepare("SELECT sponsor_id, COUNT(*) as n FROM clicks GROUP BY sponsor_id")
    .all().reduce((acc, r) => { acc[r.sponsor_id] = r.n; return acc; }, {});
  const dailySpend = spendBySponsor(true);
  const totalSpend = spendBySponsor(false);

  res.json(sponsors.map(s => ({
    ...s,
    impressions: impressionCounts[s.id] || 0,
    clicks: clickCounts[s.id] || 0,
    ctr: impressionCounts[s.id]
      ? ((clickCounts[s.id] || 0) / impressionCounts[s.id] * 100).toFixed(1) : "0.0",
    daily_spend_paise: dailySpend[s.id] || 0,
    total_spend_paise: totalSpend[s.id] || 0,
  })));
});

// Shared targeting fields for POST/PUT /api/sponsors. Empty string = "cleared".
const SLOT_TYPES = ["build", "test", "install", "idle", "all"];
const targetingFields = {
  logo_url:     httpUrl.nullable().optional().or(z.literal("")),
  slot_type:    z.enum(SLOT_TYPES).optional(),
  target_stack: z.string().max(200).nullable().optional(),
};
const targetingValues = d => [d.logo_url || null, d.slot_type || "all", d.target_stack?.trim() || null];

app.post("/api/sponsors", (req, res) => {
  const parse = z.object({
    name: z.string().min(1),
    text: z.string().min(1),
    url: httpUrl,
    bid_paise: z.number().int().min(1).optional().default(42),
    budget_paise_daily: z.number().int().min(100).nullable().optional(),
    budget_paise_total: z.number().int().min(100).nullable().optional(),
    active: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
    ...targetingFields,
  }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body", details: parse.error.flatten() });

  // payout_paise is never client-set — always derived from the bid
  const { name, text, url, bid_paise, budget_paise_daily, budget_paise_total, active } = parse.data;
  const payout_paise = Math.round(bid_paise * PAYOUT_SHARE);
  const activeVal = active === "false" || active === false ? 0 : 1;
  const id = "sponsor-" + randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO sponsors (id, name, text, url, payout_paise, bid_paise, budget_paise_daily, budget_paise_total, active, logo_url, slot_type, target_stack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name.trim(), text.trim(), url.trim(), payout_paise, bid_paise, budget_paise_daily ?? null, budget_paise_total ?? null, activeVal, ...targetingValues(parse.data));
  res.json({ ok: true, id });
});

// Partial update: absent field → keep DB value, explicit null → clear.
// payout_paise is never accepted — always re-derived from the final bid.
app.put("/api/sponsors/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM sponsors WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "sponsor_not_found" });

  const parse = z.object({
    name: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    url: httpUrl.optional(),
    bid_paise: z.number().int().min(1).optional(),
    budget_paise_daily: z.number().int().min(100).nullable().optional(),
    budget_paise_total: z.number().int().min(100).nullable().optional(),
    active: z.union([z.boolean(), z.number().int()]).optional(),
    ...targetingFields,
  }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body", details: parse.error.flatten() });

  const d = parse.data;
  const keep = (v, cur) => v === undefined ? cur : v;
  const bid_paise = keep(d.bid_paise, existing.bid_paise);
  db.prepare(
    "UPDATE sponsors SET name=?, text=?, url=?, payout_paise=?, bid_paise=?, budget_paise_daily=?, budget_paise_total=?, active=?, logo_url=?, slot_type=?, target_stack=? WHERE id=?"
  ).run(
    keep(d.name?.trim(), existing.name),
    keep(d.text?.trim(), existing.text),
    keep(d.url?.trim(), existing.url),
    Math.round(bid_paise * PAYOUT_SHARE),
    bid_paise,
    keep(d.budget_paise_daily, existing.budget_paise_daily),
    keep(d.budget_paise_total, existing.budget_paise_total),
    d.active === undefined ? existing.active : (d.active ? 1 : 0),
    d.logo_url === undefined ? existing.logo_url : (d.logo_url || null),
    keep(d.slot_type, existing.slot_type),
    d.target_stack === undefined ? existing.target_stack : (d.target_stack?.trim() || null),
    req.params.id
  );
  res.json({ ok: true });
});

app.delete("/api/sponsors/:id", (req, res) => {
  db.prepare("DELETE FROM sponsors WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/overview", (req, res) => {
  const totalImpressions = db.prepare("SELECT COUNT(*) as n FROM impressions").get().n;
  const totalClicks = db.prepare("SELECT COUNT(*) as n FROM clicks").get().n;
  const uniqueUsers = db.prepare("SELECT COUNT(DISTINCT user_id) as n FROM impressions").get().n;
  const activeSponsors = db.prepare("SELECT COUNT(*) as n FROM sponsors WHERE active=1").get().n;
  const totalUsers = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
  const pendingWithdrawals = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(amount_paise),0) as total FROM withdrawals WHERE status='pending'").get();
  // Money actually paid out — completed withdrawals only (not accrued/unwithdrawn earnings).
  const totalPaid = db.prepare(
    "SELECT COALESCE(SUM(amount_paise), 0) AS paise FROM withdrawals WHERE status = 'completed'"
  ).get().paise;
  const taskTypeBreakdown = db.prepare(
    "SELECT task_type, COUNT(*) as n FROM impressions WHERE task_type IS NOT NULL GROUP BY task_type ORDER BY n DESC"
  ).all();

  const activeDevs = db.prepare(
    "SELECT COUNT(DISTINCT user_id) as n FROM impressions WHERE ts > unixepoch() - 86400"
  ).get().n;

  const recentImpressions = db.prepare(
    "SELECT 'impression' as type, user_id, sponsor_id, ts FROM impressions ORDER BY ts DESC LIMIT 5"
  ).all();
  const recentClicks = db.prepare(
    "SELECT 'click' as type, user_id, sponsor_id, ts FROM clicks ORDER BY ts DESC LIMIT 5"
  ).all();
  const recent = [...recentImpressions, ...recentClicks].sort((a, b) => b.ts - a.ts).slice(0, 10);

  res.json({
    totalImpressions, totalClicks, uniqueUsers, activeSponsors, totalUsers,
    totalPaidRupees: (totalPaid / 100).toFixed(2),
    pendingWithdrawals: { count: pendingWithdrawals.n, totalRupees: (pendingWithdrawals.total / 100).toFixed(2) },
    taskTypeBreakdown,
    activeDevsToday: activeDevs,
    recent,
  });
});

// Admin: manage invites
app.get("/api/invites", (req, res) => {
  const invites = db.prepare("SELECT * FROM beta_invites ORDER BY created_at DESC").all();
  res.json(invites);
});

app.post("/api/invites", (req, res) => {
  const parse = z.object({ email: z.string().email(), code: z.string().min(8).optional() }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "valid email required" });
  const code = (parse.data.code || generateInviteCode()).toUpperCase().trim();
  db.prepare("INSERT OR IGNORE INTO beta_invites (code, email, email_canonical) VALUES (?, ?, ?)")
    .run(code, parse.data.email, canonicalEmail(parse.data.email));
  res.json({ ok: true, code });
});

// Admin: manage withdrawals
app.get("/api/withdrawals", (req, res) => {
  const withdrawals = db.prepare(
    "SELECT w.*, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC"
  ).all();
  res.json(withdrawals);
});

app.put("/api/withdrawals/:id", (req, res) => {
  const { status, ref } = req.body;
  if (!["completed", "rejected"].includes(status)) return res.status(400).json({ error: "status must be completed or rejected" });
  db.prepare(
    "UPDATE withdrawals SET status=?, ref=?, resolved_at=unixepoch() WHERE id=?"
  ).run(status, ref || null, req.params.id);
  res.json({ ok: true });
});

// Admin: teams overview
app.get("/api/teams", (req, res) => {
  const teams = db.prepare(
    `SELECT t.*, COUNT(tm.user_id) as member_count
     FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
     GROUP BY t.id ORDER BY t.created_at DESC`
  ).all();
  res.json(teams);
});

app.get("/api/users", (req, res) => {
  const users = db.prepare(
    `SELECT u.*,
            COALESCE(SUM(i.payout_paise), 0) AS total_earned_paise,
            COUNT(i.id) AS impression_count
     FROM users u
     LEFT JOIN impressions i ON i.user_id = u.id
     GROUP BY u.id ORDER BY total_earned_paise DESC`
  ).all();
  res.json(users);
});

app.get("/api/advertiser-inquiries", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM advertiser_inquiries ORDER BY created_at DESC"
  ).all();
  res.json(rows);
});

app.put("/api/advertiser-inquiries/:id", (req, res) => {
  const parse = z.object({
    status: z.enum(["new", "contacted", "won", "rejected"]),
    notes:  z.string().max(1000).optional(),
  }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body", details: parse.error.flatten() });

  db.prepare("UPDATE advertiser_inquiries SET status = ?, notes = COALESCE(?, notes) WHERE id = ?")
    .run(parse.data.status, parse.data.notes ?? null, req.params.id);
  res.json({ ok: true });
});

// Monthly budget → what we're willing to bid per impression. Rough tiers, tune in admin after.
const BID_BY_BUDGET = { "500-1000": 42, "1000-5000": 60, "5000-20000": 90, "20000+": 150 };

app.post("/api/advertiser-inquiries/:id/convert", (req, res) => {
  const inq = db.prepare("SELECT * FROM advertiser_inquiries WHERE id = ?").get(req.params.id);
  if (!inq) return res.status(404).json({ error: "inquiry_not_found" });

  const bid_paise = BID_BY_BUDGET[inq.budget_range] || 42;
  const sponsorId = "sponsor-" + randomUUID().slice(0, 8);
  db.transaction(() => {
    db.prepare(
      "INSERT INTO sponsors (id, name, text, url, payout_paise, bid_paise, slot_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(sponsorId, inq.company, inq.ad_text, inq.destination_url, Math.round(bid_paise * PAYOUT_SHARE), bid_paise, inq.slot_type || "all");
    db.prepare("UPDATE advertiser_inquiries SET status = 'won' WHERE id = ?").run(inq.id);
  })();

  console.log(`[inquiry-convert] inquiry=${inq.id} → sponsor=${sponsorId} bid=${bid_paise}p`);
  res.json({ ok: true, sponsorId });
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function generateInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join("");
  return `DCUT-${seg()}-${seg()}-${seg().slice(0, 2)}`;
}

// Only listen when started directly — `require`ing this file (tests) just gets the app
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nDevCut backend running at http://localhost:${PORT}`);
    console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`Public stats:    http://localhost:${PORT}/v1/public/stats\n`);
  });
}

module.exports = app;
