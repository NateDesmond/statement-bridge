// Pass 2 / persona 2 (returning user, month two, three statements already
// set up) driver for audit/INDIE-STANDARD.md. Real unpacked extension,
// bundled Chromium only. Screenshots -> audit/pass2/returner-*.png at 1440.
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(__dirname, '..', '..', 'audit', 'pass2');
fs.mkdirSync(shotsDir, { recursive: true });

const CSV = path.join(fixturesDir, 'meridian_savings.csv'); // builtin-meridian-savings, auto-matches
const PDF_TEXT = path.join(fixturesDir, 'northwind_transaction_history_sample.pdf'); // builtin-northwind-transaction-history-pdf, auto-matches
const PDF_IMAGE = path.join(fixturesDir, 'northwind_transaction_history_image.pdf'); // same bank, image-only -> OCR then auto-matches
// Note: image.pdf's transactions overlap the text sample.pdf's (same synthetic
// bank/period in the fixture set - there is only one builtin PDF profile),
// so dropping all three together is also a real "accidental duplicate scan"
// scenario: dedupe should fold the overlap in with zero extra clicks.

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pass2-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: chromium.executablePath(),
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
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(shotsDir, `returner-${name}.png`), fullPage: true });
}

async function dropFile(page, fixturePathOrArr) {
  await page.$('#file-input').then((el) => el.setInputFiles(fixturePathOrArr));
}

async function waitAllHealthy(page, count, timeout = 60000) {
  await page.waitForFunction((n) => document.querySelectorAll('.file-row .badge-ok').length >= n, count, { timeout });
}

// #copy-tsv-btn has no `disabled` attribute in the base HTML (only home.js's
// renderReadiness() sets it, on the next tick after a drop) - checking
// !disabled alone races the very first paint and can pass before any file
// has even started reading. Gate on the export panel actually being shown
// AND the button enabled AND no row still reading.
function isCopyReady() {
  const btn = document.querySelector('#copy-tsv-btn');
  const panel = document.querySelector('#export-panel');
  const notDone = [...document.querySelectorAll('.file-row')].some((r) => /Reading|Needs confirmation|Waiting for|Set up/i.test(r.textContent));
  return !!(btn && panel && !panel.hidden && !btn.disabled && !notDone);
}
// Polls twice, 250ms apart, to rule out a transient single-frame state
// during dedupe/merge re-render (seen in practice: the predicate can
// momentarily read true mid-recompute, then a still-processing row repaints
// right back in on the very next frame).
async function waitCopyEnabled(page, timeout = 90000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await page.waitForFunction(isCopyReady, { timeout: Math.max(1000, deadline - Date.now()) });
    await page.waitForTimeout(250);
    if (await page.evaluate(isCopyReady)) return;
    if (Date.now() > deadline) throw new Error('waitCopyEnabled: never stayed ready');
  }
}

