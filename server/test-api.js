// Plain `node server/test-api.js` — no framework, no new deps.
// Boots the real app on a random port against a throwaway SQLite file.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync, createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const jwt = require("jsonwebtoken");

const DB_PATH = path.join(os.tmpdir(), `devcut-test-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_KEY = "test-admin-key";   // adminAuth fails closed without one
process.env.NODE_ENV = "test";
// Pin the impression-signing key so the test can mint its own tokens (expired,
// tampered, wrong-user, wrong-algorithm) instead of only the ones the server
// hands out. Must be set before ./auth loads, i.e. before requiring ./backend.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.RSA_PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");

const app = require("./backend");
const db = require("./db");
const { DWELL_WINDOW_MS } = require("./middleware");

let base;
// `ip` sets X-Forwarded-For. The app runs with `trust proxy: 1`, so each value
// gets its own rate-limit bucket — new test blocks can't starve each other (or
// the blocks above them) out of the 120/min /v1 and 10/min auth budgets.
const api = async (method, url, body, token, ip) => {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", "x-admin-key": "test-admin-key", ...(ip && { "X-Forwarded-For": ip }), ...(token && { Authorization: "Bearer " + token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const sponsor = (id, over = {}) => {
  const s = { name: id, text: id + " ad", url: "https://example.com/" + id, payout_paise: 25, bid_paise: 42, slot_type: "all", logo_url: null, target_stack: null, budget_paise_daily: null, budget_paise_total: null, ...over };
  db.prepare("INSERT INTO sponsors (id, name, text, url, payout_paise, bid_paise, slot_type, logo_url, target_stack, budget_paise_daily, budget_paise_total) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.name, s.text, s.url, s.payout_paise, s.bid_paise, s.slot_type, s.logo_url, s.target_stack, s.budget_paise_daily, s.budget_paise_total);
};

async function main() {
  db.exec("UPDATE sponsors SET active = 0"); // drop the seeded demo sponsors

  // ── auth: invite → register ────────────────────────────────────────────────
  db.prepare("INSERT INTO beta_invites (code, email, company) VALUES (?, ?, ?)").run("DCUT-TEST-CODE-01", "test@devcut.co.in", "Acme University");
  const reg = await api("POST", "/v1/register", { inviteCode: "DCUT-TEST-CODE-01" });
  assert.strictEqual(reg.status, 200, "register failed: " + JSON.stringify(reg.body));
  const { token, userId } = reg.body;
  const mainUser = { token, userId };

  // Every mint now stamps an impressions row, and rateLimitSponsorLine puts a 25s
  // floor between mints. Tests draw far faster than any human client, so they walk
  // the user's rows back past the floor first; the floor itself gets its own block.
  const backdate = db.prepare("UPDATE impressions SET ts = ts - 60 WHERE user_id = ?");
  const line = async (u, qs = "", ip) => {
    backdate.run(u.userId);
    return api("GET", "/v1/sponsor-line" + qs, undefined, u.token, ip);
  };

  // ── POST /v1/me/profile persists, GET /v1/me exposes it ───────────────────
  const prof = await api("POST", "/v1/me/profile", { experienceLevel: "senior", primaryStack: "go", country: "India" }, token);
  assert.deepStrictEqual(prof.body, { ok: true });
  assert.strictEqual((await api("POST", "/v1/me/profile", { primaryStack: "cobol" }, token)).status, 400, "bad enum must 400");

  const me = await api("GET", "/v1/me", undefined, token);
  assert.strictEqual(me.body.user.experience_level, "senior");
  assert.strictEqual(me.body.user.primary_stack, "go");
  assert.strictEqual(me.body.user.country, "India");
  assert.strictEqual(me.body.user.company, "Acme University", "company must carry over from invite to user at registration");
  assert.ok(me.body.user.profile_done_at > 0, "profile_done_at not set");

  // ── sponsor-line: slot filtering beats bid ────────────────────────────────
  sponsor("sponsor-idle", { slot_type: "idle", bid_paise: 10, logo_url: "https://cdn.example.com/i.png" });
  sponsor("sponsor-build", { slot_type: "build", bid_paise: 100 });

  const idleLine = await line(mainUser, "?idle=1");
  assert.strictEqual(idleLine.body.id, "sponsor-idle", "idle=1 must prefer the idle slot over the higher bid");
  assert.strictEqual(idleLine.body.logoUrl, "https://cdn.example.com/i.png");

  const buildLine = await line(mainUser, "?taskType=npm");
  assert.strictEqual(buildLine.body.id, "sponsor-build", "an active tracked task must pick the build-slot sponsor");
  assert.strictEqual(buildLine.body.logoUrl, null);

  // stack targeting outranks bid, and NULL slot_type still counts as 'all'
  sponsor("sponsor-go", { slot_type: null, bid_paise: 5, target_stack: "go,rust" });
  const goLine = await line(mainUser, "?taskType=npm");
  assert.strictEqual(goLine.body.id, "sponsor-go", "target_stack match must win over a higher bid");
  db.prepare("UPDATE sponsors SET active = 0 WHERE id = ?").run("sponsor-go");

  // ── /v1/me/analytics ──────────────────────────────────────────────────────
  const ins = db.prepare("INSERT INTO impressions (user_id, sponsor_id, task_type, payout_paise, bid_paise, ts) VALUES (?,?,?,?,?,unixepoch())");
  ins.run(userId, "sponsor-idle", "npm", 25, 42);
  ins.run(userId, "sponsor-build", "gradle", 60, 100);
  db.prepare("INSERT INTO clicks (user_id, sponsor_id) VALUES (?,?)").run(userId, "sponsor-idle");

  const an = (await api("GET", "/v1/me/analytics", undefined, token)).body;
  for (const k of ["totalPaise", "impressionCount", "clickCount", "availablePaise", "withdrawnPaise",
                   "daily", "byTaskType", "bySponsor", "firstEarnedAt", "rank"]) {
    assert.ok(k in an, "analytics missing key: " + k);
  }
  assert.strictEqual(an.totalPaise, 85);
  assert.strictEqual(an.impressionCount, 2);
  assert.strictEqual(an.clickCount, 1);
  assert.strictEqual(an.availablePaise, 85);
  assert.strictEqual(an.daily.length, 1);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(an.daily[0].day), "daily.day must be a YYYY-MM-DD from date(ts,'unixepoch')");
  assert.strictEqual(an.daily[0].impressions, 2);
  assert.deepStrictEqual(an.byTaskType.map(r => r.task_type).sort(), ["gradle", "npm"]);
  assert.strictEqual(an.bySponsor.length, 2);
  assert.ok(an.firstEarnedAt > 0);
  assert.deepStrictEqual(an.rank, { position: 1, outOf: 1 });

  // ── admin: inquiry update + convert creates a sponsor ──────────────────────
  db.prepare(`INSERT INTO advertiser_inquiries (company, contact_name, email, ad_text, destination_url, budget_range, slot_type)
              VALUES (?,?,?,?,?,?,?)`)
    .run("Acme", "Jane", "jane@acme.io", "Acme — ship faster", "https://acme.io", "5000-20000", "test");
  const inqId = db.prepare("SELECT id FROM advertiser_inquiries ORDER BY id DESC LIMIT 1").get().id;

  assert.deepStrictEqual((await api("PUT", `/api/advertiser-inquiries/${inqId}`, { status: "contacted", notes: "called" })).body, { ok: true });
  assert.strictEqual(db.prepare("SELECT status FROM advertiser_inquiries WHERE id=?").get(inqId).status, "contacted");
  assert.strictEqual((await api("PUT", `/api/advertiser-inquiries/${inqId}`, { status: "bogus" })).status, 400);

  const conv = await api("POST", `/api/advertiser-inquiries/${inqId}/convert`);
  assert.strictEqual(conv.status, 200, JSON.stringify(conv.body));
  const made = db.prepare("SELECT * FROM sponsors WHERE id = ?").get(conv.body.sponsorId);
  assert.ok(made, "convert did not create a sponsor row");
  assert.strictEqual(made.name, "Acme");
  assert.strictEqual(made.url, "https://acme.io");
  assert.strictEqual(made.slot_type, "test");
  assert.strictEqual(made.payout_paise, Math.round(made.bid_paise * 0.6));
  assert.strictEqual(db.prepare("SELECT status FROM advertiser_inquiries WHERE id=?").get(inqId).status, "won");

  // ── admin sponsors CRUD round-trips the new columns ───────────────────────
  const created = await api("POST", "/api/sponsors", {
    name: "Logo Co", text: "Logo Co — hi", url: "https://logo.co",
    logo_url: "https://logo.co/l.png", slot_type: "install", target_stack: "node,python",
  });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  const listed = (await api("GET", "/api/sponsors")).body.find(s => s.id === created.body.id);
  assert.strictEqual(listed.logo_url, "https://logo.co/l.png");
  assert.strictEqual(listed.slot_type, "install");
  assert.strictEqual(listed.target_stack, "node,python");
  assert.strictEqual((await api("POST", "/api/sponsors", { name: "x", text: "x", url: "https://x.co", logo_url: "not-a-url" })).status, 400,
    "logo_url must be validated as a URL");

  await api("PUT", `/api/sponsors/${created.body.id}`, {
    name: "Logo Co", text: "Logo Co — hi", url: "https://logo.co", active: true,
    logo_url: "https://logo.co/l2.png", slot_type: "idle", target_stack: "rust",
  });
  const updated = db.prepare("SELECT * FROM sponsors WHERE id=?").get(created.body.id);
  assert.strictEqual(updated.logo_url, "https://logo.co/l2.png");
  assert.strictEqual(updated.slot_type, "idle");
  assert.strictEqual(updated.target_stack, "rust");

  // ── /api/overview keeps every existing field ──────────────────────────────
  const ov = (await api("GET", "/api/overview")).body;
  for (const k of ["totalImpressions", "totalClicks", "uniqueUsers", "activeSponsors", "totalUsers",
                   "totalPaidRupees", "pendingWithdrawals", "taskTypeBreakdown", "activeDevsToday", "recent"]) {
    assert.ok(k in ov, "overview lost key: " + k);
  }

  // ── /v1/public/stats: new keys, zero PII ──────────────────────────────────
  const statsRes = await fetch(base + "/v1/public/stats");
  const stats = await statsRes.json();
  for (const k of ["totalImpressions", "totalPaidRupees", "activeDevsToday", "totalDevs", "totalSignups", "topTaskTypes",
                   "totalClicks", "avgPerActiveDevRupees", "paidLast7dRupees", "dailyImpressions", "lastUpdated"]) {
    assert.ok(k in stats, "public stats missing key: " + k);
  }
  assert.strictEqual(stats.totalClicks, 1);
  assert.strictEqual(stats.paidLast7dRupees, "0.85");
  assert.strictEqual(stats.avgPerActiveDevRupees, "0.85");
  assert.strictEqual(stats.dailyImpressions.length, 1);
  // totalPaidRupees is real withdrawal payouts, not accrued earnings — 0 until a
  // withdrawal is actually completed, even though 0.85 has been earned above.
  assert.strictEqual(stats.totalPaidRupees, "0.00", "totalPaidRupees must not count unwithdrawn earnings");
  const raw = JSON.stringify(stats);
  assert.ok(!/email|user_id|@/i.test(raw), "public stats leaked PII: " + raw);
  assert.ok(!raw.includes(userId), "public stats leaked a user id");

  // ── totalPaidRupees tracks completed withdrawals, not accrued earnings ─────
  db.prepare("INSERT INTO withdrawals (user_id, amount_paise, upi_id, status) VALUES (?, ?, ?, 'completed')")
    .run(userId, 5000, "test@upi");
  const statsAfterPayout = await (await fetch(base + "/v1/public/stats")).json();
  assert.strictEqual(statsAfterPayout.totalPaidRupees, "50.00", "public stats must reflect completed withdrawals");
  const ovAfterPayout = (await api("GET", "/api/overview")).body;
  assert.strictEqual(ovAfterPayout.totalPaidRupees, "50.00", "admin overview must reflect completed withdrawals");

  // ── mandatory company/university name ─────────────────────────────────────
  assert.strictEqual(
    (await api("POST", "/v1/public/signup", { name: "No Co", email: "noco@example.com", role: "developer" })).status,
    400, "company must be required on public signup"
  );

  // A user whose invite never had a company set → sponsor-line stays null even
  // though eligible sponsors are active (company is mandatory to earn).
  db.prepare("INSERT INTO beta_invites (code, email) VALUES (?, ?)").run("DCUT-TEST-CODE-02", "test2@devcut.co.in");
  const reg2 = await api("POST", "/v1/register", { inviteCode: "DCUT-TEST-CODE-02" });
  assert.strictEqual(reg2.status, 200, "second register failed: " + JSON.stringify(reg2.body));
  const noCompanyLine = await api("GET", "/v1/sponsor-line", undefined, reg2.body.token);
  assert.strictEqual(noCompanyLine.body, null, "sponsor-line must be null when company is unset");

  // ── total (lifetime) budget cap ─────────────────────────────────────────────
  db.exec("UPDATE sponsors SET active = 0"); // isolate from earlier test sponsors
  sponsor("sponsor-capped", { bid_paise: 42, budget_paise_total: 50 });
  ins.run(userId, "sponsor-capped", null, 30, 50); // lifetime bid-spend already at the cap
  const cappedLine = await line(mainUser);
  assert.strictEqual(cappedLine.body, null, "sponsor must drop out once lifetime budget is spent");

  const overview = (await api("GET", "/api/sponsors")).body.find(s => s.id === "sponsor-capped");
  assert.strictEqual(overview.total_spend_paise, 50, "admin listing must report total_spend_paise");

  // ── bid-weighted selection: variety across draws, not always the top bidder ─
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-w1", { bid_paise: 10 });
  sponsor("sponsor-w2", { bid_paise: 50 });
  sponsor("sponsor-w3", { bid_paise: 100 });
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const draw = await line(mainUser);
    seen.add(draw.body.id);
  }
  assert.ok(seen.size > 1, "weighted selection should surface more than one sponsor across draws, got: " + [...seen]);

  // ── impression tokens: required, single-use, budget-enforced at mint time ──
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-tok", { bid_paise: 42, budget_paise_total: 60 }); // room for exactly one bid

  // idle pays less: same sponsor, idle=1 → half payout in both display and token
  const idleHalf = await line(mainUser, "?idle=1");
  assert.strictEqual(idleHalf.body.payoutPaise, 13, "idle impressions must pay round(25 * 0.5)");

  // Re-drawing moves the one reservation rather than adding a second, so this
  // sponsor's 60p cap still has room for it even though idleHalf reserved 42p.
  const tokLine = await line(mainUser);
  assert.ok(tokLine.body.impressionToken, "a re-roll must still mint — the previous reservation releases its hold");

  assert.strictEqual((await api("POST", "/v1/impressions", { taskType: "npm" }, token)).status, 400, "impression without token must 400");
  assert.strictEqual((await api("POST", "/v1/impressions", { token: "garbage" }, token)).body.error, "invalid_impression_token");

  const imp1 = await api("POST", "/v1/impressions", { token: tokLine.body.impressionToken, taskType: "npm" }, token);
  assert.strictEqual(imp1.status, 200, "tokened impression must credit: " + JSON.stringify(imp1.body));

  const dup = await api("POST", "/v1/impressions", { token: tokLine.body.impressionToken }, token);
  assert.strictEqual(dup.status, 409, "same token twice must 409");
  assert.strictEqual(dup.body.error, "duplicate_impression");

  // Budget stop: 42 of 60 is spent, so a second 42p bid cannot be *reserved* at all.
  // It used to be sold and then refused at redemption; refusing to mint is strictly
  // better — the client never displays a line nobody can be paid for.
  const tokLine2 = await line(mainUser);
  assert.strictEqual(tokLine2.body, null, "a sponsor with no room for another bid must not mint: " + JSON.stringify(tokLine2.body));
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM impressions WHERE sponsor_id = 'sponsor-tok' AND state != 'void'").get().n, 1,
    "an over-budget draw must leave no reservation behind");

  // ── UPI hygiene: format check + 24h withdrawal lock after a change ─────────
  assert.strictEqual((await api("PUT", "/v1/profile/upi", { upiId: "bad upi!" }, token)).status, 400, "junk UPI must 400");
  assert.deepStrictEqual((await api("PUT", "/v1/profile/upi", { upiId: "dev@upi" }, token)).body, { ok: true });
  const wd = await api("POST", "/v1/withdraw", undefined, token);
  assert.strictEqual(wd.status, 400);
  assert.strictEqual(wd.body.error, "upi_recently_changed", "fresh UPI must block withdrawal: " + JSON.stringify(wd.body));

  // ── sessions: login mints a distinct token; list/revoke are per-session ────
  const loginA = await api("POST", "/v1/login", { inviteCode: "DCUT-TEST-CODE-01" });
  assert.strictEqual(loginA.status, 200, "login failed: " + JSON.stringify(loginA.body));
  assert.ok(loginA.body.token && loginA.body.token !== token, "login must mint a distinct session token");

  const loginB = await api("POST", "/v1/login", { inviteCode: "DCUT-TEST-CODE-01" });
  assert.ok(loginB.body.token && loginB.body.token !== loginA.body.token, "each login must mint its own session token");

  const sessionsA = await api("GET", "/v1/me/sessions", undefined, loginA.body.token);
  const sessionA = sessionsA.body.find(s => s.current);
  assert.ok(sessionA, "sessions list must mark the presenting session as current");
  assert.ok(!("token_hash" in sessionA), "sessions list must never leak token_hash");

  const sessionsB = await api("GET", "/v1/me/sessions", undefined, loginB.body.token);
  assert.ok(sessionsB.body.length >= 3, "sessions list must include every live session for the user");

  // Cross-session revoke ("lost my laptop"): B revokes A's session by id.
  assert.deepStrictEqual((await api("DELETE", `/v1/me/sessions/${sessionA.id}`, undefined, loginB.body.token)).body, { ok: true });
  assert.strictEqual((await api("GET", "/v1/me", undefined, loginA.body.token)).status, 401, "session revoked via /v1/me/sessions/:id must be rejected");
  assert.strictEqual((await api("GET", "/v1/me", undefined, loginB.body.token)).status, 200, "revoking one session must not affect its siblings");
  assert.strictEqual((await api("DELETE", `/v1/me/sessions/${sessionA.id}`, undefined, loginB.body.token)).status, 404, "revoking an already-revoked session must 404");

  // Self-revoke via logout affects only the presented session.
  assert.deepStrictEqual((await api("DELETE", "/v1/logout", undefined, loginB.body.token)).body, { ok: true });
  assert.strictEqual((await api("GET", "/v1/me", undefined, loginB.body.token)).status, 401, "logged-out session must be rejected");
  assert.strictEqual((await api("GET", "/v1/me", undefined, token)).status, 200, "unrelated sessions must survive another session's logout");

  // ════════════════════════════════════════════════════════════════════════════
  // Edge cases around the permanent-session rewrite, ownership and money.
  // Each block runs on its own X-Forwarded-For (see api()) and, where it needs a
  // clean auction, on its own sponsor.
  // ════════════════════════════════════════════════════════════════════════════
  const IP = { hdr: "10.9.0.1", sess: "10.9.0.2", forge: "10.9.0.3", pin: "10.9.0.4",
               caps: "10.9.0.5", money: "10.9.0.6", life: "10.9.0.7", invite: "10.9.0.8",
               signup: "10.9.0.9", drift: "10.9.0.10", click: "10.9.0.11" };

  let inviteSeq = 0;
  const newUser = async (ip) => {
    const code = `DCUT-GEN-${String(++inviteSeq).padStart(4, "0")}-AA`;
    db.prepare("INSERT INTO beta_invites (code, email, company) VALUES (?, ?, ?)")
      .run(code, `gen${inviteSeq}@devcut.co.in`, "Acme University");
    const r = await api("POST", "/v1/register", { inviteCode: code }, undefined, ip);
    assert.strictEqual(r.status, 200, `setup: register ${code} failed: ` + JSON.stringify(r.body));
    return { code, token: r.body.token, userId: r.body.userId };
  };
  const rawGet = async (url, headers, ip) => {
    const res = await fetch(base + url, { headers: { ...headers, "X-Forwarded-For": ip } });
    return { status: res.status, body: await res.json() };
  };
  const sha256 = (s) => createHash("sha256").update(s).digest("hex");
  // Credited impressions. A row exists from the mint onward, so this deliberately
  // counts what was actually earned (billable = 1), not what was reserved.
  const impressionCount = (uid) => db.prepare("SELECT COUNT(*) AS n FROM impressions WHERE user_id = ? AND billable = 1").get(uid).n;

  // ── requireAuth: every rejection shape, on real routes ────────────────────
  // requireAuth is the only thing in front of every money route, and a wrong
  // answer here is either a lockout or a hole. Pin all three shapes.
  const hdrUser = await newUser(IP.hdr);
  for (const [label, header] of [
    ["no Authorization header", null],
    ["scheme with no token", "Bearer"],
    ["non-Bearer scheme", "Basic " + hdrUser.token],
    ["lowercase scheme", "bearer " + hdrUser.token],
  ]) {
    const r = await rawGet("/v1/me", header ? { Authorization: header } : {}, IP.hdr);
    assert.strictEqual(r.status, 401, `${label} must 401, got ${r.status}`);
    assert.strictEqual(r.body.error, "missing_token", `${label} must report missing_token, got ${r.body.error}`);
  }
  const unknownTok = await rawGet("/v1/me", { Authorization: "Bearer " + "a".repeat(64) }, IP.hdr);
  assert.strictEqual(unknownTok.status, 401, "a well-formed but unknown token must 401");
  assert.strictEqual(unknownTok.body.error, "invalid_token", "an unknown token must report invalid_token, not missing_token");

  // A suspended account keeps its session rows, so the status check is the only
  // thing stopping a fraud-suspended dev from earning on with the token already
  // on their laptop.
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(hdrUser.userId);
  for (const [method, url] of [["GET", "/v1/me"], ["GET", "/v1/sponsor-line"], ["POST", "/v1/withdraw"], ["GET", "/v1/me/sessions"]]) {
    const r = await api(method, url, undefined, hdrUser.token, IP.hdr);
    assert.strictEqual(r.status, 403, `${method} ${url} must 403 for a suspended account, got ${r.status}`);
    assert.strictEqual(r.body.error, "account_revoked", `${method} ${url} must report account_revoked when suspended`);
  }
  const suspLogin = await api("POST", "/v1/login", { inviteCode: hdrUser.code }, undefined, IP.hdr);
  assert.strictEqual(suspLogin.status, 403, "a suspended account must not be able to mint a fresh session by logging in");
  assert.strictEqual(suspLogin.body.error, "account_revoked", "suspended login must report account_revoked");

  // ── session ownership: no cross-tenant revoke, no token material on the wire ─
  const owner = await newUser(IP.sess);
  const other = await newUser(IP.sess);
  const ownerSessions = (await api("GET", "/v1/me/sessions", undefined, owner.token, IP.sess)).body;
  assert.strictEqual(ownerSessions.length, 1, "a freshly registered user must have exactly one live session");
  const ownerSid = ownerSessions[0].id;

  // IDOR: knowing someone else's session id must not let you log them out.
  assert.strictEqual((await api("DELETE", `/v1/me/sessions/${ownerSid}`, undefined, other.token, IP.sess)).status, 404,
    "revoking another user's session id must 404, not succeed");
  assert.strictEqual(db.prepare("SELECT revoked_at FROM sessions WHERE id = ?").get(ownerSid).revoked_at, null,
    "a cross-user revoke attempt must not touch the row at all");
  assert.strictEqual((await api("GET", "/v1/me", undefined, owner.token, IP.sess)).status, 200,
    "the victim's session must still work after a cross-user revoke attempt");
  assert.strictEqual((await api("DELETE", "/v1/me/sessions/00000000-0000-0000-0000-000000000000", undefined, owner.token, IP.sess)).status, 404,
    "revoking a nonexistent session id must 404");

  // Revoking your own current session is a logout by id — the token dies with it.
  assert.deepStrictEqual((await api("DELETE", `/v1/me/sessions/${ownerSid}`, undefined, owner.token, IP.sess)).body, { ok: true });
  assert.strictEqual((await api("GET", "/v1/me", undefined, owner.token, IP.sess)).status, 401,
    "revoking your own current session must kill the token that presented it");

  // A revoked session must drop off the list, or "log out my other laptop" looks broken.
  const other2 = await api("POST", "/v1/login", { inviteCode: other.code }, undefined, IP.sess);
  assert.strictEqual(other2.status, 200, "second login failed: " + JSON.stringify(other2.body));
  const twoSessions = (await api("GET", "/v1/me/sessions", undefined, other.token, IP.sess)).body;
  assert.strictEqual(twoSessions.length, 2, "a second login must appear as a second live session");
  assert.strictEqual(twoSessions.filter(s => s.current).length, 1, "exactly one session may be flagged current");
  const siblingSid = twoSessions.find(s => !s.current).id;
  assert.deepStrictEqual((await api("DELETE", `/v1/me/sessions/${siblingSid}`, undefined, other.token, IP.sess)).body, { ok: true });
  const oneSession = (await api("GET", "/v1/me/sessions", undefined, other.token, IP.sess)).body;
  assert.ok(!oneSession.some(s => s.id === siblingSid), "a revoked session must disappear from /v1/me/sessions");
  assert.strictEqual((await api("GET", "/v1/me", undefined, other2.body.token, IP.sess)).status, 401,
    "the revoked sibling's token must stop working");

  // The list is the only route that reads the sessions table back out — nothing
  // token-shaped may ride along with it.
  const listedJson = JSON.stringify(oneSession);
  assert.ok(!listedJson.includes(other.token), "sessions list leaked the raw session token: " + listedJson);
  assert.ok(!listedJson.includes(sha256(other.token)), "sessions list leaked token_hash: " + listedJson);
  assert.ok(oneSession.every(s => Object.keys(s).sort().join(",") === "created_at,current,id"),
    "sessions list must expose exactly {id, created_at, current}: " + listedJson);
  assert.strictEqual(db.prepare("SELECT token_hash FROM sessions WHERE id = ?").get(oneSession[0].id).token_hash, sha256(other.token),
    "sessions.token_hash must be the sha256 of the raw token");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?").get(other.token).n, 0,
    "the raw session token must never be stored, only its hash");

  // ── impression tokens: forgery and cross-user replay ──────────────────────
  // The token is the entire authorisation for a payout, so every way of faking
  // one has to bounce off verifyImpressionToken before it reaches the ledger.
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-forge", { payout_paise: 30, bid_paise: 50 });
  const forgeA = await newUser(IP.forge);
  const forgeB = await newUser(IP.forge);
  const mint = (sub, over = {}, opts = {}) => jwt.sign(
    { spn: "sponsor-forge", pay: 30, bid: 50, jti: randomUUID(), ...over },
    keys.privateKey,
    { algorithm: "RS256", subject: sub, expiresIn: "90s", issuer: "kickback-status", audience: "impression", ...opts },
  );

  const valid = mint(forgeA.userId);
  const [vHead, vPayload, vSig] = valid.split(".");
  const bumped = { ...JSON.parse(Buffer.from(vPayload, "base64url").toString()), pay: 999999 };
  const expiredAt = Math.floor(Date.now() / 1000) - 200;   // minted 200s ago, 90s window

  for (const [label, tok] of [
    ["expired beyond the 90s window", jwt.sign(
      { spn: "sponsor-forge", pay: 30, bid: 50, jti: randomUUID(), iat: expiredAt, exp: expiredAt + 90 },
      keys.privateKey, { algorithm: "RS256", subject: forgeA.userId, issuer: "kickback-status", audience: "impression" })],
    ["payout claim rewritten, signature kept", [vHead, Buffer.from(JSON.stringify(bumped)).toString("base64url"), vSig].join(".")],
    ["alg=none", jwt.sign({ spn: "sponsor-forge", pay: 999999, bid: 50, jti: randomUUID() }, null,
      { algorithm: "none", subject: forgeA.userId, expiresIn: "90s", issuer: "kickback-status", audience: "impression" })],
    ["alg confusion: HS256 keyed with the public key", jwt.sign(
      { spn: "sponsor-forge", pay: 999999, bid: 50, jti: randomUUID() },
      keys.publicKey.export({ type: "spki", format: "pem" }),
      { algorithm: "HS256", subject: forgeA.userId, expiresIn: "90s", issuer: "kickback-status", audience: "impression" })],
    ["wrong issuer", mint(forgeA.userId, {}, { issuer: "not-kickback" })],
    ["wrong audience", mint(forgeA.userId, {}, { audience: "session" })],
  ]) {
    const r = await api("POST", "/v1/impressions", { token: tok }, forgeA.token, IP.forge);
    assert.strictEqual(r.status, 400, `impression token "${label}" must be refused, got ${r.status}`);
    assert.strictEqual(r.body.error, "invalid_impression_token", `impression token "${label}" must report invalid_impression_token`);
  }
  assert.strictEqual(impressionCount(forgeA.userId), 0, "no forged impression token may create a row");

  // A's token in B's hands: the payout follows the token's subject, not the caller.
  const stolen = await api("POST", "/v1/impressions", { token: mint(forgeA.userId) }, forgeB.token, IP.forge);
  assert.strictEqual(stolen.status, 403, "an impression token minted for another user must 403, got " + stolen.status);
  assert.strictEqual(stolen.body.error, "token_user_mismatch", "a cross-user impression token must report token_user_mismatch");
  assert.strictEqual(impressionCount(forgeB.userId), 0, "a cross-user token must not credit the presenter either");
  assert.strictEqual(impressionCount(forgeA.userId), 0, "a cross-user token must not credit its subject either");

  // ── what gets credited is what the server pinned, never what the client sent ─
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-pin", { payout_paise: 25, bid_paise: 42 });
  const pinUser = await newUser(IP.pin);
  const pinLine = await line(pinUser, "?idle=1", IP.pin);
  assert.strictEqual(pinLine.body.payoutPaise, 13, "idle slot must be served at half payout");
  const credited = await api("POST", "/v1/impressions",
    { token: pinLine.body.impressionToken, taskType: "npm", payoutPaise: 999999, payout_paise: 999999, bid_paise: 999999 },
    pinUser.token, IP.pin);
  assert.strictEqual(credited.status, 200, "pinned impression must credit: " + JSON.stringify(credited.body));
  const pinRow = db.prepare("SELECT payout_paise, bid_paise, jti FROM impressions WHERE user_id = ?").get(pinUser.userId);
  assert.strictEqual(pinRow.payout_paise, 13, "credited payout must come from the token, not from extra body fields");
  assert.strictEqual(pinRow.bid_paise, 42, "credited bid must come from the token, not from extra body fields");
  assert.strictEqual((await api("GET", "/v1/earnings", undefined, pinUser.token, IP.pin)).body.totalPaise, 13,
    "earnings must total the server-pinned payout");

  // Single-use jti has to be a DB constraint: the SELECT above the insert races.
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_impressions_jti'").get(),
    "idx_impressions_jti is missing — a replayed impression token would only be caught by a racy SELECT");
  assert.throws(
    () => db.prepare("INSERT INTO impressions (user_id, sponsor_id, payout_paise, bid_paise, jti) VALUES (?,?,?,?,?)")
            .run(pinUser.userId, "sponsor-pin", 13, 42, pinRow.jti),
    /UNIQUE/, "a duplicate jti must be rejected by the unique index, not just by the app-level check");

  // Advertiser pauses the campaign while a token is in flight → no credit, no 500.
  const pausedLine = await line(pinUser, "", IP.pin);
  db.prepare("UPDATE sponsors SET active = 0 WHERE id = ?").run("sponsor-pin");
  const paused = await api("POST", "/v1/impressions", { token: pausedLine.body.impressionToken }, pinUser.token, IP.pin);
  assert.strictEqual(paused.status, 400, "an impression for a paused sponsor must 400, got " + paused.status);
  assert.strictEqual(paused.body.error, "unknown_sponsor", "a paused sponsor must report unknown_sponsor");

  // Daily budget is enforced at spend time too, not only the lifetime cap.
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-daily", { bid_paise: 42, budget_paise_daily: 50 }); // room for exactly one bid today
  const dayUser = await newUser(IP.pin);
  const day1 = await line(dayUser, "", IP.pin);
  assert.strictEqual((await api("POST", "/v1/impressions", { token: day1.body.impressionToken }, dayUser.token, IP.pin)).status, 200,
    "first impression inside the daily budget must credit");
  const day2 = await line(dayUser, "", IP.pin);
  assert.strictEqual(day2.body, null, "a second bid past the daily budget must not mint: " + JSON.stringify(day2.body));
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM impressions WHERE sponsor_id = 'sponsor-daily' AND state != 'void'").get().n, 1,
    "a daily-budget-rejected draw must leave no reservation behind");

  // ── per-user impression caps: the anti-spam controls on payouts ───────────
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-cap", { payout_paise: 25, bid_paise: 42 });
  const capUser = await newUser(IP.caps);
  const cap1 = await api("GET", "/v1/sponsor-line", undefined, capUser.token, IP.caps); // fresh user: no floor yet
  assert.strictEqual((await api("POST", "/v1/impressions", { token: cap1.body.impressionToken }, capUser.token, IP.caps)).status, 200,
    "first impression must credit");
  // The 25s floor sits on the mint now, not on redemption: asking for inventory is
  // what creates the row, so asking is what has to be paced. On POST it raced the
  // client's own 30s rotation with 5s to spare.
  const tooFast = await api("GET", "/v1/sponsor-line", undefined, capUser.token, IP.caps);
  assert.strictEqual(tooFast.status, 429, "a second mint inside the 25s floor must 429, got " + tooFast.status);
  assert.strictEqual(tooFast.body.error, "too_fast", "mint spam must report too_fast");
  assert.strictEqual(impressionCount(capUser.userId), 1, "a too_fast mint must not be credited");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM impressions WHERE user_id = ?").get(capUser.userId).n, 1,
    "a refused mint must not leave a reservation behind either");

  // 500/day hard cap. Rows are backdated so the 25s floor doesn't answer first;
  // skipped in the opening minute of the UTC day, when "60s ago" is yesterday
  // and the daily counter genuinely wouldn't have filled.
  const clock = db.prepare("SELECT unixepoch() AS now, unixepoch('now', 'start of day') AS day_start").get();
  if (clock.now - 60 > clock.day_start) {
    backdate.run(capUser.userId); // the credited impression above is still "now"
    const capFill = db.prepare("INSERT INTO impressions (user_id, sponsor_id, payout_paise, bid_paise, ts) VALUES (?,?,?,?,unixepoch() - 60)");
    db.transaction(() => { for (let i = 0; i < 500; i++) capFill.run(capUser.userId, "sponsor-cap", 25, 0); })();
    const cap3 = await line(capUser, "", IP.caps);
    const capped = await api("POST", "/v1/impressions", { token: cap3.body.impressionToken }, capUser.token, IP.caps);
    assert.strictEqual(capped.status, 429, "the 501st impression of the day must 429, got " + capped.status);
    assert.strictEqual(capped.body.error, "rate_limit_exceeded", "the daily cap must report rate_limit_exceeded");
    db.prepare("DELETE FROM impressions WHERE user_id = ?").run(capUser.userId); // don't skew later aggregates

    // Rupee cap. The row cap alone bounds count, not money: a scripted caller can
    // re-roll /v1/sponsor-line until the top-paying sponsor comes up and redeem only
    // that one, so extraction would scale with the best advertiser's bid. 250 rows at
    // 60p is 15000p — under the 500-row cap, over the 12500p ceiling, so only the
    // rupee cap can answer here.
    const richUser = await newUser(IP.caps);
    const rich1 = await line(richUser, "", IP.caps);
    assert.strictEqual((await api("POST", "/v1/impressions", { token: rich1.body.impressionToken }, richUser.token, IP.caps)).status, 200,
      "first impression must credit before the rupee cap fills");
    const richFill = db.prepare("INSERT INTO impressions (user_id, sponsor_id, payout_paise, bid_paise, ts) VALUES (?,?,?,?,unixepoch() - 60)");
    db.transaction(() => { for (let i = 0; i < 250; i++) richFill.run(richUser.userId, "sponsor-cap", 60, 0); })();
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM impressions WHERE user_id = ?").get(richUser.userId).n < 500,
      "the rupee-cap fixture must stay under the row cap, or it proves nothing");
    const rich2 = await line(richUser, "", IP.caps);
    const richCapped = await api("POST", "/v1/impressions", { token: rich2.body.impressionToken }, richUser.token, IP.caps);
    assert.strictEqual(richCapped.status, 429, "past the daily rupee ceiling must 429, got " + richCapped.status);
    assert.strictEqual(richCapped.body.error, "daily_earnings_cap", "the rupee cap must report daily_earnings_cap");
    db.prepare("DELETE FROM impressions WHERE user_id = ?").run(richUser.userId);
  }

  // A sponsor created with no explicit budget must still stop at the default
  // ceiling — NULL used to mean unlimited, which made payout liability unbounded.
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-nobudget", { payout_paise: 25, bid_paise: 42 });
  db.prepare("UPDATE sponsors SET budget_paise_daily = NULL, budget_paise_total = NULL WHERE id = 'sponsor-nobudget'").run();
  const defUser = await newUser(IP.caps);
  const defLine = await line(defUser, "", IP.caps);
  assert.ok(defLine.body.impressionToken, "a budgetless sponsor must still serve below the default ceiling");
  // Spend the default ceiling on someone else's rows, then confirm it stops serving.
  const burn = db.prepare("INSERT INTO impressions (user_id, sponsor_id, payout_paise, bid_paise, ts) VALUES (?,?,?,?,unixepoch())");
  db.transaction(() => { for (let i = 0; i < 2500; i++) burn.run(defUser.userId, "sponsor-nobudget", 0, 42); })();
  const exhausted = await line(defUser, "", IP.caps);
  // No eligible sponsor answers with an empty body, not a line with no token.
  assert.ok(!exhausted.body || !exhausted.body.impressionToken,
    "a budgetless sponsor past the default daily ceiling must stop serving: " + JSON.stringify(exhausted.body));
  db.prepare("DELETE FROM impressions WHERE user_id = ?").run(defUser.userId);

  // ── clicks: CTR is advertiser-facing revenue data, not a vanity metric ────
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-click", { payout_paise: 25, bid_paise: 42 });
  const clickUser = await newUser(IP.click);

  // Forgery: sponsor ids leak via /v1/sponsor-line, so a click must not be
  // accepted from someone who was never served that line.
  const forged = await api("POST", "/v1/clicks", { lineId: "sponsor-click" }, clickUser.token, IP.click);
  assert.strictEqual(forged.status, 400, "a click with no matching impression must 400, got " + forged.status);
  assert.strictEqual(forged.body.error, "no_matching_impression", "forged clicks must report no_matching_impression");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE user_id = ?").get(clickUser.userId).n, 0,
    "a rejected click must not be inserted");

  // A sponsor that does not exist has no impression either — same rejection.
  const ghost = await api("POST", "/v1/clicks", { lineId: "sponsor-does-not-exist" }, clickUser.token, IP.click);
  assert.strictEqual(ghost.status, 400, "a click on an unknown sponsor must 400, got " + ghost.status);

  // Real path: serve and redeem an impression, then the click is legitimate.
  const clickLine = await line(clickUser, "", IP.click);
  assert.strictEqual((await api("POST", "/v1/impressions", { token: clickLine.body.impressionToken }, clickUser.token, IP.click)).status, 200,
    "the click fixture needs a credited impression");
  const realClick = await api("POST", "/v1/clicks", { lineId: "sponsor-click" }, clickUser.token, IP.click);
  assert.strictEqual(realClick.status, 200, "a click after a real impression must succeed: " + JSON.stringify(realClick.body));
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE user_id = ?").get(clickUser.userId).n, 1,
    "a legitimate click must be recorded exactly once");

  // Flood: one impression must not license unlimited clicks.
  const flood = await api("POST", "/v1/clicks", { lineId: "sponsor-click" }, clickUser.token, IP.click);
  assert.strictEqual(flood.status, 429, "a repeat click inside the dedup window must 429, got " + flood.status);
  assert.strictEqual(flood.body.error, "click_too_fast", "click flooding must report click_too_fast");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE user_id = ?").get(clickUser.userId).n, 1,
    "a flooded click must not be inserted");
  db.prepare("DELETE FROM impressions WHERE user_id = ?").run(clickUser.userId);
  db.prepare("DELETE FROM clicks WHERE user_id = ?").run(clickUser.userId);

  // ── withdrawals: the money controls ───────────────────────────────────────
  const wUser = await newUser(IP.money);
  const noUpi = await api("POST", "/v1/withdraw", undefined, wUser.token, IP.money);
  assert.strictEqual(noUpi.status, 400, "withdrawing with no UPI id set must 400");
  assert.strictEqual(noUpi.body.error, "upi_not_set", "a missing UPI id must report upi_not_set");

  ins.run(wUser.userId, "sponsor-cap", null, 4999, 0);   // one paise under the ₹50 floor
  assert.deepStrictEqual((await api("PUT", "/v1/profile/upi", { upiId: "w1@upi" }, wUser.token, IP.money)).body, { ok: true });
  const unlock = db.prepare("UPDATE users SET upi_updated_at = unixepoch() - ? WHERE id = ?");
  unlock.run(90000, wUser.userId);                       // past the 24h cool-off

  const under = await api("POST", "/v1/withdraw", undefined, wUser.token, IP.money);
  assert.strictEqual(under.status, 400, "a balance under the minimum must 400");
  assert.strictEqual(under.body.error, "insufficient_balance", "under-minimum must report insufficient_balance");
  assert.strictEqual(under.body.available, 4999, "insufficient_balance must echo the real balance");
  assert.strictEqual(under.body.minimum, 5000, "insufficient_balance must echo the ₹50 minimum");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ?").get(wUser.userId).n, 0,
    "a rejected withdrawal must not leave a row behind");

  ins.run(wUser.userId, "sponsor-cap", null, 1, 0);      // exactly at the ₹50 boundary
  const atMin = await api("POST", "/v1/withdraw", undefined, wUser.token, IP.money);
  assert.strictEqual(atMin.status, 200, "a balance exactly at the minimum must be withdrawable: " + JSON.stringify(atMin.body));
  assert.strictEqual(atMin.body.amountPaise, 5000, "a withdrawal must take the whole available balance, no more");

  // Kept earning while the payout is queued: still one payout at a time.
  ins.run(wUser.userId, "sponsor-cap", null, 5000, 0);
  const dupWd = await api("POST", "/v1/withdraw", undefined, wUser.token, IP.money);
  assert.strictEqual(dupWd.status, 400, "a second withdrawal while one is pending must 400");
  assert.strictEqual(dupWd.body.error, "withdrawal_pending", "a queued payout must report withdrawal_pending");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ?").get(wUser.userId).n, 1,
    "a refused withdrawal must not queue a second payout");

  // Settled — the next request pays out the newly earned money only, never the
  // ₹50 already sent.
  db.prepare("UPDATE withdrawals SET status = 'completed' WHERE user_id = ? AND status = 'pending'").run(wUser.userId);
  const again = await api("POST", "/v1/withdraw", undefined, wUser.token, IP.money);
  assert.strictEqual(again.status, 200, "money earned after a payout must be withdrawable: " + JSON.stringify(again.body));
  assert.strictEqual(again.body.amountPaise, 5000, "a settled withdrawal must not be payable a second time");
  assert.strictEqual(
    db.prepare("SELECT COALESCE(SUM(amount_paise), 0) AS n FROM withdrawals WHERE user_id = ? AND status IN ('pending','completed')").get(wUser.userId).n,
    db.prepare("SELECT COALESCE(SUM(payout_paise), 0) AS n FROM impressions WHERE user_id = ?").get(wUser.userId).n,
    "total claimed must never exceed total earned",
  );

  // The control that matters most: a UPI change re-arms the 24h lock, even for
  // an account that was withdrawing happily a moment ago (takeover → drain).
  db.prepare("UPDATE withdrawals SET status = 'completed' WHERE user_id = ? AND status = 'pending'").run(wUser.userId);
  ins.run(wUser.userId, "sponsor-cap", null, 6000, 0);
  assert.deepStrictEqual((await api("PUT", "/v1/profile/upi", { upiId: "attacker@upi" }, wUser.token, IP.money)).body, { ok: true });
  const locked = await api("POST", "/v1/withdraw", undefined, wUser.token, IP.money);
  assert.strictEqual(locked.status, 400, "a fresh UPI change must re-lock withdrawals");
  assert.strictEqual(locked.body.error, "upi_recently_changed", "a re-locked account must report upi_recently_changed");
  unlock.run(90000, wUser.userId);
  const unlocked = await api("POST", "/v1/withdraw", undefined, wUser.token, IP.money);
  assert.strictEqual(unlocked.status, 200, "the lock must actually lift after 24h: " + JSON.stringify(unlocked.body));
  assert.strictEqual(unlocked.body.amountPaise, 6000, "the unlocked withdrawal must be the new balance");
  assert.strictEqual(db.prepare("SELECT upi_id FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(wUser.userId).upi_id,
    "attacker@upi", "a withdrawal must be booked against the UPI id in force when it was requested");

  // Double-submit: two withdraw requests in flight at once must not pay twice.
  const w2 = await newUser(IP.money);
  ins.run(w2.userId, "sponsor-cap", null, 7000, 0);
  await api("PUT", "/v1/profile/upi", { upiId: "w2@upi" }, w2.token, IP.money);
  unlock.run(90000, w2.userId);
  const both = await Promise.all([
    api("POST", "/v1/withdraw", undefined, w2.token, IP.money),
    api("POST", "/v1/withdraw", undefined, w2.token, IP.money),
  ]);
  assert.strictEqual(both.filter(r => r.status === 200).length, 1, "exactly one concurrent withdrawal may succeed: " + JSON.stringify(both));
  const loser = both.find(r => r.status !== 200);
  assert.strictEqual(loser.status, 400, "the loser of a double-submit must be refused: " + JSON.stringify(loser));
  assert.ok(["insufficient_balance", "withdrawal_pending"].includes(loser.body.error),
    "the loser must be refused for a payout reason — the winner drains the balance, so the balance check answers before the " +
    "pending check — got: " + loser.body.error);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ?").get(w2.userId).n, 1,
    "a double-submit must leave exactly one withdrawal row");
  // ...and the DB is the backstop if two processes ever race past the check.
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_withdrawals_pending'").get(),
    "idx_withdrawals_pending is missing — concurrent withdrawals would only be caught by a racy SELECT");
  assert.throws(
    () => db.prepare("INSERT INTO withdrawals (user_id, amount_paise, upi_id) VALUES (?,?,?)").run(w2.userId, 100, "w2@upi"),
    /UNIQUE/, "a second pending withdrawal must be rejected by the partial unique index");

  // ── account deletion is final and total ───────────────────────────────────
  const gone = await newUser(IP.life);
  const goneSibling = await api("POST", "/v1/login", { inviteCode: gone.code }, undefined, IP.life);
  assert.strictEqual(goneSibling.status, 200, "second session failed: " + JSON.stringify(goneSibling.body));
  await api("PUT", "/v1/profile/upi", { upiId: "gone@upi" }, gone.token, IP.life);
  assert.deepStrictEqual((await api("DELETE", "/v1/me", undefined, gone.token, IP.life)).body, { ok: true });

  for (const [label, tok] of [["the deleting session", gone.token], ["a sibling session", goneSibling.body.token]]) {
    const r = await api("GET", "/v1/me", undefined, tok, IP.life);
    assert.strictEqual(r.status, 401, `${label} must be dead after account deletion, got ${r.status}`);
    assert.strictEqual(r.body.error, "invalid_token", `${label} must report invalid_token after deletion`);
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL").get(gone.userId).n, 0,
    "account deletion must leave no live session behind");
  const goneRow = db.prepare("SELECT status, email, upi_id, company FROM users WHERE id = ?").get(gone.userId);
  assert.strictEqual(goneRow.status, "deleted", "deletion must mark the account deleted");
  assert.strictEqual(goneRow.email, `deleted-${gone.userId}@deleted.invalid`, "deletion must anonymise the email");
  assert.strictEqual(goneRow.upi_id, null, "deletion must drop the UPI id");
  assert.strictEqual(goneRow.company, null, "deletion must drop the company");

  const reLogin = await api("POST", "/v1/login", { inviteCode: gone.code }, undefined, IP.life);
  assert.strictEqual(reLogin.status, 403, "a deleted account must not be able to log back in");
  assert.strictEqual(reLogin.body.error, "account_revoked", "login to a deleted account must report account_revoked");
  const reRegister = await api("POST", "/v1/register", { inviteCode: gone.code }, undefined, IP.life);
  assert.strictEqual(reRegister.status, 403, "a spent invite code must not re-register after deletion");
  assert.strictEqual(reRegister.body.error, "invalid_or_used_code", "re-register must report invalid_or_used_code");

  // ── invite codes are the login credential: reuse, casing, whitespace ───────
  const cased = await newUser(IP.invite);
  assert.strictEqual((await api("POST", "/v1/register", { inviteCode: cased.code }, undefined, IP.invite)).body.error,
    "invalid_or_used_code", "an already-redeemed invite code must not mint a second account");
  const loose = await api("POST", "/v1/login", { inviteCode: `  ${cased.code.toLowerCase()}  ` }, undefined, IP.invite);
  assert.strictEqual(loose.status, 200, "login must tolerate the casing/whitespace of a pasted code: " + JSON.stringify(loose.body));
  assert.strictEqual(loose.body.userId, cased.userId, "a normalised code must resolve to the same account");

  db.prepare("INSERT INTO beta_invites (code, email, company) VALUES (?, ?, ?)")
    .run("DCUT-NEVER-USED-01", "never@devcut.co.in", "Acme University");
  const neverUsed = await api("POST", "/v1/login", { inviteCode: "DCUT-NEVER-USED-01" }, undefined, IP.invite);
  assert.strictEqual(neverUsed.status, 403, "login with an unredeemed invite must 403 — register is the only way in");
  assert.strictEqual(neverUsed.body.error, "invalid_code", "an unredeemed code must report invalid_code");
  assert.strictEqual((await api("POST", "/v1/login", { inviteCode: "DCUT-NOPE-NOPE-XX" }, undefined, IP.invite)).body.error,
    "invalid_code", "login with an unknown code must report invalid_code");
  assert.strictEqual((await api("POST", "/v1/register", { inviteCode: "  dcut-never-used-01  " }, undefined, IP.invite)).status, 200,
    "register must accept a pasted code with stray case/whitespace");

  // ── signup dedupe: one invite code per human, however they type their email ─
  // The invite code IS the login credential, so a second code for the same
  // mailbox is a second way into (or a second copy of) the same account.
  const inviteRows = () => db.prepare("SELECT COUNT(*) AS n FROM beta_invites").get().n;
  const n0 = inviteRows();
  const sign1 = await api("POST", "/v1/public/signup", { name: "Dee Vee", email: "d.e.v+beta@Gmail.com", company: "Acme" }, undefined, IP.signup);
  assert.strictEqual(sign1.status, 200, "signup failed: " + JSON.stringify(sign1.body));
  assert.ok(!sign1.body.resent, "a first-time address must mint a new invite, not resend one");
  assert.strictEqual(inviteRows(), n0 + 1, "first signup must create exactly one invite");
  const sign2 = await api("POST", "/v1/public/signup", { name: "Dee Vee", email: "dev@gmail.com", company: "Acme" }, undefined, IP.signup);
  assert.strictEqual(sign2.body.resent, true, "gmail dots/+tags must fold onto the existing invite");
  assert.strictEqual(inviteRows(), n0 + 1, "a canonical-duplicate signup must not mint a second invite code");
  const sign3 = await api("POST", "/v1/public/signup", { name: "Someone", email: "someone.else@gmail.com", company: "Acme" }, undefined, IP.signup);
  assert.ok(!sign3.body.resent, "a genuinely different address must get its own invite");
  assert.strictEqual(inviteRows(), n0 + 2, "a distinct address must mint exactly one more invite");

  // ── regression: spend is billed at the price it was SOLD at ───────────────
  // The reservation records bid_paise at mint time, and the render-time re-check
  // sums those recorded bids. Re-pricing a campaign, or cutting its cap, must not
  // re-value spend that is already committed: if the check read the sponsor's
  // *current* 10p bid, 200p of sold inventory would look like 20p and reopen a cap
  // that is genuinely full.
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-drift", { payout_paise: 60, bid_paise: 100, budget_paise_total: 250 });
  const drift = await newUser(IP.drift);
  const drift1 = await line(drift, "", IP.drift);
  assert.strictEqual((await api("POST", "/v1/impressions", { token: drift1.body.impressionToken }, drift.token, IP.drift)).status, 200,
    "first 100p impression under the 250p cap must credit");
  const drift2 = await line(drift, "", IP.drift);   // a second line, still inside the cap
  assert.ok(drift2.body?.impressionToken, "a second 100p reservation must fit under the 250p cap");

  // Admin re-prices the campaign and cuts its cap while that line is in flight.
  db.prepare("UPDATE sponsors SET bid_paise = 10, budget_paise_total = 150 WHERE id = 'sponsor-drift'").run();
  const drifted2 = await api("POST", "/v1/impressions", { token: drift2.body.impressionToken }, drift.token, IP.drift);
  assert.strictEqual(drifted2.status, 410,
    "200p of committed spend against a 150p cap must be refused, not re-valued at the new 10p bid: " + JSON.stringify(drifted2.body));
  assert.strictEqual(drifted2.body.error, "budget_exhausted", "an over-cap render must report budget_exhausted");
  assert.strictEqual(db.prepare("SELECT state FROM impressions WHERE jti = ?").get(jwt.decode(drift2.body.impressionToken).jti).state, "void",
    "a reservation refused for budget must be voided, not left holding the cap until TTL");
  const drifted = db.prepare("SELECT COALESCE(SUM(bid_paise), 0) AS spend FROM impressions WHERE sponsor_id = 'sponsor-drift' AND state != 'void'").get().spend;
  assert.strictEqual(drifted, 100, "recorded spend must never exceed the lifetime budget, got " + drifted + "p");

  // ── email hygiene: undeliverable domains never mint an invite code ────────
  const IP_MAIL = "10.9.0.11";
  const disposable = await api("POST", "/v1/public/signup",
    { name: "Throw Away", email: "x@mailinator.com", company: "Acme" }, undefined, IP_MAIL);
  assert.strictEqual(disposable.status, 400, "a disposable domain must be refused: " + JSON.stringify(disposable.body));
  assert.strictEqual(disposable.body.error, "email_undeliverable", "a disposable domain must report email_undeliverable");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM beta_invites WHERE email LIKE '%@mailinator.com'").get().n, 0,
    "a refused signup must not leave an invite row behind");

  // A normal domain still gets through. The MX check fails open, so this holds
  // on a box with no DNS too — and the signup IP lands in beta_invites.ip.
  const realSignup = await api("POST", "/v1/public/signup",
    { name: "Real Dev", email: "realdev@gmail.com", company: "Acme" }, undefined, IP_MAIL);
  assert.strictEqual(realSignup.status, 200, "a deliverable domain must still sign up: " + JSON.stringify(realSignup.body));
  assert.ok(!("code" in realSignup.body), "signup must never echo the invite code — it is the login credential");
  assert.strictEqual(db.prepare("SELECT ip FROM beta_invites WHERE email = ?").get("realdev@gmail.com").ip, IP_MAIL,
    "signup must record req.ip");

  // ── advertiser-inquiry is rate limited: it fires two Resend emails per call ─
  // Raw fetch, not api(): express-rate-limit's 429 body is text, not JSON.
  const IP_ADV = "10.9.0.12";
  let advStatus = 0;
  for (let i = 0; i < 11; i++) {
    // Invalid body on purpose — the limiter runs first, so nothing is inserted or emailed.
    advStatus = (await fetch(base + "/v1/public/advertiser-inquiry", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": IP_ADV },
      body: "{}",
    })).status;
  }
  assert.strictEqual(advStatus, 429, "the 11th advertiser inquiry from one IP must hit authRateLimit, got " + advStatus);

  // ── funnel counters + /api/flags (the admin dashboard renders both) ────────
  const funnel = (await api("GET", "/api/overview")).body.funnel;
  assert.ok(funnel, "/api/overview must expose a funnel block");
  for (const k of ["downloads", "ext_pings", "signups", "activated", "earning", "stuck"]) {
    assert.ok(k in funnel, "funnel missing key: " + k);
  }
  assert.ok(Array.isArray(funnel.stuck), "funnel.stuck must be an array");
  assert.ok(funnel.signups > 0, "funnel.signups must count beta_invites");

  // The .vsix route counts and then hands off to express.static.
  await fetch(base + "/site/devcut-latest.vsix");
  // ?src=ext with no Authorization is the "installed but never signed in" ping.
  await fetch(base + "/v1/updates?src=ext", { headers: { "X-Forwarded-For": IP_MAIL } });
  const funnel2 = (await api("GET", "/api/overview")).body.funnel;
  assert.strictEqual(funnel2.downloads, funnel.downloads + 1, "a .vsix GET must bump vsix_download");
  assert.strictEqual(funnel2.ext_pings, funnel.ext_pings + 1, "an anonymous ?src=ext ping must bump ext_ping_anon");

  const flags = (await api("GET", "/api/flags")).body;
  for (const k of ["shared_ips", "signup_bursts", "cap_hitters"]) {
    assert.ok(Array.isArray(flags[k]), "/api/flags." + k + " must be an array, got " + JSON.stringify(flags[k]));
  }

  // ── admin auth fails closed ────────────────────────────────────────────────
  const noKey = await fetch(base + "/api/overview");
  assert.strictEqual(noKey.status, 401, "admin endpoint without x-admin-key must be rejected");

  // ══════════════════════════════════════════════════════════════════════════
  // The impression lifecycle: reserved -> rendered. An impression used to be a
  // single INSERT at credit time with no evidence the ad was ever on screen; it
  // is now a row born at the mint and promoted as evidence arrives.
  // ══════════════════════════════════════════════════════════════════════════
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-life", { payout_paise: 25, bid_paise: 42 });
  const IP_LIFE = "10.9.0.13";
  const lc = await newUser(IP_LIFE);
  const jtiOf = (tok) => jwt.decode(tok).jti;
  const rowFor = (tok) => db.prepare("SELECT * FROM impressions WHERE jti = ?").get(jtiOf(tok));
  const earnings = async (u, ip) => (await api("GET", "/v1/earnings", undefined, u.token, ip)).body;

  // ── the mint creates the row, and it is worth nothing yet ─────────────────
  const lc1 = await line(lc, "?taskType=npm", IP_LIFE);
  const reserved = rowFor(lc1.body.impressionToken);
  assert.ok(reserved, "a mint must create an impressions row keyed by the token's jti");
  assert.strictEqual(reserved.state, "reserved", "a minted row must start in state 'reserved'");
  assert.strictEqual(reserved.billable, 0, "a reservation must not be billable");
  assert.strictEqual(reserved.payout_paise, 25, "the reservation must pin the payout it was served at");
  assert.strictEqual(reserved.rendered_at, null, "nothing has rendered yet");
  assert.strictEqual((await earnings(lc, IP_LIFE)).totalPaise, 0, "a reservation must pay nothing until the ad renders");
  assert.strictEqual((await earnings(lc, IP_LIFE)).impressionCount, 0, "a reservation must not show up as an impression");

  // ── SINGLE OUTSTANDING RESERVATION ────────────────────────────────────────
  // Re-rolling the auction moves the reservation; it does not deal another
  // redeemable option. Mint N lines, redeem the best is the entire re-roll farm,
  // and it has to come out at one.
  const lc2 = await line(lc, "", IP_LIFE);
  assert.strictEqual(rowFor(lc1.body.impressionToken).state, "void", "a new mint must void the previous reservation");
  assert.strictEqual(rowFor(lc2.body.impressionToken).state, "reserved", "the newest mint must be the live reservation");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM impressions WHERE user_id = ? AND state = 'reserved'").get(lc.userId).n, 1,
    "a user may never hold more than one redeemable reservation, however often they re-roll");

  const voided = await api("POST", "/v1/impressions", { token: lc1.body.impressionToken }, lc.token, IP_LIFE);
  assert.strictEqual(voided.status, 409, "redeeming a re-rolled (voided) reservation must 409, got " + voided.status);
  assert.strictEqual(voided.body.error, "reservation_void", "a voided reservation must report reservation_void");
  assert.strictEqual((await earnings(lc, IP_LIFE)).totalPaise, 0, "a voided reservation must never pay");

  // ── budget accounting counts reservations, ignores voids ──────────────────
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM impressions WHERE sponsor_id = 'sponsor-life'").get().n, 2,
    "both mints must have left a row behind");
  assert.strictEqual((await api("GET", "/api/sponsors")).body.find(s => s.id === "sponsor-life").total_spend_paise, 42,
    "one live reservation holds one bid — the voided one must have released its hold");

  // ── reserved -> rendered is what makes it money ───────────────────────────
  const rendered = await api("POST", "/v1/impressions", { token: lc2.body.impressionToken, taskType: "npm" }, lc.token, IP_LIFE);
  assert.strictEqual(rendered.status, 200, "rendering the live reservation must credit: " + JSON.stringify(rendered.body));
  const live = rowFor(lc2.body.impressionToken);
  assert.strictEqual(live.state, "rendered", "a credited impression must be in state 'rendered'");
  assert.strictEqual(live.billable, 1, "a rendered impression must be billable");
  assert.ok(live.rendered_at > 0, "rendered_at must be stamped by the server, not the client");
  assert.strictEqual(live.settled_at, null, "settlement is a later phase — nothing may settle here");
  assert.strictEqual((await earnings(lc, IP_LIFE)).totalPaise, 25, "a rendered impression must pay exactly the pinned payout");

  const replay = await api("POST", "/v1/impressions", { token: lc2.body.impressionToken }, lc.token, IP_LIFE);
  assert.strictEqual(replay.status, 409, "replaying a rendered token must 409, got " + replay.status);
  assert.strictEqual(replay.body.error, "duplicate_impression", "replay must keep reporting duplicate_impression — clients in the wild branch on it");
  assert.strictEqual((await earnings(lc, IP_LIFE)).totalPaise, 25, "a replay must not pay twice");

  // A perfectly signed token with no reservation behind it credits nothing — the
  // row, not the signature, is now the thing being redeemed.
  const orphan = jwt.sign({ spn: "sponsor-life", pay: 25, bid: 42, jti: randomUUID() }, keys.privateKey,
    { algorithm: "RS256", subject: lc.userId, expiresIn: "90s", issuer: "kickback-status", audience: "impression" });
  const orphanRes = await api("POST", "/v1/impressions", { token: orphan }, lc.token, IP_LIFE);
  assert.strictEqual(orphanRes.status, 404, "a signed token with no reservation must 404, got " + orphanRes.status);
  assert.strictEqual(orphanRes.body.error, "unknown_reservation", "a missing reservation must report unknown_reservation");

  // ── dwell: lie about attention all you like, never about wall-clock ───────
  const dwell = (body, u = lc) => api("POST", "/v1/impressions/dwell", body, u.token, IP_LIFE);
  const lcTok = lc2.body.impressionToken;

  // Wind rendered_at back a known 5s, then claim eleven days of attention.
  db.prepare("UPDATE impressions SET rendered_at = rendered_at - 5 WHERE id = ?").run(live.id);
  const inflated = await dwell({ token: lcTok, visibleMs: 999_999_999, focusedMs: 999_999_999 });
  assert.strictEqual(inflated.status, 200, "dwell on a rendered impression must be accepted: " + JSON.stringify(inflated.body));
  assert.ok(inflated.body.visibleMs >= 5000 && inflated.body.visibleMs <= 6000,
    "an inflated visibleMs must clamp to the ~5s that really elapsed, got " + inflated.body.visibleMs);
  assert.strictEqual(inflated.body.focusedMs, inflated.body.visibleMs, "focusedMs must clamp against the same clock");
  assert.strictEqual(rowFor(lcTok).visible_ms, inflated.body.visibleMs, "what gets stored is the clamped value, not the claim");

  // The window is the other ceiling: an hour of genuine wall-clock still only
  // yields DWELL_WINDOW_MS. Nobody watches a status bar for two minutes.
  db.prepare("UPDATE impressions SET rendered_at = rendered_at - 3600 WHERE id = ?").run(live.id);
  const windowed = await dwell({ token: lcTok, visibleMs: 999_999_999, focusedMs: 999_999_999 });
  assert.strictEqual(windowed.body.visibleMs, DWELL_WINDOW_MS, "dwell must cap at DWELL_WINDOW_MS however long the row has existed");

  // Monotonic: a later, smaller report cannot walk the number back down.
  const shrunk = await dwell({ token: lcTok, visibleMs: 1, focusedMs: -50_000 });
  assert.strictEqual(shrunk.body.visibleMs, DWELL_WINDOW_MS, "dwell must never decrease");
  assert.strictEqual(shrunk.body.focusedMs, DWELL_WINDOW_MS, "a negative report must clamp to 0 and then lose to the stored max");
  assert.strictEqual(rowFor(lcTok).visible_ms, DWELL_WINDOW_MS, "the stored dwell must be the running max");
  assert.strictEqual((await dwell({ token: lcTok, visibleMs: "lots", focusedMs: 0 })).status, 400, "a non-numeric dwell must 400");
  assert.strictEqual((await dwell({ token: lcTok, visibleMs: 10 })).status, 400, "a dwell report missing focusedMs must 400");

  // Dwell measures; it does not promote. Deciding what counts as seen belongs to
  // the settlement sweeper, which is a later phase.
  assert.strictEqual(rowFor(lcTok).state, "rendered", "dwell must not move the row out of 'rendered'");
  assert.strictEqual((await earnings(lc, IP_LIFE)).totalPaise, 25, "dwell must not change what is owed");

  // Nothing to measure on a row that was never shown, never existed, or isn't yours.
  const lc3 = await line(lc, "", IP_LIFE);
  await line(lc, "", IP_LIFE);   // the re-roll voids lc3
  const deadDwell = await dwell({ token: lc3.body.impressionToken, visibleMs: 100, focusedMs: 100 });
  assert.strictEqual(deadDwell.status, 409, "dwell on a voided reservation must 409, got " + deadDwell.status);
  assert.strictEqual(deadDwell.body.error, "reservation_void", "a voided row must report reservation_void from dwell too");
  assert.strictEqual((await dwell({ token: orphan, visibleMs: 100, focusedMs: 100 })).status, 404, "dwell on an unknown jti must 404");
  const stolenDwell = await dwell({ token: mint(forgeA.userId), visibleMs: 100, focusedMs: 100 });
  assert.strictEqual(stolenDwell.status, 403, "dwell with another user's token must 403, got " + stolenDwell.status);
  assert.strictEqual(stolenDwell.body.error, "token_user_mismatch", "a cross-user dwell must report token_user_mismatch");
  assert.strictEqual((await dwell({ token: "garbage", visibleMs: 1, focusedMs: 1 })).body.error, "invalid_impression_token",
    "dwell must verify the token before it trusts anything in the body");

  // ── a .vsix already in the wild: mint -> POST /v1/impressions, no dwell ────
  // ~9 published builds have never heard of a reservation or a dwell report. The
  // whole point of keeping the transition on the existing endpoint is that they
  // keep earning, unchanged, with no client update.
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-legacy", { payout_paise: 25, bid_paise: 42 });
  const legacy = await newUser(IP_LIFE);
  const legacyLine = await line(legacy, "?taskType=npm", IP_LIFE);
  assert.deepStrictEqual(Object.keys(legacyLine.body).sort(),
    ["advertiser", "id", "impressionToken", "logoUrl", "payoutPaise", "text", "url"],
    "the /v1/sponsor-line response shape must not change — shipped clients parse it: " + JSON.stringify(legacyLine.body));
  const legacyImp = await api("POST", "/v1/impressions", { token: legacyLine.body.impressionToken, taskType: "npm" }, legacy.token, IP_LIFE);
  assert.deepStrictEqual(legacyImp.body, { ok: true }, "the /v1/impressions response shape must not change either");
  const legacyEarned = await earnings(legacy, IP_LIFE);
  assert.strictEqual(legacyEarned.totalPaise, 25, "a legacy client that never reports dwell must still earn the full payout");
  assert.strictEqual(legacyEarned.impressionCount, 1, "a legacy client's impression must count exactly once");
  assert.strictEqual(legacyEarned.availablePaise, 25, "a legacy client's balance must be withdrawable, not held pending dwell");
  const legacyRow = rowFor(legacyLine.body.impressionToken);
  assert.strictEqual(legacyRow.visible_ms, 0, "no dwell report means no dwell — not a blocked payout");
  assert.strictEqual(legacyRow.task_type, "npm", "task_type must survive the mint -> render transition");
  assert.strictEqual(legacyRow.billable, 1, "the legacy flow must end billable");

  // ══════════════════════════════════════════════════════════════════════════
  // REGRESSION: a schema migration must never move a user's balance.
  // db.js runs its migrations on every boot, and two of them are UPDATE passes
  // over `impressions` (the payout_paise / bid_paise backfills) — i.e. the file
  // already contains the exact shape of change that could silently re-price
  // history. This block seeds a user with a known ledger, boots db.js again in a
  // child process against the same file (a real second startup, all migrations
  // and backfills), and re-reads the balance over HTTP. If any migration ever
  // touches money, this fails and names the delta.
  // ══════════════════════════════════════════════════════════════════════════
  const ledger = await newUser(IP.money);
  const seedRows = [
    ["sponsor-cap", "npm", 25, 42],
    ["sponsor-cap", "gradle", 60, 100],
    ["sponsor-gone-forever", null, 13, 42],   // sponsor row deleted: the backfills must leave it alone
    ["sponsor-cap", "docker", 0, 0],          // payout_paise = 0: exactly what the backfill's WHERE matches
  ];
  const seed = db.prepare("INSERT INTO impressions (user_id, sponsor_id, task_type, payout_paise, bid_paise) VALUES (?,?,?,?,?)");
  db.transaction(() => { for (const r of seedRows) seed.run(ledger.userId, ...r); })();

  const before = (await api("GET", "/v1/earnings", undefined, ledger.token, IP.money)).body;
  assert.strictEqual(before.totalPaise, 98, "ledger fixture must total 25+60+13+0 paise");
  assert.strictEqual(before.impressionCount, 4, "ledger fixture must be 4 impressions");

  // Re-run every migration in db.js against this live database, from a cold
  // process, exactly as a redeploy would.
  execFileSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(__dirname, "db.js"))}).close()`],
    { env: { ...process.env, DB_PATH, NODE_ENV: "test" }, stdio: "ignore" });

  const after = (await api("GET", "/v1/earnings", undefined, ledger.token, IP.money)).body;
  assert.strictEqual(after.totalPaise, before.totalPaise,
    `MIGRATION MOVED MONEY: totalPaise ${before.totalPaise} -> ${after.totalPaise}`);
  assert.strictEqual(after.impressionCount, before.impressionCount,
    `MIGRATION MOVED MONEY: impressionCount ${before.impressionCount} -> ${after.impressionCount}`);
  assert.strictEqual(after.availablePaise, before.availablePaise,
    `MIGRATION MOVED MONEY: availablePaise ${before.availablePaise} -> ${after.availablePaise}`);
  assert.deepStrictEqual(
    db.prepare("SELECT payout_paise, bid_paise FROM impressions WHERE user_id = ? ORDER BY id").all(ledger.userId),
    seedRows.map(([, , payout_paise, bid_paise]) => ({ payout_paise, bid_paise })),
    "a migration rewrote per-row payout/bid on historic impressions",
  );
  // The lifecycle columns backfill history purely through their DEFAULTS: the
  // instant they exist, every pre-existing row reads as already-earned and final.
  // That is why no migration needs an UPDATE over this table — and an UPDATE here
  // is exactly what the assertions above are standing guard against.
  assert.deepStrictEqual(
    db.prepare("SELECT DISTINCT state, billable FROM impressions WHERE user_id = ?").all(ledger.userId),
    [{ state: "settled", billable: 1 }],
    "rows predating the lifecycle columns must read as settled + billable, with no backfill pass",
  );
  db.prepare("DELETE FROM impressions WHERE user_id = ?").run(ledger.userId);

  console.log("test-api: all assertions passed");
}

const server = app.listen(0, async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await main();
    process.exitCode = 0;
  } catch (e) {
    console.error("\nFAIL:", e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    server.close();
    db.close();
    for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) fs.rmSync(f, { force: true });
  }
});
