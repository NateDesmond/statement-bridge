// Gate item 4/5: a stale/broken USER
// profile can tie a built-in on signature score and still win by list order,
// even when its own mapping silently produces no usable amounts (or, item
// 5's second scenario, an old profile version whose headerRow/dateFormat
// drifted out of date). This seeds chrome.storage.local with such a profile
// via the extension page BEFORE dropping the fixture, then asserts the
// working built-in wins on extraction quality, the row count is right, the
// explanatory caption names the losing profile, and Copy for Sheets carries
// an amount on every row.
//
// Real unpacked extension, bundled Chromium only (never the user's Chrome,
// never channel:'chrome'), test/fixtures/ synthetics only.
//
// Run with: node dev/e2e-stale-profile.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail !== undefined ? ` (${detail})` : ''}`);
  if (!ok) failures++;
  return ok;
}

// Same signatures as builtin-sc-credit-card-v1 (so it really ties on
// score), but amount mapped to the sparse "Foreign Currency Amount" column -
// the exact stale-suggester shape a real broken profile once carried.
const poisonedScProfile = {
  schemaVersion: 1, id: 'user-sc-test', bank: 'Lattice Bank', statementType: 'credit_card', fileType: 'csv',
  country: 'SG', defaultCurrency: 'SGD', name: 'sc test', builtIn: false,
  versions: [{
    id: 'user-sc-test-v1', createdAt: '2026-09-10T00:00:00Z',
    signatures: {
      headerText: ['Date', 'DESCRIPTION', 'Foreign Currency Amount', 'SGD Amount'],
      preambleKeywords: ['Transaction History:', 'LATTICE PLATINUM CARD'],
      pdfAnchors: [], filenamePattern: '',
    },
    csv: { encoding: 'auto', delimiter: 'auto', headerRow: 2, skipRowsBefore: 2, footerRules: [], ignoreRowRules: [] },
    fields: {
      date: { source: 'Date' },
      description_raw: { source: ['DESCRIPTION'] },
      amount: { source: 'Foreign Currency Amount' }, // the bug: almost every row is blank here
      currency: { mode: 'profileDefault' },
    },
    dateFormat: 'DD/MM/YYYY',
    signConvention: 'crdr',
    pendingPrefix: '[UNPOSTED]',
  }],
};

// Item 5: a second, generalised scenario - an OLD version of a Meridian Bank savings
// profile whose headerRow drifted off by one (points at the "Meridian Bank"
// preamble line instead of the real header) and whose dateFormat is wrong.
// Same signatures as builtin-dbs-savings-v1, so it still ties on score.
const staleDbsProfile = {
  schemaVersion: 1, id: 'user-dbs-old', bank: 'Meridian Bank', statementType: 'savings', fileType: 'csv',
  country: 'SG', defaultCurrency: 'SGD', name: 'My Meridian Bank savings (old)', builtIn: false,
  versions: [{
    id: 'user-dbs-old-v1', createdAt: '2026-07-01T00:00:00Z',
    signatures: {
      headerText: ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount', 'Balance'],
      preambleKeywords: ['Meridian Bank', 'Account Details For'],
      pdfAnchors: [], filenamePattern: '',
    },
    // headerRow off by one (index 3, "Meridian Bank" - a single stray cell,
    // not the real header at index 4) and a wrong dateFormat.
    csv: { encoding: 'auto', delimiter: 'auto', headerRow: 3, skipRowsBefore: 3, footerRules: [{ type: 'startsWith', value: 'Total' }], ignoreRowRules: [] },
    fields: {
      date: { source: 'Transaction Date' },
      description_raw: { source: ['Reference', 'Transaction Ref'], join: ' ' },
      amount: { debit: 'Debit Amount', credit: 'Credit Amount' },
      balance: { source: 'Balance' },
      currency: { mode: 'profileDefault' },
    },
    dateFormat: 'MM/DD/YYYY', // wrong (real export is DD/MM/YYYY)
    signConvention: 'debitCredit',
  }],
};

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-stale-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    executablePath: chromium.executablePath ? chromium.executablePath() : undefined,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e); console.log('[pageerror]', e.message); });
  await page.addInitScript(() => {
    window.__clipboardWrites = [];
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => { window.__clipboardWrites.push(text); return real(text); };
  });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page, pageErrors };
}

/** Seeds chrome.storage.local's 'profiles' key with just the poisoned profile - loadProfiles merges in the real builtins by id on its first call (profiles.js's mergeBuiltinUpdates), so this never has to hand-copy every builtin. */
async function seedPoisonedProfile(page, profile) {
  await page.evaluate(async (p) => {
    await chrome.storage.local.set({ profiles: [p] });
  }, profile);
}

