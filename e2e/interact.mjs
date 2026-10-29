// 互動測試：用真的滑鼠事件操作介面，確認各工具真的會改到編輯紀錄
import { open, settle } from './shoot.mjs';
import assert from 'node:assert/strict';
const { page, errors, close } = await open();
const S = () => page.evaluate(() => JSON.parse(JSON.stringify(window.app.state)));
const results = [];
const ok = (name) => { results.push('✓ ' + name); };
try {
  await page.evaluate(() => window.app.openSample());
  await page.waitForFunction(() => window.app.doc);
  await settle(page, 800);

  // 滑桿：拖曳、雙擊歸零
  const track = page.locator('.sl-track[aria-label="曝光"]');
  const box = await track.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  let s = await S();
  assert.ok(s.basic.exposure > 1.5, 'exposure dragged ' + s.basic.exposure);
  await track.dblclick();
  s = await S();
  assert.equal(s.basic.exposure, 0);
  ok('滑桿拖曳與雙擊歸零');

  // 鍵盤：方向鍵、復原、重做
  await page.locator('.sl-track[aria-label="對比"]').focus();
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal((await S()).basic.contrast, 10);
  await page.locator('canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+z');
  assert.equal((await S()).basic.contrast, 0);
  await page.keyboard.press('Control+Shift+z');
  assert.equal((await S()).basic.contrast, 10);
  ok('方向鍵、Ctrl+Z、Ctrl+Shift+Z');

  // 筆刷遮罩：在畫面上拖曳
  await page.keyboard.press('m');
  await page.keyboard.press('b');
  const vp = await page.locator('.viewport').boundingBox();
  await page.mouse.move(vp.x + vp.width * 0.3, vp.y + vp.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(vp.x + vp.width * 0.6, vp.y + vp.height * 0.45, { steps: 12 });
  await page.mouse.up();
  s = await S();
  assert.equal(s.masks[0].type, 'brush');
  assert.ok(s.masks[0].dabs.length > 10, 'dabs ' + s.masks[0].dabs.length);
  await page.keyboard.down('Alt');
  await settle(page, 300);
  await page.screenshot({ path: 'screenshots/15-mask-brush.png' });
  await page.keyboard.up('Alt');
  ok(`筆刷遮罩（${s.masks[0].dabs.length} 個筆觸點）`);

  // 線性漸層：拖曳把手
  await page.keyboard.press('g');
  await settle(page, 200);
  s = await S();
  const lin = s.masks[1];
  const a = await page.evaluate(([u, v]) => window.app.vp.srcToScreen(u, v), lin.a);
  await page.mouse.move(vp.x + a[0], vp.y + a[1]);
  await page.mouse.down();
  await page.mouse.move(vp.x + a[0] + 40, vp.y + a[1] - 60, { steps: 5 });
  await page.mouse.up();
  s = await S();
  assert.notDeepEqual(s.masks[1].a, lin.a);
  ok('線性漸層把手');

  // 修補：點一下
  await page.keyboard.press('j');
  await settle(page, 200);
  await page.mouse.click(vp.x + vp.width * 0.5, vp.y + vp.height * 0.7);
  await page.waitForFunction(() => window.app.state.spots.length === 1);
  s = await S();
  const sp = s.spots[0];
  assert.ok(Math.hypot(sp.sx - sp.x, sp.sy - sp.y) > sp.r, 'source away from target');
  await settle(page, 300);
  await page.screenshot({ path: 'screenshots/16-heal.png' });
  ok('污點修復自動找來源');

  // 裁切：拖曳角落把手
  await page.keyboard.press('r');
  await settle(page, 400);
  const r = await page.evaluate(() => window.app.vp.rect);
  await page.mouse.move(vp.x + r[0] + 1, vp.y + r[1] + 1);
  await page.mouse.down();
  await page.mouse.move(vp.x + r[0] + 120, vp.y + r[1] + 80, { steps: 6 });
  await page.mouse.up();
  s = await S();
  assert.ok(s.geometry.crop.x > 0.05 && s.geometry.crop.w < 0.95, JSON.stringify(s.geometry.crop));
  ok('裁切把手');
  await page.locator('button:has-text("自動拉直")').click();
  await settle(page, 600);
  ok(`自動拉直（${(await S()).geometry.angle}°）`);
  await page.keyboard.press('Enter');
  await settle(page, 300);
  assert.equal(await page.evaluate(() => window.app.tool), 'adjust');
  ok('Enter 完成裁切');

  // 多張照片、底片條、同步
  await page.evaluate(async () => {
    const b = await (await fetch('./samples/yosemite.jpg')).blob();
    await window.app.openFiles([new File([b], 'second.jpg', { type: 'image/jpeg' })]);
  });
  await page.waitForFunction(() => window.app.docs.length === 2);
  await settle(page, 600);
  assert.ok(await page.locator('.filmstrip').isVisible());
  ok('多張照片與底片條');

  // 匯出：攔截下載
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    (async () => { await page.keyboard.press('Control+e'); await page.locator('.modal .btn.primary').click(); })(),
  ]);
  const path = await dl.path();
  const { statSync } = await import('node:fs');
  assert.ok(statSync(path).size > 50000);
  ok(`匯出 JPEG（${dl.suggestedFilename()}，${Math.round(statSync(path).size / 1024)} KB）`);
  await settle(page, 400);
  await page.screenshot({ path: 'screenshots/17-filmstrip.png' });
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  console.log(results.join('\n'));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  await close();
}
