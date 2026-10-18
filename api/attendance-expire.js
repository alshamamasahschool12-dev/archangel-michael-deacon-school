'use strict';
const crypto=require('node:crypto'),runtime=require('../server/runtime'),http=require('../server/http');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return http.response(res).status(405).json({error:'الطريقة غير مسموحة.'});
 const secret=process.env.CRON_SECRET||'',expected=Buffer.from('Bearer '+secret),actual=Buffer.from(String(req.headers?.authorization||''));
 if(secret.length<32||expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))return http.response(res).status(401).json({error:'غير مسموح.'});
 try{await runtime.getService().expireAttendanceAccess();return http.response(res).status(200).json({ok:true});}catch(e){return http.fail(res,e);}
};
