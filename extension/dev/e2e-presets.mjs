// Verifies the export column builder (EXPORT-AND-DUPES.md part 2, 2026-10-08)
// against the REAL unpacked extension (bundled Chromium only, never the
// user's Chrome): drop two CSV statements, open the builder from the result
// card's "Edit columns" button and from the preview's own table header, then
// build Nate's exact target layout in it - rename headers, add two blank
// columns, reorder one column by keyboard and again by pointer drag - copy
// for Sheets and assert the TSV header line is exactly
//   date  payee  amount  currency  plaid_account_id  asset_id  notes
// then reload and assert the whole layout came back.
//
// The old version of this script drove the layout radio cards and the
// Customise pill row, both of which part 2 replaced. It also dropped the
// image-only Northwind PDF purely to get an OCR'd extra_* column into the
// list, which put the run over four minutes on a busy machine for coverage
// that dev/e2e-extension.mjs and dev/e2e-ocr-console-errors.mjs already
// carry - this one stays on CSV fixtures and finishes fast.
//
// Run with: NODE_PATH=<a node_modules with playwright + cached chromium> node dev/e2e-presets.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';
import { gotoScreen, goBack } from './lib/nav.mjs';
import { sampleProfiles } from '../test/fixtures/sample-profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
const fixShotsDir = path.join(extensionPath, 'audit', 'fix-shots');
fs.mkdirSync(shotsDir, { recursive: true });
fs.mkdirSync(fixShotsDir, { recursive: true });

// The exact shape from EXPORT-AND-DUPES.md part 2.
const TARGET_HEADER = ['date', 'payee', 'amount', 'currency', 'plaid_account_id', 'asset_id', 'notes'];

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

const CARD_SEL = '#home-preset-editor .column-card';
const NAME_SEL = `${CARD_SEL} .cc-name`;

async function columnNames(page) {
  // The coverage badge ("2/2") is a <sup> inside .cc-name - read only the
  // header text itself, which is what the export header actually carries.
  return page.$$eval(NAME_SEL, (els) => els.map((e) => e.childNodes[0].textContent.trim()));
}

