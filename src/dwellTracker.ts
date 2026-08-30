import * as vscode from "vscode";

/**
 * Measurement window. Nothing beyond two minutes of a single line is worth
 * counting — the server clamps dwell to wall-clock anyway, and an unbounded
 * counter would let a machine left open overnight claim an eight-hour "view".
 */
const WINDOW_MS = 120_000;

/**
 * Focus-aware dwell accumulator for one displayed sponsor line.
 *
 * Two numbers, both capped at WINDOW_MS:
 *  - visibleMs: wall-clock the line was on the status bar
 *  - focusedMs: only the stretches where the VS Code window actually had focus
 *
 * ACCUMULATED, not continuous: alt-tabbing to a browser PAUSES the focused
 * clock and coming back RESUMES it. Resetting on blur would zero out the most
 * common real usage (start a build, read docs, come back) and under-report
 * every honest impression.
 */
export class DwellTracker {
  private readonly startedAt: number;
  /** Start of the current focused stretch; undefined means the window is blurred. */
  private focusedSince?: number;
  private focusedAccum = 0;
  private endedAt?: number;
  private sub?: vscode.Disposable;

  /** `now` is injectable so the harness can test the 120s cap without waiting 120s. */
  constructor(private now: () => number = Date.now) {
    this.startedAt = now();
    if (vscode.window.state.focused) this.focusedSince = this.startedAt;
    this.sub = vscode.window.onDidChangeWindowState((s) => this.setFocused(s.focused));
  }

  /**
   * Clamped clock: never past the end of the measurement window, and frozen at
   * stop(). Every arithmetic below reads time through here, so the cap falls out
   * of one place instead of a Math.min at each call site.
   */
  private clock(): number {
    return Math.min(this.endedAt ?? this.now(), this.startedAt + WINDOW_MS);
  }

  private setFocused(focused: boolean): void {
    if (focused === (this.focusedSince !== undefined)) return; // duplicate event — ignore
    const t = this.clock();
    if (focused) {
      this.focusedSince = t;
    } else {
      this.focusedAccum += Math.max(0, t - this.focusedSince!);
      this.focusedSince = undefined;
    }
  }

  /** Live read; safe to call before stop(). */
  snapshot(): { visibleMs: number; focusedMs: number } {
    const t = this.clock();
    const open = this.focusedSince !== undefined ? Math.max(0, t - this.focusedSince) : 0;
    return { visibleMs: t - this.startedAt, focusedMs: this.focusedAccum + open };
  }

  /**
   * Freezes the clocks, drops the window-state listener and returns the final
   * numbers. Idempotent — AdRotator calls it on rotation and again on stop(),
   * and a leaked listener per rotation would be a real leak over a long build.
   */
  stop(): { visibleMs: number; focusedMs: number } {
    if (this.endedAt === undefined) {
      this.endedAt = this.now();
      this.setFocused(false); // flush the open focused stretch against the frozen clock
    }
    this.sub?.dispose();
    this.sub = undefined;
    return this.snapshot();
  }
}
