/**
 * Demo GIF recorder for Org Studio (optimized version)
 * Captures at reduced resolution for smaller file size.
 *
 * Usage: node scripts/record-demo.mjs [port]
 */

import puppeteer from 'puppeteer-core';
import GIFEncoder from 'gif-encoder-2';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, '..', 'docs', 'images', 'demo.gif');
const WIDTH = 960;
const HEIGHT = 540;
const FRAME_DELAY = 500; // ms per frame — slightly slower for readability

const PORT = process.argv[2] || '4503';
const BASE = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function captureFrame(page) {
  const buf = await page.screenshot({ type: 'png', encoding: 'binary' });
  const png = PNG.sync.read(buf);
  return png.data;
}

async function hold(page, frames, encoder) {
  const data = await captureFrame(page);
  for (let i = 0; i < frames; i++) encoder.addFrame(data);
}

async function main() {
  mkdirSync(join(__dirname, '..', 'docs', 'images'), { recursive: true });
  console.log('🎬 Launching browser...');

  const browser = await puppeteer.launch({
    executablePath: '/opt/google/chrome/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('theme', 'dark');
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
  });

  const encoder = new GIFEncoder(WIDTH, HEIGHT, 'octree', false); // octree = faster, less colors
  encoder.setDelay(FRAME_DELAY);
  encoder.setRepeat(0);
  encoder.setQuality(20); // lower quality = smaller file
  encoder.start();

  let totalFrames = 0;

  async function scene(label, url, holdSec, actions) {
    console.log(`  📸 ${label}`);
    if (url) {
      await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle0', timeout: 15000 });
      await page.evaluate(() => {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.remove('light');
      });
      await sleep(500);
    }
    if (actions) await actions();
    const frames = Math.ceil(holdSec * (1000 / FRAME_DELAY));
    await hold(page, frames, encoder);
    totalFrames += frames;
  }

  // === SCENES (tighter, ~25s total) ===

  await scene('Dashboard', '/', 2.5);

  await scene('Team — force graph', '/team', 3.5);

  await scene('Team — cards & values', null, 3, async () => {
    await page.evaluate(() => window.scrollTo({ top: 450, behavior: 'smooth' }));
    await sleep(500);
  });

  await scene('Teammate detail panel', null, 3, async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(300);
    const cards = await page.$$('[class*="cursor-pointer"]');
    if (cards.length > 2) { await cards[2].click(); await sleep(700); }
  });

  await scene('Task board', '/context', 3.5);

  await scene('Projects', '/vision', 2.5);

  await scene('Scheduler', '/scheduler', 3);

  await scene('Dashboard (end)', '/', 2);

  // === FINISH ===
  encoder.finish();
  const gifBuffer = encoder.out.getData();
  writeFileSync(OUTPUT, gifBuffer);

  const sizeMB = (gifBuffer.length / 1024 / 1024).toFixed(1);
  console.log(`\n✅ Demo GIF: ${OUTPUT}`);
  console.log(`   ${totalFrames} frames, ${sizeMB}MB`);

  await browser.close();
  console.log('🎬 Done!');
}

main().catch(err => { console.error('❌', err); process.exit(1); });
