import * as vscode from "vscode";
import { SponsorClient, EarningsSummary, WithdrawalRecord, SponsorLine } from "./sponsorClient";
import { EarningsStore } from "./earningsStore";

let panel: vscode.WebviewPanel | undefined;

const DEFAULT_MIN_WITHDRAW_PAISE = 5000; // ₹50 — mirrored from server; server value wins when present

export async function showEarningsPanel(
  context: vscode.ExtensionContext,
  client: SponsorClient,
  store: EarningsStore
): Promise<void> {
  if (panel) {
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel(
      "devcutEarnings",
      "DevCut — My Earnings",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === "withdraw") {
        await vscode.commands.executeCommand("devcut.withdraw");
        await render(client, store);
      } else if (msg.command === "setUpi") {
        await vscode.commands.executeCommand("devcut.setUpiId");
        await render(client, store);
      } else if (msg.command === "refresh") {
        await render(client, store);
      }
    }, null, context.subscriptions);
  }
  await render(client, store);
}

async function render(client: SponsorClient, store: EarningsStore): Promise<void> {
  if (!panel) return;
  panel.webview.html = loadingHtml();
  const [earnings, history, me, sponsor] = await Promise.all([
    client.fetchEarnings(),
    client.fetchWithdrawalHistory(),
    client.fetchMe(),
    client.fetchCurrentLine(), // read-only: impressions are a separate POST, so this pays nobody
  ]);
  if (earnings) store.setServerBalance(earnings.totalPaise);
  if (!panel) return; // closed while fetching
  panel.webview.html = dashboardHtml(earnings, history, me?.user.upi_id, store, sponsor);
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const dateStr = (unixSec?: number | null) =>
  unixSec ? new Date(unixSec * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

// CSP must live in <head> to be honoured. `img-src https:` is what lets the
// advertiser logo load; everything else stays locked to 'none'. The inline
// 'unsafe-inline' entries are for this file's own <style> and onclick handlers.
const CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';";

function head(): string {
  return `<head><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.3em; letter-spacing: -.02em; }
    .muted { color: var(--vscode-descriptionForeground); }
    .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
    .balance { font-size: 2.2em; font-weight: 800; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .stat .n { font-size: 1.3em; font-weight: 700; }
    .stat .l { font-size: .8em; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 8px 18px; cursor: pointer; font-size: 1em; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .bar { height: 8px; background: var(--vscode-progressBar-background, #333); border-radius: 4px; overflow: hidden; opacity: .9; margin: 10px 0 6px; }
    .bar > div { height: 100%; background: var(--vscode-charts-green, #2ea043); }
    table { width: 100%; border-collapse: collapse; font-size: .92em; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    .pill { padding: 2px 8px; border-radius: 10px; font-size: .85em; }
    .pill.pending { background: rgba(210,153,34,.2); color: var(--vscode-charts-yellow, #d29922); }
    .pill.completed { background: rgba(46,160,67,.2); color: var(--vscode-charts-green, #2ea043); }
    .pill.rejected { background: rgba(248,81,73,.2); color: var(--vscode-charts-red, #f85149); }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .logo { width: 44px; height: 44px; object-fit: contain; border-radius: 6px; background: rgba(127,127,127,.12); flex: none; }
  </style></head>`;
}

function loadingHtml(): string {
  return `<!DOCTYPE html><html>${head()}<body><p class="muted">Loading your earnings…</p></body></html>`;
}

/** "Currently sponsored by" card — the only place a webview can show the advertiser logo. */
function sponsorCard(line: SponsorLine | undefined): string {
  if (!line) return "";
  // Only https logos: anything else is either untrustworthy or blocked by the CSP anyway.
  const logo = line.logoUrl && /^https:\/\//i.test(line.logoUrl)
    ? `<img class="logo" src="${esc(line.logoUrl)}" alt="">`
    : "";
  if (!logo && !line.advertiser) return "";
  return `<div class="card row" style="justify-content:flex-start">
      ${logo}
      <div style="flex:1;min-width:180px">
        <div class="muted" style="font-size:.85em">Currently sponsored by</div>
        <div style="font-weight:700">${esc(line.advertiser || "a DevCut sponsor")}</div>
        <div class="muted">${esc(line.text)}</div>
      </div>
    </div>`;
}

function dashboardHtml(
  earnings: EarningsSummary | undefined,
  history: WithdrawalRecord[] | undefined,
  upiId: string | undefined,
  store: EarningsStore,
  sponsor?: SponsorLine
): string {
  // Offline fallback: local tally only, no cashout
  if (!earnings) {
    return `<!DOCTYPE html><html>${head()}<body>
      <h1>⚡ DevCut Earnings</h1>
      <div class="card">
        <p>⚠️ Could not reach the DevCut backend — showing your local tally.</p>
        <div class="balance">${rupees(store.getTotalEarningsPaise())}</div>
        <p class="muted">${store.getImpressionCount()} impressions (local, unverified)</p>
        <button onclick="vscode.postMessage({command:'refresh'})">Retry</button>
      </div>
      <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
  }

  const min = earnings.minWithdrawPaise ?? DEFAULT_MIN_WITHDRAW_PAISE;
  const withdrawn = earnings.withdrawnPaise ?? 0;
  const available = earnings.availablePaise ?? earnings.totalPaise - withdrawn;
  const pending = earnings.pendingWithdrawal ?? history?.some((w) => w.status === "pending") ?? false;

  // Cashout limit logic — mirrors the server rules, shown to the user up front
  let blockReason = "";
  if (pending) blockReason = "A withdrawal is already being processed — payouts arrive within 7 days.";
  else if (!upiId) blockReason = "Set your UPI ID to enable withdrawals.";
  else if (available < min) blockReason = `${rupees(min - available)} more to reach the ${rupees(min)} minimum.`;
  const canWithdraw = !blockReason;
  const pct = Math.min(100, Math.round((available / min) * 100));

  const rows = (history ?? [])
    .map(
      (w) => `<tr>
        <td>${dateStr(w.created_at)}</td>
        <td>${rupees(w.amount_paise)}</td>
        <td>${esc(w.upi_id)}</td>
        <td><span class="pill ${esc(w.status)}">${esc(w.status)}</span></td>
        <td>${w.status === "pending" ? "within 7 days" : dateStr(w.resolved_at)}</td>
        <td class="muted">${esc(w.ref || "—")}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html><html>${head()}<body>
    <div class="row">
      <h1>⚡ DevCut Earnings</h1>
      <button class="secondary" onclick="vscode.postMessage({command:'refresh'})">↻ Refresh</button>
    </div>

    <div class="card">
      <div class="muted">Available to withdraw</div>
      <div class="balance">${rupees(available)}</div>
      ${available < min ? `<div class="bar"><div style="width:${pct}%"></div></div>` : ""}
      <p class="muted">${blockReason || "You can cash out now. Payouts are sent to your UPI within 7 days."}</p>
      <div class="row">
        <button ${canWithdraw ? "" : "disabled"} onclick="vscode.postMessage({command:'withdraw'})">Withdraw to UPI</button>
        <span class="muted">UPI: ${upiId ? esc(upiId) : "not set"}
          <button class="secondary" onclick="vscode.postMessage({command:'setUpi'})">${upiId ? "Change" : "Set UPI ID"}</button>
        </span>
      </div>
    </div>

    ${sponsorCard(sponsor)}

    <div class="card grid">
      <div class="stat"><div class="n">${rupees(earnings.totalPaise)}</div><div class="l muted">Lifetime earned</div></div>
      <div class="stat"><div class="n">${earnings.impressionCount}</div><div class="l muted">Impressions</div></div>
      <div class="stat"><div class="n">${rupees(withdrawn)}</div><div class="l muted">Withdrawn</div></div>
    </div>

    <div class="card">
      <div class="muted" style="margin-bottom:8px">Payout history</div>
      ${rows
        ? `<table><tr><th>Requested</th><th>Amount</th><th>UPI</th><th>Status</th><th>Paid</th><th>Ref</th></tr>${rows}</table>`
        : `<p class="muted">No withdrawals yet. Earn ${rupees(min)} to unlock your first payout.</p>`}
    </div>

    <script>const vscode = acquireVsCodeApi();</script>
  </body></html>`;
}
