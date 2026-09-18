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
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e); console.log('[pageerror]', e.message); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
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
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, #attention-cards button:has-text("Set up")', { timeout: 60000 });
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
    await page.waitForSelector('#drawer-mapping-list .mapping-row', { timeout: 10000 });
    await page.click('#drawer-mapping-list .mapping-row a:has-text("Set up again")');
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
  if (!(await page.$('#wizard-confirm:not([hidden])'))) return;
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
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, #attention-cards button:has-text("Set up")', { timeout: 60000 });

  // Follow-up A (QA-REPORT.md finding 7): on a completely fresh profile
  // store this fixture doesn't always auto-match a built-in profile the way
  // QA's own long-lived session saw it do - so don't rely on that. Either
  // way, get the file mapped once (via the "Map this statement" wizard, or
  // it's already matched), then force a SECOND wizard open specifically
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
  await page.waitForSelector('#drawer-mapping-list .mapping-row', { timeout: 10000 });
  await page.click('#drawer-mapping-list .mapping-row a:has-text("Set up again")');
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
 * names as what turns a builtin-dbs-savings exact match into formatChanged:
 * true (Layout changed / Update mapping), never a fresh "Map this
 * statement". Walks Basics -> Map fields -> Test -> Save and relies on
 * assertCleanLog to fail on the pageerror or the wizard.* stack entry this
 * bug used to leave behind.
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

  console.log('2. Yes, looks right -> Screen C -> Save and finish...');
  await page.click('#confirm-yes');
  await page.waitForTimeout(200);
  await shotStep('02-confirm-c');
  await page.click('#confirm-save');
  await page.waitForTimeout(800);
  await shotStep('03-home-after-save');

  const cleanLog = await assertCleanLog(page, 'confirm-first Yes path (confirmyes)', pageErrors);
  await context.close();
  if (!cleanLog.ok) throw new Error(`confirmyes scenario: ${cleanLog.problems.join('; ')}`);
}

/**
 * Task verification 2: harbour_card_crdr.csv with "Transaction Date"
 * renamed to "Txn Date" (still in the date synonym dictionary, so mapping
 * still resolves on its own - the exact single-header-rename technique
 * map5 uses) turns the builtin-dbs-credit-card-v2-crdr exact match into
 * formatChanged, landing on the confirm-first wizard via the Home "Update
 * mapping" card. Verifies Screen A's "This looks different from last
 * time..." heading (item 4), then the plain Yes path to Save.
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
  await shotBothWidths('range', page, '01-confirm-a-wrong');
  const wrongPreview = await page.textContent('#confirm-a-preview');
  if (!/01\/06\/2026/.test(wrongPreview) || !/DATE/.test(wrongPreview.toUpperCase())) {
    throw new Error(`range scenario: expected the wrong-header preview to show a date under Description, got: ${wrongPreview}`);
  }

  console.log('2. Something\'s off -> Rows are missing or extra -> the real Locate-data grid...');
  await page.click('#confirm-off');
  await page.waitForTimeout(200);
  await page.click('#confirm-fix-rows');
  await page.waitForSelector('#confirm-focus:not([hidden])', { timeout: 10000 });
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

  console.log('5. Done -> back to Screen A, confirm the fix produced the real 2 rows...');
  await page.click('#confirm-focus-done');
  await page.waitForTimeout(200);
  await shotStep('05-confirm-a-fixed');
  const fixedPreview = await page.textContent('#confirm-a-preview');
  if (!/Coffee/.test(fixedPreview) || !/Salary/.test(fixedPreview) || /Note|Printed/.test(fixedPreview)) {
    throw new Error(`range scenario: expected the fixed preview to show Coffee/Salary and no footer rows, got: ${fixedPreview}`);
  }

  console.log('6. Yes, looks right -> Save and finish...');
  await page.click('#confirm-yes');
  await page.waitForTimeout(200);
  await shotStep('06-confirm-c');
  await page.click('#confirm-save');
  await page.waitForTimeout(800);
  await shotStep('07-home-after-save');

  console.log('7. re-drop the same file, confirm it auto-matches (rangeRules round-tripped through the saved profile)...');
  await page.$('#file-input').then((el) => el.setInputFiles(fixture));
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low', { timeout: 15000 });
  await shotStep('08-home-redrop-matched');

  const cleanLog = await assertCleanLog(page, 'manual range/sheet selection grid (range)', pageErrors);
  await context.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (!cleanLog.ok) throw new Error(`range scenario: ${cleanLog.problems.join('; ')}`);
}

// Optional CLI filter (`node dev/e2e-extension.mjs map2 map3 ...`) so a long
// run can be split into several sub-400s invocations without ever running
// two at once - each name still launches its own fresh browser context in
// sequence, same as running the whole file.
const SCENARIOS = {
  map2: runMapFieldsScenario,
  map3: runFlagResolutionScenario,
  map4: runUnknownCsvMappingScenario,
  map5: runCsvLayoutChangedUpdateMappingScenario,
  confirmyes: runConfirmYesGenericBankScenario,
  confirmupdate: runConfirmUpdateMappingScenario,
  confirmrows: runConfirmRowsBranchScenario,
  confirmocr: runConfirmOcrYesScenario,
  setup: runConfirmScreensGalleryScenario,
  range: runManualRangeScenario,
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

main().catch((err) => { console.error(err); process.exit(1); });
