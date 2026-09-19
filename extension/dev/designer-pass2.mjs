// Pass 2 designer audit screenshots. Real unpacked extension, bundled
// headless Chromium only. Run in small batches via SCENE env var.
// Usage: node dev/designer-pass2.mjs <scene>
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(extensionPath, '..', 'audit', 'pass2');
fs.mkdirSync(shotsDir, { recursive: true });

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-p2-'));
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page };
}

async function shot(page, label, widths = [1440, 1280]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shotsDir, `designer-${label}-${width}.png`), fullPage: true });
  }
}

async function dropAndOpenWizard(page, fixturePath) {
  await page.$('#file-input').then((el) => el.setInputFiles(fixturePath));
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, #attention-cards button:has-text("Set up")', { timeout: 60000 });
  const setupBtn = await page.$('#attention-cards button:has-text("Set up")');
  if (setupBtn) {
    await setupBtn.click();
  } else {
    await page.click('#change-link');
    await page.waitForTimeout(200);
    const updateLink = await page.$('#change-drawer a:has-text("Update mapping"), #change-drawer button:has-text("Update mapping")');
    if (updateLink) await updateLink.click();
  }
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
}

const scene = process.argv[2];

async function run(fn) {
  const { context, page } = await launchExtensionContext();
  try {
    await fn(page);
  } finally {
    await context.close();
  }
}

