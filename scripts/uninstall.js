// Runs outside the extension host on `vscode:uninstall` — plain Node, no `vscode` import
// available here. Best-effort: read the session mirrored by authStore.ts and tell the
// backend to revoke it. Never throws — an uninstall must never fail because of this.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");

function globalStorageDir() {
  const pkg = require("../package.json");
  const id = `${pkg.publisher}.${pkg.name}`.toLowerCase();
  const home = os.homedir();
  // ponytail: covers stock VS Code ("Code") only, not Insiders/VSCodium/other forks —
  // their user-data-dir differs and this is a best-effort cleanup, not a hard requirement.
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "globalStorage", id);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Code", "User", "globalStorage", id);
  }
  return path.join(home, ".config", "Code", "User", "globalStorage", id);
}

function revoke(session) {
  return new Promise((resolve) => {
    try {
      const url = new URL("/v1/logout", session.backendUrl);
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        url,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.token}` },
          timeout: 3000,
        },
        (res) => {
          res.resume(); // drain, don't care about the body
          resolve();
        }
      );
      req.on("error", () => resolve());
      req.on("timeout", () => { req.destroy(); resolve(); });
      req.end();
    } catch {
      resolve();
    }
  });
}

async function main() {
  try {
    const sessionPath = path.join(globalStorageDir(), "session.json");
    const raw = fs.readFileSync(sessionPath, "utf8");
    const session = JSON.parse(raw);
    if (session && session.token && session.backendUrl) {
      await revoke(session);
    }
  } catch {
    // No session file, unreadable, offline, whatever — best-effort only.
  }
}

main();
