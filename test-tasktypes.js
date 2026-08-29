// Guards the command matcher behind the status-bar ad trigger.
// Run: npm run compile && node test-tasktypes.js
//
// This exists because the bug it catches was silent and cost real revenue: the map
// used to key on "claude " with a trailing space and match with startsWith, so every
// BARE invocation — `claude`, `make`, `aider`, `mvn` — failed to match and no ad ever
// fired. Nothing crashed; impressions just quietly never happened.
const assert = require("assert");
const { detectTaskType, isReplCommand } = require("./out/taskTypes");

// Bare commands: the whole point. Every one of these was broken.
assert.strictEqual(detectTaskType("claude"), "claude", "bare `claude` is how Claude Code is launched");
assert.strictEqual(detectTaskType("make"), "make", "bare `make` is a normal build");
assert.strictEqual(detectTaskType("aider"), "aider");
assert.strictEqual(detectTaskType("mvn"), "maven");
assert.strictEqual(detectTaskType("gradle"), "gradle");

// With arguments, and with leading whitespace.
assert.strictEqual(detectTaskType("claude --resume"), "claude");
assert.strictEqual(detectTaskType("  npm run build"), "npm");
assert.strictEqual(detectTaskType("docker compose up -d"), "docker");

// Two-word keys must beat the bare binary, so slow git work fires...
assert.strictEqual(detectTaskType("git clone https://example.com/x.git"), "git");
assert.strictEqual(detectTaskType("git pull"), "git");
assert.strictEqual(detectTaskType("go build ./..."), "go");
// ...while instant git commands stay silent. An ad that flashes on `git status`
// is worse than no ad — that flicker is what the trailing spaces were guarding.
assert.strictEqual(detectTaskType("git status"), undefined, "`git status` must not trigger an ad");
assert.strictEqual(detectTaskType("git"), undefined, "bare `git` must not trigger an ad");

// Unknown and empty input.
assert.strictEqual(detectTaskType("ls -la"), undefined);
assert.strictEqual(detectTaskType(""), undefined);
assert.strictEqual(detectTaskType("   "), undefined);

// Substring collisions must not match: only whole command words count.
assert.strictEqual(detectTaskType("makefile-lint"), undefined, "prefix-of-a-word must not match `make`");
assert.strictEqual(detectTaskType("claudecode"), undefined);

// REPLs are detected as task types but must NOT start a task rotator — they hold one
// shell execution open for the whole session, so idle detection owns the waits inside.
assert.ok(isReplCommand("claude"), "bare `claude` is a REPL session");
assert.ok(isReplCommand("claude --resume"));
assert.ok(isReplCommand("aider"));
assert.ok(!isReplCommand("npm run build"), "a normal build is not a REPL");
assert.ok(!isReplCommand("make"));
assert.ok(!isReplCommand(""));

console.log("test-tasktypes: all assertions passed");
