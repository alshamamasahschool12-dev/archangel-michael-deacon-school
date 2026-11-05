'use strict';
// Same-origin Vercel endpoint: verifies the existing owner account server-side
// and returns a short-lived Firebase custom token. Never accepts a role/UID from
// the browser. Database rules must allow only the configured owner UID.
const crypto = require('node:crypto');
const DEFAULT_DB = 'https://alshamamasahschool-default-rtdb.europe-west1.firebasedatabase.app';
const TOKEN_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROJECT_ID = 'alshamamasahschool';
const OWNER = 'lucaskayser';
const attempts = new Map();

function b64url(value) { return Buffer.from(value).toString('base64url'); }
function signJwt(payload, privateKey) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const input = `${head}.${body}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function getAccountConfig() {
  let account;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try { account = JSON.parse(raw); } catch (_) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    account = { project_id: process.env.FIREBASE_PROJECT_ID, client_email: process.env.FIREBASE_CLIENT_EMAIL, private_key: process.env.FIREBASE_PRIVATE_KEY };
  } else throw new Error('Server service-account configuration is missing.');
  if (account.project_id !== PROJECT_ID || !account.client_email || !account.private_key) throw new Error('Service account is not configured for this Firebase project.');
  account.private_key = account.private_key.replace(/\\n/g, '\n');
  crypto.createPrivateKey(account.private_key);
  return account;
}
async function googleAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }, account.private_key);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error('Could not obtain Firebase server access token.');
  return body.access_token;
}
async function fetchOwnerRecord(accessToken) {
  const dbUrl = String(process.env.FIREBASE_DATABASE_URL || DEFAULT_DB).replace(/\/$/, '');
  if (new URL(dbUrl).hostname !== new URL(DEFAULT_DB).hostname) throw new Error('Wrong database URL.');
  const response = await fetch(`${dbUrl}/shamamsa-servants.json`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('Could not read the owner account from Realtime Database.');
  const accounts = await response.json();
  if (!accounts || typeof accounts !== 'object') return null;
  for (const [key, value] of Object.entries(accounts)) {
    const names = [key, value && value.username].filter(Boolean).map(x => String(x).trim().toLowerCase());
    if (names.includes(OWNER)) return { key, account: value };
  }
  return null;
}
async function passwordMatches(account, password) {
  if (!account || typeof account !== 'object') return false;
  const stored = account.password == null ? '' : String(account.password);
  if (stored && !stored.startsWith('zk1$') && safeEqual(stored, password)) return true;
  if (typeof account.passwordSalt !== 'string') return false;
  let salt;
  try { salt = Buffer.from(account.passwordSalt, 'base64'); } catch (_) { return false; }
  if (salt.length < 8 || salt.length > 64) return false;
  async function verify(encoded, iterations, input) {
    if (typeof encoded !== 'string' || !encoded) return false;
    const count = Number(iterations);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) return false;
    let expected;
    try { expected = Buffer.from(encoded, 'base64'); } catch (_) { return false; }
    if (expected.length !== 32) return false;
    const actual = await new Promise((resolve, reject) => crypto.pbkdf2(input, salt, count, 32, 'sha256', (err, key) => err ? reject(err) : resolve(key)));
    return crypto.timingSafeEqual(actual, expected);
  }
  if (account.passwordHash && await verify(String(account.passwordHash), Number(account.passwordIterations) || 120000, password)) return true;
  if (stored.startsWith('zk1$')) return verify(stored.slice(4), 60000, 'srv-api-v1:' + password);
  return false;
}
function rateAllowed(ip, bucket = 'login', max = 8, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const key = `${bucket}:${ip}`;
  const old = attempts.get(key);
  if (!old || now - old.start > windowMs) { attempts.set(key, { start: now, count: 1 }); return true; }
  if (old.count >= max) return false;
  old.count++;
  return true;
}
module.exports = async function ownerFirebaseLogin(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const query = new URL(req.url || '/', 'https://local.invalid').searchParams;
  if (req.method === 'GET' && query.get('action') === 'preview') {
    const username = String(query.get('username') || '').trim().toLowerCase();
    if (username !== OWNER) { res.status(404).json({ error: 'Not found.' }); return; }
    if (!rateAllowed(ip, 'preview', 60, 15 * 60 * 1000)) { res.status(429).json({ error: 'انتظر قليلًا ثم حاول مرة أخرى.' }); return; }
    try {
      const accountConfig = getAccountConfig();
      const accessToken = await googleAccessToken(accountConfig);
      const found = await fetchOwnerRecord(accessToken);
      if (!found || !found.account || found.account.disabled) { res.status(404).json({ error: 'Not found.' }); return; }
      const photoUrl = typeof found.account.photoUrl === 'string' && found.account.photoUrl.startsWith('https://') && found.account.photoUrl.length <= 2048 ? found.account.photoUrl : '';
      const name = String(found.account.name || OWNER).slice(0, 100);
      res.status(200).json({ name, photoUrl, username: OWNER });
    } catch (error) {
      console.error('owner profile preview failed:', error && error.message || error);
      res.status(503).json({ error: 'تعذر تحميل معاينة الحساب الآن.' });
    }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return; }
  if (!rateAllowed(ip, 'login', 8, 15 * 60 * 1000)) { res.status(429).json({ error: 'محاولات كثيرة. انتظر ١٥ دقيقة ثم حاول مرة أخرى.' }); return; }
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const username = String(body && body.username || '').trim().toLowerCase();
  const password = typeof (body && body.password) === 'string' ? body.password.trim() : '';
  if (username !== OWNER || !password || password.length > 500) { res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' }); return; }
  const uid = String(process.env.FIREBASE_OWNER_UID || '').trim();
  if (!uid || uid.length > 128) { res.status(503).json({ error: 'إعداد دخول المسؤول غير مكتمل على Vercel.' }); return; }
  try {
    const accountConfig = getAccountConfig();
    const accessToken = await googleAccessToken(accountConfig);
    const found = await fetchOwnerRecord(accessToken);
    if (!found || !found.account || found.account.disabled || ['father', 'noaccess'].includes(found.account.role) || !(await passwordMatches(found.account, password))) {
      res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' }); return;
    }
    const now = Math.floor(Date.now() / 1000);
    const customToken = signJwt({
      iss: accountConfig.client_email,
      sub: accountConfig.client_email,
      aud: TOKEN_AUD,
      iat: now,
      exp: now + 3600,
      uid,
      claims: { role: 'owner', username: OWNER }
    }, accountConfig.private_key);
    res.status(200).json({ customToken });
  } catch (error) {
    console.error('owner Firebase login failed:', error && error.message || error);
    res.status(503).json({ error: 'تعذر التحقق من حساب المسؤول عبر الخادم. راجع إعداد FIREBASE_SERVICE_ACCOUNT وFIREBASE_OWNER_UID على Vercel.' });
  }
};
