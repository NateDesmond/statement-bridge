// Pass-3 first-timer audit driver (audit/INDIE-STANDARD.md persona 1).
// Same shape as pass1-firsttimer.mjs but with DIFFERENT unknown files:
// a German-bank CSV (6-row preamble, semicolon-delimited, German headers,
// EUR "1.234,56" style amounts) and a fresh image-only PDF rasterised from
// anchor_columns.pdf, renamed to an unknown bank. Walks the real unpacked
// extension in bundled headless Chromium (never the user's Chrome), one
// script, foreground only, all the way through clicking Copy for both files.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(extensionPath, '..', 'audit', 'pass3');
fs.mkdirSync(shotsDir, { recursive: true });

let n = 0;
function nextName(label) { n += 1; return `first-timer-${String(n).padStart(2, '0')}-${label}`; }

async function shotBoth(page, label) {
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shotsDir, `${nextName(label)}-${width}.png`), fullPage: true });
  }
}

async function clickCopy(page, label) {
  const copyBtn = await page.$('#copy-tsv-btn');
  if (copyBtn && (await copyBtn.isVisible()) && !(await copyBtn.isDisabled())) {
    await copyBtn.click();
    await page.waitForTimeout(400);
    await shotBoth(page, label);
    return true;
  }
  console.log(`  (Copy button not clickable at "${label}")`);
  await shotBoth(page, `${label}-no-copy`);
  return false;
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-pass3-'));
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

  try {
  console.log('0. onboarding tab (first install)...');
  let onboardingPage = null;
  try {
    onboardingPage = await context.waitForEvent('page', { timeout: 5000 });
  } catch { /* no onboarding tab fired */ }
  if (onboardingPage && onboardingPage.url().includes('onboarding')) {
    await onboardingPage.waitForSelector('#ob-next', { state: 'attached' });
    await shotBoth(onboardingPage, 'onboarding-1-welcome');
    await onboardingPage.click('#ob-next');
    await onboardingPage.waitForTimeout(200);
    await shotBoth(onboardingPage, 'onboarding-2-how-it-works');
    await onboardingPage.click('#ob-next');
    await onboardingPage.waitForTimeout(200);
    await shotBoth(onboardingPage, 'onboarding-3-first-statement');
    await onboardingPage.close();
  } else {
    console.log('  (no onboarding tab appeared)');
  }

  console.log('1. open the extension (icon click equivalent)...');
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/workspace.html`);
  await page.waitForSelector('#file-input', { state: 'attached' });
  await shotBoth(page, 'home-empty');

  console.log('2. drop an unknown German-bank CSV (6-row preamble, semicolon, EUR)...');
  const input = await page.$('#file-input');
  await input.setInputFiles(path.join(fixturesDir, 'waldkonto_unbekannt.csv'));
  await page.waitForTimeout(600);
  await shotBoth(page, 'csv-processing-or-card');

  let setupBtn = await page.$('button:has-text("Set up")');
  if (setupBtn && (await setupBtn.isVisible())) {
    await setupBtn.click();
    await page.waitForTimeout(500);
    await shotBoth(page, 'csv-wizard-opened');
  } else {
    console.log('  (no visible "Set up" button on first look)');
  }

  const confirmYesVisible1 = await page.isVisible('#confirm-yes').catch(() => false);
  if (confirmYesVisible1) {
    await shotBoth(page, 'csv-confirm-a');
    await page.click('#confirm-yes');
    await page.waitForTimeout(300);
    await shotBoth(page, 'csv-confirm-c-name');
    if (await page.isVisible('#confirm-save').catch(() => false)) {
      await page.click('#confirm-save');
      await page.waitForTimeout(500);
      await shotBoth(page, 'csv-after-save');
    }
  } else {
    for (let step = 0; step < 5; step++) {
      await shotBoth(page, `csv-wizard-step-${step}`);
      const nextBtn = await page.$('#wizard-next');
      if (nextBtn && (await nextBtn.isVisible())) {
        const label = await nextBtn.textContent();
        await nextBtn.click();
        await page.waitForTimeout(400);
        if (label && label.trim().toLowerCase() === 'save') break;
      } else break;
    }
    await shotBoth(page, 'csv-wizard-final');
  }

  console.log('  copying CSV data...');
  await clickCopy(page, 'csv-after-copy');

  console.log('3. back to Home, drop an unknown-bank IMAGE PDF (needs OCR)...');
  await page.goto(page.url());
  await page.waitForSelector('#file-input', { state: 'attached' });
  await page.waitForTimeout(300);
  const input2 = await page.$('#file-input');
  await input2.setInputFiles(path.join(fixturesDir, 'brookline_ledger_unbekannt.pdf'));
  await page.waitForTimeout(800);
  await shotBoth(page, 'pdf-image-only-card');

  console.log('  waiting for OCR to finish...');
  for (let i = 0; i < 90; i++) {
    const done = await page.evaluate(() => {
      const rows = document.querySelectorAll('.file-row');
      return rows.length >= 1 && [...rows].every((r) => !/reading (your scan|page \d+ of)/i.test(r.textContent || ''));
    });
    if (done) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(500);
  await shotBoth(page, 'pdf-ocr-done-card');

  setupBtn = await page.$('button:has-text("Set up")');
  if (setupBtn && (await setupBtn.isVisible())) {
    await setupBtn.click();
    await page.waitForTimeout(600);
    await shotBoth(page, 'pdf-wizard-opened');
  } else {
    console.log('  (no visible "Set up" button after OCR)');
  }

  const confirmYesVisible = await page.isVisible('#confirm-yes').catch(() => false);
  if (confirmYesVisible) {
    await shotBoth(page, 'pdf-confirm-a');
    await page.click('#confirm-yes');
    await page.waitForTimeout(300);
    await shotBoth(page, 'pdf-confirm-c-name');
    if (await page.isVisible('#confirm-save').catch(() => false)) {
      await page.click('#confirm-save');
      await page.waitForTimeout(500);
      await shotBoth(page, 'pdf-after-save');
    }
  } else {
    for (let step = 0; step < 5; step++) {
      await shotBoth(page, `pdf-wizard-step-${step}`);
      const nextBtn = await page.$('#wizard-next');
      if (nextBtn && (await nextBtn.isVisible())) {
        const label = await nextBtn.textContent();
        await nextBtn.click();
        await page.waitForTimeout(500);
        if (label && label.trim().toLowerCase() === 'save') break;
      } else break;
    }
    await shotBoth(page, 'pdf-wizard-final');
  }

  console.log('  copying PDF data...');
  await clickCopy(page, 'pdf-after-copy');

  console.log('4. final Home state...');
  await shotBoth(page, 'home-final');

  console.log('done, screenshots in', shotsDir);
  } finally {
    await context.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
