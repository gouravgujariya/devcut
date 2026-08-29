const express = require("express");
const path = require("path");
const { randomUUID, randomInt, randomBytes, createHash } = require("crypto");
const dns = require("node:dns").promises;
const { z } = require("zod");
const db = require("./db");
const { signImpressionToken, verifyImpressionToken } = require("./auth");
const { requireAuth, adminAuth, rateLimitImpressions, globalRateLimit, authRateLimit, oauthRateLimit } = require("./middleware");
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) console.warn("[startup] RESEND_API_KEY not set — all emails disabled");

// Browser OAuth (web dashboard only — the extension uses VS Code's own GitHub provider)
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://waitwage-production.up.railway.app";
if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.warn("[startup] GITHUB_CLIENT_ID/SECRET not set — browser GitHub sign-in disabled (extension sign-in still works)");
}

// One-time seed for changelog_entries (see db.js) — admin panel owns it from here on,
// via POST/PUT/DELETE /api/updates. Only used if the table is still empty at boot.
const CHANGELOG_SEED = [
  {
    version: "0.2.0",
    date: "2026-08-22",
    title: "Sign-in that doesn't expire",
    notes: [
      "You'll need to sign in one more time after this update — sorry for the one-time hiccup",
      "After that: no more random 'session expired' pop-ups, ever, until you actually sign out",
      "Signing out (or reporting a lost laptop) now cuts off access instantly instead of within a day",
    ],
    critical: true,
  },
  {
    version: "0.1.4",
    date: "2026-08-20",
    title: "GitHub sign-in",
    notes: [
      "Sign in with GitHub — no invite code to lose",
      "One button now handles both new and returning users",
      "Web dashboard gets the same sign-in as the extension",
    ],
    critical: false,
  },
  {
    version: "0.1.3",
    date: "2026-07-28",
    title: "Earnings panel + safer sessions",
    notes: [
      "New earnings panel with daily, per-sponsor and per-task breakdowns",
      "Web dashboard login",
      "Single-flight token refresh — no more duplicate refresh storms",
      "Impressions are credited from a signed token, so what you're shown is what you're paid",
    ],
    critical: false,
  },
  {
    version: "0.1.2",
    date: "2026-06-27",
    title: "Onboarding",
    notes: [
      "Guided first-run onboarding",
      "Ads only render once you're signed in",
    ],
    critical: false,
  },
];

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
// Throwaway domains that DO publish MX, so the DNS check below waves them through
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "yopmail.com", "10minutemail.com", "tempmail.com",
  "throwawaymail.com", "sharklasers.com", "getnada.com", "temp-mail.org", "trashmail.com",
]);
// Domain → deliverable? The set of domains we ever see is tiny, so no TTL.
const mxCache = new Map();

// Can this domain receive mail at all? Fails OPEN: a DNS timeout, SERVFAIL or a
// box with no network must never lock a real dev out of signup — only a
// definitive "no such domain" / "no MX records" answer rejects.
// ponytail: a static disposable list only catches the well-known ones; the real
// fix is a Resend bounce webhook, add it when bounces actually show up.
async function isRealEmailDomain(domain) {
  const d = String(domain).toLowerCase().trim();
  // Reject before touching the cache. An over-long name is not a hostname, and
  // caching one would let an unauthenticated caller grow mxCache without bound —
  // the key comes straight from a public request body.
  if (d.length > 253) return false;
  if (DISPOSABLE_DOMAINS.has(d)) return false;
  if (mxCache.has(d)) return mxCache.get(d);

  let ok = true;
  try {
    const mx = await dns.resolveMx(d);
    // RFC 7505: a lone "." exchange is a null MX — the domain is explicitly
    // saying it accepts no mail, same as publishing none at all.
    ok = mx.some((r) => r.exchange && r.exchange !== ".");
  } catch (e) {
    // ENOTFOUND = NXDOMAIN, ENODATA = domain exists but publishes no MX,
    // EBADNAME = not a resolvable name at all. None of them can receive mail.
    ok = !["ENOTFOUND", "ENODATA", "NXDOMAIN", "EBADNAME"].includes(e.code);
  }
  // ponytail: crude flush rather than an LRU — bounds memory and clears stale negatives.
  if (mxCache.size > 5000) mxCache.clear();
  mxCache.set(d, ok);
  return ok;
}

// Backfill canonical emails for invites created before the column existed
{
  const upd = db.prepare("UPDATE beta_invites SET email_canonical = ? WHERE code = ?");
  for (const r of db.prepare("SELECT code, email FROM beta_invites WHERE email_canonical IS NULL").all()) {
    upd.run(canonicalEmail(r.email), r.code);
  }
}

