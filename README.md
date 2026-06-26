# DevCut — VS Code Extension

Shows a sponsored one-line message in the VS Code status bar while a build, install, or test is running. Developers earn a revenue share (in paise) for every impression and click. Advertisers pay to reach developers at the exact moment of idle attention.

Deployed on Railway. Targeted at Indian developers (UPI payouts, ₹ earnings).

---

## How it works

```
Developer runs a task (npm build, docker pull, pytest…)
  → extension detects task start via VS Code task lifecycle hooks
  → AdRotator polls backend every N seconds for the current sponsor line
  → status bar shows "📢 SponsorText" for the task duration
  → each rotation = one impression recorded against the developer's account
  → click opens sponsor URL + records a click
  → task ends → "Earned ₹0.04 this build" flashes for 4s
  → monthly: developer requests UPI withdrawal from command palette
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  VS Code (Developer's machine)                       │
│                                                      │
│  extension.ts ──► AdRotator ──► SponsorClient ──────┼──► GET /v1/sponsor-line
│       │               │                              │    POST /v1/impressions
│       │               └── EarningsStore (globalState)│    POST /v1/clicks
│       └── AuthStore (secrets) ──────────────────────┼──► POST /v1/auth/*
└─────────────────────────────────────────────────────┘
                         │ HTTPS
┌────────────────────────▼────────────────────────────┐
│  Railway — backend.js (Express + better-sqlite3)     │
│                                                      │
│  Public routes:  /v1/public/signup, /v1/sponsor-line │
│                  /v1/impressions, /v1/clicks          │
│                  /v1/auth/refresh, /v1/auth/login     │
│                  /v1/earnings, /v1/user/upi           │
│                  /v1/withdraw, /v1/teams/*            │
│                                                      │
│  Admin routes (x-admin-key):  /api/sponsors          │
│                                /api/users            │
│                                /api/withdrawals       │
│                                /api/invites           │
│                                /api/teams             │
│                                                      │
│  SQLite  ──  kickback.db (users, sponsors,           │
│              impressions, clicks, refresh_tokens,    │
│              withdrawals, teams, invites)            │
└─────────────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────┐
│  Static (landing/)                                   │
│  index.html · advertisers.html · earnings.html       │
│  how-it-works.html · shared.css                      │
└─────────────────────────────────────────────────────┘
```

---

## Extension codemap (`src/`)

### `extension.ts` — entry point and orchestrator

Activates on `onStartupFinished`. Owns:

| Responsibility | Key lines |
|---|---|
| Store/client construction | `~60–80` |
| Task lifecycle hooks (`onDidStartTask`, `onDidEndTask`) | `~90–130` |
| `detectTaskType()` — maps task label to ad category | `~340–390` |
| Command registrations (10 commands) | `~150–330` |
| Auth gate: prompts for invite code if not registered | `~400–430` |

**Known issue:** `devcut.login` is registered at runtime (~188) but absent from `package.json` contributes — invisible in command palette.

**Dead code in this file:** `shouldTrackCommand()` (~60) — has zero callers; `detectTaskType` is called directly everywhere.

### `adRotator.ts` — ad display timer

Polls `SponsorClient.fetchCurrentLine()` on an interval, updates the status bar item, and calls `earningsStore.recordImpression()` on each rotation.

| Method | Purpose |
|---|---|
| `start(item, interval)` | Begin rotation loop, reset session paise |
| `stop()` | Clear interval, capture session paise, trigger earnings flash |
| `flash(item, paise)` | Show "Earned ₹X.XX" for `earningsFlashSeconds`, then hide |

### `sponsorClient.ts` — HTTP client for the backend

Wraps Node's built-in `https` module (no fetch, no axios — zero dependencies).

