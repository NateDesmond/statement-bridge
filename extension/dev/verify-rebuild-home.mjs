// REBUILD-HOME.md verification pass (2026-09-18): drops a CSV, a text PDF and
// an image-only PDF, walks Home top to bottom, opens the "Adjust what's
// exported" sheet, changes a layout, copies; then drops an unknown CSV and
// goes through setup. FULL-PAGE screenshots at 1440 and 1280 into
// dev/shots/verify-*.png. Bundled headless Chromium only, never the user's
// Chrome. Run with: node dev/verify-rebuild-home.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

let n = 0;
function nextName(label) { n += 1; return `verify-${String(n).padStart(2, '0')}-${label}`; }

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-verify-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: chromium.executablePath ? chromium.executablePath() : undefined,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/workspace.html`);
  await page.waitForSelector('#file-input', { state: 'attached' });
  return { context, page };
}

async function shotBoth(page, label) {
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shotsDir, `${nextName(label)}-${width}.png`), fullPage: true });
  }
}

// REBUILD-HOME.md's own verification section asks for dev/shots/sheet-*.png
// specifically: the "Adjust what's exported" sheet closed, open, after
// choosing a layout, and after customising, at 1440 and 1280 - a distinct
// naming from the sequential verify-NN-*.png shots above (whose numbering
// backs audit/DESIGN-JUDGE.md's per-screen references, so it stays untouched).
async function shotSheet(page, label) {
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shotsDir, `sheet-${label}-${width}.png`), fullPage: true });
  }
}

async function main() {
  const { context, page } = await launchExtensionContext();

  console.log('1. empty state...');
  await shotBoth(page, 'home-empty');

  console.log('2. drop CSV + text PDF + image PDF...');
  const input = await page.$('#file-input');
  await input.setInputFiles([
    path.join(fixturesDir, 'meridian_savings.csv'),
    path.join(fixturesDir, 'northwind_transaction_history_3p.pdf'),
    path.join(fixturesDir, 'northwind_transaction_history_image.pdf'),
  ]);
  await page.waitForTimeout(500);
  await shotBoth(page, 'home-processing');

  // Image-only PDF auto-starts OCR; wait for every row to reach a badge.
  for (let i = 0; i < 60; i++) {
    const done = await page.evaluate(() => {
      const rows = document.querySelectorAll('.file-row');
      return rows.length >= 3 && [...rows].every((r) => r.querySelector('.badge-ok, .badge-warn, .badge-low, .badge-danger'));
    });
    if (done) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(500);
  await shotBoth(page, 'home-ready');

  console.log('3. sheet closed, then open the sheet, change a layout, customise, copy...');
  await shotSheet(page, 'closed');

  await page.click('#change-link');
  await page.waitForSelector('#change-drawer:not([hidden])');
  await page.waitForTimeout(300);
  await shotBoth(page, 'home-drawer-open');
  await shotSheet(page, 'open');

  // Item 7: six layout radio cards replace the old dropdown - pick the
  // second one ("With account").
  const layoutCards = await page.$$('#home-preset-editor .layout-card');
  if (layoutCards.length > 1) {
    await layoutCards[1].click();
    await page.waitForTimeout(300);
  }
  await shotBoth(page, 'home-drawer-layout-changed');
  await shotSheet(page, 'layout-chosen');

  // Customise: open it and toggle on the first available pill that isn't
  // already enabled, so the "after customising" shot shows a real edit.
  await page.click('#home-preset-editor .columns-customise summary');
  await page.waitForTimeout(200);
  const disabledPill = await page.$('#home-preset-editor .column-pill:not(.enabled)');
  if (disabledPill) {
    await disabledPill.click();
    await page.waitForTimeout(300);
  }
  await shotSheet(page, 'customised');

  await page.click('#copy-tsv-btn');
  await page.waitForTimeout(300);
  await shotBoth(page, 'home-after-copy');

  console.log('4. drop an unknown CSV and go through setup...');
  const input2 = await page.$('#file-input');
  await input2.setInputFiles(path.join(fixturesDir, 'generic_unknown_bank.csv'));
  await page.waitForTimeout(800);
  await shotBoth(page, 'home-new-statement-card');

  const setupBtn = await page.$('button:has-text("Set up")');
  if (setupBtn) {
    await setupBtn.click();
    await page.waitForSelector('#screen-wizard.active', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);
    await shotBoth(page, 'wizard-confirm-a');
  }

  console.log('5. gear dropdown, report sheet, settings...');
  await page.goto(page.url()); // reset to a clean Home for chrome-shell shots
  await page.waitForSelector('#file-input', { state: 'attached' });
  await page.click('#gear-btn');
  await page.waitForSelector('#gear-overlay.open');
  await shotBoth(page, 'gear-dropdown');
  await page.click('#gear-overlay .dropdown-item[data-screen="settings"]');
  await page.waitForSelector('#screen-settings.active');
  await page.waitForTimeout(300);
  await shotBoth(page, 'settings');

  await page.click('#report-fab');
  await page.waitForSelector('#screen-report.open', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await shotBoth(page, 'report-sheet-over-settings');

  console.log('done, screenshots in', shotsDir);
  await context.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
