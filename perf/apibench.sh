#!/bin/bash
# endpoint-level latency: sponsor-line (5 distinct users), impressions POST, analytics (cold + warm), public stats
B=http://localhost:3999
t() { curl -s -o /dev/null -w '%{time_total}' "$@"; }
echo -n "sponsor-line (5 users): "; for i in 101 102 103 104 105; do printf '%.0fms ' $(echo "$(t -H "Authorization: Bearer tok$i" "$B/v1/sponsor-line?taskType=npm")*1000" | bc); done; echo
echo -n "sponsor-line -> impressions POST: "; tok=$(curl -s -H "Authorization: Bearer tok110" "$B/v1/sponsor-line?taskType=npm" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).impressionToken))"); printf '%.0fms\n' $(echo "$(t -X POST -H "Authorization: Bearer tok110" -H 'Content-Type: application/json' -d "{\"token\":\"$tok\"}" "$B/v1/impressions")*1000" | bc)
echo -n "me/analytics (cold, warm, warm): "; for i in 1 2 3; do printf '%.0fms ' $(echo "$(t -H "Authorization: Bearer tok120" "$B/v1/me/analytics")*1000" | bc); done; echo
echo -n "me/analytics other user: "; printf '%.0fms\n' $(echo "$(t -H "Authorization: Bearer tok121" "$B/v1/me/analytics")*1000" | bc)
echo -n "public/stats (cold, warm, warm): "; for i in 1 2 3; do printf '%.0fms ' $(echo "$(t "$B/v1/public/stats")*1000" | bc); done; echo
echo -n "public/stats 3 concurrent: "; (for i in 1 2 3; do (printf '%.0fms ' $(echo "$(t "$B/v1/public/stats")*1000" | bc)) & done; wait); echo
echo -n "/v1/me: "; printf '%.0fms\n' $(echo "$(t -H "Authorization: Bearer tok122" "$B/v1/me")*1000" | bc)
echo -n "GET / : "; printf '%.0fms  ' $(echo "$(t "$B/")*1000" | bc); echo -n "GET /shared.css: "; printf '%.0fms\n' $(echo "$(t "$B/shared.css")*1000" | bc)
