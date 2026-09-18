// Shot 5 (pasted result in a spreadsheet-style grid) plus the two promo
// images, from static local HTML - no extension load needed for these, so
// plain playwright-core against a local file:// page is enough. Same
// bundled-Chromium rule as store-shots.mjs (never channel:'chrome').
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(__dirname, '..', '..', 'site');
const storeDir = path.join(__dirname, '..', '..', 'store');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

async function shotBand(page, filePath, viewport, caption) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(80);
  if (caption) {
    await page.evaluate((text) => {
      const old = document.getElementById('__shot_caption_band');
      if (old) old.remove();
      const band = document.createElement('div');
      band.id = '__shot_caption_band';
      band.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'height:84px',
        'background:#0d1a17', 'border-top:3px solid #c6a15b',
        'display:flex', 'align-items:center', 'justify-content:center',
        'padding:0 48px', 'z-index:2147483647',
        'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif',
        'font-size:22px', 'font-weight:600', 'color:#f3efe6', 'text-align:center',
      ].join(';');
      band.textContent = text;
      document.body.appendChild(band);
    }, caption);
  }
  await page.waitForTimeout(60);
  await page.screenshot({ path: filePath, fullPage: false });
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const page = await browser.newPage();

  // ---- Shot 5: pasted result in the mock Sheets-style grid ----
  await page.goto(pathToFileURL(path.join(siteDir, 'mock-sheets.html')).href);
  await shotBand(page, path.join(shotsDir, 'shot-5.png'), { width: 1280, height: 800 },
    'Paste once. Your columns land exactly where you expect.');
  await shotBand(page, path.join(shotsDir, 'shot-5@2x.png'), { width: 2560, height: 1600 },
    'Paste once. Your columns land exactly where you expect.');

  // ---- Promo images: logo + solid Vault colours ----
  const logoPath = path.join(__dirname, '..', '..', 'designs', 'logos', 'logo-final.png');
  const logoDataUri = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');

  const promoHtml = (w, h, logoSize, fontSize, showTagline) => `<!doctype html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:${w}px;height:${h}px;background:#0d1a17;display:flex;align-items:center;justify-content:center;
      font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;overflow:hidden;position:relative;}
    body::before{content:"";position:absolute;inset:0;background:linear-gradient(135deg,#132420 0%,#0d1a17 70%);}
    .row{position:relative;display:flex;align-items:center;gap:${Math.round(logoSize * 0.4)}px;}
    img{width:${logoSize}px;height:${logoSize}px;border-radius:${Math.round(logoSize * 0.12)}px;}
    .text{color:#f3efe6;}
    .name{font-size:${fontSize}px;font-weight:700;letter-spacing:0.2px;}
    .tag{margin-top:6px;font-size:${Math.round(fontSize * 0.42)}px;color:#c6a15b;font-weight:600;}
    </style></head><body>
      <div class="row">
        <img src="${logoDataUri}">
        <div class="text">
          <div class="name">Statement Bridge</div>
          ${showTagline ? '<div class="tag">Your bank statements, in your spreadsheet.</div>' : ''}
        </div>
      </div>
    </body></html>`;

  // promo-small.png 440x280
  const smallPath = path.join(shotsDir, 'promo-small.html');
  fs.writeFileSync(smallPath, promoHtml(440, 280, 96, 30, true));
  await page.goto(pathToFileURL(smallPath).href);
  await page.setViewportSize({ width: 440, height: 280 });
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(storeDir, 'promo-small.png') });

  // promo-marquee.png 1400x560
  const marqueePath = path.join(shotsDir, 'promo-marquee.html');
  fs.writeFileSync(marqueePath, promoHtml(1400, 560, 180, 54, true));
  await page.goto(pathToFileURL(marqueePath).href);
  await page.setViewportSize({ width: 1400, height: 560 });
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(storeDir, 'promo-marquee.png') });

  await browser.close();
  console.log('done: shot-5 + promo images written');
}

main().catch((err) => { console.error(err); process.exit(1); });