| Method | Endpoint |
|---|---|
| `register(name, email, inviteCode)` | `POST /v1/public/signup` |
| `login(email)` | `POST /v1/auth/login` |
| `refreshAccessToken()` | `POST /v1/auth/refresh` |
| `fetchCurrentLine(taskType)` | `GET /v1/sponsor-line` |
| `recordImpression(lineId, paise)` | `POST /v1/impressions` |
| `recordClick(lineId)` | `POST /v1/clicks` |
| `fetchEarnings()` | `GET /v1/earnings` |
| `setUpiId(upi)` | `POST /v1/user/upi` |
| `requestWithdrawal()` | `POST /v1/withdraw` |
| `createTeam(name)` | `POST /v1/teams` |
| `joinTeam(code)` | `POST /v1/teams/join` |
| `fetchTeamInfo()` | `GET /v1/teams/mine` |

**Dead methods (no callers):** `fetchMe()`, `fetchWithdrawalHistory()`, `leaveTeam()`, `setTokenGetter()`.

### `authStore.ts` — token persistence

Stores access token + expiry in `context.secrets` (encrypted). Stores server-assigned userId in `globalState`.

| Method | Storage key |
|---|---|
| `setTokens(access, refresh, userId)` | `devcut.accessToken`, `devcut.refreshToken`, `devcut.userId` |
| `setAccessToken(token)` | `devcut.accessToken` (+ sets expiry = now + 23.5h) |
| `getAccessToken()` | `devcut.accessToken` |
| `isAccessTokenExpired()` | checks `devcut.tokenExpiry` |

**Dead methods:** `clearToken()`, `isRegistered()`, `getUserId()` — none have callers.

### `earningsStore.ts` — local earnings cache

Stores lifetime/session paise in `context.globalState`. Generates a local UUID for the device identity.

| Method | Storage key |
|---|---|
| `getUserId()` | `devcut.localUserId` (random UUID, generated once) |
| `getLifetimePaise()` | `devcut.lifetimePaise` |
| `addPaise(n)` | accumulates into `devcut.lifetimePaise` |
| `startSession()` / `endSession()` | reset `sessionPaise` to 0 (both do the same thing — smell) |
| `recordImpression(paise)` | adds paise, increments count |
| `getSessionPaise()` | returns `sessionPaise` |

---

## Backend codemap (`server/`)

### `backend.js` — Express app, all routes

Single file, ~760 lines. Route groups:

**Public (no auth):**
```
POST /v1/public/signup     register with invite code → sends welcome email via Resend
POST /v1/auth/login        email OTP initiation
POST /v1/auth/refresh      refresh JWT using stored refresh token
GET  /v1/sponsor-line      returns current active sponsor line (highest bid, budget not exhausted)
POST /v1/impressions       record an impression (auth required)
POST /v1/clicks            record a click (auth required)
GET  /v1/earnings          user's lifetime + session earnings
POST /v1/user/upi          save UPI ID
POST /v1/withdraw          request withdrawal (min ₹10)
POST /v1/teams             create team
POST /v1/teams/join        join team with code
GET  /v1/teams/mine        get own team info + leaderboard
GET  /v1/public/stats      public stats (total devs, total impressions — not shown on landing)
```

**Admin (`x-admin-key` header required):**
```
GET/POST/PUT/DELETE /api/sponsors    sponsor CRUD
GET                 /api/users       all users with earnings aggregates
GET/PUT             /api/withdrawals list + approve/reject
GET                 /api/invites     list invite codes
POST                /api/invites     generate new invite codes
GET                 /api/teams       all teams
```

**Key helpers:**
- `generateInviteCode()` (~733) — generates `XXXX-XXXX-XXXX` codes. **Bug:** body is duplicated inline at ~533 inside signup route.
- `requireAuth` middleware — validates Bearer JWT
- Daily budget SQL — duplicated at ~138 and ~574 (should be a prepared statement)

### `auth.js` — JWT sign/verify

Pure crypto, no I/O, no Express dependency. Signs with RS256 using env-provided keys.

