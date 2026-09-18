// Final integration pass (2026-09-16), task 3d: walk the wizard against the
// two synthetic fixtures exercising the paths real files above don't cover
// (summit_card_sample.pdf: PDF columns rowModel; harbour_card_crdr.csv: CSV
// credit-card CR/DR), screenshotting each into dev/shots/final-*.png.
// Requires the dev server: python3 -m http.server 8934 --directory extension
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.SB_DEV_PORT || 8934;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');

async function freshPage(browser) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://localhost:${PORT}/dev/index.html`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => { const req = indexedDB.deleteDatabase('statement-bridge'); req.onsuccess = resolve; req.onerror = resolve; req.onblocked = resolve; });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  await page.waitForSelector('#dropzone-full strong', { timeout: 15000 });
  return page;
}

async function runWizardFixture(browser, { fixture, prefix }) {
  console.log(`\n=== ${prefix}: ${fixture} ===`);
  const page = await freshPage(browser);
  const filePath = path.join(repoRoot, 'test', 'fixtures', fixture);
  await page.$('#file-input').then((el) => el.setInputFiles(filePath));

  console.log('1. drop, waiting for a "Map this statement" card or an auto-match badge...');
  await page.waitForSelector('button:has-text("Map this statement"), .file-row .badge-ok, .file-row .badge-warn', { timeout: 15000 });
  const mapBtn = await page.$('button:has-text("Map this statement")');
  if (mapBtn) {
    await mapBtn.click();
  } else {
    // Auto-matched a built-in profile: open the wizard via Home's Change drawer instead.
    await page.click('#change-link');
    await page.waitForSelector('#drawer-mapping-list .mapping-row', { timeout: 10000 });
    await page.click('#drawer-mapping-list .mapping-row a:has-text("Update mapping")');
  }
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shotsDir, `final-${prefix}-01-basics.png`), fullPage: true });
  console.log('   basics screenshot saved');

  console.log('2. Basics -> Locate data...');
  await page.click('#wizard-next');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shotsDir, `final-${prefix}-02-locate.png`), fullPage: true });
  const suggestCaption = await page.textContent('#pdf-suggest-caption').catch(() => null);
  if (suggestCaption) console.log('   locate caption:', suggestCaption.trim());

  console.log('3. Locate data -> Map fields...');
  await page.click('#wizard-next');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shotsDir, `final-${prefix}-03-map-fields.png`), fullPage: true });
  const signCap = await page.textContent('#w-signconvention-cap').catch(() => null);
  const signVal = await page.$eval('#w-signconvention', (el) => el.value).catch(() => null);
  console.log('   sign convention select value:', signVal, '| caption:', signCap?.trim());

  console.log('4. Map fields -> Test...');
  await page.click('#wizard-next');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shotsDir, `final-${prefix}-04-test.png`), fullPage: true });
  const rsItems = await page.$$eval('.review-summary .rs-item', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('   test-step checks:', JSON.stringify(rsItems));

  console.log('5. Test -> Save...');
  await page.click('#wizard-next');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shotsDir, `final-${prefix}-05-save.png`), fullPage: true });

  console.log('6. Save profile...');
  await page.click('#wizard-next');
  await page.waitForSelector('#screen-home.active', { timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shotsDir, `final-${prefix}-06-home-saved.png`), fullPage: true });
  const fileLine = await page.textContent('.file-row .fr-line').catch(() => '');
  const badge = await page.textContent('.file-row .badge-ok, .file-row .badge-warn').catch(() => '');
  console.log('   home after save - badge:', badge?.trim(), '| line:', fileLine?.trim());

  await page.context().close();
}

const browser = await chromium.launch();
try {
  await runWizardFixture(browser, { fixture: 'summit_card_sample.pdf', prefix: 'uob-pdf' });
  await runWizardFixture(browser, { fixture: 'harbour_card_crdr.csv', prefix: 'dbs-crdr-csv' });
  console.log('\nDONE');
} finally {
  await browser.close();
}
