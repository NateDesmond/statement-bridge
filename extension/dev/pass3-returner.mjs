// Pass 3 / persona 2 (returning user, month two) driver for audit/INDIE-STANDARD.md.
// Real unpacked extension, bundled Chromium only. Screenshots -> audit/pass3/returner-*.png at 1440.
// Uses a FIXED userDataDir (not mkdtemp) so profile/storage persists across
// separate node invocations - this is what lets "close and reopen the tab"
// and the later monthly-path phase see the profiles set up earlier.
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(extensionPath, '..', 'audit', 'pass3');
fs.mkdirSync(shotsDir, { recursive: true });
const profileDir = '/private/tmp/claude-501/-Users-nathanaeldesmond2026/35c3bf4d-36a1-47b4-868f-fd6901a59a2c/scratchpad/sb-pass3-profile';
fs.mkdirSync(profileDir, { recursive: true });
const logPath = '/private/tmp/claude-501/-Users-nathanaeldesmond2026/35c3bf4d-36a1-47b4-868f-fd6901a59a2c/scratchpad/pass3-log.json';

const phase = process.argv[2];
let clicks = 0;
const t0 = Date.now();
function seconds() { return ((Date.now() - t0) / 1000).toFixed(1); }
function appendLog(entry) {
  const cur = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
  cur.push(entry);
  fs.writeFileSync(logPath, JSON.stringify(cur, null, 2));
}

async function launch() {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromium.executablePath(),
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
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page, extensionId };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(shotsDir, `returner-${name}.png`), fullPage: true });
}
async function click(page, selector) {
  await page.click(selector);
  clicks++;
}
async function dropFile(page, fixturePathOrArr) {
  await page.$('#file-input').then((el) => el.setInputFiles(fixturePathOrArr));
}
async function openWizard(page) {
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, #attention-cards button:has-text("Set up")', { timeout: 60000 });
  const mapBtn = await page.$('#attention-cards button:has-text("Set up")');
  if (mapBtn) { await mapBtn.click(); clicks++; }
  else { await click(page, '#change-link'); await page.waitForSelector('#accounts-table-body tr'); await click(page, '#accounts-table-body a:has-text("Set up again")'); }
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
}
async function advanceWizardTo(page, stepIndex, maxClicks = 6) {
  for (let i = 0; i < maxClicks; i++) {
    if (await page.$(`#step-${stepIndex}.active`)) return true;
    if (!(await page.$('#screen-wizard.active'))) return false;
    await click(page, '#wizard-next');
    await page.waitForTimeout(400);
  }
  return !!(await page.$(`#step-${stepIndex}.active`));
}
async function waitCopyEnabled(page, timeout = 90000) {
  function isCopyReady() {
    const btn = document.querySelector('#copy-tsv-btn');
    const panel = document.querySelector('#export-panel');
    const notDone = [...document.querySelectorAll('.file-row')].some((r) => /Reading|Needs confirmation|Waiting for|Set up/i.test(r.textContent));
    return !!(btn && panel && !panel.hidden && !btn.disabled && !notDone);
  }
  const deadline = Date.now() + timeout;
  for (;;) {
    await page.waitForFunction(isCopyReady, { timeout: Math.max(1000, deadline - Date.now()) });
    await page.waitForTimeout(250);
    if (await page.evaluate(isCopyReady)) return;
    if (Date.now() > deadline) throw new Error('waitCopyEnabled: never stayed ready');
  }
}

