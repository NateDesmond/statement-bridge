// Manual verification driver for the "wizard fixes" round (2026-09-16): walks
// the mapping wizard against the new 3-page grouped-layout fixture
// (test/fixtures/northwind_transaction_history_3p.pdf, see
// test/fixtures/gen/gen-dbs-transaction-history-3p.mjs) through every step,
// screenshotting each one to dev/shots/wiz2-*.png. Requires the dev server:
//   python3 -m http.server 8934 --directory extension   # from the repo root
//   node dev/wiz2-check.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.SB_DEV_PORT || 8934;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', 'test', 'fixtures', 'northwind_transaction_history_3p.pdf');
const shotsDir = path.join(__dirname, 'shots');

// Bundled, headless Chromium: never the user's own installed Chrome (no
// "channel: 'chrome'"), so this never touches a real browser session.
const browser = await chromium.launch();
try {
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

await page.goto(`http://localhost:${PORT}/dev/index.html`, { waitUntil: 'load' });
await page.evaluate(async () => {
  localStorage.clear();
  await new Promise((resolve) => { const req = indexedDB.deleteDatabase('statement-bridge'); req.onsuccess = resolve; req.onerror = resolve; req.onblocked = resolve; });
});
await page.reload({ waitUntil: 'load' });
await page.setViewportSize({ width: 1440, height: 1000 });
await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });

console.log('1. drop 3-page fixture...');
await page.$('#file-input').then((el) => el.setInputFiles(fixture));
// The fixture matches the built-in "Northwind Bank savings, Transaction History PDF"
// profile confidently (proof by itself that extractPdfPagesRows already
// merges all 3 pages: the file resolves straight to a healthy row, no "Map
// this statement" card) - reopen the wizard via Home's Change drawer instead
// of via a fresh-match card.
await page.waitForSelector('.file-row .badge-ok, button:has-text("Map this statement")', { timeout: 15000 });
const healthyLine = await page.textContent('.file-row .fr-line').catch(() => '');
console.log('   file resolved:', healthyLine?.trim() || '(no auto-match, a Map-this-statement card showed instead)');

console.log('2. open wizard via Home Change drawer -> Update mapping...');
await page.click('#change-link');
await page.waitForSelector('#drawer-mapping-list .mapping-row', { timeout: 10000 });
await page.click('#drawer-mapping-list .mapping-row a:has-text("Update mapping")');
await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shotsDir, 'wiz2-01-basics.png'), fullPage: true });

console.log('3. Basics -> Locate data...');
await page.click('#wizard-next');
await page.waitForTimeout(600); // pdf.js render + all-pages load
await page.screenshot({ path: path.join(shotsDir, 'wiz2-02-locate-p1.png'), fullPage: true });
const p1Caption = await page.textContent('#pdf-suggest-caption').catch(() => '');
const p1Totals = await page.textContent('#pdf-wholefile-caption').catch(() => '');
console.log('   page 1 caption:', p1Caption?.trim());
console.log('   whole-file totals:', p1Totals?.trim());

console.log('4. Locate data: Next page (2 of 3)...');
await page.click('#pdf-page-next');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shotsDir, 'wiz2-03-locate-p2.png'), fullPage: true });
console.log('   page 2 caption:', (await page.textContent('#pdf-suggest-caption').catch(() => ''))?.trim());

console.log('5. Locate data: Next page (3 of 3)...');
await page.click('#pdf-page-next');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shotsDir, 'wiz2-04-locate-p3.png'), fullPage: true });
console.log('   page 3 caption:', (await page.textContent('#pdf-suggest-caption').catch(() => ''))?.trim());
const pageIndicator = await page.textContent('.pdf-page-indicator').catch(() => '');
console.log('   page indicator:', pageIndicator?.trim());

console.log('6. scroll to bottom to verify sticky footer does not overlap content...');
await page.evaluate(() => { document.querySelector('main').scrollTo(0, document.querySelector('main').scrollHeight); });
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shotsDir, 'wiz2-05-locate-scrolled.png'), fullPage: false });

console.log('7. Locate data -> Map fields...');
await page.click('#wizard-next');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shotsDir, 'wiz2-06-map-fields.png'), fullPage: true });
const mapRows = await page.$$eval('#w-mapping-table tbody tr', (rows) => rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
console.log('   map-fields rows:', mapRows);

console.log('8. Map fields -> Test...');
await page.click('#wizard-next');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shotsDir, 'wiz2-07-test.png'), fullPage: true });
const rsItems = await page.$$eval('.review-summary .rs-item', (els) => els.map((e) => ({ cls: e.className, text: e.textContent.replace(/\s+/g, ' ').trim() })));
console.log('   test-step checks:', JSON.stringify(rsItems, null, 2));
const flaggedToggle = await page.$('#w-test-flaggedonly');
console.log('   flagged-only toggle present:', !!flaggedToggle);

console.log('9. Test -> Save...');
await page.click('#wizard-next');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shotsDir, 'wiz2-08-save.png'), fullPage: true });
const saveTotals = await page.textContent('#w-save-totals').catch(() => '');
console.log('   save-step totals:', saveTotals?.replace(/\s+/g, ' ').trim());

console.log('10. Save profile...');
await page.click('#wizard-next');
await page.waitForSelector('#screen-home.active', { timeout: 10000 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shotsDir, 'wiz2-09-home-saved.png'), fullPage: true });
const fileLine = await page.textContent('.file-row .fr-line').catch(() => '');
console.log('   home file line after save:', fileLine?.trim());

console.log('DONE');
} finally {
  await browser.close();
}
