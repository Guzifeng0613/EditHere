#!/usr/bin/env node
// 意见图导出验证：注入 bridge.js 到 Web 版页面，用桩替代 AndroidBridge，
// 检查 endFile 文件名/类型并落地 PNG，供目视核对编号、换行与留白。
// 运行：cd android && node tests/notes-image.cjs   （依赖 playwright-core + 本机 Chromium）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const OUT = process.env.EDITHERE_OUT || os.tmpdir();
const CHROME = process.env.EDITHERE_CHROMIUM || '/usr/local/bin/chromium';
const bridge = fs.readFileSync(path.join(ROOT, 'android/app/src/main/assets/bridge.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'web/EditHere.html'), 'utf8');
const STUB = `window.__calls=[];window.__files={};window.AndroidBridge={beginFile(){this._b=''},appendFile(c){this._b+=c},endFile(n,m){window.__calls.push({t:'end',n,m,len:this._b.length});window.__files[n]=this._b},copyText(){},log(){}};`;
const FIXTURE = path.join(OUT, 'eh-notes-fixture.html');
fs.writeFileSync(FIXTURE, page.replace('</body>', `<script>${STUB}</script><script>${bridge}</script></body>`));

const svg = (w, h, body) => 'data:image/svg+xml;base64,' + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`).toString('base64');

async function scenario(name, w, h, image, notes, tag) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('file://' + FIXTURE);
  await p.waitForTimeout(350);

  const png = await p.evaluate(async ([w, h, src]) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  }, [w, h, image]);
  const srcFile = path.join(OUT, 'eh-notes-src.png');
  fs.writeFileSync(srcFile, Buffer.from(png, 'base64'));
  await p.locator('#file-input').setInputFiles(srcFile);
  for (let i = 0; i < 400 && await p.evaluate(() => !!document.body.dataset.busy); i++) await p.waitForTimeout(50);
  await p.waitForTimeout(350);

  for (const [fx, fy, text] of notes) {
    const box = await p.locator('#stage').boundingBox();
    // 页面只认 Pointer Events：合成一次拖拽即可生成框选批注
    await p.evaluate(([x, y]) => {
      const st = document.getElementById('stage');
      const base = { bubbles: true, cancelable: true, composed: true, pointerId: 42, pointerType: 'touch', isPrimary: true, button: 0 };
      st.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { buttons: 1, clientX: x, clientY: y })));
      st.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, base, { buttons: 1, clientX: x + 34, clientY: y + 26 })));
      st.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { buttons: 0, clientX: x + 34, clientY: y + 26 })));
    }, [box.x + box.width * fx, box.y + box.height * fy]);
    await p.waitForTimeout(300);
    if (!(await p.evaluate(() => !!document.querySelector('#note-dialog[open]')))) throw new Error('批注对话框未打开');
    await p.locator('#note-text').fill(text);
    await p.locator('#note-dialog button:not([type=button])').last().click();
    await p.waitForTimeout(300);
  }

  await p.evaluate(() => { window.__calls.length = 0; window.__files = {}; document.getElementById('eh-notes-image').click(); });
  await p.waitForTimeout(3200);
  const keys = await p.evaluate(() => Object.keys(window.__files));
  if (keys.length) {
    const data = await p.evaluate(k => window.__files[k], keys[0]);
    const outFile = path.join(OUT, `eh-notes-${tag}.png`);
    fs.writeFileSync(outFile, Buffer.from(data, 'base64'));
    console.log(`  ${outFile}  ${fs.statSync(outFile).size} bytes`);
  }
  const state = await p.evaluate(() => ({
    toast: (document.getElementById('eh-toast') || {}).textContent || '',
    calls: window.__calls.map(c => ({ t: c.t, n: c.n, m: c.m }))
  }));
  const ok = keys.length === 1 && /-notes\.png$/.test(keys[0]) && errors.length === 0;
  console.log(`[${notes.length ? '' : '无意见 '}${name}] ${ok ? 'PASS' : 'FAIL'} toast="${state.toast}" calls=${JSON.stringify(state.calls)}`
    + (errors.length ? ` errors=${errors.join(' | ')}` : ''));
  await browser.close();
  return ok;
}

(async () => {
  const results = [];
  results.push(await scenario('竖图 600×900 · 2 条', 600, 900,
    svg(600, 900, '<rect width="600" height="900" fill="#f4f6fa"/><rect x="30" y="60" width="540" height="120" rx="10" fill="#1f3a66"/><rect x="60" y="100" width="240" height="40" fill="#FFB352"/><rect x="30" y="220" width="540" height="300" rx="10" fill="#e6ecf7"/><circle cx="120" cy="330" r="46" fill="#3E74EF"/><rect x="30" y="560" width="540" height="280" rx="10" fill="#132C4A"/>'),
    [[0.15, 0.12, '标题改成蓝色'],
     [0.35, 0.55, '这个圆角图标太大了，建议缩小到 32px，并把右侧两行说明文字的字号从 14 提到 16，行距保持一致。']], 'portrait'));

  results.push(await scenario('横图 1200×675 · 1 条', 1200, 675,
    svg(1200, 675, '<rect width="1200" height="675" fill="#101a2b"/><rect x="80" y="90" width="500" height="60" fill="#FFB352"/><rect x="80" y="190" width="900" height="30" fill="#3E74EF"/><rect x="80" y="380" width="1040" height="210" fill="#1b2b45"/>'),
    [[0.2, 0.2, '横版页面里这个标题和下面的色块间距不够，加 12px']], 'landscape'));

  results.push(await scenario('长图 1080×2400 · 8 条', 1080, 2400,
    svg(1080, 2400, '<rect width="1080" height="2400" fill="#0B1A2E"/><rect x="60" y="120" width="960" height="200" fill="#FFB352"/><rect x="60" y="400" width="960" height="600" fill="#16304f"/><rect x="60" y="1100" width="960" height="600" fill="#16304f"/><rect x="60" y="1800" width="960" height="300" fill="#3E74EF"/>'),
    [[0.3, 0.06, '顶部横幅的黄色太饱和，建议换成 #FFC46B。'],
     [0.3, 0.2, '第二张卡片的圆角和第一张不一致，统一成 16。'],
     [0.3, 0.32, '这里缺少一个返回按钮。'],
     [0.3, 0.5, '文案太长，建议缩短到两行以内，并把行高从 24 提到 28，注意不要和下面的按钮挤在一起。'],
     [0.3, 0.62, '列表项之间的分隔线可以再淡一点。'],
     [0.3, 0.74, '底部按钮的点击热区建议不小于 44x44。'],
     [0.3, 0.85, '深色模式下这里几乎看不见，需要提高对比度。'],
     [0.3, 0.93, 'Mixed text like "Customize now" should not break mid-word.']], 'tall'));

  results.push(await scenario('无意见 900×600', 900, 600,
    svg(900, 600, '<rect width="900" height="600" fill="#fafbfd"/><rect x="60" y="70" width="420" height="46" fill="#1f3a66"/><rect x="60" y="180" width="780" height="330" fill="#e9eef7"/>'),
    [], 'plain'));

  // 组图模式：当前页 1 条批注 + 1 条整组意见（徽章「整 1」，胶囊样式）
  {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.goto('file://' + FIXTURE);
    await p.waitForTimeout(350);
    const srcA = path.join(OUT, 'eh-set-a.png'), srcB = path.join(OUT, 'eh-set-b.png');
    for (const [f, body] of [[srcA, '<rect width="800" height="600" fill="#1f3a66"/><rect x="60" y="60" width="300" height="60" fill="#FFB352"/>'],
                             [srcB, '<rect width="800" height="600" fill="#132C4A"/><circle cx="400" cy="300" r="120" fill="#3E74EF"/>']]) {
      const png = await p.evaluate(async ([w, h, src]) => {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL('image/png').split(',')[1];
      }, [800, 600, svg(800, 600, body)]);
      fs.writeFileSync(f, Buffer.from(png, 'base64'));
    }
    const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 4000 }), p.evaluate(() => document.getElementById('open').click())]);
    await chooser.setFiles([srcA, srcB]);
    for (let i = 0; i < 400 && await p.evaluate(() => !!document.body.dataset.busy); i++) await p.waitForTimeout(50);
    await p.waitForTimeout(350);
    const isSet = await p.locator('#set-bar').isVisible();
    const box = await p.locator('#stage').boundingBox();
    await p.evaluate(([x, y]) => {
      const st = document.getElementById('stage');
      const base = { bubbles: true, cancelable: true, composed: true, pointerId: 42, pointerType: 'touch', isPrimary: true, button: 0 };
      st.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { buttons: 1, clientX: x, clientY: y })));
      st.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, base, { buttons: 1, clientX: x + 30, clientY: y + 24 })));
      st.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { buttons: 0, clientX: x + 30, clientY: y + 24 })));
    }, [box.x + box.width * 0.3, box.y + box.height * 0.3]);
    await p.waitForTimeout(300);
    await p.locator('#note-text').fill('本页：黄色块改小一点');
    await p.locator('#note-dialog button:not([type=button])').last().click();
    await p.waitForTimeout(300);
    await p.evaluate(() => document.getElementById('group-note').click());
    await p.waitForTimeout(200);
    const groupDialog = await p.locator('#group-note-dialog[open]').count();
    await p.locator('#group-note-text').fill('整组统一圆角 16，主色统一 #3E74EF');
    await p.evaluate(() => document.getElementById('group-note-form').requestSubmit());
    await p.waitForTimeout(300);
    const groupCards = await p.locator('#group-notes .group-note').count();

    await p.evaluate(() => { window.__calls.length = 0; window.__files = {}; document.getElementById('eh-notes-image').click(); });
    await p.waitForTimeout(3200);
    const keys = await p.evaluate(() => Object.keys(window.__files));
    if (keys.length) {
      const data = await p.evaluate(k => window.__files[k], keys[0]);
      const outFile = path.join(OUT, 'eh-notes-set.png');
      fs.writeFileSync(outFile, Buffer.from(data, 'base64'));
      console.log(`  ${outFile}  ${fs.statSync(outFile).size} bytes`);
    }
    const ok = isSet && groupDialog === 1 && groupCards === 1 && keys.length === 1 && /-notes\.png$/.test(keys[0]) && errors.length === 0;
    console.log(`[组图 800×600 · 1 条 + 整组 1 条] ${ok ? 'PASS' : 'FAIL'} set=${isSet} groupDialog=${groupDialog} groupCards=${groupCards} file=${keys[0]}`
      + (errors.length ? ` errors=${errors.join(' | ')}` : ''));
    results.push(ok);
    await browser.close();
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 场景通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
