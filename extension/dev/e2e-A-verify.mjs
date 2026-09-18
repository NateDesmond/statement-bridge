// Section A verification pass (2026-09-17 feedback items 1-7): real
// unpacked extension in the bundled headless Chromium, walking the wizard
// against the OCR fixture, the flags fixture, and the 3-page fixture.
// Screenshots land in audit/fix-shots/A*-*.png - read them, not just the
// console output.
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(extensionPath, 'audit', 'fix-shots');
fs.mkdirSync(shotsDir, { recursive: true });

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-a-verify-'));
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
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page };
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

async function dropAndOpenWizard(page, fixturePath) {
  await page.$('#file-input').then((el) => el.setInputFiles(fixturePath));
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, button:has-text("Map this statement")', { timeout: 60000 });
  const mapBtn = await page.$('button:has-text("Map this statement")');
  if (mapBtn) await mapBtn.click();
  else {
    await page.click('#change-link');
    await page.waitForSelector('#drawer-mapping-list .mapping-row', { timeout: 10000 });
    await page.click('#drawer-mapping-list .mapping-row a:has-text("Set up again")');
  }
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
}

// --- Scenario A1: OCR fixture - items 1, 2, 5, 7 -----------------------
async function scenarioOcrFixture() {
  console.log('\n=== A1-A2-A5-A7: OCR fixture (northwind_transaction_history_image.pdf) ===');
  const { context, page } = await launchExtensionContext();
  const shotStep = shotter(page, 'A1');
  const shotBottom = bottomShotter(page, 'A1');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_image.pdf');

  await dropAndOpenWizard(page, fixture);
  await shotStep('01-basics');

  console.log('1. Basics -> (Locate data, may be auto-skipped)...');
  await page.click('#wizard-next');
  await page.waitForTimeout(500);
  const onMapAlready = await page.$('#step-2.active');
  if (!onMapAlready) {
    console.log('   landed on Locate data (low confidence) - screenshotting actions...');
    await shotStep('02-locate-lowconf');
    const actionButtons = await page.$$eval('#pdf-locate-actions button', (els) => els.map((e) => e.textContent.trim()));
    console.log('   locate actions found:', actionButtons);
    await page.click('#wizard-next');
    await page.waitForTimeout(500);
  } else {
    console.log('   SKIPPED straight to Map fields (confidence >= 0.9) - item 1');
  }
  await shotStep('03-map-fields-top');
  const bannerText = await page.textContent('#w-locate-summary').catch(() => null);
  console.log('   Map-fields locate-summary banner:', bannerText);

  console.log('2. Map fields -> Test (item 5: flags must show now, not silently appear after Save)...');
  await page.click('#wizard-next');
  await page.waitForTimeout(500);
  await shotStep('04-test-top');
  await shotBottom('05-test-bottom', '#wizard-steps');
  const flagsLine = await page.textContent('p.pdf-anchor-hint:has-text("Flags:")').catch(() => null);
  console.log('   Test step flags line:', flagsLine);
  const flagCounts = {};
  for (const chip of await page.$$('.flag-chip')) flagCounts[(await chip.textContent()).trim()] = true;
  console.log('   flag chips:', Object.keys(flagCounts));

  console.log('3. Resolve every flagged row with "Looks right"...');
  let resolveBtns = await page.$$('.row-resolve-actions .row-confirm-btn');
  let guard = 0;
  while (resolveBtns.length && guard++ < 50) {
    await resolveBtns[0].click();
    await page.waitForTimeout(150);
    resolveBtns = await page.$$('.row-resolve-actions .row-confirm-btn');
  }
  await shotStep('06-test-all-resolved');

  console.log('4. Test -> Save (item 7: signatures list + explanation copy)...');
  await page.click('#wizard-next');
  await page.waitForTimeout(500);
  await shotStep('07-save-top');
  const sigExplain = await page.textContent('#step-4 .pdf-anchor-hint').catch(() => null);
  console.log('   Save step explanation line:', sigExplain);
  const sigItems = await page.$$eval('#w-signatures-human li', (els) => els.map((e) => e.textContent.trim()));
  console.log('   signature phrases:', sigItems);

  console.log('5. Save profile -> Home status must read "Done, N transactions" (item 5)...');
  await page.click('#wizard-next');
  await page.waitForTimeout(800);
  await shotStep('08-home-after-save');
  const badgeText = await page.textContent('.file-row .badge').catch(() => null);
  console.log('   Home badge after save:', badgeText);
  if (badgeText && !/^done, /i.test(badgeText)) {
    console.log('   *** ITEM 5 FAILED: expected "Done, N transactions" after resolving every flag in Test ***');
  } else {
    console.log('   item 5 OK: Home status is "Done, N transactions" post-save');
  }

  await context.close();
}

