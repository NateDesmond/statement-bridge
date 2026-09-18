// Shared helpers for the pass-1 designer audit stage scripts (dev/designer-*.mjs).
// Real unpacked extension, bundled headless Chromium only, never the user's
// Chrome. Screenshots into audit/pass1/ at the repo root (not extension/audit).
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const extensionPath = path.join(__dirname, '..');
export const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
export const shotsDir = path.join(extensionPath, '..', 'audit', 'pass1');
fs.mkdirSync(shotsDir, { recursive: true });

export async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-designer-'));
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
  return { context, page, extId };
}

export function makeShotter(prefixStart = 0) {
  let n = prefixStart;
  return async function shot3(page, label, { widths = [1440, 1280, 1024] } = {}) {
    n += 1;
    const name = `designer-${String(n).padStart(2, '0')}-${label}`;
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(shotsDir, `${name}-${width}.png`), fullPage: true });
    }
    return n;
  };
}