// Seed changelog_entries once — inserted oldest-first so id order (newest-last-inserted)
// matches the hand-written newest-first array below it reading in reverse.
if (db.prepare("SELECT COUNT(*) AS n FROM changelog_entries").get().n === 0) {
  const insert = db.prepare(
    "INSERT INTO changelog_entries (version, date, title, notes, critical) VALUES (?, ?, ?, ?, ?)"
  );
  for (const e of [...CHANGELOG_SEED].reverse()) {
    insert.run(e.version, e.date, e.title, JSON.stringify(e.notes), e.critical ? 1 : 0);
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

// Funnel counters — see the `counters` table in db.js.
const bumpCounterStmt = db.prepare(
  "INSERT INTO counters (name, n) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1"
);
function bumpCounter(event) {
  bumpCounterStmt.run(`${event}:${new Date().toISOString().slice(0, 10)}`);
}

// Global daily ceiling on outbound mail. A per-IP limit cannot protect this: the
// advertiser-inquiry route mails an attacker-chosen address, so a rotating-IP
// caller can still burn the Resend quota and get the sending domain blocklisted —
// after which every real invite email fails silently. This bounds it regardless
// of how many IPs are used.
// ponytail: one flat cap across all mail; split per-route if it ever binds on real traffic.
const EMAIL_DAILY_CAP = Number(process.env.EMAIL_DAILY_CAP || 300);
const emailCountStmt = db.prepare("SELECT n FROM counters WHERE name = ?");
function canSendEmail() {
  const n = emailCountStmt.get(`email_sent:${new Date().toISOString().slice(0, 10)}`)?.n ?? 0;
  if (n < EMAIL_DAILY_CAP) return true;
  console.warn(`[email] daily cap ${EMAIL_DAILY_CAP} reached — suppressing send`);
  return false;
}

// Count .vsix downloads before express.static below blindly serves the file.
// Must stay above the /site mount — Express matches layers in registration order.
app.get("/site/devcut-latest.vsix", globalRateLimit, (req, res, next) => {
  bumpCounter("vsix_download");
  next();
});

// Landing pages at /site/ — doesn't collide with admin panel at /
app.use("/site", express.static(path.join(__dirname, "..", "landing")));

// ─── Public extension API (/v1/) ──────────────────────────────────────────────

app.use("/v1", corsMw, globalRateLimit);

// Opaque permanent session token: 256 bits, hex. Raw value is returned to the
// client exactly once and never stored server-side — only its SHA-256 hash,
// looked up by requireAuth on every request. No expiry, no rotation: a
// session stays valid until explicitly revoked (logout / account deletion /
// per-session revoke via DELETE /v1/me/sessions/:id).
function issueSession(userId) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO sessions (id, token_hash, user_id) VALUES (?, ?, ?)")
    .run(randomUUID(), tokenHash, userId);
  return token;
}

// Row → wire shape: notes back to an array, critical back to a boolean.
function changelogEntryOut(row) {
  let notes;
  try { notes = JSON.parse(row.notes); } catch { notes = []; }
  return { version: row.version, date: row.date, title: row.title, notes, critical: !!row.critical };
}

// Compares each dot-separated part as an integer; a string compare would rank
// "0.1.10" below "0.1.9". Mirrors isNewerVersion() in src/sponsorClient.ts.
function versionIsNewer(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

// GET /v1/updates  — extension changelog (public), so the client can nudge on a new version
app.get("/v1/updates", (req, res) => {
  // Every extension hits this on activation. Signed-out callers are the
  // "installed but never signed in" bucket — the gap between download and signup.
  if (req.query.src === "ext" && !req.headers["authorization"]) bumpCounter("ext_ping_anon");
  const rows = db.prepare("SELECT * FROM changelog_entries ORDER BY id DESC").all();
  const entries = rows.map(changelogEntryOut);
  // `latest` is the highest version, NOT the newest row: the admin panel can post a
  // backfilled entry or edit an old one, and taking entries[0] there would report an
  // older version as latest — silently switching off every client's update prompt.
  const latest = entries.reduce((max, e) => (versionIsNewer(e.version, max) ? e.version : max), "0.0.0");
  res.json({ latest, entries });
});

// POST /v1/register  — exchange invite code for a session token
app.post("/v1/register", authRateLimit, (req, res) => {
  const parse = z.object({ inviteCode: z.string().min(1) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "inviteCode required" });

  const code = parse.data.inviteCode.toUpperCase().trim();
  const invite = db.prepare(
    "SELECT * FROM beta_invites WHERE code = ? AND used_at IS NULL"
  ).get(code);

  if (!invite) return res.status(403).json({ error: "invalid_or_used_code" });

  const userId = randomUUID();
  let token;

  try {
    db.transaction(() => {
      db.prepare("INSERT INTO users (id, email, invite_code, company) VALUES (?, ?, ?, ?)").run(userId, invite.email, invite.code, invite.company || null);
      db.prepare("UPDATE beta_invites SET used_at = ?, used_by_user_id = ? WHERE code = ?").run(Math.floor(Date.now() / 1000), userId, invite.code);
      token = issueSession(userId);
    })();
  } catch (e) {
    console.error("[register] DB error:", e.message);
    return res.status(500).json({ error: "registration_failed" });
  }

  console.log(`[register] new user ${userId} via code ${code}`);
  res.json({ token, userId });
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

  const token = issueSession(invite.used_by_user_id);

  console.log(`[login] user=${invite.used_by_user_id} via code ${code}`);
  res.json({ token, userId: invite.used_by_user_id });
});

// Auth-grade email equivalence — NOT the same rule as canonicalEmail().
// Gmail guarantees dev@, d.e.v@ and dev+tag@gmail.com are one mailbox (dots are
// ignored and '+' is not a legal Gmail username character), so folding them is safe
// even when the result decides WHICH ACCOUNT the caller gets. Every other domain is
// left alone on purpose: `alice+devcut@corp.tld` can be a genuinely separate mailbox,
// and folding it to alice@corp.tld would let its owner take over Alice's account.
// canonicalEmail() keeps the looser rule for signup dedupe, where a false match
// grants nothing but a resent invite code.
function authEmailKey(email) {
  const [local = "", domain = ""] = String(email).toLowerCase().trim().split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.split("+")[0].replace(/\./g, "")}@${domain}`;
  }
  return `${local}@${domain}`;
}
const isGmailAddress = (e) => /@(gmail|googlemail)\.com$/.test(String(e).toLowerCase().trim());

// Verify a GitHub access token and pull the identity we key accounts on.
// Returns { ok: true, githubId, email } or { ok: false, status, error }.
async function fetchGithubIdentity(githubAccessToken) {
  // GitHub counts even invalid-token calls against this server's 60/hr unauthenticated
  // IP budget, so junk here would 403 every genuine sign-in. Shape-check before spending it.
  // ponytail: matches today's gh*_ and classic 40-hex formats; widen if GitHub adds one.
  if (!/^(gh[pousr]_[A-Za-z0-9]{20,}|[0-9a-f]{40})$/.test(String(githubAccessToken))) {
    return { ok: false, status: 401, error: "invalid_github_token" };
  }
  const ghHeaders = { Authorization: `Bearer ${githubAccessToken}`, "User-Agent": "DevCut", Accept: "application/vnd.github+json" };

  let ghUser;
  try {
    const r = await fetch("https://api.github.com/user", { headers: ghHeaders });
    if (!r.ok) return { ok: false, status: 401, error: "invalid_github_token" };
    ghUser = await r.json();
  } catch (e) {
    console.error("[auth/github] GitHub API unreachable:", e.message);
    return { ok: false, status: 502, error: "github_unreachable" };
  }

  // The email decides which DevCut account the caller gets, so only a *verified*
  // address is ever good enough. GET /user's profile `email` carries no verified
  // flag of its own, so it never becomes the deciding value — /user/emails does,
  // and the user:email scope both callers request is what makes it readable.
  let email;
  try {
    const r = await fetch("https://api.github.com/user/emails", { headers: ghHeaders });
    if (r.ok) {
      const emails = await r.json();
      if (Array.isArray(emails)) {
        email = (emails.find(e => e.primary && e.verified) || emails.find(e => e.verified))?.email;
      }
    }
  } catch (e) {
    console.error("[auth/github] /user/emails fetch failed:", e.message);
  }
  if (!email) return { ok: false, status: 400, error: "github_email_unavailable" };

  return { ok: true, githubId: String(ghUser.id), email: email.toLowerCase().trim() };
}

// Turn a GitHub access token into a DevCut user id: login if linked, link if the
// email already has an account, register if the email holds an unused invite.
// Shared by POST /v1/auth/github (extension) and the browser OAuth sign-in callback —
// two transports, one account-resolution rule.
// Returns { ok: true, userId } or { ok: false, status, error }; the caller issues tokens.
async function resolveGithubIdentity(githubAccessToken) {
  const id = await fetchGithubIdentity(githubAccessToken);
  if (!id.ok) return id;
  const { githubId, email } = id;
  const authKey = authEmailKey(email);

  // Already linked — straight login.
  const byGithub = db.prepare("SELECT id, status FROM users WHERE github_id = ?").get(githubId);
  if (byGithub) {
    if (byGithub.status !== "active") return { ok: false, status: 403, error: "account_revoked" };
    console.log(`[auth/github] login user=${byGithub.id} github=${githubId}`);
    return { ok: true, userId: byGithub.id };
  }

  // Existing invite-code account with an equivalent email — link this identity to it.
  let byEmail = db.prepare("SELECT id, status, github_id FROM users WHERE email = ?").get(email);
  if (!byEmail && isGmailAddress(email)) {
    // users.email stores the address exactly as the invite was issued to, so a Gmail
    // dev who signed up as d.e.v@gmail.com but whose GitHub email reads dev@gmail.com
    // misses the exact match and would get a bogus "not_invited" for their own account.
    // Gmail only — see authEmailKey for why this must not be generalised.
    // ponytail: scans the gmail rows and compares in JS. Fine at beta scale; add a
    // stored normalized column if users ever gets large.
    byEmail = db.prepare(
      "SELECT id, status, github_id, email FROM users WHERE email LIKE '%@gmail.com' OR email LIKE '%@googlemail.com'"
    ).all().find((u) => authEmailKey(u.email) === authKey);
  }
  if (byEmail) {
    if (byEmail.status !== "active") return { ok: false, status: 403, error: "account_revoked" };
    if (byEmail.github_id && byEmail.github_id !== githubId) {
      // Bound to a different GitHub identity already — refuse rather than silently
      // stealing the link and locking the original identity out of the account.
      return { ok: false, status: 409, error: "account_already_linked" };
    }
    db.prepare("UPDATE users SET github_id = ? WHERE id = ?").run(githubId, byEmail.id);
    console.log(`[auth/github] linked user=${byEmail.id} github=${githubId}`);
    return { ok: true, userId: byEmail.id };
  }

  // Brand new identity — only allowed in if this email holds an unused invite.
  // For gmail, email_canonical already equals authEmailKey (same dot/+ folding);
  // for every other domain only the exact address counts, so a +tag variant can't
  // claim someone else's invite.
  const invite = isGmailAddress(email)
    ? db.prepare("SELECT * FROM beta_invites WHERE (email_canonical = ? OR email = ?) AND used_at IS NULL").get(authKey, email)
    : db.prepare("SELECT * FROM beta_invites WHERE email = ? AND used_at IS NULL").get(email);
  if (!invite) return { ok: false, status: 403, error: "not_invited" };

  const userId = randomUUID();
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO users (id, email, invite_code, company, github_id) VALUES (?, ?, ?, ?, ?)")
        .run(userId, invite.email, invite.code, invite.company || null, githubId);
      db.prepare("UPDATE beta_invites SET used_at = ?, used_by_user_id = ? WHERE code = ?")
        .run(Math.floor(Date.now() / 1000), userId, invite.code);
    })();
  } catch (e) {
    console.error("[auth/github] DB error:", e.message);
    return { ok: false, status: 500, error: "registration_failed" };
  }

  console.log(`[auth/github] new user ${userId} via github=${githubId} invite=${invite.code}`);
  return { ok: true, userId };
}

// POST /v1/auth/github  — sign in (or register, if invited) with a GitHub account
// instead of an invite code. Client gets the access token from VS Code's built-in
// `vscode.authentication.getSession('github', ...)` — no OAuth app secret needed here,
// we just verify that token against the GitHub API ourselves before trusting it.
app.post("/v1/auth/github", authRateLimit, async (req, res) => {
  const parse = z.object({ accessToken: z.string().min(1) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "accessToken required" });

  const result = await resolveGithubIdentity(parse.data.accessToken);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ token: issueSession(result.userId), userId: result.userId });
});

// ─── Browser GitHub OAuth (web dashboard) ─────────────────────────────────────
// The extension gets a token from VS Code; a browser has no such provider, so the
// dashboard needs a real OAuth App round-trip.

const OAUTH_DEFAULT_NEXT = "/site/login.html";

// `next` becomes a redirect target with tokens attached — an attacker-supplied
// "//evil.com" or "https://evil.com" would hand them the session. Site-relative only.
// '#' and '?' are rejected too: `?next=/site/login.html%23x` would build
// "...#x#access=…", which the client parses as the single key "x#access", so a real
// session gets minted and then silently dropped on a page showing no error.
function safeNext(next) {
  const n = String(next || "");
  if (!n.startsWith("/") || n.startsWith("//")) return OAUTH_DEFAULT_NEXT;
  if (n.includes("\\") || n.includes(":") || n.includes("#") || n.includes("?")) return OAUTH_DEFAULT_NEXT;
  return n;
}

// ponytail: in-memory OAuth state — dies on restart (user just retries) and breaks
// across instances. Move to a DB row before running >1 dyno.
const oauthStates = new Map(); // state -> { next, mode, userId, nonce, expires }

function pruneOauthStates() {
  const now = Date.now();
  for (const [k, v] of oauthStates) if (v.expires < now) oauthStates.delete(k);
}

// The state cookie binds the callback to the browser that started the flow. Without
// it, state alone proves nothing: an attacker can mint their own state, complete
// GitHub auth, then feed the victim the callback URL so the victim's browser stores
// the ATTACKER's tokens on our origin. Only the browser that got this cookie can
// finish the exchange. SameSite=Lax still rides along on GitHub's top-level redirect.
const OAUTH_COOKIE = "devcut_oauth";

function setOauthCookie(res, nonce) {
  const secure = PUBLIC_BASE_URL.startsWith("https://") ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${OAUTH_COOKIE}=${nonce}; Path=/v1/auth/github; Max-Age=600; HttpOnly; SameSite=Lax${secure}`);
}
function clearOauthCookie(res) {
  res.setHeader("Set-Cookie", `${OAUTH_COOKIE}=; Path=/v1/auth/github; Max-Age=0; HttpOnly; SameSite=Lax`);
}
function readOauthCookie(req) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === OAUTH_COOKIE) return v.join("=");
  }
  return "";
}

