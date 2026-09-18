// Store + site screenshot pass (LAUNCH.md task B), against the REAL unpacked
// extension in bundled headless Chromium only (playwright-core's own
// download, chromium.executablePath() - never channel:'chrome', never the
// user's browser). Pattern copied from dev/e2e-extension.mjs and
// dev/simple-shots.mjs. Only test/fixtures are used, never test/private.
//
// Tight-on-the-product shots (owner requirement 2026-09-18): capture at
// 1100x720 @2x, then clip to the actual content card's bounding box (see
// lib/shot-crop.mjs) instead of the whole viewport, so there's no empty page
// background or huge dark header band. Writes:
//   - site/img/shot-N@2x.png (the crop, full 2x resolution)
//   - site/img/shot-N.png (the same crop downscaled to 1x, via sips)
//   - store/shot-N.png (1280x800 with a caption band, product scaled to
//     fill the band width - see composeStoreShot)
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';
import { shotCardCrop, composeStoreShot } from './lib/shot-crop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(__dirname, 'shots');
const siteImgDir = path.join(__dirname, '..', '..', 'site', 'img');
const storeDir = path.join(__dirname, '..', '..', 'store');
fs.mkdirSync(shotsDir, { recursive: true });

const VIEWPORT = { width: 1100, height: 720 };

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-store-shots-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // --headless=new below is what actually goes headless (extensions require it)
    executablePath: chromium.executablePath(), // bundled Chromium only
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e); console.log('[pageerror]', e.message); });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page, pageErrors };
}

function sipsPixelSize(filePath) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath], { encoding: 'utf8' });
  const width = Number(out.match(/pixelWidth:\s*(\d+)/)[1]);
  const height = Number(out.match(/pixelHeight:\s*(\d+)/)[1]);
  return { width, height };
}

/** Writes site img (@2x + downscaled 1x) and the composited store/shot-N.png for one card. */
async function writeShotSet(context, page, selector, name, caption) {
  const crop2xPath = path.join(shotsDir, `${name}@2x.png`);
  await shotCardCrop(page, selector, crop2xPath);
  fs.copyFileSync(crop2xPath, path.join(siteImgDir, `${name}@2x.png`));

  const shot1xPath = path.join(siteImgDir, `${name}.png`);
  const { width, height } = sipsPixelSize(crop2xPath);
  fs.copyFileSync(crop2xPath, shot1xPath);
  execFileSync('sips', ['--resampleWidth', String(Math.round(width / 2)), shot1xPath]);

  const cropBuffer = fs.readFileSync(crop2xPath);
  await composeStoreShot(context, cropBuffer, path.join(storeDir, `${name}.png`), caption);
}

async function main() {
  // ---- Shot 1: the drop area (empty state) ----
  {
    const { context, page, pageErrors } = await launchExtensionContext();
    await writeShotSet(context, page, '#dropzone-full', 'shot-1',
      'Drop your bank statement. Nothing leaves your computer.');
    const clean = await assertCleanLog(page, 'shot-1 drop area', pageErrors);
    await context.close();
    if (!clean.ok) throw new Error('shot-1: ' + clean.problems.join('; '));
  }

  // ---- Shot 2: result card with Copy to Google Sheets ----
  {
    const { context, page, pageErrors } = await launchExtensionContext();
    await page.$('#file-input').then((el) => el.setInputFiles(path.join(fixturesDir, 'meridian_savings.csv')));
    await page.waitForSelector('.file-row .badge-ok', { timeout: 15000 });
    await page.waitForSelector('#export-panel:not([hidden])', { timeout: 5000 });
    // The result table's body is a "live" preset-editor.js preview: it
    // renders with an empty tbody first, then fills in after a 100ms
    // debounce (PREVIEW_DEBOUNCE_MS in preset-editor.js). Wait for the real
    // rows (5, from meridian_savings.csv) instead of a fixed timeout.
    await page.waitForFunction(
      () => document.querySelectorAll('#result-table tbody tr').length >= 5,
      { timeout: 5000 },
    );
    await writeShotSet(context, page, '#export-panel', 'shot-2',
      'Copy your transactions straight into Google Sheets.');
    const clean = await assertCleanLog(page, 'shot-2 result card', pageErrors);
    await context.close();
    if (!clean.ok) throw new Error('shot-2: ' + clean.problems.join('; '));
  }

  // ---- Shot 3: quick look decision card with a page snippet ----
  {
    const { context, page, pageErrors } = await launchExtensionContext();
    await page.$('#file-input').then((el) => el.setInputFiles(path.join(fixturesDir, 'northwind_transaction_history_flags.pdf')));
    await page.waitForSelector('.decision-row', { timeout: 20000 });
    // The page-snippet crop (loadDecisionSnippet in home.js) starts as a
    // "Loading..." placeholder and swaps in a <canvas> once the async PDF
    // crop finishes. Wait for the real canvas instead of a fixed timeout.
    await page.waitForFunction(
      () => document.querySelector('.decision-row .decision-snippet canvas'),
      { timeout: 10000 },
    );
    await writeShotSet(context, page, '.decision-row', 'shot-3',
      'A quick look at anything unclear, right next to the page it came from.');
    const clean = await assertCleanLog(page, 'shot-3 decision card', pageErrors);
    await context.close();
    if (!clean.ok) throw new Error('shot-3: ' + clean.problems.join('; '));
  }

  // ---- Shot 4: confirm-first "Does this look right?" screen ----
  {
    const { context, page, pageErrors } = await launchExtensionContext();
    const setupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-shots-setup-'));
    const setupCsvPath = path.join(setupDir, 'newbank_savings.csv');
    fs.writeFileSync(setupCsvPath, [
      'Newbank Pte Ltd',
      'Account: 555-1234',
      '',
      'Date,Description,Amount',
      '01/09/2026,Coffee Shop Purchase,-4.50',
      '03/09/2026,Grocery Store,-52.30',
      '10/09/2026,Salary Payout,3000.00',
      '18/09/2026,Utility Bill,-88.20',
      '20/09/2026,Refund,15.00',
      '',
    ].join('\n'));
    await page.$('#file-input').then((el) => el.setInputFiles(setupCsvPath));
    await page.waitForSelector('#attention-cards button:has-text("Set up")', { timeout: 15000 });
    await page.click('#attention-cards button:has-text("Set up")');
    await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
    await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 10000 });
    // renderConfirmA() writes the preview table synchronously, but wait for
    // its rows explicitly anyway (defensive, matches the other async shots)
    // rather than assuming render order.
    await page.waitForFunction(
      () => document.querySelectorAll('#confirm-a-preview tbody tr').length >= 5,
      { timeout: 5000 },
    );
    await writeShotSet(context, page, '#confirm-a', 'shot-4',
      'Confirm the read before you copy anything.');
    const clean = await assertCleanLog(page, 'shot-4 confirm screen', pageErrors);
    await context.close();
    fs.rmSync(setupDir, { recursive: true, force: true });
    if (!clean.ok) throw new Error('shot-4: ' + clean.problems.join('; '));
  }

  console.log('done. shots in', shotsDir, 'site img in', siteImgDir, 'store in', storeDir);
}

main().catch((err) => { console.error(err); process.exit(1); });
