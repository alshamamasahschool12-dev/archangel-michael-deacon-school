'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   خدمة موافقات فتح الحضور — مدرسة الملاك ميخائيل للشمامسة
   Vercel Function  ←  /api/attendance-access

   • من غير أي مكتبات خارجية: مش محتاج package.json ولا npm install.
   • بتتكلم مع Firebase Realtime Database بالـREST API بمفتاح Service Account
     محطوط في Vercel ← Settings ← Environment Variables باسم FIREBASE_SERVICE_ACCOUNT.

   GET  /api/attendance-access           فحص سريع للإعدادات (من غير ما يلمس قاعدة البيانات)
   GET  /api/attendance-access?check=1   فحص كامل: مفتاح Google + قراءة وكتابة في قاعدة البيانات
   POST /api/attendance-access           العمليات اللي بتبعتها صفحة الإدارة (shamamsa-admin.html)
   ═══════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const SERVICE = 'attendance-access';
const VERSION = '2026.10.27-skills-v5';
const DEFAULT_DATABASE_URL = 'https://alshamamasahschool-default-rtdb.europe-west1.firebasedatabase.app';
const DEFAULT_PROJECT_ID = 'alshamamasahschool';
const OWNER = 'lucaskayser';

const PATHS = {
  servants: 'shamamsa-servants',
  attendance: 'shamamsa-attendance',
  log: 'shamamsa-activity-log',
  logCount: 'shamamsa-activity-log-count',
  requests: 'shamamsa-attendance-access/requests',
  todayOps: 'shamamsa-attendance-access/today-ops',
  health: 'shamamsa-attendance-access/health',
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const APPROVAL_MS = 5 * MINUTE;   // مهلة قرار مسؤول الموافقة
const ACCESS_MS = 30 * MINUTE;    // مدة فتح تعديل الأيام السابقة بعد الموافقة
const SESSION_MS = 12 * HOUR;     // مدة جلسة الخدمة بعد تسجيل الدخول
const KEEP_MS = 3 * DAY;          // الطلبات الأقدم من كده بتتمسح تلقائيًا
const RECENT_MS = DAY;            // الطلبات اللي بترجع للصفحة

const LEVELS = ['المستوى الأول', 'المستوى الثاني', 'المستوى الثالث', 'المستوى الرابع', 'المستوى الخامس',
  'المستوى السادس', 'المستوى السابع', 'المستوى الثامن', 'المستوى التاسع'];
const STATUS_AR = { present: 'حاضر', absent: 'غايب' };
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const BAD_KEY_RE = /[.#$[\]/\u0000-\u001f\u007f]/;

class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

/* ───────────────────────── أدوات صغيرة ───────────────────────── */
const b64url = (x) => Buffer.from(x).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s), 'base64url');
const env = (name) => (typeof process.env[name] === 'string' ? process.env[name].trim() : '');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function same(a, b) {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  if (x === y) return true;
  if ((x && typeof x === 'object') || (y && typeof y === 'object')) return JSON.stringify(x) === JSON.stringify(y);
  return false;
}
function cairoDate(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}
function cairoTime(ts) {
  try { return new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' }).format(ts); }
  catch (_) { return new Date(ts).toISOString().slice(11, 16); }
}
function newId(now) {
  return 'r2_' + now.toString(36) + crypto.randomBytes(5).toString('hex');
}
function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return '';
  return (user.length > 8 ? user.slice(0, 8) + '…' : user) + '@' + domain;
}

/* ───────────────────────── الإعدادات ───────────────────────── */
let CONFIG = null;

function parseServiceAccount(raw) {
  let text = String(raw || '').trim().replace(/^\uFEFF/, '');
  if (text.length > 1 && text[0] === "'" && text[text.length - 1] === "'") text = text.slice(1, -1).trim();
  const candidates = [text];
  if (!text.startsWith('{') && !text.startsWith('"')) {
    try { candidates.push(Buffer.from(text, 'base64').toString('utf8').trim()); } catch (_) { /* مش base64 */ }
  }
  for (const c of candidates) {
    try {
      let v = JSON.parse(c);
      if (typeof v === 'string') v = JSON.parse(v);
      if (isObj(v)) return v;
    } catch (_) { /* جرّب اللي بعده */ }
  }
  return null;
}
function normalizePem(key) {
  let k = String(key || '').trim();
  if (k.length > 1 && k[0] === '"' && k[k.length - 1] === '"') k = k.slice(1, -1);
  return k.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r/g, '');
}

function readConfig() {
  if (CONFIG) return CONFIG;
  const missing = [];
  const invalid = [];
  let sa = null;
  let source = '';
  const names = ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_SERVICE_ACCOUNT_KEY',
    'FIREBASE_ADMIN_SDK', 'GOOGLE_SERVICE_ACCOUNT', 'SERVICE_ACCOUNT_JSON'];
  for (const n of names) { if (env(n)) { source = n; break; } }
  if (source) {
    sa = parseServiceAccount(process.env[source]);
    if (!sa) invalid.push(source + ': مش JSON صالح — انسخ محتوى ملف المفتاح كله من أول { لحد آخر }');
  } else if (env('FIREBASE_CLIENT_EMAIL') && env('FIREBASE_PRIVATE_KEY')) {
    source = 'FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY';
    sa = { client_email: env('FIREBASE_CLIENT_EMAIL'), private_key: process.env.FIREBASE_PRIVATE_KEY, project_id: env('FIREBASE_PROJECT_ID') };
  } else {
    missing.push('FIREBASE_SERVICE_ACCOUNT');
  }

  let privateKey = null;
  if (sa) {
    if (sa.type && sa.type !== 'service_account') invalid.push(source + ': الملف ده مش مفتاح Service Account');
    if (!sa.client_email || !/@[a-z0-9-]+\.iam\.gserviceaccount\.com$/i.test(String(sa.client_email))) invalid.push(source + ': ناقص client_email');
    const pem = normalizePem(sa.private_key);
    if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) invalid.push(source + ': ناقص private_key');
    else {
      try { privateKey = crypto.createPrivateKey(pem); }
      catch (_) { invalid.push(source + ': private_key بايظ أو ناقص حروف — انسخ الملف كله تاني'); }
    }
  }

  const projectId = env('FIREBASE_PROJECT_ID') || DEFAULT_PROJECT_ID;
  const databaseURL = (env('FIREBASE_DATABASE_URL') || DEFAULT_DATABASE_URL).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)$/i.test(databaseURL)) {
    invalid.push('FIREBASE_DATABASE_URL: لازم يكون رابط قاعدة البيانات (أو امسحه خالص)');
  }
  if (sa && sa.project_id && sa.project_id !== projectId) {
    invalid.push(source + ': المفتاح ده من مشروع «' + sa.project_id + '» مش «' + projectId + '» — نزّل المفتاح من نفس مشروع Firebase');
  }
  const secret = env('ATTENDANCE_SESSION_SECRET');
  if (secret && secret.length < 16) invalid.push('ATTENDANCE_SESSION_SECRET: لازم ١٦ حرف على الأقل (أو امسحه خالص)');
  const sessionKey = crypto.createHash('sha256')
    .update('shamamsa-attendance-session-v1|' + (secret || (sa ? normalizePem(sa.private_key) : '')))
    .digest();

  CONFIG = {
    ok: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    source,
    clientEmail: sa ? String(sa.client_email || '') : '',
    privateKeyId: sa ? String(sa.private_key_id || '') : '',
    privateKey,
    projectId,
    databaseURL,
    sessionKey,
    ownerPasscode: env('OWNER_PASSCODE'),
  };
  return CONFIG;
}

function configMessage(cfg) {
  const parts = [];
  if (cfg.missing.length) parts.push('ناقص في Environment Variables على Vercel: ' + cfg.missing.join('، '));
  if (cfg.invalid.length) parts.push('فيه إعداد غلط: ' + cfg.invalid.join(' | '));
  return 'خدمة موافقات الحضور مرفوعة بس لسه مش متجهزة — ' + parts.join(' — ') + '. بعد التعديل اعمل Redeploy.';
}

/* ───────────────────────── مفتاح Google ───────────────────────── */
let ACCESS = null;

async function accessToken(cfg) {
  if (ACCESS && ACCESS.exp - 2 * MINUTE > Date.now()) return ACCESS.token;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  if (cfg.privateKeyId) header.kid = cfg.privateKeyId;
  const claims = {
    iss: cfg.clientEmail,
    sub: cfg.clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const signature = crypto.sign('sha256', Buffer.from(unsigned), cfg.privateKey);
  let res;
  let data;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(signature) }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    data = await res.json().catch(() => ({}));
  } catch (_) {
    throw new ApiError(502, 'مش قادر أوصل لـGoogle عشان أتأكد من مفتاح الخدمة. جرّب تاني بعد لحظة.');
  }
  if (!res.ok || !data || !data.access_token) {
    const why = String((data && (data.error_description || data.error)) || res.status);
    throw new ApiError(500, 'Google رفض مفتاح الخدمة (' + why + '). نزّل مفتاح جديد من Firebase وحطه في FIREBASE_SERVICE_ACCOUNT وبعدين Redeploy.', { code: 'google-auth' });
  }
  ACCESS = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return ACCESS.token;
}

