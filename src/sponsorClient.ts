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
  private onAuthExpired?: () => Promise<boolean>;
  private refreshInFlight?: Promise<boolean>;

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

  /** Called when the access token is rejected mid-session. Should refresh + store new tokens; returns true on success. */
  setAuthRefresher(fn: () => Promise<boolean>): void {
    this.onAuthExpired = fn;
  }

  /**
   * Single-flight token refresh — the only entry point that should ever trigger one.
   * Refresh tokens rotate on use, so two concurrent refreshes race: the loser sends
   * an already-revoked token and gets a false "session expired". Callers (startup
   * check, mid-request 401 handling) must all funnel through here, not call
   * refreshAccessToken() directly, so they share the same in-flight attempt.
   */
  async refreshIfNeeded(): Promise<boolean> {
    if (!this.onAuthExpired) return false;
    this.refreshInFlight ??= this.onAuthExpired().finally(() => (this.refreshInFlight = undefined));
    return this.refreshInFlight;
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
  async recordImpression(lineId: string, taskType?: string): Promise<boolean> {
    try {
      const data = await this.request("POST", "/v1/impressions", { lineId, taskType });
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

  // ── Auth ─────────────────────────────────────────────────────────────────

  async register(inviteCode: string): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    // request() now rejects with an Error whose message is the backend error code.
    // Network failures resolve to undefined — treat those as a generic failure.
    const data = await this.request("POST", "/v1/register", { inviteCode }, { skipAuth: true });
    if (!data) throw new Error("Registration failed — could not reach backend");
    return JSON.parse(data) as { accessToken: string; refreshToken: string; userId: string };
  }

  async login(inviteCode: string): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    // request() rejects with an Error whose message is the backend error code
    // (e.g. "invalid_code", "account_revoked"). Network failures resolve to undefined.
    const data = await this.request("POST", "/v1/login", { inviteCode }, { skipAuth: true });
    if (!data) throw new Error("Login failed — could not reach backend");
    return JSON.parse(data) as { accessToken: string; refreshToken: string; userId: string };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | undefined> {
    // Does NOT use the Authorization header — the refresh token is the credential.
    try {
      const data = await this.request("POST", "/v1/token/refresh", { refreshToken }, { skipAuth: true });
      if (!data) return undefined;
      return JSON.parse(data) as { accessToken: string; refreshToken: string };
    } catch {
      return undefined;
    }
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
      const data = await this.request("PUT", "/v1/profile/upi", { upiId });
      return !!data;
    } catch {
      return false;
    }
  }

  async requestWithdrawal(): Promise<{ ok: boolean; amountPaise?: number; message?: string; error?: string } | undefined> {
    try {
      const data = await this.request("POST", "/v1/withdraw");
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
    opts?: { skipAuth?: boolean }
  ): Promise<string | undefined> {
    try {
      return await this.requestOnce(method, path, body, opts);
    } catch (err: any) {
      // Access tokens live 1 day but VS Code windows live longer — refresh once and retry.
      const authFailed = err?.message === "token_expired" || err?.message === "invalid_token";
      if (authFailed && !opts?.skipAuth && (await this.refreshIfNeeded())) {
        return this.requestOnce(method, path, body, opts);
      }
      throw err;
    }
  }

  private async requestOnce(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    opts?: { skipAuth?: boolean }
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

        const req = lib.request(url, { method, headers, timeout: 3000 }, (res) => {
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
                reject(new Error(code));
              } catch {
                reject(new Error(`http_${status}`));
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
