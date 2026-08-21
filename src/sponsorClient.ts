import * as https from "https";
import * as http from "http";

export interface SponsorLine {
  id: string;
  text: string;
  advertiser?: string;
  url?: string;
  /** Advertiser logo. Remote URL — the status bar cannot render it; the earnings webview can. */
  logoUrl?: string | null;
  /** What this impression pays the developer, in paise (1/100 rupee). */
  payoutPaise?: number;
  /** Short-lived (90s) signed JWT — required to record the impression. */
  impressionToken?: string;
}

export interface EarningsSummary {
  totalPaise: number;
  impressionCount: number;
  // Fields below exist on newer backends only — treat as optional
  withdrawnPaise?: number;
  availablePaise?: number;
  pendingWithdrawal?: boolean;
  minWithdrawPaise?: number;
}

export interface WithdrawalRecord {
  id: number;
  amount_paise: number;
  upi_id: string;
  status: string;
  ref?: string | null;
  created_at: number;
  resolved_at?: number | null;
}

export interface UpdateEntry {
  version: string;
  date: string;
  title: string;
  notes: string[];
  critical?: boolean;
}

export interface UpdateInfo {
  latest: string;
  entries: UpdateEntry[];
}

/**
 * True if `a` is a newer version than `b`. Compares each dot-separated part as an
 * integer — a plain string compare would rank "0.1.10" *older* than "0.1.9".
 * Lives here (not in a new file) because both extension.ts and panel.ts need it.
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export interface TeamInfo {
  team: { id: string; name: string; code: string; ownerId: string };
  leaderboard: Array<{ user_id: string; total_paise: number; impression_count: number }>;
  teamTotalPaise: number;
  memberCount: number;
}

/**
 * Talks to the backend. All /v1/ calls include a Bearer JWT.
 * Pricing/auction/targeting logic lives server-side.
 */
export class SponsorClient {
  private token: (() => Promise<string | undefined>) | undefined;

  constructor(
    private backendUrl: string,
    private userId: string,
    tokenGetter?: () => Promise<string | undefined>
  ) {
    this.token = tokenGetter;
  }

  setTokenGetter(fn: () => Promise<string | undefined>): void {
    this.token = fn;
  }

  /**
   * Definitive session-liveness check. `false` only on a real 401/403 (session dead —
   * revoked, banned, or account disabled, since tokens never expire on their own). `undefined`
   * means "couldn't tell" (offline, timeout, server error) — never treated as dead.
   */
  async isSessionAlive(): Promise<boolean | undefined> {
    try {
      const data = await this.request("GET", "/v1/me");
      return data ? true : undefined; // request() resolves undefined on network failure
    } catch (err: any) {
      return err?.status === 401 || err?.status === 403 ? false : undefined;
    }
  }

  /** Best-effort server-side session revoke on sign-out. Never throws. */
  async logout(): Promise<void> {
    try {
      await this.request("DELETE", "/v1/logout");
    } catch {
      // Best-effort fire-and-forget.
    }
  }

  /** `idle` asks the server for the lower-paying idle inventory. */
  async fetchCurrentLine(taskType?: string, idle?: boolean): Promise<SponsorLine | undefined> {
    const params = new URLSearchParams();
    if (taskType) params.set("taskType", taskType);
    if (idle) params.set("idle", "1");
    const qs = params.toString() ? `?${params.toString()}` : "";
    try {
      const data = await this.request("GET", `/v1/sponsor-line${qs}`);
      if (!data) return undefined;
      return JSON.parse(data) as SponsorLine;
    } catch {
      return undefined;
    }
  }

  /** Returns true only if the server accepted (and will pay for) the impression. */
  async recordImpression(token: string, taskType?: string): Promise<boolean> {
    try {
      const data = await this.request("POST", "/v1/impressions", { token, taskType });
      return !!data;
    } catch {
      return false; // rejected (rate-limited) or unreachable — don't credit locally
    }
  }

  async recordClick(lineId: string): Promise<void> {
    try {
      await this.request("POST", "/v1/clicks", { lineId });
    } catch {
      // Best-effort fire-and-forget.
    }
  }

  async fetchEarnings(): Promise<EarningsSummary | undefined> {
    try {
      const data = await this.request("GET", "/v1/earnings");
      if (!data) return undefined;
      return JSON.parse(data) as EarningsSummary;
    } catch {
      return undefined;
    }
  }