// Mints a state + cookie for either flow and returns GitHub's authorize URL.
function beginOauth(res, { next, mode, userId }) {
  pruneOauthStates();
  const state = randomUUID();
  const nonce = randomUUID();
  oauthStates.set(state, { next, mode, userId, nonce, expires: Date.now() + 10 * 60_000 });
  setOauthCookie(res, nonce);

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", GITHUB_CLIENT_ID);
  url.searchParams.set("scope", "user:email");
  url.searchParams.set("redirect_uri", `${PUBLIC_BASE_URL}/v1/auth/github/callback`);
  url.searchParams.set("state", state);
  return url.toString();
}

// GET /v1/auth/github/start  — kick off sign-in (creates or signs into an account)
app.get("/v1/auth/github/start", oauthRateLimit, (req, res) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return res.status(503).json({ error: "github_oauth_not_configured" });
  }
  res.redirect(302, beginOauth(res, { next: safeNext(req.query.next), mode: "signin" }));
});

// POST /v1/auth/github/link/start  — kick off LINKING for the already-signed-in user.
// Authenticated, unlike sign-in: linking must attach to the session that asked for it,
// so the callback can refuse anything that would resolve to a different account.
// Returns the URL instead of redirecting because the caller is fetch(), not a nav.
app.post("/v1/auth/github/link/start", requireAuth, oauthRateLimit, (req, res) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return res.status(503).json({ error: "github_oauth_not_configured" });
  }
  const next = safeNext(req.body && req.body.next);
  res.json({ url: beginOauth(res, { next, mode: "link", userId: req.userId }) });
});

