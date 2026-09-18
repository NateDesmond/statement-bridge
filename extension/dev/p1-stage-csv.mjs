// Pass-1 first-timer audit, stage 1: onboarding + drop an unknown-bank CSV + setup.
// Bundled headless Chromium only. Uses a FIXED userDataDir (SB_UDD env var) so
// stage 2/3 scripts can reopen the same extension state (sessions persist via
// chrome.storage/IndexedDB, same as a real browser restart).
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(extensionPath, '..', 'audit', 'pass1');
fs.mkdirSync(shotsDir, { recursive: true });
const userDataDir = process.env.SB_UDD;
if (!userDataDir) throw new Error('SB_UDD env var required');

let n = 0;
function nextName(label) { n += 1; return `first-timer-${String(n).padStart(2, '0')}-${label}`; }
async function shotBoth(page, label) {
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shotsDir, `${nextName(label)}-${width}.png`), fullPage: true });
  }
}

async function main() {
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

  console.log('0. onboarding tab...');
  let onboardingPage = null;
  try { onboardingPage = await context.waitForEvent('page', { timeout: 5000 }); } catch {}
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
    console.log('  (no onboarding tab)');
  }

  console.log('1. open extension...');
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/workspace.html`);
  await page.waitForSelector('#file-input', { state: 'attached' });
  await shotBoth(page, 'home-empty');

  console.log('2. drop unknown-bank CSV...');
  const input = await page.$('#file-input');
  await input.setInputFiles(path.join(fixturesDir, 'generic_unknown_bank.csv'));
  await page.waitForTimeout(600);
  await shotBoth(page, 'csv-new-statement-card');

  const setupBtn = await page.$('button:has-text("Set up")');
  if (setupBtn && (await setupBtn.isVisible())) {
    await setupBtn.click();
    await page.waitForTimeout(500);
    await shotBoth(page, 'csv-wizard-opened');
  } else {
    console.log('  (no visible Set up button)');
  }

  if (await page.isVisible('#confirm-yes').catch(() => false)) {
    await shotBoth(page, 'csv-confirm-a');
    await page.click('#confirm-yes');
    await page.waitForTimeout(300);
    await shotBoth(page, 'csv-confirm-c-name');
    if (await page.isVisible('#confirm-save').catch(() => false)) {
      await page.click('#confirm-save');
      await page.waitForTimeout(600);
      await shotBoth(page, 'csv-after-save');
    }
  } else {
    console.log('  (no confirm-a screen visible, full wizard shown instead)');
    await shotBoth(page, 'csv-wizard-fallback');
  }

  console.log('done with stage 1');
  await context.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
