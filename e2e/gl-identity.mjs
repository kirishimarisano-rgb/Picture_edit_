// 在真的瀏覽器裡跑 shader：所有調整歸零時輸出必須等於輸入
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(execSync('npm root -g').toString().trim() + '/playwright'); }

const server = await createServer({ logLevel: 'error', server: { port: 5199 } });
await server.listen();
const browser = await pw.chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('http://localhost:5199/e2e/harness.html');
await page.waitForFunction(() => window.ready || false, null, { timeout: 30000 }).catch(() => {});
if (errors.length) { console.error(errors.join('\n')); }
const out = await page.evaluate(() => window.glTests());
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
const ok = out.results['預設狀態'].max <= 1 && out.results['底片強度 0'].max <= 1 && out.results['曝光 +1（應該不同）'].mean > 10
  && Object.values(out.stocks).every((v) => v > 20 && v < 240);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
