# Performance benchmarks

Baseline taken 2026-09-14 before the optimisation pass; `after-*` is the same
procedure on the optimised tree. Everything runs against a local server on a
**seeded 200k-impression SQLite DB** so numbers are comparable run to run (the
production DB is far smaller today — these show what the code does as it grows).

```sh
npm i --no-save lighthouse@12 puppeteer@23            # brings its own Chrome
cd server && node ../perf/seed.js /tmp/bench.db        # 500 users, 200k impressions, 3k signups
DB_PATH=/tmp/bench.db PORT=3999 ADMIN_KEY=x node backend.js &
node perf/lighthouse.mjs after http://localhost:3999 5 / /how-it-works.html /advertisers.html /earnings.html /login.html /dashboard.html
node perf/runtime.mjs after http://localhost:3999/     # idle/scroll FPS + main-thread ms under 4x CPU throttle
perf/apibench.sh                                       # endpoint latencies (uses seeded session tokens tok<N>)
```

`lighthouse.mjs` rewrites the hard-coded production API host to the local
server so the page's own `/v1/public/stats` calls are measured too. Mobile
profile, simulated throttling, medians of N runs; `results/*.json` keep every run.

Known lab artifact: on `/` Lighthouse's Lantern model counts the (now ~2ms)
stats response as an LCP dependency when it lands before the hero paints, adding
~600ms to the *simulated* LCP in most runs. Observed LCP−FCP is 0ms in every run
and the same page with the fetch delayed 500ms measures the baseline LCP —
see `results/after-local.json` (`obs` field).
