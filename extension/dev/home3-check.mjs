// Verification for the Home v3 UX fix (auto-OCR, simplified attention cards,
// single-column card layout, "Edit export settings" expander + Mapping
// list). Screenshots only, driven through the real dev harness, never
// against production data. Requires the dev server running:
//   python3 -m http.server 8934 --directory extension   # from the repo root
//   node dev/home3-check.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.SB_DEV_PORT || 8934;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-home3-check-'));

const imagePdf = path.join(repoRoot, 'test', 'fixtures', 'northwind_transaction_history_image.pdf');
const chaseCsv = path.join(repoRoot, 'test', 'fixtures', 'anchor_checking.csv');
const dbsCsv = path.join(repoRoot, 'test', 'fixtures', 'meridian_savings_alt_header.csv');
const unknownCsv = path.join(scratch, 'unknown_bank.csv');
const dupeCsv = path.join(scratch, 'meridian_savings_dupe.csv');
fs.writeFileSync(unknownCsv, 'When,What,Value\n15/09/2026,Coffee Shop Purchase,-4.50\n14/09/2026,Grocery Store,-52.30\n');
fs.writeFileSync(dupeCsv, fs.readFileSync(path.join(repoRoot, 'test', 'fixtures', 'meridian_savings.csv'), 'utf8'));

// Bundled, headless Chromium: never the user's own installed Chrome (no
// "channel: 'chrome'"), so this never touches a real browser session.
const browser = await chromium.launch();

