import * as vscode from "vscode";
import { SponsorClient, SponsorLine } from "./sponsorClient";
import { EarningsStore } from "./earningsStore";
import { DwellTracker } from "./dwellTracker";

/**
 * Impression tokens die at 90s. Render one at 89s and the impression POST loses a
 * race it did not need to enter, so a buffered line is dropped well before that.
 */
const TOKEN_SAFE_MS = 75_000;

/** Cold/stale buffer retry. Short so the FIRST line of a build isn't a whole rotation late. */
const RETRY_MS = 2_000;

/**
 * Holds exactly ONE pre-authorised line so rotate() never awaits the network on the
 * path to bar.show(). Two sequential 8s-timeout round-trips used to gate the first
 * render, which meant a 10s `npm install` could finish before its ad appeared.
 *
 * Depth is 1 on purpose: GET /v1/sponsor-line reserves budget server-side and only one
 * reservation may be outstanding per user. Do not raise it — a deeper buffer would
 * either be rejected or strand held budget.
 */
export class LineBuffer {
  private line?: SponsorLine;
  private fetchedAt = 0;
  private inFlight = false;

  constructor(
    private fetch: () => Promise<SponsorLine | undefined>,
    private now: () => number = Date.now,
    private maxAgeMs = TOKEN_SAFE_MS
  ) {}

  /** Synchronous by contract — the render path must never await. */
  take(): SponsorLine | undefined {
    const line = this.line;
    this.line = undefined;
    if (!line) return undefined;
    // Dead-token guard: showing it would render an ad nobody can be billed for.
    if (this.now() - this.fetchedAt > this.maxAgeMs) return undefined;
    return line;
  }

  /** Background refill. At most one fetch in flight — see the depth-1 note above. */
  refill(): void {
    if (this.line || this.inFlight) return;
    this.inFlight = true;
    this.fetch()
      .then((line) => {
        // No token means the server declined (budget, targeting, unfinished profile) —
        // buffering it would only produce an unbillable render later.
        if (line?.impressionToken) {
          this.line = line;
          this.fetchedAt = this.now();
        }
      })
      .catch(() => undefined)
      .then(() => {
        this.inFlight = false;
      });
  }

  clear(): void {
    this.line = undefined;
  }
}

export class AdRotator {
  private stopped = false;
  private pendingShowTimer?: NodeJS.Timeout;
  private rotationInterval?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private flashTimer?: NodeJS.Timeout;
  private currentLine?: SponsorLine;
  private dwell?: DwellTracker;
  private dwellToken?: string;
  private buffer: LineBuffer;

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
    this.buffer = new LineBuffer(() => this.client.fetchCurrentLine(this.taskType, this.idle));
  }

  start(): void {
    this.store.startSession();
    // Prefetch NOW, before the anti-flicker wait: minTaskSeconds is dead time that
    // pays for the fetch, so the first line renders the instant the wait is over.
    this.buffer.refill();
    // Idle mode already waited out devcut.idleMinutes — no extra anti-flicker delay needed.
    const minMs = this.idle ? 0 : this.config.get<number>("minTaskSeconds", 3) * 1000;
    this.pendingShowTimer = setTimeout(() => this.firstShow(), minMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pendingShowTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.rotationInterval);
    // Report the last line's dwell too, or every build silently loses its final
    // (and longest-viewed) impression.
    this.flushDwell();
    this.buffer.clear();
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

  private firstShow(): void {
    if (this.stopped) return;
    this.rotate();
    const rotMs = this.idle
      ? this.config.get<number>("idleAdRotationSeconds", 120) * 1000
      : this.config.get<number>("adRotationSeconds", 30) * 1000;
    this.rotationInterval = setInterval(() => this.rotate(), rotMs);
  }

  /**
   * Synchronous by design: buffer -> bar.show() with nothing awaited in between.
   * The impression POST now REPORTS a render that already happened, so it is fired
   * after the fact and never gates the pixels.
   */
  private rotate(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);

    const line = this.buffer.take();
    if (!line || !line.impressionToken) {
      // Cold or stale buffer. Deliberately DO NOT hide: a transient 429 or a Railway
      // cold start used to blank the status bar mid-build. Keep whatever is up and
      // try again shortly.
      this.buffer.refill();
      this.retryTimer = setTimeout(() => this.rotate(), RETRY_MS);
      return;
    }

    this.flushDwell(); // close out the line being replaced
    this.currentLine = line;
    this.bar.text = `$(megaphone) ${line.text}`;
    this.bar.tooltip = `Sponsored — click to learn more. ${line.advertiser ?? ""}`;
    this.bar.show();
    this.dwell = new DwellTracker();
    this.dwellToken = line.impressionToken;

    // Fire-and-forget, and refill only once it has landed: the server allows a single
    // outstanding reservation, so the next GET must not overtake this POST.
    void this.client
      .recordImpression(line.impressionToken, this.taskType)
      .catch(() => false)
      .then(() => {
        if (!this.stopped) this.buffer.refill();
      });

    // ponytail: EarningsStore stays optimistic — it is a UX cache, not a ledger.
    // The server's settled balance overwrites it on sync.
    this.store.recordSessionImpression(line.payoutPaise ?? 0);
    const rupees = (this.store.getSessionEarningsPaise() / 100).toFixed(2);
    this.sessionBar.text = `$(coin) ₹${rupees} this session`;
    this.sessionBar.show();
  }

  /** Ends the current dwell measurement and ships it. Safe to call with nothing running. */
  private flushDwell(): void {
    const tracker = this.dwell;
    const token = this.dwellToken;
    this.dwell = undefined;
    this.dwellToken = undefined;
    if (!tracker || !token) return;
    const { visibleMs, focusedMs } = tracker.stop();
    if (visibleMs <= 0) return;
    void this.client.reportDwell(token, visibleMs, focusedMs);
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
