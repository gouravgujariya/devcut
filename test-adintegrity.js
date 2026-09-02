// Guards impression integrity: dwell measurement (Phase 2) and the buffered
// delivery pipeline (Phase 3).
// Run: npm run compile && node test-adintegrity.js
//
// These exist because both bugs they catch are silent and cost real money:
//  - an ad nobody looked at used to be indistinguishable from one that was read
//  - rotate() used to await two 8s-timeout round-trips before bar.show(), so the
//    first line of a 10s `npm install` could land after the build already finished
//  - a single 429 used to call bar.hide() and blank the sponsored line mid-build
const assert = require("assert");
const Module = require("module");

// ── vscode stub ────────────────────────────────────────────────────────────
// taskTypes.ts needs no stub (it imports nothing), but adRotator/dwellTracker do.
// Intercepting Module._load is the smallest way to satisfy `require("vscode")`
// outside the extension host — no bundler, no ambient file, no dependency.
const listeners = [];
const vscodeStub = {
  window: {
    state: { focused: true },
    onDidChangeWindowState(cb) {
      listeners.push(cb);
      return { dispose: () => listeners.splice(listeners.indexOf(cb), 1) };
    },
  },
  ThemeColor: class { constructor(id) { this.id = id; } },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscodeStub : origLoad.call(this, request, ...rest);
};
const setFocus = (focused) => {
  vscodeStub.window.state.focused = focused;
  listeners.slice().forEach((cb) => cb({ focused }));
};

const { DwellTracker } = require("./out/dwellTracker");
const { AdRotator, LineBuffer } = require("./out/adRotator");

const tick = () => new Promise((r) => setImmediate(r));
// Real sleep: dwell is measured with the real clock inside AdRotator, and a 0ms
// dwell is deliberately not reported.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Phase 2: dwell ─────────────────────────────────────────────────────────

// A fake clock, because asserting a 120s cap must not take 120 seconds.
let t = 1_000_000;
const now = () => t;

setFocus(true);
const d = new DwellTracker(now);
t += 5_000;                         // 5s focused
setFocus(false);
t += 60_000;                        // 60s in a browser — visible, not focused
setFocus(true);
t += 3_000;                         // 3s focused again
let r = d.snapshot();
assert.strictEqual(r.focusedMs, 8_000, "focused time must ACCUMULATE across a blur, not reset");
assert.strictEqual(r.visibleMs, 68_000, "visible time is wall-clock and keeps running while blurred");

// The 120s measurement window caps both numbers: a machine left open overnight
// must not be able to claim an eight-hour view of one line.
t += 300_000;
r = d.snapshot();
assert.strictEqual(r.visibleMs, 120_000, "visibleMs is capped at the 120s window");
assert.strictEqual(r.focusedMs, 120_000 - 60_000, "focusedMs is capped at the window too");

// stop() freezes the clocks and drops the listener — AdRotator builds one tracker
// per rotation, so a leak here would grow for the whole build.
const before = listeners.length;
const final = d.stop();
assert.strictEqual(listeners.length, before - 1, "stop() must dispose its window-state listener");
t += 999_999;
assert.deepStrictEqual(d.stop(), final, "stop() is idempotent and the clock stays frozen");

// A tracker born while the window is blurred accumulates nothing until focus returns.
setFocus(false);
const blurred = new DwellTracker(now);
t += 10_000;
assert.strictEqual(blurred.snapshot().focusedMs, 0, "no focused time while the window is in the background");
assert.strictEqual(blurred.snapshot().visibleMs, 10_000);
blurred.stop();
setFocus(true);

// ── Phase 3: LineBuffer ────────────────────────────────────────────────────

const mkLine = (id) => ({ id, text: `ad ${id}`, payoutPaise: 25, impressionToken: `tok-${id}` });

