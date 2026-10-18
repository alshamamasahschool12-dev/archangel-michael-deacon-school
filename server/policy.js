'use strict';
const crypto = require('node:crypto');
const OWNER = 'lucaskayser';
const fail = (message, status=400) => { const e=new Error(message); e.status=status; throw e; };
function today(now=Date.now()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
function safeKey(v){return typeof v==='string'&&v.length>0&&v.length<=140&&!/[.#$\[\]/\u0000-\u001f]/.test(v)&&!['__proto__','prototype','constructor'].includes(v);}
function scope(body,now=Date.now()){
 const {date,levelIndex}=body, classCode=body.classCode||'عام';
 const parsed=new Date(date+'T12:00:00Z');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)fail('التاريخ غير صحيح.');
 if(date>=today(now))fail('اختر يوم خدمة سابق، مش النهارده أو يوم في المستقبل.');
 if(!Number.isInteger(levelIndex)||levelIndex<0||levelIndex>8||!safeKey(classCode))fail('المستوى أو الفصل غير صحيح.');
 return {date,levelIndex,classCode,key:`${date}__${levelIndex}__${classCode}`};
}
function canRequest(account,username){return username===OWNER||(!account.disabled&&!['father','noaccess'].includes(account.role)&&Array.isArray(account.permissions)&&account.permissions.includes('attendance')&&account.permissions.includes('lateAttendanceRequest'));}
function canApprove(a,user){return user===OWNER||(!a.disabled&&!['father','noaccess'].includes(a.role)&&Array.isArray(a.permissions)&&(a.permissions.includes('attendanceApprover')||a.permissions.includes('attendanceCodeReceiver')));}
function normalizePhone(value){
 let n=String(value||'').replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[\s()\-]/g,'');
 if(!n)return null;if(n.startsWith('00'))n='+'+n.slice(2);
 if(/^01[0125]\d{8}$/.test(n))return '20'+n.slice(1);
 if(/^1[0125]\d{8}$/.test(n))return '20'+n;
 if(/^20[1][0125]\d{8}$/.test(n))return n;
 if(/^\+[1-9]\d{7,14}$/.test(n))return n.slice(1);
 return null;
}
function allowed(r,user,uid,now=Date.now()){
 if(!r||r.username!==user||r.uid!==uid)fail('الطلب ده مرتبط بحساب أو جهاز آخر.',403);
 if(r.status!=='active'||r.accessUntil<=now)fail('انتهت أو أُغلقت نافذة التسجيل. اطلب موافقة جديدة.',403);
}
const digest=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
module.exports={OWNER,fail,today,safeKey,scope,canRequest,canApprove,normalizePhone,allowed,digest,equal};
