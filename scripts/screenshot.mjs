// Usage: node scripts/screenshot.mjs <path> <out.png> [width] [height]
// Signs in with SCREENSHOT_EMAIL / SCREENSHOT_PASSWORD (dev only) and captures a page.
import { chromium } from '@playwright/test';

const [path = '/', out = 'shot.png', width = '1440', height = '900'] = process.argv.slice(2);
const base = process.env.APP_URL ?? 'http://localhost:3000';
const browser = await chromium.launch(process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' ? { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' } : {});
const context = await browser.newContext({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 1 });
const page = await context.newPage();
const res = await page.request.post(`${base}/api/auth/login`, {
  data: { email: process.env.SCREENSHOT_EMAIL ?? 'sam@northline.test', password: process.env.SCREENSHOT_PASSWORD ?? 'correct horse battery' },
  headers: { origin: base },
});
if (!res.ok()) console.error('login failed', res.status(), await res.text());
await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.screenshot({ path: out, fullPage: process.env.FULL === '1' });
console.log('saved', out, page.url());
await browser.close();