const scenes = {
  async home_empty(page) {
    await shot(page, '01-home-empty', [1440, 1280, 1024]);
  },

  async home_processing(page) {
    await page.$('#file-input').then((el) => el.setInputFiles(path.join(fixturesDir, 'northwind_transaction_history_flags.pdf')));
    await page.waitForSelector('.file-row', { timeout: 15000 });
    await shot(page, '02-home-processing');
  },

  async home_ready(page) {
    await page.$('#file-input').then((el) => el.setInputFiles(path.join(fixturesDir, 'meridian_savings.csv')));
    await page.waitForSelector('.file-row .badge-ok', { timeout: 15000 });
    await page.waitForSelector('#export-panel:not([hidden])', { timeout: 5000 });
    await shot(page, '03-home-ready');
  },

  async decisions_image_pdf(page) {
    const fixture = path.join(fixturesDir, 'summit_grouped_2line_image.pdf');
    await dropAndOpenWizard(page, fixture);
    await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(400);
    await shot(page, '04-decisions-ocr-image-pdf');
  },

  async decisions_csv_flagged(page) {
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-p2-csvflag-'));
    const fixture = path.join(tmpDir, 'dbs_savings_dup.csv');
    fs.writeFileSync(fixture, csv);
    await page.$('#file-input').then((el) => el.setInputFiles(fixture));
    await page.waitForSelector('.decision-row', { timeout: 15000 });
    await shot(page, '05-decisions-csv-flagged');
  },

  async export_sheet_states(page) {
    await page.$('#file-input').then((el) => el.setInputFiles(path.join(fixturesDir, 'meridian_savings.csv')));
    await page.waitForSelector('#export-panel:not([hidden])', { timeout: 15000 });
    await shot(page, '06-export-closed');
    await page.click('#change-link');
    await page.waitForSelector('#change-drawer:not([hidden])', { timeout: 5000 });
    await shot(page, '07-export-open');
    const details = await page.$('#home-preset-editor .columns-customise');
    if (details) {
      await page.click('#home-preset-editor .columns-customise > summary');
      await page.waitForTimeout(150);
    }
    const chip = await page.$('#home-preset-editor .columns-customise button:has-text("Balance")');
    if (chip) await chip.click();
    await page.waitForTimeout(150);
    await shot(page, '08-export-customised');
  },

  async setup_abc(page) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-p2-setup-'));
    const setupCsvPath = path.join(tmpDir, 'newbank_savings.csv');
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
    await page.$('#file-input').then((el) => el.setInputFiles(setupCsvPath));
    await page.waitForSelector('#attention-cards button:has-text("Set up")', { timeout: 15000 });
    await page.click('#attention-cards button:has-text("Set up")');
    await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
    await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 10000 });
    await shot(page, '09-setup-a');
    await page.click('#confirm-off');
    await page.waitForSelector('#confirm-b:not([hidden])', { timeout: 5000 });
    await shot(page, '10-setup-b');
    await page.click('#confirm-fix-other');
    await page.waitForSelector('#step-2.active', { timeout: 5000 });
    await shot(page, '11-setup-detailed-map-fields');
  },

  async setup_c(page) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-p2-setupc-'));
    const setupCsvPath = path.join(tmpDir, 'newbank2_savings.csv');
    fs.writeFileSync(setupCsvPath, [
      'Newbank2 Pte Ltd',
      'Account: 555-9999',
      '',
      'Date,Description,Amount',
      '01/09/2026,Coffee Shop Purchase,-4.50',
      '03/09/2026,Grocery Store,-52.30',
      '10/09/2026,Salary Payout,3000.00',
      '',
    ].join('\n'));
    await page.$('#file-input').then((el) => el.setInputFiles(setupCsvPath));
    await page.waitForSelector('#attention-cards button:has-text("Set up")', { timeout: 15000 });
    await page.click('#attention-cards button:has-text("Set up")');
    await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 10000 });
    await page.click('#confirm-yes');
    await page.waitForSelector('#confirm-c:not([hidden])', { timeout: 5000 });
    await shot(page, '12-setup-c');
  },

  async check_a_statement(page) {
    await page.$('#file-input').then((el) => el.setInputFiles(path.join(fixturesDir, 'meridian_savings.csv')));
    await page.waitForSelector('#export-panel:not([hidden])', { timeout: 15000 });
    await page.click('#change-link');
    await page.waitForSelector('#change-drawer:not([hidden])', { timeout: 5000 });
    const checkLink = await page.$('#change-drawer a:has-text("Check"), #change-drawer button:has-text("Check")');
    if (checkLink) {
      await checkLink.click();
      await page.waitForTimeout(400);
    }
    await shot(page, '13-check-a-statement');
  },

  async gear_and_statement_types(page) {
    await page.click('#gear-btn');
    await page.waitForSelector('#gear-overlay.open', { timeout: 5000 });
    await shot(page, '14-gear-dropdown');
    await page.click('#gear-overlay .dropdown-item[data-screen="profiles"]');
    await page.waitForSelector('#screen-profiles.active', { timeout: 5000 });
    await shot(page, '15-statement-types');
  },

  async settings_and_how(page) {
    await page.click('#gear-btn');
    await page.waitForSelector('#gear-overlay.open', { timeout: 5000 });
    await page.click('#gear-overlay .dropdown-item[data-screen="settings"]');
    await page.waitForSelector('#screen-settings.active', { timeout: 5000 });
    await shot(page, '16-settings');
    await page.click('#gear-btn');
    await page.waitForSelector('#gear-overlay.open', { timeout: 5000 });
    await page.click('#gear-overlay .dropdown-item[data-screen="how"]');
    await page.waitForSelector('#screen-how.active', { timeout: 5000 });
    await shot(page, '17-how-it-works');
  },

  async report_sheet(page) {
    await page.click('#report-fab');
    await page.waitForSelector('#screen-report.active, #report-backdrop:not([hidden])', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, '18-report-sheet');
  },

  async onboarding(page, context) {
    let onboardingPage = null;
    try { onboardingPage = await context.waitForEvent('page', { timeout: 5000 }); } catch {}
    if (!onboardingPage) { console.log('no onboarding tab opened'); return; }
    await onboardingPage.waitForSelector('#ob-next', { state: 'attached' });
    await shot(onboardingPage, '19-onboarding-1');
    await onboardingPage.click('#ob-next');
    await onboardingPage.waitForTimeout(200);
    await shot(onboardingPage, '20-onboarding-2');
    await onboardingPage.click('#ob-next');
    await onboardingPage.waitForTimeout(200);
    await shot(onboardingPage, '21-onboarding-3');
  },
};

async function runOnboarding() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-p2-ob-'));
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
  try {
    let onboardingPage = null;
    try { onboardingPage = await context.waitForEvent('page', { timeout: 5000 }); } catch {}
    if (!onboardingPage) { console.log('no onboarding tab opened'); return; }
    await onboardingPage.waitForSelector('#ob-next', { state: 'attached' });
    await shot(onboardingPage, '19-onboarding-1');
    await onboardingPage.click('#ob-next');
    await onboardingPage.waitForTimeout(200);
    await shot(onboardingPage, '20-onboarding-2');
    await onboardingPage.click('#ob-next');
    await onboardingPage.waitForTimeout(200);
    await shot(onboardingPage, '21-onboarding-3');
  } finally {
    await context.close();
  }
}

async function main() {
  if (scene === 'onboarding') {
    await runOnboarding();
    return;
  }
  const list = scene === 'all' ? Object.keys(scenes).filter((s) => s !== 'onboarding') : scene.split(',');
  for (const s of list) {
    console.log(`--- scene: ${s} ---`);
    await run(scenes[s]);
  }
  console.log('done');
}

main().catch((err) => { console.error(err); process.exit(1); });
