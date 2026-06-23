import * as vscode from "vscode";
import { SponsorClient } from "./sponsorClient";
import { EarningsStore } from "./earningsStore";
import { AuthStore } from "./authStore";
import { AdRotator } from "./adRotator";

let adBar: vscode.StatusBarItem;
let sessionBar: vscode.StatusBarItem;
let readyBar: vscode.StatusBarItem;
let sponsorClient: SponsorClient;
let earningsStore: EarningsStore;
let authStore: AuthStore;
let activeTaskCount = 0;
let activeRotator: AdRotator | undefined;

// Maps terminal command prefixes → task type label sent to backend for targeting
const TASK_TYPE_MAP: Array<[string, string]> = [
  // AI tools (Claude Code support — v1.1)
  ["claude ",      "claude"],
  ["aider ",       "aider"],
  ["cursor ",      "cursor"],
  // Node / JS
  ["npm ",         "npm"],
  ["yarn ",        "yarn"],
  ["pnpm ",        "pnpm"],
  ["npx ",         "npx"],
  // Python
  ["pip ",         "pip"],
  ["pip3 ",        "pip"],
  ["poetry ",      "python"],
  ["uv ",          "python"],
  // Containers / infra
  ["docker ",      "docker"],
  ["kubectl ",     "k8s"],
  ["terraform ",   "terraform"],
  // Build systems
  ["gradle ",      "gradle"],
  ["mvn ",         "maven"],
  ["cargo ",       "rust"],
  ["go build",     "go"],
  ["make ",        "make"],
  ["cmake ",       "cmake"],
  // VCS
  ["git clone",    "git"],
  ["git pull",     "git"],
  ["git fetch",    "git"],
  // Ruby / PHP
  ["bundle install", "ruby"],
  ["composer install", "php"],
];

function detectTaskType(cmd: string): string | undefined {
  const trimmed = cmd.trimStart();
  for (const [prefix, type] of TASK_TYPE_MAP) {
    if (trimmed.startsWith(prefix)) return type;
  }
  return undefined;
}

function shouldTrackCommand(cmd: string): boolean {
  return detectTaskType(cmd) !== undefined;
}

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("devcut");

  authStore   = new AuthStore(context);
  earningsStore = new EarningsStore(context);

  sponsorClient = new SponsorClient(
    config.get<string>("backendUrl", "http://localhost:3000"),
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
  readyBar.text = "$(megaphone)";
  readyBar.tooltip = "DevCut — click to test ad";
  readyBar.command = "devcut.testAd";
  context.subscriptions.push(readyBar);
  readyBar.show();

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.handleClick", async () => {
      const line = activeRotator?.getCurrentLine();
      if (line) {
        await sponsorClient.recordClick(line.id);
        if (line.url) vscode.env.openExternal(vscode.Uri.parse(line.url));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.showEarnings", () => {
      const localRupees = earningsStore.getTotalEarningsPaise() / 100;
      const impressions = earningsStore.getImpressionCount();
      const serverPaise = earningsStore.getServerBalance();
      if (serverPaise !== undefined) {
        const serverRupees = (serverPaise / 100).toFixed(2);
        const fetchedAt = earningsStore.getServerBalanceFetchedAt();
        const minsAgo = Math.round((Date.now() - fetchedAt) / 60000);
        vscode.window.showInformationMessage(
          `DevCut — Server-verified: ₹${serverRupees} (synced ${minsAgo}m ago). ` +
          `Local tally: ₹${localRupees.toFixed(2)} across ${impressions} impressions.`
        );
      } else {
        vscode.window.showInformationMessage(
          `DevCut — Lifetime earnings: ₹${localRupees.toFixed(2)} across ${impressions} impressions.`
        );
      }
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

      try {
        const result = await sponsorClient.register(code.trim().toUpperCase());
        await authStore.setTokens(result.accessToken, result.refreshToken, result.userId);
        vscode.window.showInformationMessage(
          "DevCut activated! You will start earning on your next build."
        );
      } catch (err: any) {
        const msg = err?.message || "unknown error";
        vscode.window.showErrorMessage(
          msg === "invalid_or_used_code"
            ? "Invalid or already-used invite code. Contact the DevCut team."
            : `DevCut: activation failed — ${msg}`
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
        await authStore.setTokens(result.accessToken, result.refreshToken, result.userId);
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

  // ── Set UPI ID ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devcut.setUpiId", async () => {
      const upiId = await vscode.window.showInputBox({
        prompt: "Enter your UPI ID for earnings payout",
        placeHolder: "yourname@upi or phone@paytm",
        ignoreFocusOut: true,
        validateInput: (v) => v.includes("@") ? undefined : "UPI ID must contain @",
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
        vscode.window.showWarningMessage("You are already in a team. Use 'Kickback: Leave Team' first.");
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
          const cmd = e.execution.commandLine.value.trimStart();
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

  // Auto-sync server balance once per day on startup
  const oneDayMs = 86_400_000;
  if (Date.now() - earningsStore.getServerBalanceFetchedAt() > oneDayMs) {
    sponsorClient.fetchEarnings().then((result) => {
      if (result) earningsStore.setServerBalance(result.totalPaise);
    });
  }

  // Silently refresh the 1-day access token on startup if it has expired.
  // Uses the long-lived refresh token (rotated on each use).
  if (authStore.isAccessTokenExpired()) {
    authStore.getRefreshToken().then(async (rt) => {
      if (!rt) return;
      const result = await sponsorClient.refreshAccessToken(rt);
      if (result?.accessToken) {
        await authStore.setAccessToken(result.accessToken);
        await authStore.setRefreshToken(result.refreshToken);
      } else {
        const action = await vscode.window.showWarningMessage(
          "DevCut: Session expired. Re-enter your invite code to continue earning.",
          "Re-activate"
        );
        if (action === "Re-activate") {
          vscode.commands.executeCommand("devcut.activate");
        }
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

function onLongRunningStart(context: vscode.ExtensionContext, taskType?: string) {
  const config = vscode.workspace.getConfiguration("devcut");
  if (!config.get<boolean>("enabled", true)) return;

  activeTaskCount++;

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
  }
}

export function deactivate() {
  if (activeRotator) {
    activeRotator.cancelFlash();
  }
}