// GET /v1/auth/github/callback  — GitHub sends the user back here with a code
app.get("/v1/auth/github/callback", oauthRateLimit, async (req, res) => {
  pruneOauthStates();

  const stateKey = String(req.query.state || "");
  const entry = oauthStates.get(stateKey);
  oauthStates.delete(stateKey); // single use
  const next = entry && entry.expires > Date.now() ? entry.next : OAUTH_DEFAULT_NEXT;
  const cookie = readOauthCookie(req);
  clearOauthCookie(res);
  // Tokens ride in the fragment, never the query string — fragments aren't sent to
  // servers, so they stay out of access logs, referrers and proxy history.
  const back = (frag) => res.redirect(302, `${next}#${frag}`);

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) return back("error=github_oauth_not_configured");
  if (!entry || entry.expires < Date.now()) return back("error=invalid_state");
  if (!entry.nonce || cookie !== entry.nonce) return back("error=invalid_state");
  if (!req.query.code) return back("error=missing_code");

  let ghToken;
  try {
    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "DevCut" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code: req.query.code,
        redirect_uri: `${PUBLIC_BASE_URL}/v1/auth/github/callback`,
      }),
    });
    ghToken = (await r.json()).access_token;
  } catch (e) {
    console.error("[auth/github] token exchange failed:", e.message);
    return back("error=github_unreachable");
  }
  if (!ghToken) return back("error=code_exchange_failed");

  // ── Link mode: attach this GitHub identity to the session that started the flow.
  // Never creates an account, never consumes an invite, never issues tokens — so it
  // cannot silently swap the user onto a different account the way sign-in would.
  if (entry.mode === "link") {
    const id = await fetchGithubIdentity(ghToken);
    if (!id.ok) return back(`error=${id.error}`);

    const owner = db.prepare("SELECT id FROM users WHERE github_id = ?").get(id.githubId);
    if (owner && owner.id !== entry.userId) return back("error=github_already_linked");

    const me = db.prepare("SELECT github_id, status FROM users WHERE id = ?").get(entry.userId);
    if (!me || me.status !== "active") return back("error=account_revoked");
    if (me.github_id && me.github_id !== id.githubId) return back("error=account_already_linked");

    db.prepare("UPDATE users SET github_id = ? WHERE id = ?").run(id.githubId, entry.userId);
    console.log(`[auth/github] linked (explicit) user=${entry.userId} github=${id.githubId}`);
    return back("linked=1");
  }

  const result = await resolveGithubIdentity(ghToken);
  if (!result.ok) return back(`error=${result.error}`);

  const token = issueSession(result.userId);
  console.log(`[auth/github] browser login user=${result.userId} → ${next}`);
  back(`token=${token}&uid=${result.userId}`);
});

