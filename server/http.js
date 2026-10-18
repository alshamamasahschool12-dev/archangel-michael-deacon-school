'use strict';
function response(res){return {set:(name,value)=>res.setHeader(name,value),status(code){res.statusCode=code;return this;},json(value){res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));return res;}};}
function request(req){
 let body=req.body;
 if(Buffer.isBuffer(body))body=body.toString('utf8');
 if(typeof body==='string'){if(Buffer.byteLength(body)>90000){const e=Error('الطلب كبير جدًا.');e.status=413;throw e;}try{body=JSON.parse(body);}catch(_){const e=Error('صيغة JSON غير صحيحة.');e.status=400;throw e;}}
 const headers=Object.fromEntries(Object.entries(req.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));
 return {method:req.method,headers,body:body||{},is:type=>String(headers['content-type']||'').split(';')[0].trim().toLowerCase()===type,ip:String(headers['x-vercel-forwarded-for']||headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim()};
}
function fail(res,e){res.setHeader('Cache-Control','no-store');return response(res).status(e.status||500).json({error:e.status?e.message:'تعذر تشغيل خدمة موافقات الحضور. راجع Function Logs في Vercel.',code:e.code||'API_ERROR',...(e.details||{})});}
module.exports={request,response,fail};