/** Click a column card's header and type a new name over it (rule 4). */
async function renameColumn(page, from, to) {
  const card = page.locator(CARD_SEL, { has: page.locator('.cc-name', { hasText: new RegExp(`^${from}`) }) }).first();
  await card.locator('.cc-name').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(to);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
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
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 60000 });
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
    await page.waitForSelector('#file-input', { state: 'attached', timeout: 60000 });
    // No statement type ships with a setup (NO-TEMPLATES.md item 1) - seed the
    // two this script drops files for, standing in for a user who already
    // saved them through confirm-first.
    await page.evaluate(async (profiles) => { await chrome.storage.local.set({ profiles }); },
      sampleProfiles().filter((p) => ['Meridian Bank', 'Anchor Bank'].includes(p.bank)));

    console.log('1. dropping two CSV statements (two accounts)...');
    await (await page.$('#file-input')).setInputFiles([
      path.join(extensionPath, 'test', 'fixtures', 'meridian_savings_40rows.csv'),
      path.join(extensionPath, 'test', 'fixtures', 'anchor_checking.csv'),
    ]);
    await page.waitForSelector('#export-panel:not([hidden])', { timeout: 60000 });
    await page.waitForSelector('#result-table .preset-preview-scroll-live', { timeout: 30000 });
    await page.waitForTimeout(500); // clear the 100ms preview debounce

    // --- Rule 1: the way into the builder -------------------------------
    console.log('2. rule 1: "Edit columns" button and a clickable preview header...');
    const editBtn = await page.$eval('#change-link', (el) => ({
      text: el.textContent.trim(),
      inPreviewHead: !!el.closest('.preview-head'),
      isButton: el.tagName === 'BUTTON' && el.classList.contains('btn'),
    }));
    check('"Edit columns" is a visible secondary button on the preview caption line', editBtn.text === 'Edit columns' && editBtn.inPreviewHead && editBtn.isButton, JSON.stringify(editBtn));
    const oldLink = await page.$$eval('#export-panel *', (els) => els.filter((e) => e.textContent.trim() === "Adjust what's exported").length);
    check('the old "Adjust what\'s exported" text link is gone', oldLink === 0, String(oldLink));

    // The preview's own table header opens the same builder.
    await page.click('#result-table thead th');
    await page.waitForSelector(CARD_SEL, { timeout: 10000 });
    check('clicking the preview table header opens the builder', await page.isVisible('#change-drawer'), '');
    // Close and reopen from the button, which is the documented path.
    await page.click('#change-link');
    await page.waitForTimeout(200);
    await page.click('#change-link');
    await page.waitForSelector(CARD_SEL, { timeout: 10000 });
    await page.waitForTimeout(300);

    // --- Rule 2/6: the panel's shape ------------------------------------
    console.log('3. rule 2/6: one panel, column cards, no radio-card grid...');
    check('the layout radio-card grid is gone', await page.$('#home-preset-editor .layout-cards') === null, '');
    check('the Customise pill row is gone', await page.$('#home-preset-editor .column-pill') === null, '');
    check('"Start from" is a single select', await page.$('#home-preset-editor select[data-test="start-from"]') !== null, '');
    check('date range, accounts and currency sit under a collapsed "More options"', await page.$eval('#more-options', (el) => !el.open), '');

    const cardInfo = await page.$$eval(CARD_SEL, (cards) => cards.map((c) => {
      const name = c.querySelector('.cc-name');
      const sample = c.querySelector('.cc-sample');
      return {
        name: name.childNodes[0].textContent.trim(),
        sample: (sample?.textContent || '').trim(),
        nameTruncated: name.scrollWidth > name.clientWidth + 1,
        sampleTruncated: sample ? sample.scrollWidth > sample.clientWidth + 1 : false,
        hasHandle: !!c.querySelector('.cc-handle'),
        hasRemove: !!c.querySelector('.cc-remove'),
      };
    }));
    check('every column card shows a header, a sample, a drag handle and an x', cardInfo.length > 0 && cardInfo.every((c) => c.name && c.sample && c.hasHandle && c.hasRemove), JSON.stringify(cardInfo));
    check('no column card truncates its header or its sample', cardInfo.every((c) => !c.nameTruncated && !c.sampleTruncated), JSON.stringify(cardInfo.filter((c) => c.nameTruncated || c.sampleTruncated)));

    // --- Rule 3/4: build the target layout -------------------------------
    console.log('4. rule 6: Start from "With account"...');
    await page.selectOption('#home-preset-editor select[data-test="start-from"]', 'withAccount');
    await page.waitForTimeout(400);
    check('"With account" gives the five columns it names', JSON.stringify(await columnNames(page)) === JSON.stringify(['Date', 'Account', 'Description', 'Amount', 'Currency']), (await columnNames(page)).join(','));

    console.log('5. rule 3: adding two blank columns...');
    await page.click('#home-preset-editor summary[data-test="add-column"]');
    await page.waitForTimeout(200);
    const menuGroups = await page.$$eval('#home-preset-editor .acm-group-label', (els) => els.map((e) => e.textContent.trim()));
    check('"Add a column" groups the catalog (Core, Statement, Original currency, Source, Your own)', menuGroups.length === 5 && menuGroups[0] === 'Core', menuGroups.join(' | '));
    const menuSamples = await page.$$eval('#home-preset-editor .acm-item .acm-sample', (els) => els.map((e) => e.textContent.trim()));
    check('every "Add a column" entry shows a sample value', menuSamples.length > 0 && menuSamples.every(Boolean), String(menuSamples.length));
    const everythingFields = await page.$$eval('#home-preset-editor .acm-item[data-field]', (els) => els.map((e) => e.dataset.field));
    for (const f of ['post_date', 'reference', 'type', 'orig_amount', 'orig_currency', 'source_file']) {
      check(`the menu offers ${f}`, everythingFields.includes(f), '');
    }
    await page.click('#home-preset-editor button[data-test="add-blank"]');
    await page.waitForTimeout(300);
    await page.click('#home-preset-editor button[data-test="add-blank"]');
    await page.waitForTimeout(300);
    check('two blank columns coexist', (await columnNames(page)).filter((n) => n === 'Blank').length === 2, (await columnNames(page)).join(','));

    console.log('6. rule 4: renaming headers in place...');
    await renameColumn(page, 'Date', 'date');
    await renameColumn(page, 'Description', 'payee');
    await renameColumn(page, 'Amount', 'amount');
    await renameColumn(page, 'Currency', 'currency');
    await renameColumn(page, 'Account', 'asset_id');
    await renameColumn(page, 'Blank', 'plaid_account_id');
    await renameColumn(page, 'Blank', 'notes');
    const renamed = await columnNames(page);
    check('every header renamed', JSON.stringify(renamed) === JSON.stringify(['date', 'asset_id', 'payee', 'amount', 'currency', 'plaid_account_id', 'notes']), renamed.join(','));

    console.log('7. rule 2: reorder by keyboard (Alt+Right)...');
    const assetCard = page.locator(CARD_SEL, { has: page.locator('.cc-name', { hasText: /^asset_id/ }) }).first();
    await assetCard.focus();
    await page.keyboard.press('Alt+ArrowRight');
    await page.waitForTimeout(350);
    const afterKeyboard = await columnNames(page);
    check('Alt+Right moved asset_id one place right', JSON.stringify(afterKeyboard) === JSON.stringify(['date', 'payee', 'asset_id', 'amount', 'currency', 'plaid_account_id', 'notes']), afterKeyboard.join(','));

    console.log('8. rule 2: reorder by pointer drag (real pointer events on the handle)...');
    await page.evaluate((targetIdx) => {
      // The cards wrap onto a second row, so the gesture has to travel in
      // both axes - walk the pointer from the card being dragged to the
      // middle of the card already sitting where it should end up.
      const cards = [...document.querySelectorAll('#home-preset-editor .column-card')];
      const card = cards.find((c) => c.querySelector('.cc-name').childNodes[0].textContent.trim() === 'asset_id');
      const handle = card.querySelector('.cc-handle');
      const from = card.getBoundingClientRect();
      const to = cards[targetIdx].getBoundingClientRect();
      const fire = (type, clientX, clientY) => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX, clientY }));
      const x0 = from.left + 6, y0 = from.top + 6;
      const x1 = to.left + to.width / 2 + 2, y1 = to.top + to.height / 2;
      fire('pointerdown', x0, y0);
      const steps = 40;
      for (let i = 1; i <= steps; i++) fire('pointermove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
      fire('pointerup', x1, y1);
    }, TARGET_HEADER.indexOf('asset_id'));
    await page.waitForTimeout(400);
    const afterDrag = await columnNames(page);
    check('pointer drag put asset_id where the target layout wants it', JSON.stringify(afterDrag) === JSON.stringify(TARGET_HEADER), afterDrag.join(','));

    // --- Real mouse drag (Nate 2026-10-10: cards moved, export did not) ---
    console.log('8b. drag with the real mouse, two places right, then compare cards / preview / summary...');
    {
      const cards = page.locator('#home-preset-editor .column-card');
      const handle = cards.nth(1).locator('.cc-handle');
      const hb = await handle.boundingBox();
      const tb = await cards.nth(3).boundingBox();
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 25; i++) await page.mouse.move(hb.x + ((tb.x + tb.width * 0.8 - hb.x) * i) / 25, hb.y + ((tb.y + tb.height / 2 - hb.y) * i) / 25);
      await page.mouse.up();
      await page.waitForTimeout(400);
      const names = await columnNames(page);
      const expected = [...TARGET_HEADER];
      const [moved] = expected.splice(1, 1);
      expected.splice(3, 0, moved);
      check('real mouse drag moved the second card two places right', JSON.stringify(names) === JSON.stringify(expected), names.join(','));
      const previewHeader = await page.$$eval('.preset-preview-table thead th', (ths, n) => ths.map((t) => t.textContent.trim()).slice(0, n), expected.length);
      check('the preview header shows exactly the card order', JSON.stringify(previewHeader.map((h) => h.toLowerCase())) === JSON.stringify(names.map((n) => n.toLowerCase())), `preview=${previewHeader.join(',')} cards=${names.join(',')}`);
      // Put it back for the rest of the script.
      await page.locator('#home-preset-editor .column-card').nth(3).focus();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.keyboard.press('Alt+ArrowLeft');
      await page.waitForTimeout(200);
      const restored = await columnNames(page);
      check('keyboard moves restore the target order', JSON.stringify(restored) === JSON.stringify(TARGET_HEADER), restored.join(','));
    }

    // --- Rule 7: the summary names the real columns ----------------------
    const summary = await page.$eval('#change-drawer-title .drawer-settings-summary', (el) => el.textContent);
    check('rule 7: the summary line reads the actual column names in order', summary.includes(TARGET_HEADER.join(', ')), summary);

    // --- Rule 9: screenshots --------------------------------------------
    console.log('9. screenshots...');
    await page.locator('#home-preset-editor .column-cards').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const shot1440 = path.join(fixShotsDir, 'builder-1440.png');
    await page.screenshot({ path: shot1440, clip: { x: 0, y: 0, width: 1440, height: 900 } });
    console.log('   screenshot:', shot1440);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    await page.locator('#home-preset-editor .column-cards').scrollIntoViewIfNeeded();
    const shot1280 = path.join(fixShotsDir, 'builder-1280.png');
    await page.screenshot({ path: shot1280, clip: { x: 0, y: 0, width: 1280, height: 900 } });
    console.log('   screenshot:', shot1280);
    const narrowCards = await page.$$eval(CARD_SEL, (cards) => cards.map((c) => {
      const n = c.querySelector('.cc-name');
      const s = c.querySelector('.cc-sample');
      return { name: n.childNodes[0].textContent.trim(), nameTrunc: n.scrollWidth > n.clientWidth + 1, sampleTrunc: s.scrollWidth > s.clientWidth + 1 };
    }));
    check('at 1280 no column card truncates its header or sample', narrowCards.every((c) => !c.nameTrunc && !c.sampleTrunc), JSON.stringify(narrowCards.filter((c) => c.nameTrunc || c.sampleTrunc)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);

    // --- Rule 8: the export itself --------------------------------------
    console.log('10. rule 8: Copy for Sheets...');
    const previewHeader = await page.$$eval('#result-table thead th', (ths) => ths.map((t) => t.textContent.trim()));
    check('the live preview header matches the built layout', JSON.stringify(previewHeader) === JSON.stringify(TARGET_HEADER), previewHeader.join(','));

    await page.click('#copy-tsv-btn');
    await page.waitForTimeout(600);
    const writes = await page.evaluate(() => window.__clipboardWrites);
    let clipText = writes[writes.length - 1] || '';
    if (!clipText) {
      try { clipText = await page.evaluate(() => navigator.clipboard.readText()); } catch { /* no permission */ }
    }
    const clipLines = clipText.split(/\r\n/).filter(Boolean); // buildTsv uses CRLF line endings
    check('clipboard TSV header line is exactly the target layout', clipLines[0] === TARGET_HEADER.join('\t'), JSON.stringify(clipLines[0]));
    const firstCells = (clipLines[1] || '').split('\t');
    check('a data row has 7 cells, with both blank columns empty and asset_id filled', firstCells.length === 7 && firstCells[4] === '' && firstCells[6] === '' && !!firstCells[5], JSON.stringify(clipLines[1]));

    // --- Rule 7: whatever is left in the builder is next time's default ---
    console.log('11. reload and confirm the whole layout came back...');
    await page.goto(`chrome-extension://${extId}/workspace.html`);
    await page.waitForSelector('#file-input', { state: 'attached', timeout: 60000 });
    await page.waitForSelector('#restore-banner:not([hidden])', { timeout: 15000 });
    await page.click('#restore-yes');
    await page.waitForTimeout(600);
    await page.click('#change-link');
    await page.waitForSelector(CARD_SEL, { timeout: 10000 });
    await page.waitForTimeout(300);
    const afterReload = await columnNames(page);
    check('column order, renames and both blank columns survive a reload with no explicit save', JSON.stringify(afterReload) === JSON.stringify(TARGET_HEADER), afterReload.join(','));
    const reloadedHeader = await page.$$eval('#result-table thead th', (ths) => ths.map((t) => t.textContent.trim()));
    check('and the preview after a reload still shows that exact header', JSON.stringify(reloadedHeader) === JSON.stringify(TARGET_HEADER), reloadedHeader.join(','));

    // --- Kept from the previous version: the live preview's own contract ---
    console.log('12. the live preview box (5 rows, scroll, captions, a11y)...');
    const liveCaption = await page.$eval('#result-table .preset-preview-caption', (p) => p.textContent);
    check('Home live preview is captioned "Preview of what will be copied"', liveCaption === 'Preview of what will be copied', liveCaption);
    const footCaptionBefore = await page.$eval('#result-table .preset-preview-footcaption', (p) => p.textContent);
    check('Home preview footer caption names the row count (e.g. "All N rows")', /^All \d+ rows?$/.test(footCaptionBefore), footCaptionBefore);
    const boxMetrics = await page.evaluate(() => {
      const scroll = document.querySelector('#result-table .preset-preview-scroll-live');
      return {
        boxHeight: scroll.getBoundingClientRect().height,
        headerHeight: scroll.querySelector('thead th').getBoundingClientRect().height,
        rowHeight: scroll.querySelector('tbody td').getBoundingClientRect().height,
        scrollHeight: scroll.scrollHeight,
      };
    });
    check('Preview box is exactly header + 5 data rows tall', Math.abs(boxMetrics.boxHeight - (boxMetrics.headerHeight + 5 * boxMetrics.rowHeight)) <= 1, JSON.stringify(boxMetrics));
    check('Preview box actually scrolls (more real rows than fit)', boxMetrics.scrollHeight > boxMetrics.boxHeight + 1, JSON.stringify(boxMetrics));
    const scrollA11y = await page.$eval('#result-table .preset-preview-scroll-live', (el) => ({ tabIndex: el.tabIndex, role: el.getAttribute('role'), label: el.getAttribute('aria-label') }));
    check('Preview scroll region is focusable with a role/aria-label', scrollA11y.tabIndex === 0 && !!scrollA11y.role && !!scrollA11y.label, JSON.stringify(scrollA11y));
    const thScopes = await page.$$eval('#result-table .preset-preview-scroll-live thead th', (ths) => ths.map((th) => th.getAttribute('scope')));
    check('Every preview header cell is a th[scope=col]', thScopes.length > 0 && thScopes.every((s) => s === 'col'), thScopes.join(','));
    const dateCellInfo = await page.$eval('#result-table .preset-preview-scroll-live tbody td[data-field="date"]', (td) => ({
      whiteSpace: getComputedStyle(td).whiteSpace, width: td.getBoundingClientRect().width,
    }));
    check('Date column cell does not wrap (white-space nowrap, >=96px wide)', dateCellInfo.whiteSpace === 'nowrap' && dateCellInfo.width >= 96, JSON.stringify(dateCellInfo));
    const previewRows = await page.$$eval('#result-table .txn-table tbody tr', (trs) => trs.length);
    const accountCellCount = await page.$$eval('#result-table .txn-table tbody td[data-field="account_label"]', (tds) => tds.length);
    check('preview has exactly one td per row for account_label (a comma-containing value is not split across cells)', accountCellCount === previewRows, `got ${accountCellCount} for ${previewRows} rows`);

    console.log('13. toggling an account off changes the preview row count...');
    await page.click('#more-options > summary');
    await page.waitForTimeout(250);
    const accountSwitchSel = '#accounts-table-body .switch input[type=checkbox]';
    const accountSwitchCount = await page.$$eval(accountSwitchSel, (els) => els.length);
    check('At least 2 accounts are listed to toggle between', accountSwitchCount >= 2, `${accountSwitchCount}`);
    if (accountSwitchCount >= 2) {
      await page.click(accountSwitchSel);
      await page.waitForTimeout(500);
      const footCaptionAfter = await page.$eval('#result-table .preset-preview-footcaption', (p) => p.textContent);
      check('Toggling an account off changes the preview row count', footCaptionAfter !== footCaptionBefore, `${footCaptionBefore} -> ${footCaptionAfter}`);
      await page.click(accountSwitchSel);
      await page.waitForTimeout(400);
    }

    console.log('14. Settings\' "Start from" picker...');
    await gotoScreen(page, 'settings');
    await page.waitForSelector('#pref-default-preset', { timeout: 10000 });
    const startFromOptions = await page.$$eval('#pref-default-preset option', (els) => els.map((e) => e.textContent));
    check('"Start from" lists the six layouts plus Last used (default)', startFromOptions.length === 7 && startFromOptions[0] === 'Last used (default)', startFromOptions.join(','));
    check('Settings has no column editor of its own', await page.$('#preset-editor-container') === null, '');
    await page.screenshot({ path: path.join(shotsDir, 'preset2-settings.png'), fullPage: true });
    await goBack(page);

    const cleanLog = await assertCleanLog(page, 'presets e2e', pageErrors);
    if (!cleanLog.ok) failures++;
  } finally {
    await context.close();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
