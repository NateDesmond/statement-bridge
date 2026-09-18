// One-off verification for the cross-file-merge health-badge fix: drop the
// same OCR fixture twice (second drop auto-matches the profile saved from
// the first), so every row cross-file-dedupes away from the second file into
// the first, then confirm BOTH file rows show "All checks pass" plus the
// second file's row caption "N rows merged into <first file>". Structure
// copied from dev/e2e-extension.mjs's runMapFieldsScenario (loads the real
// unpacked extension into the bundled headless Chromium, never the user's
// Chrome), extended with a second drop + badge/caption check at the end.
// Screenshot: dev/shots/dedupe-04-badges.png - read it, don't just trust text.
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-dedupe-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // see dev/e2e-extension.mjs's module doc comment
    executablePath: chromium.executablePath(), // bundled Chromium only, never channel:'chrome'
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

function shotter(page, prefix) {
  return async function shotStep(name) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shotsDir, `${prefix}-${name}.png`), fullPage: false });
  };
}

/** Drop a fixture on Home and open the wizard for it (see e2e-extension.mjs's identical helper). */
async function dropAndOpenWizard(page, fixturePath) {
  await page.$('#file-input').then((el) => el.setInputFiles(fixturePath));
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, button:has-text("Map this statement")', { timeout: 60000 });
  const mapBtn = await page.$('button:has-text("Map this statement")');
  if (mapBtn) {
    await mapBtn.click();
  } else {
    await page.click('#change-link');
    await page.waitForSelector('#drawer-mapping-list .mapping-row', { timeout: 10000 });
    await page.click('#drawer-mapping-list .mapping-row a:has-text("Update mapping")');
  }
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
}

async function main() {
  const { context, page } = await launchExtensionContext();
  const shotStep = shotter(page, 'dedupe');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_image.pdf');

  console.log('1. drop the OCR fixture (image-only, forces the auto-OCR path), open the wizard...');
  await dropAndOpenWizard(page, fixture);
  await shotStep('01-basics');

  console.log('2. Basics -> Locate data -> Map fields -> Test -> Save...');
  await page.click('#wizard-next'); await page.waitForTimeout(500); // Basics -> Locate
  await page.click('#wizard-next'); await page.waitForTimeout(500); // Locate -> Map fields
  await page.click('#wizard-next'); await page.waitForTimeout(500); // Map fields -> Test
  await shotStep('02-test');
  await page.click('#wizard-next'); await page.waitForTimeout(500); // Test -> Save (profile-name screen)
  await shotStep('03-save-screen');
  await page.click('#wizard-next'); await page.waitForTimeout(800); // Save profile -> back to Home
  await shotStep('04-home-after-save');

  console.log('3. drop the SAME fixture again - it should auto-match the just-saved profile...');
  await page.$('#file-input').then((el) => el.setInputFiles(fixture));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(shotsDir, 'dedupe-04-badges.png') });

  const rows = await page.$$('.file-row');
  console.log(`   ${rows.length} file rows on Home`);
  for (let i = 0; i < rows.length; i++) {
    console.log(`   --- file row ${i} ---\n${await rows[i].innerText()}\n`);
  }

  console.log('done. screenshots in', shotsDir);
  await context.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
