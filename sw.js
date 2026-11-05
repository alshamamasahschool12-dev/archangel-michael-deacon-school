/* Firebase Messaging uses the site's existing service worker for background push. */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey: 'AIzaSyBGQL2NhNW37LR6rkMe_RhuV5vlWVV4yGw',
  authDomain: 'alshamamasahschool.firebaseapp.com',
  databaseURL: 'https://alshamamasahschool-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'alshamamasahschool',
  storageBucket: 'alshamamasahschool.firebasestorage.app',
  messagingSenderId: '708082510989',
  appId: '1:708082510989:web:b1064a9664fcf66b0c86c4'
});
const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const notification = payload.notification || {};
  const title = notification.title || 'إشعار جديد';
  self.registration.showNotification(title, {
    body: notification.body || '',
    icon: notification.icon || '/icon-192.png',
    badge: notification.badge || '/icon-192.png',
    tag: (payload.data && payload.data.requestId) ? `attendance-request-${payload.data.requestId}` : 'shamamsa-notification',
    data: payload.data || {}
  });
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/shamamsa-admin.html';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if ('focus' in client) { client.navigate(target); return client.focus(); }
    }
    return clients.openWindow(target);
  }));
});

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
