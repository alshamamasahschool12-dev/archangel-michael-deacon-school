'use strict';
// Shared business logic, independent of Firebase Functions or Vercel wrappers.
const crypto=require('node:crypto'),P=require('./policy');
const DEFAULT_DATES=require('./schedule-defaults.json');
module.exports=function createAttendanceService({admin}){
 const db=admin.database();
const ROOT='attendance-approval-v4-private',DURATION=20*60000,APPROVAL_TTL=5*60000;
const levels=['المستوى الأول','المستوى الثاني','المستوى الثالث','المستوى الرابع','المستوى الخامس','المستوى السادس','المستوى السابع','المستوى الثامن','المستوى التاسع'];
const read=async p=>(await db.ref(p).get()).val();
// On Vercel, runtime.js supplies the REST/ETag adapter in rtdb-rest.js.
// Its transactions already start from the exact server value, so do NOT pin
// a WebSocket listener first: a frozen/thawed serverless instance can leave
// that listener waiting forever. The listener fallback below is only for a
// real Admin SDK database, and every path is time-bounded.
function databaseTimeout(message){const e=Error(message);e.status=503;e.code='RTDB_TRANSACTION_TIMEOUT';return e;}
function withDatabaseTimeout(promise,ms,message){
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(databaseTimeout(message)),ms);})])
  .finally(()=>clearTimeout(timer));
}
async function transact(ref,update){
 if(ref.__attendanceRest){
  return withDatabaseTimeout(ref.transaction(update,undefined,false),20000,'انتهى وقت عملية الحفظ في قاعدة البيانات. حدّث الحالة وحاول تاني بنفس البيانات.');
 }
 let resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const listener=()=>resolveReady();
 try{
  ref.on('value',listener,rejectReady);
  await withDatabaseTimeout(ready,10000,'تعذر تجهيز اتصال قاعدة البيانات في الوقت المحدد.');
  return await withDatabaseTimeout(ref.transaction(update,undefined,false),20000,'انتهى وقت عملية الحفظ في قاعدة البيانات. حدّث الحالة وحاول تاني بنفس البيانات.');
 }finally{ref.off('value',listener);}
}
function approvalError(code,message,status=403){const e=Error(message);e.status=status;e.publicCode=code;throw e;}
function approvalStateError(v){
 if(!v)approvalError('REQUEST_NOT_FOUND','الطلب لم يعد موجودًا. اطلب موافقة جديدة.',404);
 if(v.status==='rejected')approvalError('REQUEST_REJECTED','الطلب اترفض بالفعل. اطلب موافقة جديدة لو محتاج.');
 if(v.status==='superseded')approvalError('REQUEST_REPLACED','ده طلب قديم اتبدّل بطلب جديد. حدّث قائمة الطلبات.');
 if(v.status==='revoked')approvalError('REQUEST_REVOKED','الطلب اتلغى. اطلب موافقة جديدة لو محتاج.');
 if(v.status==='expired'||v.status==='pending'&&approvalDeadline(v)<=Date.now()||['active','saving'].includes(v.status)&&v.accessUntil<=Date.now())approvalError('REQUEST_EXPIRED','انتهت صلاحية الطلب. اطلب موافقة جديدة.');
 if(['active','saving'].includes(v.status)||v.approvedAt)approvalError('ALREADY_APPROVED','الطلب اتوافق عليه بالفعل، والموافقة لا تبدأ ٢٠ دقيقة جديدة.',409);
 if(v.status!=='pending')approvalError('REQUEST_STATE_CHANGED','حالة الطلب اتغيرت. حدّث الطلب وحاول تاني.',409);
}

