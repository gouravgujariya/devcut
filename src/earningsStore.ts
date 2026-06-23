import * as vscode from "vscode";
import { randomUUID } from "crypto";

const KEY_USER_ID        = "devcut.localUserId";
const KEY_TOTAL_PAISE    = "devcut.totalEarningsPaise";
const KEY_IMPRESSIONS    = "devcut.impressionCount";
const KEY_SERVER_PAISE   = "devcut.serverBalancePaise";
const KEY_SERVER_FETCHED = "devcut.serverBalanceFetchedAt"; // unix ms

/**
 * Lightweight local mirror of earnings, so the user gets instant feedback
 * ("Show My Earnings") without a network round trip. The backend remains
 * the source of truth for actual payouts — this is a UX cache, not a ledger.
 */
export class EarningsStore {
  private sessionPaise = 0;

  constructor(private context: vscode.ExtensionContext) {
    if (!this.context.globalState.get<string>(KEY_USER_ID)) {
      this.context.globalState.update(KEY_USER_ID, randomUUID());
    }
  }

  getUserId(): string {
    return this.context.globalState.get<string>(KEY_USER_ID) ?? "unknown";
  }

  getTotalEarningsPaise(): number {
    return this.context.globalState.get<number>(KEY_TOTAL_PAISE, 0);
  }

  getImpressionCount(): number {
    return this.context.globalState.get<number>(KEY_IMPRESSIONS, 0);
  }

  recordImpression(payoutPaise: number): void {
    const total = this.getTotalEarningsPaise() + payoutPaise;
    const count = this.getImpressionCount() + 1;
    this.context.globalState.update(KEY_TOTAL_PAISE, total);
    this.context.globalState.update(KEY_IMPRESSIONS, count);
  }

  // ── Session tracking (in-memory; resets on reload) ──────────────────────

  startSession(): void {
    this.sessionPaise = 0;
  }

  endSession(): void {
    this.sessionPaise = 0;
  }

  recordSessionImpression(payoutPaise: number): void {
    this.sessionPaise += payoutPaise;
    this.recordImpression(payoutPaise);
  }

  getSessionEarningsPaise(): number {
    return this.sessionPaise;
  }

  // ── Server-verified balance (persisted in globalState) ───────────────────

  setServerBalance(paise: number): void {
    this.context.globalState.update(KEY_SERVER_PAISE, paise);
    this.context.globalState.update(KEY_SERVER_FETCHED, Date.now());
  }

  getServerBalance(): number | undefined {
    return this.context.globalState.get<number>(KEY_SERVER_PAISE);
  }

  getServerBalanceFetchedAt(): number {
    return this.context.globalState.get<number>(KEY_SERVER_FETCHED, 0);
  }
}
