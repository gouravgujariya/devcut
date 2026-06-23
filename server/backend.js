const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const { z } = require("zod");
const db = require("./db");
const { signAccessToken, getPublicJwk } = require("./auth");
const { requireAuth, adminAuth, rateLimitImpressions, globalRateLimit } = require("./middleware");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Public extension API (/v1/) ──────────────────────────────────────────────

app.use("/v1", globalRateLimit);

// GET /v1/jwks  — public key for client-side token verification
app.get("/v1/jwks", (req, res) => {
  res.json({ keys: [getPublicJwk()] });
});

// POST /v1/register  — exchange invite code for access + refresh tokens
app.post("/v1/register", (req, res) => {
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
      db.prepare("INSERT INTO users (id, email, invite_code) VALUES (?, ?, ?)").run(userId, invite.email, invite.code);
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
app.post("/v1/login", (req, res) => {
  const parse = z.object({ inviteCode: z.string().min(1) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "inviteCode required" });

  const code = parse.data.inviteCode.toUpperCase().trim();
  const invite = db.prepare(
    "SELECT * FROM beta_invites WHERE code = ? AND used_by_user_id IS NOT NULL"
  ).get(code);
  if (!invite) return res.status(403).json({ error: "invalid_code" });

  const user = db.prepare("SELECT status FROM users WHERE id = ?").get(invite.used_by_user_id);
  if (!user || user.status === "revoked") return res.status(403).json({ error: "account_revoked" });

  const refreshToken = randomUUID();
  db.prepare("INSERT INTO refresh_tokens (id, user_id) VALUES (?, ?)").run(refreshToken, invite.used_by_user_id);

  console.log(`[login] user=${invite.used_by_user_id} via code ${code}`);
  res.json({ accessToken: signAccessToken(invite.used_by_user_id), refreshToken, userId: invite.used_by_user_id });
});

// GET /v1/me  — lightweight token validation + profile
app.get("/v1/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, upi_id, created_at FROM users WHERE id = ?").get(req.userId);
  const team = db.prepare(
    "SELECT t.id, t.name, t.code FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ?"
  ).get(req.userId);
  res.json({ user, team: team || null });
});