async function dropAndSettle(page, fileName, { timeout = 30000 } = {}) {
  const filePath = path.join(fixturesDir, fileName);
  await page.$('#file-input').then((el) => el.setInputFiles(filePath));
  const rowSel = `.file-row[aria-label="${fileName}"]`;
  await page.waitForSelector(rowSel, { timeout: 15000 });
  await page.waitForFunction((sel) => {
    const row = document.querySelector(sel);
    if (!row) return false;
    return !!row.querySelector('.badge');
  }, rowSel, { timeout });
  return page.$eval(rowSel, (row) => {
    const badge = row.querySelector('.badge');
    return {
      badgeTone: badge ? [...badge.classList].find((c) => c.startsWith('badge-'))?.replace('badge-', '') : null,
      badgeLabel: badge ? badge.textContent.trim() : null,
      // Simple B's row heading is the account, not the profile's own mapping
      // name (fix item 1) - row.dataset.profileName/rowCount are the plain
      // internal hooks home.js sets for exactly this kind of check, never
      // rendered as visible text.
      rowCount: row.dataset.rowCount ? Number(row.dataset.rowCount) : null,
      profileName: row.dataset.profileName || null,
      captionText: [...row.querySelectorAll('.fr-caption')].map((c) => c.textContent.trim()).join(' | '),
    };
  });
}

async function copyForSheetsAndCheckAmounts(page, { skipHeaderRows = 1 } = {}) {
  await page.click('#copy-tsv-btn');
  await page.waitForTimeout(400);
  const writes = await page.evaluate(() => window.__clipboardWrites);
  let clipText = writes[writes.length - 1] || '';
  if (!clipText) {
    try { clipText = await page.evaluate(() => navigator.clipboard.readText()); } catch { /* no permission */ }
  }
  const lines = clipText.split(/\r\n/).filter(Boolean);
  const header = (lines[0] || '').split('\t');
  const amountIdx = header.findIndex((h) => h.trim().toLowerCase() === 'amount');
  const dataRows = lines.slice(skipHeaderRows);
  const missing = dataRows.filter((l) => {
    const v = l.split('\t')[amountIdx];
    return v === undefined || v.trim() === '';
  });
  return { totalDataRows: dataRows.length, missingAmountRows: missing.length, amountColFound: amountIdx !== -1 };
}

// --- Scenario 1 (item 4): the exact SC "sc test" bug -----------------------
async function scenarioSc() {
  console.log('\n=== e2e-stale-profile: SC credit card, poisoned "sc test" profile ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  try {
    await seedPoisonedProfile(page, poisonedScProfile);
    const info = await dropAndSettle(page, 'lattice_card_tabbed.csv');
    console.log('   result:', JSON.stringify(info));

    check('the built-in Lattice Bank profile wins, not the poisoned "sc test"', info.profileName === 'Lattice Bank credit card, CSV', info.profileName);
    check('a healthy (ok) badge, not a warning/failure from the poisoned profile', info.badgeTone === 'ok', `badge=${info.badgeLabel}`);
    check('all 6 real transactions extracted', info.rowCount === 6, info.rowCount);
    check(
      'the row explains that \'sc test\' lost and offers to fix/delete it',
      /Used '.*Lattice Bank.*'\..*'sc test'.*could not read amounts/.test(info.captionText) && /Fix or delete/.test(info.captionText),
      info.captionText,
    );

    const copy = await copyForSheetsAndCheckAmounts(page);
    check('Copy for Sheets has the Amount column', copy.amountColFound);
    check('Copy for Sheets has an amount on every row', copy.totalDataRows > 0 && copy.missingAmountRows === 0, JSON.stringify(copy));

    const cleanLog = await assertCleanLog(page, 'stale-profile e2e (SC scenario)', pageErrors);
    if (!cleanLog.ok) failures++;
  } finally {
    await context.close();
  }
}

// --- Scenario 2 (item 5): generalised - an old Meridian Bank profile version --------
async function scenarioDbs() {
  console.log('\n=== e2e-stale-profile: Meridian Bank savings, stale old profile version ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  try {
    await seedPoisonedProfile(page, staleDbsProfile);
    const info = await dropAndSettle(page, 'meridian_savings.csv');
    console.log('   result:', JSON.stringify(info));

    check('the built-in Meridian Bank savings profile wins, not the stale old version', info.profileName === 'Meridian Bank savings, CSV', info.profileName);
    check('a healthy (ok) badge, not a warning/failure from the stale profile', info.badgeTone === 'ok', `badge=${info.badgeLabel}`);
    check(
      'the row explains that the stale Meridian Bank profile lost and offers to fix/delete it',
      /Used '.*Meridian Bank savings.*'\..*'My Meridian Bank savings \(old\)'.*could not read amounts/.test(info.captionText) && /Fix or delete/.test(info.captionText),
      info.captionText,
    );

    const cleanLog = await assertCleanLog(page, 'stale-profile e2e (Meridian Bank scenario)', pageErrors);
    if (!cleanLog.ok) failures++;
  } finally {
    await context.close();
  }
}

async function main() {
  await scenarioSc();
  await scenarioDbs();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