/* ───────────────────────── قاعدة البيانات (REST) ───────────────────────── */
function dbUrl(cfg, path, query) {
  const clean = String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = new URL(cfg.databaseURL + '/' + clean + '.json');
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  return url.toString();
}

async function db(cfg, method, path, opts = {}) {
  const token = await accessToken(cfg);
  const headers = { Authorization: 'Bearer ' + token };
  if (opts.etag) headers['X-Firebase-ETag'] = 'true';
  if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
  let body;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res;
  let text;
  try {
    res = await fetch(dbUrl(cfg, path, opts.query), { method, headers, body, signal: AbortSignal.timeout(opts.timeout || 12000) });
    text = await res.text();
  } catch (_) {
    throw new ApiError(502, 'قاعدة البيانات مردتش في الوقت. جرّب تاني بعد لحظة.');
  }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
  if (res.status === 412 && opts.ifMatch) return { status: 412, data, etag: res.headers.get('etag') };
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      ACCESS = null;
      throw new ApiError(500, 'قاعدة البيانات رفضت مفتاح الخدمة (' + res.status + '). اتأكد إن المفتاح من مشروع ' + cfg.projectId + '.', { code: 'db-auth' });
    }
    if (res.status === 404) throw new ApiError(500, 'رابط قاعدة البيانات مش موجود: ' + cfg.databaseURL, { code: 'db-url' });
    const msg = isObj(data) && data.error ? String(data.error) : String(res.status);
    throw new ApiError(res.status >= 500 ? 502 : 500, 'قاعدة البيانات رجّعت خطأ: ' + msg);
  }
  return { status: res.status, data, etag: res.headers.get('etag') };
}
const dbGet = (cfg, path, query) => db(cfg, 'GET', path, { query }).then((r) => r.data);
const dbPatch = (cfg, path, body) => db(cfg, 'PATCH', path, { body, query: { print: 'silent' } });
const dbPut = (cfg, path, body) => db(cfg, 'PUT', path, { body, query: { print: 'silent' } });

/* تعديل آمن (زي transaction): بنقرا القيمة مع ETag، ولو حد غيّرها قبلنا بنعيد الحساب. */
async function transact(cfg, path, update, tries = 10) {
  let { data, etag } = await db(cfg, 'GET', path, { etag: true });
  for (let i = 0; i < tries; i++) {
    const next = update(data === undefined ? null : data);
    if (next === undefined) return { committed: false, value: data };
    const r = await db(cfg, 'PUT', path, { body: next, ifMatch: etag });
    if (r.status !== 412) return { committed: true, value: next };
    data = r.data;
    etag = r.etag;
    if (!etag) ({ data, etag } = await db(cfg, 'GET', path, { etag: true }));
  }
  throw new ApiError(503, 'في تعديلات كتير بتحصل على نفس البيانات دلوقتي. جرّب تاني بعد ثواني.');
}

/* ───────────────────────── تسجيل دخول Firebase (ID token) ───────────────────────── */
let CERTS = null;

async function googleCerts(force) {
  if (!force && CERTS && CERTS.exp > Date.now()) return CERTS.keys;
  let res;
  let map = null;
  try {
    res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', { signal: AbortSignal.timeout(8000) });
    map = await res.json().catch(() => null);
  } catch (_) { map = null; }
  if (!res || !res.ok || !isObj(map)) {
    if (CERTS) return CERTS.keys;
    throw new ApiError(502, 'مش قادر أتأكد من تسجيل الدخول دلوقتي. جرّب تاني بعد لحظة.');
  }
  const keys = {};
  for (const [kid, pem] of Object.entries(map)) {
    try { keys[kid] = new crypto.X509Certificate(pem).publicKey; } catch (_) { /* شهادة بايظة */ }
  }
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  CERTS = { keys, exp: Date.now() + Math.min(m ? Number(m[1]) * 1000 : HOUR, 6 * HOUR) };
  return keys;
}

async function verifyIdToken(token, cfg) {
  const bad = () => new ApiError(401, 'سجّل دخولك تاني واتأكد إن الإنترنت متصل.');
  if (!token || token.length > 4096) throw bad();
  const parts = token.split('.');
  if (parts.length !== 3) throw bad();
  let header;
  let payload;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch (_) { throw bad(); }
  if (!header || header.alg !== 'RS256' || !header.kid || !payload) throw bad();
  let keys = await googleCerts(false);
  if (!keys[header.kid]) keys = await googleCerts(true);
  const key = keys[header.kid];
  if (!key) throw bad();
  let ok = false;
  try { ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), key, fromB64url(parts[2])); } catch (_) { ok = false; }
  const now = Math.floor(Date.now() / 1000);
  if (!ok
    || payload.aud !== cfg.projectId
    || payload.iss !== 'https://securetoken.google.com/' + cfg.projectId
    || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128
    || !(payload.exp > now - 300)
    || !(payload.iat < now + 300)) throw bad();
  return payload.sub;
}

