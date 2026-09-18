// Screenshots of the first-run onboarding tab (task C), against the REAL
// unpacked extension in bundled headless Chromium (never the user's Chrome).
// Same launch pattern as dev/simple-shots.mjs. Run with:
//   node dev/onboarding-shots.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-onboarding-shots-'));
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
  await page.goto(`chrome-extension://${extId}/onboarding/onboarding.html`);
  await page.waitForSelector('#ob-next', { state: 'attached' });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, 'onboarding-1-welcome.png') });

  await page.click('#ob-next');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, 'onboarding-2-how-it-works.png') });

  await page.click('#ob-next');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, 'onboarding-3-first-statement.png') });

  await context.close();
  console.log('Wrote onboarding-1/2/3 screenshots to', shotsDir);
}

main();
