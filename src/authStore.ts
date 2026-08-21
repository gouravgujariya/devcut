import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const SECRET_TOKEN  = "devcut.sessionToken";
const STATE_USER_ID = "devcut.userId";

export class AuthStore {
  constructor(private context: vscode.ExtensionContext) {}

  // ── Session token ────────────────────────────────────────────────────────

  async getToken(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_TOKEN);
  }

  /** Stores the permanent session token on register/login/github-auth. */
  async setTokens(token: string, userId: string): Promise<void> {
    await this.context.secrets.store(SECRET_TOKEN, token);
    await this.context.globalState.update(STATE_USER_ID, userId);
    this.mirrorSessionFile(token, userId);
  }

  async clearToken(): Promise<void> {
    await this.context.secrets.delete(SECRET_TOKEN);
    await this.context.globalState.update(STATE_USER_ID, undefined);
    this.deleteSessionFile();
  }

  // ── User identity ─────────────────────────────────────────────────────────

  getUserId(): string | undefined {
    return this.context.globalState.get<string>(STATE_USER_ID);
  }

  async isRegistered(): Promise<boolean> {
    return !!(await this.getToken());
  }

  // ── Uninstall-time best-effort revoke ───────────────────────────────────
  // scripts/uninstall.js runs outside the extension host (no `vscode` import there),
  // so it can't read context.secrets. Mirror the token to a plain file it can read.

  private sessionFilePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, "session.json");
  }

  private mirrorSessionFile(token: string, userId: string): void {
    try {
      const backendUrl = vscode.workspace.getConfiguration("devcut").get<string>("backendUrl", "http://localhost:3000");
      fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
      fs.writeFileSync(this.sessionFilePath(), JSON.stringify({ token, userId, backendUrl }), { mode: 0o600 });
      fs.chmodSync(this.sessionFilePath(), 0o600); // mode above only applies on create — fix pre-existing 664 mirrors
    } catch {
      // Best-effort only — the uninstall cleanup is a nicety, not a requirement.
    }
  }

  private deleteSessionFile(): void {
    try {
      fs.rmSync(this.sessionFilePath(), { force: true });
    } catch {
      // Best-effort only.
    }
  }
}