function bearer(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

/* ───────────────────────── جلسة الخدمة ───────────────────────── */
function signSession(cfg, payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', cfg.sessionKey).update('s1.' + body).digest());
  return 's1.' + body + '.' + sig;
}
function readSession(cfg, token, uid) {
  const expired = () => new ApiError(401, 'جلسة خدمة الموافقات انتهت. سجّل خروج وادخل تاني بكلمة مرور حسابك.');
  if (typeof token !== 'string' || !token || token.length > 2048) throw expired();
  const [v, body, sig] = token.split('.');
  if (v !== 's1' || !body || !sig) throw expired();
  const expect = b64url(crypto.createHmac('sha256', cfg.sessionKey).update('s1.' + body).digest());
  if (!safeEqual(expect, sig)) throw expired();
  let p;
  try { p = JSON.parse(fromB64url(body).toString('utf8')); } catch (_) { throw expired(); }
  if (!isObj(p) || typeof p.k !== 'string' || !(p.exp > Date.now()) || p.uid !== uid) throw expired();
  return p;
}

/* ───────────────────────── الخدام والصلاحيات ───────────────────────── */
let SERVANTS = null;

async function loadServants(cfg, fresh) {
  if (!fresh && SERVANTS && Date.now() - SERVANTS.at < 15000) return SERVANTS.map;
  const data = await dbGet(cfg, PATHS.servants);
  SERVANTS = { at: Date.now(), map: isObj(data) ? data : {} };
  return SERVANTS.map;
}
function normalizeUsernameKey(u) {
  return String(u || '').trim().replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\./g, '．').replace(/#/g, '＃').replace(/\$/g, '＄')
    .replace(/\[/g, '［').replace(/\]/g, '］').replace(/\//g, '／').slice(0, 200);
}
function findServant(map, username) {
  const raw = String(username || '').trim();
  if (!raw) return null;
  const wanted = new Set([raw.toLowerCase(), normalizeUsernameKey(raw).toLowerCase()]);
  const key = Object.keys(map).find((k) => wanted.has(k.toLowerCase()));
  return key && isObj(map[key]) ? { key, s: map[key] } : null;
}
function permList(s) {
  const p = s && s.permissions;
  if (Array.isArray(p)) return p.filter((x) => typeof x === 'string');
  if (isObj(p)) return Object.values(p).filter((x) => typeof x === 'string');
  return [];
}
function describe(key, s) {
  const perms = permList(s);
  const owner = String(key).toLowerCase() === OWNER;
  const father = s.role === 'father';
  return {
    key,
    uname: String(key).toLowerCase(),
    name: String(s.name || key).slice(0, 120),
    phone: String(s.phone || '').replace(/\D/g, '').slice(0, 20),
    isOwner: owner,
    active: !s.disabled && s.role !== 'father' && s.role !== 'noaccess',
    canApprove: owner || perms.includes('attendanceApprover') || perms.includes('attendanceCodeReceiver'),
    canRequest: owner || (!father && perms.includes('lateAttendanceRequest') && perms.includes('attendance')),
    canAttend: owner || (!father && perms.includes('attendance')),
    canDeacons: owner || (!father && perms.includes('deacons')),
    isSchoolAdmin: !father && s.role === 'admin',
  };
}
async function loadMe(ctx, fresh = false) {
  const map = await loadServants(ctx.cfg, fresh);
  const found = findServant(map, ctx.session.k);
  if (!found) throw new ApiError(401, 'الحساب ده مش موجود دلوقتي في قاعدة البيانات. سجّل خروج وادخل تاني.');
  const me = describe(found.key, found.s);
  if (!me.active) throw new ApiError(401, 'الحساب ده موقوف أو مش من حسابات الإدارة.');
  return me;
}

/* ───────────────────────── الطلبات ───────────────────────── */
/* كل طلب وكل موافقة بيتختموا بتوقيع سري من السيرفر. أي سجل اتكتب في قاعدة البيانات من برّه
   الخدمة (من غير التوقيع) بيتجاهل — حتى لو قواعد قاعدة البيانات مفتوحة للكتابة. */
function mac(cfg, parts) {
  return b64url(crypto.createHmac('sha256', cfg.sessionKey).update(parts.map((x) => String(x === undefined ? '' : x)).join('|')).digest());
}
/* نفس توقيع الطلبات السابقة للحفاظ على التوافق أثناء تحديث الخدمة. */
const originSig = (cfg, r) => mac(cfg, ['req1', r.id, r.username, r.approverUsername, r.createdAt, r.kind || 'request']);
const grantSig = (cfg, r) => mac(cfg, ['grant1', r.id, r.username, r.approvedAt, r.accessUntil, r.decidedBy]);
/* إثبات تاريخي مختلف عن توقيع الفتح؛ لا يصلح وحده للكتابة بعد الإنهاء. */
const approvalHistorySig = (cfg, r) => mac(cfg, ['approved-history-v2', r.id, r.username, r.approvedAt, r.accessUntil, r.decidedBy]);
const genuine = (cfg, r) => isObj(r) && typeof r.sig0 === 'string' && safeEqual(r.sig0, originSig(cfg, r));
const grantOk = (cfg, r) => isObj(r) && typeof r.sig === 'string' && safeEqual(r.sig, grantSig(cfg, r));
const normUser = (v) => String(v || '').trim().toLowerCase();

/* صلاحية القرار لا تزيد عن خمس دقائق من وقت الطلب الموقّع، حتى لو غُيّر الحقل في قاعدة البيانات. */
function pendingDeadline(r) {
  const created = Number(r && r.createdAt);
  const until = Number(r && r.approvalUntil);
  if (!Number.isSafeInteger(created) || created <= 0 || !Number.isSafeInteger(until) || until <= created) return 0;
  return Math.min(until, created + APPROVAL_MS);
}

/* إذن صالح فقط لطلب حقيقي وافق عليه المسؤول المختار، وليس صاحب الطلب نفسه.
   الأذونات القديمة من نوع owner أو أي فتح ذاتي تُعتبر ملغاة حتى لو توقيعها القديم صحيح. */
function approvedMetadataOk(cfg, r) {
  if (!genuine(cfg, r) || (r.kind && r.kind !== 'request')) return false;
  const requester = normUser(r.username), approver = normUser(r.approverUsername), decider = normUser(r.decidedBy);
  if (!requester || !approver || !decider || requester === approver || requester === decider || approver !== decider) return false;
  const created = Number(r.createdAt), approved = Number(r.approvedAt), until = Number(r.accessUntil);
  const deadline = pendingDeadline(r);
  return Number.isSafeInteger(created) && Number.isSafeInteger(approved) && Number.isSafeInteger(until)
    && approved >= created && deadline > approved
    && until > approved && until <= approved + ACCESS_MS;
}
function approvedByOther(cfg, r) {
  return approvedMetadataOk(cfg, r) && grantOk(cfg, r);
}
/* الطلب الذي حصل على موافقة فعلية لا يُحسب كإزعاج عند إرسال طلب جديد.
   v2 يطلب إثباتًا تاريخيًا مستقلاً. سجلات v1 المنتهية يدويًا فقدت توقيع الفتح
   عمدًا؛ نقبل بيانات إغلاقها القديمة للتوافق فقط. إثبات التاريخ لا يفتح الحضور. */
function hasApprovalHistory(cfg, r) {
  if (!approvedMetadataOk(cfg, r)) return false;
  if (approvedByOther(cfg, r)) return true;
  if (typeof r.approvalHistory === 'string' && safeEqual(r.approvalHistory, approvalHistorySig(cfg, r))) return true;
  return !String(r.id || '').startsWith('r2_') && r.status === 'revoked' && Number.isSafeInteger(Number(r.closedAt))
    && Number(r.closedAt) >= Number(r.approvedAt) && !!normUser(r.closedBy);
}

const VIEW_FIELDS = ['id', 'kind', 'username', 'name', 'requesterPhone', 'approverUsername', 'approverName', 'status',
  'createdAt', 'approvalUntil', 'approvedAt', 'accessUntil', 'decidedBy', 'decidedByName', 'closedAt', 'closedBy',
  'closedByName', 'notifiedAt', 'lastSaveAt', 'saves'];

function effectiveStatus(cfg, r, now) {
  if (r.status === 'pending' && !(pendingDeadline(r) > now)) return 'expired';
  if ((r.status === 'active' || r.status === 'saving') && !approvedByOther(cfg, r)) return 'revoked';
  if ((r.status === 'active' || r.status === 'saving') && !(Number(r.accessUntil) > now)) return 'expired';
  return r.status;
}
function view(cfg, r, now) {
  const o = {};
  for (const f of VIEW_FIELDS) if (r[f] !== undefined && r[f] !== null) o[f] = r[f];
  o.status = effectiveStatus(cfg, r, now);
  return o;
}
async function loadRequests(cfg) {
  const data = await dbGet(cfg, PATHS.requests);
  return isObj(data) ? data : {};
}
function requestList(cfg, all) {
  return Object.entries(all).filter(([id, r]) => isObj(r) && r.id === id && r.username && genuine(cfg, r)).map(([, r]) => r);
}
function pruneUpdates(cfg, all, now) {
  const u = {};
  for (const [id, r] of Object.entries(all)) {
    if (!isObj(r) || r.id !== id || !genuine(cfg, r) || !(now - (Number(r.createdAt) || 0) < KEEP_MS)) u[PATHS.requests + '/' + id] = null;
  }
  return u;
}
const isRunning = (cfg, r, now) => ['active', 'saving'].includes(effectiveStatus(cfg, r, now));
function closedText(r, st) {
  const texts = {
    rejected: 'الطلب ده اترفض بالفعل.',
    revoked: 'الطلب ده اتقفل بالفعل.',
    superseded: 'الطلب ده اتبدل بطلب أحدث.',
    expired: 'انتهت مهلة الطلب ده.',
  };
  return texts[st] || 'الطلب ده اتقفل.';
}
function checkId(id, label) {
  const v = String(id || '');
  if (!ID_RE.test(v)) throw new ApiError(400, label || 'رقم الطلب غير صحيح.');
  return v;
}

/* ───────────────────────── سجل النشاطات ───────────────────────── */
function logEntry(me, action, details, now) {
  const key = 'l' + now + Math.floor(Math.random() * 1000);
  return {
    [PATHS.log + '/' + key]: {
      servant: me.name,
      username: me.key,
      action,
      details: String(details || '').slice(0, 2000),
      at: { '.sv': 'timestamp' },
      deviceAt: now,
    },
  };
}
async function bumpLogCount(cfg) {
  try { await transact(cfg, PATHS.logCount, (cur) => (typeof cur === 'number' ? cur + 1 : undefined), 5); }
  catch (e) { console.warn('[attendance-access] log count:', e && e.message); }
}

/* ───────────────────────── العمليات ───────────────────────── */
/* بعض الحسابات القديمة تحفظ كلمة المرور كما هي، وبعضها يحمل PBKDF2 ووسم zk1$.
   لا نقبل قيمة التجزئة نفسها كأنها كلمة مرور قابلة للدخول. */
async function verifyAccountPassword(s, password) {
  const stored = s.password === undefined || s.password === null ? '' : String(s.password);
  if (stored && !stored.startsWith('zk1$') && safeEqual(stored, password)) return true;
  if (typeof s.passwordSalt !== 'string' || !s.passwordSalt) return false;
  let salt;
  try { salt = Buffer.from(s.passwordSalt, 'base64'); } catch (_) { return false; }
  if (salt.length < 8 || salt.length > 64) return false;
  async function verifyHash(input, encoded, iterations) {
    if (typeof encoded !== 'string' || !encoded) return false;
    const count = Number(iterations);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) return false;
    let expected;
    try { expected = Buffer.from(encoded, 'base64'); } catch (_) { return false; }
    if (expected.length !== 32) return false;
    const actual = await new Promise((resolve, reject) => crypto.pbkdf2(input, salt, count, expected.length, 'sha256',
      (err, derived) => err ? reject(err) : resolve(derived)));
    return crypto.timingSafeEqual(actual, expected);
  }
  if (s.passwordHash && await verifyHash(password, String(s.passwordHash), Number(s.passwordIterations) || 120000)) return true;
  if (stored.startsWith('zk1$')) return verifyHash('srv-api-v1:' + password, stored.slice(4), 60000);
  return false;
}

async function accountLogin(ctx) {
  const { cfg, body, uid } = ctx;
  const username = String(body.username || '').trim().slice(0, 200);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) throw new ApiError(400, 'اكتب اسم المستخدم وكلمة المرور.');
  const map = await loadServants(cfg, true);
  const found = findServant(map, username);
  if (!found) throw new ApiError(401, 'الحساب ده مش موجود في قاعدة البيانات.');
  const { key, s } = found;
  const me = describe(key, s);
  let ok = await verifyAccountPassword(s, password);
  if (!ok && me.isOwner && cfg.ownerPasscode && safeEqual(cfg.ownerPasscode, password)) ok = true;
  if (!ok) {
    throw new ApiError(401, me.isOwner && !cfg.ownerPasscode
      ? 'كلمة المرور دي مش هي المسجلة لحسابك في قاعدة البيانات. لو دخلت بالكود العام: ادخل بكلمة مرور حسابك، أو ضيف OWNER_PASSCODE في Vercel.'
      : 'كلمة المرور مش مطابقة للمسجلة في قاعدة البيانات.');
  }
  if (s.disabled) throw new ApiError(403, 'الحساب ده موقوف حاليًا.');
  if (!me.active) throw new ApiError(403, 'الحساب ده مش من حسابات الإدارة.');
  const now = Date.now();
  const expiresAt = now + SESSION_MS;
  const token = signSession(cfg, { v: 1, k: key, u: me.uname, uid, ap: me.canApprove, iat: now, exp: expiresAt });
  return { token, expiresAt, approvalAccess: me.canApprove, canRequest: me.canRequest, username: me.uname, name: me.name };
}

