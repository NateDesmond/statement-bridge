// One-off verification shot for task C's two "Show the welcome tour again"
// links (Settings, How it works). Not part of the onboarding screenshot set.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-tourlink-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: chromium.executablePath ? chromium.executablePath() : undefined,
    args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/workspace.html`);
  await page.waitForSelector('#file-input', { state: 'attached' });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.click('#gear-btn');
  await page.click('[data-screen="settings"]');
  await page.waitForSelector('#settings-show-tour-link', { state: 'visible' });
  await page.locator('#settings-show-tour-link').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shotsDir, 'tourlink-settings.png') });

  await page.click('#gear-btn');
  await page.click('[data-screen="how"]');
  await page.waitForSelector('#how-show-tour-link', { state: 'visible' });
  await page.locator('#how-show-tour-link').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shotsDir, 'tourlink-how.png') });

  await context.close();
  console.log('ok');
}

main();
