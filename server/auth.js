const { generateKeyPairSync, createPrivateKey, createPublicKey, randomUUID } = require("crypto");
const jwt = require("jsonwebtoken");

const ISSUER = "kickback-status";

// ── Key loading / generation ──────────────────────────────────────────────────
// Production: set RSA_PRIVATE_KEY env var (PKCS#8 PEM, newlines as \n).
// Generate with:
//   node -e "const {generateKeyPairSync:g}=require('crypto');console.log(g('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}))"
let privateKey, publicKey;

if (process.env.RSA_PRIVATE_KEY) {
  privateKey = createPrivateKey(process.env.RSA_PRIVATE_KEY.replace(/\\n/g, "\n"));
  publicKey  = createPublicKey(privateKey);
} else {
  if (process.env.NODE_ENV === "production") {
    console.error("[auth] FATAL: RSA_PRIVATE_KEY must be set in production. Exiting.");
    process.exit(1);
  }
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey  = pair.publicKey;
  console.warn("[auth] RSA_PRIVATE_KEY not set — ephemeral keys in use (dev only). Tokens invalidate on server restart.");
}

// ── Token operations ──────────────────────────────────────────────────────────
// Session (access) tokens are opaque and DB-backed now — see server/middleware.js
// and the `sessions` table in server/db.js. Only the impression token below still
// needs RSA/JWT, so the key-loading block above stays.

// Short-lived, single-use proof that a specific ad was served to a specific user.
// jti is the id of the `reserved` impressions row minted alongside this token, so
// the caller passes one in: POST /v1/impressions looks the row up by it, and the
// unique index on impressions.jti is the backstop against a replayed token.
function signImpressionToken({ sponsorId, userId, payoutPaise, bidPaise, jti = randomUUID() }) {
  return jwt.sign({ spn: sponsorId, pay: payoutPaise, bid: bidPaise, jti }, privateKey, {
    algorithm: "RS256",
    subject: userId,
    expiresIn: "90s",
    issuer: ISSUER,
    audience: "impression",
  });
}

function verifyImpressionToken(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: ISSUER,
    audience: "impression",
  });
}

module.exports = { signImpressionToken, verifyImpressionToken };