async function status(ctx) {
  const now = Date.now();
  const all = await loadRequests(ctx.cfg);
  const requests = requestList(ctx.cfg, all)
    .filter((r) => r.username === ctx.me.uname && now - (Number(r.createdAt) || 0) < RECENT_MS)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((r) => view(ctx.cfg, r, now));
  return { requests };
}

async function list(ctx) {
  const { me } = ctx;
  if (!me.canApprove) throw new ApiError(403, 'صلاحية «موافقات فتح الحضور» مش مفعلة لحسابك.');
  const now = Date.now();
  const all = await loadRequests(ctx.cfg);
  const requests = requestList(ctx.cfg, all)
    .filter((r) => (r.approverUsername === me.uname || r.username === me.uname) && now - (Number(r.createdAt) || 0) < RECENT_MS)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((r) => view(ctx.cfg, r, now));
  return { requests };
}

async function approvers(ctx) {
  const map = await loadServants(ctx.cfg, true);
  const out = Object.entries(map)
    .filter(([, s]) => isObj(s))
    .map(([k, s]) => describe(k, s))
    .filter((d) => d.active && d.canApprove && d.uname !== ctx.me.uname)
    .map((d) => ({ username: d.uname, name: d.name, isOwner: d.isOwner }))
    .sort((a, b) => (Number(b.isOwner) - Number(a.isOwner)) || a.name.localeCompare(b.name, 'ar'));
  return { approvers: out };
}

/* المسار القديم باقٍ للرد الواضح على الصفحات القديمة، لكنه لا ينشئ أي إذن. */
async function ownerGrant() {
  throw new ApiError(403, 'الفتح المباشر متوقف. ابعت طلب موافقة لمسؤول آخر من داخل السيستم.');
}

async function request(ctx) {
  const { cfg, me, body } = ctx;
  if (!me.canRequest) throw new ApiError(403, 'صلاحية «طلب فتح الحضور» غير مفعلة لحسابك.');
  const map = await loadServants(cfg, true);
  const found = findServant(map, body.approverUsername);
  if (!found) throw new ApiError(400, 'اختار مسؤول الموافقة من القائمة.');
  const ap = describe(found.key, found.s);
  if (ap.uname === me.uname) throw new ApiError(400, 'مينفعش توافق على طلبك بنفسك. اختار مسؤول تاني.');
  if (!ap.active || !ap.canApprove) throw new ApiError(400, 'الحساب ده مش معاه صلاحية «موافقات فتح الحضور».');

  const now = Date.now();
  const all = await loadRequests(cfg);
  const mine = requestList(cfg, all).filter((r) => r.username === me.uname);
  const running = mine.find((r) => isRunning(cfg, r, now));
  if (running) return { id: running.id, request: view(cfg, running, now) };
  const pending = mine.filter((r) => r.status === 'pending' && pendingDeadline(r) > now)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (pending.length && !body.renew && pending[0].approverUsername === ap.uname) return { id: pending[0].id, request: view(cfg, pending[0], now) };
  /* لا نعاقب التجديد الطبيعي بعد موافقة انتهت أو اتقفلت. نحمي المسؤول من
     تكرار الطلبات غير المعتمدة، ونبدأ العد من آخر موافقة موثقة. */
  const lastApproval = mine.reduce((latest, r) => hasApprovalHistory(cfg, r) ? Math.max(latest, Number(r.approvedAt) || 0) : latest, 0);
  const unanswered = mine.filter((r) => {
    const created = Number(r.createdAt) || 0;
    return now - created < 30 * MINUTE && created > lastApproval && !hasApprovalHistory(cfg, r);
  });
  if (unanswered.length >= 12) {
    throw new ApiError(429, 'اتبعت طلبات كتير من غير موافقة ورا بعض. استنى شوية وجرّب تاني.');
  }
  for (const old of pending) {
    await transact(cfg, PATHS.requests + '/' + old.id,
      (r) => (isObj(r) && r.status === 'pending' ? Object.assign({}, r, { status: 'superseded', closedAt: now, closedBy: me.uname }) : undefined), 5)
      .catch(() => {});
  }
  const id = newId(now);
  const rec = {
    id, kind: 'request', username: me.uname, name: me.name, requesterPhone: me.phone,
    approverUsername: ap.uname, approverName: ap.name, status: 'pending',
    createdAt: now, approvalUntil: now + APPROVAL_MS,
  };
  rec.sig0 = originSig(cfg, rec);
  const updates = Object.assign(pruneUpdates(cfg, all, now), { [PATHS.requests + '/' + id]: rec },
    logEntry(me, 'طلب فتح الحضور', 'طلب من ' + ap.name + ' (@' + ap.uname + ') فتح تعديل الحضور السابق لمدة ٣٠ دقيقة.', now));
  await dbPatch(cfg, '', updates);
  await bumpLogCount(cfg);
  return { id, request: view(cfg, rec, now) };
}

