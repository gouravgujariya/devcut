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
    private taskType?: string
  ) {}

  start(): void {
    this.store.startSession();
    const minMs = this.config.get<number>("minTaskSeconds", 3) * 1000;
    this.pendingShowTimer = setTimeout(() => this.firstShow(), minMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pendingShowTimer);
    clearInterval(this.rotationInterval);
    const paise = this.store.getSessionEarningsPaise();
    this.store.endSession();
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
    const rotMs = this.config.get<number>("adRotationSeconds", 30) * 1000;
    this.rotationInterval = setInterval(() => this.rotate(), rotMs);
  }

  private async rotate(): Promise<void> {
    if (this.stopped) return;
    try {
      const line = await this.client.fetchCurrentLine(this.taskType);
      if (!line || this.stopped) return;
      this.currentLine = line;
      this.bar.text = `$(megaphone) ${line.text}`;
      this.bar.tooltip = `Sponsored — click to learn more. ${line.advertiser ?? ""}`;
      this.bar.show();
      // Only credit the local tally when the server accepts the impression,
      // so "Earned ₹X this build" never promises money the server won't pay.
      const accepted = await this.client.recordImpression(line.id, this.taskType);
      if (accepted) this.store.recordSessionImpression(line.payoutPaise ?? 0);
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