```js
signAccessToken(userId)   // 24h expiry
signRefreshToken(userId)  // 30d expiry
verifyToken(token)        // returns decoded payload or throws
```

**Stale branding:** `ISSUER = "kickback-status"` (line 4), `kid: "kickback-rs256-1"` (line 46) — embedded in every JWT and checked on every verify. Changing these breaks existing tokens.

### `db.js` — SQLite schema

Opens `kickback.db` with better-sqlite3 (synchronous, no connection pool needed). Creates tables on startup:

| Table | Purpose |
|---|---|
| `users` | id, name, email, upi_id, invite_code |
| `sponsors` | id, name, text, url, bid_paise, payout_paise, active |
| `impressions` | id, user_id, sponsor_id, ts, paise |
| `clicks` | id, user_id, sponsor_id, ts |
| `refresh_tokens` | token (hashed), user_id, expires_at |
| `withdrawals` | id, user_id, amount_paise, status, upi_id, ts |
| `teams` | id, name, code, owner_id |
| `team_members` | team_id, user_id |
| `invites` | code, created_by, used_by, used_at |

**Missing indexes** — all high-traffic queries hit unindexed columns:
- `impressions(user_id)`, `impressions(ts)`, `impressions(sponsor_id)`
- `refresh_tokens(token)`

### `middleware.js` — auth + rate limiting

```js
requireAuth(req, res, next)   // verifies Bearer JWT, sets req.userId
requireAdmin(req, res, next)  // checks x-admin-key header
rateLimitImpressions          // in-process Map, 60 impressions/hr/user (memory leak: never pruned)
```

**Unnecessary complexity:** `getDb()` lazy loader exists to solve an imaginary circular require. Replace with `const db = require('./db')` at top.

### `mock-backend.js` — delete this

POC prototype with incompatible API (no Bearer auth, in-memory only). Never referenced by package.json, railway.toml, or any import. Safe to delete.

### `public/index.html` — admin dashboard

Single-page admin UI. Tabs: Sponsors, Users, Withdrawals, Invites, Teams.

**Bug:** write operations (`saveAd`, `deleteAd`, `approveWithdrawal`, `rejectWithdrawal`) use raw `fetch()` without the `apiFetch` wrapper — the `x-admin-key` header is never sent on mutations. All writes return 401.

---

## Landing pages (`landing/`)

| File | Purpose |
|---|---|
| `index.html` | Main marketing page — personas, earnings calculator, install CTA, India section, before/after mockup |
| `advertisers.html` | Advertiser pitch — CPM pricing, targeting, sign-up form |
| `earnings.html` | Developer earnings breakdown — how paise accumulates |
| `how-it-works.html` | Step-by-step guide with install command |
| `shared.css` | Shared styles (nav, footer, buttons, cards, animations) |

**Note:** `landing/index.html` does not link `shared.css` — it carries a full 487-line inline `<style>` block instead. Changes to `shared.css` silently don't apply to the homepage.

---

## Cleanup plan (ranked by impact)

### Delete immediately — zero risk

| File / Symbol | Why |
|---|---|
| `server/mock-backend.js` | Superseded, incompatible API, unreferenced |
| `competition.ini` | AI chat dump — every item in it has been implemented |
| `gen_logo.py` | Output already committed; not in any build pipeline |
| `image copy.png`, `image copy 2.png` | Untracked Finder accidents |
| `scripts/inject-env.sh` | Targets placeholder strings that no longer exist in any file |
| `scripts/wait.py` | POC test helper; not referenced anywhere active |
| `howtouse.md` | Fully subsumed by README; all paths/names reference "Kickback Status" |

### Fix bugs before any traffic