async function main() {
  const { context, page } = await launch();
  try {
    if (phase === 'setup-csv') {
      // Set up the unknown-bank CSV via confirm-first -> Screen B -> Something else -> Map fields (manual).
      const fixture = path.join(fixturesDir, 'generic_unknown_bank.csv');
      await dropFile(page, fixture);
      await openWizard(page);
      await shot(page, '01-csv-confirm-a');
      const yesDisabled = await page.$eval('#confirm-yes', (b) => b.disabled).catch(() => null);
      appendLog({ phase, note: 'confirm-a yesDisabled', yesDisabled });
      if (yesDisabled) {
        await click(page, '#confirm-off');
        await page.waitForTimeout(200);
        await shot(page, '02-csv-confirm-b');
        await click(page, '#confirm-fix-other');
        await page.waitForSelector('#step-2.active', { timeout: 8000 });
        await shot(page, '03-csv-map-fields-unmapped');
        const selects = await page.$$('#w-mapping-table select.map-select');
        await selects[0].selectOption('date');
        await selects[1].selectOption('description_raw');
        clicks += 2;
        await page.waitForTimeout(200);
        await shot(page, '04-csv-map-fields-mapped');
      } else {
        await click(page, '#confirm-yes');
        await page.waitForTimeout(300);
        await shot(page, '02b-csv-confirm-c');
        await click(page, '#confirm-save');
        await page.waitForTimeout(800);
      }
      // Advance to Save if still in full wizard.
      if (await page.$('#screen-wizard.active')) {
        await advanceWizardTo(page, 4);
        await shot(page, '05-csv-save-step');
        await click(page, '#wizard-next');
        await page.waitForTimeout(800);
      }
      await shot(page, '06-csv-home-after-save');
      appendLog({ phase, clicksSoFar: clicks, seconds: seconds() });
    } else if (phase === 'setup-pdf') {
      const fixture = path.join(fixturesDir, 'summit_grouped_2line_image.pdf');
      await dropFile(page, fixture);
      await openWizard(page);
      await shot(page, '10-pdf-confirm-a');
      const heading = await page.textContent('#confirm-a-heading').catch(() => null);
      const yesDisabled = await page.$eval('#confirm-yes', (b) => b.disabled).catch(() => null);
      appendLog({ phase, heading, yesDisabled });
      if (yesDisabled) {
        await click(page, '#confirm-off');
        await page.waitForTimeout(200);
        await shot(page, '11-pdf-confirm-b');
        const opts = await page.$$eval('#screen-confirm-b button, #confirm-b button', (btns) => btns.map((b) => b.textContent.trim())).catch(() => []);
        appendLog({ phase, screenBOptions: opts });
        await click(page, '#confirm-fix-other');
        await page.waitForSelector('#step-2.active, #screen-wizard.active', { timeout: 8000 }).catch(() => {});
        await shot(page, '12-pdf-map-fields');
        await advanceWizardTo(page, 4);
        await shot(page, '13-pdf-save-step');
        await click(page, '#wizard-next');
        await page.waitForTimeout(800);
      } else {
        await click(page, '#confirm-yes');
        await page.waitForTimeout(300);
        await shot(page, '11b-pdf-confirm-c');
        await click(page, '#confirm-save');
        await page.waitForTimeout(800);
      }
      await shot(page, '14-pdf-home-after-save');
      appendLog({ phase, clicksSoFar: clicks, seconds: seconds() });
    } else if (phase === 'reopen-check') {
      // "Close and reopen the tab": this is a fresh node invocation against
      // the same persistent profileDir, i.e. a fresh tab/context reading
      // the same extension storage - the strongest form of "reopened".
      await shot(page, '20-reopened-home');
      const rows = await page.$$eval('.file-row', (els) => els.map((e) => e.innerText.replace(/\n/g, ' | '))).catch(() => []);
      appendLog({ phase, rowsAfterReopen: rows });
    } else if (phase === 'monthly-path') {
      // NEW copies of both custom fixtures, renamed + CSV dates pushed one
      // month later (image PDF: renamed only, dates baked into the scan
      // image can't be edited without re-rastering), plus one builtin fixture.
      const csvSrc = fs.readFileSync(path.join(fixturesDir, 'generic_unknown_bank.csv'), 'utf8');
      const csvNextMonth = csvSrc.replace(/(\d{2})\/(\d{2})\/2026/g, (m, d, mo) => `${d}/${String(Number(mo) + 1).padStart(2, '0')}/2026`);
      const csvOct = path.join(profileDir, 'generic_unknown_bank_october.csv');
      fs.writeFileSync(csvOct, csvNextMonth);
      const pdfOct = path.join(profileDir, 'summit_grouped_2line_image_october.pdf');
      fs.copyFileSync(path.join(fixturesDir, 'summit_grouped_2line_image.pdf'), pdfOct);
      const builtin = path.join(fixturesDir, 'meridian_savings.csv'); // builtin, auto-matches with zero setup

      const dropAt = Date.now();
      await dropFile(page, [csvOct, pdfOct, builtin]);
      await waitCopyEnabled(page, 90000);
      const readySec = ((Date.now() - dropAt) / 1000).toFixed(1);
      await shot(page, '30-monthly-all-ready');
      const rowTexts = await page.$$eval('.file-row', (els) => els.map((e) => e.innerText.replace(/\n/g, ' | ')));
      appendLog({ phase, readySeconds: readySec, clicksToReady: clicks, rowTexts });

      await click(page, '#copy-tsv-btn');
      await page.waitForTimeout(400);
      await shot(page, '31-monthly-after-copy');
      appendLog({ phase, clicksAfterCopy: clicks, secondsAfterCopy: seconds() });

      // Confirm "Since last export" appears and works after the first copy.
      await click(page, '#change-link');
      await page.waitForSelector('#range-chip-row');
      await shot(page, '32-change-drawer-range-chips');
      const chipLabels = await page.$$eval('#range-chip-row .chip', (els) => els.map((e) => e.textContent.trim()));
      const sinceChip = await page.$('#range-chip-row button:has-text("Since last export")');
      appendLog({ phase, chipLabels, sinceLastExportPresent: !!sinceChip });
      if (sinceChip) {
        await sinceChip.click();
        clicks++;
        await page.waitForTimeout(300);
        await shot(page, '33-since-last-export-applied');
        const overlapText = await page.textContent('#since-export-overlap').catch(() => null);
        appendLog({ phase, sinceLastExportOverlapNote: overlapText });
      }
      appendLog({ phase, finalClicks: clicks, finalSeconds: seconds() });
    } else if (phase === 'layout-changed') {
      // Rename a header in a fresh copy of the custom CSV profile - keeps
      // the amount/description columns intact but the date header no longer
      // matches "When" exactly, forcing formatChanged (Update mapping),
      // same technique e2e-extension.mjs's map5 scenario uses for a builtin.
      const csvSrc = fs.readFileSync(path.join(fixturesDir, 'generic_unknown_bank.csv'), 'utf8');
      const changed = csvSrc.replace('When,What,Value', 'Whn,What,Value');
      const changedPath = path.join(profileDir, 'generic_unknown_bank_layoutchanged.csv');
      fs.writeFileSync(changedPath, changed);
      await dropFile(page, changedPath);
      await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, #attention-cards button, button:has-text("Set up again")', { timeout: 60000 });
      await shot(page, '40-layout-changed-home');
      const rowText = await page.$$eval('.file-row', (els) => els.map((e) => e.innerText.replace(/\n/g, ' | ')));
      appendLog({ phase, layoutChangedRowText: rowText });
      const updateBtn = await page.$('button:has-text("Set up again")') || await page.$('#screen-home button:has-text("Set up again")');
      appendLog({ phase, updateBtnFound: !!updateBtn });
      if (updateBtn) {
        await updateBtn.click(); clicks++;
        await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
        await shot(page, '41-layout-changed-wizard-open');
      }
    } else if (phase === 're-drop') {
      // Drop the exact same October CSV+PDF again (already exported) - a
      // no-reason interruption here (re-asking for setup, re-showing the
      // wizard) is itself a defect per the task brief.
      const csvOct = path.join(profileDir, 'generic_unknown_bank_october.csv');
      const pdfOct = path.join(profileDir, 'summit_grouped_2line_image_october.pdf');
      const t0redrop = Date.now();
      await dropFile(page, [csvOct, pdfOct]);
      await waitCopyEnabled(page, 90000);
      const redropSec = ((Date.now() - t0redrop) / 1000).toFixed(1);
      await shot(page, '50-re-drop-same-files');
      await shot(page, '51-re-drop-final');
      const rowText = await page.$$eval('.file-row', (els) => els.map((e) => e.innerText.replace(/\n/g, ' | ')));
      appendLog({ phase, redropSeconds: redropSec, redropRowText: rowText });
    }
  } finally {
    await context.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
