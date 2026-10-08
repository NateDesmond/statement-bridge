// Real-extension E2E runner: loads the actual unpacked MV3 extension (not
// dev/index.html's chrome-shim harness) into the BUNDLED headless Chromium
// (playwright-core's own download, resolved via chromium.executablePath() -
// never channel:'chrome', never the user's real browser, never killed).
// Chrome only supports loading extensions in "headless=new" mode when that
// flag is passed explicitly in `args` (Playwright's own `headless: true`
// uses old headless, which does not support extensions at all), so this
// launches with headless:false and puts --headless=new in args itself.
//
// Usage: node dev/e2e-extension.mjs
// Screenshots land in dev/shots/*.png; read them, don't just check the exit
// code - a screenshot that "looks fine" numerically can still be visually
// broken (a footer overlapping the last control, an empty samples column,
// etc). Each scenario gets its own fresh persistent-context userDataDir, so
// a profile saved in one scenario never leaks into another's matching.
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';
import { sampleProfiles } from '../test/fixtures/sample-profiles.js';

let checkFailures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) checkFailures++;
}


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // see module doc comment: --headless=new below is what actually goes headless
    executablePath: chromium.executablePath(), // bundled Chromium only, never channel:'chrome'
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 60000 });
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e); console.log('[pageerror]', e.message); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 60000 });
  return { context, page, pageErrors };
}

function shotter(page, prefix) {
  return async function shotStep(name) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shotsDir, `${prefix}-${name}.png`), fullPage: false });
  };
}
function bottomShotter(page, prefix) {
  return async function shotScrolledToBottom(name, scrollSelector) {
    await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollTop = el.scrollHeight; }, scrollSelector);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shotsDir, `${prefix}-${name}.png`), fullPage: false });
  };
}

/** Drop a fixture on Home and open the wizard for it, whether it auto-matches (Change drawer -> Update mapping) or not (the "Map this statement" card). */
async function dropAndOpenWizard(page, fixturePath) {
  await page.$('#file-input').then((el) => el.setInputFiles(fixturePath));
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, #attention-cards button:has-text("Set up")', { timeout: 240000 });
  // Scoped to #attention-cards: an unscoped button:has-text("Set up") can
  // match an unrelated hidden template elsewhere on the page (a different
  // screen's markup, always in the DOM but display:none) and then hang
  // forever waiting for THAT element to become visible - a real flake found
  // verifying the confirm-first scenarios against a file that auto-matches
  // cleanly (no attention card at all, so the drawer/"Set up again" branch
  // below is the only correct path).
  const mapBtn = await page.$('#attention-cards button:has-text("Set up")');
  if (mapBtn) {
    await mapBtn.click();
  } else {
    await page.click('#change-link');
    await page.evaluate(() => { const d = document.querySelector('#more-options'); if (d) d.open = true; });
    await page.waitForSelector('#accounts-table-body tr');
    await page.click('#accounts-table-body a:has-text("Set up again")');
  }
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
}

/**
 * Confirm-first setup (SIMPLE-BUILD.md Section 2) is the wizard's new
 * default entry point: opening the wizard now lands on Screen A ("Does this
 * look right?"), not the old step-0 Basics panel. Scenarios that exist to
 * exercise the full step-by-step wizard's own UI (Map fields/Test/Save)
 * reach it the same way a real user would for anything Screen A's Yes/quick
 * fixes don't cover: "Something's off" -> "Something else". A no-op when
 * detection couldn't produce any rows at all (the confirm screens are
 * skipped entirely in that case, landing straight on step-0 with a plain
 * intro - nothing to bypass).
 */
async function skipConfirmToFullWizard(page) {
  // The confirm screens are rendered asynchronously after the wizard opens,
  // so "is #wizard-confirm hidden?" is only meaningful once the wizard has
  // settled into one of its two entry states. Reading it too early used to
  // see the still-hidden confirm block, return a no-op, and then hang for
  // 30s clicking a #wizard-next that the confirm screens keep hidden.
  await page.waitForFunction(() => {
    const confirm = document.getElementById('wizard-confirm');
    const footer = document.getElementById('wizard-footer');
    return (confirm && !confirm.hidden) || (footer && footer.offsetParent !== null);
  }, { timeout: 30000 });
  if (!(await page.$('#wizard-confirm:not([hidden])'))) return;
  // Some layouts open on the date-format focus screen ahead of Screen A.
  if (await page.isVisible('#confirm-focus').catch(() => false)) {
    await page.click('#confirm-focus-done');
    await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 20000 });
  }
  await page.click('#confirm-off');
  await page.waitForTimeout(200);
  await page.click('#confirm-fix-other');
  await page.waitForSelector('#step-2.active', { timeout: 5000 });
}

// Wizard step indices (STEP_META in src/ui/wizard.js): 0 Basics, 1 Locate
// data, 2 Map fields, 3 Test, 4 Save.
/**
 * Click Continue until the wizard reaches the given step index, or leaves
 * the wizard entirely (Save profile went through). A step's ordinal
 * position is no longer fixed (2026-09-17 coordinator follow-up, item 1): a
 * confidently-detected grouped/OCR PDF now skips Locate data straight to
 * Map fields, so a hard-coded "click Next N times" no longer reaches the
 * intended step - this instead checks which step is actually active after
 * each click and stops there.
 */
async function advanceWizardTo(page, stepIndex, maxClicks = 6) {
  for (let i = 0; i < maxClicks; i++) {
    if (await page.$(`#step-${stepIndex}.active`)) return true;
    if (!(await page.$('#screen-wizard.active'))) return false;
    await page.click('#wizard-next');
    await page.waitForTimeout(400);
  }
  return !!(await page.$(`#step-${stepIndex}.active`));
}

