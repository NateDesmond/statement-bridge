// End-to-end OCR check driven through the real dev harness UI (not just
// module calls): drop the synthetic image-only PDF fixture, click through
// the OCR card, confirm the matched profile + healthy badge, check Review,
// then Copy for Sheets. Screenshots only ever come from the synthetic
// fixture (test/fixtures/northwind_transaction_history_image.pdf), never a real
// file. Requires the dev server running:
//   python3 -m http.server 8934 --directory extension   # from the repo root
//   node dev/ocr-e2e-check.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.SB_DEV_PORT || 8934;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', 'test', 'fixtures', 'northwind_transaction_history_image.pdf');
const shotsDir = path.join(__dirname, 'shots');

// Bundled, headless Chromium: never the user's own installed Chrome (no
// "channel: 'chrome'"), so this never touches a real browser session.
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(`http://localhost:${PORT}/dev/index.html`, { waitUntil: 'load' });
  // Reset settings + sessions first in case this script has run before
  // against a reused browser profile directory (README's documented
  // dev-harness reset, see "Dev harness" section).
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => { const req = indexedDB.deleteDatabase('statement-bridge'); req.onsuccess = resolve; req.onerror = resolve; req.onblocked = resolve; });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });

  const input = await page.$('#file-input');
  await input.setInputFiles(fixture);

  console.log('1. drop: waiting for image-only card...');
  await page.waitForSelector('.file-card:has-text("This PDF is a picture of a statement")', { timeout: 15000 });
  await page.screenshot({ path: path.join(shotsDir, 'ocr-01-image-only-card.png'), fullPage: true });
  console.log('   OK - image-only card shown');

  console.log('2. click "Read it with on-device text recognition"...');
  await page.click('button:has-text("Read it with on-device text recognition")');
  await page.screenshot({ path: path.join(shotsDir, 'ocr-02-reading-progress.png'), fullPage: true }).catch(() => {});

  console.log('3. waiting for OCR + match to resolve to a healthy row (up to 90s)...');
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 90000 });
  const badgeText = await page.textContent('.file-row .badge-ok, .file-row .badge-warn');
  const fileLine = await page.textContent('.file-row .fr-line');
  console.log('   OK - health badge:', badgeText.trim(), '| line:', fileLine.trim());
  await page.screenshot({ path: path.join(shotsDir, 'ocr-03-healthy-row.png'), fullPage: true });

  console.log('4. opening Review...');
  await page.click('a.rs-link:has-text("Review")');
  await page.waitForSelector('#review-summary', { timeout: 15000 });
  await page.waitForTimeout(500); // let the pdf canvas render
  const summaryText = await page.textContent('#review-summary');
  console.log('   review summary:', summaryText.replace(/\s+/g, ' ').trim());
  await page.screenshot({ path: path.join(shotsDir, 'ocr-04-review.png'), fullPage: true });

  console.log('5. back to Home, Copy for Sheets...');
  await page.click('button[data-screen="home"]');
  await page.waitForSelector('#copy-tsv-btn:not([disabled])', { timeout: 15000 });
  await page.click('#copy-tsv-btn');
  await page.waitForSelector('#home-toast.shown', { timeout: 10000 });
  const toast = await page.textContent('#home-toast');
  console.log('   toast:', toast.trim());
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const clipLines = clip.trim().split('\n');
  console.log('   clipboard: header + ' + (clipLines.length - 1) + ' data rows');
  await page.screenshot({ path: path.join(shotsDir, 'ocr-05-copied-toast.png'), fullPage: true });

  console.log('DONE');
} finally {
  await browser.close();
}
