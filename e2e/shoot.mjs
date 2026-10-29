// 共用：啟動 vite preview + Playwright
import { preview } from 'vite';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(execSync('npm root -g').toString().trim() + '/playwright'); }

export async function open({ width = 1440, height = 900, mobile = false, port = 4178 } = {}) {
  const server = await preview({ preview: { port, strictPort: false }, logLevel: 'error' });
  const url = server.resolvedUrls.local[0];
  const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(url);
  return { page, errors, close: async () => { await browser.close(); await new Promise((r) => server.httpServer.close(r)); } };
}

export async function settle(page, ms = 400) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(ms);
}
