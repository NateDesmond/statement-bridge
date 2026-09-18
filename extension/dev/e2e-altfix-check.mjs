// Verifies the OCR "Use $X" alt-amount fix (low_confidence_hint caption +
// one-click apply, Review + wizard Test) against the REAL unpacked extension
// - bundled Chromium only, never the user's Chrome. No fixture in the repo
// actually trips normalize.js's amount_alt safety net (it needs a real OCR
// misread), so per the task's own fallback, a synthetic row is written
// straight into the session store (the same shape home.js's serializableFiles
// produces) and loaded through the real restore-banner flow - this exercises
// the real review.js/rowedit.js/checks.js modules, not a mock.
//
// Run with: node dev/e2e-altfix-check.mjs
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

// normalize.js's real shape (see OCR_LOW_CONFIDENCE_THRESHOLD's doc comment):
// `amount` is the flagged, decimal-dropped OCR read (here "173" misread with
// no decimal point, parsed as 173.00 -> -17300 minor); `amount_alt` is the
// likely-correct value with the decimal restored (1.73 -> -173 minor), 100x
// smaller in minor units. Coordinator catch (2026-09-17): the first version
// of this fixture had the two swapped, which made "Use $X" render the
// ALREADY-FLAGGED value back at the user instead of the fix.
const syntheticRow = {
  row_id: 'ocr-1:0',
  date: '2026-09-10',
  date_raw: '10 Sep 2026',
  description_raw: 'NETS PAYMENT MERCHANT',
  amount: -17300,
  amount_alt: -173,
  currency: 'SGD',
  flags: ['ocr', 'low_confidence_ocr'],
  low_confidence_hint: 'Amount read as 173 with no decimal point. Likely 1.73. Check against the page.',
  skipped: false,
  excluded: false,
  edited: false,
  original: {},
};
const cleanRow = {
  row_id: 'ocr-1:1', date: '2026-09-09', date_raw: '9 Sep 2026', description_raw: 'SALARY',
  amount: 500000, currency: 'SGD', flags: ['ocr'], skipped: false, excluded: false, edited: false, original: {},
};

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-altfix-'));
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
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`chrome-extension://${extId}/workspace.html`, { waitUntil: 'load' });
    await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });

    // Write the synthetic session directly into the same IndexedDB
    // home.js's own sessions.js uses, then reload so the real
    // restore-banner flow loads it into state.files.
    await page.evaluate(({ rows }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('statement-bridge', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('sessions')) {
          req.result.createObjectStore('sessions', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put({ id: 'current', files: [{ name: 'ocr-statement.pdf', rows } ] });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }), { rows: [syntheticRow, cleanRow] });

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
    await page.waitForSelector('#restore-banner:not([hidden])', { timeout: 10000 });
    await page.click('#restore-yes');
    await page.waitForTimeout(300);

    // --- Review screen ------------------------------------------------
    await page.click('button[data-screen="review"]');
    await page.waitForSelector('#review-body:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(300);

    const flaggedRowText = await page.$eval(
      'tr[data-row-id="ocr-1:0"] td:nth-child(2)',
      (td) => td.textContent.trim(),
    );
    check(
      'Review row caption shows the specific low_confidence_hint text, not the generic label',
      flaggedRowText.includes('Amount read as 173 with no decimal point. Likely 1.73.'),
      flaggedRowText,
    );
    const useBtnText = await page.$eval(
      'tr[data-row-id="ocr-1:0"] button[data-act="use-alt"]',
      (b) => b.textContent.trim(),
    ).catch(() => null);
    // Coordinator catch: amount_alt (-173 minor) must render as "-1.73" via
    // formatMinorDisplay, not "-173.00" (which would be amount_alt read as
    // if it were already major units, or amount/amount_alt swapped).
    check('Review row has a "Use -1.73" one-click button', useBtnText === 'Use -1.73', useBtnText);

    await page.screenshot({ path: path.join(shotsDir, 'altfix-review-before.png') });

    await page.click('tr[data-row-id="ocr-1:0"] button[data-act="use-alt"]');
    await page.waitForTimeout(200);
    const afterAmount = await page.$eval('tr[data-row-id="ocr-1:0"] td:nth-child(3)', (td) => td.textContent.trim());
    check('Clicking Use applies amount_alt (-1.73 SGD)', afterAmount === '-1.73 SGD', afterAmount);
    const stillHasUseBtn = await page.$('tr[data-row-id="ocr-1:0"] button[data-act="use-alt"]');
    check('Use button is gone after applying (flag cleared)', !stillHasUseBtn);
    const rowClasses = await page.$eval('tr[data-row-id="ocr-1:0"]', (tr) => tr.className);
    check('row now shows the edited marker', rowClasses.includes('edited'), rowClasses);

    await page.screenshot({ path: path.join(shotsDir, 'altfix-review-after.png') });

    // Edit's amount input should pre-fill from amount_alt on the OTHER
    // (still-flagged) row - re-seed a fresh flagged row to check Edit
    // pre-fill independent of the just-applied fix above.
    await page.evaluate(({ rows }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('statement-bridge', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put({ id: 'current', files: [{ name: 'ocr-statement.pdf', rows } ] });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }), { rows: [syntheticRow, cleanRow] });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#restore-banner:not([hidden])', { timeout: 10000 });
    await page.click('#restore-yes');
    await page.click('button[data-screen="review"]');
    await page.waitForSelector('#review-body:not([hidden])', { timeout: 10000 });
    await page.click('tr[data-row-id="ocr-1:0"] button[data-act="edit"]');
    await page.waitForTimeout(150);
    const editAmountVal = await page.$eval('tr[data-row-id="ocr-1:0"] .edit-amount', (i) => i.value);
    check('Edit amount input pre-fills with amount_alt (-1.73)', editAmountVal === '-1.73', editAmountVal);
    await page.screenshot({ path: path.join(shotsDir, 'altfix-review-edit-prefill.png') });
  } finally {
    console.log(failures ? `${failures} FAILURE(S)` : 'all checks passed');
    await context.close();
    process.exitCode = failures ? 1 : 0;
  }
}

main();
