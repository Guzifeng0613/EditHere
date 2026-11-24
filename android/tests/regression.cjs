/* EditHere 安卓壳注入层回归：真实触控事件（CDP dispatchTouchEvent，isTrusted=true）。
 * 用法：node /tmp/pw/reg.cjs */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(ROOT, 'web/EditHere.html'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'android/app/src/main/assets/bridge.js'), 'utf8');
const stub = `
window.__calls = []; window.__files = {};
window.AndroidBridge = {
  beginFile(){ this._buf=''; },
  appendFile(c){ this._buf += c; },
  endFile(n, m){ window.__calls.push({t:'end', n, m, len:this._buf.length}); window.__files[n]=this._buf; },
  copyText(t){ window.__calls.push({t:'copy', len:(t||'').length, text:t}); },
  log(m){ window.__calls.push({t:'log', m:String(m)}); }
};`;
fs.writeFileSync('/tmp/eh-reg.html', html.replace('</body>', `<script>${stub}</script><script>${bridge}</script></body>`));

// 2 秒测试视频（纯色 + 移动方块），与 Chromium 同 codec 家族（H.264 baseline / yuv420p）
const { execSync } = require('child_process');
if (!fs.existsSync('/tmp/eh-test.mp4')) {
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "color=c=0x0B1A2E:s=480x720:d=2:r=15" -vf "drawbox=x=40:y=100:w=200:h=120:color=0xFFB352:t=fill" -pix_fmt yuv420p -c:v libx264 -profile:v baseline -movflags +faststart /tmp/eh-test.mp4`);
}

const R = [];
function ok(name, cond, extra) { R.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' :: ' + extra : ''}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDITHERE_CHROMIUM || '/usr/local/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [], consoleErrors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('dialog', d => d.accept());
  const cdp = await ctx.newCDPSession(page);

  const isBusy = () => page.evaluate(() => !!document.body.dataset.busy);
  async function waitIdle(max = 20000) { const t0 = Date.now(); await sleep(100); while (await isBusy()) { if (Date.now() - t0 > max) throw new Error('busy timeout'); await sleep(50); } await sleep(150); }
  async function box(sel) { return page.locator(sel).boundingBox(); }
  async function center(sel) { const b = await box(sel); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
  async function touch(type, pts) { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 4, radiusY: 4, force: 1 })) }); }
  async function tapAt(p) { await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(120); }
  async function drag1(a, b, steps = 6) {
    await touch('touchStart', [a]); await sleep(40);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', [{ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps, id: 0 }]); await sleep(25); }
    await touch('touchEnd', []); await sleep(150);
  }
  async function pinch(cx, cy, r0, r1, steps = 6) {
    await touch('touchStart', [{ x: cx - r0, y: cy, id: 0 }, { x: cx + r0, y: cy, id: 1 }]); await sleep(40);
    for (let i = 1; i <= steps; i++) { const r = r0 + (r1 - r0) * i / steps; await touch('touchMove', [{ x: cx - r, y: cy, id: 0 }, { x: cx + r, y: cy, id: 1 }]); await sleep(25); }
    await touch('touchEnd', []); await sleep(150);
  }
  async function pan2(cx, cy, dx, dy, r = 40, steps = 6) {
    await touch('touchStart', [{ x: cx - r, y: cy, id: 0 }, { x: cx + r, y: cy, id: 1 }]); await sleep(40);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', [{ x: cx - r + dx * i / steps, y: cy + dy * i / steps, id: 0 }, { x: cx + r + dx * i / steps, y: cy + dy * i / steps, id: 1 }]); await sleep(25); }
    await touch('touchEnd', []); await sleep(150);
  }
  const zoom = () => page.locator('#fit').textContent();
  const pins = () => page.locator('#pins [data-note]').count();
  const dialogOpen = () => page.evaluate(() => !!document.querySelector('#note-dialog[open]'));
  async function saveNote(text) {
    await page.locator('#note-text').fill(text);
    await page.locator('#note-form button[type=submit], #note-dialog button:not([type=button])').last().click();
    await sleep(250);
  }
  async function ensureUtility() {
    const vis = await page.locator('#save-project').isVisible();
    if (!vis) { await tapAt(await center('#utility-toggle')); await sleep(250); }
  }
  const stagePos = () => page.evaluate(() => [document.getElementById('stage').style.left, document.getElementById('stage').style.top, document.getElementById('stage').style.width]);
  async function loadPng(w, h, draw) {
    const data = await page.evaluate(async ([w, h, src]) => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png').split(',')[1]; }, [w, h, draw]);
    fs.writeFileSync('/tmp/eh-in.png', Buffer.from(data, 'base64'));
    await page.locator('#file-input').setInputFiles('/tmp/eh-in.png');
    await waitIdle();
  }

  try {
    await page.goto('file:///tmp/eh-reg.html');
    await sleep(300);
    ok('bridge injected', await page.evaluate(() => !!window.__edithereAndroid));
    const readyLogged = await page.evaluate(() => window.__calls.some(c => c.t === 'log' && /ready/.test(c.m)));
    ok('bridge ready log', readyLogged);
    ok('no INTERNET-dependent init error', errors.length === 0, errors.join('|'));

    // ---- T1 打开素材 ----
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#0B1A2E"/><rect x="40" y="120" width="520" height="160" fill="#132C4A"/><rect x="60" y="150" width="200" height="36" fill="#FFB352"/><rect x="60" y="210" width="360" height="18" fill="#6AADFF"/><rect x="40" y="330" width="520" height="300" fill="#132C4A"/><rect x="60" y="370" width="480" height="56" fill="#3E74EF"/><rect x="60" y="460" width="300" height="18" fill="#88A7FF"/></svg>`;
    await loadPng(600, 900, 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
    ok('T1 image loaded, export enabled', await page.locator('#export').isEnabled() && await page.locator('#save-project').isEnabled());
    const sb = await box('#stage');
    ok('T1 stage fit within viewport', sb.x >= 0 && sb.x + sb.width <= 420 && sb.y >= 0, JSON.stringify(sb));
    const P = (fx, fy) => ({ x: sb.x + sb.width * fx, y: sb.y + sb.height * fy });

    // ---- T2 单指框选批注（真实触控）----
    await drag1(P(0.12, 0.14), P(0.5, 0.25));
    ok('T2 rect annotation opens note dialog', await dialogOpen());
    if (await dialogOpen()) await saveNote('标题按钮改蓝色，圆角加大');
    ok('T2 note saved -> pin #1', await pins() === 1, await pins());

    // ---- T3 点批注 ----
    await tapAt(await center('[data-mode="point"]'));
    await tapAt(P(0.8, 0.55));
    ok('T3 point annotation opens dialog', await dialogOpen());
    if (await dialogOpen()) await saveNote('这里留白太多');
    ok('T3 note saved -> pin #2', await pins() === 2, await pins());

    // ---- T4 智能选块点按 ----
    await tapAt(await center('[data-mode="smart"]'));
    await sleep(200);
    await tapAt(P(0.3, 0.18));
    ok('T4 smart tap opens dialog (candidate)', await dialogOpen());
    if (await dialogOpen()) { await page.locator('#note-dialog button', { hasText: '取消' }).click(); await sleep(200); }
    ok('T4 cancel keeps 2 pins', await pins() === 2, await pins());

    // ---- T5 撤销/重做 ----
    await tapAt(await center('#undo')); await sleep(150);
    const afterUndo = await pins();
    await tapAt(await center('#redo')); await sleep(150);
    ok('T5 undo/redo', afterUndo === 1 && await pins() === 2, `${afterUndo}->${await pins()}`);

    // ---- T6 保存项目 ----
    await page.evaluate(() => { window.__calls.length = 0; window.__files = {}; });
    await ensureUtility();
    await tapAt(await center('#save-project')); await sleep(600);
    const projName = await page.evaluate(() => { window.__files0 = window.__files; return (window.__calls.find(c => c.t === 'end') || {}).n; });
    const proj = await page.evaluate(() => { const k = Object.keys(window.__files)[0]; try { return JSON.parse(atob(window.__files[k])); } catch (e) { return { err: String(e) }; } });
    ok('T6 save project -> bridge file', /\.edithere-web\.json$/.test(projName || ''), projName);
    const countAnn = (v) => { if (!v || typeof v !== 'object') return 0; let n = 0; for (const [k, x] of Object.entries(v)) { if ((k === 'annotations' || k === 'notes') && Array.isArray(x)) n += x.length; else n += countAnn(x); } return n; };
  const noteCount = countAnn(proj);
    ok('T6 project JSON valid with 2 notes', noteCount === 2, `keys=${Object.keys(proj || {}).join(',')} notes=${noteCount}`);

    // ---- T7 导出反馈 ----
    await page.evaluate(() => { window.__calls.length = 0; window.__files = {}; });
    await tapAt(await center('#export')); await sleep(400);
    ok('T7 export dialog opens', await page.evaluate(() => !!document.querySelector('#export-dialog[open]')));
    await tapAt(await center('#copy-json')); await sleep(500);
    const copy = await page.evaluate(() => window.__calls.find(c => c.t === 'copy'));
    let fb = null; try { fb = JSON.parse(copy.text); } catch (e) {}
    ok('T7 copy JSON -> clipboard bridge', !!copy && !!fb, copy ? `len=${copy.len} keys=${Object.keys(fb || {}).join(',')}` : 'no call');
    const annCount = fb ? countAnn(fb) : -1;
    ok('T7 feedback JSON has 2 annotations', annCount === 2, annCount);
    await tapAt(await center('#download-json')); await sleep(800);
    const fbFile = await page.evaluate(() => (window.__calls.find(c => c.t === 'end') || {}).n);
    ok('T7 download feedback -> bridge file', /-feedback\.(json|zip)$/.test(fbFile || ''), fbFile);
    await page.keyboard.press('Escape'); await sleep(200);

    // ---- T8 保存批注图 ----
    await page.evaluate(() => { window.__calls.length = 0; });
    await ensureUtility();
    await tapAt(await center('#preview')); await sleep(1500);
    const png = await page.evaluate(() => window.__calls.find(c => c.t === 'end'));
    ok('T8 annotated PNG -> bridge', !!png && /-annotations\.png$/.test(png.n) && png.m === 'image/png' && png.len > 1000, png && `${png.n} ${png.m} ${png.len}`);

    // ---- T9 双指捏合放大 ----
    const z0 = await zoom();
    await pinch(sb.x + sb.width / 2, sb.y + sb.height / 2, 40, 110);
    const z1 = await zoom();
    ok('T9 pinch zoom in', parseFloat(z1) > parseFloat(z0) + 5, `${z0} -> ${z1}`);
    await pinch(sb.x + sb.width / 2, sb.y + sb.height / 2, 110, 40);
    ok('T9 pinch zoom out', parseFloat(await zoom()) < parseFloat(z1), `${z1} -> ${await zoom()}`);

    // ---- T10 双指平移 ----
    const p0 = await stagePos();
    await pan2(sb.x + sb.width / 2, sb.y + sb.height / 2, 60, 40);
    const p1 = await stagePos();
    ok('T10 two-finger pan moves stage ~60,40', Math.abs(parseFloat(p1[0]) - parseFloat(p0[0]) - 60) < 6 && Math.abs(parseFloat(p1[1]) - parseFloat(p0[1]) - 40) < 6, `${p0} -> ${p1}`);
    ok('T10 pan creates no note', await pins() === 2 && !(await dialogOpen()), await pins());

    // ---- T11 单指拖动中落第二指 ----
    await page.evaluate(() => { window.__calls.length = 0; });
    const a = P(0.6, 0.7), b = P(0.7, 0.75);
    await touch('touchStart', [{ x: a.x, y: a.y, id: 0 }]); await sleep(40);
    await touch('touchMove', [{ x: b.x, y: b.y, id: 0 }]); await sleep(40);
    const zBefore = parseFloat(await zoom());
    await touch('touchStart', [{ x: a.x, y: a.y, id: 0 }, { x: a.x + 30, y: a.y, id: 1 }]); await sleep(40);
    for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ x: a.x - i * 10, y: a.y, id: 0 }, { x: a.x + 30 + i * 10, y: a.y, id: 1 }]); await sleep(25); }
    await touch('touchEnd', [{ x: a.x + 80, y: a.y, id: 1 }]); await sleep(60);   // 抬起一指
    await touch('touchMove', [{ x: a.x + 20, y: a.y + 60, id: 1 }]); await sleep(60); // 残留手指移动不应画框
    await touch('touchEnd', []); await sleep(250);
    const zAfter = parseFloat(await zoom());
    ok('T11 gesture during drag zooms, no stray note', zAfter > zBefore + 3 && await pins() === 2 && !(await dialogOpen()), `${zBefore} -> ${zAfter} pins=${await pins()}`);

    // ---- T12 平移模式单指拖动 ----
    await tapAt(await center('[data-mode="pan"]'));
    const q0 = await stagePos();
    await drag1({ x: 300, y: 300 }, { x: 340, y: 330 });
    const q1 = await stagePos();
    ok('T12 pan mode single-finger drag', Math.abs(parseFloat(q1[0]) - parseFloat(q0[0])) > 10, `${q0} -> ${q1}`);
    await tapAt(await center('[data-mode="smart"]'));

    // ---- T13 大爆炸 + 组件拖动 ----
    await page.evaluate(() => { window.__calls.length = 0; });
    await tapAt(await center('#explode')); await sleep(800);
    ok('T13 explode toggled on', await page.locator('#explode').getAttribute('aria-pressed') === 'true');
    await tapAt(await center('[data-mode="select"]'));
    await sleep(200);
    const mv0 = await page.locator('[data-movement]').count();
    await drag1(P(0.3, 0.18), P(0.3, 0.30));
    await sleep(300);
    const mv1 = await page.locator('[data-movement]').count();
    ok('T13 component drag creates movement', mv1 > mv0, `${mv0} -> ${mv1}`);
    if (await dialogOpen()) { await page.locator('#note-dialog button', { hasText: '取消' }).click(); await sleep(200); }
    await tapAt(await center('#undo')); await sleep(200);
    await tapAt(await center('#explode')); await sleep(400);

    // ---- T14 帮助 ----
    await ensureUtility();
    await tapAt(await center('#help')); await sleep(300);
    ok('T14 help dialog opens', await page.evaluate(() => !!document.querySelector('#help-dialog[open]')));
    await page.keyboard.press('Escape'); await sleep(200);

    // ---- T15 组图（一次选两张进入组图模式）----
    const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null), tapAt(await center('#open'))]);
    ok('T15 open button triggers file chooser', !!fc);
    fs.copyFileSync('/tmp/eh-in.png', '/tmp/eh-in2.png');
    if (fc) { await fc.setFiles(['/tmp/eh-in.png', '/tmp/eh-in2.png']); await waitIdle(); }
    ok('T15 set mode with 2 pages', await page.locator('#set-bar').isVisible(), (await page.locator('#set-meta').textContent().catch(() => '')).slice(0, 60));
    ok('T15 add-pages button visible in set mode', await page.locator('#add-pages').isVisible());

    // ---- T15b 重新打开已保存项目（闭环）----
    fs.writeFileSync('/tmp/eh-proj.json', Buffer.from(Object.values(await page.evaluate(() => window.__files0 || {}))[0] || '', 'base64'));
    await page.evaluate(() => { window.__calls.length = 0; window.__files = {}; });
    await page.locator('#file-input').setInputFiles('/tmp/eh-in.png'); await waitIdle();
    await page.locator('#file-input').setInputFiles('/tmp/eh-proj.json'); await waitIdle(); await page.keyboard.press('Escape'); await waitIdle();
    ok('T15b reopen saved project restores 2 notes', await pins() === 2, await pins());

    // ---- T16 视频 ----
    await page.evaluate(() => { window.__calls.length = 0; });
    await page.locator('#file-input').setInputFiles('/tmp/eh-test.mp4'); await waitIdle();
    await page.keyboard.press('Escape'); await sleep(300); // 若弹替换确认由 dialog 处理
    await waitIdle();
    const isVideo = await page.evaluate(() => document.body.dataset.mediaKind === 'video');
    ok('T16 video loaded', isVideo, await page.evaluate(() => document.body.dataset.mediaKind));
    if (isVideo) {
      await page.locator('#video').evaluate(v => v.play()); await sleep(700);
      await page.locator('#video').evaluate(v => v.pause()); await sleep(200);
      const vb = await box('#stage');
      await tapAt({ x: vb.x + vb.width * 0.5, y: vb.y + vb.height * 0.3 }); await sleep(300);
      if (await dialogOpen()) await saveNote('这一帧字幕太小');
      await ensureUtility();
      await tapAt(await center('#preview')); await sleep(1500);
      const vpng = await page.evaluate(() => (window.__calls.find(c => c.t === 'end' && /png$/.test(c.n)) || {}).n);
      ok('T16 video frame annotated PNG export', !!vpng && /-\d+-annotations\.png$/.test(vpng), vpng);
    }

    // ---- T17 360px 顶栏 ----
    await page.setViewportSize({ width: 360, height: 740 }); await sleep(400);
    const layout = await page.evaluate(() => {
      const out = { vw: innerWidth, items: [] };
      document.querySelectorAll('.header > *').forEach(e => { const b = e.getBoundingClientRect(); out.items.push([e.className.split(' ')[0], Math.round(b.left), Math.round(b.right), getComputedStyle(e).display]); });
      const ex = document.getElementById('export').getBoundingClientRect(); out.export = [Math.round(ex.left), Math.round(ex.right), ex.width];
      out.scrollable = (() => { const a = document.querySelector('.header-actions'); return a ? a.scrollWidth > a.clientWidth : null; })();
      return out;
    });
    const maxRight = Math.max(...layout.items.map(i => i[2]));
    ok('T17 header fits 360px', maxRight <= 360 && layout.export[1] <= 360, JSON.stringify(layout));
    const sb2 = await box('#stage');
    ok('T17 stage fits 360px after rotation-like resize', sb2.x >= 0 && sb2.x + sb2.width <= 360, JSON.stringify(sb2));

    ok('T18 no pageerror', errors.length === 0, errors.join(' | '));
    ok('T19 no console.error', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 400));
    ok('T20 (moved to top) bridge ready log', readyLogged);
  } catch (e) {
    R.push('FAIL EXCEPTION ' + (e.stack || e.message));
  }
  await browser.close();
  console.log(R.join('\n'));
  fs.writeFileSync('/tmp/eh-reg-result.txt', R.join('\n'));
})();
