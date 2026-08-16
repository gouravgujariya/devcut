// Plain `node server/test-api.js` — no framework, no new deps.
// Boots the real app on a random port against a throwaway SQLite file.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DB_PATH = path.join(os.tmpdir(), `devcut-test-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.ADMIN_KEY = "test-admin-key";   // adminAuth fails closed without one
process.env.NODE_ENV = "test";

const app = require("./backend");
const db = require("./db");

let base;
const api = async (method, url, body, token) => {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", "x-admin-key": "test-admin-key", ...(token && { Authorization: "Bearer " + token }) },
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
  const { accessToken: token, userId } = reg.body;

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

  const idleLine = await api("GET", "/v1/sponsor-line?idle=1", undefined, token);
  assert.strictEqual(idleLine.body.id, "sponsor-idle", "idle=1 must prefer the idle slot over the higher bid");
  assert.strictEqual(idleLine.body.logoUrl, "https://cdn.example.com/i.png");

  const buildLine = await api("GET", "/v1/sponsor-line?taskType=build", undefined, token);
  assert.strictEqual(buildLine.body.id, "sponsor-build", "taskType=build must pick the build-slot sponsor");
  assert.strictEqual(buildLine.body.logoUrl, null);

  // stack targeting outranks bid, and NULL slot_type still counts as 'all'
  sponsor("sponsor-go", { slot_type: null, bid_paise: 5, target_stack: "go,rust" });
  const goLine = await api("GET", "/v1/sponsor-line?taskType=build", undefined, token);
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
  const noCompanyLine = await api("GET", "/v1/sponsor-line", undefined, reg2.body.accessToken);
  assert.strictEqual(noCompanyLine.body, null, "sponsor-line must be null when company is unset");

  // ── total (lifetime) budget cap ─────────────────────────────────────────────
  db.exec("UPDATE sponsors SET active = 0"); // isolate from earlier test sponsors
  sponsor("sponsor-capped", { bid_paise: 42, budget_paise_total: 50 });
  ins.run(userId, "sponsor-capped", null, 30, 50); // lifetime bid-spend already at the cap
  const cappedLine = await api("GET", "/v1/sponsor-line", undefined, token);
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
    const line = await api("GET", "/v1/sponsor-line", undefined, token);
    seen.add(line.body.id);
  }
  assert.ok(seen.size > 1, "weighted selection should surface more than one sponsor across draws, got: " + [...seen]);

  // ── impression tokens: required, single-use, budget-enforced at spend time ──
  db.exec("UPDATE sponsors SET active = 0");
  sponsor("sponsor-tok", { bid_paise: 42, budget_paise_total: 60 }); // room for exactly one bid
  // sidestep the 25s per-user impression floor by backdating prior impressions
  const backdate = db.prepare("UPDATE impressions SET ts = ts - 60 WHERE user_id = ?");

  const tokLine = await api("GET", "/v1/sponsor-line", undefined, token);
  assert.ok(tokLine.body.impressionToken, "sponsor-line must return an impressionToken");

  // idle pays less: same sponsor, idle=1 → half payout in both display and token
  const idleHalf = await api("GET", "/v1/sponsor-line?idle=1", undefined, token);
  assert.strictEqual(idleHalf.body.payoutPaise, 13, "idle impressions must pay round(25 * 0.5)");

  backdate.run(userId);
  assert.strictEqual((await api("POST", "/v1/impressions", { taskType: "npm" }, token)).status, 400, "impression without token must 400");
  assert.strictEqual((await api("POST", "/v1/impressions", { token: "garbage" }, token)).body.error, "invalid_impression_token");

  const imp1 = await api("POST", "/v1/impressions", { token: tokLine.body.impressionToken, taskType: "npm" }, token);
  assert.strictEqual(imp1.status, 200, "tokened impression must credit: " + JSON.stringify(imp1.body));

  backdate.run(userId);
  const dup = await api("POST", "/v1/impressions", { token: tokLine.body.impressionToken }, token);
  assert.strictEqual(dup.status, 409, "same token twice must 409");
  assert.strictEqual(dup.body.error, "duplicate_impression");

  // budget stop: 42 spent of 60 — sponsor still serveable, but a second bid (84 > 60) must not land
  backdate.run(userId);
  const tokLine2 = await api("GET", "/v1/sponsor-line", undefined, token);
  assert.ok(tokLine2.body?.impressionToken, "sponsor with budget headroom must still serve");
  const imp2 = await api("POST", "/v1/impressions", { token: tokLine2.body.impressionToken }, token);
  assert.strictEqual(imp2.status, 410, "impression past the budget must 410: " + JSON.stringify(imp2.body));
  assert.strictEqual(imp2.body.error, "budget_exhausted");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM impressions WHERE sponsor_id = 'sponsor-tok'").get().n, 1,
    "budget-rejected impression must not be inserted");

  // ── UPI hygiene: format check + 24h withdrawal lock after a change ─────────
  assert.strictEqual((await api("PUT", "/v1/profile/upi", { upiId: "bad upi!" }, token)).status, 400, "junk UPI must 400");
  assert.deepStrictEqual((await api("PUT", "/v1/profile/upi", { upiId: "dev@upi" }, token)).body, { ok: true });
  const wd = await api("POST", "/v1/withdraw", undefined, token);
  assert.strictEqual(wd.status, 400);
  assert.strictEqual(wd.body.error, "upi_recently_changed", "fresh UPI must block withdrawal: " + JSON.stringify(wd.body));

  // ── admin auth fails closed ────────────────────────────────────────────────
  const noKey = await fetch(base + "/api/overview");
  assert.strictEqual(noKey.status, 401, "admin endpoint without x-admin-key must be rejected");

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
