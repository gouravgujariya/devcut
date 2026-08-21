// Runs outside the extension host on `vscode:uninstall` — plain Node, no `vscode` import
// available here. Best-effort: delete the plaintext session.json mirror authStore.ts
// keeps for this hook, so no token is left on disk. Deliberately does NOT revoke the
// session server-side — the keychain token survives a reinstall, so a manual .vsix
// update would otherwise sign the user out. Never throws — an uninstall must never
// fail because of this.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

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

function main() {
  try {
    const sessionPath = path.join(globalStorageDir(), "session.json");
    fs.rmSync(sessionPath, { force: true });
  } catch {
    // Missing dir, permissions, whatever — best-effort only.
  }
}

main();