// GET /v1/me  — lightweight token validation + profile
app.get("/v1/me", requireAuth, (req, res) => {
  const user = db.prepare(
    `SELECT id, email, upi_id, created_at, company,
            experience_level, primary_stack, country, profile_done_at, github_id
     FROM users WHERE id = ?`
  ).get(req.userId);
  // Clients only need to know whether GitHub is connected — the raw id is
  // account-linking material, so it never leaves the server.
  if (user) {
    user.github_linked = !!user.github_id;
    delete user.github_id;
  }
  const team = db.prepare(
    "SELECT t.id, t.name, t.code FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ?"
  ).get(req.userId);
  res.json({ user, team: team || null });
});

// DELETE /v1/me/github  — unlink GitHub. Never gated: the invite code is still a
// working credential, so unlinking can't lock anyone out of their account.
app.delete("/v1/me/github", requireAuth, (req, res) => {
  db.prepare("UPDATE users SET github_id = NULL WHERE id = ?").run(req.userId);
  console.log(`[auth/github] unlinked user=${req.userId}`);
  res.json({ ok: true });
});

// DELETE /v1/logout  — revoke the session presented in the Authorization header
app.delete("/v1/logout", requireAuth, (req, res) => {
  db.prepare("UPDATE sessions SET revoked_at = unixepoch() WHERE id = ? AND revoked_at IS NULL")
    .run(req.sessionId);
  console.log(`[logout] user=${req.userId} session=${req.sessionId}`);
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
    db.prepare("UPDATE sessions SET revoked_at = unixepoch() WHERE user_id = ? AND revoked_at IS NULL")
      .run(req.userId);
  })();
  console.log(`[delete-me] user=${req.userId}`);
  res.json({ ok: true });
});

