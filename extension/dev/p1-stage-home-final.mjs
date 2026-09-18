// Pass-1 first-timer audit, stage 3: reopen the same extension state and look
// at the final Home screen a first-timer would be left with (one broken CSV,
// one PDF stuck mid-setup), then try the Copy action. 1440-only shots.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(extensionPath, '..', 'audit', 'pass1');
fs.mkdirSync(shotsDir, { recursive: true });
const userDataDir = process.env.SB_UDD;
if (!userDataDir) throw new Error('SB_UDD env var required');

let n = Number(process.env.SB_N_START || '27');
function nextName(label) { n += 1; return `first-timer-${String(n).padStart(2, '0')}-${label}`; }
async function shot(page, label) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, `${nextName(label)}-1440.png`), fullPage: true });
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
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = sw.url().split('/')[2];
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/workspace.html`);
    await page.waitForSelector('#file-input', { state: 'attached' });
    await page.waitForTimeout(300);

    // Back out of the stuck wizard if it's still open from stage 2.
    const backLink = await page.$('#wizard-back-btn');
    if (backLink && (await backLink.isVisible())) {
      await backLink.click();
      await page.waitForTimeout(400);
    }

    const restoreBtn = await page.$('button:has-text("Restore")');
    if (restoreBtn && (await restoreBtn.isVisible())) {
      await restoreBtn.click();
      await page.waitForTimeout(500);
    }
    await shot(page, 'home-final-state');

    const copyBtn = await page.$('button:has-text("Copy for Sheets"), #copy-tsv-btn');
    if (copyBtn && (await copyBtn.isVisible())) {
      await copyBtn.click();
      await page.waitForTimeout(400);
      await shot(page, 'home-after-copy-attempt');
    } else {
      console.log('(no visible Copy button - export panel likely blocked)');
    }

    console.log('LAST_N=' + n);
  } finally {
    await context.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