| Bug | Location | Fix |
|---|---|---|
| Admin writes bypass auth | `public/index.html` `saveAd`, `deleteAd`, `approveWithdrawal`, `rejectWithdrawal` | Replace `fetch(` with `apiFetch(` |
| Sponsor delete orphans earnings | `backend.js:633` | Add `ON DELETE SET NULL` or soft-delete |
| Missing DB indexes | `db.js` | Add indexes on `impressions(user_id, ts, sponsor_id)` |
| Duplicate `generateInviteCode` | `backend.js:533–535` | Delete inline copy, use the function at 733 |

### Dead code to delete (extension)

| Symbol | File | Action |
|---|---|---|
| `shouldTrackCommand()` | `extension.ts:60` | Delete — no callers |
| `SponsorClient.userId` field | `sponsorClient.ts:29` | Delete — stored, never read |
| `SponsorClient.fetchMe()` | `sponsorClient.ts:105` | Delete — no callers |
| `SponsorClient.fetchWithdrawalHistory()` | `sponsorClient.ts:136` | Delete — no callers |
| `SponsorClient.leaveTeam()` | `sponsorClient.ts:168` | Delete — no command registered |
| `SponsorClient.setTokenGetter()` | `sponsorClient.ts:35` | Delete — always injected at construction |
| `AuthStore.clearToken()` | `authStore.ts:47` | Delete — no logout command |
| `AuthStore.isRegistered()` | `authStore.ts:60` | Delete — no callers |
| `AuthStore.getUserId()` | `authStore.ts:56` | Delete — stored, never read back |

### Dead code to delete (backend)

| Symbol | File | Action |
|---|---|---|
| `role`, `github`, `company` in signup schema | `backend.js:507` | Delete — validated, never stored |
| `payout_paise` in POST /api/sponsors schema | `backend.js:597` | Delete — recalculated unconditionally |
| `f-payout` form field | `public/index.html:600` | Delete — value always overwritten server-side |
| `taskType` query param in `GET /v1/sponsor-line` | `backend.js:133` | Delete or implement — currently logged and ignored |
| Post-insert count queries | `backend.js:186,197` | Delete — full table scan for a log line |
| `express.urlencoded` middleware | `backend.js:14` | Delete — no URL-encoded clients |
| `getDb()` lazy wrapper | `middleware.js:5` | Replace with `const db = require('./db')` |

### Stale branding (server)

`server/package.json` name/description, `auth.js` ISSUER (`"kickback-status"`), `auth.js` kid (`"kickback-rs256-1"`), and `db.js` default path (`kickback.db`) all reference the old product name. The JWT issuer and kid are embedded in live tokens — changing them invalidates all existing sessions. Change on next planned auth rotation.

### Landing page debt

1. Extract canvas particle IIFE (copied verbatim into 5 files) → `landing/canvas-particles.js`
2. Add `<link rel="stylesheet" href="shared.css">` to `landing/index.html` and strip the inline `<style>` block
3. `docs/index.html` is an outdated predecessor with visible zero stats — replace with redirect or delete

---

## Dev setup

### Extension

```bash
npm install
npm run compile          # or: npm run watch
# F5 in VS Code to open Extension Development Host
```

Default backend URL (from `package.json` schema default): `https://waitwage-production.up.railway.app`
Override in VS Code settings: `"devcut.backendUrl": "http://localhost:3000"`

### Backend

```bash
cd server
npm install
npm run dev              # node --watch backend.js, port 3000
```

Required env vars:

| Variable | Purpose |
|---|---|
| `JWT_PRIVATE_KEY` | RS256 private key for signing tokens |
| `JWT_PUBLIC_KEY` | RS256 public key for verifying tokens |
| `ADMIN_KEY` | Secret for `x-admin-key` header on admin routes |
| `RESEND_API_KEY` | Resend email API key (signup welcome + invite emails) |
| `DCUT_INVITE_CODE` | Auto-sent invite code in welcome email |
| `PORT` | HTTP port (Railway sets this automatically) |

### Packaging the extension

```bash
npm install -g @vscode/vsce
vsce package             # produces devcut-X.Y.Z.vsix
```
