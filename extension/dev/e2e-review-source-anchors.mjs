// Verifies Section B item 1 (row-click page jump + outline using real
// source_page/source_y from extraction) and item 3 (completion panel) against
// the REAL unpacked extension - bundled Chromium only, never the user's Chrome.
//
// Run with: cd extension && node dev/e2e-review-source-anchors.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gotoScreen } from './lib/nav.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(extensionPath, '..', 'audit', 'fix-shots');
fs.mkdirSync(shotsDir, { recursive: true });

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

async function newContext() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-anchors-'));
  return chromium.launchPersistentContext(tmpDir, {
    headless: false, // MV3 service worker needs a real (bundled Chromium) window context
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function openWorkspace(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`chrome-extension://${extId}/workspace.html`);
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return page;
}

// --- Scenario 1: 3-page real-text fixture: click a row -> jump to its own
// page (2 or 3) and outline the exact line, using extraction's own
// source_page/source_y, not a best-effort re-derivation. ------------------
async function run3PageFixture() {
  console.log('\n=== scenario: 3-page text fixture, page jump + outline ===');
  const context = await newContext();
  try {
    const page = await openWorkspace(context);
    const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_3p.pdf');
    await (await page.$('#file-input')).setInputFiles(fixture);
    await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, button:has-text("Map this statement")', { timeout: 30000 });
    const mapBtn = await page.$('button:has-text("Map this statement")');
    if (mapBtn) {
      console.log('   (no auto-match - mapping once via the wizard)');
      await mapBtn.click();
      await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
      for (let i = 0; i < 4; i++) { await page.click('#wizard-next'); await page.waitForTimeout(400); }
      await page.waitForTimeout(800);
    }
    await gotoScreen(page, 'review');
    await page.waitForSelector('#review-body:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(600);

    const rowCount = await page.$$eval('#review-table tbody tr', (trs) => trs.length);
    check('3-page fixture produced multiple rows to click through', rowCount > 1, `rows=${rowCount}`);

    // Click through rows in order, watching for one that lands on page 2 and
    // one that lands on page 3 (real grouped-layout statements spread transactions
    // across all 3 pages, so a handful of clicks should hit both).
    const seenPages = new Set();
    const total = Math.min(rowCount, 20);
    for (let i = 0; i < total && (!seenPages.has(2) || !seenPages.has(3)); i++) {
      await page.click(`#review-table tbody tr:nth-child(${i + 1})`);
      await page.waitForTimeout(300);
      const pageLabel = await page.$eval('#pdf-page-label', (el) => el.textContent.trim()).catch(() => '');
      const pageNum = Number((pageLabel.match(/^(\d+)\//) || [])[1]);
      if (pageNum) seenPages.add(pageNum);
      const outlinedCount = await page.$$eval('#source-pdf-scroll .anchor-row-highlight.outlined', (els) => els.length);
      if (pageNum === 2 && outlinedCount > 0 && !seenPages.has('shot2')) {
        seenPages.add('shot2');
        await page.screenshot({ path: path.join(shotsDir, 'B4-3page-row-page2-outlined.png'), fullPage: true });
      }
      if (pageNum === 3 && outlinedCount > 0 && !seenPages.has('shot3')) {
        seenPages.add('shot3');
        await page.screenshot({ path: path.join(shotsDir, 'B4-3page-row-page3-outlined.png'), fullPage: true });
      }
    }
    check('a clicked row landed on page 2 of the source pane', seenPages.has(2), `pages seen: ${[...seenPages].filter((v) => typeof v === 'number')}`);
    check('a clicked row landed on page 3 of the source pane', seenPages.has(3), `pages seen: ${[...seenPages].filter((v) => typeof v === 'number')}`);

    // Keyboard: Up/Down moves selection and the page follows (item 1).
    await page.click('#review-table tbody tr:first-child');
    await page.waitForTimeout(200);
    const beforeSel = await page.$eval('#review-table tbody tr.selected', (tr) => tr.dataset.rowId).catch(() => null);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    const afterSel = await page.$eval('#review-table tbody tr.selected', (tr) => tr.dataset.rowId).catch(() => null);
    check('ArrowDown moves the selected row (keyboard nav wired)', !!beforeSel && !!afterSel && beforeSel !== afterSel, `${beforeSel} -> ${afterSel}`);
  } finally {
    await context.close();
  }
}

// --- Scenario 2: OCR fixture (single page): outline uses OCR-derived
// source_page/source_y, not a best-effort re-derivation. ------------------
async function runOcrFixture() {
  console.log('\n=== scenario: OCR fixture, outline from real extraction position ===');
  const context = await newContext();
  try {
    const page = await openWorkspace(context);
    const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_image.pdf');
    await (await page.$('#file-input')).setInputFiles(fixture);
    await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, button:has-text("Read it with on-device text recognition")', { timeout: 30000 });
    const ocrBtn = await page.$('button:has-text("Read it with on-device text recognition")');
    if (ocrBtn) {
      await ocrBtn.click();
      await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 60000 });
    }
    await page.waitForTimeout(500);
    await gotoScreen(page, 'review');
    await page.waitForSelector('#review-body:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(600);

    await page.click('#review-table tbody tr:nth-child(2)'); // not the first row, so a real jump is exercised
    await page.waitForTimeout(400);
    const outlinedCount = await page.$$eval('#source-pdf-scroll .anchor-row-highlight.outlined', (els) => els.length);
    check('clicking an OCR-extracted row outlines a line in the source pane', outlinedCount > 0, `outlined=${outlinedCount}`);
    await page.screenshot({ path: path.join(shotsDir, 'B4-ocr-row-outlined.png'), fullPage: true });
  } finally {
    await context.close();
  }
}

// --- Scenario 3: flags fixture - resolve every warning, check the
// completion panel (item 3). ----------------------------------------------
async function runFlagsFixtureCompletion() {
  console.log('\n=== scenario: flags fixture, completion panel after resolving all warnings ===');
  const context = await newContext();
  try {
    const page = await openWorkspace(context);
    const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_flags.pdf');
    await (await page.$('#file-input')).setInputFiles(fixture);
    await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, button:has-text("Read it with on-device text recognition"), button:has-text("Map this statement")', { timeout: 30000 });
    const ocrBtn = await page.$('button:has-text("Read it with on-device text recognition")');
    if (ocrBtn) {
      await ocrBtn.click();
      await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, button:has-text("Map this statement")', { timeout: 60000 });
    }
    const mapBtn = await page.$('button:has-text("Map this statement")');
    if (mapBtn) {
      console.log('   (no auto-match - mapping once via the wizard)');
      await mapBtn.click();
      await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
      for (let i = 0; i < 4; i++) { await page.click('#wizard-next'); await page.waitForTimeout(400); }
      await page.waitForTimeout(800);
    }
    await gotoScreen(page, 'review');
    await page.waitForSelector('#review-body:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(600);

    await page.click('#review-warnings-filter');
    await page.waitForTimeout(300);
    const chipDisabled = await page.$eval('#review-warnings-filter', (el) => el.disabled);
    if (chipDisabled) {
      console.log('   (info) fixture had no warnings at all - completion panel should already show)');
    } else {
      // Resolve every warning row by clicking "Looks right" until none
      // remain - falling back to "Exclude" for a row whose date/amount
      // never actually parsed (Pass 3 item 2: those never offer "Looks
      // right" at all, only Edit/Exclude - this fixture has one).
      for (let i = 0; i < 50; i++) {
        const looksRight = await page.$('#review-table tbody tr:first-child button:has-text("Looks right")');
        if (looksRight) { await looksRight.click(); await page.waitForTimeout(120); continue; }
        const exclude = await page.$('#review-table tbody tr:first-child button:has-text("Exclude")');
        if (exclude) { await exclude.click(); await page.waitForTimeout(120); continue; }
        break;
      }
    }
    await page.waitForTimeout(300);
    const remaining = await page.$eval('#review-warnings-filter', (el) => el.textContent.trim());
    check('all quick looks resolved (Quick look (0))', remaining === 'Quick look (0)', remaining);

    // Item 6c: with only ONE statement in this session, resolving its last
    // warning goes straight to the calm "all done" screen (#review-all-done)
    // rather than the "#review-complete" per-file panel, which only ever
    // shows when there's a NEXT statement still waiting - see review.js's
    // renderCompletion doc comment.
    const allDoneVisible = await page.$eval('#review-all-done', (el) => !el.hidden).catch(() => false);
    check('the calm all-done screen shows once every quick look is resolved', allDoneVisible);
    const allDoneHomeVisible = await page.$eval('#review-all-done-home', (el) => !el.hidden).catch(() => false);
    check('all-done screen offers "Back to Home to copy"', allDoneHomeVisible);
    const allDoneAddVisible = await page.$eval('#review-all-done-add', (el) => !el.hidden).catch(() => false);
    check('all-done screen always offers "Add a statement"', allDoneAddVisible);

    await page.screenshot({ path: path.join(shotsDir, 'B4-flags-completion-panel.png'), fullPage: true });
  } finally {
    await context.close();
  }
}

async function main() {
  await run3PageFixture();
  await runOcrFixture();
  await runFlagsFixtureCompletion();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
