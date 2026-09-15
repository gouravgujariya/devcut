// Seed a synthetic DB at "plausible 6-months-of-beta" scale to expose query patterns.
const path = require('path');
process.env.DB_PATH = process.argv[2];
const db = require('../server/db.js');
const { randomUUID } = require('crypto');
const N_USERS = 500, N_IMP = 200000, N_SIGNUPS = 3000, N_CLICKS = 2000, N_WD = 800;
const now = Math.floor(Date.now()/1000);
const tx = db.transaction(() => {
  const users = [];
  const iu = db.prepare("INSERT INTO users (id,email,invite_code,upi_id,created_at,status,company) VALUES (?,?,?,?,?,?,?)");
  for (let i=0;i<N_USERS;i++){ const id=randomUUID(); users.push(id); iu.run(id,`u${i}@x.io`,`DCUT-${i}`,`u${i}@upi`,now-Math.floor(Math.random()*180*86400),'active','acme'); }
  const ib = db.prepare("INSERT INTO beta_invites (code,email,created_at) VALUES (?,?,?)");
  for (let i=0;i<N_SIGNUPS;i++) ib.run(`DCUT-S-${i}`,`s${i}@x.io`,now-Math.floor(Math.random()*180*86400));
  const sponsors = db.prepare("SELECT id FROM sponsors").all().map(r=>r.id);
  const tasks = ['npm','cargo','pytest','docker','idle','git','go','make'];
  const ii = db.prepare("INSERT INTO impressions (user_id,sponsor_id,task_type,ts,payout_paise,bid_paise,jti,state,rendered_at,visible_ms,focused_ms,settled_at,billable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (let i=0;i<N_IMP;i++){ const ts=now-Math.floor(Math.random()*180*86400); const settled=Math.random()<0.9;
    ii.run(users[Math.floor(Math.random()*N_USERS)], sponsors[i%sponsors.length], tasks[i%tasks.length], ts, 25, 42, randomUUID(), settled?'settled':'reserved', ts, 8000, 8000, settled?ts+10:null, settled?1:0); }
  const ic = db.prepare("INSERT INTO clicks (user_id,sponsor_id,ts) VALUES (?,?,?)");
  for (let i=0;i<N_CLICKS;i++) ic.run(users[Math.floor(Math.random()*N_USERS)], sponsors[i%sponsors.length], now-Math.floor(Math.random()*180*86400));
  const iw = db.prepare("INSERT INTO withdrawals (user_id,amount_paise,upi_id,status,created_at) VALUES (?,?,?,?,?)");
  for (let i=0;i<N_WD;i++) iw.run(users[i%N_USERS], 5000, 'x@upi', i%4===0?'completed':(i%4===1?'rejected':'completed'), now-Math.floor(Math.random()*180*86400));
  const is = db.prepare("INSERT INTO sessions (id,token_hash,user_id) VALUES (?,?,?)");
  for (let i=0;i<N_USERS;i++) is.run(randomUUID(), require('crypto').createHash('sha256').update('tok'+i).digest('hex'), users[i]);
});
tx();
console.log('seeded', db.prepare('select count(*) n from impressions').get().n, 'impressions');
