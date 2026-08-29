import * as vscode from "vscode";
import { detectTaskType, isReplCommand } from "./taskTypes";
import { SponsorClient, isNewerVersion } from "./sponsorClient";
import { EarningsStore } from "./earningsStore";
import { AuthStore } from "./authStore";
import { AdRotator } from "./adRotator";
import { showEarningsPanel } from "./panel";

let adBar: vscode.StatusBarItem;
let sessionBar: vscode.StatusBarItem;
let readyBar: vscode.StatusBarItem;
let sponsorClient: SponsorClient;
let earningsStore: EarningsStore;
let authStore: AuthStore;
let activeTaskCount = 0;
let activeRotator: AdRotator | undefined;
let idleRotator: AdRotator | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let profileTimer: NodeJS.Timeout | undefined;

const PROFILE_DONE  = "devcut.profileDone";
const PROFILE_SKIPS = "devcut.profileSkips";
const COMPANY_DONE  = "devcut.companyDone";
const COMPANY_NUDGE_SEEN = "devcut.companyNudgeSeen";
const UPDATE_SEEN   = "devcut.updateSeenVersion";

// readyBar's resting state, restored when the update dot is dismissed.
const READY_TEXT    = "$(megaphone)";
const READY_TOOLTIP = "DevCut — click to test ad";

// Set only while the red update dot is showing; the version showUpdates marks seen.
let pendingUpdateVersion: string | undefined;
// Guards in-flight callbacks that would otherwise touch disposed status bar items.
let deactivated = false;

// Maps terminal command prefixes → task type label sent to backend for targeting

/**
 * Tries to recover a dead session without bothering the user: if VS Code already
 * has a cached GitHub session, exchange it for a fresh DevCut token — the same
 * exchange devcut.signInWithGithub does, just non-interactive (createIfNone: false
 * means this never pops a picker). Returns false (no UI shown) if nothing cached.
 */