// POST /v1/token/refresh  — exchange refresh token for new access + refresh tokens
// No Authorization header needed — the refresh token IS the credential here.
app.post("/v1/token/refresh", (req, res) => {
  const parse = z.object({ refreshToken: z.string().uuid() }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "refreshToken required" });

  const record = db.prepare(
    "SELECT user_id FROM refresh_tokens WHERE id = ? AND revoked_at IS NULL"
  ).get(parse.data.refreshToken);
  if (!record) return res.status(401).json({ error: "invalid_refresh_token" });

  const user = db.prepare("SELECT status FROM users WHERE id = ?").get(record.user_id);
  if (!user || user.status === "revoked") return res.status(403).json({ error: "account_revoked" });

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

// PUT /v1/profile/upi  — set/update UPI ID
app.put("/v1/profile/upi", requireAuth, (req, res) => {
  const parse = z.object({ upiId: z.string().min(5).max(64) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid upiId" });
  db.prepare("UPDATE users SET upi_id = ? WHERE id = ?").run(parse.data.upiId, req.userId);
  res.json({ ok: true });
});

// GET /v1/sponsor-line  — fetch current ad using highest-bidder auction (authenticated)
app.get("/v1/sponsor-line", requireAuth, (req, res) => {
  const taskType = req.query.taskType || null;

  const allSponsors = db.prepare("SELECT * FROM sponsors WHERE active = 1").all();
  if (allSponsors.length === 0) return res.json(null);

  const todaySpendStmt = db.prepare(
    `SELECT COALESCE(SUM(s.payout_paise), 0) AS spend
     FROM impressions i
     JOIN sponsors s ON s.id = i.sponsor_id
     WHERE i.sponsor_id = ? AND i.ts > unixepoch('now', 'start of day')`
  );

  // Filter out sponsors that have exceeded their daily budget
  const eligible = allSponsors.filter(s => {
    if (s.budget_paise_daily == null) return true; // unlimited
    const { spend } = todaySpendStmt.get(s.id);
    return spend < s.budget_paise_daily;
  });

  if (eligible.length === 0) return res.json(null);

  // Pick highest bidder; break ties randomly
  const maxBid = Math.max(...eligible.map(s => s.bid_paise));
  const topTier = eligible.filter(s => s.bid_paise === maxBid);
  const sponsor = topTier[Math.floor(Math.random() * topTier.length)];

  const payoutPaise = Math.floor(sponsor.bid_paise * 0.6);

  console.log(`[sponsor-line] served "${sponsor.id}" (bid=${sponsor.bid_paise}p payout=${payoutPaise}p) to ${req.userId} task_type=${taskType}`);
  res.json({
    id: sponsor.id,
    text: sponsor.text,
    advertiser: sponsor.name,
    url: sponsor.url,
    payoutPaise,
  });
});

// POST /v1/impressions
app.post("/v1/impressions", requireAuth, rateLimitImpressions, (req, res) => {
  const parse = z.object({
    lineId: z.string().regex(/^sponsor-[a-z0-9-]+$/),
    taskType: z.string().max(32).optional(),
  }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body" });

  const { lineId, taskType } = parse.data;
  const sponsor = db.prepare("SELECT id FROM sponsors WHERE id = ? AND active = 1").get(lineId);
  if (!sponsor) return res.status(400).json({ error: "unknown_sponsor" });

  const ip = req.ip || req.headers["x-forwarded-for"] || null;
  db.prepare("INSERT INTO impressions (user_id, sponsor_id, task_type, ip) VALUES (?, ?, ?, ?)")
    .run(req.userId, lineId, taskType || null, ip);

  const total = db.prepare("SELECT COUNT(*) as n FROM impressions").get().n;
  console.log(`[impression] user=${req.userId} sponsor=${lineId} type=${taskType} total=${total}`);
  res.json({ ok: true });
});

// POST /v1/clicks
app.post("/v1/clicks", requireAuth, (req, res) => {
  const parse = z.object({ lineId: z.string().regex(/^sponsor-[a-z0-9-]+$/) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body" });

  db.prepare("INSERT INTO clicks (user_id, sponsor_id) VALUES (?, ?)").run(req.userId, parse.data.lineId);
  const total = db.prepare("SELECT COUNT(*) as n FROM clicks").get().n;
  console.log(`[click] user=${req.userId} sponsor=${parse.data.lineId} total=${total}`);
  res.json({ ok: true });
});

// GET /v1/earnings  — server-verified lifetime earnings for the authenticated user
app.get("/v1/earnings", requireAuth, (req, res) => {
  const row = db.prepare(
    `SELECT COALESCE(SUM(s.payout_paise), 0) AS total_paise,
            COUNT(i.id)                        AS impression_count
     FROM   impressions i
     JOIN   sponsors    s ON s.id = i.sponsor_id
     WHERE  i.user_id = ?`
  ).get(req.userId);
  res.json({ totalPaise: row.total_paise, impressionCount: row.impression_count });
});

// GET /v1/stats  — quick sanity check (unauthenticated, aggregate only)
app.get("/v1/stats", (req, res) => {
  const impressions = db.prepare("SELECT COUNT(*) as n FROM impressions").get().n;
  const clicks = db.prepare("SELECT COUNT(*) as n FROM clicks").get().n;
  res.json({ impressions, clicks });
});

// ─── UPI Withdrawal ──────────────────────────────────────────────────────────

const MIN_WITHDRAWAL_PAISE = 5000; // ₹50

// POST /v1/withdraw  — request a UPI payout
app.post("/v1/withdraw", requireAuth, (req, res) => {
  const user = db.prepare("SELECT upi_id FROM users WHERE id = ?").get(req.userId);
  if (!user?.upi_id) {
    return res.status(400).json({ error: "upi_not_set", message: "Set your UPI ID first via the extension command." });
  }

  // Calculate available balance (total earned - total withdrawn)
  const earned = db.prepare(
    `SELECT COALESCE(SUM(s.payout_paise), 0) AS total_paise
     FROM impressions i JOIN sponsors s ON s.id = i.sponsor_id
     WHERE i.user_id = ?`
  ).get(req.userId).total_paise;

  const withdrawn = db.prepare(
    `SELECT COALESCE(SUM(amount_paise), 0) AS total_paise
     FROM withdrawals WHERE user_id = ? AND status IN ('pending', 'completed')`
  ).get(req.userId).total_paise;

  const available = earned - withdrawn;

  if (available < MIN_WITHDRAWAL_PAISE) {
    return res.status(400).json({
      error: "insufficient_balance",
      available,
      minimum: MIN_WITHDRAWAL_PAISE,
      message: `Need ₹${MIN_WITHDRAWAL_PAISE / 100} to withdraw. You have ₹${(available / 100).toFixed(2)}.`,
    });
  }

  // Check no pending withdrawal already exists
  const pending = db.prepare(
    "SELECT id FROM withdrawals WHERE user_id = ? AND status = 'pending'"
  ).get(req.userId);
  if (pending) {
    return res.status(400).json({ error: "withdrawal_pending", message: "A withdrawal is already being processed." });
  }

  db.prepare(
    "INSERT INTO withdrawals (user_id, amount_paise, upi_id) VALUES (?, ?, ?)"
  ).run(req.userId, available, user.upi_id);

  console.log(`[withdraw] user=${req.userId} amount=₹${(available / 100).toFixed(2)} upi=${user.upi_id}`);
  res.json({
    ok: true,
    amountPaise: available,
    upiId: user.upi_id,
    message: `Withdrawal of ₹${(available / 100).toFixed(2)} requested to ${user.upi_id}. Processed within 7 days.`,
  });
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
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
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
            COALESCE(SUM(s.payout_paise), 0) AS total_paise,
            COUNT(i.id)                        AS impression_count
     FROM   team_members tm
     LEFT JOIN impressions i ON i.user_id = tm.user_id
     LEFT JOIN sponsors    s ON s.id = i.sponsor_id
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
  const totalPaid = db.prepare(
    `SELECT COALESCE(SUM(s.payout_paise), 0) AS total_paise
     FROM impressions i JOIN sponsors s ON s.id = i.sponsor_id`
  ).get().total_paise;
  const activeDevs = db.prepare(
    "SELECT COUNT(DISTINCT user_id) as n FROM impressions WHERE ts > unixepoch() - 86400"
  ).get().n;
  const totalDevs = db.prepare("SELECT COUNT(*) as n FROM users WHERE status = 'active'").get().n;
  const topTaskTypes = db.prepare(
    `SELECT task_type, COUNT(*) as n FROM impressions
     WHERE task_type IS NOT NULL GROUP BY task_type ORDER BY n DESC LIMIT 5`
  ).all();

  res.json({
    totalImpressions,
    totalPaidRupees: (totalPaid / 100).toFixed(2),
    activeDevsToday: activeDevs,
    totalDevs,
    topTaskTypes,
    lastUpdated: new Date().toISOString(),
  });
});

// ─── Admin API ────────────────────────────────────────────────────────────────

app.use("/api", adminAuth);

app.get("/api/sponsors", (req, res) => {
  const sponsors = db.prepare("SELECT * FROM sponsors ORDER BY created_at DESC").all();
  const impressionCounts = db.prepare("SELECT sponsor_id, COUNT(*) as n FROM impressions GROUP BY sponsor_id")
    .all().reduce((acc, r) => { acc[r.sponsor_id] = r.n; return acc; }, {});
  const clickCounts = db.prepare("SELECT sponsor_id, COUNT(*) as n FROM clicks GROUP BY sponsor_id")
    .all().reduce((acc, r) => { acc[r.sponsor_id] = r.n; return acc; }, {});
  const dailySpendStmt = db.prepare(
    `SELECT COALESCE(SUM(s.payout_paise), 0) AS spend
     FROM impressions i
     JOIN sponsors s ON s.id = i.sponsor_id
     WHERE i.sponsor_id = ? AND i.ts > unixepoch('now', 'start of day')`
  );

  res.json(sponsors.map(s => ({
    ...s,
    impressions: impressionCounts[s.id] || 0,
    clicks: clickCounts[s.id] || 0,
    ctr: impressionCounts[s.id]
      ? ((clickCounts[s.id] || 0) / impressionCounts[s.id] * 100).toFixed(1) : "0.0",
    daily_spend_paise: dailySpendStmt.get(s.id).spend,
  })));
});

app.post("/api/sponsors", (req, res) => {
  const parse = z.object({
    name: z.string().min(1),
    text: z.string().min(1),
    url: z.string().url(),
    payout_paise: z.number().int().min(1).optional(),
    bid_paise: z.number().int().min(1).optional().default(42),
    budget_paise_daily: z.number().int().min(100).nullable().optional(),
    active: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body", details: parse.error.flatten() });

  const { name, text, url, bid_paise, budget_paise_daily, active } = parse.data;
  const payout_paise = Math.round(bid_paise * 0.6);
  const activeVal = active === "false" || active === false ? 0 : 1;
  const id = "sponsor-" + randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO sponsors (id, name, text, url, payout_paise, bid_paise, budget_paise_daily, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name.trim(), text.trim(), url.trim(), payout_paise, bid_paise, budget_paise_daily ?? null, activeVal);
  res.json({ ok: true, id });
});

app.put("/api/sponsors/:id", (req, res) => {
  const parse = z.object({
    name: z.string().min(1),
    text: z.string().min(1),
    url: z.string().url(),
    bid_paise: z.number().int().min(1).optional().default(42),
    budget_paise_daily: z.number().int().min(100).nullable().optional(),
    active: z.union([z.boolean(), z.number().int()]).optional(),
  }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body", details: parse.error.flatten() });

  const { name, text, url, bid_paise, budget_paise_daily, active } = parse.data;
  const payout_paise = Math.round(bid_paise * 0.6);
  const activeVal = active ? 1 : 0;
  db.prepare(
    "UPDATE sponsors SET name=?, text=?, url=?, payout_paise=?, bid_paise=?, budget_paise_daily=?, active=? WHERE id=?"
  ).run(name.trim(), text.trim(), url.trim(), payout_paise, bid_paise, budget_paise_daily ?? null, activeVal, req.params.id);
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
  const totalPaid = db.prepare(
    `SELECT COALESCE(SUM(s.payout_paise), 0) AS paise
     FROM impressions i JOIN sponsors s ON s.id = i.sponsor_id`
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
  db.prepare("INSERT OR IGNORE INTO beta_invites (code, email) VALUES (?, ?)").run(code, parse.data.email);
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
            COALESCE(SUM(s.payout_paise), 0) AS total_earned_paise,
            COUNT(i.id) AS impression_count
     FROM users u
     LEFT JOIN impressions i ON i.user_id = u.id
     LEFT JOIN sponsors s ON s.id = i.sponsor_id
     GROUP BY u.id ORDER BY total_earned_paise DESC`
  ).all();
  res.json(users);
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function generateInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `DCUT-${seg()}-${seg()}-${seg().slice(0, 2)}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nDevCut backend running at http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
  console.log(`Public stats:    http://localhost:${PORT}/v1/public/stats\n`);
});
