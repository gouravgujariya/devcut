// Usage: node runtime.mjs <label> <url>
// Measures runtime smoothness under 4x CPU throttle at mobile viewport: FPS while idle and while
// scrolling, long tasks, script/layout/style time. Lighthouse lab can't see this (INP is null w/o input).
import puppeteer from 'puppeteer';
const [label, url] = process.argv.slice(2);
const PROD = 'https://waitwage-production.up.railway.app';
const base = new URL(url).origin;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 823, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true });
await page.setRequestInterception(true);
page.on('request', r => { const u = r.url(); if (u.startsWith(PROD)) r.continue({ url: base + u.slice(PROD.length) }); else r.continue(); });
const cdp = await page.createCDPSession();
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.goto(url, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1500));
const measure = async (scroll) => {
  const m0 = await page.metrics();
  const p = page.evaluate((scroll) => new Promise(res => {
    let frames = 0, longTasks = 0, longMs = 0, worst = 0;
    const po = new PerformanceObserver(l => { for (const e of l.getEntries()) { longTasks++; longMs += e.duration; worst = Math.max(worst, e.duration); } });
    po.observe({ type: 'longtask', buffered: false });
    const t0 = performance.now(); let last = t0, maxGap = 0;
    const tick = t => { frames++; maxGap = Math.max(maxGap, t - last); last = t; if (t - t0 < 4000) requestAnimationFrame(tick); else { po.disconnect(); res({ fps: +(frames / ((t - t0) / 1000)).toFixed(1), longTasks, longMs: Math.round(longMs), worstTask: Math.round(worst), maxFrameGap: Math.round(maxGap) }); } };
    requestAnimationFrame(tick);
    if (scroll) { let y = 0; const iv = setInterval(() => { y += 60; window.scrollTo(0, y); if (y > 5000) y = 0; }, 50); setTimeout(() => clearInterval(iv), 4000); }
  }), scroll);
  const r = await p; const m1 = await page.metrics();
  r.scriptMs = Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000);
  r.layoutMs = Math.round((m1.LayoutDuration - m0.LayoutDuration) * 1000);
  r.styleMs = Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000);
  r.taskMs = Math.round((m1.TaskDuration - m0.TaskDuration) * 1000);
  r.jsHeapMB = +(m1.JSHeapUsedSize / 1048576).toFixed(1);
  return r;
};
const idle = await measure(false);
const scrolling = await measure(true);
console.log(JSON.stringify({ label, url, idle, scrolling }));
await browser.close();