async function attemptSilentRecovery(context: vscode.ExtensionContext): Promise<boolean> {
  const session = await vscode.authentication.getSession("github", ["user:email"], { createIfNone: false });
  if (!session) return false;
  try {
    const result = await sponsorClient.loginWithGithub(session.accessToken);
    await authStore.setTokens(result.token, result.userId);
    return true;
  } catch {
    return false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  deactivated = false;
  const config = vscode.workspace.getConfiguration("devcut");

  authStore   = new AuthStore(context);
  earningsStore = new EarningsStore(context);

  sponsorClient = new SponsorClient(
    config.get<string>("backendUrl", "https://waitwage-production.up.railway.app"),
    earningsStore.getUserId(),
    () => authStore.getToken()
  );

  // ── Status bar items ──────────────────────────────────────────────────────

  adBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  adBar.name = "DevCut Ad";
  adBar.command = "devcut.handleClick";
  context.subscriptions.push(adBar);

  sessionBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  sessionBar.name = "DevCut Session Earnings";
  sessionBar.command = "devcut.showEarnings";
  sessionBar.tooltip = "Click to see lifetime earnings";
  context.subscriptions.push(sessionBar);

  readyBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  readyBar.name = "DevCut Ready";
  readyBar.text = READY_TEXT;
  readyBar.tooltip = READY_TOOLTIP;
  readyBar.command = "devcut.testAd";
  context.subscriptions.push(readyBar);
  readyBar.show();

  // ── First-run onboarding ──────────────────────────────────────────────────
  // Show once: if user has never registered, tell them exactly what to do.
  if (!authStore.getUserId()) {
    vscode.window.showInformationMessage(
      "⚡ DevCut: Earn ₹ while you wait on builds. Sign in to activate.",
      "Sign in with GitHub",
      "Get Free Code →",
      "I Have a Code"
    ).then((action) => {
      if (action === "Sign in with GitHub")  vscode.commands.executeCommand("devcut.signInWithGithub");
      if (action === "Get Free Code →")      vscode.commands.executeCommand("devcut.openWebsite");
      if (action === "I Have a Code")        vscode.commands.executeCommand("devcut.activate");
    });
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.openWebsite", () => {
      vscode.env.openExternal(vscode.Uri.parse("https://waitwage-production.up.railway.app/site/"));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.handleClick", async () => {
      const line = (activeRotator ?? idleRotator)?.getCurrentLine();
      if (line) {
        await sponsorClient.recordClick(line.id);
        if (line.url) vscode.env.openExternal(vscode.Uri.parse(line.url));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.showEarnings", () => {
      showEarningsPanel(context, sponsorClient, earningsStore);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.showUpdates", async () => {
      if (pendingUpdateVersion) {
        await context.globalState.update(UPDATE_SEEN, pendingUpdateVersion);
        pendingUpdateVersion = undefined;
        readyBar.text = READY_TEXT;
        readyBar.tooltip = READY_TOOLTIP;
        readyBar.command = "devcut.testAd";
      }
      showEarningsPanel(context, sponsorClient, earningsStore, "updates");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.syncEarnings", async () => {
      const result = await sponsorClient.fetchEarnings();
      if (!result) {
        vscode.window.showWarningMessage("DevCut: Could not reach the backend to sync earnings.");
        return;
      }
      earningsStore.setServerBalance(result.totalPaise);
      const rupees = (result.totalPaise / 100).toFixed(2);
      vscode.window.showInformationMessage(
        `DevCut — Server-verified: ₹${rupees} across ${result.impressionCount} impressions.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "devcut");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.testAd", () => {
      onLongRunningStart(context, "npm");
      setTimeout(() => onLongRunningEnd(), 10_000);
    })
  );

  // ── Activate with invite code ─────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.activate", async () => {
      const code = await vscode.window.showInputBox({
        prompt: "Enter your DevCut invite code",
        placeHolder: "DCUT-XXXX-XXXX-XX",
        ignoreFocusOut: true,
      });
      if (!code) return;

      const normalizedCode = code.trim().toUpperCase();

      try {
        const result = await sponsorClient.register(normalizedCode);
        await authStore.setTokens(result.token, result.userId);
        vscode.window.showInformationMessage(
          "DevCut activated! You will start earning on your next build."
        );
        maybeAskProfile(context);
        return;
      } catch (err: any) {
        // A code already used is the normal shape of a returning user (reinstall,
        // new machine) — not a hard failure. Fall back to sign-in with that same
        // code instead of dead-ending; most users never discover the separate
        // "DevCut: Sign In" command.
        if (err?.message !== "invalid_or_used_code") {
          vscode.window.showErrorMessage(
            /could not reach backend/.test(err?.message ?? "")
              ? "DevCut couldn't reach the server — it's usually just waking up. Wait about 20 seconds and run 'DevCut: Activate with Invite Code' again. Your code is still valid."
              : `DevCut: activation failed — ${err?.message || "unknown error"}`
          );
          return;
        }
      }

      try {
        const result = await sponsorClient.login(normalizedCode);
        await authStore.setTokens(result.token, result.userId);
        vscode.window.showInformationMessage(
          "DevCut: Signed in successfully! You will resume earning on your next build."
        );
      } catch (err: any) {
        const msg = err?.message || "unknown error";
        vscode.window.showErrorMessage(
          msg === "invalid_code"
            ? "Invalid invite code. Check for typos and try again."
            : msg === "account_revoked"
            ? "Your account has been revoked. Contact the DevCut team."
            : `DevCut: sign-in failed — ${msg}`
        );
      }
    })
  );

  // ── Sign in with invite code (returning users) ────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.login", async () => {
      const code = await vscode.window.showInputBox({
        prompt: "Enter your DevCut invite code to sign back in",
        placeHolder: "DCUT-XXXX-XXXX-XX",
        ignoreFocusOut: true,
      });
      if (!code) return;

      try {
        const result = await sponsorClient.login(code.trim().toUpperCase());
        await authStore.setTokens(result.token, result.userId);
        vscode.window.showInformationMessage(
          "DevCut: Signed in successfully! You will resume earning on your next build."
        );
      } catch (err: any) {
        const msg = err?.message || "unknown error";
        vscode.window.showErrorMessage(
          msg === "invalid_code"
            ? "Invalid invite code. Use the same code you registered with."
            : msg === "account_revoked"
            ? "Your account has been revoked. Contact the DevCut team."
            : `DevCut: sign-in failed — ${msg}`
        );
      }
    })
  );

  // ── Sign in with GitHub (no code to type or lose) ─────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.signInWithGithub", async () => {
      let session: vscode.AuthenticationSession;
      try {
        session = await vscode.authentication.getSession("github", ["user:email"], { createIfNone: true });
      } catch (err: any) {
        // Cancelling the picker is not a failure, but a provider/network error is —
        // swallowing both makes the button look like a dead no-op.
        if (/cancel/i.test(String(err?.message ?? ""))) return;
        vscode.window.showErrorMessage(
          `DevCut: could not reach GitHub sign-in — ${err?.message || "unknown error"}`
        );
        return;
      }

      try {
        const result = await sponsorClient.loginWithGithub(session.accessToken);
        await authStore.setTokens(result.token, result.userId);
        vscode.window.showInformationMessage(
          "DevCut: Signed in with GitHub! You will start earning on your next build."
        );
        maybeAskProfile(context);
      } catch (err: any) {
        const msg = err?.message || "unknown error";
        vscode.window.showErrorMessage(
          msg === "not_invited"
            ? "This GitHub account's email isn't on the DevCut invite list yet. Get a free code first."
            : msg === "account_revoked"
            ? "Your account has been revoked. Contact the DevCut team."
            : msg === "github_email_unavailable"
            ? "DevCut: could not read an email from your GitHub account. Make sure it has a verified email."
            : `DevCut: GitHub sign-in failed — ${msg}`
        );
      }
    })
  );

  // ── Sign out ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.signOut", async () => {
      await sponsorClient.logout(); // best-effort server revoke — never throws
      await authStore.clearToken();
      vscode.window.showInformationMessage(
        "Signed out of DevCut. Run 'DevCut: Sign in with GitHub' or 'DevCut: Activate with Invite Code' when you want to start earning again."
      );
    })
  );

  // ── Set UPI ID ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.setUpiId", async () => {
      const upiId = await vscode.window.showInputBox({
        prompt: "Enter your UPI ID for earnings payout",
        placeHolder: "yourname@upi or phone@paytm",
        ignoreFocusOut: true,
        validateInput: (v) => /^[\w.\-]{2,64}@[a-zA-Z]{2,32}$/.test(v.trim()) ? undefined : "Enter a valid UPI ID, e.g. name@bank",
      });
      if (!upiId) return;

      const ok = await sponsorClient.setUpiId(upiId.trim());
      if (ok) {
        vscode.window.showInformationMessage(`UPI ID saved: ${upiId.trim()}. Earnings will be sent here.`);
      } else {
        vscode.window.showErrorMessage("DevCut: Could not save UPI ID. Are you registered?");
      }
    })
  );

  // ── Request withdrawal ────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.withdraw", async () => {
      const result = await sponsorClient.requestWithdrawal();
      if (!result) {
        vscode.window.showErrorMessage("DevCut: Could not reach backend. Try again.");
        return;
      }
      if (result.error === "upi_not_set") {
        const action = await vscode.window.showWarningMessage(
          "Set a UPI ID first to withdraw earnings.",
          "Set UPI ID"
        );
        if (action === "Set UPI ID") {
          vscode.commands.executeCommand("devcut.setUpiId");
        }
        return;
      }
      if (result.error === "insufficient_balance") {
        vscode.window.showWarningMessage(result.message ?? "Insufficient balance. Minimum withdrawal is ₹50.");
        return;
      }
      if (result.error === "withdrawal_pending") {
        vscode.window.showWarningMessage("A withdrawal is already being processed. Check back in a few days.");
        return;
      }
      if (result.ok) {
        const rupees = ((result.amountPaise ?? 0) / 100).toFixed(2);
        vscode.window.showInformationMessage(
          `Withdrawal of ₹${rupees} requested! Processed within 7 days via UPI.`
        );
      }
    })
  );

  // ── Team Pool ─────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.createTeam", async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Team name (e.g. your startup or bootcamp cohort name)",
        placeHolder: "100xDevs Cohort 10",
        ignoreFocusOut: true,
        validateInput: (v) => v.trim().length >= 2 ? undefined : "Name must be at least 2 characters",
      });
      if (!name) return;

      const result = await sponsorClient.createTeam(name.trim());
      if (!result) {
        vscode.window.showErrorMessage("DevCut: Could not create team. Are you registered?");
        return;
      }
      if (result.error === "already_in_team") {
        vscode.window.showWarningMessage("You are already in a team. Leave it first before creating a new one.");
        return;
      }
      if (result.ok) {
        vscode.window.showInformationMessage(
          `Team "${name.trim()}" created! Share this code with your team: ${result.code}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.joinTeam", async () => {
      const code = await vscode.window.showInputBox({
        prompt: "Enter the 6-character team code",
        placeHolder: "AB1234",
        ignoreFocusOut: true,
        validateInput: (v) => v.trim().length === 6 ? undefined : "Code must be exactly 6 characters",
      });
      if (!code) return;

      const result = await sponsorClient.joinTeam(code.trim().toUpperCase());
      if (!result) {
        vscode.window.showErrorMessage("DevCut: Could not reach backend. Try again.");
        return;
      }
      if (result.error === "team_not_found") {
        vscode.window.showErrorMessage(`No team found with code "${code.trim().toUpperCase()}". Check the code and try again.`);
        return;
      }
      if (result.error === "already_in_team") {
        vscode.window.showWarningMessage("You are already in a team. Leave it first before joining another.");
        return;
      }
      if (result.error === "already_member") {
        vscode.window.showWarningMessage("You are already a member of this team.");
        return;
      }
      if (result.ok) {
        vscode.window.showInformationMessage(`Joined team "${result.name}"! Your builds now contribute to the team pool.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.showTeam", async () => {
      const info = await sponsorClient.fetchTeamInfo();
      if (info === undefined) {
        vscode.window.showErrorMessage("DevCut: Could not reach backend.");
        return;
      }
      if (info === null) {
        const action = await vscode.window.showInformationMessage(
          "You are not in a team pool.",
          "Create Team", "Join Team"
        );
        if (action === "Create Team") vscode.commands.executeCommand("devcut.createTeam");
        if (action === "Join Team")   vscode.commands.executeCommand("devcut.joinTeam");
        return;
      }
      const total = (info.teamTotalPaise / 100).toFixed(2);
      const top = info.leaderboard.slice(0, 3)
        .map((m, i) => `${i + 1}. ...${m.user_id.slice(-4)}: ₹${(m.total_paise / 100).toFixed(2)}`)
        .join(" | ");
      vscode.window.showInformationMessage(
        `Team "${info.team.name}" — ${info.memberCount} members — Total earned: ₹${total} | Top: ${top}`
      );
    })
  );

  // ── VS Code Tasks API ─────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.tasks.onDidStartTask((e) => {
      // Try to extract task type from the task definition
      const taskDef = e.execution.task.definition;
      const taskCmd = (taskDef as any)?.command as string | undefined;
      const taskType = taskCmd ? detectTaskType(taskCmd) : undefined;
      onLongRunningStart(context, taskType);
    })
  );
  context.subscriptions.push(
    vscode.tasks.onDidEndTask(() => onLongRunningEnd())
  );

  // ── Terminal Shell Integration (VS Code 1.93+) ────────────────────────────

  const activeExecutions = new Map<unknown, string | undefined>(); // execution → taskType

  if (typeof (vscode.window as any).onDidStartTerminalShellExecution === "function") {
    context.subscriptions.push(
      (vscode.window as any).onDidStartTerminalShellExecution(
        (e: vscode.TerminalShellExecutionStartEvent) => {
          bumpActivity();
          const cmd = e.execution.commandLine.value.trimStart();
          if (isReplCommand(cmd)) return; // see REPL_COMMANDS — idle detection covers these
          const taskType = detectTaskType(cmd);
          if (taskType && !activeExecutions.has(e.execution)) {
            activeExecutions.set(e.execution, taskType);
            onLongRunningStart(context, taskType);
          }
        }
      )
    );
    context.subscriptions.push(
      (vscode.window as any).onDidEndTerminalShellExecution(
        (e: vscode.TerminalShellExecutionEndEvent) => {
          if (activeExecutions.has(e.execution)) {
            activeExecutions.delete(e.execution);
            onLongRunningEnd();
          }
        }
      )
    );
  }

  // ── Idle ads ──────────────────────────────────────────────────────────────
  // Any sign of life re-arms the countdown and kills a running idle ad instantly.

  context.subscriptions.push(
    // Only the focused document counts as human activity. An agent (Claude Code in the
    // sidebar, Copilot, aider) writing to background files used to reset the idle
    // countdown, so the one moment idle ads exist to catch — you, waiting, while a
    // machine works — was the one moment they could never fire.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) bumpActivity();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => bumpActivity()),
    vscode.window.onDidChangeTextEditorSelection(() => bumpActivity()),
    vscode.window.onDidChangeWindowState(() => bumpActivity()),
    vscode.window.onDidChangeActiveTerminal(() => bumpActivity()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("devcut")) bumpActivity();
    }),
    // Timers are module-level, so they must die with the extension host too.
    { dispose: () => clearAllTimers() }
  );
  bumpActivity();

  // ── One-time profile survey ───────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.profileSurvey", () => maybeAskProfile(context, true))
  );
  // Deferred so it never lands on top of whatever the user opened VS Code to do.
  // A dismissible toast, never a raw input box on a timer: only "Add it" opens the
  // company flow, and the nudge shows at most once ever (seen-flag, either answer).
  profileTimer = setTimeout(async () => {
    if (!authStore.getUserId()) return;
    if (context.globalState.get<boolean>(COMPANY_DONE)) return;
    if (context.globalState.get<boolean>(COMPANY_NUDGE_SEEN)) return;
    await context.globalState.update(COMPANY_NUDGE_SEEN, true);
    const action = await vscode.window.showInformationMessage(
      "DevCut: one thing left — add your company or college and ads can start earning. ",
      "Add it", "Later"
    );
    if (action === "Add it") maybeAskProfile(context);
  }, 15_000);

  // ── Update check ──────────────────────────────────────────────────────────
  // Shipped as a private .vsix, so nothing prompts the user to update — we ask
  // ourselves. Fire-and-forget on startup (never awaited) and once per activation:
  // no polling timer, a reload is cheap enough to re-check.
  sponsorClient.fetchUpdates().then((info) => {
    // The window can close inside the request timeout, which disposes readyBar via
    // context.subscriptions — touching it after that throws inside this .then().
    if (deactivated || !info?.latest) return;
    const running = String(context.extension.packageJSON.version ?? "0.0.0");
    if (!isNewerVersion(info.latest, running)) return;
    if (context.globalState.get<string>(UPDATE_SEEN) === info.latest) return;
    // Emoji dot, not a codicon: a single codicon glyph can't be tinted red, and
    // readyBar.backgroundColor would repaint the whole status bar pill.
    pendingUpdateVersion = info.latest;
    readyBar.text = `${READY_TEXT} 🔴`;
    readyBar.tooltip = `DevCut ${info.latest} available — click to see what's new`;
    readyBar.command = "devcut.showUpdates";
  }).catch(() => { /* update nudge is best-effort — never surface it */ });

  // Auto-sync server balance once per day on startup
  const oneDayMs = 86_400_000;
  if (Date.now() - earningsStore.getServerBalanceFetchedAt() > oneDayMs) {
    sponsorClient.fetchEarnings().then((result) => {
      if (result) earningsStore.setServerBalance(result.totalPaise);
    });
  }

  // Tokens are permanent now — no expiry to check locally. Instead, do one real
  // liveness check on startup so a revoked/disabled account is caught early rather
  // than surfacing as a confusing "could not reach backend" on the next ad request.
  if (authStore.getUserId()) {
    sponsorClient.isSessionAlive().then(async (alive) => {
      if (alive !== false) return; // true, or undefined (network issue) — don't act
      if (await attemptSilentRecovery(context)) return;
      const action = await vscode.window.showWarningMessage(
        "DevCut: You've been signed out. Sign in again to keep earning.",
        "Re-activate", "Sign in with GitHub"
      );
      if (action === "Re-activate") {
        vscode.commands.executeCommand("devcut.activate");
      } else if (action === "Sign in with GitHub") {
        vscode.commands.executeCommand("devcut.signInWithGithub");
      }
    });
  }

  adBar.hide();
  sessionBar.hide();

  return {
    beginWait: (taskType?: string) => onLongRunningStart(context, taskType),
    endWait: () => onLongRunningEnd(),
  };
}

// ── Idle ads ────────────────────────────────────────────────────────────────

function stopIdleAds(): void {
  idleRotator?.stop();
  idleRotator = undefined;
}

function clearAllTimers(): void {
  clearTimeout(idleTimer);
  clearTimeout(profileTimer);
  idleTimer = undefined;
  profileTimer = undefined;
  stopIdleAds();
}

/**
 * Kill any running idle ad, then re-arm the idle countdown.
 * Called on every sign of user activity — and by onLongRunningStart, where the
 * activeTaskCount guard below makes it a pure "stop and stay stopped".
 */
function bumpActivity(): void {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  stopIdleAds();

  const config = vscode.workspace.getConfiguration("devcut");
  if (!config.get<boolean>("enabled", true)) return;
  if (!config.get<boolean>("idleAdsEnabled", true)) return;
  if (activeTaskCount > 0) return;             // build ads always win
  if (!vscode.window.state.focused) return;    // window in the background — nobody is looking
  if (!authStore?.getUserId()) return;         // not registered → no ad, same as builds

  // Floor of 30s, not 60s: an agent turn is tens of seconds, and a one-minute
  // minimum could never fire inside one.
  const minutes = Math.max(0.5, config.get<number>("idleMinutes", 1));
  idleTimer = setTimeout(() => {
    if (activeTaskCount > 0 || !vscode.window.state.focused) return;
    idleRotator = new AdRotator(adBar, sessionBar, sponsorClient, earningsStore, config, undefined, true);
    idleRotator.start();
  }, minutes * 60_000);
}

// ── One-time profile survey ─────────────────────────────────────────────────

// ponytail: a short list, not ISO-3166. Country is a free string server-side;
// swap in a full list if the targeting ever needs it.
const COUNTRIES = [
  "India", "United States", "Brazil", "Nigeria", "Indonesia", "Pakistan",
  "Bangladesh", "Philippines", "Germany", "United Kingdom", "Other",
];

// Re-entrancy guard: activation path and the startup nudge must never stack two surveys.
let profileInFlight = false;

async function maybeAskProfile(context: vscode.ExtensionContext, force = false): Promise<void> {
  if (profileInFlight) return;
  if (!authStore?.getUserId()) return;
  if (activeTaskCount > 0) return; // never interrupt a build

  profileInFlight = true;
  try {
    // Company/university name is mandatory — no ad-serving (no earnings) until it's
    // answered server-side (see GET /v1/sponsor-line). Keeps re-asking every trigger
    // until filled in; unlike the optional survey below, it never gives up.
    if (!context.globalState.get<boolean>(COMPANY_DONE)) {
      const company = await vscode.window.showInputBox({
        title: "DevCut — company or university name (required to earn)",
        prompt: "This is required before ads can start showing.",
        ignoreFocusOut: false,
        validateInput: (v) => (v.trim() ? undefined : "Required"),
      });
      if (company?.trim()) {
        if (await sponsorClient.saveProfile({ company: company.trim() })) {
          await context.globalState.update(COMPANY_DONE, true);
        }
      }
    }

    if (!force) {
      if (context.globalState.get<boolean>(PROFILE_DONE)) return;
      if (context.globalState.get<number>(PROFILE_SKIPS, 0) >= 2) return;
    }

    const ask = (placeHolder: string, items: string[]) =>
      vscode.window.showQuickPick(items, {
        placeHolder,
        title: "DevCut — 3 quick questions (Esc to skip)",
      });

    // Chained: an Esc at any step ends the survey and keeps whatever came before.
    const experienceLevel = await ask("Your experience level?", ["student", "junior", "mid", "senior"]);
    const primaryStack = experienceLevel
      ? await ask("Your primary stack?", ["node", "python", "go", "java", "rust", "php", "other"])
      : undefined;
    const country = primaryStack ? await ask("Where are you based?", COUNTRIES) : undefined;

    if (!experienceLevel && !primaryStack && !country) {
      await context.globalState.update(PROFILE_SKIPS, context.globalState.get<number>(PROFILE_SKIPS, 0) + 1);
      return;
    }

    if (await sponsorClient.saveProfile({ experienceLevel, primaryStack, country })) {
      await context.globalState.update(PROFILE_DONE, true);
    }
  } finally {
    profileInFlight = false;
  }
}

function onLongRunningStart(context: vscode.ExtensionContext, taskType?: string) {
  const config = vscode.workspace.getConfiguration("devcut");
  if (!config.get<boolean>("enabled", true)) return;

  // Guard: if never registered, show a one-time nudge then bail — no token, no ad.
  if (!authStore.getUserId()) {
    const hintKey = "devcut.taskHintShown";
    if (!context.globalState.get<boolean>(hintKey)) {
      context.globalState.update(hintKey, true);
      vscode.window.showInformationMessage(
        "⚡ DevCut: Activate to earn ₹ on this build!",
        "Activate Now", "Get Code"
      ).then((a) => {
        if (a === "Activate Now") vscode.commands.executeCommand("devcut.activate");
        if (a === "Get Code")     vscode.commands.executeCommand("devcut.openWebsite");
      });
    }
    return;
  }

  activeTaskCount++;
  bumpActivity(); // stops any idle ad and leaves the countdown disarmed while a task runs

  if (activeTaskCount === 1) {
    activeRotator?.cancelFlash();
    activeRotator = new AdRotator(adBar, sessionBar, sponsorClient, earningsStore, config, taskType);
    activeRotator.start();
  }
}

function onLongRunningEnd() {
  activeTaskCount = Math.max(0, activeTaskCount - 1);
  if (activeTaskCount === 0 && activeRotator) {
    activeRotator.stop();
    activeRotator = undefined;
    bumpActivity(); // re-arm the idle countdown now that the build is done
  }
}

export function deactivate() {
  deactivated = true;
  pendingUpdateVersion = undefined;
  clearAllTimers();
  if (activeRotator) {
    activeRotator.cancelFlash();
  }
}
