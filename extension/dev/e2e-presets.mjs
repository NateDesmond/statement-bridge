// Verifies the export column-layout rework (REBUILD-HOME item 7, 2026-09-18)
// against the REAL unpacked extension (bundled Chromium only, never the
// user's Chrome): drop the Northwind Bank image-only PDF fixture (auto-OCR
// against the built-in "Northwind Bank savings, Transaction History PDF"
// profile, which has an extra_type "Type" column), open the Home Change
// drawer's layout cards + Customise pills, enable Type, screenshot the
// editor + preview, Copy for Sheets, and assert the clipboard TSV carries
// the Type column.
//
// Run with: NODE_PATH=<a node_modules with playwright + cached chromium> node dev/e2e-presets.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';
import { gotoScreen, goBack } from './lib/nav.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-presets-'));
  const context = await chromium.launchPersistentContext(tmpDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
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
    // Capture navigator.clipboard.writeText calls too, in case the toast/copy
    // path races the clipboard permission grant in this headed context.
    await page.addInitScript(() => {
      window.__clipboardWrites = [];
      const real = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text) => { window.__clipboardWrites.push(text); return real(text); };
    });
    await page.goto(`chrome-extension://${extId}/workspace.html`);
    await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });

    const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_image.pdf');
    const input = await page.$('#file-input');
    await input.setInputFiles(fixture);

    console.log('1. waiting for OCR + match...');
    await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, button:has-text("Read it with on-device text recognition")', { timeout: 30000 });
    const ocrBtn = await page.$('button:has-text("Read it with on-device text recognition")');
    if (ocrBtn) {
      await ocrBtn.click();
      await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 60000 });
    }
    await page.waitForTimeout(500);

    console.log('2. opening Edit export settings (Change drawer)...');
    await page.click('#change-link');
    await page.waitForSelector('#home-preset-editor .layout-cards', { timeout: 10000 });
    await page.waitForTimeout(300);

    const beforeShot = path.join(shotsDir, 'preset2-01-drawer-before.png');
    await page.screenshot({ path: beforeShot, fullPage: true });
    console.log('   screenshot:', beforeShot);

    // Item 7: six layout radio cards, none of which include Type by default.
    const layoutCardNames = await page.$$eval('#home-preset-editor .layout-card .layout-card-name', (els) => els.map((e) => e.textContent));
    check('Six layout cards are offered', layoutCardNames.length === 6, layoutCardNames.join(','));

    // Choose "With balance" (has Account, needed by the checks below) before
    // customising - picking a layout resets columns to its own shape.
    const withBalanceIdx = layoutCardNames.indexOf('With balance');
    const layoutCards = await page.$$('#home-preset-editor .layout-card');
    await layoutCards[withBalanceIdx].click();
    await page.waitForTimeout(300);

    console.log('3. Customise: enabling extra_type...');
    await page.click('#home-preset-editor .columns-customise summary');
    // Type should be listed as a pill (it has real OCR'd data this session)
    // but not enabled yet (no built-in layout includes it).
    const typePill = page.locator('#home-preset-editor .column-pill', { has: page.locator('.column-pill-label', { hasText: /^Type$/ }) });
    check('Type (extra_type) is offered as a Customise pill', await typePill.count() === 1, String(await typePill.count()));
    check('Type pill starts unselected', !(await typePill.evaluate((el) => el.classList.contains('enabled'))), '');
    // renderPresetEditor fully re-renders the container on every onChange (a
    // controlled component, like review.js), so the pill node is replaced the
    // instant it's clicked - re-query fresh state after, never the old handle.
    await typePill.click({ force: true, noWaitAfter: true });
    await page.waitForTimeout(300);

    const enabledPillLabels = await page.$$eval('#home-preset-editor .column-pill.enabled .column-pill-label', (els) => els.map((e) => e.textContent));
    check('Type moved into the enabled pills after toggling on', enabledPillLabels.includes('Type'), enabledPillLabels.join(','));
    check('Account is on the export too ("With balance" layout)', enabledPillLabels.includes('Account'), enabledPillLabels.join(','));

    const afterShot = path.join(shotsDir, 'preset2-02-drawer-after-enable.png');
    await page.screenshot({ path: afterShot, fullPage: true });
    console.log('   screenshot:', afterShot);

    const previewText = await page.$eval('#result-table .txn-table thead', (t) => t.textContent);
    check('preview header includes the Type column', previewText.includes('Type'), previewText.trim());
    // Item 1: the preview now shows the REAL export (every row Copy for
    // Sheets would produce, not a fixed 2-row sample) - it must match the
    // footer caption's count exactly (this fixture has well under 200 rows).
    const previewRows = await page.$$eval('#result-table .txn-table tbody tr', (trs) => trs.length);
    const footCaption1 = await page.$eval('#result-table .preset-preview-footcaption', (p) => p.textContent);
    check('preview shows every real export row, matching its own footer caption', previewRows > 0 && footCaption1 === `All ${previewRows} row${previewRows === 1 ? '' : 's'}`, `${previewRows} rows, caption "${footCaption1}"`);

    // Coordinator follow-up (1): the preview must render each field from the
    // row object (export.js's fieldValue), never by re-splitting buildCsv
    // text on commas - a value containing a comma (a bank/statement-type
    // account label, or any description) must land in exactly one <td>, not
    // spill into the next column.
    const accountCellCount = await page.$$eval('#result-table .txn-table tbody td[data-field="account_label"]', (tds) => tds.length);
    check('preview has exactly one td per row for account_label (a comma-containing value is not split across cells)', accountCellCount === previewRows, `got ${accountCellCount} for ${previewRows} rows`);
    const accountCellText = await page.$eval('#result-table .txn-table tbody td[data-field="account_label"]', (td) => td.textContent);

    // Coordinator follow-up (2): account_label must be "<bank> <statement
    // type> ****<last4>", never the profile's own display name.
    check('account_label is "<bank> <statement type> ****<last4>", not the profile display name', /^Northwind Bank savings \*\*\*\*\d{4}$/.test(accountCellText), accountCellText);

    const dateCellInfo = await page.$eval('#result-table .txn-table tbody td[data-field="date"]', (td) => {
      const cs = getComputedStyle(td);
      return { whiteSpace: cs.whiteSpace, width: td.getBoundingClientRect().width, lines: td.getClientRects().length };
    });
    check('Date column cell does not wrap (white-space nowrap, >=96px wide)', dateCellInfo.whiteSpace === 'nowrap' && dateCellInfo.width >= 96, JSON.stringify(dateCellInfo));

    console.log('4. Copy for Sheets...');
    // #copy-tsv-btn lives in the main export panel, not inside the drawer -
    // no need to close the drawer first.
    await page.click('#copy-tsv-btn');
    await page.waitForTimeout(500);

    const writes = await page.evaluate(() => window.__clipboardWrites);
    let clipText = writes[writes.length - 1] || '';
    if (!clipText) {
      try { clipText = await page.evaluate(() => navigator.clipboard.readText()); } catch { /* no permission */ }
    }
    const clipLines = clipText.split(/\r\n/).filter(Boolean); // buildTsv uses CRLF line endings
    check('clipboard TSV header includes Type', clipLines[0].includes('Type'), clipLines[0]);
    const typeColIdx = clipLines[0].split('\t').indexOf('Type');
    const dataTypeValues = clipLines.slice(1).filter(Boolean).map((l) => l.split('\t')[typeColIdx]);
    // Not every grouped-PDF row has a type line (a continuation/footer line
    // can legitimately leave it blank - see builtin-profiles.js's comment on
    // this profile) - the real bug being checked is that a Type value that
    // DOES exist actually reaches the export, not that every row has one.
    check('clipboard TSV carries at least one real, non-empty Type value', dataTypeValues.some((v) => v && v.trim()), dataTypeValues.join(' | '));

    console.log('5. checking Settings\' "Start from" picker...');
    await gotoScreen(page, 'settings');
    await page.waitForSelector('#pref-default-preset', { timeout: 10000 });
    // Item 7: Settings holds preferences only - the same six layouts Home's
    // drawer offers, plus "Last used" (the default). No column editor here.
    const startFromOptions = await page.$$eval('#pref-default-preset option', (els) => els.map((e) => e.textContent));
    check('"Start from" lists the six layouts plus Last used (default)', startFromOptions.length === 7 && startFromOptions[0] === 'Last used (default)', startFromOptions.join(','));
    check('Settings no longer has a column-editing checkbox list', await page.$('#preset-editor-container') === null, '');
    await page.screenshot({ path: path.join(shotsDir, 'preset2-03-settings.png'), fullPage: true });

    console.log('6. Home: a real 40-row export preview (5 visible rows, scroll, caption)...');
    await goBack(page);
    const fixture40 = path.join(extensionPath, 'test', 'fixtures', 'meridian_savings_40rows.csv');
    await (await page.$('#file-input')).setInputFiles(fixture40);
    await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 30000 });
    await page.waitForTimeout(500);
    if (!(await page.isVisible('#change-drawer'))) await page.click('#change-link');
    await page.waitForSelector('#result-table .preset-preview-scroll-live', { timeout: 10000 });
    await page.waitForTimeout(400); // clear the 100ms preview debounce

    const liveCaption = await page.$eval('#result-table .preset-preview-caption', (p) => p.textContent);
    check('Home live preview is captioned "Preview of what will be copied"', liveCaption === 'Preview of what will be copied', liveCaption);

    const footCaptionBefore = await page.$eval('#result-table .preset-preview-footcaption', (p) => p.textContent);
    check('Home preview footer caption names the row count (e.g. "All N rows")', /^All \d+ rows?$/.test(footCaptionBefore), footCaptionBefore);

    const boxMetrics = await page.evaluate(() => {
      const scroll = document.querySelector('#result-table .preset-preview-scroll-live');
      const th = scroll.querySelector('thead th');
      const td = scroll.querySelector('tbody td');
      return {
        boxHeight: scroll.getBoundingClientRect().height,
        headerHeight: th.getBoundingClientRect().height,
        rowHeight: td.getBoundingClientRect().height,
        scrollHeight: scroll.scrollHeight,
      };
    });
    const expectedBox = boxMetrics.headerHeight + 5 * boxMetrics.rowHeight;
    check('Preview box is exactly header + 5 data rows tall', Math.abs(boxMetrics.boxHeight - expectedBox) <= 1, JSON.stringify(boxMetrics));
    check('Preview box actually scrolls (more real rows than fit)', boxMetrics.scrollHeight > boxMetrics.boxHeight + 1, JSON.stringify(boxMetrics));

    const scrollA11y = await page.$eval('#result-table .preset-preview-scroll-live', (el) => ({ tabIndex: el.tabIndex, role: el.getAttribute('role'), label: el.getAttribute('aria-label') }));
    check('Preview scroll region is focusable with a role/aria-label', scrollA11y.tabIndex === 0 && !!scrollA11y.role && !!scrollA11y.label, JSON.stringify(scrollA11y));
    const thScopes = await page.$$eval('#result-table .preset-preview-scroll-live thead th', (ths) => ths.map((th) => th.getAttribute('scope')));
    check('Every preview header cell is a th[scope=col]', thScopes.length > 0 && thScopes.every((s) => s === 'col'), thScopes.join(','));

    // The drawer scrolls inside its own internal container (the page/body
    // never grows), so a fullPage screenshot would just repeat the viewport -
    // scroll the preview into view first and screenshot the drawer itself.
    await page.locator('#result-table .preset-preview-scroll-live').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shotsDir, 'preview-1440.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(150);
    await page.locator('#result-table .preset-preview-scroll-live').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shotsDir, 'preview-1280.png'), clip: { x: 0, y: 0, width: 1280, height: 900 } });
    await page.setViewportSize({ width: 1440, height: 900 });

    console.log('7. toggling an account off changes the preview row count...');
    // Item 8: the merged "Your accounts" table's Include switch - the table
    // fully re-renders on every drawer update, so a switch handle from before
    // the first click is detached by the time of a second one - re-query it
    // fresh each time rather than reusing the old handle.
    const accountSwitchSel = '#accounts-table-body .switch input[type=checkbox]';
    const accountSwitchCount = await page.$$eval(accountSwitchSel, (els) => els.length);
    check('At least 2 accounts are listed to toggle between', accountSwitchCount >= 2, `${accountSwitchCount}`);
    if (accountSwitchCount >= 2) {
      await page.click(accountSwitchSel);
      await page.waitForTimeout(400);
      const footCaptionAfter = await page.$eval('#result-table .preset-preview-footcaption', (p) => p.textContent);
      check('Toggling an account off changes the preview row count', footCaptionAfter !== footCaptionBefore, `${footCaptionBefore} -> ${footCaptionAfter}`);
      await page.click(accountSwitchSel); // restore for the reload test below
      await page.waitForTimeout(400);
    }

    console.log('8. item 7: reorder columns (drag), Copy, reload, confirm it stuck as "Last used"...');
    const orderBefore = await page.$$eval('#home-preset-editor .column-pill.enabled .column-pill-label', (els) => els.map((e) => e.textContent));
    // Drag the first enabled pill past the second one.
    await page.dragAndDrop('#home-preset-editor .column-pill.enabled:nth-child(1)', '#home-preset-editor .column-pill.enabled:nth-child(2)');
    await page.waitForTimeout(200);
    const orderAfter = await page.$$eval('#home-preset-editor .column-pill.enabled .column-pill-label', (els) => els.map((e) => e.textContent));
    check('Reordering actually changed the column order', JSON.stringify(orderAfter) !== JSON.stringify(orderBefore), `${orderBefore} -> ${orderAfter}`);
    const summaryAfterEdit = await page.$eval('#change-drawer-title .drawer-settings-summary', (el) => el.textContent);
    check('Drawer summary reads "Customised" once the working set no longer matches any layout', summaryAfterEdit.includes('Customised'), summaryAfterEdit);

    await page.click('#copy-tsv-btn');
    await page.waitForTimeout(300);

    await page.goto(`chrome-extension://${extId}/workspace.html`);
    await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
    // A reload doesn't auto-restore the in-progress session - resume it via
    // the restore banner, the same as a real user reopening the tab.
    await page.waitForSelector('#restore-banner:not([hidden])', { timeout: 15000 });
    await page.click('#restore-yes');
    await page.waitForTimeout(500);
    await page.click('#change-link');
    await page.waitForSelector('#home-preset-editor .layout-cards', { timeout: 10000 });
    await page.waitForTimeout(300);
    const orderAfterReload = await page.$$eval('#home-preset-editor .column-pill.enabled .column-pill-label', (els) => els.map((e) => e.textContent));
    check('Column order survives a reload with no explicit save', JSON.stringify(orderAfterReload) === JSON.stringify(orderAfter), `${orderAfter} vs ${orderAfterReload}`);
    const summaryAfterReload = await page.$eval('#change-drawer-title .drawer-settings-summary', (el) => el.textContent);
    check('Reload still reads "Customised" (no nagging, nothing to save)', summaryAfterReload.includes('Customised'), summaryAfterReload);

    const cleanLog = await assertCleanLog(page, 'presets e2e', pageErrors);
    if (!cleanLog.ok) failures++;
  } finally {
    await context.close();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
