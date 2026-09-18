// Real-files e2e (release gate item 5): drives the REAL unpacked extension
// (bundled Chromium only, never the user's Chrome, never channel:'chrome')
// against the private statements listed in test/private/manifest.json -
// never test/fixtures/ synthetics. Numbers only: no transaction text, no
// account digits, no descriptions are ever printed by this script.
//
// Only runs when both test/private/ and test/private/manifest.json exist -
// dev/gate.mjs is what decides that; this script also no-ops cleanly if run
// standalone without them. manifest.json (gitignored, never committed) shape:
//   {
//     "files": [
//       { "name": "my_savings.csv", "expectRowCount": 205, "expectProfileContains": "savings" },
//       { "name": "my_card.csv", "expectRowCount": 310 },
//       { "name": "my_statement.pdf", "expectRowCount": 31, "expectProfileContains": "PDF", "timeoutMs": 180000 }
//     ]
//   }
// Every field but "name" is optional; omit expectRowCount/expectProfileContains
// to just smoke-test that the file settles to a healthy or reviewable badge.
//
// Run with: node dev/e2e-real-files.mjs   (dev server not needed - this
// loads the extension directly, like e2e-extension/review/presets.mjs do)
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const privateDir = path.join(extensionPath, 'test', 'private');
const manifestPath = path.join(privateDir, 'manifest.json');

if (!fs.existsSync(privateDir) || !fs.existsSync(manifestPath)) {
  console.log('test/private/manifest.json not found - skipping (nothing to run this checks against).');
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const files = Array.isArray(manifest.files) ? manifest.files : [];
if (files.length === 0) {
  console.log('test/private/manifest.json has no files listed - skipping.');
  process.exit(0);
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail !== undefined ? ` (${detail})` : ''}`);
  if (!ok) failures++;
  return ok;
}

/** Drop one file onto Home and wait for its row to leave a transient state (Preparing/Waiting/OCR-running). Returns {badgeTone, rowsText, profileName} read straight off that file's own row (aria-label = original filename, stable across a match). */
async function dropAndSettle(page, fileName, { timeout = 120000 } = {}) {
  const filePath = path.join(privateDir, fileName);
  await page.$('#file-input').then((el) => el.setInputFiles(filePath));
  const rowSel = `.file-row[aria-label="${fileName}"]`;
  await page.waitForSelector(rowSel, { timeout: 15000 });
  await page.waitForFunction(
    (sel) => {
      const row = document.querySelector(sel);
      if (!row) return false;
      const badge = row.querySelector('.badge');
      const fr = row.querySelector('.fr-line');
      const transientText = fr ? fr.textContent : '';
      if (/Preparing|Waiting for text recognition|Reading page/.test(transientText)) return false;
      return !!badge;
    },
    rowSel,
    { timeout },
  );
  return page.$eval(rowSel, (row) => {
    const badge = row.querySelector('.badge');
    return {
      badgeTone: badge ? [...badge.classList].find((c) => c.startsWith('badge-'))?.replace('badge-', '') : null,
      badgeLabel: badge ? badge.textContent.trim() : null,
      rowCount: row.dataset.rowCount ? Number(row.dataset.rowCount) : null,
      warnCount: row.dataset.warnCount ? Number(row.dataset.warnCount) : null,
      fileType: row.dataset.fileType || null,
      profileName: row.dataset.profileName || null,
      accountLabel: row.querySelector('.fr-name')?.textContent.trim() || null,
      captionText: [...row.querySelectorAll('.fr-caption')].map((c) => c.textContent.trim()).join(' | '),
    };
  });
}

async function readExportComposition(page) {
  return page.evaluate(async () => {
    const mod = await import('./src/core/debuglog.js');
    const entries = mod.all().filter((e) => e.stage === 'home.export' && e.message === 'export composition');
    const last = entries[entries.length - 1];
    return last ? { rows: last.data.rows, accounts: last.data.accounts } : null;
  });
}

async function countOcrJobs(page) {
  return page.evaluate(async () => {
    const mod = await import('./src/core/debuglog.js');
    return mod.all().filter((e) => e.stage === 'ocr' && e.message === 'starting document OCR').length;
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-realfiles-'));
  const context = await chromium.launchPersistentContext(tmpDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    console.log('extension id:', extId);

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => { pageErrors.push(e); console.log('[pageerror]', e.message); });
    await page.goto(`chrome-extension://${extId}/workspace.html`);
    await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });

    const results = [];
    for (const f of files) {
      console.log(`${results.length + 1}. ${f.name}...`);
      const info = await dropAndSettle(page, f.name, { timeout: f.timeoutMs || 120000 });
      if (f.expectProfileContains) {
        check(`${f.name} matches a profile containing "${f.expectProfileContains}"`, !!info.profileName && info.profileName.includes(f.expectProfileContains), info.profileName);
      }
      if (typeof f.expectRowCount === 'number') {
        check(`${f.name} yields ${f.expectRowCount} rows`, info.rowCount === f.expectRowCount, info.rowCount);
      }
      const hasWarn = info.badgeTone === 'warn' && info.warnCount > 0;
      check(`${f.name} shows a healthy status or a real "needs a quick look" one`, info.badgeTone === 'ok' || hasWarn, `badge=${info.badgeLabel} warnCount=${info.warnCount}`);
      results.push(info);
    }

    console.log('snapshotting export composition + OCR job count before re-drop...');
    const composition1 = await readExportComposition(page);
    const ocrJobs1 = await countOcrJobs(page);

    console.log('re-dropping all files...');
    for (const f of files) await dropAndSettle(page, f.name, { timeout: f.timeoutMs || 120000 });

    const composition2 = await readExportComposition(page);
    const ocrJobs2 = await countOcrJobs(page);
    check('row counts unchanged after re-drop', !!composition1 && !!composition2 && composition1.rows === composition2.rows, `${composition1?.rows} -> ${composition2?.rows}`);
    check('export composition (accounts) unchanged after re-drop', !!composition1 && !!composition2 && composition1.accounts === composition2.accounts, `${composition1?.accounts} -> ${composition2?.accounts}`);
    check('OCR job count unchanged after re-drop (exact re-drop should not re-OCR)', ocrJobs2 === ocrJobs1, `${ocrJobs1} -> ${ocrJobs2}`);

    const cleanLog = await assertCleanLog(page, 'real-files e2e', pageErrors);
    if (!cleanLog.ok) failures++;

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  } finally {
    await context.close();
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
