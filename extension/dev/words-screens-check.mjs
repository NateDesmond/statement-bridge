// Section 3 (copy agent) verification: screenshots the plain-word renames
// (Statement types, Settings' three cards, Check a statement, How it works)
// in the REAL unpacked extension under bundled Chromium.
//
// Bypasses app.js's own nav wiring on purpose: at the time this was written,
// src/ui/nav.js's wireGearMenu() throws ("Cannot read properties of null
// (reading 'addEventListener')" on #gear-overlay, which workspace.html
// doesn't have yet - Section 1's shell rewrite is mid-flight) before home.js
// ever wires the file input, which breaks navigation and file drops for
// EVERY screen, not just this section's. Rather than block on that, this
// script imports each screen module fresh and renders it directly onto the
// live DOM (the same ids/markup app.js's instances use), which needs no nav
// click at all. See dev/shots/words-*.png and the run's own report for the
// exact error.
//
// Usage: node dev/words-screens-check.mjs
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-words-check-'));
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
  const pageErrors = [];
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = sw.url().split('/')[2];
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`chrome-extension://${extId}/workspace.html`);
    await page.waitForTimeout(500);

    // Seed one real statement type + one saved rate so Statement types/
    // Settings don't render as empty states.
    await page.evaluate(async () => {
      const { createProfile } = await import(chrome.runtime.getURL('src/core/profiles.js'));
      const { createChromeStorage } = await import(chrome.runtime.getURL('src/core/storage.js'));
      const storage = createChromeStorage();
      await createProfile(storage, {
        bank: 'Meridian Bank', name: 'Meridian Bank savings', fileType: 'csv',
        versions: [{ createdAt: Date.now(), signatures: {}, fields: {}, lastUsed: { rowCount: 91, readCount: 91 } }],
      });
      await storage.set('rates', { USD_SGD: 1.28 });
    });

    async function showScreenDirect(name, render) {
      await page.evaluate((n) => {
        document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${n}`));
      }, name);
      await render();
      await page.waitForTimeout(200);
    }

    await showScreenDirect('profiles', () => page.evaluate(async () => {
      const { createChromeStorage } = await import(chrome.runtime.getURL('src/core/storage.js'));
      const { createProfilesScreen } = await import(chrome.runtime.getURL('src/ui/profiles.js'));
      const screen = createProfilesScreen({ storage: createChromeStorage(), onMapNewStatement: () => {} });
      await screen.render();
    }));
    await page.screenshot({ path: path.join(shotsDir, 'words-01-statement-types.png'), fullPage: true });

    await showScreenDirect('settings', () => page.evaluate(async () => {
      const { createChromeStorage } = await import(chrome.runtime.getURL('src/core/storage.js'));
      const { createIndexedDbSessionStore } = await import(chrome.runtime.getURL('src/core/sessions.js'));
      const { createSettingsScreen } = await import(chrome.runtime.getURL('src/ui/settings.js'));
      const screen = createSettingsScreen({ storage: createChromeStorage(), sessionStore: createIndexedDbSessionStore(), getSampleRows: () => [] });
      screen.wire();
      await screen.render();
    }));
    await page.screenshot({ path: path.join(shotsDir, 'words-02-settings-three-cards.png'), fullPage: true });

    await showScreenDirect('review', () => page.evaluate(async () => {
      const { createChromeStorage } = await import(chrome.runtime.getURL('src/core/storage.js'));
      const { createReview } = await import(chrome.runtime.getURL('src/ui/review.js'));
      const screen = createReview({ storage: createChromeStorage(), getFiles: () => [], onUpdateMapping: () => {}, persist: () => {}, nav: { showScreen: () => {} }, onRemoveFile: () => {} });
      screen.render();
    }));
    await page.screenshot({ path: path.join(shotsDir, 'words-03-check-a-statement.png'), fullPage: true });

    await showScreenDirect('how', () => Promise.resolve());
    await page.screenshot({ path: path.join(shotsDir, 'words-04-how-it-works.png'), fullPage: true });

    console.log('pageErrors seen during this run:', pageErrors);
    console.log('Screenshots written to', shotsDir);
  } finally {
    await context.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
