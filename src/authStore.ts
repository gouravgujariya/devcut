import * as vscode from "vscode";

const SECRET_ACCESS  = "devcut.accessToken";
const SECRET_REFRESH = "devcut.refreshToken";
const STATE_USER_ID  = "devcut.userId";
const STATE_EXPIRES  = "devcut.accessTokenExpiresAt"; // unix ms

export class AuthStore {
  constructor(private context: vscode.ExtensionContext) {}

  // ── Access token ─────────────────────────────────────────────────────────

  async getToken(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_ACCESS);
  }

  async setAccessToken(token: string): Promise<void> {
    await this.context.secrets.store(SECRET_ACCESS, token);
    // Store expiry as 23.5h from now — 30-min safety margin before 1-day JWT expires
    await this.context.globalState.update(STATE_EXPIRES, Date.now() + 23.5 * 3600 * 1000);
  }

  isAccessTokenExpired(): boolean {
    const expiresAt = this.context.globalState.get<number>(STATE_EXPIRES, 0);
    return Date.now() > expiresAt;
  }

  // ── Refresh token ─────────────────────────────────────────────────────────

  async getRefreshToken(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_REFRESH);
  }

  async setRefreshToken(token: string): Promise<void> {
    await this.context.secrets.store(SECRET_REFRESH, token);
  }

  // ── Combined set (on first registration) ──────────────────────────────────

  async setTokens(accessToken: string, refreshToken: string, userId: string): Promise<void> {
    await this.context.secrets.store(SECRET_ACCESS, accessToken);
    await this.context.secrets.store(SECRET_REFRESH, refreshToken);
    await this.context.globalState.update(STATE_USER_ID, userId);
    await this.context.globalState.update(STATE_EXPIRES, Date.now() + 23.5 * 3600 * 1000);
  }

  async clearToken(): Promise<void> {
    await this.context.secrets.delete(SECRET_ACCESS);
    await this.context.secrets.delete(SECRET_REFRESH);
    await this.context.globalState.update(STATE_USER_ID, undefined);
    await this.context.globalState.update(STATE_EXPIRES, undefined);
  }

  // ── User identity ─────────────────────────────────────────────────────────

  getUserId(): string | undefined {
    return this.context.globalState.get<string>(STATE_USER_ID);
  }

  async isRegistered(): Promise<boolean> {
    const token = await this.getToken();
    return !!token && !this.isAccessTokenExpired();
  }
}
