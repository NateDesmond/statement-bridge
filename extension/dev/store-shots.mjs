// Store + site screenshot pass (LAUNCH.md task B), against the REAL unpacked
// extension in bundled headless Chromium only (playwright-core's own
// download, chromium.executablePath() - never channel:'chrome', never the
// user's browser). Pattern copied from dev/e2e-extension.mjs and
// dev/simple-shots.mjs. Only test/fixtures are used, never test/private.
//
// Writes 1280x800 PNGs to dev/shots/store-N.png, then this script's caller
// copies them into store/ and site/img/ (plus @2x via a 2560x1600 capture).
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-store-shots-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // --headless=new below is what actually goes headless (extensions require it)
    executablePath: chromium.executablePath(), // bundled Chromium only
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

// Injects a caption band for screenshot purposes only (never shipped in the
// extension itself) - a bottom strip in the Vault palette (ink-900 bg, brass
// rule, paper text) naming the one idea the shot demonstrates. Chrome Web
// Store screenshots convention: short caption band, one idea each.
async function addCaptionBand(page, text) {
  await page.evaluate((caption) => {
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
      'letter-spacing:0.1px',
    ].join(';');
    band.textContent = caption;
    document.body.appendChild(band);
  }, text);
}

async function shot(page, viewport, filePath, caption) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(150);
  if (caption) await addCaptionBand(page, caption);
  await page.waitForTimeout(80);
  await page.screenshot({ path: filePath, fullPage: false });
}

/** Writes one shot at 1280x800 (store/site) and its @2x (2560x1600) sibling. */
async function shotWithRetina(page, basePath, caption) {
  await shot(page, { width: 1280, height: 800 }, `${basePath}.png`, caption);
  await shot(page, { width: 2560, height: 1600 }, `${basePath}@2x.png`, caption);
}

async function main() {
  // ---- Shot 1: the drop area (empty state) ----
  {
    const { context, page, pageErrors } = await launchExtensionContext();
    await shotWithRetina(page, path.join(shotsDir, 'shot-1'),
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
    await shotWithRetina(page, path.join(shotsDir, 'shot-2'),
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
    await page.waitForTimeout(700); // let the async page-snippet crop finish rendering
    await shotWithRetina(page, path.join(shotsDir, 'shot-3'),
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
    await shotWithRetina(page, path.join(shotsDir, 'shot-4'),
      'Confirm the read before you copy anything.');
    const clean = await assertCleanLog(page, 'shot-4 confirm screen', pageErrors);
    await context.close();
    fs.rmSync(setupDir, { recursive: true, force: true });
    if (!clean.ok) throw new Error('shot-4: ' + clean.problems.join('; '));
  }

  console.log('done. shots in', shotsDir);
}

main().catch((err) => { console.error(err); process.exit(1); });