async function decide(ctx, kind) {
  const { cfg, me, body } = ctx;
  const id = checkId(body.id);
  let err = null;
  let result = null;
  let changed = false;
  await transact(cfg, PATHS.requests + '/' + id, (r) => {
    err = null; result = null; changed = false;
    const now = Date.now();
    if (!isObj(r) || r.id !== id || !r.username || !genuine(cfg, r)) { err = new ApiError(404, 'الطلب ده مش موجود أو اتمسح.'); return undefined; }
    const st = effectiveStatus(cfg, r, now);
    const isApprover = r.approverUsername === me.uname;
    if (kind === 'approve' || kind === 'reject') {
      if (normUser(r.username) === me.uname) { err = new ApiError(403, 'مينفعش توافق على طلبك بنفسك. اختار مسؤول تاني.'); return undefined; }
      if (!isApprover) { err = new ApiError(403, 'الطلب ده مش موجه ليك.'); return undefined; }
      if (!me.canApprove) { err = new ApiError(403, 'صلاحية «موافقات فتح الحضور» مش مفعلة لحسابك.'); return undefined; }
      if (kind === 'approve') {
        if (st === 'active' || st === 'saving') { result = r; return undefined; } // اتوافق عليه قبل كده: من غير مدة جديدة
        if (r.status === 'pending' && st === 'expired') { err = new ApiError(409, 'انتهت مهلة الموافقة على الطلب ده (٥ دقائق). خلّي الخادم يبعت طلب جديد.'); return undefined; }
        if (st !== 'pending') { err = new ApiError(409, closedText(r, st)); return undefined; }
        result = Object.assign({}, r, { status: 'active', approvedAt: now, accessUntil: now + ACCESS_MS, decidedBy: me.uname, decidedByName: me.name });
        result.sig = grantSig(cfg, result);
        result.approvalHistory = approvalHistorySig(cfg, result);
      } else {
        if (st === 'rejected') { result = r; return undefined; }
        if (st === 'active' || st === 'saving') { err = new ApiError(409, 'الطلب ده اتوافق عليه بالفعل. لو عايز تقفله استخدم «إنهاء إذن التعديل».'); return undefined; }
        if (st !== 'pending') { err = new ApiError(409, closedText(r, st)); return undefined; }
        result = Object.assign({}, r, { status: 'rejected', closedAt: now, decidedBy: me.uname, decidedByName: me.name });
      }
    } else {
      if (r.username !== me.uname && !isApprover && !me.isOwner) { err = new ApiError(403, 'مش من حقك تقفل الطلب ده.'); return undefined; }
      if (!(st === 'pending' || st === 'active' || st === 'saving')) { result = r; return undefined; } // مقفول أصلًا
      result = Object.assign({}, r, { status: 'revoked', closedAt: now, closedBy: me.uname, closedByName: me.name });
      if (approvedByOther(cfg, r)) result.approvalHistory = approvalHistorySig(cfg, r);
      delete result.sig; // لا نترك توقيع إذن فعّال في سجل تم إغلاقه
    }
    changed = true;
    return result;
  });
  if (err) throw err;
  const now = Date.now();
  if (changed) {
    const who = result.name + ' (@' + result.username + ')';
    let entry;
    if (kind === 'approve') entry = logEntry(me, 'موافقة على فتح الحضور', 'وافق على طلب ' + who + ' — تعديل الأيام السابقة مفتوح لحد ' + cairoTime(result.accessUntil) + '.', now);
    else if (kind === 'reject') entry = logEntry(me, 'رفض طلب فتح الحضور', 'رفض طلب ' + who + ' لفتح تعديل الحضور السابق.', now);
    else if (result.username === me.uname) entry = logEntry(me, 'إلغاء/إنهاء فتح الحضور', 'قفل طلب فتح تعديل الحضور الخاص بيه.', now);
    else entry = logEntry(me, 'إنهاء إذن فتح الحضور', 'قفل إذن تعديل الحضور الخاص بـ' + who + '.', now);
    await dbPatch(cfg, '', entry);
    await bumpLogCount(cfg);
  }
  return { id, request: view(cfg, result, now) };
}

async function notification(ctx) {
  const { cfg, me, body } = ctx;
  const id = checkId(body.id);
  await transact(cfg, PATHS.requests + '/' + id, (r) => (
    isObj(r) && r.id === id && genuine(cfg, r) && r.approverUsername === me.uname && !r.notifiedAt
      ? Object.assign({}, r, { notifiedAt: Date.now(), soundPlayed: body.soundPlayed === true })
      : undefined), 3);
  return {};
}

function cleanValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    if (v.length > 200) throw new ApiError(400, 'قيمة حضور غير صحيحة.');
    return v;
  }
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return v;
  throw new ApiError(400, 'قيمة حضور غير صحيحة.');
}
function parseSavePayload(b) {
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))
    || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw new ApiError(400, 'تاريخ اليوم غير صحيح.');
  const levelIndex = Number(b.levelIndex);
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex > 50) throw new ApiError(400, 'المستوى غير صحيح.');
  const classCode = String(b.classCode === undefined || b.classCode === null ? '' : b.classCode).trim() || 'عام';
  if (classCode.length > 80 || BAD_KEY_RE.test(classCode)) throw new ApiError(400, 'اسم الفصل فيه حروف مش مسموحة في قاعدة البيانات (. # $ [ ] /).');
  const opId = String(b.operationId || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(opId)) throw new ApiError(400, 'رقم العملية غير صحيح. حدّث الصفحة وجرّب تاني.');
  const patchIn = isObj(b.recordsPatch) ? b.recordsPatch : {};
  const expIn = isObj(b.expected) ? b.expected : {};
  const names = Object.keys(patchIn);
  if (names.length > 3000) throw new ApiError(413, 'التعديل كبير زيادة مرة واحدة.');
  const patch = {};
  const expected = {};
  for (const n of names) {
    if (!n || n.length > 300 || BAD_KEY_RE.test(n)) throw new ApiError(400, 'الاسم «' + n.slice(0, 40) + '» فيه حروف مش مسموحة في قاعدة البيانات.');
    patch[n] = cleanValue(patchIn[n]);
    expected[n] = cleanValue(has(expIn, n) ? expIn[n] : null);
  }
  const lessonContent = typeof b.lessonContent === 'string' ? b.lessonContent.slice(0, 20000) : '';
  let lessonNumber = null;
  if (b.lessonNumber !== null && b.lessonNumber !== undefined && b.lessonNumber !== '') {
    lessonNumber = Number(b.lessonNumber);
    if (!Number.isFinite(lessonNumber)) throw new ApiError(400, 'رقم الدرس غير صحيح.');
  }
  return {
    id: b.id === undefined || b.id === null ? '' : String(b.id),
    date, levelIndex, classCode, opId, patch, expected, lessonContent, lessonNumber,
    finalized: b.finalized === true,
    level: typeof b.level === 'string' ? b.level.slice(0, 80) : '',
  };
}
function describeChange(p, changed, grant) {
  const level = p.level || LEVELS[p.levelIndex] || ('المستوى ' + (p.levelIndex + 1));
  const cls = p.classCode && p.classCode !== 'عام' ? ' — فصل ' + p.classCode : '';
  const items = changed.slice(0, 12).map((n) => n + ': ' + (p.patch[n] === null ? 'اتشال' : (STATUS_AR[p.patch[n]] || String(p.patch[n]))));
  const more = changed.length > 12 ? ' … و' + (changed.length - 12) + ' كمان' : '';
  let via = '';
  if (grant) via = ' (بموافقة ' + (grant.decidedByName || grant.approverName || '') + ')';
  return level + cls + ' يوم ' + p.date + via + ': ' + items.join('، ') + more;
}

