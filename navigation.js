/* ═══════════════════════════════════════════════════════════════
   navigation.js — إصلاحات بسيطة وآمنة بدون كسر الصفحات
   · إصلاح وميض زر التثبيت
   · تحسينات أداء بسيطة
   · لا touch لمحتوى الصفحة أو إعادة تشغيل سكربتات
   ═══════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  if (window.__cxNavFixed) return;
  window.__cxNavFixed = true;

  /* ───── 1) إصلاح زر التثبيت: نخفيه فورًا في الـ head قبل ما يرسم ───── */
  function isStandalone() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches ||
             window.matchMedia('(display-mode: fullscreen)').matches ||
             window.navigator.standalone === true ||
             (document.referrer && document.referrer.indexOf('android-app://') === 0);
    } catch(e){ return false; }
  }

  function fixInstallButton() {
    var btn = document.getElementById('pwa-inst-btn');
    if (!btn) return false;

    /* لو متثبت: نخفي نهائيًا */
    if (isStandalone()) {
      btn.style.display = 'none';
      return true;
    }

    /* نخفي الزر أوّلاً بشكل ناعم */
    btn.style.opacity = '0';
    btn.style.transform = 'translateY(-2px) scale(0.9)';
    btn.style.transition = 'opacity .4s ease, transform .4s cubic-bezier(.2,.9,.3,1.2)';

    /* نتابع حدث beforeinstallprompt */
    var hasPrompt = false;
    function showBtn() {
      hasPrompt = true;
      btn.style.display = 'inline-flex';
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){
          btn.style.opacity = '1';
          btn.style.transform = 'translateY(0) scale(1)';
          btn.classList.remove('is-helper');
        });
      });
    }
    function showHelper() {
      if (hasPrompt) return;
      if (isStandalone()) { btn.style.display = 'none'; return; }
      btn.style.display = 'inline-flex';
      btn.classList.add('is-helper');
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){
          btn.style.opacity = '1';
          btn.style.transform = 'translateY(0) scale(1)';
        });
      });
    }

    window.addEventListener('beforeinstallprompt', function(e){
      e.preventDefault();
      window.__pwaDeferred = e;
      showBtn();
    });
    window.addEventListener('appinstalled', function(){ btn.style.display = 'none'; });

    /* بعد ١.٥ ثانية لو مفيش beforeinstallprompt (يعني iOS) نُظهر زر المساعدة */
    setTimeout(showHelper, 1600);

    /* مراقبة تغيير وضع standalone */
    if (window.matchMedia) {
      try {
        var mq = window.matchMedia('(display-mode: standalone)');
        if (mq.addEventListener) mq.addEventListener('change', function(e){
          if (e.matches) btn.style.display = 'none';
        });
      } catch(e){}
    }
    return true;
  }

  /* نحاول مبكرًا جدًا */
  if (document.body) fixInstallButton();
  else document.addEventListener('DOMContentLoaded', fixInstallButton);

  /* محاولة مبكرة إضافية في حالة تأخر الـ DOM */
  var tryCount = 0;
  function tryFix(){
    tryCount++;
    if (!fixInstallButton() && tryCount < 20) setTimeout(tryFix, 100);
  }
  setTimeout(tryFix, 0);

  /* ───── 2) تحسين بسيط للانتقال بين الصفحات (مجرد شريط progress) ───── */
  var bar, fill;
  function ensureBar(){
    if (bar) return;
    bar = document.createElement('div');
    bar.style.cssText='position:fixed;top:0;left:0;right:0;height:3px;z-index:99999;pointer-events:none;opacity:0;transition:opacity .2s';
    fill = document.createElement('div');
    fill.style.cssText='height:100%;width:0;background:linear-gradient(90deg,#c3922b,#c93a86,#e9c877);box-shadow:0 0 8px rgba(201,58,134,.4);transition:width .25s cubic-bezier(.4,0,.2,1)';
    bar.appendChild(fill);
    document.documentElement.appendChild(bar);
  }
  /* شريط progress عند الضغط على رابط داخلي يودّي لصفحة تانية */
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || !a.href) return;
    try {
      var url = new URL(a.href, location.href);
      if (url.origin === location.origin && url.pathname.endsWith('.html') && url.pathname !== location.pathname.split('/').pop() && !a.target) {
        ensureBar();
        bar.style.opacity = '1';
        fill.style.width = '60%';
      }
    } catch(e){}
  }, true);

  window.addEventListener('pageshow', function(){
    if (bar) { bar.style.opacity = '0'; fill.style.width = '0'; }
  });

  /* ───── 3) تسريع بسيط: prefetch للروابط عند التحويم (مجرد link rel=prefetch، مفيش كاش أو تخزين) ───── */
  var done = {};
  function prefetchOne(href){
    if (done[href]) return;
    done[href] = true;
    try {
      var l = document.createElement('link');
      l.rel = 'prefetch';
      l.href = href;
      l.as = 'document';
      document.head.appendChild(l);
    } catch(e){}
  }
  document.addEventListener('mouseover', function(e){
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    try {
      var url = new URL(a.href, location.href);
      if (url.origin === location.origin && url.pathname.endsWith('.html')) {
        prefetchOne(a.href);
      }
    } catch(e){}
  }, { passive: true });
})();
