import { open, settle } from './shoot.mjs';
const { page, errors, close } = await open();
await settle(page, 800); console.log(errors.join('\n')); await page.screenshot({ path: '/tmp/claude-0/s-empty.png' });
await page.evaluate(() => window.app.openSample());
await page.waitForFunction(() => window.app.doc, null, { timeout: 30000 });
await settle(page, 1200);
await page.screenshot({ path: '/tmp/claude-0/s-loaded.png' });
console.log(errors.join('\n') || 'no errors');
await close();