/** Scenario 1: auto-OCR -> wizard -> Map fields (samples/preview) -> Test -> Save -> Home -> re-drop auto-matches. */
async function runMapFieldsScenario() {
  console.log('\n=== scenario: map fields / save (prefix map2) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'map2');
  const shotBottom = bottomShotter(page, 'map2');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_image.pdf');

  console.log('1. drop the OCR fixture (image-only, forces the auto-OCR path)...');
  await dropAndOpenWizard(page, fixture);
  await shotStep('01-confirm-a');
  console.log('   confirm-first Screen A shown (Section 2); bypass via Something\'s off -> Something else to reach the full wizard\'s Map fields...');
  await skipConfirmToFullWizard(page);

  console.log('2. Map fields (item 1: Locate data is skipped when detection is confident, only reachable via Back from here)...');
  if (await page.$('#step-1.active')) {
    await shotStep('02-locate');
    await page.click('#wizard-next');
    await page.waitForTimeout(500);
  }
  await shotStep('03-map-fields-top');
  await shotBottom('04-map-fields-bottom', '#wizard-steps');

  console.log('3. Map fields -> Test...');
  await advanceWizardTo(page, 3);
  await shotStep('05-test-top');
  await shotBottom('06-test-bottom', '#wizard-steps');

  console.log('4. Test -> Save...');
  await advanceWizardTo(page, 4);
  await shotStep('07-save-top');
  await shotBottom('08-save-bottom', '#wizard-steps');

  console.log('5. Save profile -> back to Home...');
  await page.click('#wizard-next');
  await page.waitForTimeout(800);
  await shotStep('09-home-after-save');

  console.log('6. drop the same fixture again, confirm it auto-matches (no wizard)...');
  await page.$('#file-input').then((el) => el.setInputFiles(fixture));
  await page.waitForTimeout(3000);
  await shotStep('10-home-redrop');

  const cleanLog = await assertCleanLog(page, 'map fields / save (map2)', pageErrors);
  await context.close();
  if (!cleanLog.ok) throw new Error(`map2 scenario: ${cleanLog.problems.join('; ')}`);
}

/** Scenario 2 (Fix 5 verification): a fixture with a malformed date, a fused-sign amount and a duplicate row - real flagged rows on the Test step, walking through "Looks right", "Fix" and confirming counts update and survive Back/Continue. */
async function runFlagResolutionScenario() {
  console.log('\n=== scenario: Test step flag resolution (prefix map3) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'map3');
  const shotBottom = bottomShotter(page, 'map3');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_flags.pdf');

  console.log('1. drop the flagged-rows fixture...');
  await page.$('#file-input').then((el) => el.setInputFiles(fixture));
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, #attention-cards button:has-text("Set up")', { timeout: 240000 });

  // Follow-up A (QA-REPORT.md finding 7): on a completely fresh profile
  // store this fixture won't auto-match at all - no profile ships with the
  // extension (NO-TEMPLATES.md item 1) - so save one via the wizard first.
  // Either way, get the file mapped once (via the "Set up" wizard, or it's
  // already matched from an earlier run of this same context), then force a
  // SECOND wizard open specifically
  // through the Change drawer's "Update mapping" link - the entry point QA
  // could not exercise - so the wizard's own Test-step flag-resolution UI
  // (not Home's card or Review's chip) is what actually gets tested below.
  // Scoped to #attention-cards (see dropAndOpenWizard's own comment): an
  // unscoped lookup can match an unrelated hidden "Set up" template
  // elsewhere on the page and hang forever waiting for it to become visible.
  const mapBtn = await page.$('#attention-cards button:has-text("Set up")');
  if (mapBtn) {
    console.log('   (no auto-match this run - saving a profile first so the file is mapped)');
    await mapBtn.click();
    await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
    await skipConfirmToFullWizard(page); // confirm-first Screen A is the new default entry (Section 2)
    await advanceWizardTo(page, 4); // item 1: Locate data may be skipped, so this is no longer a fixed 4 clicks
    await page.click('#wizard-next'); // Save profile -> back to Home
    await page.waitForTimeout(800);
  }

  console.log('2. reopen via the Change drawer\'s "Update mapping" link...');
  await page.click('#change-link');
    await page.evaluate(() => { const d = document.querySelector('#more-options'); if (d) d.open = true; });
  await page.waitForSelector('#accounts-table-body tr');
  await page.click('#accounts-table-body a:has-text("Set up again")');
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
  await shotStep('01-confirm-a');
  await skipConfirmToFullWizard(page);

  console.log('3. Map fields -> Test (item 1: Locate data may be skipped)...');
  await advanceWizardTo(page, 3);
  await shotStep('02-test-with-flags');
  await shotBottom('03-test-bottom', '#wizard-steps');

  const flagCountText = await page.textContent('.rs-item .num').catch(() => null);
  console.log('   rows parsed (first summary number):', flagCountText);
  const flagsLine = await page.textContent('p.pdf-anchor-hint:has-text("Flags:")').catch(() => null);
  console.log('   flags line:', flagsLine);

  const resolveRows = await page.$$('.row-resolve-actions');
  console.log(`   found ${resolveRows.length} row(s) with resolve actions`);
  if (resolveRows.length === 0) {
    throw new Error('Follow-up A: no flagged rows with resolve actions found on the wizard Test step (via Update mapping) - the flag-resolution UI was not exercised');
  } else {
    console.log('4. click "Looks right" on the first flagged row...');
    await resolveRows[0].$('button:has-text("Looks right")').then((btn) => btn.click());
    await page.waitForTimeout(300);
    await shotStep('04-after-looks-right');

    const resolveRowsAfter = await page.$$('.row-resolve-actions');
    if (resolveRowsAfter.length > 0) {
      console.log('5. click "Fix" on another flagged row and edit the amount inline...');
      await resolveRowsAfter[0].$('button:has-text("Fix")').then((btn) => btn.click());
      await page.waitForTimeout(300);
      await shotStep('05-fix-inline-open');
      // Item 6 (2026-09-17): Fix now edits the row's own Date/Description/
      // Amount cells in place (tr.editing-row .cell-edit-input), not the old
      // standalone .row-fix-form - Save fix/Cancel live in the Resolve cell.
      const amountInput = await page.$('tr.editing-row .row-fix-amount');
      if (amountInput) {
        await amountInput.fill('12.00');
        await page.click('tr.editing-row .row-fix-save');
        await page.waitForTimeout(300);
      }
      await shotStep('06-after-fix-saved');
    }
  }

  console.log('6. Back to Map fields, then Continue back to Test - resolutions must survive...');
  await page.click('#wizard-back');
  await page.waitForTimeout(300);
  await shotStep('07-back-at-map-fields');
  await page.click('#wizard-next');
  await page.waitForTimeout(300);
  await shotStep('08-continue-back-at-test');

  const cleanLog = await assertCleanLog(page, 'Test step flag resolution (map3)', pageErrors);
  await context.close();
  if (!cleanLog.ok) throw new Error(`map3 scenario: ${cleanLog.problems.join('; ')}`);
}

/**
 * Scenario 3 (Finding 2 verification): an unknown CSV from an unrelated bank
 * ("When"/"What"/"Value" headers, none of which the header dictionary
 * recognises for date or description) lands on Map fields with Date and
 * Description both unmapped. Map them manually via the target <select>s -
 * exactly the flow QA found broken - then assert Continue is enabled
 * WITHOUT clicking Back first (the only workaround QA could find by trial).
 */
async function runUnknownCsvMappingScenario() {
  console.log('\n=== scenario: unknown CSV, manual Map fields (prefix map4) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'map4');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'generic_unknown_bank.csv');

  console.log('1. drop the unrelated-bank CSV, open the wizard...');
  await dropAndOpenWizard(page, fixture);
  await shotStep('01-confirm-a');
  // Confirm-first Screen A is the new default entry (Section 2): this file's
  // "When"/"What" headers map to neither date nor description, so Screen A
  // itself already shows a blank preview - "Something's off" -> "Something
  // else" is exactly how a real user would reach the full mapping UI, same
  // entry point this scenario always meant to exercise.
  await skipConfirmToFullWizard(page);
  await shotStep('02-map-fields-unmapped');

  const nextBtn = () => page.$('#wizard-next');
  const disabledBefore = await (await nextBtn()).getAttribute('disabled');
  console.log('   Continue disabled before manual mapping:', disabledBefore !== null);

  console.log('3. manually map "When" -> Date and "What" -> Description...');
  const selects = await page.$$('#w-mapping-table select.map-select');
  if (selects.length < 2) throw new Error(`expected at least 2 mapping selects, found ${selects.length}`);
  await selects[0].selectOption('date');
  await selects[1].selectOption('description_raw');
  await page.waitForTimeout(200);
  await shotStep('03-map-fields-mapped');

  console.log('4. assert Continue is enabled WITHOUT clicking Back (Finding 2)...');
  const disabledAfter = await (await nextBtn()).getAttribute('disabled');
  if (disabledAfter !== null) {
    throw new Error('Finding 2 regression: Continue is still disabled after a valid manual mapping (Date + Description + auto-mapped Amount)');
  }
  console.log('   Continue enabled - Finding 2 fixed.');

  const cleanLog = await assertCleanLog(page, 'unknown CSV manual mapping (map4)', pageErrors);
  await context.close();
  if (!cleanLog.ok) throw new Error(`map4 scenario: ${cleanLog.problems.join('; ')}`);
}

/**
 * Scenario 4 (2026-09-17 root cause): a CSV opened via Update mapping (the
 * layout-changed path, state.updateProfile set) used to throw at
 * buildVersionFromWizard - "Cannot read properties of null (reading
 * 'rowModel')" on every preview/test render, because state.pdf is null for
 * a csv/xlsx entry and one signConvention line read state.pdf.rowModel with
 * no isPdf() guard. Renaming "Transaction Date" -> "Txn Date" (still in the
 * date synonym dictionary, so Map fields still resolves date on its own)
 * is the exact single-header-rename profiles.js's own matchProfile comment
 * names as what turns an exact match into formatChanged: true (Layout
 * changed / Update mapping), never a fresh "Set up". Walks Basics -> Map
 * fields -> Test -> Save and relies on assertCleanLog to fail on the
 * pageerror or the wizard.* stack entry this bug used to leave behind.
 *
 * No profile ships with the extension (NO-TEMPLATES.md item 1), so this
 * seeds the matching Meridian Bank savings profile itself first - standing
 * in for a user who already saved the un-renamed export through
 * confirm-first - since what's under test here is the Update-mapping bug,
 * not the confirm-first save flow.
 */
async function runCsvLayoutChangedUpdateMappingScenario() {
  console.log('\n=== scenario: CSV layout-changed via Update mapping (prefix map5) ===');
  const srcFixture = path.join(extensionPath, 'test', 'fixtures', 'meridian_savings_real_export.csv');
  const csv = fs.readFileSync(srcFixture, 'utf8').replace('"Transaction Date"', '"Txn Date"');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-e2e-fixture-'));
  const fixture = path.join(fixtureDir, 'l3m_dbs.csv');
  fs.writeFileSync(fixture, csv);

  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'map5');
  const shotBottom = bottomShotter(page, 'map5');

  await page.evaluate(async (profiles) => { await chrome.storage.local.set({ profiles }); },
    sampleProfiles().filter((p) => p.bank === 'Meridian Bank'));

  console.log('1. drop the renamed-header Meridian Bank export, wait for the Layout-changed card...');
  await page.$('#file-input').then((el) => el.setInputFiles(fixture));
  await page.waitForSelector('button:has-text("Set up again")', { timeout: 60000 });
  await shotStep('01-home-layout-changed');

  console.log('2. click Update mapping (state.updateProfile path)...');
  await page.click('button:has-text("Set up again")');
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
  // Confirm-first Screen A is the new default entry (Section 2): a
  // state.updateProfile reopen shows "This looks different from last
  // time..." instead of the fresh-file heading - this used to be exactly
  // where buildVersionFromWizard's null state.pdf.rowModel bug crashed
  // (Screen A computes a preview immediately on open), so reaching it here
  // at all is itself part of the regression coverage.
  await shotStep('02-confirm-a-layout-changed');
  await skipConfirmToFullWizard(page);

  console.log('3. Map fields (this used to throw at buildVersionFromWizard)...');
  await advanceWizardTo(page, 2);
  await shotStep('03-map-fields');
  await shotBottom('04-map-fields-bottom', '#wizard-steps');

  console.log('4. Map fields -> Test...');
  await advanceWizardTo(page, 3);
  await shotStep('05-test');
  await shotBottom('06-test-bottom', '#wizard-steps');

  console.log('5. Test -> Save...');
  await advanceWizardTo(page, 4);
  await shotStep('07-save');

  console.log('6. Save profile...');
  await page.click('#wizard-next');
  await page.waitForTimeout(800);
  await shotStep('08-home-after-save');

  const cleanLog = await assertCleanLog(page, 'CSV layout-changed via Update mapping (map5)', pageErrors);
  await context.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (!cleanLog.ok) throw new Error(`map5 scenario: ${cleanLog.problems.join('; ')}`);
}

/** Shoot both viewport widths the task asked for (1440 and 1280), one file per width, then restore 1440 for the rest of the scenario. */
async function shotBothWidths(prefix, page, name) {
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shotsDir, `${prefix}-${name}-1440.png`), fullPage: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shotsDir, `${prefix}-${name}-1280.png`), fullPage: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
}