async function saveOperation(ctx, todayMode) {
  const { cfg, me, body } = ctx;
  const p = parseSavePayload(body);
  const now = Date.now();
  const today = cairoDate(now);
  let grant = null;
  let gid = '';
  let opPath;
  if (!todayMode) {
    gid = checkId(p.id, 'رقم إذن الفتح غير صحيح.');
    grant = await dbGet(cfg, PATHS.requests + '/' + gid);
    if (!isObj(grant) || grant.id !== gid || grant.username !== me.uname || !genuine(cfg, grant)) throw new ApiError(403, 'إذن فتح الحضور ده غير صحيح لحسابك.');
    if (!me.canRequest) throw new ApiError(403, 'صلاحية «طلب فتح الحضور» غير مفعلة لحسابك دلوقتي.');
    if (!(p.date < cairoDate(Date.now()))) throw new ApiError(400, 'التاريخ ده مش يوم سابق — حضور النهاردة بيتسجل عادي من غير موافقة.');
    if (!approvedByOther(cfg, grant)) throw new ApiError(403, 'الإذن غير مرتبط بموافقة المسؤول المختار أو اتقفل. ابعت طلب جديد.');
    const done = isObj(grant.ops) ? grant.ops[p.opId] : null;
    if (isObj(done)) return { duplicate: true, key: done.key, changed: done.changed || 0, accessUntil: grant.accessUntil };
    if (grant.status === 'revoked') throw new ApiError(409, 'الموافقة اتسحبت، وتعديل الأيام السابقة اتقفل. اطلب موافقة جديدة.');
    if (grant.status !== 'active' && grant.status !== 'saving') throw new ApiError(409, 'الطلب ده لسه مش متوافق عليه أو اتقفل — تعديل الأيام السابقة غير متاح.');
    if (!(Number(grant.accessUntil) > Date.now())) throw new ApiError(409, 'انتهت الـ٣٠ دقيقة بتاعة فتح الحضور. اطلب موافقة جديدة.');
    opPath = PATHS.requests + '/' + gid + '/ops/' + p.opId;
  } else {
    if (p.date !== today) throw new ApiError(400, 'التاريخ ده مش يوم النهاردة — تعديل الأيام السابقة محتاج موافقة فتح الحضور.');
    if (!me.canAttend) throw new ApiError(403, 'صلاحية تسجيل الحضور غير مفعلة لحسابك.');
    opPath = PATHS.todayOps + '/' + today + '/' + p.opId;
    const done = await dbGet(cfg, opPath);
    if (isObj(done)) return { duplicate: true, key: done.key, changed: done.changed || 0 };
  }

  /* أعد فحص حالة الإذن قبيل الكتابة: لو المسؤول سحبه أو المدة انتهت أثناء الشبكة، نرفض. */
  if (grant) {
    const freshGrant = await dbGet(cfg, PATHS.requests + '/' + gid);
    if (!isObj(freshGrant) || freshGrant.id !== gid || freshGrant.username !== me.uname
      || !isRunning(cfg, freshGrant, Date.now())) {
      throw new ApiError(409, 'إذن فتح الحضور انتهى أو اتسحب قبل الحفظ. اطلب موافقة جديدة.');
    }
    grant = freshGrant;
  }
  const key = p.date + '__' + p.levelIndex + '__' + p.classCode;
  let conflict = null;
  let finalizedConflict = false;
  let expiredWhileSaving = false;
  let changed = [];
  await transact(cfg, PATHS.attendance + '/' + key, (node) => {
    conflict = null;
    finalizedConflict = false;
    expiredWhileSaving = false;
    changed = [];
    if (grant && !(Number(grant.accessUntil) > Date.now())) { expiredWhileSaving = true; return undefined; }
    const cur = isObj(node) ? node : null;
    if (todayMode && cur && cur.finalized === true) { finalizedConflict = true; return undefined; }
    const records = Object.assign({}, cur && isObj(cur.records) ? cur.records : {});
    for (const n of Object.keys(p.patch)) {
      const haveNow = has(records, n) ? records[n] : null;
      const next = p.patch[n];
      if (same(haveNow, next)) continue;                                    // متسجل كده أصلًا
      if (!same(haveNow, p.expected[n])) { conflict = n; return undefined; } // حد غيّره من جهاز تاني
      changed.push(n);
      if (next === null) delete records[n]; else records[n] = next;
    }
    const lessonSame = cur && same(cur.lessonContent || '', p.lessonContent)
      && same(cur.lessonNumber === undefined ? null : cur.lessonNumber, p.lessonNumber);
    if (cur && !changed.length && lessonSame && (!todayMode || !!cur.finalized === p.finalized)) return undefined;
    if (!cur && !changed.length && !p.lessonContent && p.lessonNumber === null) return undefined; // مفيش حاجة تتسجل
    const out = Object.assign({}, cur || {});
    out.records = records;
    out.date = p.date;
    out.levelIndex = p.levelIndex;
    out.classCode = p.classCode;
    if (!out.level) out.level = p.level || LEVELS[p.levelIndex] || '';
    out.lessonContent = p.lessonContent;
    out.lessonNumber = p.lessonNumber;
    out.finalized = todayMode ? p.finalized : !!(cur && cur.finalized); // التعديل المتأخر ما بيغيّرش القفل النهائي
    out.updatedAt = now;
    return out;
  });
  if (expiredWhileSaving) throw new ApiError(409, 'انتهت الـ٣٠ دقيقة قبل حفظ التعديل. اطلب موافقة جديدة.');
  if (finalizedConflict) throw new ApiError(409, 'حضور اليوم ده مؤكد ومغلق؛ لم يتم حفظ التعديل.');
  if (conflict) throw new ApiError(409, 'حضور «' + conflict + '» اتغير من جهاز تاني بعد ما فتحت اليوم ده. حدّث الصفحة وراجع قبل ما تحفظ.');

  const updates = { [opPath]: { at: now, key, changed: changed.length, by: me.uname } };
  if (grant) {
    updates[PATHS.requests + '/' + gid + '/lastSaveAt'] = now;
    updates[PATHS.requests + '/' + gid + '/saves'] = (Number(grant.saves) || 0) + 1;
  }
  if (changed.length) {
    Object.assign(updates, logEntry(me, grant ? 'تعديل حضور يوم سابق (بموافقة)' : 'تسجيل حضور اليوم', describeChange(p, changed, grant), now));
  }
  if (todayMode) {
    const days = await dbGet(cfg, PATHS.todayOps, { shallow: 'true' }).catch(() => null);
    if (isObj(days)) for (const d of Object.keys(days)) if (d < cairoDate(now - 2 * DAY)) updates[PATHS.todayOps + '/' + d] = null;
  }
  await dbPatch(cfg, '', updates);
  if (changed.length) await bumpLogCount(cfg);
  return { key, changed: changed.length, accessUntil: grant ? grant.accessUntil : undefined };
}

/* ملاحظات الخدام: مشفّرة، مرتبطة بمعرّف المخدوم، وصلاحيتها من حساب الخادم. */
const NOTES_ROOT = 'shamamsa-skill-notes-v1';
const NOTE_CATEGORIES = Object.freeze({alhan:'الألحان',coptic:'القبطي',rites:'الطقس',readings:'القراءات والمحفوظات',service:'الخدمة',other:'ملاحظات عامة'});
const NOTE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

