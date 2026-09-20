// Item 11 verification: drives a real image-only PDF through OCR in the
// REAL unpacked extension (bundled Chromium only) and asserts zero console
// errors and zero connect-src violations - the wasmBinary fix means the
// Tesseract core's own fetch(data:...) call should never happen at all.
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixture = path.join(extensionPath, 'test', 'fixtures', 'summit_grouped_2line_image.pdf');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail !== undefined ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-ocr-console-'));
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
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    await page.goto(`chrome-extension://${extId}/workspace.html`);
    await page.waitForSelector('#file-input', { state: 'attached' });

    const input = await page.$('#file-input');
    await input.setInputFiles(fixture);
    const rowSel = `.file-row[aria-label="summit_grouped_2line_image.pdf"]`;
    await page.waitForSelector(rowSel, { timeout: 20000 });
    await page.waitForFunction((sel) => {
      const row = document.querySelector(sel);
      return row && !/Preparing|Waiting|recognition/i.test(row.textContent || '');
    }, rowSel, { timeout: 120000, polling: 1000 });

    const connectSrcViolations = consoleErrors.filter((m) => /connect-src/i.test(m));
    const dataUrlFetches = consoleErrors.filter((m) => /data:application/i.test(m));
    check('zero console errors during OCR', consoleErrors.length === 0, JSON.stringify(consoleErrors));
    check('zero connect-src violations', connectSrcViolations.length === 0, connectSrcViolations.length);
    check('zero data: URL fetch attempts', dataUrlFetches.length === 0, dataUrlFetches.length);
  } finally {
    await context.close();
  }
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FAIL - script error:', e.message); process.exit(1); });
