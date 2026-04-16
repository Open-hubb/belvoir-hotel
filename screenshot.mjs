import puppeteer from 'puppeteer';
import { mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const screenshotDir = join(__dirname, 'temporary screenshots');
mkdirSync(screenshotDir, { recursive: true });

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] || '';

// Find next screenshot number
const existing = readdirSync(screenshotDir).filter(f => f.startsWith('screenshot-'));
const numbers = existing.map(f => parseInt(f.match(/screenshot-(\d+)/)?.[1] || '0'));
const next = numbers.length ? Math.max(...numbers) + 1 : 1;

const filename = label ? `screenshot-${next}-${label}.png` : `screenshot-${next}.png`;
const filepath = join(screenshotDir, filename);

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise(r => setTimeout(r, 1500)); // wait for hero animations

// Scroll through the page to trigger ScrollTrigger animations
await page.evaluate(async () => {
  const totalHeight = document.body.scrollHeight;
  const step = 400;
  for (let y = 0; y <= totalHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 100));
  }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 500));
});

await page.screenshot({ path: filepath, fullPage: true });
await browser.close();

console.log(`Screenshot saved: ${filepath}`);