function notesKeys() {
  const raw = env('NOTES_ENCRYPTION_KEY');
  let master = null;
  if (/^[0-9a-f]{64}$/i.test(raw)) master = Buffer.from(raw, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(raw)) {
    try { master = Buffer.from(raw.replace(/-/g,'+').replace(/_/g,'/'), 'base64'); } catch (_) {}
  }
  if (!master || master.length !== 32) throw new ApiError(503, 'مفتاح حماية الملاحظات غير متجهّز. اتبع خطوة NOTES_ENCRYPTION_KEY في README ثم أعد النشر.');
  return {
    enc: crypto.createHmac('sha256', master).update('student-notes-encryption-v1').digest(),
    index: crypto.createHmac('sha256', master).update('student-notes-index-v1').digest(),
  };
}
function notesReady() { try { notesKeys(); return true; } catch (_) { return false; } }
function notesGuard(ctx) {
  if (!ctx.me || !(ctx.me.isOwner || ctx.me.canDeacons)) throw new ApiError(403, 'عرض وإضافة الملاحظات يحتاج صلاحية تسجيل المخدومين.');
  return notesKeys();
}
function studentId(value) {
  const id=typeof value==='string' ? value.trim() : '';
  if(!id || id.length>200 || BAD_KEY_RE.test(id)) throw new ApiError(400, 'معرّف المخدوم غير صالح.');
  return id;
}
function noteId(value) {
  const id=typeof value==='string'?value:'';
  if(!NOTE_ID_RE.test(id)) throw new ApiError(400, 'معرّف الملاحظة غير صالح.');
  return id;
}
function mutationId(value) {
  const id=typeof value==='string'?value:'';
  if(!NOTE_ID_RE.test(id)) throw new ApiError(400, 'معرّف العملية غير صالح.');
  return id;
}
function noteFields(body) {
  const category=String(body.category||'');
  if(!has(NOTE_CATEGORIES,category)) throw new ApiError(400, 'اختار نوع الملاحظة.');
  if(typeof body.text!=='string') throw new ApiError(400, 'اكتب نص الملاحظة.');
  const text=body.text.replace(/\r\n?/g,'\n').trim();
  if(!text || text.length>1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new ApiError(400, 'اكتب ملاحظة من ١ إلى ١٠٠٠ حرف بدون رموز تحكم.');
  return {category,text};
}
const NOTES_META_PATH = 'shamamsa-skill-notes-config/v1';
function keyFingerprint(keys) { return crypto.createHmac('sha256',keys.index).update('notes-key-verifier-v1').digest('base64url'); }
async function verifyNotesKey(cfg,keys,initialize) {
  const expected=keyFingerprint(keys),meta=await dbGet(cfg,NOTES_META_PATH);
  function check(value) {
    if(!isObj(value)||value.v!==1||typeof value.keyCheck!=='string'||!safeEqual(value.keyCheck,expected)) throw new ApiError(503,'مفتاح حماية الملاحظات مختلف عن المفتاح المستخدم عند حفظها، أو مؤشر الحماية تالف. أعد المفتاح الأصلي من النسخة الآمنة ولا تحفظ ملاحظات جديدة.');
  }
  if(meta!==null && meta!==undefined){check(meta);return;}
  const existing=await dbGet(cfg,NOTES_ROOT);
  if(existing!==null && (typeof existing!=='object'||Object.keys(existing).length)) throw new ApiError(503,'مؤشر حماية الملاحظات مفقود مع وجود بيانات سابقة؛ استعد المؤشر والمفتاح من النسخة الاحتياطية قبل المتابعة.');
  if(!initialize)return;
  await transact(cfg,NOTES_META_PATH,current=>{
    if(current!==null && current!==undefined){check(current);return undefined;}
    return {v:1,keyCheck:expected};
  });
}
function noteBucket(keys,id) { return crypto.createHmac('sha256',keys.index).update('student-id-v1|'+id).digest('base64url'); }
function notePath(keys,id,nid) { return NOTES_ROOT+'/'+noteBucket(keys,id)+'/'+nid; }
function encryptNote(keys,bucket,nid,note) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',keys.enc,iv);
  cipher.setAAD(Buffer.from('student-note-v1|'+bucket+'|'+nid,'utf8'));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(note),'utf8'),cipher.final()]);
  return {v:1,iv:iv.toString('base64url'),data:ciphertext.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')};
}
function decryptNote(keys,bucket,nid,blob) {
  try {
    if(!isObj(blob)||blob.v!==1||typeof blob.iv!=='string'||typeof blob.data!=='string'||typeof blob.tag!=='string') throw Error('bad blob');
    const iv=Buffer.from(blob.iv,'base64url'),data=Buffer.from(blob.data,'base64url'),tag=Buffer.from(blob.tag,'base64url');
    if(iv.length!==12||tag.length!==16||data.length>12000) throw Error('bad size');
    const decipher=crypto.createDecipheriv('aes-256-gcm',keys.enc,iv);
    decipher.setAAD(Buffer.from('student-note-v1|'+bucket+'|'+nid,'utf8'));decipher.setAuthTag(tag);
    const n=JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'));
    if(!isObj(n)||n.id!==nid||!NOTE_ID_RE.test(n.id)||!n.studentId||noteBucket(keys,n.studentId)!==bucket||!has(NOTE_CATEGORIES,n.category)||typeof n.text!=='string'||typeof n.schoolYear!=='string'||typeof n.authorUsername!=='string'||typeof n.version!=='string') throw Error('bad note');
    return n;
  } catch (_) { throw new ApiError(500, 'تعذرت قراءة ملاحظة محفوظة أو التحقق من سلامتها. تأكد من مفتاح الحماية والنسخة الاحتياطية؛ لم يتم عرض نتائج ناقصة.'); }
}
function canEditNote(me,n) { return !!me && (me.isOwner || me.isSchoolAdmin || me.uname===String(n.authorUsername||'').toLowerCase()); }
function publicNote(n,me) {
  return {id:n.id,studentId:n.studentId,studentName:n.studentName,schoolYear:n.schoolYear,category:n.category,categoryLabel:NOTE_CATEGORIES[n.category],text:n.text,authorUsername:n.authorUsername,authorName:n.authorName,createdAt:n.createdAt,updatedAt:n.updatedAt,updatedBy:n.updatedBy||'',edited:!!n.lastMutation,version:n.version,canEdit:canEditNote(me,n)};
}
function historyYears(r) {
  const entries=[r];
  if(Array.isArray(r.history)) entries.push(...r.history);
  else if(isObj(r.history)) entries.push(...Object.values(r.history));
  return new Set(entries.filter(isObj).map(x=>String(x.year||'').trim()).filter(Boolean));
}
function sortNotes(a,b) { return String(b.schoolYear).localeCompare(String(a.schoolYear)) || Number(b.createdAt)-Number(a.createdAt) || a.id.localeCompare(b.id); }
async function skillNotesList(ctx) {
  const keys=notesGuard(ctx),sid=studentId(ctx.body.studentId),bucket=noteBucket(keys,sid);
  await verifyNotesKey(ctx.cfg,keys,false);
  const raw=await dbGet(ctx.cfg,NOTES_ROOT+'/'+bucket);
  if(raw!==null&&!isObj(raw)) throw new ApiError(500,'بيانات ملاحظات المخدوم غير صالحة؛ لم يتم عرض نتائج ناقصة.');
  const list=[];
  for(const [id,blob] of Object.entries(raw||{})) { if(!NOTE_ID_RE.test(id)) throw new ApiError(500,'بيانات ملاحظات المخدوم غير صالحة.'); const n=decryptNote(keys,bucket,id,blob); if(n.studentId!==sid) throw new ApiError(500,'تعذر التحقق من المخدوم.'); list.push(publicNote(n,ctx.me)); }
  list.sort(sortNotes);
  return {notes:list};
}
async function skillNotesAdd(ctx) {
  const keys=notesGuard(ctx),sid=studentId(ctx.body.studentId),nid=noteId(ctx.body.noteId),fields=noteFields(ctx.body);
  const schoolYear=typeof ctx.body.schoolYear==='string'?ctx.body.schoolYear.trim():'';
  if(!schoolYear||schoolYear.length>64) throw new ApiError(400,'اختار سنة دراسية صحيحة.');
  const student=await dbGet(ctx.cfg,'shamamsa/'+sid);
  if(!isObj(student)) throw new ApiError(404,'ملف المخدوم مش موجود؛ احفظ الملف أولًا.');
  if(!historyYears(student).has(schoolYear)) throw new ApiError(409,'السنة مش محفوظة في ملف المخدوم. احفظ بيانات السنة أولًا ثم أضف الملاحظة.');
  await verifyNotesKey(ctx.cfg,keys,true);
  const bucket=noteBucket(keys,sid),path=notePath(keys,sid,nid),now=Date.now();
  let result=null,duplicate=false;
  await transact(ctx.cfg,path,current=>{
    if(current!==null && current!==undefined) {
      const prev=decryptNote(keys,bucket,nid,current);
      if(prev.studentId!==sid||prev.authorUsername!==ctx.me.uname||prev.schoolYear!==schoolYear||prev.category!==fields.category||prev.text!==fields.text) throw new ApiError(409,'معرّف الملاحظة مستخدم لبيانات مختلفة. جرّب إضافة جديدة.');
      result=prev;duplicate=true;return undefined;
    }
    result={id:nid,studentId:sid,studentName:String(student.name||'').slice(0,160),schoolYear,category:fields.category,text:fields.text,authorUsername:ctx.me.uname,authorName:String(ctx.me.name||ctx.me.key).slice(0,120),createdAt:now,updatedAt:now,updatedBy:ctx.me.uname,version:crypto.randomBytes(18).toString('base64url'),lastMutation:''};
    return encryptNote(keys,bucket,nid,result);
  });
  return {note:publicNote(result,ctx.me),duplicate};
}
async function skillNotesEdit(ctx) {
  const keys=notesGuard(ctx),sid=studentId(ctx.body.studentId),nid=noteId(ctx.body.noteId),op=mutationId(ctx.body.mutationId),fields=noteFields(ctx.body);
  const expected=typeof ctx.body.version==='string'?ctx.body.version:'';
  if(!NOTE_ID_RE.test(expected)) throw new ApiError(400,'نسخة الملاحظة غير صالحة؛ حدّث القائمة.');
  await verifyNotesKey(ctx.cfg,keys,false);
  const bucket=noteBucket(keys,sid),path=notePath(keys,sid,nid),now=Date.now();let result=null;
  await transact(ctx.cfg,path,current=>{
    if(!current) throw new ApiError(404,'الملاحظة غير موجودة؛ حدّث القائمة.');
    const prev=decryptNote(keys,bucket,nid,current);
    if(prev.studentId!==sid||!canEditNote(ctx.me,prev)) throw new ApiError(403,'صاحب الملاحظة أو إدارة المدرسة فقط يقدروا يعدّلوها.');
    if(prev.lastMutation===op && prev.updatedBy===ctx.me.uname) {
      if(prev.text!==fields.text || prev.category!==fields.category) throw new ApiError(409,'العملية مستخدمة لبيانات مختلفة.');
      result=prev;return undefined;
    }
    if(prev.version!==expected) throw new ApiError(409,'الملاحظة اتغيّرت من جهاز تاني؛ حدّثها وراجع التعديل.');
    result=Object.assign({},prev,fields,{updatedAt:now,updatedBy:ctx.me.uname,version:crypto.randomBytes(18).toString('base64url'),lastMutation:op});
    return encryptNote(keys,bucket,nid,result);
  });
  return {note:publicNote(result,ctx.me)};
}
async function skillNotesDelete(ctx) {
  const keys=notesGuard(ctx),sid=studentId(ctx.body.studentId),nid=noteId(ctx.body.noteId);
  mutationId(ctx.body.mutationId);
  const expected=typeof ctx.body.version==='string'?ctx.body.version:'';
  if(!NOTE_ID_RE.test(expected)) throw new ApiError(400,'نسخة الملاحظة غير صالحة؛ حدّث القائمة.');
  await verifyNotesKey(ctx.cfg,keys,false);
  const bucket=noteBucket(keys,sid),path=notePath(keys,sid,nid);
  await transact(ctx.cfg,path,current=>{
    if(!current)return undefined;
    const prev=decryptNote(keys,bucket,nid,current);
    if(prev.studentId!==sid||!canEditNote(ctx.me,prev)) throw new ApiError(403,'صاحب الملاحظة أو إدارة المدرسة فقط يقدروا يمسحوها.');
    if(prev.version!==expected) throw new ApiError(409,'الملاحظة اتغيّرت من جهاز تاني؛ حدّث القائمة قبل المسح.');
    return null;
  });
  return {deleted:true};
}
function notesNormalize(value) {
  return String(value||'').normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/\s+/g,' ').trim();
}
async function skillNotesSearch(ctx) {
  const keys=notesGuard(ctx),rawQuery=String(ctx.body.query||'').trim();
  if(rawQuery.length>120) throw new ApiError(400,'كلمة البحث طويلة زيادة.');
  const category=String(ctx.body.category||'');
  if(category&&!has(NOTE_CATEGORIES,category)) throw new ApiError(400,'نوع الملاحظة غير معروف.');
  const offset=Math.max(0,Math.min(100000,Math.floor(Number(ctx.body.offset)||0))),limit=Math.max(1,Math.min(100,Math.floor(Number(ctx.body.limit)||30)));
  await verifyNotesKey(ctx.cfg,keys,false);
  const [raw,roster]=await Promise.all([dbGet(ctx.cfg,NOTES_ROOT),dbGet(ctx.cfg,'shamamsa')]);
  if(raw!==null&&!isObj(raw)) throw new ApiError(500,'بيانات الملاحظات غير صالحة؛ لم يتم عرض نتائج ناقصة.');
  if(roster!==null&&!isObj(roster)) throw new ApiError(500,'قائمة المخدومين غير صالحة؛ لم يتم عرض نتائج ناقصة.');
  const terms=notesNormalize(rawQuery).split(' ').filter(Boolean),matches=[];let checked=0;
  for(const [bucket,group] of Object.entries(raw||{})) {
    if(!/^[A-Za-z0-9_-]{43}$/.test(bucket)||!isObj(group)) throw new ApiError(500,'بيانات الملاحظات غير صالحة؛ لم يتم عرض نتائج ناقصة.');
    for(const [id,blob] of Object.entries(group)) {
      if(++checked>30000) throw new ApiError(413,'عدد الملاحظات كبير جدًا للبحث الحالي؛ تواصل مع المطور لتجهيز بحث مفهرس.');
      if(!NOTE_ID_RE.test(id)) throw new ApiError(500,'بيانات الملاحظات غير صالحة.');
      const n=decryptNote(keys,bucket,id,blob);if(category&&category!==n.category)continue;
      const current=roster&&isObj(roster[n.studentId])?roster[n.studentId]:null;
      const currentName=current?String(current.name||n.studentName||''):String(n.studentName||'');
      const hay=notesNormalize([currentName,n.studentName,n.schoolYear,n.text,NOTE_CATEGORIES[n.category],n.authorName,n.authorUsername].join(' '));
      if(!terms.every(x=>hay.includes(x)))continue;
      const item=publicNote(n,ctx.me);item.currentName=currentName;item.studentExists=!!current;item.currentLevel=current?String(current.level||''):'';item.currentClass=current?String(current.classCode||''):'';matches.push(item);
    }
  }
  matches.sort((a,b)=>String(a.currentName||'').localeCompare(String(b.currentName||''),'ar')||String(a.studentId).localeCompare(String(b.studentId))||sortNotes(a,b));
  return {items:matches.slice(offset,offset+limit),total:matches.length,students:new Set(matches.map(x=>x.studentId)).size,offset,limit};
}

