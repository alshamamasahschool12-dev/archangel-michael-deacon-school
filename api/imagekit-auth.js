'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   توقيع رفع الصور على ImageKit — مدرسة الملاك ميخائيل للشمامسة
   Vercel Function  ←  /api/imagekit-auth

   صفحة الإدارة بتطلب من هنا توقيع مؤقت قبل ما ترفع صورة خادم أو مخدوم على ImageKit.
   محتاج Environment Variable واحد على Vercel:  IMAGEKIT_PRIVATE_KEY  (بيبدأ بـ private_)
   من غير أي مكتبات خارجية.

   GET /api/imagekit-auth?check=1   فحص الإعداد: المفتاح موجود؟ شكله سليم؟ وبيجرّبه مع ImageKit نفسه
                                    (طلب قراءة صغير، من غير ما يرفع أو يمسح أي حاجة)
   GET /api/imagekit-auth           توقيع جديد (لازم تسجيل دخول Firebase من صفحة الإدارة)
   ═══════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || 'alshamamasahschool').trim();
const SIGNATURE_TTL_SECONDS = 30 * 60; // ImageKit بيطلب أقل من ساعة
const IK_VERIFY_URL = 'https://api.imagekit.io/v1/files?limit=1&skip=0';

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

let CERTS = null;
async function googleCerts(force) {
  if (!force && CERTS && CERTS.exp > Date.now()) return CERTS.keys;
  let res;
  let map = null;
  try {
    res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', { signal: AbortSignal.timeout(8000) });
    map = await res.json().catch(() => null);
  } catch (_) { map = null; }
  if (!res || !res.ok || !map || typeof map !== 'object') {
    if (CERTS) return CERTS.keys;
    throw new HttpError(502, 'مش قادر أتأكد من تسجيل الدخول دلوقتي. جرّب تاني بعد لحظة.');
  }
  const keys = {};
  for (const [kid, pem] of Object.entries(map)) {
    try { keys[kid] = new crypto.X509Certificate(pem).publicKey; } catch (_) { /* شهادة بايظة */ }
  }
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  CERTS = { keys, exp: Date.now() + Math.min(m ? Number(m[1]) * 1000 : 3600000, 6 * 3600000) };
  return keys;
}

async function verifyIdToken(token) {
  const bad = () => new HttpError(401, 'سجّل دخولك تاني قبل رفع الصورة.');
  if (!token || token.length > 4096) throw bad();
  const parts = token.split('.');
  if (parts.length !== 3) throw bad();
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) { throw bad(); }
  if (!header || header.alg !== 'RS256' || !header.kid || !payload) throw bad();
  let keys = await googleCerts(false);
  if (!keys[header.kid]) keys = await googleCerts(true);
  const key = keys[header.kid];
  if (!key) throw bad();
  let ok = false;
  try { ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url')); } catch (_) { ok = false; }
  const now = Math.floor(Date.now() / 1000);
  if (!ok || payload.aud !== PROJECT_ID || payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID
    || typeof payload.sub !== 'string' || !payload.sub || !(payload.exp > now - 300) || !(payload.iat < now + 300)) throw bad();
  return payload.sub;
}