async function freshPage() {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.stack || e.message));
  await page.goto(`http://localhost:${PORT}/dev/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  // The harness fetches + document.write()s workspace.html, then its module
  // scripts run and wire up event listeners; #file-input existing in the DOM
  // doesn't yet mean home.js's 'change' listener is attached.
  await page.waitForSelector('#dropzone-full strong', { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
}

try {

// --- 1. Image-only PDF: auto-OCR, no card, no question --------------------
{
  const page = await freshPage();
  const input = await page.$('#file-input');
  await input.setInputFiles(imagePdf);

  console.log('1a. drop image-only PDF: expecting an immediate reading row, no "picture of a statement" card');
  await page.waitForSelector('.file-row', { timeout: 10000 });
  const hasOldCard = await page.$('text=This PDF is a picture of a statement');
  console.log('   old ask-first card present?', !!hasOldCard, '(must be false)');
  // Poll briefly to catch the OCR progress label before it resolves.
  let line1 = '';
  for (let i = 0; i < 40; i++) {
    line1 = (await page.textContent('.file-row .fr-line').catch(() => '')) || '';
    if (/recognition/.test(line1)) break;
    await page.waitForTimeout(150);
  }
  console.log('   file row caption:', line1.trim());
  await page.screenshot({ path: path.join(shotsDir, 'home3-01-ocr-reading.png'), fullPage: true });

  console.log('1b. waiting for OCR + match to resolve to a healthy row (up to 90s)...');
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 90000 });
  const badgeText = await page.textContent('.file-row .badge-ok, .file-row .badge-warn');
  const caption = await page.textContent('.file-row .fr-caption').catch(() => null);
  console.log('   healthy row badge:', badgeText.trim(), '| ocr caption:', caption);
  await page.screenshot({ path: path.join(shotsDir, 'home3-02-ocr-healthy.png'), fullPage: true });
  await page.context().close();
}

// --- 2. Cancel mid-OCR: "Reading cancelled" + "Read again" -----------------
{
  const page = await freshPage();
  const input = await page.$('#file-input');
  await input.setInputFiles(imagePdf);
  // Wait until OCR has actually started (not the generic "reading" row that
  // exists for any file type before OCR kicks in) before clicking Cancel,
  // otherwise it hits the generic processing-row Cancel (which removes the
  // file outright) instead of OCR's own cancel path.
  let started = false;
  for (let i = 0; i < 150 && !started; i++) {
    const line = (await page.textContent('.file-row .fr-line').catch(() => '')) || '';
    if (/recognition/.test(line)) { started = true; break; }
    if (await page.$('.file-row .badge-ok, .file-row .badge-warn')) break; // already resolved, too fast to catch
    await page.waitForTimeout(20);
  }
  let cancelled = false;
  if (started) {
    // A locator re-queries at click time instead of clicking a possibly
    // stale handle from a row that's re-rendered since (progress ticks
    // replace the row's innerHTML on every update).
    await page.locator('.file-row .icon-btn:has-text("Cancel")').click({ timeout: 3000 }).catch(() => {});
    cancelled = true;
  }
  console.log('   OCR started before cancel click:', started, '| clicked Cancel:', cancelled);
  const outcome = await Promise.race([
    page.waitForSelector('.file-row .fr-line:has-text("Reading cancelled")', { timeout: 20000 }).then(() => 'cancelled'),
    page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 20000 }).then(() => 'resolved-anyway'),
  ]).catch(() => 'neither');
  console.log('2. OCR cancel outcome:', outcome, outcome === 'resolved-too-fast' ? '(fixture too small/fast to interrupt, not a bug)' : '');
  await page.screenshot({ path: path.join(shotsDir, 'home3-03-ocr-cancelled.png'), fullPage: true });
  await page.context().close();
}

// --- 3. "new" card: unrecognised CSV ---------------------------------------
{
  const page = await freshPage();
  const input = await page.$('#file-input');
  await input.setInputFiles(unknownCsv);
  await page.waitForSelector('.file-card:has-text("New statement type")', { timeout: 10000 });
  console.log('3. "new" card shown for an unrecognised CSV');
  await page.screenshot({ path: path.join(shotsDir, 'home3-04-card-new.png'), fullPage: true });
  await page.context().close();
}

// --- 4. "warnings" card: duplicate row --------------------------------------
{
  const page = await freshPage();
  const input = await page.$('#file-input');
  await input.setInputFiles(dupeCsv);
  await page.waitForSelector('.file-card:has-text("a look")', { timeout: 10000 });
  console.log('4. "warnings" card shown for a duplicate-row file');
  await page.screenshot({ path: path.join(shotsDir, 'home3-05-card-warnings.png'), fullPage: true });
  await page.context().close();
}

// --- 5. "lowConfidence" card + "missingRate" card + expander/drawer --------
{
  const page = await freshPage();
  const input = await page.$('#file-input');
  await input.setInputFiles(chaseCsv);
  // Anchor Bank checking matches at 70% confidence, below the auto-apply threshold.
  await page.waitForSelector('.file-card:has-text("Confirm statement type")', { timeout: 10000 });
  console.log('5a. "lowConfidence" card shown for a 70%-confidence match');
  await page.screenshot({ path: path.join(shotsDir, 'home3-06-card-lowconfidence.png'), fullPage: true });
  await page.click('.file-card button:has-text("Confirm")');
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 15000 });

  const expandedBefore = await page.getAttribute('#change-link', 'aria-expanded');
  console.log('   expander aria-expanded before open:', expandedBefore);
  await page.click('#change-link');
  await page.waitForSelector('#change-drawer:not([hidden])', { timeout: 5000 });
  const expandedAfter = await page.getAttribute('#change-link', 'aria-expanded');
  console.log('   expander aria-expanded after open:', expandedAfter);
  await page.click('#currency-mode-b');
  await page.waitForSelector('.file-card:has-text("Missing exchange rate")', { timeout: 10000 });
  console.log('5b. "missingRate" card shown after switching to currency mode B with no saved rate');
  const mappingText = await page.textContent('#drawer-mapping-list');
  console.log('   drawer Mapping list:', mappingText.replace(/\s+/g, ' ').trim());
  await page.locator('.file-card:has-text("Missing exchange rate")').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shotsDir, 'home3-07a-card-missingrate.png') });
  await page.locator('#drawer-mapping-list').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shotsDir, 'home3-07b-drawer-mapping-section.png') });
  await page.context().close();
}

// --- 6. Mapping list: "Update mapping" reopens the wizard -----------------
{
  const page = await freshPage();
  const input = await page.$('#file-input');
  await input.setInputFiles(dbsCsv);
  // meridian_savings_alt_header.csv matches at 78% confidence, below the auto-apply threshold.
  await page.waitForSelector('.file-card:has-text("Confirm statement type")', { timeout: 10000 });
  await page.click('.file-card button:has-text("Confirm")');
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 15000 });
  await page.click('#change-link');
  await page.waitForSelector('#drawer-mapping-list .mapping-row', { timeout: 5000 });
  await page.click('#drawer-mapping-list a:has-text("Update mapping")');
  await page.waitForSelector('#screen-wizard.active, #screen-home:not(.active)', { timeout: 5000 }).catch(() => {});
  const wizardActive = await page.evaluate(() => document.querySelector('#screen-wizard')?.classList.contains('active'));
  console.log('6. Mapping list "Update mapping" opened the wizard:', wizardActive);
  await page.screenshot({ path: path.join(shotsDir, 'home3-08-mapping-update-wizard.png'), fullPage: true });
  await page.context().close();
}

console.log('DONE');
} finally {
  // Always close, even on a failed assertion above, so a broken run never
  // leaves an orphaned isolated Chromium process behind.
  await browser.close();
}