// GET /v1/me/sessions  — list this user's sessions ("lost my laptop" support case)
app.get("/v1/me/sessions", requireAuth, (req, res) => {
  const rows = db.prepare(
    "SELECT id, created_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC"
  ).all(req.userId);
  res.json(rows.map(r => ({ id: r.id, created_at: r.created_at, current: r.id === req.sessionId })));
});

// DELETE /v1/me/sessions/:id  — revoke one session (e.g. a lost device)
app.delete("/v1/me/sessions/:id", requireAuth, (req, res) => {
  const info = db.prepare(
    "UPDATE sessions SET revoked_at = unixepoch() WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
  ).run(req.params.id, req.userId);
  if (info.changes === 0) return res.status(404).json({ error: "session_not_found" });
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

// A sponsor with no explicit budget used to mean *unlimited*, which made payout
// liability unbounded: impressions accrue real INR owed to devs with no ceiling on
// what any advertiser can run up, and every live sponsor was created with NULL.
// A missing budget now means this default rather than infinity — generous enough
// not to disturb normal serving, finite enough that the worst case is a number.
// ponytail: one flat default for every sponsor; give it a per-sponsor column if
// campaigns ever legitimately need very different ceilings.
const SPONSOR_DEFAULT_DAILY_PAISE = Number(process.env.SPONSOR_DEFAULT_DAILY_PAISE || 100000); // Rs 1000/day
const effectiveDailyBudget = (s) => s.budget_paise_daily ?? SPONSOR_DEFAULT_DAILY_PAISE;

// Per-sponsor spend in one GROUP BY (bid-denominated — budgets cap what advertisers pay,
// not what devs are paid), instead of a query per sponsor.
function spendBySponsor(todayOnly) {
  return db.prepare(
    `SELECT sponsor_id, COALESCE(SUM(bid_paise), 0) AS spend FROM impressions
     ${todayOnly ? "WHERE ts > unixepoch('now', 'start of day')" : ""}
     GROUP BY sponsor_id`
  ).all().reduce((m, r) => (m[r.sponsor_id] = r.spend, m), {});
}

// Mirrors detectTaskType / TASK_TYPE_MAP in src/extension.ts — the only values an honest client sends
const KNOWN_TASK_TYPES = new Set(["claude", "aider", "cursor", "npm", "yarn", "pnpm", "npx", "pip", "python", "docker", "k8s", "terraform", "gradle", "maven", "rust", "go", "make", "cmake", "git", "ruby", "php"]);

// GET /v1/sponsor-line  — fetch current ad using highest-bidder auction (authenticated)
app.get("/v1/sponsor-line", requireAuth, (req, res) => {
  const taskType = KNOWN_TASK_TYPES.has(req.query.taskType) ? req.query.taskType : null;
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
    if ((todaySpend[s.id] || 0) >= effectiveDailyBudget(s)) return false;
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
      if ((today + claims.bid > effectiveDailyBudget(sponsor)) ||
          (sponsor.budget_paise_total != null && total + claims.bid > sponsor.budget_paise_total)) {
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
// A click only means anything if this user was actually served this sponsor's line.
// The route used to accept any string matching the id pattern, and sponsor ids leak
// through /v1/sponsor-line — so one account could fabricate ~172k clicks/day against
// any campaign: inflate your own to look renewable, or wreck a rival's to get it
// audited. No payout rides on a click, but CTR is what advertisers renew on, which
// makes this revenue data rather than a vanity metric.
// ponytail: matches a recent impression instead of the token's jti, so it needs no
// client change and extensions already in the wild keep working. Bind to the jti if
// a strict 1:1 click-per-impression ever matters.
const CLICK_IMPRESSION_WINDOW = 3600; // generous gap between seeing the line and clicking
const CLICK_DEDUP_WINDOW = 60;        // the line rotates on this order — faster is a script
app.post("/v1/clicks", requireAuth, (req, res) => {
  const parse = z.object({ lineId: z.string().regex(/^sponsor-[a-z0-9-]+$/) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body" });
  const lineId = parse.data.lineId;

  const served = db.prepare(
    "SELECT 1 FROM impressions WHERE user_id = ? AND sponsor_id = ? AND ts > unixepoch() - ?"
  ).get(req.userId, lineId, CLICK_IMPRESSION_WINDOW);
  if (!served) return res.status(400).json({ error: "no_matching_impression" });

  const recent = db.prepare(
    "SELECT 1 FROM clicks WHERE user_id = ? AND sponsor_id = ? AND ts > unixepoch() - ?"
  ).get(req.userId, lineId, CLICK_DEDUP_WINDOW);
  if (recent) return res.status(429).json({ error: "click_too_fast" });

  db.prepare("INSERT INTO clicks (user_id, sponsor_id) VALUES (?, ?)").run(req.userId, lineId);
  console.log(`[click] user=${req.userId} sponsor=${lineId}`);
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
// ponytail: 12 queries, 6 of them full scans of `impressions`, all synchronous —
// measured ~810ms at 1M rows, which blocks the event loop ahead of /v1/impressions.
// Costs nothing at today's row count. A 60s response cache fixes it in 3 lines, but
// it must invalidate on withdrawal-status changes or public stats go stale (there is
// a test asserting exactly that). Add it, with invalidation, before impressions pass ~100k.
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
  // Money owed but not yet sent — shown alongside totalPaidOut so "our books" includes
  // what's in flight, not just what's already settled.
  const pendingPayouts = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount_paise), 0) AS paise FROM withdrawals WHERE status = 'pending'"
  ).get();
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
    pendingPayouts: { count: pendingPayouts.n, totalRupees: (pendingPayouts.paise / 100).toFixed(2) },
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
app.post("/v1/public/signup", authRateLimit, async (req, res) => {
  const parse = z.object({
    name:    z.string().min(1).max(120),
    email:   z.string().email().max(254),
    role:    z.string().max(64).optional(),
    github:  z.string().max(64).optional().nullable(),
    company: z.string().min(1).max(120),
    source:  z.string().max(64).optional(),
  }).safeParse(req.body);

  if (!parse.success) return res.status(400).json({ error: "invalid_body" });

  const { name, email, role, github, company, source } = parse.data;
  const normalizedEmail = email.toLowerCase().trim();
  if (!await isRealEmailDomain(normalizedEmail.split("@")[1])) {
    return res.status(400).json({ error: "email_undeliverable" });
  }
  const canonical = canonicalEmail(email);
  console.log(`[signup] meta role=${role || "-"} github=${github || "-"} company=${company} source=${source || "-"}`);

  // Dedupe on canonical email (dev+tag@gmail.com == d.e.v@gmail.com); fall back
  // to exact email for legacy rows that predate the canonical column.
  const existing = db.prepare(
    "SELECT code, email FROM beta_invites WHERE email_canonical = ? OR (email_canonical IS NULL AND email = ?)"
  ).get(canonical, normalizedEmail);
  if (existing) {
    // Resend their code
    let email_sent = false;
    if (resend && canSendEmail()) {
      bumpCounter("email_sent");
      const result = await resend.emails.send({
        from: "DevCut <techsupport@devcut.co.in>",
        to: existing.email,
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
    db.prepare("INSERT INTO beta_invites (code, email, email_canonical, company, role, github, source, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(code, normalizedEmail, canonical, company.trim(), role || null, github || null, source || null, req.ip || null);
  } catch (e) {
    console.error("[signup] db error:", e.message);
    return res.status(500).json({ error: "signup_failed" });
  }

  // Send invite email via Resend
  let email_sent = false;
  if (resend && canSendEmail()) {
    bumpCounter("email_sent");
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
    console.warn("[signup] RESEND_API_KEY not set — email not sent for", normalizedEmail);
  }

  console.log(`[signup] new signup email=${normalizedEmail}`);
  res.json({ ok: true, email_sent, ...(!email_sent && { note: "Email delivery pending" }) });
});

// POST /v1/public/advertiser-inquiry  — advertiser sign-up form (no auth)
// authRateLimit, not the loose global 120/min: each accepted request fires two
// Resend emails, one of them to an attacker-supplied address.
app.post("/v1/public/advertiser-inquiry", authRateLimit, async (req, res) => {
  const parse = z.object({
    company:         z.string().min(1).max(120),
    contact_name:    z.string().min(1).max(120),
    email:           z.string().email().max(254),
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
  if (!await isRealEmailDomain(d.email.split("@")[1])) {
    return res.status(400).json({ error: "email_undeliverable" });
  }
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
  if (resend && canSendEmail()) {
    bumpCounter("email_sent");
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

    // Confirmation to advertiser. This one goes to an attacker-supplied address,
    // so it is the send that risks the sending domain's reputation — count it too,
    // otherwise the daily cap under-counts this route by half.
    bumpCounter("email_sent");
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

  // Download → install → signup → activate → earn. `stuck` is the actionable
  // end: invites that were emailed days ago and never redeemed.
  //
  // The whole block is optional: it reads `counters`, a table added later than the
  // rest of this endpoint, so a DB that predates that migration would throw here and
  // take the core stats down with it. The dashboard renders the funnel only when
  // present, so degrade to null rather than 500 the entire overview.
  let funnel = null;
  try {
  const counterSum = (prefix) => db.prepare(
    "SELECT COALESCE(SUM(n), 0) AS n FROM counters WHERE name LIKE ?"
  ).get(prefix + ":%").n;
  funnel = {
    downloads: counterSum("vsix_download"),
    ext_pings: counterSum("ext_ping_anon"),
    signups:   db.prepare("SELECT COUNT(*) AS n FROM beta_invites").get().n,
    activated: db.prepare("SELECT COUNT(*) AS n FROM beta_invites WHERE used_at IS NOT NULL").get().n,
    earning:   uniqueUsers,
    stuck: db.prepare(
      `SELECT email, company, created_at, (unixepoch() - created_at) / 86400 AS days
       FROM beta_invites
       WHERE used_at IS NULL AND created_at < unixepoch() - 3 * 86400
       ORDER BY created_at DESC LIMIT 50`
    ).all(),
  };
  } catch (e) {
    console.error("[overview] funnel unavailable:", e.message);
  }

  res.json({
    totalImpressions, totalClicks, uniqueUsers, activeSponsors, totalUsers,
    totalPaidRupees: (totalPaid / 100).toFixed(2),
    pendingWithdrawals: { count: pendingWithdrawals.n, totalRupees: (pendingWithdrawals.total / 100).toFixed(2) },
    taskTypeBreakdown,
    activeDevsToday: activeDevs,
    recent,
    funnel,
  });
});

// Abuse signals for manual review — flag only, never auto-ban. Admins act via
// PUT /api/users/:id/status.
app.get("/api/flags", (req, res) => {
  const shared_ips = db.prepare(
    `SELECT ip, COUNT(DISTINCT user_id) AS user_count, group_concat(DISTINCT user_id) AS ids
     FROM impressions WHERE ip IS NOT NULL
     GROUP BY ip HAVING COUNT(DISTINCT user_id) > 3
     ORDER BY user_count DESC`
  ).all().map(r => ({ ip: r.ip, user_count: r.user_count, user_ids: r.ids.split(",") }));

  const signup_bursts = db.prepare(
    `SELECT ip, COUNT(*) AS count FROM beta_invites WHERE ip IS NOT NULL
     GROUP BY ip HAVING COUNT(*) > 3 ORDER BY count DESC`
  ).all();

  // Derived from impressions, the same table rateLimitImpressions counts against
  // the 500/day cap (both bucket by UTC day), so no extra column is needed.
  const cap_hitters = db.prepare(
    `SELECT user_id, COUNT(*) AS days_at_cap FROM (
       SELECT user_id FROM impressions
       GROUP BY user_id, date(ts, 'unixepoch') HAVING COUNT(*) >= 500
     ) GROUP BY user_id HAVING days_at_cap >= 2 ORDER BY days_at_cap DESC`
  ).all();

  res.json({ shared_ips, signup_bursts, cap_hitters });
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

// Admin: post/edit/delete the changelog shown at GET /v1/updates (extension red dot + web dashboard)
const changelogBody = z.object({
  version:  z.string().min(1).max(32),
  date:     z.string().min(1).max(32).optional(), // defaults to today, admin can backdate/override
  title:    z.string().min(1).max(120),
  notes:    z.array(z.string().min(1).max(300)).max(20),
  critical: z.boolean().optional(),
});

app.get("/api/updates", (req, res) => {
  const rows = db.prepare("SELECT * FROM changelog_entries ORDER BY id DESC").all();
  res.json(rows.map(r => ({ id: r.id, ...changelogEntryOut(r), created_at: r.created_at })));
});

app.post("/api/updates", (req, res) => {
  const parse = changelogBody.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body", details: parse.error.flatten() });
  const d = parse.data;
  const date = d.date || new Date().toISOString().slice(0, 10);
  const info = db.prepare(
    "INSERT INTO changelog_entries (version, date, title, notes, critical) VALUES (?, ?, ?, ?, ?)"
  ).run(d.version.trim(), date, d.title.trim(), JSON.stringify(d.notes), d.critical ? 1 : 0);
  console.log(`[updates] posted ${d.version} "${d.title}"`);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put("/api/updates/:id", (req, res) => {
  const parse = changelogBody.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid body", details: parse.error.flatten() });
  const d = parse.data;
  const date = d.date || new Date().toISOString().slice(0, 10);
  const info = db.prepare(
    "UPDATE changelog_entries SET version=?, date=?, title=?, notes=?, critical=? WHERE id=?"
  ).run(d.version.trim(), date, d.title.trim(), JSON.stringify(d.notes), d.critical ? 1 : 0, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

app.delete("/api/updates/:id", (req, res) => {
  db.prepare("DELETE FROM changelog_entries WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
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
  const info = db.prepare(
    "UPDATE withdrawals SET status=?, ref=?, resolved_at=unixepoch() WHERE id=? AND status='pending'"
  ).run(status, ref || null, req.params.id);
  // Resolved rows are final. Without the status guard, flipping completed ->
  // rejected returns already-paid money to the user's withdrawable balance.
  if (info.changes === 0) return res.status(409).json({ error: "already_resolved" });
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

app.put("/api/users/:id/status", (req, res) => {
  const parse = z.object({ status: z.enum(["active", "banned"]) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "invalid status" });
  db.transaction(() => {
    db.prepare("UPDATE users SET status = ? WHERE id = ?").run(parse.data.status, req.params.id);
    if (parse.data.status !== "active")
      db.prepare("UPDATE sessions SET revoked_at = unixepoch() WHERE user_id = ? AND revoked_at IS NULL").run(req.params.id);
  })();
  console.log(`[admin] user=${req.params.id} status=${parse.data.status}`);
  res.json({ ok: true });
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
