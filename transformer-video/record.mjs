import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, 'transformer.html');
const recordDir = resolve(__dirname, 'recording');
const outPath = resolve(__dirname, 'transformer-explainer.mp4');

if (!existsSync(recordDir)) mkdirSync(recordDir, { recursive: true });

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION_S = 65; // total animation ~64s + buffer

console.log('Launching browser...');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  recordVideo: { dir: recordDir, size: { width: WIDTH, height: HEIGHT } },
});

const tWebmStart = Date.now();

// Phase 2: freeze animations before page parses
await context.addInitScript(() => {
  const style = document.createElement('style');
  style.id = '__freeze';
  style.textContent =
    '*, *::before, *::after { animation-play-state: paused !important;' +
    ' -webkit-animation-play-state: paused !important; }';
  const attach = () => (document.head || document.documentElement).appendChild(style);
  if (document.head || document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
  window.__unfreeze = () => document.getElementById('__freeze')?.remove();
});

const page = await context.newPage();

// Phase 3: use domcontentloaded
console.log('Loading page...');
await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });

// Phase 4: wait for fonts, then release
await page.evaluate(() => new Promise((resolve) => {
  const doc = document;
  const fonts = doc.fonts;
  if (!fonts || typeof fonts.ready?.then !== 'function') { resolve(); return; }

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  };
  const cap = setTimeout(finish, 8000);

  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  const linkDone = links.map((link) => {
    try { if (link.sheet && link.sheet.cssRules) return Promise.resolve(); }
    catch { /* not ready */ }
    return new Promise((r) => {
      const done = () => r();
      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', done, { once: true });
      setTimeout(done, 6000);
    });
  });

  Promise.all(linkDone)
    .then(() => {
      const loads = [];
      fonts.forEach((face) => {
        try { loads.push(face.load().catch(() => undefined)); }
        catch { /* ignore */ }
      });
      return Promise.all(loads);
    })
    .then(() => fonts.ready)
    .then(() => { clearTimeout(cap); finish(); })
    .catch(() => { clearTimeout(cap); finish(); });
})).catch(() => {});

const leadInMs = Date.now() - tWebmStart;
console.log(`Font wait: ${leadInMs}ms lead-in`);

// Unfreeze animations
await page.evaluate(() => window.__unfreeze?.());
console.log('Recording started...');

// Wait for the animation to finish
await new Promise(r => setTimeout(r, DURATION_S * 1000));

console.log('Closing context...');
await context.close();

// Find the webm file
const { readdirSync } = await import('fs');
const files = readdirSync(recordDir).filter(f => f.endsWith('.webm'));
if (files.length === 0) {
  console.error('No webm file found!');
  process.exit(1);
}
const webmPath = resolve(recordDir, files[0]);

// Phase 5: encode with ffmpeg
const ss = Math.max(0, (leadInMs - 120) / 1000);
console.log(`Encoding with ffmpeg (trim ${ss.toFixed(2)}s lead-in)...`);

execSync(
  `ffmpeg -y -ss ${ss.toFixed(3)} -i "${webmPath}" ` +
  `-t ${DURATION_S} ` +
  `-r ${FPS} ` +
  `-c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 ` +
  `-movflags +faststart ` +
  `"${outPath}"`,
  { stdio: 'inherit' }
);

// Verify
const duration = execSync(
  `ffprobe -v error -show_entries format=duration -of csv=p=0 "${outPath}"`
).toString().trim();

console.log(`\nDone! Output: ${outPath}`);
console.log(`Duration: ${parseFloat(duration).toFixed(1)}s`);

await browser.close();