(async () => {
  let bt = 0;
  let fetches = 0;
  const buf = new LineBuffer(async () => { fetches++; return mkLine(fetches); }, () => bt);

  assert.strictEqual(buf.take(), undefined, "a cold buffer serves nothing");
  buf.refill();
  buf.refill();
  await tick();
  assert.strictEqual(fetches, 1, "at most one fetch in flight — the server allows one reservation");

  // A buffered line 80s old carries a token that expires at 90s. Rendering it would
  // put an unbillable ad on screen, so it is dropped and refetched instead.
  bt += 80_000;
  assert.strictEqual(buf.take(), undefined, "a buffered line past the 75s safety margin is discarded");

  buf.refill();
  await tick();
  bt += 10_000;
  const fresh = buf.take();
  assert.ok(fresh && fresh.impressionToken === "tok-2", "a fresh line is served");
  assert.strictEqual(buf.take(), undefined, "take() empties the slot — depth is 1");

  // A server that declines (no token) must not poison the buffer.
  const declining = new LineBuffer(async () => ({ id: "x", text: "x" }), () => bt);
  declining.refill();
  await tick();
  assert.strictEqual(declining.take(), undefined, "a tokenless response is never buffered");

  // ── Phase 3: AdRotator ───────────────────────────────────────────────────

  const mkBar = () => ({ text: "", tooltip: "", shows: 0, hides: 0, show() { this.shows++; }, hide() { this.hides++; } });
  const mkStore = () => ({
    paise: 0,
    startSession() { this.paise = 0; },
    endSession() { this.paise = 0; },
    recordSessionImpression(p) { this.paise += p; },
    getSessionEarningsPaise() { return this.paise; },
  });
  const config = { get: (_k, dflt) => dflt };

  const build = (client) => {
    const bar = mkBar();
    const sessionBar = mkBar();
    const store = mkStore();
    const rot = new AdRotator(bar, sessionBar, client, store, config, "npm");
    return { bar, sessionBar, store, rot };
  };

  // The whole point of the buffer: bar.show() happens with nothing awaited.
  let served = 0;
  let impressions = 0;
  let dwells = [];
  const goodClient = {
    async fetchCurrentLine() { served++; return mkLine(served); },
    async recordImpression() { impressions++; return true; },
    async reportDwell(token, visibleMs, focusedMs) { dwells.push({ token, visibleMs, focusedMs }); },
  };

  const a = build(goodClient);
  a.rot.buffer.refill();
  await tick();
  const servedBeforeRender = served;
  a.rot.rotate();                                  // SYNCHRONOUS — no await anywhere
  assert.strictEqual(a.bar.shows, 1, "the line renders on the same tick, with no network round-trip first");
  assert.ok(a.bar.text.includes("ad 1"), "the buffered line is what rendered");
  assert.strictEqual(served, servedBeforeRender, "no fetch on the render path");
  assert.strictEqual(a.store.paise, 25, "earnings credit optimistically at render");
  await tick();
  assert.strictEqual(impressions, 1, "the impression POST is fired after the render");
  assert.strictEqual(served, servedBeforeRender + 1, "the buffer refills in the background");

  // Rotation closes out the previous line's dwell.
  await sleep(5);
  a.rot.rotate();
  assert.strictEqual(dwells.length, 1, "rotating reports dwell for the line it replaced");
  assert.strictEqual(dwells[0].token, "tok-1");
  assert.ok(dwells[0].visibleMs >= 0);
  await tick();

  // stop() reports the LAST line too — otherwise every build loses its longest view.
  await sleep(5);
  a.rot.stop();
  a.rot.cancelFlash();
  assert.strictEqual(dwells.length, 2, "stop() reports the final line's dwell");
  assert.strictEqual(dwells[1].token, "tok-2");

  // A rejected impression POST must NOT blank the status bar. This is the
  // regression that mattered most: one 429 used to make the sponsored line vanish
  // for the rest of the build.
  const flakyClient = {
    async fetchCurrentLine() { return mkLine("f"); },
    async recordImpression() { return false; },     // 429 / budget exhausted / duplicate
    async reportDwell() { throw new Error("network down"); },
  };
  const b = build(flakyClient);
  b.rot.buffer.refill();
  await tick();
  b.rot.rotate();
  await tick();
  await tick();
  assert.strictEqual(b.bar.hides, 0, "a failed impression POST must never hide the bar");
  assert.strictEqual(b.bar.shows, 1, "the line stays up");
  b.rot.stop();
  b.rot.cancelFlash();

  // An empty buffer (offline, cold start) leaves whatever is on screen alone.
  const deadClient = {
    async fetchCurrentLine() { return undefined; },
    async recordImpression() { return true; },
    async reportDwell() {},
  };
  const c = build(deadClient);
  c.bar.text = "$(megaphone) previous ad";
  c.bar.shows = 1;
  c.rot.rotate();
  assert.strictEqual(c.bar.hides, 0, "a cold/offline buffer must not blank the bar");
  assert.strictEqual(c.bar.text, "$(megaphone) previous ad", "the previously rendered line stays up");
  c.rot.stop();       // clears the short retry timer
  c.rot.cancelFlash();

  // Retry backs off past the server's 25s mint floor. A mint that lands server-side
  // but times out here leaves us 429-ed for the rest of that window; a flat 2s retry
  // would spend it hammering a door we already know is shut.
  const d = build(deadClient);
  const realSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0); };
  try {
    for (let i = 0; i < 6; i++) d.rot.rotate();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepStrictEqual(
    delays,
    [2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
    "cold-buffer retry doubles and caps at 30s, above the 25s MINT_FLOOR_SEC"
  );
  assert.ok(delays[4] > 25_000, "the backoff must clear the server's mint floor, not sit under it");

  // An outage that ends must not leave the next cold buffer inheriting its ceiling.
  const e = build(goodClient);
  e.rot.rotate();                                  // empty buffer — escalates once
  e.rot.buffer.refill();
  await tick();
  e.rot.rotate();                                  // a line lands — backoff resets
  const delaysAfter = [];
  global.setTimeout = (fn, ms) => { delaysAfter.push(ms); return realSetTimeout(() => {}, 0); };
  try {
    e.rot.rotate();                                // buffer empty again
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepStrictEqual(delaysAfter, [2_000], "a successful render resets the backoff to its floor");
  e.rot.stop();
  e.rot.cancelFlash();

  console.log("test-adintegrity: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