  /** skipAuth: the .vsix has no Marketplace update prompt, so even a user who
   *  never activated deserves to hear that a newer build exists. */
  async fetchUpdates(): Promise<UpdateInfo | undefined> {
    try {
      const data = await this.request("GET", "/v1/updates", undefined, { skipAuth: true });
      if (!data) return undefined;
      return JSON.parse(data) as UpdateInfo;
    } catch {
      return undefined;
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  async register(inviteCode: string): Promise<{ token: string; userId: string }> {
    // request() now rejects with an Error whose message is the backend error code.
    // Network failures resolve to undefined — treat those as a generic failure.
    const data = await this.request("POST", "/v1/register", { inviteCode }, { skipAuth: true, timeoutMs: 20000 });
    if (!data) throw new Error("Registration failed — could not reach backend");
    return JSON.parse(data) as { token: string; userId: string };
  }

  async login(inviteCode: string): Promise<{ token: string; userId: string }> {
    // request() rejects with an Error whose message is the backend error code
    // (e.g. "invalid_code", "account_revoked"). Network failures resolve to undefined.
    const data = await this.request("POST", "/v1/login", { inviteCode }, { skipAuth: true, timeoutMs: 20000 });
    if (!data) throw new Error("Login failed — could not reach backend");
    return JSON.parse(data) as { token: string; userId: string };
  }

  /** Alternative to invite-code login: exchange a GitHub access token (from vscode.authentication) for our session token. */
  async loginWithGithub(githubAccessToken: string): Promise<{ token: string; userId: string }> {
    // request() rejects with an Error whose message is the backend error code
    // (e.g. "not_invited", "account_revoked"). Network failures resolve to undefined.
    const data = await this.request("POST", "/v1/auth/github", { accessToken: githubAccessToken }, { skipAuth: true, timeoutMs: 20000 });
    if (!data) throw new Error("GitHub sign-in failed — could not reach backend");
    return JSON.parse(data) as { token: string; userId: string };
  }

  async fetchMe(): Promise<{ user: { id: string; email: string; upi_id?: string }; team: TeamInfo | null } | undefined> {
    try {
      const data = await this.request("GET", "/v1/me");
      if (!data) return undefined;
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  /** One-time onboarding survey answers. All fields optional — send only what was answered. */
  async saveProfile(p: { experienceLevel?: string; primaryStack?: string; country?: string; company?: string }): Promise<boolean> {
    const body: Record<string, unknown> = {};
    if (p.experienceLevel) body.experienceLevel = p.experienceLevel;
    if (p.primaryStack) body.primaryStack = p.primaryStack;
    if (p.country) body.country = p.country;
    if (p.company) body.company = p.company;
    try {
      return !!(await this.request("POST", "/v1/me/profile", body));
    } catch {
      return false;
    }
  }

  // ── UPI & Withdrawals ────────────────────────────────────────────────────

  async setUpiId(upiId: string): Promise<boolean> {
    try {
      const data = await this.request("PUT", "/v1/profile/upi", { upiId }, { timeoutMs: 20000 });
      return !!data;
    } catch {
      return false;
    }
  }

  async requestWithdrawal(): Promise<{ ok: boolean; amountPaise?: number; message?: string; error?: string } | undefined> {
    try {
      const data = await this.request("POST", "/v1/withdraw", undefined, { timeoutMs: 20000 });
      if (!data) return undefined;
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  async fetchWithdrawalHistory(): Promise<WithdrawalRecord[] | undefined> {
    try {
      const data = await this.request("GET", "/v1/withdraw/history");
      if (!data) return undefined;
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  // ── Team Pool ────────────────────────────────────────────────────────────

  async createTeam(name: string): Promise<{ ok: boolean; teamId?: string; code?: string; error?: string } | undefined> {
    try {
      const data = await this.request("POST", "/v1/teams", { name });
      if (!data) return undefined;
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  async joinTeam(code: string): Promise<{ ok: boolean; teamId?: string; name?: string; error?: string } | undefined> {
    try {
      const data = await this.request("POST", "/v1/teams/join", { code });
      if (!data) return undefined;
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  async leaveTeam(): Promise<boolean> {
    try {
      const data = await this.request("DELETE", "/v1/teams/leave");
      return !!data;
    } catch {
      return false;
    }
  }

  async fetchTeamInfo(): Promise<TeamInfo | null | undefined> {
    try {
      const data = await this.request("GET", "/v1/teams/me");
      if (!data) return undefined;
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  // ── HTTP core ────────────────────────────────────────────────────────────

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    opts?: { skipAuth?: boolean; timeoutMs?: number }
  ): Promise<string | undefined> {
    const token = opts?.skipAuth ? undefined : await this.token?.();

    return new Promise((resolve, reject) => {
      try {
        const url = new URL(path, this.backendUrl);
        const lib = url.protocol === "https:" ? https : http;
        const payload = body ? JSON.stringify(body) : undefined;

        const headers: Record<string, string | number> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        if (payload) {
          headers["Content-Type"] = "application/json";
          headers["Content-Length"] = Buffer.byteLength(payload);
        }

        // 8s default: the Railway backend cold-starts and 3s killed every first request.
        const req = lib.request(url, { method, headers, timeout: opts?.timeoutMs ?? 8000 }, (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status === 200 || status === 201) {
              resolve(raw);
            } else {
              // Attempt to extract a machine-readable error code from the body
              // so callers can branch on specific error strings (e.g. "invalid_code").
              try {
                const parsed = JSON.parse(raw) as { error?: string; message?: string };
                const code = parsed.error ?? parsed.message ?? `http_${status}`;
                reject(Object.assign(new Error(code), { status }));
              } catch {
                reject(Object.assign(new Error(`http_${status}`), { status }));
              }
            }
          });
        });

        req.on("error", () => resolve(undefined));
        req.on("timeout", () => { req.destroy(); resolve(undefined); });

        if (payload) req.write(payload);
        req.end();
      } catch {
        resolve(undefined);
      }
    });
  }
}