async function main() {
  const { context, page } = await launch();
  const log = [];
  const t0 = Date.now();
  try {
    // --- Seed: confirm all three fixtures auto-match a builtin profile with zero setup (that IS "already set up" for a builtin) ---
    console.log('Seeding: verifying the three fixtures auto-match builtin profiles with no wizard...');
    await dropFile(page, [CSV, PDF_TEXT, PDF_IMAGE]);
    await waitCopyEnabled(page, 90000);
    await shot(page, '00-seed-all-three-healthy');
    const setupClicksNeeded = await page.$('#attention-cards button:has-text("Set up")');
    const rowCount = await page.$$eval('.file-row', (els) => els.length);
    const seedBtnState = await page.$eval('#copy-tsv-btn', (b) => ({ disabled: b.disabled, cls: b.className })).catch(() => null);
    const seedBlockNote = await page.$eval('#export-blocked-note', (el) => el.textContent).catch(() => null);
    const seedRowTexts = await page.$$eval('.file-row', (els) => els.map((e) => e.innerText.replace(/\n/g, ' | ')));
    log.push(`Seed: builtin-matching fixtures reached Copy-ready with 0 wizard clicks (Set up button present: ${!!setupClicksNeeded}; ${rowCount} file row(s) shown - image.pdf's transactions overlap sample.pdf's in this fixture set, so it folds in as a duplicate rather than a 3rd distinct row).`);
    log.push(`Seed evidence: copy-tsv-btn=${JSON.stringify(seedBtnState)}, blockNote="${seedBlockNote}", rows=${JSON.stringify(seedRowTexts)}`);

    // --- Month two starts here: fresh reload, empty file list, profiles still known (builtins are baked in, not session state). ---
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#file-input', { state: 'attached' });
    await shot(page, '01-home-empty-month2');

    // --- Monthly path: drop all three, wait, copy. Count clicks + seconds. ---
    let clicks = 0;
    const monthlyStart = Date.now();
    console.log('Monthly path: dropping all three...');
    await dropFile(page, [CSV, PDF_TEXT, PDF_IMAGE]);
    await shot(page, '02-monthly-dropped');
    const dropSec = (Date.now() - monthlyStart) / 1000;
    await waitCopyEnabled(page, 90000);
    const readySec = (Date.now() - monthlyStart) / 1000;
    await shot(page, '03-monthly-ready');
    await page.click('#copy-tsv-btn');
    clicks += 1;
    const doneSec = (Date.now() - monthlyStart) / 1000;
    await shot(page, '04-monthly-copied');
    log.push(`Monthly path: drag-drop (1 action) + ${clicks} click (Copy). Files rendered in ${dropSec.toFixed(1)}s, all healthy/Copy enabled at ${readySec.toFixed(1)}s, copy done at ${doneSec.toFixed(1)}s. (headless timing, indicative)`);

    // --- Reset for edge cases ---
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#file-input', { state: 'attached' });

    // --- Case A: one file whose layout changed (renamed header column in a copy) ---
    const changedCsv = path.join(os.tmpdir(), 'meridian_savings_headerchanged.csv');
    {
      const raw = fs.readFileSync(CSV, 'utf8');
      const lines = raw.split(/\r?\n/);
      lines[0] = lines[0].replace(/^[^,]+/, 'Txn Date'); // rename first header ("Date" -> "Txn Date")
      fs.writeFileSync(changedCsv, lines.join('\n'));
    }
    console.log('Case A: layout-changed file...');
    await dropFile(page, changedCsv);
    await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, #attention-cards, .file-row .fr-line', { timeout: 30000 });
    await page.waitForTimeout(500);
    await shot(page, '05-case-a-layout-changed');

    // --- Case B: exact re-drop of an already-processed file ---
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#file-input', { state: 'attached' });
    console.log('Case B: exact re-drop...');
    await dropFile(page, CSV);
    await waitAllHealthy(page, 1);
    await shot(page, '06-case-b-first-drop');
    await dropFile(page, CSV);
    await page.waitForTimeout(1500);
    await shot(page, '07-case-b-redrop');

    // --- Case C: drop a second file while the first is still being read (OCR queue) ---
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#file-input', { state: 'attached' });
    console.log('Case C: concurrent drop while one is still reading...');
    await dropFile(page, PDF_IMAGE); // slow OCR path, stays "processing" for a while
    await page.waitForTimeout(400);
    await shot(page, '08-case-c-first-still-reading');
    await dropFile(page, CSV); // fast file, dropped mid-OCR of the first
    await page.waitForTimeout(600);
    await shot(page, '09-case-c-second-dropped-mid-read');
    const copyDisabledMidRead = await page.$eval('#copy-tsv-btn', (b) => b.disabled).catch(() => null);
    const blockNote = await page.$eval('#export-blocked-note', (el) => el.textContent).catch(() => null);
    log.push(`Case C: while first file still reading, Copy disabled=${copyDisabledMidRead}, note="${blockNote}"`);
    await waitCopyEnabled(page, 90000);
    await shot(page, '10-case-c-both-done');

    console.log('\n--- LOG ---');
    for (const l of log) console.log(l);
    fs.writeFileSync(path.join(shotsDir, 'run-log.txt'), log.join('\n') + '\n');
  } finally {
    await context.close();
  }
  console.log(`\nTotal wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