// --- Scenario A6: flags fixture - inline Fix editing (item 6) ----------
async function scenarioFlagsFixtureInlineEdit() {
  console.log('\n=== A6: flags fixture, inline Fix editing ===');
  const { context, page } = await launchExtensionContext();
  const shotStep = shotter(page, 'A6');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_flags.pdf');

  await dropAndOpenWizard(page, fixture);
  // Click Continue until the Test step is active - item 1's confidence-based
  // skip means this is no longer always exactly 3 clicks.
  for (let i = 0; i < 5 && !(await page.$('#step-3.active')); i++) {
    await page.click('#wizard-next');
    await page.waitForTimeout(400);
  }
  await shotStep('01-test-with-flags');

  const resolveRows = await page.$$('.row-resolve-actions');
  console.log(`   found ${resolveRows.length} row(s) with resolve actions`);
  if (resolveRows.length) {
    await resolveRows[0].$('button:has-text("Fix")').then((btn) => btn.click());
    await page.waitForTimeout(300);
    await shotStep('02-fix-inline-inputs');
    const inlineInputs = await page.$$('tr.editing-row .cell-edit-input');
    console.log(`   inline editable cells on the editing row: ${inlineInputs.length} (expect 3: date/description/amount)`);
    const descInput = await page.$('tr.editing-row .row-fix-desc');
    if (descInput) {
      await descInput.fill('Edited description');
      await descInput.press('Enter');
      await page.waitForTimeout(300);
    }
    await shotStep('03-after-inline-save');
    const editedRow = await page.$('tr.edited');
    console.log('   an "edited" row marker is present:', !!editedRow);
  } else {
    console.log('   *** no flagged rows found - could not exercise item 6 ***');
  }

  await context.close();
}

// --- Scenario A3-page: 3-page fixture extraction correctness -----------
async function scenario3PageFixture() {
  console.log('\n=== 3-page fixture (northwind_transaction_history_3p.pdf) ===');
  const { context, page } = await launchExtensionContext();
  const shotStep = shotter(page, 'A3p');
  const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_3p.pdf');

  await dropAndOpenWizard(page, fixture);
  await shotStep('01-basics');
  await page.waitForTimeout(500);
  await page.click('#wizard-next');
  await page.waitForTimeout(800);
  await shotStep('02-locate-or-map');
  const onMap = await page.$('#step-2.active');
  console.log('   skipped straight to Map fields (item 1, confidence fix):', !!onMap);
  if (!onMap) {
    console.log('   rowModel:', await page.evaluate(() => document.querySelector('#pdf-suggest-caption')?.textContent));
    const wholeFileCaption = await page.textContent('#pdf-wholefile-caption').catch(() => null);
    console.log('   whole-file caption (Locate data):', wholeFileCaption);
  } else {
    const bannerText = await page.textContent('#w-locate-summary').catch(() => null);
    console.log('   Map-fields skip banner:', bannerText);
    console.log('3. click "Change" - should open the Locate-data page preview...');
    await page.click('#w-locate-summary #w-locate-change');
    await page.waitForTimeout(500);
    await shotStep('03-change-opens-locate-preview');
    const onLocate = await page.$('#step-1.active');
    console.log('   Change landed on Locate data:', !!onLocate);
  }

  await context.close();
}

const scenario = process.argv[2];
const scenarios = { ocr: scenarioOcrFixture, flags: scenarioFlagsFixtureInlineEdit, threepage: scenario3PageFixture };
if (scenario && scenarios[scenario]) {
  await scenarios[scenario]();
} else {
  await scenarioOcrFixture();
  await scenarioFlagsFixtureInlineEdit();
  await scenario3PageFixture();
}
console.log('\nDone. Screenshots in', shotsDir);