const school=x=>(Array.isArray(x.programs)&&x.programs.length?x.programs:[x.program||'shamamsa']).includes('shamamsa');
async function account(user){const all=await read('shamamsa-servants')||{},k=Object.keys(all).find(k=>k.toLowerCase()===user),a=k&&all[k];if(!a||a.disabled||['father','noaccess'].includes(a.role))P.fail('الحساب غير متاح.',403);return a;}
async function limit(key,max,span){const now=Date.now(),t=await transact(db.ref(ROOT+'/limits/'+P.digest(key)),v=>{if(!v||now-v.start>span)v={start:now,count:0};return {...v,count:v.count+1};});if(t.snapshot.val().count>max)P.fail('محاولات كتير. استنى شوية وحاول تاني.',429);}
function approvalDeadline(r){return Math.min(r.approvalUntil||Infinity,(r.createdAt||0)+APPROVAL_TTL);}
function view(r){
 const {uid,...out}=r;
 if(r.status==='pending')out.approvalUntil=approvalDeadline(r);
 return out;
}
async function approverDirectory(viewer){
 const map=await read('shamamsa-servants')||{},out=[];
 for(const[key,a]of Object.entries(map)){
  const username=key.toLowerCase();
  if(!P.safeKey(username)||username===viewer||a.disabled||['father','noaccess'].includes(a.role)||!P.canApprove(a,username))continue;
  out.push({username,name:a.name||key,isOwner:username===P.OWNER});
 }
 return out.sort((a,b)=>Number(b.isOwner)-Number(a.isOwner)||a.name.localeCompare(b.name,'ar'));
}
async function audit(id,event,r,action,details,extra={}){
 const key='la_'+id+'_'+event;let fresh=false;
 const entry={servant:r.name||r.username,username:r.username,action,details,at:Date.now(),deviceAt:Date.now(),source:'attendance-approval-v4',requestId:id,approverUsername:r.approverUsername||'',approverName:r.approverName||'',actorUsername:r.username,actorName:r.name||r.username,...extra};
 const tx=await transact(db.ref(ROOT+'/events/'+key),v=>{fresh=!v;return v||entry;});
 // Re-setting the same public key also repairs interrupted delivery to the existing activity log.
 const publicEntry={...tx.snapshot.val()};delete publicEntry._delivered;
 await db.ref('shamamsa-activity-log/'+key).set(publicEntry);
 await db.ref(ROOT+'/events/'+key).update({_delivered:true});
 if(fresh)await transact(db.ref('shamamsa-activity-log-count'),v=>(Number(v)||0)+1);
}
async function expireOne(id,r){
 if(!r)return r;
 const approved=!!r.approvedAt;
 if(r.status==='expired'){if((await read(ROOT+'/events/la_'+id+'_expired'))?._delivered)return r;await audit(id,'expired',r,approved?'انتهاء نافذة تعديل الحضور':'انتهاء مهلة الموافقة على فتح الحضور',approved?'أُغلقت نافذة الـ٢٠ دقيقة تلقائيًا.':'انتهت مهلة الموافقة على الطلب من غير قرار.',{effectiveAt:r.accessUntil||r.approvalUntil});return r;}
 if(!['active','saving','pending'].includes(r.status))return r;
 const expired=approved?r.accessUntil<=Date.now():approvalDeadline(r)<=Date.now();if(!expired)return r;
 const tx=await transact(db.ref(ROOT+'/requests/'+id),v=>{if(!v)return;if(['active','saving'].includes(v.status)&&v.accessUntil<=Date.now()||v.status==='pending'&&approvalDeadline(v)<=Date.now())return {...v,status:'expired',closedAt:Date.now(),pendingSave:null};return;});
 if(tx.committed){const out=tx.snapshot.val();await audit(id,'expired',out,approved?'انتهاء نافذة تعديل الحضور':'انتهاء مهلة الموافقة على فتح الحضور',approved?'أُغلقت نافذة الـ٢٠ دقيقة تلقائيًا، ولا تُقبل عمليات حفظ جديدة.':'انتهت مهلة الموافقة على الطلب من غير قرار.');return out;}return (await db.ref(ROOT+'/requests/'+id).get()).val();
}
const expireAttendanceAccess=async()=>{const all=await read(ROOT+'/requests')||{};for(const[id,r]of Object.entries(all))await expireOne(id,r);};
async function auditOwnerGrant(id,r,a){
 await audit(id,'owner_granted',r,'فتح مباشر لمدة ٢٠ دقيقة من مالك النظام','فتح '+(a.name||P.OWNER)+' (@'+P.OWNER+') تعديل الحضور مباشرةً من غير طلب أو انتظار موافق آخر، حتى '+new Date(r.accessUntil).toISOString()+'.',{actorUsername:P.OWNER,actorName:a.name||P.OWNER,approvedAt:r.approvedAt,accessUntil:r.accessUntil,ownerDirectGrant:true});
}
async function ownerDirectGrant(uid,a){
 const user=P.OWNER;
 await limit('owner-direct-grant:'+user,12,3600000);
 const all=await read(ROOT+'/requests')||{};
 const ownEntries=Object.entries(all)
  .filter(([,r])=>r&&r.username===user&&r.uid===uid&&['pending','active','saving'].includes(r.status))
  .sort((x,y)=>(y[1].createdAt||0)-(x[1].createdAt||0));
 let activeGrant=null;
 const pending=[];
 for(const[id,old]of ownEntries){
  const current=await expireOne(id,old);
  if(!current)continue;
  if(['active','saving'].includes(current.status)&&Number(current.accessUntil)>Date.now()){
   activeGrant=activeGrant||{id,request:current};
  }else if(current.status==='pending'&&approvalDeadline(current)>Date.now())pending.push([id,current]);
 }
 // Close any request Lucas may have sent to another approver before making
 // the owner-only grant. If an approval wins the race, use that active grant.
 for(const[id,r]of pending){
  const t=await transact(db.ref(ROOT+'/requests/'+id),v=>v&&v.status==='pending'&&approvalDeadline(v)>Date.now()
   ?{...v,status:'superseded',closedAt:Date.now(),closedBy:user,closedReason:'owner-direct-grant'}:undefined);
  if(t.committed){
   await audit(id,'superseded',r,'إلغاء طلب موافقة قبل الفتح المباشر','أُلغي الطلب المعلّق لأن مالك النظام فتح صلاحية تعديل الحضور مباشرةً لمدة ٢٠ دقيقة.',{replacedByOwnerDirectGrant:true,actorUsername:user,actorName:a.name||user});
  }else{
   const latest=t.snapshot.val();
   if(latest&&['active','saving'].includes(latest.status)&&Number(latest.accessUntil)>Date.now())activeGrant={id,request:latest};
   else if(latest&&latest.status==='pending'&&approvalDeadline(latest)>Date.now())P.fail('طلب الموافقة بيتغير الآن. اضغط مرة أخرى بعد لحظة.',409);
  }
 }
 if(activeGrant){if(activeGrant.request.ownerDirectGrant)await auditOwnerGrant(activeGrant.id,activeGrant.request,a);return {id:activeGrant.id,request:view(activeGrant.request),serverNow:Date.now()};}

 // A transactional per-owner slot prevents two simultaneous clicks from
 // creating overlapping 20-minute grants. The corresponding request record is
 // also written transactionally, so retries can safely finish an interrupted
 // grant without extending its deadline.
 const slotRef=db.ref(ROOT+'/owner-grants/'+user);
 const candidate=db.ref(ROOT+'/requests').push();
 const slotTx=await transact(slotRef,current=>{
  const now=Date.now();
  if(current&&current.status==='active'&&P.safeKey(current.requestId)&&Number(current.accessUntil)>now)return current;
  return {version:1,status:'active',username:user,requestId:candidate.key,createdAt:now,accessUntil:now+DURATION};
 });
 let slot=slotTx.snapshot.val();
 if(!slot||!P.safeKey(slot.requestId)||!Number.isFinite(Number(slot.accessUntil)))P.fail('تعذر تجهيز الفتح المباشر. حاول مرة أخرى.',503);
 let id=slot.requestId,requestRef=db.ref(ROOT+'/requests/'+id),existing=(await requestRef.get()).val();
 const isThisGrant=r=>!!(r&&r.ownerDirectGrant===true&&r.username===user&&r.uid===uid&&Number(r.accessUntil)===Number(slot.accessUntil)&&['active','saving'].includes(r.status)&&Number(r.accessUntil)>Date.now());
 if(existing&&!isThisGrant(existing)){
  // A revoked/inconsistent record must not be reused as a new grant. Rotate
  // the pointer with compare-and-swap; another concurrent grant takes priority.
  const replacement=db.ref(ROOT+'/requests').push(),now=Date.now();
  const rotate=await transact(slotRef,current=>{
   if(current&&current.requestId!==id&&current.status==='active'&&Number(current.accessUntil)>Date.now())return current;
   if(current&&current.requestId===id||!current||current.status!=='active'||Number(current.accessUntil)<=Date.now())return {version:1,status:'active',username:user,requestId:replacement.key,createdAt:now,accessUntil:now+DURATION};
   return current;
  });
  slot=rotate.snapshot.val();id=slot.requestId;requestRef=db.ref(ROOT+'/requests/'+id);existing=(await requestRef.get()).val();
  if(existing&&!isThisGrant(existing))P.fail('حالة الفتح المباشر اتغيرت. حدّث الصفحة وحاول مرة أخرى.',409);
 }
 const grantRecord={
  version:4,username:user,name:a.name||user,uid,
  requesterPhone:P.normalizePhone(a.phone),
  approverUsername:user,approverName:a.name||user,
  status:'active',createdAt:Number(slot.createdAt)||Date.now(),
  approvedAt:Number(slot.createdAt)||Date.now(),decidedAt:Number(slot.createdAt)||Date.now(),
  decidedBy:user,decidedByName:a.name||user,accessUntil:Number(slot.accessUntil),
  ownerDirectGrant:true,closedAt:null
 };
 const saved=await transact(requestRef,current=>{
  if(!current)return grantRecord;
  if(isThisGrant(current))return current;
  P.fail('حالة الفتح المباشر اتغيرت. حدّث الصفحة وحاول مرة أخرى.',409);
 });
 const r=saved.snapshot.val();
 if(!r||!['active','saving'].includes(r.status)||Number(r.accessUntil)<=Date.now())P.fail('انتهت مهلة الفتح أثناء تجهيزها. اضغط مرة أخرى لبدء ٢٠ دقيقة جديدة.',409);
 await auditOwnerGrant(id,r,a);
 return {id,request:view(r),serverNow:Date.now()};
}
async function datesFor(level){const[g,o]=await Promise.all([read('shamamsa-schedule-dates'),read('shamamsa-schedule-overrides/'+level)]);const dates=g||DEFAULT_DATES;return Array.from({length:Math.max(DEFAULT_DATES.length,Array.isArray(dates)?dates.length:Object.keys(dates).length)},(_,i)=>(o||{})[i+1]||dates[i]||'');}
async function syncProgress(all,b,node){
 const level=levels[b.levelIndex],lesson=node.lessonNumber||b.lessonNumber;
 for(const[id,p]of Object.entries(all)){
  if(!p||p.level!==level||((p.classCode||'').trim()||'عام')!==b.classCode||!school(p)||!Object.hasOwn(b.recordsPatch,p.name))continue;
  const year=String(p.year||'').trim().replace(/[.#$/\[\]]/g,'-'),lk='level_'+b.levelIndex+(year?'__'+year:'');
  await transact(db.ref('shamamsa/'+id+'/lessonsProgress/'+lk),v=>{const values=(Array.isArray(v)?v:[]).filter(x=>x!==lesson);if(b.recordsPatch[p.name]==='present')values.push(lesson);return Array.from(new Set(values)).filter(Number.isFinite).sort((a,b)=>a-b);});
  if(b.recordsPatch[p.name]!=='absent')await transact(db.ref('shamamsa/'+id+'/missedLessons'),v=>(Array.isArray(v)?v:[]).filter(x=>!(x.date===b.date&&x.levelIndex===b.levelIndex&&(x.classCode||'عام')===b.classCode)));
  if(b.recordsPatch[p.name]==='absent'&&String(node.lessonContent||'').trim())await transact(db.ref('shamamsa/'+id+'/missedLessons'),v=>{const a=Array.isArray(v)?v.slice():[],entry={date:b.date,level,levelIndex:b.levelIndex,classCode:b.classCode,lessonNumber:lesson,content:node.lessonContent},i=a.findIndex(x=>x.date===b.date&&x.levelIndex===b.levelIndex&&(x.classCode||'عام')===b.classCode);if(i>=0)a[i]=entry;else a.push(entry);return a;});
 }
}
const attendanceAccess=async(req,res)=>{
 res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
 try{
  if(req.method!=='POST'||!req.is('application/json'))P.fail('طلب غير صحيح.',400);
  if(Buffer.byteLength(JSON.stringify(req.body||{}))>90000)P.fail('الطلب كبير جدًا.',413);
  const identity=await admin.auth().verifyIdToken(String(req.headers.authorization||'').replace(/^Bearer /,'')).catch(()=>P.fail('سجّل دخولك أولًا.',401));
  const uid=identity.uid,b=req.body||{},action=b.action;await limit('ip:'+req.ip,160,60000);
  // The only sign-in proof is the servant's normal account password.
  // Privileges are always re-derived from the server account record.
  if(action==='accountLogin'){
   const user=String(b.username||'').trim().toLowerCase();if(!P.safeKey(user))P.fail('اسم الحساب غير صحيح.');
   await limit('account-login:'+uid,8,15*60000);await limit('account-login-user:'+user,24,15*60000);
   const a=await account(user);
   if(typeof b.password!=='string'||!b.password||b.password.length>500||!P.equal(b.password,a.password||''))P.fail('كلمة مرور الحساب غير صحيحة. استخدم كلمة المرور المسجلة للحساب.',403);
   const token=crypto.randomBytes(32).toString('hex'),expiresAt=Date.now()+8*3600000,approvalAccess=P.canApprove(a,user);
   await db.ref(ROOT+'/sessions/'+P.digest(token)).set({username:user,uid,expiresAt,approvalAccess,credentialVersion:P.digest(a.password)});
   return res.json({token,expiresAt,approvalAccess,serverNow:Date.now()});
  }
  if(!/^[a-f0-9]{64}$/.test(b.session||''))P.fail('أكد هويتك مرة واحدة للمتابعة.',401);
  const session=await read(ROOT+'/sessions/'+P.digest(b.session));if(!session||session.uid!==uid||session.expiresAt<=Date.now())P.fail('انتهت جلسة الاعتماد. أكّد هويتك مرة تانية.',401);
  const user=session.username,a=await account(user),owner=user===P.OWNER;
  if(session.credentialVersion!==P.digest(a.password))P.fail('بيانات الاعتماد اتغيرت.',401);
  const approving=P.canApprove(a,user)&&session.approvalAccess===true;
  if(action==='approvers'){
   if(!P.canRequest(a,user)&&!owner)P.fail('غير مسموح بعرض المسؤولين عن الموافقة.',403);
   return res.json({approvers:await approverDirectory(user),serverNow:Date.now()});
  }
  if(action==='saveToday'){
   if(!P.safeKey(b.operationId))P.fail('رقم العملية غير صحيح.');
   if(!owner&&!(Array.isArray(a.permissions)&&a.permissions.includes('attendance')))P.fail('معندكش صلاحية تسجيل الحضور.',403);
   if(b.date!==P.today())P.fail('التسجيل المباشر مسموح في يوم الخدمة فقط. استخدم طلب تسجيل متأخر.',403);
   if(!Number.isInteger(b.levelIndex)||b.levelIndex<0||b.levelIndex>8||!P.safeKey(b.classCode||'عام'))P.fail('المستوى أو الفصل غير صحيح.');
   if(!b.recordsPatch||typeof b.recordsPatch!=='object'||Array.isArray(b.recordsPatch)||Object.keys(b.recordsPatch).length>1000)P.fail('كشف غير صحيح.');
   if(typeof b.lessonContent!=='string'||b.lessonContent.length>10000||!(b.lessonNumber===null||Number.isInteger(b.lessonNumber)&&b.lessonNumber>0&&b.lessonNumber<=300))P.fail('بيانات الحصة غير صحيحة.');
   const level=levels[b.levelIndex],classCode=b.classCode||'عام',key=`${b.date}__${b.levelIndex}__${classCode}`;
   const all=await read('shamamsa')||{},names=new Set(Object.values(all).filter(x=>x&&x.level===level&&((x.classCode||'').trim()||'عام')===classCode).map(x=>x.name));
   for(const [name,status] of Object.entries(b.recordsPatch))if(!P.safeKey(name)||!names.has(name)||![null,'present','absent'].includes(status))P.fail('اسم أو حالة غير صحيحة.');
   const operationHash=P.digest(JSON.stringify({date:b.date,levelIndex:b.levelIndex,classCode,recordsPatch:b.recordsPatch,lessonContent:b.lessonContent,lessonNumber:b.lessonNumber,finalized:!!b.finalized}));let blocked=false;const tx=await transact(db.ref('shamamsa-attendance/'+key),v=>{blocked=false;if(v&&v.normalOperations&&v.normalOperations[b.operationId]){const op=v.normalOperations[b.operationId];if(op.hash===operationHash&&op.by===user)return v;return;}if(v&&v.finalized){blocked=true;return;}const node={...(v||{})},records={...(node.records||{})};for(const [n,status]of Object.entries(b.recordsPatch)){if(status===null)delete records[n];else records[n]=status;}return {...node,records,date:b.date,level,levelIndex:b.levelIndex,classCode,lessonNumber:b.lessonNumber||node.lessonNumber||null,lessonContent:b.lessonContent,finalized:!!b.finalized,updatedAt:Date.now(),updatedBy:user,normalOperations:{...(node.normalOperations||{}),[b.operationId]:{hash:operationHash,by:user,at:Date.now()}}};});
   if(!tx.committed)P.fail(blocked?'اليوم اتقفل بالفعل من جهاز آخر.':'تعذر الحفظ.',409);
   await syncProgress(all,{...b,classCode},tx.snapshot.val());
   await audit('today_'+b.operationId,'save',{username:user,name:a.name},'تسجيل حضور اليوم',b.date+' / '+level+' / فصل '+classCode,{serviceDate:b.date,recordCount:Object.keys(b.recordsPatch).length});
   return res.json({ok:true,serverNow:Date.now()});
  }
  if(['list','status'].includes(action)){
   const all=await read(ROOT+'/requests')||{},items=[];
   for(const[id,old]of Object.entries(all))if((approving&&old.approverUsername===user)||(old.username===user&&old.uid===uid)){const r=await expireOne(id,old);if(r)items.push({id,...view(r)});}
   items.sort((x,y)=>y.createdAt-x.createdAt);return res.json({requests:items.slice(0,100),serverNow:Date.now()});
  }
  if(action==='ownerGrant'){
   if(!owner||!approving)P.fail('الفتح المباشر متاح لمالك النظام فقط.',403);
   const result=await ownerDirectGrant(uid,a);
   return res.json(result);
  }
  if(action==='request'){
   if(!P.canRequest(a,user))P.fail('صلاحية طلب فتح الحضور غير مفعلة لحسابك.',403);
   await limit('request:'+user,10,3600000);
   const target=String(b.approverUsername||'').toLowerCase();if(!P.safeKey(target)||target===user)P.fail('اختار مسؤول موافقة مصرحًا غير حسابك.');
   const approver=(await approverDirectory(user)).find(x=>x.username===target);if(!approver)P.fail('المسؤول غير متاح أو صلاحية الموافقة اتسحبت منه.',403);
   const all=await read(ROOT+'/requests')||{};let same=null;
   const ownEntries=Object.entries(all).filter(([,r])=>r.username===user&&r.uid===uid&&['pending','active','saving'].includes(r.status)).sort((x,y)=>(y[1].createdAt||0)-(x[1].createdAt||0));
   for(const entry of ownEntries){const current=await expireOne(entry[0],entry[1]);if(current&&(['active','saving'].includes(current.status)&&current.accessUntil>Date.now()||current.status==='pending'&&approvalDeadline(current)>Date.now())){same=[entry[0],current];break;}}
   if(same&&['active','saving'].includes(same[1].status)){
    if(b.renew)P.fail('نافذة الحضور مفتوحة بالفعل؛ الموافقة لا تجدد مدة الـ٢٠ دقيقة.',409);
    return res.json({id:same[0],request:view(same[1]),serverNow:Date.now()});
   }
   if(same&&!b.renew&&same[1].approverUsername!==target)P.fail('عندك طلب موافقة مفتوح لمسؤول آخر. ألغه أو اختار تغيير المسؤول.',409);
   if(same&&(!b.renew||same[1].approverUsername===target))return res.json({id:same[0],request:view(same[1]),serverNow:Date.now()});
   if(same&&Date.now()-same[1].createdAt<30000)P.fail('انتظر ٣٠ ثانية قبل تحويل طلب الموافقة لمسؤول آخر.',429);
   if(same){const rr=db.ref(ROOT+'/requests/'+same[0]);const t=await transact(rr,v=>v&&v.status==='pending'?{...v,status:'superseded',closedAt:Date.now(),closedBy:user}:undefined);if(!t.committed)P.fail('حالة الطلب اتغيرت. حدّث الطلب.',409);await audit(same[0],'superseded',same[1],'استبدال طلب موافقة فتح الحضور','أُلغي طلب الموافقة القديم بناءً على تحويل الطلب إلى '+approver.name+' (@'+target+').',{replacedByApproverUsername:target,replacedByApproverName:approver.name});}
   const ref=db.ref(ROOT+'/requests').push(),now=Date.now();
   const r={version:4,username:user,name:a.name||user,uid,requesterPhone:P.normalizePhone(a.phone),approverUsername:target,approverName:approver.name,status:'pending',createdAt:now,approvalUntil:now+APPROVAL_TTL};await ref.set(r);
   await audit(ref.key,'requested',r,'طلب موافقة فتح تعديل الحضور','طلب '+(a.name||user)+' (@'+user+') من '+approver.name+' (@'+target+') الموافقة على فتح تعديل الحضور السابق لمدة ٢٠ دقيقة. الطلب صالح للموافقة حتى '+new Date(r.approvalUntil).toISOString()+'.',{requestedAt:now,approvalUntil:r.approvalUntil});
   return res.json({id:ref.key,request:view(r),serverNow:Date.now()});
  }
  if(!P.safeKey(b.id))P.fail('رقم الطلب غير صحيح.');
  const ref=db.ref(ROOT+'/requests/'+b.id);let r=(await ref.get()).val();if(!r)P.fail('الطلب غير موجود.',404);
  const isApprover=approving&&r.approverUsername===user,isRequester=r.username===user&&r.uid===uid;
  if(action==='notification'){
   if(!isApprover)P.fail('هذا الطلب خاص بمسؤول الموافقة المختار فقط.',403);
   await audit(b.id,'notified',r,'وصول إشعار طلب فتح الحضور','ظهر إشعار طلب '+(r.name||r.username)+' (@'+r.username+') في سيستم مسؤول الموافقة المختار '+(a.name||user)+(b.soundPlayed?' مع التنبيه الصوتي.':'.'),{actorUsername:user,actorName:a.name||user,soundPlayed:!!b.soundPlayed});
   return res.json({ok:true,serverNow:Date.now()});
  }
  if(action==='approve'||action==='reject'){
   if(!isApprover)P.fail('هذا الطلب خاص بمسؤول الموافقة المختار فقط.',403);
   if(r.username===user)P.fail('لا يمكن للخادم الموافقة على طلب نفسه.',403);
   const requester=await account(r.username);if(!P.canRequest(requester,r.username))P.fail('صلاحية طلب فتح الحضور اتسحبت من حساب مقدم الطلب.',403);
   let outcome='';
   const t=await transact(ref,v=>{
    outcome='';
    if(!v)return;
    if(action==='approve'&&['active','saving'].includes(v.status)&&v.accessUntil>Date.now()){outcome='already';return v;}
    if(action==='reject'&&v.status==='rejected'){outcome='already';return v;}
    if(v.status!=='pending'||approvalDeadline(v)<=Date.now())return;
    const now=Date.now();
    outcome=action==='approve'?'approved':'rejected';
    return action==='approve'
     ?{...v,status:'active',approvedAt:now,decidedAt:now,decidedBy:user,decidedByName:a.name||user,accessUntil:now+DURATION,closedAt:null}
     :{...v,status:'rejected',rejectedAt:now,decidedAt:now,decidedBy:user,decidedByName:a.name||user,closedAt:now,closedBy:user};
   });
   if(!t.committed||!outcome){approvalStateError(t.snapshot.val());approvalError('APPROVAL_RETRY','تعذر تأكيد القرار بسبب تعارض مؤقت. حدّث الحالة وحاول تاني.',409);}
   r=t.snapshot.val();
   if(outcome==='approved')await audit(b.id,'approved',r,'الموافقة على فتح تعديل الحضور','وافق '+(a.name||user)+' (@'+user+') على طلب '+(r.name||r.username)+' (@'+r.username+')، وفُتح تعديل الأيام السابقة لمدة ٢٠ دقيقة حتى '+new Date(r.accessUntil).toISOString()+'. الحفظ أو تغيير اليوم لا يمدد الوقت.',{actorUsername:user,actorName:a.name||user,approvedAt:r.approvedAt,accessUntil:r.accessUntil});
   if(outcome==='rejected')await audit(b.id,'rejected',r,'رفض طلب فتح تعديل الحضور','رفض '+(a.name||user)+' (@'+user+') طلب '+(r.name||r.username)+' (@'+r.username+') لفتح تعديل الحضور السابق. لم تُفتح أي نافذة تعديل.',{actorUsername:user,actorName:a.name||user,rejectedAt:r.rejectedAt});
   return res.json({request:view(r),serverNow:Date.now()});
  }
  if(action==='revoke'){
   if(!owner&&!isApprover&&!isRequester)P.fail('غير مسموح.',403);
   const wasPending=r.status==='pending';
   const t=await transact(ref,v=>v&&['pending','active'].includes(v.status)?{...v,status:'revoked',closedAt:Date.now(),closedBy:user}:undefined);
   if(!t.committed)P.fail('الطلب مغلق أو الحفظ جاري؛ حدّث الحالة.',409);
   if(r.ownerDirectGrant)await transact(db.ref(ROOT+'/owner-grants/'+P.OWNER),v=>v&&v.requestId===b.id?{...v,status:'revoked',revokedAt:Date.now()}:undefined);
   const actorName=a.name||user,title=isRequester?(wasPending?'إلغاء طلب موافقة فتح الحضور':'إغلاق نافذة تعديل الحضور'):'إلغاء طلب/إذن الحضور بواسطة الإدارة';
   await audit(b.id,'revoked',r,title,'أُغلق الطلب بواسطة '+actorName+' (@'+user+'). مقدم الطلب: '+(r.name||r.username)+' (@'+r.username+')، ومسؤول الموافقة: '+(r.approverName||r.approverUsername)+' (@'+r.approverUsername+').',{actorUsername:user,actorName});return res.json({ok:true,serverNow:Date.now()});
  }
  if(!isRequester)P.fail('الطلب خاص بالحساب والجهاز اللي طلبه.',403);
  if(!P.canRequest(a,user))P.fail('صلاحية فتح الحضور اتسحبت من حسابك.',403);
  if(action==='save'){
   if(!P.safeKey(b.operationId))P.fail('رقم عملية الحفظ غير صحيح.');
   const late=b.date<P.today();if(!late)P.fail('المسار ده مخصص للأيام السابقة.');
   return await saveAttendance(b,r,user,uid,a,res,true);
  }
  P.fail('عملية غير معروفة.');
 }catch(e){console.error('attendance-access',e.status||500,e.status?e.message:'server error');res.status(e.status||500).json({error:e.status?e.message:'تعذر تنفيذ العملية. أعد المحاولة بنفس البيانات.',...(e.publicCode?{code:e.publicCode}:{})});}
};
async function saveAttendance(b,r,user,uid,a,res,late){
 const scope=P.scope(b),ref=db.ref(ROOT+'/requests/'+b.id),dates=await datesFor(b.levelIndex),lesson=dates.indexOf(b.date)+1;if(!lesson)P.fail('التاريخ مش يوم خدمة مسجل لهذا المستوى.');
 if(!b.recordsPatch||Array.isArray(b.recordsPatch)||typeof b.recordsPatch!=='object'||!b.expected||typeof b.expected!=='object'||Object.keys(b.recordsPatch).length>1000)P.fail('كشف غير صحيح.');
 if(typeof b.lessonContent!=='string'||b.lessonContent.length>10000)P.fail('محتوى الدرس غير صحيح.');
 const all=await read('shamamsa')||{},names=new Set(Object.values(all).filter(x=>x&&x.level===levels[b.levelIndex]&&((x.classCode||'').trim()||'عام')===scope.classCode&&school(x)).map(x=>x.name));
 for(const[name,status]of Object.entries(b.recordsPatch))if(!P.safeKey(name)||!names.has(name)||![null,'present','absent'].includes(status))P.fail('اسم أو حالة غير صحيحة.');
 const payload={date:b.date,levelIndex:b.levelIndex,classCode:scope.classCode,recordsPatch:b.recordsPatch,expected:b.expected,lessonContent:b.lessonContent},hash=P.digest(JSON.stringify(payload));let issue='';
 const lock=await transact(ref,v=>{issue='';if(v&&v.results&&v.results[b.operationId]){if(v.results[b.operationId].hash!==hash){issue='لا يمكن تغيير بيانات عملية محفوظة.';return;}return v;}
  if(v&&['saving','expired'].includes(v.status)&&v.pendingSave&&v.pendingSave.operationId===b.operationId&&v.pendingSave.hash===hash)return v;
  try{P.allowed(v,user,uid);}catch(e){issue=e.message;return;}
  return {...v,status:'saving',pendingSave:{...payload,operationId:b.operationId,hash}};});
 if(!lock.committed)P.fail(issue||'الحفظ جاري في عملية أخرى.',409);r=lock.snapshot.val();
 if(r.results&&r.results[b.operationId])return res.json({ok:true,count:r.results[b.operationId].count,serverNow:Date.now(),accessUntil:r.accessUntil});
 let conflict='';const now=Date.now();
 const t=await transact(db.ref('shamamsa-attendance/'+scope.key),old=>{conflict='';if(old&&old.lateOperations&&old.lateOperations[b.operationId])return old;
  if(Date.now()>=r.accessUntil){conflict='انتهت مدة الـ٢٠ دقيقة؛ لم يتم حفظ تغييرات جديدة.';return;}
  const n=structuredClone(old||{});n.records=n.records||{};const changes={};
  for(const[name,value]of Object.entries(b.recordsPatch)){const before=n.records[name]??null;if(before!==(b.expected[name]??null)){conflict='الحضور اتغير من جهاز تاني. حدّث الكشف قبل التعديل.';return;}changes[name]={before,after:value};if(value===null)delete n.records[name];else n.records[name]=value;}
  const event={requestId:b.id,operationId:b.operationId,recordedBy:user,recordedAt:now,serviceDate:b.date,changes,contentBefore:n.lessonContent||'',contentAfter:b.lessonContent};
  return {...n,date:b.date,level:levels[b.levelIndex],levelIndex:b.levelIndex,classCode:scope.classCode,lessonNumber:n.lessonNumber||lesson,lessonContent:b.lessonContent,updatedAt:now,lateOperations:{...(n.lateOperations||{}),[b.operationId]:event}};
 });
 if(!t.committed){await transact(ref,v=>v&&v.status==='saving'&&v.pendingSave.operationId===b.operationId?{...v,status:Date.now()<v.accessUntil?'active':'expired',pendingSave:null}:undefined);if(Date.now()>=r.accessUntil)await audit(b.id,'expired',r,'انتهاء نافذة تعديل الحضور','انتهت الـ٢٠ دقيقة ورُفض أي حفظ جديد.');P.fail(conflict||'تعذر الحفظ.',409);}
 const node=t.snapshot.val();await syncProgress(all,{...b,classCode:scope.classCode,lessonNumber:lesson},node);
 const count=Object.keys(b.recordsPatch).length,event=node.lateOperations[b.operationId];
 await audit(b.id,'save_'+b.operationId,r,'تعديل حضور يوم سابق',levels[b.levelIndex]+' / فصل '+scope.classCode+' / يوم '+b.date+' / '+count+' تغيير، بوقت التنفيذ الحقيقي.',{serviceDate:b.date,changes:event.changes,executedAt:event.recordedAt,operationId:b.operationId,contentBefore:event.contentBefore,contentAfter:event.contentAfter});
 const finish=await transact(ref,v=>{if(!v)return;return {...v,status:Date.now()<v.accessUntil?'active':'expired',pendingSave:null,results:{...(v.results||{}),[b.operationId]:{hash,count,savedAt:Date.now(),date:b.date}}};});
 if(finish.snapshot.val().status==='expired')await audit(b.id,'expired',r,'انتهاء نافذة تعديل الحضور','أُغلقت نافذة الـ٢٠ دقيقة تلقائيًا.');
 return res.json({ok:true,count,accessUntil:r.accessUntil,serverNow:Date.now(),node});
}

return {attendanceAccess,expireAttendanceAccess};
};
