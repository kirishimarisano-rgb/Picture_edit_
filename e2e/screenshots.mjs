// 每個里程碑的截圖：npm run screenshots → screenshots/*.png
import { open, settle } from './shoot.mjs';
import { mkdirSync } from 'node:fs';
mkdirSync('screenshots', { recursive: true });
const only = process.argv[2];
const shot = async (page, name) => { if (!only || name.includes(only)) await page.screenshot({ path: `screenshots/${name}.png` }); };

async function load(page) {
  await page.evaluate(() => window.app.openSample());
  await page.waitForFunction(() => window.app.doc, null, { timeout: 30000 });
  await settle(page, 900);
}

// ── 桌面 ──
{
  const { page, errors, close } = await open();
  await settle(page, 500);
  await shot(page, '01-empty');
  await load(page);
  await shot(page, '02-loaded');
  await page.evaluate(() => {
    const a = window.app;
    a.update((s) => { Object.assign(s.basic, { exposure: 0.2, contrast: 12, highlights: -45, shadows: 30, whites: 10, blacks: -6, vibrance: 18, clarity: 12, temp: 6 }); }, '調整');
    a.vp.split = 0.5; a.refreshChrome(); a.request();
  });
  await settle(page, 700);
  await shot(page, '03-adjust-split');
  await page.evaluate(() => { const a = window.app; a.vp.split = null; a.refreshChrome();
    a.update((s) => { s.curves.rgb = [[0, 0.04], [0.25, 0.2], [0.75, 0.82], [1, 0.97]]; s.hsl.green = [-12, -25, -10]; s.hsl.blue = [0, 15, -15]; }, '曲線');
    document.querySelectorAll('.sec-head').forEach((b) => { if (/曲線|HSL/.test(b.textContent)) b.click(); });
    document.querySelector('.panel-body').scrollTop = 560; a.request(); });
  await settle(page, 700);
  await shot(page, '04-curves-hsl');
  await page.evaluate(() => window.app.setTool('film'));
  await settle(page, 2500);
  await page.evaluate(() => document.querySelector('.stock[data-id="amber160"]').click());
  await settle(page, 2500);
  await shot(page, '05-film');
  await page.evaluate(() => { document.querySelector('.stock[data-id="neon800"]').click(); });
  await settle(page, 800);
  await page.evaluate(() => { window.app.vp.setZoom(1); });
  await settle(page, 900);
  await shot(page, '06-film-grain-100');
  await page.evaluate(() => { const a = window.app; a.vp.setZoom('fit'); document.querySelector('.stock[data-id="sumi400"]').click(); a.update((s) => { s.film.border = true; }, '片邊'); });
  await settle(page, 900);
  await shot(page, '07-film-mono-border');
  await page.evaluate(() => { const a = window.app; document.querySelector('.stock[data-id="faded200"]').click(); });
  await settle(page, 900);
  await shot(page, '08-film-faded-leak');
  await page.evaluate(() => { const a = window.app; a.update((s) => { s.film.enabled = false; }, 'x'); a.setTool('crop'); a.update((s) => { s.geometry.angle = 4; s.geometry.aspect = '4:5'; }, 'x'); });
  await page.evaluate(() => { const a = window.app; const { cropForAspect } = a; });
  await page.evaluate(() => document.querySelectorAll('.chip')[3].click());
  await settle(page, 800);
  await shot(page, '09-crop');
  await page.evaluate(() => { const a = window.app; a.setTool('mask'); });
  await page.evaluate(() => document.querySelectorAll('.add-row .btn')[2].click());
  await settle(page, 600);
  await shot(page, '10-mask-radial');
  await page.evaluate(() => { const a = window.app; a.showMaskHeld = true; a.request(); });
  await settle(page, 600);
  await shot(page, '11-mask-overlay');
  await page.evaluate(() => { const a = window.app; a.showMaskHeld = false; a.setTool('history'); });
  await settle(page, 400);
  await shot(page, '12-history');
  await page.evaluate(() => document.querySelector('.rail .tool[aria-label="快捷鍵"]').click());
  await settle(page, 400);
  await shot(page, '13-shortcuts');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.app.openExport());
  await settle(page, 400);
  await shot(page, '14-export');
  console.log(errors.join('\n') || '桌面：沒有錯誤');
  await close();
}

// ── 手機 ──
{
  const { page, errors, close } = await open({ width: 390, height: 844, mobile: true });
  await settle(page, 500);
  await shot(page, '20-mobile-empty');
  await load(page);
  await page.evaluate(() => { const a = window.app; a.update((s) => { s.basic.exposure = 0.35; s.basic.shadows = 25; }, 'x'); });
  await settle(page, 700);
  await shot(page, '21-mobile-adjust');
  await page.evaluate(() => { window.app.setTool('film'); document.querySelector('.panel').classList.add('expanded'); });
  await settle(page, 2500);
  await shot(page, '22-mobile-film');
  console.log(errors.join('\n') || '手機：沒有錯誤');
  await close();
}