/**
 * Task verification 1: generic_unknown_bank.csv (no auto-detectable date -
 * Screen A itself already shows the blank preview) via the plain Yes path
 * end to end, separate from map4's "Something else" manual-mapping path
 * against the same fixture.
 */
async function runConfirmYesGenericBankScenario() {
  console.log('\n=== scenario: confirm-first Yes path, generic_unknown_bank.csv (prefix confirmyes) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'confirmyes');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'generic_unknown_bank.csv');

  console.log('1. drop the fixture, land on Screen A...');
  await dropAndOpenWizard(page, fixture);
  await shotStep('01-confirm-a');
  const cells = await page.$$eval('#confirm-a-preview tbody tr', (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())));
  check('Screen A shows at least 3 preview rows', cells.length >= 3, `rows=${cells.length}`);
  check('Screen A preview has a date on every row', cells.length > 0 && cells.every((c) => /\d{4}-\d{2}-\d{2}|\d{1,2}[\/ -]/.test(c[0] || '')), JSON.stringify(cells.map((c) => c[0])));
  check('Screen A preview has a description on every row', cells.length > 0 && cells.every((c) => (c[1] || '').length > 0), JSON.stringify(cells.map((c) => c[1])));
  const yesDisabled = await page.$eval('#confirm-yes', (b) => b.disabled);
  check('Yes is enabled only when the preview is complete', !yesDisabled, `disabled=${yesDisabled}`);

  console.log('2. Yes, looks right -> Screen C -> Save and finish...');
  await page.click('#confirm-yes');
  await page.waitForTimeout(200);
  await shotStep('02-confirm-c');
  await page.click('#confirm-save');
  await page.waitForFunction(() => /Done, \d+ transactions/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  await shotStep('03-home-after-save');
  const bodyText = await page.evaluate(() => document.body.innerText);
  const done = bodyText.match(/Done, (\d+) transactions/);
  check('Home shows the saved file as done with a row count', !!done && Number(done[1]) >= 3, done ? done[0] : 'no "Done, N transactions" on Home');
  check('Home does not show a could-not-read-dates state for the saved file', !/Could not read dates/i.test(bodyText), /Could not read dates/i.test(bodyText) ? 'found "Could not read dates"' : '');

  const cleanLog = await assertCleanLog(page, 'confirm-first Yes path (confirmyes)', pageErrors);
  await context.close();
  if (!cleanLog.ok) throw new Error(`confirmyes scenario: ${cleanLog.problems.join('; ')}`);
}

/**
 * Task verification 2: harbour_card_crdr.csv with "Transaction Date"
 * renamed to "Txn Date" (still in the date synonym dictionary, so mapping
 * still resolves on its own - the exact single-header-rename technique
 * map5 uses) turns an exact match into formatChanged, landing on the
 * confirm-first wizard via the Home "Update mapping" card. Verifies Screen
 * A's "This looks different from last time..." heading (item 4), then the
 * plain Yes path to Save.
 *
 * No profile ships with the extension (NO-TEMPLATES.md item 1), so this
 * seeds the matching Harbour Card credit-card profile itself first -
 * standing in for a user who already saved the un-renamed export through
 * confirm-first - since what's under test here is the Update-mapping
 * heading, not the confirm-first save flow.
 */
async function runConfirmUpdateMappingScenario() {
  console.log('\n=== scenario: confirm-first Update-mapping heading, harbour_card_crdr.csv renamed header (prefix confirmupdate) ===');
  const srcFixture = path.join(extensionPath, 'test', 'fixtures', 'harbour_card_crdr.csv');
  const csv = fs.readFileSync(srcFixture, 'utf8').replace('Transaction Date', 'Txn Date');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-e2e-fixture-'));
  const fixture = path.join(fixtureDir, 'harbour_card_crdr.csv');
  fs.writeFileSync(fixture, csv);

  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'confirmupdate');

  await page.evaluate(async (profiles) => { await chrome.storage.local.set({ profiles }); },
    sampleProfiles().filter((p) => p.bank === 'Harbour Card'));

  console.log('1. drop the renamed-header export, wait for the Layout-changed card, click Update mapping...');
  await page.$('#file-input').then((el) => el.setInputFiles(fixture));
  await page.waitForSelector('button:has-text("Set up again")', { timeout: 60000 });
  await page.click('button:has-text("Set up again")');
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
  await shotStep('01-confirm-a-layout-changed');

  const heading = await page.textContent('#confirm-a-heading');
  console.log('   Screen A heading:', heading);
  if (!/looks different from last time/i.test(heading || '')) {
    throw new Error(`confirmupdate scenario: expected "looks different from last time" heading, got: ${heading}`);
  }

  console.log('2. Yes, looks right -> Screen C -> Save and finish...');
  await page.click('#confirm-yes');
  await page.waitForTimeout(200);
  await shotStep('02-confirm-c');
  await page.click('#confirm-save');
  await page.waitForTimeout(800);
  await shotStep('03-home-after-save');

  const cleanLog = await assertCleanLog(page, 'confirm-first Update-mapping heading (confirmupdate)', pageErrors);
  await context.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (!cleanLog.ok) throw new Error(`confirmupdate scenario: ${cleanLog.problems.join('; ')}`);
}

