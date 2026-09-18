// E2E verification for "delete individual statements / clear all statements
// without clearing profiles". Loads the REAL unpacked
// extension into the bundled headless Chromium (never the user's Chrome,
// never channel:'chrome' - see dev/e2e-extension.mjs's module doc comment),
// against test/fixtures/ synthetics only.
//
// Run with: node dev/e2e-remove-statements.mjs
// Screenshots: dev/shots/remove-*.png - read them, don't just trust text.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';
import { gotoScreen, goBack, openGearMenu } from './lib/nav.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail !== undefined ? ` (${detail})` : ''}`);
  if (!ok) failures++;
  return ok;
}

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-remove-'));
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
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e); console.log('[pageerror]', e.message); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page, pageErrors };
}

async function dropAndSettle(page, fileName, { timeout = 60000 } = {}) {
  const filePath = path.join(fixturesDir, fileName);
  const input = await page.$('#file-input');
  const before = await page.$$eval('.file-row', (rows) => rows.length);
  await input.setInputFiles(filePath);
  await page.waitForFunction((n) => document.querySelectorAll('.file-row').length > n, before, { timeout: 15000 });
  await page.waitForFunction(
    (name) => {
      const row = [...document.querySelectorAll('.file-row')].find((r) => r.getAttribute('aria-label') === name);
      if (!row) return false;
      const fr = row.querySelector('.fr-line');
      if (fr && /Preparing|Waiting for text recognition|Reading page|Reading statement/.test(fr.textContent)) return false;
      return !!row.querySelector('.badge');
    },
    fileName,
    { timeout },
  );
}

async function readyToCopyText(page) {
  return page.$eval('#export-summary', (el) => el.textContent.trim()).catch(() => null);
}

async function main() {
  const { context, page, pageErrors } = await launchExtensionContext();
  try {
    console.log('1. drop three fixtures (meridian_savings, riverside_savings, summit_savings)...');
    await dropAndSettle(page, 'meridian_savings.csv');
    await dropAndSettle(page, 'riverside_savings.csv');
    await dropAndSettle(page, 'summit_savings.csv');
    const before = await readyToCopyText(page);
    console.log('   Ready to copy summary before removal:', before);
    await page.screenshot({ path: path.join(shotsDir, 'remove-01-three-dropped.png'), fullPage: false });
    check('three files show a healthy badge', (await page.$$eval('.file-row .badge-ok', (b) => b.length)) === 3, 'expected 3 badge-ok rows');

    console.log('2. remove the riverside_savings.csv row via its Remove button...');
    const ocbcRow = await page.$('.file-row[aria-label="riverside_savings.csv"]');
    await ocbcRow.hover();
    await ocbcRow.$('.remove-file-btn').then((b) => b.click());
    await page.waitForSelector('.file-row[aria-label="riverside_savings.csv"]', { state: 'detached', timeout: 5000 });
    const afterRemove = await readyToCopyText(page);
    console.log('   Ready to copy summary after removal:', afterRemove);
    await page.screenshot({ path: path.join(shotsDir, 'remove-02-after-remove.png'), fullPage: false });
    check('the removed file row is gone', (await page.$$eval('.file-row', (r) => r.length)) === 2, '2 rows left');
    check('Ready to copy count changed after removal', before !== afterRemove, `${before} -> ${afterRemove}`);
    const toastVisible = await page.$eval('#home-toast', (el) => !el.hidden && el.classList.contains('shown')).catch(() => false);
    const toastText = await page.$eval('#home-toast', (el) => el.textContent.trim()).catch(() => '');
    check('toast shows "Removed <file>. Undo"', toastVisible && /Removed riverside_savings\.csv/.test(toastText) && /Undo/.test(toastText), toastText);

    console.log('3. click Undo...');
    await page.click('#home-toast a:has-text("Undo")');
    await page.waitForSelector('.file-row[aria-label="riverside_savings.csv"]', { timeout: 5000 });
    const afterUndo = await readyToCopyText(page);
    console.log('   Ready to copy summary after undo:', afterUndo);
    await page.screenshot({ path: path.join(shotsDir, 'remove-03-after-undo.png'), fullPage: false });
    check('Ready to copy count restored after undo', afterUndo === before, `${before} vs ${afterUndo}`);
    check('undone row still shows a healthy badge', !!(await page.$('.file-row[aria-label="riverside_savings.csv"] .badge-ok')));

    console.log('4. drop the OCR fixture and remove it mid-OCR...');
    const imagePdf = path.join(fixturesDir, 'northwind_transaction_history_image.pdf');
    const beforeCount = await page.$$eval('.file-row', (r) => r.length);
    await page.$('#file-input').then((el) => el.setInputFiles(imagePdf));
    await page.waitForFunction((n) => document.querySelectorAll('.file-row').length > n, beforeCount, { timeout: 15000 });
    // Grab the row as soon as it exists - mid-read, before it can resolve.
    const ocrRowSel = '.file-row[aria-label="northwind_transaction_history_image.pdf"]';
    await page.waitForSelector(ocrRowSel, { timeout: 10000 });
    await page.hover(ocrRowSel).catch(() => {});
    const removed = await page.locator(`${ocrRowSel} .remove-file-btn`).click({ timeout: 3000 }).then(() => true).catch(() => false);
    check('clicked Remove on the file mid-OCR/mid-read', removed);
    await page.waitForSelector(ocrRowSel, { state: 'detached', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500); // let any in-flight OCR abort settle
    check('the mid-OCR file is gone from the list', !(await page.$(ocrRowSel)));
    await page.screenshot({ path: path.join(shotsDir, 'remove-04-mid-ocr-removed.png'), fullPage: false });
    check('removing mid-OCR produced no page errors', pageErrors.length === 0, `${pageErrors.length} error(s)`);

    console.log('5. Clear statements (gear menu tile)...');
    page.once('dialog', (d) => d.accept());
    await openGearMenu(page);
    await page.click('#tile-clear');
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 0, { timeout: 5000 });
    await page.screenshot({ path: path.join(shotsDir, 'remove-05-cleared.png'), fullPage: false });
    check('all statements removed from Home', (await page.$$eval('.file-row', (r) => r.length)) === 0);

    console.log('6. Statement types still listed after Clear statements...');
    await gotoScreen(page, 'profiles');
    const profileCount = await page.$$eval('#screen-profiles .bank-group', (els) => els.length).catch(() => -1);
    await page.screenshot({ path: path.join(shotsDir, 'remove-06-profiles-after-clear.png'), fullPage: false });
    check('Statement types screen still shows saved/built-in types after Clear statements', profileCount > 0, `found ${profileCount} statement-type-ish elements`);

    console.log('7. re-dropping meridian_savings.csv auto-matches after Clear statements...');
    await goBack(page);
    await dropAndSettle(page, 'meridian_savings.csv');
    const redroppedTone = await page.$eval('.file-row[aria-label="meridian_savings.csv"] .badge', (b) => [...b.classList].find((c) => c.startsWith('badge-'))).catch(() => null);
    check('a re-dropped file auto-matches its profile after Clear statements', redroppedTone === 'badge-ok', redroppedTone);
    await page.screenshot({ path: path.join(shotsDir, 'remove-07-redrop-after-clear.png'), fullPage: false });

    const clean = await assertCleanLog(page, 'remove-statements e2e', pageErrors);
    if (!clean.ok) failures++;
  } finally {
    await context.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
