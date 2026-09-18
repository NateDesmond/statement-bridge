// Verifies the export preset editor rework against the REAL unpacked
// extension (bundled Chromium only, never the user's Chrome): drop the Northwind Bank
// image-only PDF fixture (auto-OCR against the built-in "Northwind Bank savings,
// Transaction History PDF" profile, which has an extra_type "Type" column),
// open the Home Change drawer's preset editor, enable Type, screenshot the
// editor + preview, Copy for Sheets, and assert the clipboard TSV carries
// the Type column. Also checks Settings' preset editor.
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
    await page.waitForSelector('#home-preset-editor .preset-columns', { timeout: 10000 });
    await page.waitForTimeout(300);

    const beforeShot = path.join(shotsDir, 'preset2-01-drawer-before.png');
    await page.screenshot({ path: beforeShot, fullPage: true });
    console.log('   screenshot:', beforeShot);

    // Type should be listed but disabled (never appears in the export today).
    const disabledRows = await page.$$eval('#home-preset-editor .preset-columns-disabled li', (lis) =>
      lis.map((li) => li.querySelector('.col-name')?.textContent));
    check('Type (extra_type) is listed as a disabled column up front', disabledRows.includes('Type'), disabledRows.join(','));

    console.log('3. enabling extra_type...');
    // renderPresetEditor fully re-renders the container on every onChange (a
    // controlled component, like review.js), so the checkbox node is replaced
    // the instant it's clicked - a re-queried locator's own auto-wait-for-
    // checked would poll the OLD detached node and hang. Plain click, then
    // verify the resulting DOM state separately.
    const typeCheckbox = page.locator('#home-preset-editor .preset-columns-disabled li', { has: page.locator('.col-name', { hasText: /^Type$/ }) }).locator('input[type=checkbox]');
    await typeCheckbox.click({ force: true, noWaitAfter: true });
    await page.waitForTimeout(300);

    const enabledRows = await page.$$eval('#home-preset-editor > .preset-columns:first-child li', (lis) =>
      lis.map((li) => li.querySelector('.col-field')?.textContent));
    check('extra_type moved into the enabled list after toggling on', enabledRows.includes('extra_type'), enabledRows.join(','));

    const afterShot = path.join(shotsDir, 'preset2-02-drawer-after-enable.png');
    await page.screenshot({ path: afterShot, fullPage: true });
    console.log('   screenshot:', afterShot);

    const previewText = await page.$eval('#home-preset-editor .txn-table thead', (t) => t.textContent);
    check('preview header includes the Type column', previewText.includes('Type'), previewText.trim());
    // Item 1: the preview now shows the REAL export (every row Copy for
    // Sheets would produce, not a fixed 2-row sample) - it must match the
    // footer caption's count exactly (this fixture has well under 200 rows).
    const previewRows = await page.$$eval('#home-preset-editor .txn-table tbody tr', (trs) => trs.length);
    const footCaption1 = await page.$eval('#home-preset-editor .preset-preview-footcaption', (p) => p.textContent);
    check('preview shows every real export row, matching its own footer caption', previewRows > 0 && footCaption1 === `All ${previewRows} row${previewRows === 1 ? '' : 's'}`, `${previewRows} rows, caption "${footCaption1}"`);

    // Coordinator follow-up (1): the preview must render each field from the
    // row object (export.js's fieldValue), never by re-splitting buildCsv
    // text on commas - a value containing a comma (a bank/statement-type
    // account label, or any description) must land in exactly one <td>, not
    // spill into the next column.
    const accountCellCount = await page.$$eval('#home-preset-editor .txn-table tbody td[data-field="account_label"]', (tds) => tds.length);
    check('preview has exactly one td per row for account_label (a comma-containing value is not split across cells)', accountCellCount === previewRows, `got ${accountCellCount} for ${previewRows} rows`);
    const accountCellText = await page.$eval('#home-preset-editor .txn-table tbody td[data-field="account_label"]', (td) => td.textContent);

    // Coordinator follow-up (2): account_label must be "<bank> <statement
    // type> ****<last4>", never the profile's own display name.
    check('account_label is "<bank> <statement type> ****<last4>", not the profile display name', /^Northwind Bank savings \*\*\*\*\d{4}$/.test(accountCellText), accountCellText);

    // Coordinator follow-up (3): layout - 16px gap above Mapping, Date column
    // never wraps.
    const mappingGap = await page.evaluate(() => {
      const actions = document.querySelector('.export-actions[style*="margin-top:8px"]');
      const title = document.querySelector('.drawer-mapping-title');
      if (!actions || !title) return null;
      const a = actions.getBoundingClientRect();
      const t = title.getBoundingClientRect();
      return Math.round(t.top - a.bottom);
    });
    check('16px gap above the Mapping section title (no collision with the checkbox row)', mappingGap != null && mappingGap >= 15, `gap=${mappingGap}px`);

    const dateCellInfo = await page.$eval('#home-preset-editor .txn-table tbody td[data-field="date"]', (td) => {
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

    console.log('5. checking Settings preset editor...');
    await gotoScreen(page, 'settings');
    await page.waitForSelector('#preset-editor-container .preset-columns', { timeout: 10000 });
    await page.waitForTimeout(300);
    const settingsDisabled = await page.$$eval('#preset-editor-container .preset-columns-disabled li .col-name', (els) => els.map((e) => e.textContent));
    check('Settings preset editor lists standard/source/mode-B/extra fields', settingsDisabled.length > 0, `${settingsDisabled.length} disabled fields`);
    // Item 4: with a real last-session sample on hand (the OCR'd file above),
    // Settings' preview is captioned "Sample", not "Preview of what will be
    // copied" (it has no live session of its own to copy from).
    const settingsCaption = await page.$eval('#preset-editor-container .preset-preview-caption', (p) => p.textContent);
    check('Settings preset editor preview is captioned "Sample"', settingsCaption === 'Sample', settingsCaption);
    await page.screenshot({ path: path.join(shotsDir, 'preset2-03-settings.png'), fullPage: true });

    console.log('6. Home: a real 40-row export preview (5 visible rows, scroll, caption)...');
    await goBack(page);
    const fixture40 = path.join(extensionPath, 'test', 'fixtures', 'meridian_savings_40rows.csv');
    await (await page.$('#file-input')).setInputFiles(fixture40);
    await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn', { timeout: 30000 });
    await page.waitForTimeout(500);
    if (!(await page.isVisible('#change-drawer'))) await page.click('#change-link');
    await page.waitForSelector('#home-preset-editor .preset-preview-scroll-live', { timeout: 10000 });
    await page.waitForTimeout(400); // clear the 100ms preview debounce

    const liveCaption = await page.$eval('#home-preset-editor .preset-preview-caption', (p) => p.textContent);
    check('Home live preview is captioned "Preview of what will be copied"', liveCaption === 'Preview of what will be copied', liveCaption);

    const footCaptionBefore = await page.$eval('#home-preset-editor .preset-preview-footcaption', (p) => p.textContent);
    check('Home preview footer caption names the row count (e.g. "All N rows")', /^All \d+ rows?$/.test(footCaptionBefore), footCaptionBefore);

    const boxMetrics = await page.evaluate(() => {
      const scroll = document.querySelector('#home-preset-editor .preset-preview-scroll-live');
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

    const scrollA11y = await page.$eval('#home-preset-editor .preset-preview-scroll-live', (el) => ({ tabIndex: el.tabIndex, role: el.getAttribute('role'), label: el.getAttribute('aria-label') }));
    check('Preview scroll region is focusable with a role/aria-label', scrollA11y.tabIndex === 0 && !!scrollA11y.role && !!scrollA11y.label, JSON.stringify(scrollA11y));
    const thScopes = await page.$$eval('#home-preset-editor .preset-preview-scroll-live thead th', (ths) => ths.map((th) => th.getAttribute('scope')));
    check('Every preview header cell is a th[scope=col]', thScopes.length > 0 && thScopes.every((s) => s === 'col'), thScopes.join(','));

    // The drawer scrolls inside its own internal container (the page/body
    // never grows), so a fullPage screenshot would just repeat the viewport -
    // scroll the preview into view first and screenshot the drawer itself.
    await page.locator('#home-preset-editor .preset-preview-scroll-live').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shotsDir, 'preview-1440.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(150);
    await page.locator('#home-preset-editor .preset-preview-scroll-live').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shotsDir, 'preview-1280.png'), clip: { x: 0, y: 0, width: 1280, height: 900 } });
    await page.setViewportSize({ width: 1440, height: 900 });

    console.log('7. toggling a source off changes the preview row count...');
    // The footer caption's total is the reliable signal here (the mapping
    // list is fully re-rendered on every drawer update, so a checkbox handle
    // from before the first click is detached by the time of a second one -
    // re-query it fresh each time rather than reusing the old handle).
    const sourceCheckboxSel = '#drawer-mapping-list input[type=checkbox]';
    const sourceCheckboxCount = await page.$$eval(sourceCheckboxSel, (els) => els.length);
    check('At least 2 sources are listed to toggle between', sourceCheckboxCount >= 2, `${sourceCheckboxCount}`);
    if (sourceCheckboxCount >= 2) {
      await page.click(sourceCheckboxSel);
      await page.waitForTimeout(400);
      const footCaptionAfter = await page.$eval('#home-preset-editor .preset-preview-footcaption', (p) => p.textContent);
      check('Toggling a source off changes the preview row count', footCaptionAfter !== footCaptionBefore, `${footCaptionBefore} -> ${footCaptionAfter}`);
      await page.click(sourceCheckboxSel); // restore for the reload test below
      await page.waitForTimeout(400);
    }

    console.log('8. item 6: reorder columns, Copy, reload, confirm it stuck as "Last used"...');
    const orderBefore = await page.$$eval('#home-preset-editor > .preset-columns:first-child li .col-field', (els) => els.map((e) => e.textContent));
    // First enabled row's "down" button (2nd of its two icon buttons - up, down).
    const firstRowButtons = await page.$$('#home-preset-editor > .preset-columns:first-child li:first-child button.icon-btn-xs');
    await firstRowButtons[1].click(); // move the first column down one position
    await page.waitForTimeout(200);
    const orderAfter = await page.$$eval('#home-preset-editor > .preset-columns:first-child li .col-field', (els) => els.map((e) => e.textContent));
    check('Reordering actually changed the column order', JSON.stringify(orderAfter) !== JSON.stringify(orderBefore), `${orderBefore} -> ${orderAfter}`);
    const labelAfterEdit = await page.$eval('#preset-select-home', (el) => el.value);
    check('Picker reads "Last used" once the working set no longer matches any saved preset', labelAfterEdit === 'Last used', labelAfterEdit);

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
    await page.waitForSelector('#home-preset-editor .preset-columns', { timeout: 10000 });
    await page.waitForTimeout(300);
    const orderAfterReload = await page.$$eval('#home-preset-editor > .preset-columns:first-child li .col-field', (els) => els.map((e) => e.textContent));
    check('Column order survives a reload with no explicit save', JSON.stringify(orderAfterReload) === JSON.stringify(orderAfter), `${orderAfter} vs ${orderAfterReload}`);
    const labelAfterReload = await page.$eval('#preset-select-home', (el) => el.value);
    check('Reload still reads "Last used" (no nagging, nothing to save)', labelAfterReload === 'Last used', labelAfterReload);
    const dirtyNoteHiddenAfterReload = await page.$eval('#preset-dirty-note-home', (el) => el.hidden);
    check('No "Revert to" link right after a reload (nothing was loaded-from-and-changed this session)', dirtyNoteHiddenAfterReload, String(dirtyNoteHiddenAfterReload));

    const cleanLog = await assertCleanLog(page, 'presets e2e', pageErrors);
    if (!cleanLog.ok) failures++;
  } finally {
    await context.close();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
