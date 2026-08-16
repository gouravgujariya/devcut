import * as vscode from "vscode";
import { SponsorClient, SponsorLine } from "./sponsorClient";
import { EarningsStore } from "./earningsStore";

export class AdRotator {
  private stopped = false;
  private pendingShowTimer?: NodeJS.Timeout;
  private rotationInterval?: NodeJS.Timeout;
  private flashTimer?: NodeJS.Timeout;
  private currentLine?: SponsorLine;

  constructor(
    private bar: vscode.StatusBarItem,
    private sessionBar: vscode.StatusBarItem,
    private client: SponsorClient,
    private store: EarningsStore,
    private config: vscode.WorkspaceConfiguration,
    private taskType?: string,
    /** Idle mode: lower-paying inventory, slower rotation, silent exit. */
    private idle = false
  ) {
    // Label idle impressions so they get their own byTaskType row instead of an
    // unattributed null. Only ever fires for the idle rotator (always built with
    // taskType undefined) — a build's npm/docker/cargo taskType is never touched.
    if (idle) this.taskType = "idle";
  }

  start(): void {
    this.store.startSession();
    // Idle mode already waited out devcut.idleMinutes — no extra anti-flicker delay needed.
    const minMs = this.idle ? 0 : this.config.get<number>("minTaskSeconds", 3) * 1000;
    this.pendingShowTimer = setTimeout(() => this.firstShow(), minMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pendingShowTimer);
    clearInterval(this.rotationInterval);
    const paise = this.store.getSessionEarningsPaise();
    this.store.endSession();
    // ponytail: idle ads exit silently. stop() fires the instant the user types —
    // a "you earned ₹X" flash right then is exactly the interruption idle mode must not cause.
    if (this.idle) {
      this.bar.hide();
      return;
    }
    this.flash(paise);
  }

  cancelFlash(): void {
    clearTimeout(this.flashTimer);
    this.bar.hide();
    this.bar.backgroundColor = undefined;
  }

  getCurrentLine(): SponsorLine | undefined {
    return this.currentLine;
  }

  private async firstShow(): Promise<void> {
    if (this.stopped) return;
    await this.rotate();
    const rotMs = this.idle
      ? this.config.get<number>("idleAdRotationSeconds", 120) * 1000
      : this.config.get<number>("adRotationSeconds", 30) * 1000;
    this.rotationInterval = setInterval(() => this.rotate(), rotMs);
  }

  private async rotate(): Promise<void> {
    if (this.stopped) return;
    try {
      const line = await this.client.fetchCurrentLine(this.taskType, this.idle);
      if (!line || !line.impressionToken || this.stopped) {
        this.bar.hide();
        return;
      }
      // Paid-display invariant: record the impression BEFORE showing the ad.
      // A rejected impression (429/budget exhausted/duplicate) pays nothing —
      // showing it anyway would give the advertiser a free ad and the dev ₹0.
      const accepted = await this.client.recordImpression(line.impressionToken, this.taskType);
      if (!accepted || this.stopped) {
        this.bar.hide();
        return;
      }
      this.currentLine = line;
      this.bar.text = `$(megaphone) ${line.text}`;
      this.bar.tooltip = `Sponsored — click to learn more. ${line.advertiser ?? ""}`;
      this.bar.show();
      this.store.recordSessionImpression(line.payoutPaise ?? 0);
      const rupees = (this.store.getSessionEarningsPaise() / 100).toFixed(2);
      this.sessionBar.text = `$(coin) ₹${rupees} this session`;
      this.sessionBar.show();
    } catch {
      // fail silently — never block the user's task on ad errors
    }
  }

  private flash(paise: number): void {
    if (paise === 0) {
      this.bar.hide();
      return;
    }
    const rupees = (paise / 100).toFixed(2);
    this.bar.text = `$(check) Earned ₹${rupees} this build`;
    this.bar.tooltip = "";
    this.bar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.bar.show();
    const flashMs = this.config.get<number>("earningsFlashSeconds", 4) * 1000;
    this.flashTimer = setTimeout(() => {
      this.bar.hide();
      this.bar.backgroundColor = undefined;
    }, flashMs);
  }
}
