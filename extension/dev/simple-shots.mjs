// Screenshot pass for the Simple B Home redesign (SIMPLE-BUILD.md Section 1),
// against the REAL unpacked extension in bundled headless Chromium (never the
// user's Chrome). Captures every required surface at 1440 and 1280 wide into
// dev/shots/simple-NN.png.
//
// Run with: node dev/simple-shots.mjs
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

// Fix item 9 (2026-09-18): prefix override via SHOT_PREFIX so a fresh
// verification pass writes dev/shots/final-*.png without clobbering the
// original simple-*.png set this script was written for.
const PREFIX = process.env.SHOT_PREFIX || 'simple';
let n = 0;
function nextName(label) { n += 1; return `${PREFIX}-${String(n).padStart(2, '0')}-${label}`; }

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-simple-shots-'));
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
    await page.screenshot({ path: path.join(shotsDir, `${nextName(label)}-${width}.png`), fullPage: false });
  }
}

async function main() {
  // 1/2: empty state.
  {
    const { context, page } = await launchExtensionContext();
    await shotBoth(page, 'empty');
    await context.close();
  }

  // 3/4: processing (mid-OCR row, before it resolves).
  {
    const { context, page } = await launchExtensionContext();
    await page.$('#file-input').then((el) => el.setInputFiles(path.join(fixturesDir, 'northwind_transaction_history_image.pdf')));
    await page.waitForSelector('.file-row', { timeout: 15000 });
    await shotBoth(page, 'processing');
    await context.close();
  }

  // 5/6: result (healthy CSV, no decisions).
  {
    const { context, page } = await launchExtensionContext();
    await page.$('#file-input').then((el) => el.setInputFiles(path.join(fixturesDir, 'meridian_savings.csv')));
    await page.waitForSelector('.file-row .badge-ok', { timeout: 15000 });
    await page.waitForSelector('#export-panel:not([hidden])', { timeout: 5000 });
    await shotBoth(page, 'result');
    await context.close();
  }

  // 7/8: decisions with a PDF snippet.
  {
    const { context, page } = await launchExtensionContext();
    await page.$('#file-input').then((el) => el.setInputFiles(path.join(fixturesDir, 'northwind_transaction_history_flags.pdf')));
    await page.waitForSelector('.decision-row', { timeout: 20000 });
    await page.waitForTimeout(600); // let the async snippet crop finish rendering
    await shotBoth(page, 'decisions-pdf-snippet');
    await context.close();
  }

  // 9/10: decisions with a CSV snippet (synthetic file with a within-file
  // duplicate transaction, same shape as the Meridian Bank savings builtin profile).
  {
    const csv = [
      'Account Details For: TAN WEI MING',
      'Account No: 123-4-567890',
      'Statement Period: 01 Jun 2026 to 30 Jun 2026',
      'Meridian Bank',
      '',
      'Transaction Date,Reference,Debit Amount,Credit Amount,Balance',
      '01/06/2026,NETS PAY 8817 SHENG SIONG,45.20,,4954.80',
      '03/06/2026,GIRO SP SERVICES,120.00,,4834.80',
      '03/06/2026,GIRO SP SERVICES,120.00,,4834.80',
      '05/06/2026,PAYNOW TRANSFER FROM JANE LEE,,200.00,5034.80',
      '15/06/2026,SALARY GIRO CREDIT ACME PTE LTD,,5000.00,10034.80',
      '',
    ].join('\n');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-simple-shots-fixture-'));
    const fixture = path.join(tmpDir, 'dbs_savings_dup.csv');
    fs.writeFileSync(fixture, csv);

    const { context, page } = await launchExtensionContext();
    await page.$('#file-input').then((el) => el.setInputFiles(fixture));
    await page.waitForSelector('.decision-row', { timeout: 15000 });
    await shotBoth(page, 'decisions-csv-snippet');
    await context.close();
  }

  // 11/12: gear menu overlay.
  {
    const { context, page } = await launchExtensionContext();
    await page.click('#gear-btn');
    await page.waitForSelector('#gear-overlay.open', { timeout: 5000 });
    await shotBoth(page, 'gear-menu');
    await context.close();
  }

  // 13/14: a secondary screen (Statement types) with the shell's Back control.
  {
    const { context, page } = await launchExtensionContext();
    await page.click('#gear-btn');
    await page.waitForSelector('#gear-overlay.open', { timeout: 5000 });
    await page.click('#gear-overlay .dropdown-item[data-screen="profiles"]');
    await page.waitForSelector('#screen-profiles.active', { timeout: 5000 });
    await shotBoth(page, 'secondary-screen-back');
    await context.close();
  }

  // Fix item 9: Settings and How it works, plus the confirm-first setup
  // screens A/B/C (SIMPLE-BUILD.md Section 2) - a real new bank
  // statement via the attention card's "Set up". generic_unknown_bank.csv
  // (map4's own fixture) has deliberately unrecognisable headers ("When",
  // "What", "Value") - real for testing manual mapping, but a blank Date/
  // Description preview makes for a poor screenshot; a fresh synthetic CSV
  // with plain, recognisable headers gives Screen A something real to show.
  const setupCsvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-simple-shots-setup-'));
  const setupCsvPath = path.join(setupCsvDir, 'newbank_savings.csv');
  fs.writeFileSync(setupCsvPath, [
    'Newbank Pte Ltd',
    'Account: 555-1234',
    '',
    'Date,Description,Amount',
    '01/09/2026,Coffee Shop Purchase,-4.50',
    '03/09/2026,Grocery Store,-52.30',
    '10/09/2026,Salary Payout,3000.00',
    '18/09/2026,Utility Bill,-88.20',
    '20/09/2026,Refund,15.00',
    '',
  ].join('\n'));
  async function openSetup(page) {
    await page.$('#file-input').then((el) => el.setInputFiles(setupCsvPath));
    await page.waitForSelector('#attention-cards button:has-text("Set up")', { timeout: 15000 });
    await page.click('#attention-cards button:has-text("Set up")');
    await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
    await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 10000 });
  }

  // 15/16, 17/18: setup A, then B ("Something's off").
  {
    const { context, page } = await launchExtensionContext();
    await openSetup(page);
    await shotBoth(page, 'setup-a');
    await page.click('#confirm-off');
    await page.waitForSelector('#confirm-b:not([hidden])', { timeout: 5000 });
    await shotBoth(page, 'setup-b');
    await context.close();
  }

  // 19/20: setup C ("Name this statement"), from a fresh drop via Yes.
  {
    const { context, page } = await launchExtensionContext();
    await openSetup(page);
    await page.click('#confirm-yes');
    await page.waitForSelector('#confirm-c:not([hidden])', { timeout: 5000 });
    await shotBoth(page, 'setup-c');
    await context.close();
  }

  // 21/22: Settings.
  {
    const { context, page } = await launchExtensionContext();
    await page.click('#gear-btn');
    await page.waitForSelector('#gear-overlay.open', { timeout: 5000 });
    await page.click('#gear-overlay .dropdown-item[data-screen="settings"]');
    await page.waitForSelector('#screen-settings.active', { timeout: 5000 });
    await shotBoth(page, 'settings');
    await context.close();
  }

  // 23/24: How it works.
  {
    const { context, page } = await launchExtensionContext();
    await page.click('#gear-btn');
    await page.waitForSelector('#gear-overlay.open', { timeout: 5000 });
    await page.click('#gear-overlay .dropdown-item[data-screen="how"]');
    await page.waitForSelector('#screen-how.active', { timeout: 5000 });
    await shotBoth(page, 'how-it-works');
    await context.close();
  }

  console.log(`done. ${n} screenshot groups written to ${shotsDir}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
