'use strict';
const DEFAULT_DATABASE_URL='https://alshamamasahschool-default-rtdb.europe-west1.firebasedatabase.app';
const EXPECTED_PROJECT='alshamamasahschool';
function configuration(env=process.env){
 const missing=[],invalid=[];let account=null;
 const json=env.FIREBASE_SERVICE_ACCOUNT||env.FIREBASE_SERVICE_ACCOUNT_JSON;
 if(json){try{account=JSON.parse(json);}catch(_){invalid.push('FIREBASE_SERVICE_ACCOUNT: يجب لصق محتوى ملف JSON كاملًا، وليس اسم الملف أو مساره.');}}
 else if(env.FIREBASE_PROJECT_ID&&env.FIREBASE_CLIENT_EMAIL&&env.FIREBASE_PRIVATE_KEY){account={project_id:env.FIREBASE_PROJECT_ID,client_email:env.FIREBASE_CLIENT_EMAIL,private_key:env.FIREBASE_PRIVATE_KEY};}
 else missing.push('FIREBASE_SERVICE_ACCOUNT');
 if(account){
  if(!account.project_id||!account.client_email||!account.private_key)invalid.push('FIREBASE_SERVICE_ACCOUNT: حقول حساب الخدمة ناقصة.');
  else if(account.project_id!==EXPECTED_PROJECT)invalid.push('FIREBASE_SERVICE_ACCOUNT: حساب الخدمة ليس لمشروع المدرسة الحالي.');
  else {account.private_key=account.private_key.replace(/\\n/g,'\n');try{require('node:crypto').createPrivateKey(account.private_key);}catch(_){invalid.push('FIREBASE_SERVICE_ACCOUNT: المفتاح الخاص غير صالح.');}}
 }
 const databaseURL=env.FIREBASE_DATABASE_URL||DEFAULT_DATABASE_URL;
 try{const u=new URL(databaseURL);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.hostname!==new URL(DEFAULT_DATABASE_URL).hostname)throw Error();}catch(_){invalid.push('FIREBASE_DATABASE_URL: رابط قاعدة المدرسة غير صحيح.');}
 return {configured:!missing.length&&!invalid.length,missing,invalid,account,databaseURL,cronConfigured:typeof env.CRON_SECRET==='string'&&env.CRON_SECRET.length>=32};
}
function publicStatus(env=process.env){const c=configuration(env);return {service:'attendance-access',platform:'vercel',version:'vercel-approval-5m-20m-v5-rest-etag',configured:c.configured,missing:c.missing,invalid:c.invalid,cronConfigured:c.cronConfigured,setupUrl:'/تفعيل-خدمة-موافقات-الحضور.html',note:'هذا فحص وجود وصيغة الإعدادات فقط؛ صلاحية الاتصال الفعلي تُختبر من داخل حسابك.'};}
let service,cachedAccessToken=null,accessTokenPromise=null;
async function googleAccessToken(credential){
 if(cachedAccessToken&&cachedAccessToken.refreshAt>Date.now())return cachedAccessToken.token;
 if(!accessTokenPromise){
  accessTokenPromise=(async()=>{
   try{
    const result=await credential.getAccessToken(),token=result&&result.access_token;
    if(!token)throw Error('missing access_token');
    const expiresIn=Number(result.expires_in)||3600;
    cachedAccessToken={token,refreshAt:Date.now()+Math.max(60,expiresIn-300)*1000};
    return token;
   }catch(error){
    console.error('firebase access token failed',error&&(error.code||error.message)||error);
    const e=Error('تعذر تجهيز اعتماد Firebase لقاعدة البيانات. راجع حساب الخدمة في Vercel ثم حاول تاني.');
    e.code='FIREBASE_ACCESS_TOKEN_FAILED';e.status=503;throw e;
   }
  })().finally(()=>{accessTokenPromise=null;});
 }
 return accessTokenPromise;
}
function getService(){
 if(service)return service;const c=configuration();
 if(!c.configured){const e=Error('إعداد خدمة موافقات الحضور على Vercel غير مكتمل. افتح صفحة تفعيل الخدمة؛ لا تغيّر كلمة مرور حسابك.');e.code='SERVER_NOT_CONFIGURED';e.status=503;e.details={missing:c.missing,invalid:c.invalid};throw e;}
 try{
  const {getApps,initializeApp,cert}=require('firebase-admin/app');
  const {getAuth}=require('firebase-admin/auth');
  const {createRestDatabase}=require('./rtdb-rest');
  const credential=cert(c.account);
  const app=getApps().find(app=>app.name==='attendance-school')||initializeApp({credential,databaseURL:c.databaseURL},'attendance-school');
  // Keep Admin Auth for ID-token verification, but use short-lived RTDB
  // REST requests for data. This avoids the Admin SDK's long-lived RTDB
  // WebSocket being frozen between Vercel invocations and then stalling
  // the next request's listener/transaction.
  const database=createRestDatabase({databaseURL:c.databaseURL,getAccessToken:()=>googleAccessToken(credential),timeoutMs:10000,transactionTimeoutMs:15000});
  const admin={database:()=>database,auth:()=>getAuth(app)};
  service=require('./attendance-core')({admin});return service;
 }catch(error){console.error('firebase init failed',error&&(error.code||error.message)||error);const e=Error('تعذر تهيئة Firebase Admin. راجع إعداد حساب الخدمة في Vercel ثم اعمل Redeploy.');e.code='FIREBASE_INIT_FAILED';e.status=503;throw e;}
}
module.exports={configuration,publicStatus,getService};