/* ── مفتاح ImageKit ─────────────────────────────────────────────────── */
// بيصلّح غلطات اللصق المعروفة: اسم المتغير مع القيمة، علامات تنصيص، مسافات أو سطر جديد.
function readKey() {
  let k = String(process.env.IMAGEKIT_PRIVATE_KEY || '').trim();
  for (let i = 0; i < 2; i++) {
    k = k.replace(/^["'`]+|["'`]+$/g, '').trim();
    k = k.replace(/^IMAGEKIT_PRIVATE_KEY\s*[:=]\s*/i, '').trim();
  }
  return k.replace(/\s+/g, '');
}

function keyProblem(k) {
  if (!k) return '';
  if (/^public_/i.test(k)) return 'اللي اتحط ده الـ Public Key — المطلوب الـ Private Key اللي جنبه في ImageKit.';
  if (/[*•●]/.test(k)) return 'المفتاح اتنسخ وهو متخبي بالنجوم — في ImageKit دوس على علامة العين جنب Private Key الأول، وبعدين انسخه كامل.';
  if (!/^private_/.test(k)) return 'قيمة IMAGEKIT_PRIVATE_KEY لازم تبدأ بـ private_ — انسخها من ImageKit ← Developer options ← Private Key.';
  if (!/^private_[A-Za-z0-9+/=_-]{8,}$/.test(k)) return 'فيه حروف غريبة في قيمة IMAGEKIT_PRIVATE_KEY — انسخ المفتاح تاني من ImageKit من غير أي زيادات.';
  return '';
}

// تجربة حقيقية للمفتاح: ImageKit بيرد 200 لو المفتاح صح، و401 أو 403 لو غلط.
let VERIFY = null;
async function verifyKey(k) {
  const h = crypto.createHash('sha256').update(k).digest('hex');
  if (VERIFY && VERIFY.h === h && VERIFY.until > Date.now()) return VERIFY.out;
  let out;
  try {
    const r = await fetch(IK_VERIFY_URL, {
      headers: { Authorization: 'Basic ' + Buffer.from(k + ':').toString('base64'), Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) out = { verified: true };
    else if (r.status === 401 || r.status === 403) out = { verified: false, status: r.status };
    else out = { verified: null, status: r.status };
    await r.arrayBuffer().catch(() => null);
  } catch (_) {
    out = { verified: null, status: 0 };
  }
  VERIFY = { h, out, until: Date.now() + (out.verified === true ? 10 * 60 * 1000 : 15 * 1000) };
  return out;
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
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      throw new HttpError(405, 'الطريقة دي مش مدعومة.');
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const key = readKey();
    const problem = keyProblem(key);
    if (url.searchParams.get('check') === '1') {
      const out = {
        service: 'imagekit-auth',
        configured: !!key && !problem,
        verified: null, // true = ImageKit قبل المفتاح · false = رفضه · null = متجرّبش
        missing: key ? [] : ['IMAGEKIT_PRIVATE_KEY'],
        invalid: problem ? [problem] : [],
        serverNow: Date.now(),
      };
      if (out.configured) {
        const v = await verifyKey(key);
        out.verified = v.verified;
        if (v.status) out.imagekitStatus = v.status;
        // المفتاح المرفوض مالوش قيمة، فبنوري أوله وطوله عشان تقارنه باللي في ImageKit
        if (v.verified === false) { out.keyStart = key.slice(0, 12); out.keyLength = key.length; }
      }
      return send(res, method, 200, out);
    }
    if (!key) throw new HttpError(500, 'رفع الصور مش متجهز: ناقص IMAGEKIT_PRIVATE_KEY في Environment Variables على Vercel. ضيفه واعمل Redeploy.', { missing: ['IMAGEKIT_PRIVATE_KEY'] });
    if (problem) throw new HttpError(500, problem);
    const auth = String((req.headers && req.headers.authorization) || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    await verifyIdToken(m ? m[1].trim() : '');
    const token = crypto.randomUUID();
    const expire = Math.floor(Date.now() / 1000) + SIGNATURE_TTL_SECONDS;
    const signature = crypto.createHmac('sha1', key).update(token + expire).digest('hex');
    return send(res, method, 200, { token, expire, signature });
  } catch (e) {
    const known = e instanceof HttpError;
    if (!known || e.status >= 500) console.error('[imagekit-auth]', known ? e.message : (e && e.stack) || e);
    return send(res, method, known ? e.status : 500, Object.assign(
      { error: known ? e.message : 'حصل خطأ في خدمة رفع الصور. جرّب تاني.' },
      known && e.extra ? e.extra : {},
    ));
  }
};
