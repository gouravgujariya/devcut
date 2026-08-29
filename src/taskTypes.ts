// Keyed by the command WORD, not a string prefix. The old map keyed on "claude " —
// with a trailing space — and matched with startsWith, so a bare `claude` (how Claude
// Code is actually launched) never matched and no ad ever fired. Same for bare `make`,
// `aider`, `mvn`, `gradle`, `docker`. Two-word keys are checked first so `git clone`
// still fires while a bare `git status` correctly stays silent.
export const TASK_TYPES = new Map<string, string>([
  // AI tools
  ["claude", "claude"], ["aider", "aider"], ["cursor", "cursor"],
  // Node / JS
  ["npm", "npm"], ["yarn", "yarn"], ["pnpm", "pnpm"], ["npx", "npx"],
  // Python
  ["pip", "pip"], ["pip3", "pip"], ["poetry", "python"], ["uv", "python"],
  // Containers / infra
  ["docker", "docker"], ["kubectl", "k8s"], ["terraform", "terraform"],
  // Build systems
  ["gradle", "gradle"], ["mvn", "maven"], ["cargo", "rust"], ["go build", "go"],
  ["make", "make"], ["cmake", "cmake"],
  // VCS — only the slow subcommands, never bare `git`
  ["git clone", "git"], ["git pull", "git"], ["git fetch", "git"],
  // Ruby / PHP
  ["bundle install", "ruby"], ["composer install", "php"],
]);

// Interactive REPLs. These hold ONE shell execution open for the entire session, so
// treating them as a long-running task would pin an ad on screen while you read and
// type, not just while the agent works. Idle detection owns the gaps inside them
// instead — the same path that covers agents running in the sidebar with no terminal.
export const REPL_COMMANDS = new Set(["claude", "aider"]);

function commandWord(cmd: string): { bin: string; key: string } {
  const [bin = "", sub = ""] = cmd.trim().split(/\s+/);
  return { bin, key: `${bin} ${sub}` };
}

export function detectTaskType(cmd: string): string | undefined {
  const { bin, key } = commandWord(cmd);
  if (!bin) return undefined;
  return TASK_TYPES.get(key) ?? TASK_TYPES.get(bin);
}

export function isReplCommand(cmd: string): boolean {
  return REPL_COMMANDS.has(commandWord(cmd).bin);
}
