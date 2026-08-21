# ⚡ DevCut — Get Paid While You Wait

> Shows a sponsored one-line message in your VS Code status bar while builds, installs, and tests run.  
> You earn **real money (₹ via UPI)** for every impression. Zero effort. Zero distraction.

---

## What it looks like

```
 ⎇ main   ⚙ Building (14s)…   📣 Postman — test your APIs in seconds →   $(coin) ₹0.25 this session
```

The moment you run `npm run build`, `cargo build`, `pytest`, `docker pull` etc., a sponsored line appears on the right side of your status bar. When the task finishes, it flashes `✓ Earned ₹0.25 this build` for 4 seconds, then disappears.

---

## Quick Start (2 minutes)

### Step 1 — Get your invite code

Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
DevCut: Open Website / Get Invite Code
```

Or go directly to → **https://waitwage-production.up.railway.app/site/**

Fill in your name and email. You'll receive an email with your personal invite code — looks like `DCUT-XXXX-XXXX-XX`.

### Step 2 — Activate in VS Code

Open the command palette and run:

```
DevCut: Activate with Invite Code
```

Paste your `DCUT-XXXX-XXXX-XX` code. Done. You'll see:

> *"DevCut activated! You will start earning on your next build."*

### Step 3 — Run a build

Run any tracked command (`npm run build`, `yarn install`, `pytest`, etc.) and watch the status bar.

---

## Commands (Command Palette)

| Command | What it does |
|---|---|
| `DevCut: Activate with Invite Code` | First-time setup — paste your `DCUT-...` code |
| `DevCut: Sign In (returning user)` | Restore on a new machine with the same code |
| `DevCut: Open Website / Get Invite Code` | Opens the DevCut site to get a code |
| `DevCut: Show My Earnings` | See lifetime and server-verified earnings |
| `DevCut: Sync Earnings from Server` | Pull latest balance from the backend |
| `DevCut: Set Payout UPI ID` | Add your UPI ID for withdrawals |
| `DevCut: Withdraw Earnings to UPI` | Request a payout (min ₹50) |
| `DevCut: Test Ad (10s demo)` | Preview what an ad looks like |
| `DevCut: Create Team Pool` | Pool earnings with your team/cohort |
| `DevCut: Join Team Pool` | Join an existing team pool |

---

## What triggers an ad

A sponsored line shows whenever you run any of these in the terminal:

| Tool | Examples |
|---|---|
| **Node / JS** | `npm`, `yarn`, `pnpm`, `npx` |
| **Python** | `pip`, `pip3`, `poetry`, `uv` |
| **Rust** | `cargo` |
| **Go** | `go build` |
| **Containers** | `docker`, `kubectl`, `terraform` |
| **Build** | `gradle`, `mvn`, `make`, `cmake` |
| **VCS** | `git clone`, `git pull`, `git fetch` |
| **Ruby / PHP** | `bundle install`, `composer install` |
| **AI tools** | `claude`, `aider`, `cursor` |

Tasks triggered via VS Code's Task runner also count.

---

## Earnings

- **~₹0.25 per impression** (typical — the exact rate is set per advertiser)  
- Each 30-second rotation during a task = 1 impression  
- Minimum withdrawal: ₹50 via UPI  
- Payouts processed within 7 days

---

## Returning to a new machine?

Your invite code doubles as your login. On a new machine:

```
DevCut: Sign In (returning user)  →  enter your DCUT-XXXX-XXXX-XX code
```

---

## Settings

`File → Preferences → Settings → search "devcut"`

| Setting | Default | Description |
|---|---|---|
| `devcut.enabled` | `true` | Turn DevCut on/off |
| `devcut.minTaskSeconds` | `3` | Minimum task duration before ad shows |
| `devcut.adRotationSeconds` | `30` | Seconds between impression rotations |
| `devcut.earningsFlashSeconds` | `4` | How long the "Earned ₹X" flash shows |
| `devcut.backendUrl` | Railway URL | Override for self-hosted setups |

---

## Privacy

- The extension records **impressions and clicks** — that's it  
- No keystroke logging, no file access, no telemetry beyond impression counts  
- Open source: [github.com/gouravgujariya/devcut](https://github.com/gouravgujariya/devcut)

---

## Support

- **Get invite / sign up:** https://waitwage-production.up.railway.app/site/  
- **Advertise:** https://waitwage-production.up.railway.app/site/advertisers.html  
- **Email:** techsupport@devcut.co.in
