// Screenshot pass for "Report a problem" (Section D), against the REAL
// unpacked extension in bundled headless Chromium (never the user's Chrome).
// Captures dev/shots/report-NN-*.png.
//
// Run with: node dev/report-shots.mjs
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

let n = 0;
function nextName(label) { n += 1; return `report-${String(n).padStart(2, '0')}-${label}.png`; }

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-report-shots-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: chromium.executablePath ? chromium.executablePath() : undefined,
    permissions: ['clipboard-read', 'clipboard-write'],
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
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`chrome-extension://${extId}/workspace.html`);
  await page.waitForSelector('#file-input', { state: 'attached' });
  return { context, page };
}

async function openGearMenu(page) {
  await page.click('#gear-btn');
  await page.waitForSelector('#gear-overlay.open');
}

async function main() {
  const { context, page } = await launchExtensionContext();

  // 1: the empty report screen, reached via the gear menu.
  await openGearMenu(page);
  await page.click('#gear-overlay .tile[data-screen="report"]');
  await page.waitForSelector('#screen-report.active');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, nextName('empty')) });

  // Drop a real statement so the "which file" dropdown and the debug log
  // have real content to show off the anonymised preview.
  await page.click('#shell-back-btn'); // back to Home
  await page.waitForSelector('#screen-home.active');
  const input = await page.$('#file-input');
  await input.setInputFiles(path.join(fixturesDir, 'meridian_savings.csv'));
  await page.waitForTimeout(1500);

  // 2: filled form with a file picked and the anonymised preview visible.
  await openGearMenu(page);
  await page.click('#gear-overlay .tile[data-screen="report"]');
  await page.waitForSelector('#screen-report.active');
  await page.fill('#report-what', 'The credit amount on 05/06 copied as blank.');
  await page.selectOption('#report-file', { label: 'meridian_savings.csv' });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, nextName('filled-with-preview')) });

  // 3: log excluded - the summary line should say so plainly.
  await page.uncheck('#report-include-log');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, nextName('log-excluded')) });
  await page.check('#report-include-log');

  // 4: after "Copy report and open email" - the confirmation panel.
  await page.click('#report-send-btn');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shotsDir, nextName('sent-confirmation')) });

  await context.close();
  console.log('report-shots.mjs: done, wrote to', shotsDir);
}

main().catch((e) => { console.error(e); process.exit(1); });