const ACTIONS = {
  accountLogin,
  status,
  list,
  approvers,
  request,
  approve: (ctx) => decide(ctx, 'approve'),
  reject: (ctx) => decide(ctx, 'reject'),
  revoke: (ctx) => decide(ctx, 'revoke'),
  notification,
  ownerGrant,
  save: (ctx) => saveOperation(ctx, false),
  saveToday: (ctx) => saveOperation(ctx, true),
  skillNotesList, skillNotesAdd, skillNotesEdit, skillNotesDelete, skillNotesSearch,
};

/* ───────────────────────── الفحص (GET) ───────────────────────── */
let DEEP = null;

async function deepCheck(cfg) {
  if (DEEP && Date.now() - DEEP.at < 20000) return DEEP.result;
  const checks = { google: null, read: null, write: null, accounts: null };
  try { await accessToken(cfg); checks.google = { ok: true }; }
  catch (e) { checks.google = { ok: false, error: e.message }; }
  if (checks.google.ok) {
    try {
      const map = await loadServants(cfg, true);
      const people = Object.entries(map).filter(([, s]) => isObj(s)).map(([k, s]) => describe(k, s));
      checks.read = { ok: true };
      checks.accounts = {
        owner: people.some((d) => d.isOwner),
        approvers: people.filter((d) => d.active && d.canApprove).length,
        requesters: people.filter((d) => d.active && d.canRequest && !d.isOwner).length,
      };
    } catch (e) { checks.read = { ok: false, error: e.message }; }
    try {
      await dbPut(cfg, PATHS.health, { checkedAt: { '.sv': 'timestamp' }, region: process.env.VERCEL_REGION || null, version: VERSION });
      checks.write = { ok: true };
    } catch (e) { checks.write = { ok: false, error: e.message }; }
  }
  DEEP = { at: Date.now(), result: checks };
  return checks;
}

async function health(req) {
  const cfg = readConfig();
  const url = new URL(req.url || '/', 'http://localhost');
  const out = {
    service: SERVICE,
    version: VERSION,
    configured: cfg.ok,
    missing: cfg.missing,
    invalid: cfg.invalid,
    credentialsFrom: cfg.source || null,
    serviceAccount: cfg.clientEmail ? maskEmail(cfg.clientEmail) : null,
    projectId: cfg.projectId,
    optional: { ATTENDANCE_SESSION_SECRET: !!env('ATTENDANCE_SESSION_SECRET'), OWNER_PASSCODE: !!cfg.ownerPasscode, NOTES_ENCRYPTION_KEY: notesReady() },
    region: process.env.VERCEL_REGION || null,
    serverNow: Date.now(),
  };
  if (url.searchParams.get('check') === '1') out.checks = cfg.ok ? await deepCheck(cfg) : null;
  return out;
}

/* ───────────────────────── قراءة الطلب والرد ───────────────────────── */
async function readBody(req) {
  let pre;
  try { pre = req.body; } catch (_) { throw new ApiError(400, 'بيانات الطلب مش JSON صالح.'); }
  let raw = '';
  if (pre === null) return {};
  if (pre !== undefined) {
    if (Buffer.isBuffer(pre)) raw = pre.toString('utf8');
    else if (typeof pre === 'string') raw = pre;
    else return isObj(pre) ? pre : {};
  } else {
    if (typeof req.on !== 'function' || req.readableEnded) return {};
    raw = await new Promise((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 512 * 1024) { reject(new ApiError(413, 'الطلب كبير زيادة.')); req.destroy(); }
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isObj(parsed) ? parsed : {};
  } catch (_) { throw new ApiError(400, 'بيانات الطلب مش JSON صالح.'); }
}

function send(res, method, status, obj) {
  res.statusCode = status;
  res.end(method === 'HEAD' ? undefined : JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');
  try {
    if (method === 'GET' || method === 'HEAD') return send(res, method, 200, await health(req));
    if (method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      throw new ApiError(405, 'الطريقة دي مش مدعومة. الخدمة بتقبل طلبات GET للفحص، وطلبات POST للعمليات.');
    }
    const cfg = readConfig();
    if (!cfg.ok) throw new ApiError(500, configMessage(cfg), { service: SERVICE, configured: false, missing: cfg.missing, invalid: cfg.invalid });
    const body = await readBody(req);
    const action = typeof body.action === 'string' ? body.action : '';
    const fn = has(ACTIONS, action) ? ACTIONS[action] : null;
    if (!fn) throw new ApiError(400, 'عملية غير معروفة' + (action ? ': ' + action.slice(0, 40) : '') + '.');
    const uid = await verifyIdToken(bearer(req), cfg);
    const ctx = { cfg, uid, body };
    if (action !== 'accountLogin') {
      ctx.session = readSession(cfg, body.session, uid);
      /* العمليات التي تمنح أو تستخدم الإذن تقرأ صلاحيات الحساب من المصدر فورًا، لا من كاش ١٥ ثانية. */
      const sensitive = ['request', 'approve', 'reject', 'revoke', 'ownerGrant', 'save', 'saveToday', 'skillNotesList', 'skillNotesAdd', 'skillNotesEdit', 'skillNotesDelete', 'skillNotesSearch'].includes(action);
      ctx.me = await loadMe(ctx, sensitive);
    }
    const out = await fn(ctx);
    return send(res, method, 200, Object.assign({ ok: true }, out || {}, { serverNow: Date.now() }));
  } catch (e) {
    const known = e instanceof ApiError;
    if (!known || e.status >= 500) console.error('[attendance-access]', known ? e.message : (e && e.stack) || e);
    const payload = Object.assign(
      { ok: false, error: known ? e.message : 'حصل خطأ غير متوقع في خدمة موافقات الحضور. جرّب تاني بعد لحظة.' },
      known && e.extra ? e.extra : {},
      { serverNow: Date.now() },
    );
    return send(res, method, known ? e.status : 500, payload);
  }
};

/* للاختبارات المحلية فقط */
module.exports._test = { reset() { CONFIG = null; ACCESS = null; CERTS = null; SERVANTS = null; DEEP = null; } };
