// Usage: node lighthouse.mjs <label> <baseUrl> <runs> [pages...]
// Runs Lighthouse (mobile, simulated throttling) N times per page via puppeteer,
// rewriting the hard-coded production API host to the local server so results are controlled.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
const [label, base, runsStr, ...pages] = process.argv.slice(2);
const runs = Number(runsStr);
const PROD = 'https://waitwage-production.up.railway.app';
const out = { label, base, runs, pages: {} };
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
for (const p of pages) {
  const url = base + p;
  const rows = [];
  for (let i = 0; i < runs; i++) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => {
      const u = r.url();
      if (u.startsWith(PROD)) r.continue({ url: base + u.slice(PROD.length) }); else r.continue();
    });
    const { lhr } = await lighthouse(url, { output: 'json', logLevel: 'error' }, undefined, page);
    const a = lhr.audits;
    const items = a['network-requests'].details.items;
    const sum = (f) => items.filter(f).reduce((s, x) => s + (x.transferSize || 0), 0);
    const byType = t => sum(x => x.resourceType === t);
    rows.push({
      perf: Math.round(lhr.categories.performance.score * 100),
      a11y: Math.round(lhr.categories.accessibility.score * 100),
      bp: Math.round(lhr.categories['best-practices'].score * 100),
      seo: Math.round(lhr.categories.seo.score * 100),
      lcp: a['largest-contentful-paint'].numericValue,
      fcp: a['first-contentful-paint'].numericValue,
      cls: a['cumulative-layout-shift'].numericValue,
      tbt: a['total-blocking-time'].numericValue,
      inp: a['interaction-to-next-paint']?.numericValue ?? null,
      ttfb: a['server-response-time'].numericValue,
      si: a['speed-index'].numericValue,
      totalBytes: a['total-byte-weight'].numericValue,
      requests: items.length,
      docBytes: byType('Document'), jsBytes: byType('Script'), cssBytes: byType('Stylesheet'),
      imgBytes: byType('Image'), fontBytes: byType('Font'), xhrBytes: byType('XHR') + byType('Fetch'),
      apiCalls: items.filter(x => x.url.includes('/v1/')).length,
      apiMs: items.filter(x => x.url.includes('/v1/')).map(x => Math.round(x.networkEndTime - x.networkRequestTime)),
      lcpElement: a['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node?.snippet?.slice(0, 80),
      obs: (a['metrics'].details.items[0].observedLargestContentfulPaint - a['metrics'].details.items[0].observedFirstContentfulPaint) + 'ms observed LCP-FCP gap, FCP@' + a['metrics'].details.items[0].observedFirstContentfulPaint,
      lcpPhases: a['largest-contentful-paint-element']?.details?.items?.[1]?.items?.map(i => i.phase + '=' + Math.round(i.timing)).join(' '),
      failing: Object.values(a).filter(x => x.score !== null && x.score < 0.9 && x.scoreDisplayMode !== 'informative').map(x => `${x.id}(${x.score})`),
    });
    await page.close();
    process.stderr.write(`${label} ${p} run ${i + 1}: perf=${rows.at(-1).perf} lcp=${Math.round(rows.at(-1).lcp)} tbt=${Math.round(rows.at(-1).tbt)}\n`);
  }
  const med = k => { const v = rows.map(r => r[k]).filter(x => typeof x === 'number').sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  out.pages[p] = { runs: rows, median: Object.fromEntries(['perf','a11y','bp','seo','lcp','fcp','cls','tbt','inp','ttfb','si','totalBytes','requests','docBytes','jsBytes','cssBytes','imgBytes','fontBytes','xhrBytes','apiCalls'].map(k => [k, med(k)])), failing: rows[0].failing, lcpElement: rows[0].lcpElement };
}
await browser.close();
fs.writeFileSync(`${label}.json`, JSON.stringify(out, null, 2));
for (const [p, r] of Object.entries(out.pages)) console.log(p, JSON.stringify(r.median), r.failing.join(' '), '| LCP:', r.lcpElement, '|', r.runs.map(x=>x.obs).join(' ; '));
