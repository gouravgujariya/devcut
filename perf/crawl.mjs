// Crawl every internal link from /, report status codes, canonical, OG, JSON-LD validity, H1 count, images without alt, mobile overflow.
import puppeteer from 'puppeteer';
const base = process.argv[2] || 'http://localhost:3999';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const seen = new Map(); const queue = ['/']; const links = new Set();
const fetchStatus = async (u) => { const r = await fetch(base + u, { redirect: 'manual' }); return { status: r.status, loc: r.headers.get('location'), xr: r.headers.get('x-robots-tag') }; };
while (queue.length) {
  const u = queue.shift(); if (seen.has(u)) continue;
  const st = await fetchStatus(u); seen.set(u, st);
  if (st.status !== 200 || !/^\/[^.]*$/.test(u)) continue;
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 700, isMobile: true, hasTouch: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.setRequestInterception(true);
  page.on('request', r => r.url().startsWith('https://waitwage-production.up.railway.app') ? r.continue({ url: base + r.url().slice('https://waitwage-production.up.railway.app'.length) }) : r.continue());
  await page.goto(base + u, { waitUntil: 'networkidle0' });
  const info = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    let ld = null, ldErr = null; try { ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => JSON.parse(s.textContent)); } catch (e) { ldErr = e.message; }
    return {
      title: document.title, desc: q('meta[name=description]')?.content?.length, canonical: q('link[rel=canonical]')?.href, robots: q('meta[name=robots]')?.content,
      og: ['og:title','og:description','og:image','og:url','og:type'].filter(p => !q(`meta[property="${p}"]`)), h1: document.querySelectorAll('h1').length,
      imgsNoAlt: [...document.images].filter(i => !i.hasAttribute('alt')).length, imgs: document.images.length,
      ldTypes: ld ? ld.flatMap(d => (d['@graph'] || [d]).map(n => n['@type'])) : ldErr,
      overflow: document.documentElement.scrollWidth > window.innerWidth ? document.documentElement.scrollWidth : 0,
      links: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')),
    };
  });
  for (const h of info.links) { if (h.startsWith('/') ) { const p = h.split('#')[0]; if (p) queue.push(p); } else if (/^https?:/.test(h)) links.add(h); }
  console.log(u.padEnd(18), `title="${info.title}" desc=${info.desc} canonical=${info.canonical} robots=${info.robots || '-'} ogMissing=${info.og.join(',') || 'none'} h1=${info.h1} imgs=${info.imgs}/${info.imgsNoAlt}noalt ld=${JSON.stringify(info.ldTypes)} overflow=${info.overflow || 'no'} errors=${errors.length ? errors.join(';') : 'none'}`);
  await page.close();
}
console.log('--- internal URL statuses'); for (const [u, s] of seen) console.log(' ', s.status, u, s.loc || '', s.xr || '');
console.log('--- external links'); for (const l of links) { try { const r = await fetch(l, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) }); console.log(' ', r.status, l); } catch (e) { console.log('  ERR', l, e.message); } }
await browser.close();
