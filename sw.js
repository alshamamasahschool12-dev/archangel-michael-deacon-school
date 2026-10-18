/* Static assets only. Never cache an API response or replace it with offline HTML. */
const CACHE='shamamsa-vercel-attendance-v4-activation';
const SHELL=['./','./index.html','./navigation.js','./manifest.webmanifest'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(async cache=>{await Promise.all(SHELL.map(url=>cache.add(url).catch(()=>{})));}).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('shamamsa-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==location.origin||/^\/api(?:\/|$)/.test(url.pathname))return;
 if(req.mode==='navigate'||(req.headers.get('accept')||'').includes('text/html')){
  event.respondWith(fetch(req).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(cache=>cache.put(req,copy)).catch(()=>{});}return res;}).catch(async()=>await caches.match(req)||await caches.match('./offline.html')||Response.error()));return;
 }
 event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(cache=>cache.put(req,copy)).catch(()=>{});}return res;})));
});
