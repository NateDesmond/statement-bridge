// Item 10 verification: drops the private SC CSV and DBS PDF onto the REAL
// unpacked extension (bundled Chromium only), opens "Report a problem", and
// reads the exact report text - asserting it is counts/structure only, never
// a transaction, amount, date, account number or file name. Prints only
// PASS/FAIL lines and counts, never any report text itself.
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const privateDir = path.join(extensionPath, 'test', 'private');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail !== undefined ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-report-privacy-'));
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
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = sw.url().split('/')[2];
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extId}/workspace.html`);
    await page.waitForSelector('#file-input', { state: 'attached' });

    // Item 1 (NO-TEMPLATES): nothing auto-matches on a fresh install any
    // more - each file needs the real confirm-first save (Set up -> Yes ->
    // Save) before a 'match applied' event exists for session-report.js to
    // read a detected bank/type off of, same as a real first-time user.
    for (const name of ['sc_all.csv', 'aug_2026_dbs.pdf']) {
      const input = await page.$('#file-input');
      await input.setInputFiles(path.join(privateDir, name));
      const rowSel = `.file-row[aria-label="${name}"]`;
      await page.waitForSelector(rowSel, { timeout: 20000 });
      await page.waitForFunction((sel) => {
        const row = document.querySelector(sel);
        return row && !/Cancel/.test(row.textContent || '');
      }, rowSel, { timeout: 180000, polling: 1000 });
      console.log(`dropped ${name}, settled`);

      const setupBtn = page.locator('.new-bank-card button:has-text("Set up")');
      if (await setupBtn.count()) {
        await setupBtn.click();
        await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 20000 });
        await page.waitForFunction(() => document.getElementById('confirm-a-heading')?.textContent?.trim().length > 0, { timeout: 20000 });
        await page.click('#confirm-yes');
        await page.waitForSelector('#confirm-c:not([hidden])', { timeout: 20000 });
        await page.click('#confirm-save');
        await page.waitForSelector(rowSel, { timeout: 20000 });
        console.log(`saved a statement type for ${name}`);
      }
    }

    await page.click('#report-fab');
    await page.waitForSelector('#screen-report.open');
    await page.click('#report-raw-details summary');
    await page.waitForTimeout(200);
    const reportText = await page.textContent('#report-preview');
    const parsed = JSON.parse(reportText);

    check('report has no top-level log/row array', !('log' in parsed) && !('rows' in parsed));
    check('report has a statements array', Array.isArray(parsed.statements), `count=${parsed.statements?.length}`);
    check('exactly 2 statements summarised', parsed.statements?.length === 2, parsed.statements?.length);

    const dump = JSON.stringify(parsed);
    check('no real file name in report', !dump.includes('sc_all.csv') && !dump.includes('aug_2026_dbs.pdf'));
    check('no "amount" field anywhere', !/"amount"\s*:/.test(dump));
    check('no "description" field anywhere', !/"description"\s*:/.test(dump));
    check('no decimal-amount-shaped number literal', !/\d[\d,]*\.\d{2}(?!\d)/.test(dump));
    // A DBS PDF read as savings, per item 3/9c - the report's own bank field
    // is exactly the kind of structured, non-free-text detail meant to
    // survive (never the sentence it came from).
    check('a statement reports detected bank: DBS', /detected bank: DBS/.test(dump));
    check('a statement reports type: savings', /type: savings/.test(dump));
    check('no other bank named (e.g. Northwind)', !/Northwind/i.test(dump));

    for (const s of parsed.statements || []) {
      console.log('statement summary:', s.summary);
    }
  } finally {
    await context.close();
  }
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FAIL - script error:', e.message); process.exit(1); });
