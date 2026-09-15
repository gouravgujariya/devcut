// Renders the social-preview card to og-image.png (1200x630). Text only, brand colours from shared.css.
import puppeteer from 'puppeteer';
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:1200px;height:630px;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#e6edf3;overflow:hidden;position:relative}
.glow{position:absolute;border-radius:50%;filter:blur(90px);opacity:.22}
.g1{width:520px;height:520px;background:#00e676;top:-200px;left:-120px}.g2{width:460px;height:460px;background:#58a6ff;bottom:-220px;right:-100px}
.wrap{position:absolute;inset:0;padding:72px 84px;display:flex;flex-direction:column;justify-content:space-between}
.logo{font-size:34px;font-weight:900;letter-spacing:-.03em}.logo b{color:#58a6ff;font-weight:900}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#00e676;box-shadow:0 0 10px #00e676;margin-right:12px;vertical-align:middle}
h1{font-size:92px;line-height:1.02;letter-spacing:-.035em;font-weight:900;margin:0;max-width:980px}
h1 span{background:linear-gradient(135deg,#00e676,#64ffda 50%,#58a6ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{font-size:30px;color:#8b949e;margin-top:22px}
.bar{background:#007acc;border-radius:10px;padding:16px 26px;font-family:'Cascadia Code','Fira Code',monospace;font-size:21px;color:#fff;display:flex;gap:30px;white-space:nowrap;align-items:center;box-shadow:0 20px 60px rgba(0,0,0,.45)}
.bar .earn{margin-left:auto;background:rgba(0,230,118,.18);color:#00e676;padding:4px 14px;border-radius:6px;font-weight:700}
</style><body><div class="glow g1"></div><div class="glow g2"></div><div class="wrap">
<div class="logo"><span class="dot"></span><b>Dev</b>Cut &nbsp;<span style="font-weight:600;color:#8b949e;font-size:22px">Open-source VS Code extension</span></div>
<div><h1>Get paid while<br>you <span>wait on builds.</span></h1><div class="sub">One sponsored line in your status bar during builds, tests and deploys. You get a share of the revenue — paid to UPI.</div></div>
<div class="bar"><span>⎇ main</span><span>⚙ Building (14s)…</span><span>📣 Example sponsor — your ad here →</span><span class="earn">+ ₹0.25</span></div>
</div></body>`;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.screenshot({ path: process.argv[2], type: 'jpeg', quality: 88 });
await browser.close();
