/*
 * EditHere Android 注入桥。页面零修改，本脚本在 onPageFinished 后注入：
 *  1) 记录 createObjectURL 产生的 blob（页面 CSP connect-src 'none'，不能 fetch blob:）
 *  2) 拦截 <a download> 点击，FileReader 转 base64 分块回传 Java 存下载目录
 *  3) navigator.clipboard.writeText -> AndroidBridge.copyText
 *  4) 双指手势翻译：捏合 -> ctrl+wheel 缩放；双指拖动 -> 合成中键 pointer 事件平移
 */
(function () {
  'use strict';
  if (window.__edithereAndroid) return;
  window.__edithereAndroid = true;

  var hasBridge = typeof AndroidBridge !== 'undefined';
  function log(m) { try { if (hasBridge) AndroidBridge.log(String(m)); } catch (e) {} }

  /* ---------- 1. blob 登记表 ---------- */
  var blobs = {};
  var origCreate = URL.createObjectURL.bind(URL);
  var origRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (b) {
    var u = origCreate(b);
    try { blobs[u] = b; } catch (e) {}
    return u;
  };
  URL.revokeObjectURL = function (u) {
    try { delete blobs[u]; } catch (e) {}
    return origRevoke(u);
  };

  /* ---------- 2. 下载拦截 ---------- */
  function sendBlob(name, blob) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var s = String(reader.result);
        var b64 = s.slice(s.indexOf(',') + 1);
        AndroidBridge.beginFile();
        var CH = 2000000;
        for (var i = 0; i < b64.length; i += CH) {
          AndroidBridge.appendFile(b64.slice(i, i + CH));
        }
        AndroidBridge.endFile(name, blob.type || 'application/octet-stream');
      } catch (e) { log('save error: ' + e); }
    };
    reader.onerror = function () { log('FileReader error'); };
    reader.readAsDataURL(blob);
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[download]') : null;
    if (!a || !a.href || a.href.indexOf('blob:') !== 0) return;
    var blob = blobs[a.href];
    if (!blob || !hasBridge) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    sendBlob(a.download || 'edithere-export', blob);
  }, true);

  /* ---------- 3. 剪贴板 ---------- */
  function copyText(text) {
    try {
      if (hasBridge) { AndroidBridge.copyText(String(text)); return Promise.resolve(); }
    } catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('no bridge'));
  }
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText = copyText;
    } else {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: copyText } });
    }
  } catch (e) { log('clipboard patch: ' + e); }

  /* ---------- 4. 触控手势翻译 ---------- */
  // 合成 pointerId 没有真实活跃指针，setPointerCapture 会抛 NotFoundError，容错包装。
  ['setPointerCapture', 'releasePointerCapture'].forEach(function (m) {
    var orig = Element.prototype[m];
    Element.prototype[m] = function (id) {
      try { return orig.call(this, id); } catch (e) {}
    };
  });
  var origHas = Element.prototype.hasPointerCapture;
  Element.prototype.hasPointerCapture = function (id) {
    try { return origHas.call(this, id); } catch (e) { return false; }
  };

  var viewport = document.getElementById('viewport');
  var stage = document.getElementById('stage');
  if (!viewport) { log('no #viewport, gesture layer skipped'); return; }

  var SYN = 999999;               // 合成平移指针 id
  var blocking = false;           // 手势期间屏蔽真实 touch pointer 事件
  var gesture = null;             // {mid:{x,y}, dist:number}
  var touchPointers = {};         // 真实 touch pointerId -> target

  function mid(ts) {
    return { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 };
  }
  function dist(ts) {
    return Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  }
  function inViewport(t) {
    var el = document.elementFromPoint(t.clientX, t.clientY);
    return !!(el && el.closest && el.closest('#viewport'));
  }
  function pe(type, target, opts) {
    var init = {
      bubbles: true, cancelable: true, composed: true,
      pointerId: SYN, pointerType: 'mouse', isPrimary: true,
      button: type === 'pointermove' ? -1 : 1, buttons: type === 'pointerup' ? 0 : 4,
      clientX: opts.x, clientY: opts.y
    };
    target.dispatchEvent(new PointerEvent(type, init));
  }

  // 记录真实 touch 指针（先于 blocker 注册，保证被屏蔽前已登记）
  window.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch' && e.isTrusted) touchPointers[e.pointerId] = e.target;
  }, true);
  window.addEventListener('pointerup', function (e) { delete touchPointers[e.pointerId]; }, true);
  window.addEventListener('pointercancel', function (e) { delete touchPointers[e.pointerId]; }, true);

  // 手势期间屏蔽真实 touch pointer 事件，避免第二根手指触发画框/拖动
  function blocker(e) {
    if (blocking && e.isTrusted && e.pointerType === 'touch') {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (t) {
    window.addEventListener(t, blocker, true);
  });

  function cancelActivePointers() {
    Object.keys(touchPointers).forEach(function (id) {
      var target = touchPointers[id] || stage || viewport;
      try {
        target.dispatchEvent(new PointerEvent('pointercancel', {
          bubbles: true, cancelable: true, pointerId: Number(id), pointerType: 'touch'
        }));
      } catch (e) {}
    });
  }

  window.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2 && inViewport(e.touches[0]) && inViewport(e.touches[1])) {
      blocking = true;
      cancelActivePointers();
      var m = mid(e.touches);
      gesture = { mid: m, dist: dist(e.touches) };
      pe('pointerdown', viewport, m); // 中键 -> startPan
    }
  }, { capture: true, passive: true });

  window.addEventListener('touchmove', function (e) {
    if (!gesture || e.touches.length < 2) return;
    var m = mid(e.touches), d = dist(e.touches);
    // 平移：中点位移 1:1 传给合成指针
    if (m.x !== gesture.mid.x || m.y !== gesture.mid.y) {
      pe('pointermove', viewport, m);
    }
    // 捏合：换算成 ctrl+wheel，走页面 setZoom（绕开组件缩放/候选切换分支）。
    // 页面在 pan 激活期间忽略 wheel，故先结束合成 pan、缩放、再按新中点重启 pan。
    if (gesture.dist > 0 && d > 0 && Math.abs(d - gesture.dist) > 0.5) {
      var factor = d / gesture.dist;
      factor = Math.max(0.8, Math.min(1.25, factor));
      var deltaY = -Math.log(factor) / 0.002;
      pe('pointerup', viewport, m);
      var target = document.elementFromPoint(m.x, m.y) || viewport;
      try {
        target.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true,
          clientX: m.x, clientY: m.y, deltaY: deltaY, ctrlKey: true
        }));
      } catch (err) {}
      pe('pointerdown', viewport, m);
    }
    gesture.mid = m;
    gesture.dist = d;
  }, { capture: true, passive: true });

  function endGesture(e) {
    if (gesture && e.touches.length < 2) {
      pe('pointerup', viewport, gesture.mid);
      gesture = null;
    }
    if (e.touches.length === 0) blocking = false;
  }
  window.addEventListener('touchend', endGesture, { capture: true, passive: true });
  window.addEventListener('touchcancel', endGesture, { capture: true, passive: true });

  /* ---------- 5. 小屏体验微调 ---------- */
  try {
    var style = document.createElement('style');
    style.textContent =
      'body{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}' +
      'textarea,input,[contenteditable]{-webkit-user-select:text;user-select:text;}' +
      '@media (max-width:640px){' +
      '.header{gap:6px;}' +
      '.header .brand{max-width:30px;overflow:hidden;flex:none;}' +
      '.header .brand img{max-width:none;}' +
      '.header-actions .button span{display:none;}' +
      '.header-actions{min-width:0;overflow-x:auto;scrollbar-width:none;}' +
      '.header-actions::-webkit-scrollbar{display:none;}' +
      '}';
    document.head.appendChild(style);
  } catch (e) {}

  log('bridge ready');
})();