/**
 * Task verification 3: summit_card_sample.pdf (a columns-rowModel credit-card
 * PDF) via "Something's off" -> "Rows are missing or extra", landing on the
 * real anchor/column-boundary picker inside the confirm focus screen, then
 * Done back to Screen A and the plain Yes path to Save.
 */
async function runConfirmRowsBranchScenario() {
  console.log('\n=== scenario: confirm-first "Rows are missing or extra" branch, summit_card_sample.pdf (prefix confirmrows) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'confirmrows');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'summit_card_sample.pdf');

  console.log('1. drop the fixture, land on Screen A...');
  await dropAndOpenWizard(page, fixture);
  await shotStep('01-confirm-a');

  console.log('2. Something\'s off -> Screen B...');
  await page.click('#confirm-off');
  await page.waitForTimeout(200);
  await shotStep('02-confirm-b');

  console.log('3. "Rows are missing or extra" -> the real PDF anchor/column picker...');
  await page.click('#confirm-fix-rows');
  await page.waitForSelector('#confirm-focus:not([hidden])', { timeout: 10000 });
  await shotStep('03-confirm-focus-rows');

  console.log('4. Done -> back to Screen A -> Yes, looks right -> Save...');
  await page.click('#confirm-focus-done');
  await page.waitForTimeout(200);
  await shotStep('04-confirm-a-after-fix');
  await page.click('#confirm-yes');
  await page.waitForTimeout(200);
  await page.click('#confirm-save');
  await page.waitForTimeout(800);
  await shotStep('05-home-after-save');

  const cleanLog = await assertCleanLog(page, 'confirm-first Rows-are-missing branch (confirmrows)', pageErrors);
  await context.close();
  if (!cleanLog.ok) throw new Error(`confirmrows scenario: ${cleanLog.problems.join('; ')}`);
}

/**
 * Task verification 4: the image-only OCR fixture via the plain Yes path.
 * OCR runs automatically at drop time (see extension/README.md's "OCR for
 * image-only PDFs"), so by the time the wizard opens Screen A's preview
 * already reflects the OCR'd text.
 */

async function runFirstTimerUnknownPdfScenario() {
  console.log('\n=== scenario: first-timer, unknown-bank image PDF, primary prompts only (prefix firsttimerpdf) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'firsttimerpdf');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'summit_grouped_2line_image.pdf');
  try {
    console.log('1. drop the unknown image PDF, wait for reading, Set up...');
    await dropAndOpenWizard(page, fixture);
    await shotStep('01-after-setup-click');
    const onConfirmA = await page.isVisible('#confirm-a').catch(() => false);
    check('unknown image PDF lands on the confirm-first screen, not the bare wizard', onConfirmA, `confirm-a visible=${onConfirmA}`);
    if (onConfirmA) {
      const cells = await page.$$eval('#confirm-a-preview tbody tr', (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())));
      check('Screen A has dated rows with descriptions', cells.length >= 3 && cells.every((c) => c[0] && c[1]), JSON.stringify(cells.slice(0, 3)));
      const yesDisabled = await page.$eval('#confirm-yes', (b) => b.disabled);
      check('Yes is enabled', !yesDisabled, `disabled=${yesDisabled}`);
      await page.click('#confirm-yes');
      await page.waitForTimeout(200);
      await shotStep('02-confirm-c');
      const bank = await page.$eval('#confirm-name', (el) => el.value).catch(() => '');
      check('statement name is prefilled', bank.trim().length > 0, `name="${bank}"`);
      await page.click('#confirm-save');
      await page.waitForFunction(() => /Done, \d+ transactions/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
      await shotStep('03-home-after-save');
      const bodyText = await page.evaluate(() => document.body.innerText);
      const done = bodyText.match(/Done, (\d+) transactions/);
      check('Home shows the saved image PDF as done with a row count', !!done && Number(done[1]) >= 10, done ? done[0] : 'no Done line');
      check('Copy to Google Sheets is available', await page.$eval('#copy-tsv-btn', (b) => !b.disabled).catch(() => false), '');
    } else {
      await shotStep('02-wherever-it-landed');
    }
    const cleanLog = await assertCleanLog(page, 'first-timer unknown image PDF (firsttimerpdf)', pageErrors);
    if (!cleanLog.ok) throw new Error(`firsttimerpdf scenario: ${cleanLog.problems.join('; ')}`);
  } finally {
    await context.close();
  }
}

/**
 * Pass 3 fix items 1-3 gated scenario: a first-timer dropping an unknown
 * German bank CSV (semicolon-delimited, dotted dates "15.09.2026", German
 * number format "-45,23") and following ONLY the primary prompts the app
 * itself offers, all the way to Copy - the same walk PASS-3-first-timer.md
 * did by hand, now with real assertions instead of eyeballed screenshots.
 * Real dead end that report found: dotted dates never parsed, Map fields
 * offered no way out, and "Looks right" cleared the flag without fixing
 * anything. All three are fixed now (see FIX-PASS-3-LOG.md items 1-3); this
 * scenario is the regression guard.
 */
async function runFirstTimerGermanCsvScenario() {
  console.log('\n=== scenario: first-timer, unknown German-bank CSV, primary prompts only (prefix firsttimerde) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'firsttimerde');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'waldkonto_unbekannt.csv');
  try {
    console.log('1. drop the unknown German CSV, wait for Set up...');
    await dropAndOpenWizard(page, fixture);
    await shotStep('01-after-setup-click');
    const onConfirmA = await page.isVisible('#confirm-a').catch(() => false);
    check('unknown German CSV lands on the confirm-first screen, not the full 5-step wizard on an error banner', onConfirmA, `confirm-a visible=${onConfirmA}`);
    if (onConfirmA) {
      const heading = await page.textContent('#confirm-a-heading').catch(() => '');
      console.log('   heading:', heading);
      const cells = await page.$$eval('#confirm-a-preview tbody tr td:first-child', (tds) => tds.map((td) => td.textContent.trim()));
      // Item 10 (pass 3): confirm-a's preview now shows dates in Home's own
      // display format ("15 Sep 2026"), not raw ISO - accept either shape,
      // the point of this assertion is "a real parsed date, not blank/raw".
      check('every previewed row has a real (non-empty) date, not blank/unparsed', cells.length >= 3 && cells.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c) || /^\d{1,2} [A-Za-z]{3} \d{4}$/.test(c)), JSON.stringify(cells));
      const yesDisabled = await page.$eval('#confirm-yes', (b) => b.disabled);
      check('Yes is enabled (dotted German dates parsed)', !yesDisabled, `disabled=${yesDisabled}`);
      await page.click('#confirm-yes');
      await page.waitForTimeout(200);
      await shotStep('02-confirm-c');
      await page.click('#confirm-save');
      await page.waitForFunction(() => /Done, \d+ transactions/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
      await shotStep('03-home-after-save');
      const bodyText = await page.evaluate(() => document.body.innerText);
      const done = bodyText.match(/Done, (\d+) transactions/);
      check('Home shows the saved CSV as Done with a row count (real dates, no "could not read dates" dead end)', !!done && Number(done[1]) === 6, done ? done[0] : 'no Done line');
      check('no "Could not read dates" failure banner', !/Could not read dates/i.test(bodyText), bodyText.slice(0, 400));
      const copyEnabled = await page.$eval('#copy-tsv-btn', (b) => !b.disabled).catch(() => false);
      check('Copy to Google Sheets is available', copyEnabled, '');
      if (copyEnabled) {
        await page.click('#copy-tsv-btn');
        await page.waitForFunction(() => /Copied \d+ (rows?|transactions?) to the clipboard/i.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
        const afterCopy = await page.evaluate(() => document.body.innerText);
        const copied = afterCopy.match(/Copied (\d+) (?:rows?|transactions?) to the clipboard/i);
        check('Copy produced the toast with the real row count (6)', !!copied && Number(copied[1]) === 6, copied ? copied[0] : 'no copy toast');
        await shotStep('04-after-copy');
      }
    } else {
      await shotStep('02-wherever-it-landed');
    }
    const cleanLog = await assertCleanLog(page, 'first-timer German CSV (firsttimerde)', pageErrors);
    if (!cleanLog.ok) throw new Error(`firsttimerde scenario: ${cleanLog.problems.join('; ')}`);
  } finally {
    await context.close();
  }
}

async function runConfirmOcrYesScenario() {
  console.log('\n=== scenario: confirm-first Yes path, OCR image-only PDF (prefix confirmocr) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'confirmocr');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_image.pdf');

  console.log('1. drop the OCR fixture, land on Screen A...');
  await dropAndOpenWizard(page, fixture);
  await shotStep('01-confirm-a');

  console.log('2. Yes, looks right -> Screen C -> Save and finish...');
  await page.click('#confirm-yes');
  await page.waitForTimeout(200);
  await shotStep('02-confirm-c');
  await page.click('#confirm-save');
  await page.waitForTimeout(800);
  await shotStep('03-home-after-save');

  const cleanLog = await assertCleanLog(page, 'confirm-first OCR Yes path (confirmocr)', pageErrors);
  await context.close();
  if (!cleanLog.ok) throw new Error(`confirmocr scenario: ${cleanLog.problems.join('; ')}`);
}

/**
 * Screenshot gallery for the confirm-first screens themselves (SIMPLE-
 * BUILD.md Section 2's screenshot deliverable): Screen A, Screen B, each of
 * B's three fix branches, and Screen C, at both 1440 and 1280 widths. Uses a
 * clean CSV (meridian_savings.csv) so Screen A's own detection has real
 * dates/amounts to show - the four scenarios above cover the harder
 * detection edge cases; this one is purely for the visual record.
 */
async function runConfirmScreensGalleryScenario() {
  console.log('\n=== scenario: confirm-first screens gallery (prefix setup) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'meridian_savings.csv');
  let n = 1;
  const shotBoth = async (name) => { await shotBothWidths('setup', page, `${String(n).padStart(2, '0')}-${name}`); n += 1; };

  console.log('1. drop a clean CSV, open the wizard, land on Screen A...');
  await dropAndOpenWizard(page, fixture);
  await shotBoth('confirm-a');

  console.log('2. Something\'s off -> Screen B...');
  await page.click('#confirm-off');
  await page.waitForTimeout(200);
  await shotBoth('confirm-b');

  console.log('3. Screen B -> "Dates are wrong" -> focus -> Done back to A...');
  await page.click('#confirm-fix-dates');
  await page.waitForTimeout(200);
  await shotBoth('confirm-b-dates');
  await page.click('#confirm-focus-done');
  await page.waitForTimeout(200);

  console.log('4. Screen A -> Something\'s off -> "Amounts or +/- are wrong" -> focus -> Done...');
  await page.click('#confirm-off');
  await page.waitForTimeout(200);
  await page.click('#confirm-fix-amounts');
  await page.waitForTimeout(200);
  await shotBoth('confirm-b-amounts');
  await page.click('#confirm-focus-done');
  await page.waitForTimeout(200);

  console.log('5. Screen A -> Something\'s off -> "Rows are missing or extra" -> focus -> Done...');
  await page.click('#confirm-off');
  await page.waitForTimeout(200);
  await page.click('#confirm-fix-rows');
  await page.waitForTimeout(200);
  await shotBoth('confirm-b-rows');
  await page.click('#confirm-focus-done');
  await page.waitForTimeout(200);

  console.log('6. Screen A -> Yes, looks right -> Screen C...');
  await page.click('#confirm-yes');
  await page.waitForTimeout(200);
  await shotBoth('confirm-c');

  console.log('7. Save and finish -> back to Home...');
  await page.click('#confirm-save');
  await page.waitForTimeout(800);
  await shotBoth('home-after-save');

  const cleanLog = await assertCleanLog(page, 'confirm-first screens gallery (setup)', pageErrors);
  await context.close();
  if (!cleanLog.ok) throw new Error(`setup scenario: ${cleanLog.problems.join('; ')}`);
}

/**
 * Track 4 (manual range/sheet selection): a CSV whose auto-detected header
 * row is wrong - a 3-cell preamble line ("Reference, Type, Amount") right
 * above a same-width filler row fools suggestHeaderRow into guessing row 3
 * instead of the real header 6 rows down - plus a 2-row footer
 * ("Note"/"Printed" lines) that's full-width and carries no total/balance
 * wording, so suggestFooterRows' own heuristic never auto-skips it either.
 * The wrong guess still produces a plausible-looking 2-row confirm-first
 * preview (an amount-shaped column parses under any header), so this walks
 * the real "Something's off" -> "Rows are missing or extra" path to the
 * Locate-data grid, fixes it there (real header row + "last data row"), Done
 * back to Screen A (now showing the real rows), Save, then re-drops the same
 * file and confirms it auto-matches - the whole point of persisting
 * rangeRules onto the saved profile version.
 */
async function runManualRangeScenario() {
  console.log('\n=== scenario: manual range/sheet selection grid (prefix range) ===');
  // No blank lines: csv.js's trimLines() drops empty lines outright, which
  // would shift every row number below one - keeping every row non-empty
  // means "row 9"/"row 11" below match the on-screen grid exactly.
  const csv = [
    'MockBank Pte Ltd', 'Statement of Account',
    'Reference,Type,Amount', 'N/A,N/A,N/A',
    'Account No:,1234567890', 'Currency:,SGD',
    'Period:,01 Jun 2026,30 Jun 2026', 'Opening Balance:,1000.00',
    'Date,Description,Amount',
    '01/06/2026,Coffee,-5.00',
    '02/06/2026,Salary,3000.00',
    'Note,See T&Cs,for details',
    'Printed,on 01/07/2026,by system',
  ].join('\n');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-e2e-fixture-'));
  const fixture = path.join(fixtureDir, 'mockbank_wrong_header.csv');
  fs.writeFileSync(fixture, csv);

  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'range');

  console.log('1. drop the wrong-header-guess CSV, land on confirm-first Screen A...');
  await dropAndOpenWizard(page, fixture);
  // The wrong guess still produces 2 "rows" (an amount-shaped column parses
  // regardless of which header it sits under), so Screen A shows a plausible
  // but wrong preview (Description holding the dates, no real Date column) -
  // this is exactly the case "Something's off" -> "Rows are missing or
  // extra" exists for, not the separate zero-rows fallback.
  await shotBothWidths('range', page, '01-after-setup');
  // The completeness gate must NOT let a mis-detected header reach "Does this
  // look right?" with blank dates: it routes straight to the grid with an
  // explanation. Accept either route into the grid.
  const onConfirmA = await page.isVisible('#confirm-a').catch(() => false);
  if (onConfirmA) {
    const wrongPreview = await page.textContent('#confirm-a-preview');
    const cells = await page.$$eval('#confirm-a-preview tbody tr td:first-child', (tds) => tds.map((td) => td.textContent.trim()));
    check('Screen A is only shown when dates were detected', cells.every((c) => /\d/.test(c)), JSON.stringify(cells));
    console.log('2. Something\'s off -> Rows are missing or extra -> the real Locate-data grid...');
    await page.click('#confirm-off');
    await page.waitForTimeout(200);
    await page.click('#confirm-fix-rows');
    await page.waitForSelector('#confirm-focus:not([hidden]), #wizard-steps:not([hidden])', { timeout: 10000 });
    void wrongPreview;
  } else {
    console.log('2. routed straight to the grid (dates were not detected)...');
    await page.waitForSelector('#w-rawgrid', { timeout: 10000 });
    const intro = await page.$eval('#wizard-step-intro', (el) => (el.hidden ? '' : el.textContent)).catch(() => '');
    check('grid route explains itself', /could not (tell|find)|not sure/i.test(intro), intro);
  }
  await shotBothWidths('range', page, '02-locate-wrong-guess');

  console.log('3. click the real header row (row 9) in the grid...');
  await page.click('#w-rawgrid tbody tr:nth-child(9) .raw-use-header-btn');
  await page.waitForTimeout(200);
  await shotBothWidths('range', page, '03-locate-header-fixed');

  console.log('4. click "last" on the final real transaction row (row 11) to drop the 2-row footer...');
  await page.click('#w-rawgrid tbody tr:nth-child(11) .raw-row-action-btn:has-text("last")');
  await page.waitForTimeout(200);
  await shotBothWidths('range', page, '04-locate-last-row-set');

  const excludedNote = await page.textContent('#w-rawgrid tbody tr:nth-child(12)').catch(() => '');
  console.log('   footer row struck through:', /Note/.test(excludedNote || ''));

  if (onConfirmA) {
    console.log('5. Done -> back to Screen A, confirm the fix produced the real 2 rows...');
    await page.click('#confirm-focus-done');
    await page.waitForTimeout(200);
    await shotStep('05-confirm-a-fixed');
    const fixedPreview = await page.textContent('#confirm-a-preview');
    check('fixed preview shows Coffee and Salary and no footer rows', /Coffee/.test(fixedPreview) && /Salary/.test(fixedPreview) && !/Note|Printed/.test(fixedPreview), fixedPreview.slice(0, 120));
    console.log('6. Yes, looks right -> Save and finish...');
    await page.click('#confirm-yes');
    await page.waitForTimeout(200);
    await shotStep('06-confirm-c');
    await page.click('#confirm-save');
  } else {
    console.log('5. Continue through Map fields and Test to Save on the detailed route...');
    for (let i = 0; i < 4; i++) {
      const label = await page.textContent('#wizard-next').catch(() => '');
      await page.click('#wizard-next');
      await page.waitForTimeout(300);
      if (/Save and finish/.test(label)) break;
    }
    await shotStep('05-detailed-route-test');
    const testText = await page.textContent('#wizard-steps').catch(() => '');
    check('detailed route reaches Save with the real rows', /Coffee/.test(testText) && /Salary/.test(testText), testText.slice(0, 120));
    if (await page.isVisible('#wizard-next')) await page.click('#wizard-next').catch(() => {});
  }
  await page.waitForTimeout(800);
  await shotStep('07-home-after-save');

  console.log('7. re-drop the same file, confirm it auto-matches (rangeRules round-tripped through the saved profile)...');
  await page.$('#file-input').then((el) => el.setInputFiles(fixture));
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low', { timeout: 120000 });
  await shotStep('08-home-redrop-matched');

  const cleanLog = await assertCleanLog(page, 'manual range/sheet selection grid (range)', pageErrors);
  await context.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (!cleanLog.ok) throw new Error(`range scenario: ${cleanLog.problems.join('; ')}`);
}

/**
 * Item B (NO-TEMPLATES, 2026-09-20): the default export is the union of what
 * was actually imported - Date/Account/Description/Amount/Currency plus only
 * the optional fields the loaded statements really carry, never Statement
 * type/Bank/File, and never a blank Account cell. Loads a PDF and a CSV
 * (whose own "Posting Date"/"Type" columns are what widens the union), then
 * screenshots the result card's export preview at both widths.
 */
async function runUnionExportScenario() {
  console.log('\n=== scenario: union default export (prefix union2) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const outDir = path.join(os.homedir(), 'Desktop', 'StatementBridge', 'audit', 'fix-shots');
  fs.mkdirSync(outDir, { recursive: true });

  for (const name of ['northwind_transaction_history_flags.pdf', 'anchor_checking.csv']) {
    console.log(`1. drop ${name}, confirm-first setup (Set up -> Yes -> Save)...`);
    await dropAndOpenWizard(page, path.join(extensionPath, 'test', 'fixtures', name));
    // anchor_checking.csv is month-first, which the wizard can't tell on its
    // own - it opens straight on the date-format picker (the same focus
    // screen "Something's off -> the dates" reaches). Answer it, then carry
    // on to Screen A.
    if (await page.isVisible('#confirm-focus').catch(() => false)) {
      await page.selectOption('#w-dateformat', 'MM/DD/YYYY');
      await page.waitForTimeout(300);
      await page.click('#confirm-focus-done');
    }
    await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('confirm-a-heading')?.textContent?.trim().length > 0, { timeout: 30000 });
    await page.click('#confirm-yes');
    await page.waitForSelector('#confirm-c:not([hidden])', { timeout: 20000 });
    await page.click('#confirm-save');
    await page.waitForSelector('#export-panel:not([hidden])', { timeout: 30000 });
    await page.waitForTimeout(800);
  }

  const headers = await page.$$eval('#result-table thead th', (ths) => ths.map((th) => th.textContent.trim()));
  console.log('   column list:', JSON.stringify(headers));
  check('default export starts with Date, Account, Description, Amount, Currency',
    JSON.stringify(headers.slice(0, 5)) === JSON.stringify(['Date', 'Account', 'Description', 'Amount', 'Currency']), JSON.stringify(headers));
  for (const banned of ['Statement type', 'Bank', 'File']) {
    check(`default export never includes ${banned}`, !headers.some((h) => h.toLowerCase() === banned.toLowerCase()), JSON.stringify(headers));
  }
  check('at most 8 columns in the preview', headers.length <= 8, `columns=${headers.length}`);

  const accountCells = await page.$$eval('#result-table tbody td[data-field="account_label"]', (tds) => tds.map((td) => td.textContent.trim()));
  check('no empty Account cell', accountCells.length > 0 && accountCells.every((t) => t.length > 0), JSON.stringify([...new Set(accountCells)]));

  // No header may be cut off by the preview's own horizontal scroll box.
  const truncated = await page.$$eval('#result-table thead th', (ths) => ths
    .filter((th) => th.scrollWidth > th.clientWidth + 1 || th.getBoundingClientRect().right > th.closest('.preset-preview-scroll').getBoundingClientRect().right + 1)
    .map((th) => th.textContent.trim()));
  check('no truncated header', truncated.length === 0, JSON.stringify(truncated));

  const summary = await page.textContent('#change-drawer-title').catch(() => '');
  check('export-settings summary does not call an untouched default "Customised"', !/Customised/.test(summary || ''), summary || '');

  const card = await page.$('#export-panel');
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(400);
    await card.screenshot({ path: path.join(outDir, `union2-${width}.png`) });
  }
  console.log('   screenshots:', path.join(outDir, 'union2-1440.png'), path.join(outDir, 'union2-1280.png'));

  const cleanLog = await assertCleanLog(page, 'union default export (union2)', pageErrors);
  await context.close();
  if (!cleanLog.ok) throw new Error(`union2 scenario: ${cleanLog.problems.join('; ')}`);
}

// Optional CLI filter (`node dev/e2e-extension.mjs map2 map3 ...`) so a long
// run can be split into several sub-400s invocations without ever running
// two at once - each name still launches its own fresh browser context in
// sequence, same as running the whole file.
async function runAmbiguousDatesScenario() {
  console.log('\n=== scenario: every date reads both ways, confirm A offers the other reading (prefix ambigdates) ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  const shotStep = shotter(page, 'ambigdates');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'generic_ambiguous_dates.csv');
  try {
    await dropAndOpenWizard(page, fixture);
    await shotStep('01-confirm-a');
    const notice = await page.textContent('#confirm-a-notice').catch(() => '');
    check('confirm A says the dates could be day-first or month-first', /day-first or month-first/.test(notice), notice);
    const yesDisabled = await page.$eval('#confirm-yes', (b) => b.disabled);
    check('Yes stays enabled', !yesDisabled, '');
    const before = await page.$$eval('#confirm-a-preview tbody tr td:first-child', (tds) => tds.map((td) => td.textContent.trim()));
    await page.click('#confirm-a-swap-dates');
    await page.waitForTimeout(150);
    await shotStep('02-after-swap');
    const after = await page.$$eval('#confirm-a-preview tbody tr td:first-child', (tds) => tds.map((td) => td.textContent.trim()));
    check('swapping the reading changes the previewed dates', before[0] === '10 Sep 2026' && after[0] === '9 Oct 2026', JSON.stringify({ before: before[0], after: after[0] }));
    const notice2 = await page.textContent('#confirm-a-notice').catch(() => '');
    check('the notice now offers day/month/year', /day\/month\/year instead/.test(notice2), notice2);
    const cleanLog = await assertCleanLog(page, 'ambiguous dates (ambigdates)', pageErrors);
    if (!cleanLog.ok) throw new Error(`ambigdates scenario: ${cleanLog.problems.join('; ')}`);
  } finally {
    await context.close();
  }
}


// --- EXPORT-AND-DUPES rule 5: cross-file duplicate decisions --------------
// Two Meridian Bank exports of the SAME account whose date ranges differ (a
// June-only export next to a June-to-July one) repeat three transactions.
// That is not a re-download of one month, so nothing may merge silently:
// each repeated transaction is ONE decision card showing BOTH rows and both
// file names, and nothing is dropped until the user answers.
//
// Note on the spec's "two different-type CSVs" variant: unreachable in the
// real app by design - the dedupe fingerprint is scoped to the account
// label, which carries the statement type (home-state.js's
// defaultAccountLabel), so a savings row and a credit-card row never
// fingerprint-match in the first place. The same-account, different-range
// pair below is the reachable form of that question, so run 2 answers it
// with "Keep both" instead.
function writeDupFixtures() {
  const srcPath = path.join(extensionPath, 'test', 'fixtures', 'meridian_savings_40rows.csv');
  const lines = fs.readFileSync(srcPath, 'utf8').split('\n');
  const headerBlock = lines.slice(0, 6); // 4 preamble lines, a blank, the column header
  // The first three transactions with the description written differently
  // (same date, amount and balance): a near twin, which is the case that asks.
  const dataRows = lines.slice(6, 9).map((l) => l.replace(/^(\S+),([^,]+),/, (m, d, desc) => `${d},POS ${desc},`));
  const juneOnly = [
    headerBlock[0],
    headerBlock[1],
    'Statement Period: 01 Jun 2026 to 30 Jun 2026',
    headerBlock[3],
    '',
    headerBlock[5],
    ...dataRows,
    '20/06/2026,PAYNOW UNIQUE 999,,9.00,5000.00',
    'Total,0.00,9.00,',
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-e2e-dups-'));
  const wide = path.join(dir, 'meridian_jun_jul.csv');
  const narrow = path.join(dir, 'meridian_june.csv');
  fs.writeFileSync(wide, lines.join('\n'));
  fs.writeFileSync(narrow, juneOnly);
  return { wide, narrow, names: ['meridian_jun_jul.csv', 'meridian_june.csv'] };
}

/** The transaction count off the result card's own headline ("44 transactions from 2 statements ..."). */
async function exportedRowCount(page) {
  const text = await page.textContent('#export-summary');
  return Number((text.match(/(\d+)\s+transaction/) || [])[1]);
}

async function dropBothDupFixtures(page, fixtures) {
  await page.evaluate(async (profiles) => { await chrome.storage.local.set({ profiles }); },
    sampleProfiles().filter((p) => p.bank === 'Meridian Bank'));
  await page.$('#file-input').then((el) => el.setInputFiles([fixtures.wide, fixtures.narrow]));
  await page.waitForFunction(() => document.querySelectorAll('.file-row .badge-ok, .file-row .badge-warn').length >= 2, { timeout: 120000 });
  await page.waitForSelector('#attention-cards [data-test="duplicate-pairs"]', { timeout: 30000 });
  await page.waitForTimeout(400);
}

async function runDuplicatePairScenario() {
  console.log('\n=== scenario: cross-file duplicates ask once per pair (prefix dups) ===');
  const fixtures = writeDupFixtures();
  const outDir = path.join(extensionPath, 'audit', 'fix-shots');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('run 1: Keep one merges each pair...');
  let { context, page, pageErrors } = await launchExtensionContext();
  try {
    await dropBothDupFixtures(page, fixtures);
    const pairCount = await page.$$eval('[data-test="dup-pair"]', (els) => els.length);
    check('one decision card per repeated transaction (3 pairs)', pairCount === 3, `pairs=${pairCount}`);

    const cardsText = await page.textContent('#attention-cards');
    check('no per-row "Possible duplicate" card anywhere', !/Possible duplicate/.test(cardsText), cardsText.slice(0, 160));
    check('the card names what it is asking', /same transaction in two files/.test(cardsText), cardsText.slice(0, 160));

    const firstCard = await page.textContent('[data-test="dup-pair"]');
    check('the pair card shows both file names', fixtures.names.every((n) => firstCard.includes(n)), firstCard.replace(/\s+/g, ' ').slice(0, 220));
    const sides = await page.$$eval('[data-test="dup-pair"]:first-child [data-test="dup-side"]', (els) => els.length);
    check('the pair card shows two rows side by side', sides === 2, `sides=${sides}`);
    const defaultLabel = await page.textContent('[data-test="dup-pair"] button[data-default="true"]');
    check('CSV + CSV defaults to Keep both', /Keep both/.test(defaultLabel), defaultLabel);

    await page.screenshot({ path: path.join(outDir, 'dups-1440.png'), fullPage: false });
    console.log('   screenshot:', path.join(outDir, 'dups-1440.png'));

    const before = await exportedRowCount(page);
    check('nothing is dropped before the user answers', before === 44, `rows=${before}`);
    for (let i = 0; i < 3; i++) {
      await page.click('[data-test="dup-pair"] [data-test="dup-keep-one"]');
      await page.waitForTimeout(400);
    }
    const after = await exportedRowCount(page);
    check('Keep one drops exactly the pair count', after === before - 3, `before=${before} after=${after}`);
    const gone = await page.$('[data-test="duplicate-pairs"]');
    check('every question is answered, the banner is gone', !gone, '');
    const mergedNotice = await page.textContent('#dedupe-notice-line').catch(() => '');
    check('a hand-merged row is still undoable', /3 rows merged/.test(mergedNotice) && /Undo/.test(mergedNotice), mergedNotice);

    const cleanLog = await assertCleanLog(page, 'duplicate pairs, Keep one (dups)', pageErrors);
    if (!cleanLog.ok) throw new Error(`dups scenario (run 1): ${cleanLog.problems.join('; ')}`);
  } finally {
    await context.close();
  }

  console.log('run 2: Keep both leaves every row in place...');
  ({ context, page, pageErrors } = await launchExtensionContext());
  try {
    await dropBothDupFixtures(page, fixtures);
    const before = await exportedRowCount(page);
    for (let i = 0; i < 3; i++) {
      await page.click('[data-test="dup-pair"] [data-test="dup-keep-both"]');
      await page.waitForTimeout(400);
    }
    const after = await exportedRowCount(page);
    check('Keep both leaves the row count unchanged', after === before, `before=${before} after=${after}`);
    const gone = await page.$('[data-test="duplicate-pairs"]');
    check('an answered question never comes back', !gone, '');
    const cleanLog = await assertCleanLog(page, 'duplicate pairs, Keep both (dups)', pageErrors);
    if (!cleanLog.ok) throw new Error(`dups scenario (run 2): ${cleanLog.problems.join('; ')}`);
  } finally {
    await context.close();
  }
}

const SCENARIOS = {
  map2: runMapFieldsScenario,
  map3: runFlagResolutionScenario,
  map4: runUnknownCsvMappingScenario,
  map5: runCsvLayoutChangedUpdateMappingScenario,
  confirmyes: runConfirmYesGenericBankScenario,
  confirmupdate: runConfirmUpdateMappingScenario,
  confirmrows: runConfirmRowsBranchScenario,
  confirmocr: runConfirmOcrYesScenario,
  firsttimerpdf: runFirstTimerUnknownPdfScenario,
  firsttimerde: runFirstTimerGermanCsvScenario,
  ambigdates: runAmbiguousDatesScenario,
  setup: runConfirmScreensGalleryScenario,
  range: runManualRangeScenario,
  union2: runUnionExportScenario,
  dups: runDuplicatePairScenario,
};

async function main() {
  const requested = process.argv.slice(2);
  const names = requested.length ? requested : Object.keys(SCENARIOS);
  for (const name of names) {
    if (!SCENARIOS[name]) throw new Error(`unknown scenario "${name}" - known: ${Object.keys(SCENARIOS).join(', ')}`);
    await SCENARIOS[name]();
  }
  console.log('\ndone. screenshots in', shotsDir);
}

main().then(() => { if (checkFailures) { console.error(`${checkFailures} check(s) failed`); process.exit(1); } }).catch((err) => { console.error(err); process.exit(1); });
