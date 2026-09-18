// Shot 5 (pasted result in a spreadsheet-style grid) plus the two promo
// images, from static local HTML - no extension load needed for these, so
// plain playwright-core against a local file:// page is enough. Same
// bundled-Chromium rule as store-shots.mjs (never channel:'chrome').
//
// Tight-on-the-product crop (owner requirement 2026-09-18): shot-5 clips to
// the pasted grid region (.grid-wrap) plus a small margin instead of the
// whole 1280x800 mock page, so the drop shot shows the drop area filling the
// frame - see lib/shot-crop.mjs for the shared crop/compose helpers.
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shotUnionCrop, composeStoreShot } from './lib/shot-crop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(__dirname, '..', '..', 'site');
const siteImgDir = path.join(siteDir, 'img');
const storeDir = path.join(__dirname, '..', '..', 'store');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

function sipsPixelSize(filePath) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath], { encoding: 'utf8' });
  return { width: Number(out.match(/pixelWidth:\s*(\d+)/)[1]) };
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const caption = 'Paste once. Your columns land exactly where you expect.';

  // ---- Shot 5: pasted result in the mock Sheets-style grid, cropped tight ----
  await page.goto(pathToFileURL(path.join(siteDir, 'mock-sheets.html')).href);
  await page.waitForTimeout(80);
  const crop2xPath = path.join(shotsDir, 'shot-5@2x.png');
  // Union of just the .pasted cells (not .toast, which sits near the
  // bottom of the whole 800px mock body and would drag the crop down
  // through a dozen empty rows).
  await shotUnionCrop(page, '.pasted', crop2xPath);
  fs.copyFileSync(crop2xPath, path.join(siteImgDir, 'shot-5@2x.png'));
  const shot1xPath = path.join(siteImgDir, 'shot-5.png');
  const { width } = sipsPixelSize(crop2xPath);
  fs.copyFileSync(crop2xPath, shot1xPath);
  execFileSync('sips', ['--resampleWidth', String(Math.round(width / 2)), shot1xPath]);
  const cropBuffer = fs.readFileSync(crop2xPath);
  await composeStoreShot(context, cropBuffer, path.join(storeDir, 'shot-5.png'), caption);

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
