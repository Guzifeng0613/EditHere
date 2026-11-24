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
  var pendingCapture = null;                    // 供意见图导出复用页面渲染结果
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
    if (pendingCapture) {                       // 意见图导出时先截下页面渲染的批注图
      var take = pendingCapture;
      pendingCapture = null;
      take(blob, name);
      return;
    }
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

  /* ---------- 6. 意见图：原图（含圈画）贴白底 + 下方自适应意见栏 ---------- */
  function toast(msg) {
    try {
      var t = document.getElementById('eh-toast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'eh-toast';
        t.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:99;' +
          'max-width:86vw;padding:9px 15px;border-radius:12px;background:rgba(16,24,38,.92);color:#fff;' +
          'font:13px/1.4 -apple-system,"PingFang SC",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.24);' +
          'transition:opacity .2s;text-align:center;pointer-events:none;';
        document.body.appendChild(t);
      }
      t.textContent = msg;
      t.style.opacity = '1';
      clearTimeout(t._timer);
      t._timer = setTimeout(function () { t.style.opacity = '0'; }, 2600);
    } catch (e) {}
  }

  // 从页面批注列表取文字与编号（与画面上编号一致）
  // 页面结构：#notes 只渲染当前页的 .note-card（.note-number / 直接子 p）；
  // 只有位移没写字的卡片是 .movement-empty，p 里是占位文字，不算意见；
  // 整组意见（仅组图模式）渲染在 #group-notes .group-note（.group-note-number「整 N」/ 直接子 p）
  function collectNotes() {
    var items = [];
    var cards = document.querySelectorAll('#notes .note-card:not(.movement-empty)');
    for (var i = 0; i < cards.length; i++) {
      var numEl = cards[i].querySelector('.note-number');
      var kindEl = cards[i].querySelector('.note-kind');
      var p = cards[i].querySelector(':scope > p');
      var text = p ? (p.textContent || '').replace(/\s+/g, ' ').trim() : '';
      if (!text) continue;
      items.push({
        n: numEl ? (numEl.textContent || '').trim() : String(i + 1),
        kind: kindEl ? (kindEl.textContent || '').trim() : '',
        text: text
      });
    }
    var groups = document.querySelectorAll('#group-notes .group-note');
    for (var j = 0; j < groups.length; j++) {
      var gn = groups[j].querySelector('.group-note-number');
      var gp = groups[j].querySelector(':scope > p');
      var gt = gp ? (gp.textContent || '').replace(/\s+/g, ' ').trim() : '';
      if (!gt) continue;
      items.push({ n: (gn ? (gn.textContent || '').trim() : '整 ' + (j + 1)), kind: '整组意见', text: gt });
    }
    return items;
  }

  // 借页面自己的「保存批注图」渲染结果（布局位移、箭头、圈画、编号都在里面）
  function captureAnnotatedImage() {
    return new Promise(function (resolve, reject) {
      var preview = document.getElementById('preview');
      if (!preview || preview.disabled) { reject(new Error('先打开图片或视频，并添加批注')); return; }
      if (document.body.dataset.busy) { reject(new Error('正在处理上一个操作，稍候再试')); return; }
      var timer = setTimeout(function () {
        pendingCapture = null;
        reject(new Error('没有取到批注图，请先添加批注'));
      }, 15000);   // 手机上大图渲染 + toBlob 可能较慢
      pendingCapture = function (blob, name) {
        clearTimeout(timer);
        if (!blob) { reject(new Error('没有取到批注图')); return; }
        resolve({ blob: blob, name: name || '' });
      };
      preview.click();
    });
  }

  // 中文/英文混排断行：ASCII 单词整体保留，CJK 逐字可断
  function tokenize(text) {
    var out = [], buf = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (/[A-Za-z0-9_'\-.,:;!?%$/\\@#&*+=<>()[\]{}|~]/.test(ch)) { buf += ch; continue; }
      if (buf) { out.push(buf); buf = ''; }
      if (ch === ' ') out.push(' ');
      else out.push(ch);
    }
    if (buf) out.push(buf);
    return out;
  }

  function wrapText(ctx, text, maxWidth) {
    var lines = [], line = '';
    var tokens = tokenize(text);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var test = line + t;
      if (ctx.measureText(test).width > maxWidth && line.replace(/\s+$/, '') !== '') {
        lines.push(line.replace(/\s+$/, ''));
        line = t === ' ' ? '' : t;
      } else {
        line = test;
      }
      // 单个超长英文串，硬切
      while (ctx.measureText(line).width > maxWidth && line.length > 1) {
        var cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line.replace(/\s+$/, '') !== '') lines.push(line.replace(/\s+$/, ''));
    return lines;
  }

  var FONT_STACK = '"PingFang SC","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei",sans-serif';
  var MAX_PIXELS = 24e6;   // 手机内存安全上限，超了等比缩小

  async function buildNotesImage(imageBlob, baseName) {
    var url = URL.createObjectURL(imageBlob);
    var img = new Image();
    img.src = url;
    try { await img.decode(); } finally { /* 下面统一 revoke */ }
    var W = img.naturalWidth, H = img.naturalHeight;
    var notes = collectNotes();

    // 设计尺寸：字号随原图宽度等比，保证大图小图观感一致
    var pad = Math.round(Math.max(32, W * 0.045));
    var fs = Math.round(Math.max(17, Math.min(76, W / 34)));
    var lh = Math.round(fs * 1.62);
    var badge = Math.round(fs * 1.55);
    var gapX = Math.round(fs * 0.62);
    var gapY = Math.round(fs * 0.7);
    var titleFs = Math.round(fs * 1.32);
    // 编号徽章宽度按最宽标签（数字 / 「整 1」）自适应，正文列从徽章右侧起
    var measure = document.createElement('canvas').getContext('2d');
    measure.font = 'bold ' + Math.round(fs * 0.95) + 'px ' + FONT_STACK;
    var badgeW = badge;
    for (var bi = 0; bi < notes.length; bi++) {
      badgeW = Math.max(badgeW, Math.ceil(measure.measureText(notes[bi].n).width + fs * 0.6));
    }
    var textW = W - badgeW - gapX;

    var canvasW = W + pad * 2;
    var textX = pad + badgeW + gapX;
    var y = pad + H + pad;                       // 图下留白后接意见栏

    var linesByNote = [];
    measure.font = fs + 'px ' + FONT_STACK;
    for (var i = 0; i < notes.length; i++) {
      var wrapped = wrapText(measure, notes[i].text, textW);
      linesByNote.push(wrapped);
      y += Math.max(badge, wrapped.length * lh) + gapY;
    }
    var titleText = notes.length ? '修改意见 · ' + notes.length + ' 条' : '修改意见';
    var titleTop = pad + H + pad;
    y += Math.round(titleFs * 1.9);
    // 底部多留一点呼吸空间，避免末条文字贴边
    var canvasH = notes.length ? y + pad + Math.round(fs * 0.5) : pad * 2 + H;

    var K = 1;
    if (canvasW * canvasH > MAX_PIXELS) K = Math.sqrt(MAX_PIXELS / (canvasW * canvasH));

    var out = document.createElement('canvas');
    out.width = Math.round(canvasW * K);
    out.height = Math.round(canvasH * K);
    var p = out.getContext('2d');
    p.setTransform(K, 0, 0, K, 0, 0);
    p.imageSmoothingQuality = 'high';

    p.fillStyle = '#ffffff';
    p.fillRect(0, 0, canvasW, canvasH);

    // 原图（批注后的）居中贴入，细边框区分画面与白边
    p.drawImage(img, pad, pad, W, H);
    p.strokeStyle = '#dfe4ec';
    p.lineWidth = Math.max(1, W / 1200);
    p.strokeRect(pad + .5, pad + .5, W - 1, H - 1);

    if (!notes.length) {
      URL.revokeObjectURL(url);
      return out;
    }

    // 标题
    p.fillStyle = '#111827';
    p.font = 'bold ' + titleFs + 'px ' + FONT_STACK;
    p.textBaseline = 'alphabetic';
    p.fillText(titleText, pad, titleTop + Math.round(titleFs * 1.15));
    p.strokeStyle = '#e5e9f0';
    p.lineWidth = Math.max(1, W / 1400);
    p.beginPath();
    p.moveTo(pad, titleTop + Math.round(titleFs * 1.62));
    p.lineTo(pad + W, titleTop + Math.round(titleFs * 1.62));
    p.stroke();

    // 逐条意见：编号圆点 + 正文
    var ty = titleTop + Math.round(titleFs * 1.9) + Math.round(fs * 0.2);
    for (var j = 0; j < notes.length; j++) {
      var lines = linesByNote[j];
      var blockH = Math.max(badge, lines.length * lh);
      var cy = ty + Math.max(badge, lh) / 2;
      p.fillStyle = '#346df1';
      if (badgeW <= badge + 1) {
        p.beginPath();
        p.arc(pad + badge / 2, cy, badge / 2, 0, Math.PI * 2);
        p.fill();
      } else {
        var r = badge / 2;
        p.beginPath();
        p.moveTo(pad + r, cy - r);
        p.lineTo(pad + badgeW - r, cy - r);
        p.arc(pad + badgeW - r, cy, r, -Math.PI / 2, Math.PI / 2);
        p.lineTo(pad + r, cy + r);
        p.arc(pad + r, cy, r, Math.PI / 2, Math.PI * 1.5);
        p.closePath();
        p.fill();
      }
      p.fillStyle = '#ffffff';
      p.font = 'bold ' + Math.round(fs * 0.95) + 'px ' + FONT_STACK;
      p.textAlign = 'center';
      p.textBaseline = 'middle';
      p.fillText(notes[j].n, pad + badgeW / 2, cy + 1);
      p.textAlign = 'left';
      p.textBaseline = 'alphabetic';
      p.fillStyle = '#1f2937';
      p.font = fs + 'px ' + FONT_STACK;
      for (var k = 0; k < lines.length; k++) {
        p.fillText(lines[k], textX, ty + lh * k + fs * 1.0);
      }
      ty += blockH + gapY;
    }

    URL.revokeObjectURL(url);
    return out;
  }

  function notesImageName(raw) {
    var base = (raw || '').replace(/\.png$/i, '').replace(/-annotations$/i, '');
    if (!base) base = 'edithere';
    return base + '-notes.png';
  }

  async function exportNotesImage() {
    try {
      var cap = await captureAnnotatedImage();
      var canvas = await buildNotesImage(cap.blob, cap.name);
      var blob = await new Promise(function (resolve, reject) {
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('图片编码失败')); }, 'image/png');
      });
      sendBlob(notesImageName(cap.name), blob);
      toast(collectNotes().length ? '已生成意见图，正在保存到下载目录'
        : '还没有文字意见，已导出带白边的原图');
    } catch (e) {
      toast(e && e.message ? e.message : '意见图导出失败');
      log('notes image failed: ' + (e && e.message));
    }
  }

  // 工具坞新增入口（只存在于安卓壳里，页面代码不动）
  (function addNotesImageButton() {
    var actions = document.querySelector('.utility-actions');
    if (!actions || document.getElementById('eh-notes-image')) return;
    var b = document.createElement('button');
    b.id = 'eh-notes-image';
    b.type = 'button';
    b.className = 'button';
    b.title = '导出意见图：原图圈画 + 下方意见栏';
    b.setAttribute('aria-label', '导出意见图');
    b.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-notes"/></svg><span>意见图</span>';
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); exportNotesImage(); }, true);
    actions.insertBefore(b, actions.firstChild);
  })();

  /* ---------- 7. 移动端导出收口：只保留「意见图」 ---------- */
  // 隐藏 导出反馈（JSON/ZIP）、保存 JSON 一组、保存批注图；
  // 保留 保存项目（存档续改，返回键防丢依赖它）、意见图、主题、帮助。
  // 节点只是不可见，底层能力还在——意见图内部仍借 #preview 渲染批注图。
  (function () {
    var style = document.createElement('style');
    style.id = 'eh-export-scope';
    style.textContent = '#export,.save-control,#export-dialog{display:none!important;}';
    (document.head || document.documentElement).appendChild(style);
    // 节点虽不可见，程序化点击仍会弹出一个看不见的模态框并挡住后续操作，
    // 这里摘掉原来的回调（页面用 onclick 属性绑定，可安全置空）。
    // 注意 #preview 的回调必须保留：意见图靠它渲染批注画布。
    var ex = document.getElementById('export');
    var sj = document.getElementById('save-json');
    if (ex) ex.onclick = null;
    if (sj) sj.onclick = null;
    var pv = document.getElementById('preview');
    if (pv) {
      pv.style.display = 'none';
      pv.setAttribute('aria-hidden', 'true');
      pv.tabIndex = -1;
    }
  })();

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