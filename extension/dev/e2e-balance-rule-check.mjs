// Verification script for the 2026-09-19 "balance is a silent cross-check"
// product rule - real extension, bundled Chromium only. Loads one CSV with
// no balance data (meridian_savings.csv) and one with balance data that
// reconciles (anchor_checking.csv), screenshotting Home-ready, Review, and
// the wizard's Test step for each, plus checking the reassurance line / the
// absence of any balance UI on the no-balance file.
//
// Run with: cd extension && node dev/e2e-balance-rule-check.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

async function launchWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-balance-'));
  const context = await chromium.launchPersistentContext(tmpDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    args: [
      '--headless=new',
      '--no-sandbox',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e); console.log('[pageerror]', e.message); });
  await page.goto(`chrome-extension://${extId}/workspace.html`);
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page, pageErrors };
}

async function runFor(fixtureName, label, expectBalance) {
  console.log(`\n=== ${label} (${fixtureName}) ===`);
  const { context, page, pageErrors } = await launchWorkspace();
  try {
    const fixture = path.join(extensionPath, 'test', 'fixtures', fixtureName);
    await page.$eval('#file-input', () => {}); // no-op, keeps selector referenced
    const input = await page.$('#file-input');
    await input.setInputFiles(fixture);
    await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 20000 });
    await page.waitForTimeout(500);

    // --- Home ready ---
    await page.waitForSelector('#export-panel:not([hidden])', { timeout: 10000 });
    await page.screenshot({ path: path.join(shotsDir, `balance-home-${label}.png`), fullPage: true });
    const allClearText = await page.$eval('#export-allclear-note', (el) => ({ hidden: el.hidden, text: el.textContent.trim() }));
    if (expectBalance) {
      check('Home reassurance line mentions balances when they reconcile', !allClearText.hidden && allClearText.text.includes('balances add up'), JSON.stringify(allClearText));
    } else {
      check('Home reassurance line never mentions balances with no balance data', allClearText.hidden || !/balance/i.test(allClearText.text), JSON.stringify(allClearText));
    }

    // --- Review ---
    if (await page.$eval('#change-drawer', (el) => el.hidden)) await page.click('#change-link');
    await page.waitForSelector('#change-drawer:not([hidden])', { timeout: 10000 });
    await page.locator('#accounts-table-body a:has-text("Check")').first().click();
    await page.waitForSelector('#review-body:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(shotsDir, `balance-review-${label}.png`), fullPage: true });
    const reviewBalanceLine = await page.$$eval('#review-summary .rs-item', (items) => items.map((i) => i.textContent.trim()).find((t) => /alance/i.test(t)) || null);
    const reviewHeaders = await page.$$eval('#review-thead th', (ths) => ths.map((t) => t.textContent.trim()));
    if (expectBalance) {
      check('Review shows a Balance column when the file has balances', reviewHeaders.includes('Balance'), reviewHeaders.join(','));
      check('Review has no balance mismatch line (it reconciles)', reviewBalanceLine === null, reviewBalanceLine);
    } else {
      check('Review shows no Balance column with no balance data', !reviewHeaders.includes('Balance'), reviewHeaders.join(','));
      check('Review shows no balance line at all with no balance data', reviewBalanceLine === null, reviewBalanceLine);
    }

    // --- Wizard Test step (via Update mapping, back on Home first) --------
    await page.click('#review-footer-export, #review-footer-add').catch(() => {});
    await page.waitForSelector('#screen-home.active', { timeout: 10000 });
    // The drawer may already be open (left open from the Review "Check" step
    // above, whose drawerOpen state survives the round trip) - only click to
    // open it, never toggle it shut.
    if (await page.$eval('#change-drawer', (el) => el.hidden)) await page.click('#change-link');
    await page.waitForSelector('#change-drawer:not([hidden])', { timeout: 10000 });
    await page.locator('#accounts-table-body a:has-text("Set up again")').first().click();
    await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
    // Bypass confirm-first screen straight to the full wizard if it appears.
    const somethingsOff = await page.$('button:has-text("Something\'s off")');
    if (somethingsOff) {
      await somethingsOff.click();
      const somethingElse = await page.$('button:has-text("Something else")');
      if (somethingElse) await somethingElse.click();
    }
    // Advance to Test step (id 3 in the stepper): click Next until it's active.
    for (let i = 0; i < 6; i++) {
      const onTest = await page.$('#w-test-results');
      if (onTest && await onTest.isVisible().catch(() => false)) break;
      const next = await page.$('#wizard-next');
      if (next && await next.isVisible() && !(await next.isDisabled())) await next.click();
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(shotsDir, `balance-wizardtest-${label}.png`), fullPage: true });
    const wizardBalanceLine = await page.$$eval('.review-summary .rs-item, #w-test-results .rs-item', (items) => items.map((i) => i.textContent.trim()).find((t) => /alance/i.test(t)) || null);
    const wizardHeaders = await page.$$eval('#w-test-table thead th', (ths) => ths.map((t) => t.textContent.trim())).catch(() => []);
    if (expectBalance) {
      check('Wizard Test step shows a Balance column when the file has balances', wizardHeaders.includes('Balance'), wizardHeaders.join(','));
      check('Wizard Test step has no balance mismatch line (it reconciles)', wizardBalanceLine === null, wizardBalanceLine);
    } else {
      check('Wizard Test step shows no Balance column with no balance data', !wizardHeaders.includes('Balance'), wizardHeaders.join(','));
      check('Wizard Test step shows no balance line at all with no balance data', wizardBalanceLine === null, wizardBalanceLine);
    }

    const cleanLog = await assertCleanLog(page, label, pageErrors);
    check(`${label}: clean debug log`, cleanLog.ok, cleanLog.problems.join('; '));
  } finally {
    await context.close();
  }
}

async function main() {
  await runFor('lattice_card_tabbed.csv', 'no-balance', false);
  await runFor('anchor_checking.csv', 'with-balance', true);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
