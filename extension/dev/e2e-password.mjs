// Real-extension E2E for Track 2 (password-protected PDFs, HARDENING.md):
// loads the actual unpacked MV3 extension into the BUNDLED headless Chromium
// (playwright-core's own download, never channel:'chrome', never the user's
// real browser) - same launch pattern as dev/e2e-extension.mjs.
//
// Run: node dev/e2e-password.mjs
// Screenshots land in dev/shots/password-*.png; read them, don't just check
// the exit code.
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertCleanLog } from './lib/assert-clean-log.mjs';
import { gotoScreen } from './lib/nav.mjs';
import { PASSWORD, WRONG_PASSWORD } from '../test/fixtures/gen/gen-encrypted.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

const TEXT_FIXTURE = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_protected.pdf');
const IMAGE_FIXTURE = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_protected_image.pdf');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

async function launchExtensionContext() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pw-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // --headless=new below is what actually goes headless
    executablePath: chromium.executablePath(), // bundled Chromium only
    permissions: ['clipboard-read', 'clipboard-write'],
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
  // settings.js's Copy-debug-log button alert()s on success, and home.js's
  // "Remember a hint" link window.prompt()s for the hint text - accept both
  // so neither blocks the page, giving the prompt() a real answer.
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Usually your ID number plus date of birth' : undefined));
  await page.addInitScript(() => {
    window.__clipboardWrites = [];
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => { window.__clipboardWrites.push(text); return real(text); };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page, pageErrors };
}

async function shot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shotsDir, `password-${name}.png`), fullPage: false });
}

/** Drop `fixture`, wait for the password-prompt row, type WRONG_PASSWORD, assert the wrong-password message, then type the real PASSWORD and wait for the prompt to clear. */
async function dropAndUnlock(page, fixture, shotPrefix) {
  await page.$('#file-input').then((el) => el.setInputFiles(fixture));
  await page.waitForSelector('.fr-pw-input', { timeout: 30000 });
  await shot(page, `${shotPrefix}-prompt`);

  check('remembered-hint line is absent for a never-seen statement type', !(await page.$('.fr-caption')));

  await page.fill('.fr-pw-input', WRONG_PASSWORD);
  await page.click('.fr-pw-unlock');
  await page.waitForSelector('.fr-pw-wrong', { timeout: 10000 });
  await shot(page, `${shotPrefix}-wrong`);
  check('wrong-password message shown, still on the prompt row', !!(await page.$('.fr-pw-input')));

  await page.fill('.fr-pw-input', PASSWORD);
  await page.click('.fr-pw-unlock');
  await page.waitForSelector('.fr-pw-input', { state: 'detached', timeout: 30000 });
  await shot(page, `${shotPrefix}-unlocked`);
  check('password prompt cleared after the correct password', true);
}

/** Never-logged proof (HARDENING.md's "password held in memory only, never logged"): read the REAL running debug log back via Settings' own Copy-debug-log button and assert neither password string appears anywhere in it. */
async function assertPasswordNeverLogged(page, label) {
  await gotoScreen(page, 'settings');
  await page.click('#settings-copy-debuglog-btn');
  await page.waitForFunction(() => window.__clipboardWrites.length > 0, { timeout: 5000 });
  const log = await page.evaluate(() => window.__clipboardWrites.at(-1));
  check(`${label}: debug log never contains the real password`, !log.includes(PASSWORD), `log length ${log.length}`);
  check(`${label}: debug log never contains the wrong password either`, !log.includes(WRONG_PASSWORD));
  await page.click('#shell-back-btn');
  await page.waitForSelector('#screen-home.active');
}

/** Scenario 1: encrypted text PDF, wrong then right password, then the never-logged proof. */
async function runTextPdfScenario() {
  console.log('\n=== scenario: encrypted text PDF, wrong then right password ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  await dropAndUnlock(page, TEXT_FIXTURE, 'text');

  console.log('checking the file continues exactly like an unprotected PDF...');
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, .file-row .badge-new, #attention-cards .file-card', { timeout: 15000 });
  check('file proceeded into a normal post-match state (not stuck on the prompt)', true);
  await shot(page, 'text-final');

  const rememberLink = await page.$('.pw-remember-hint');
  if (rememberLink) {
    console.log('saving a password hint for this statement type...');
    await rememberLink.click();
    await page.waitForTimeout(300);
    check('remember-hint prompt cleared after saving', !(await page.$('.pw-remember-hint')));
  } else {
    check('a "remember a hint" offer appeared after a clean unlock', false);
  }

  await assertPasswordNeverLogged(page, 'text PDF');

  // Reload the extension page (chrome.storage.local, same profile, persists
  // across a reload - a real "next month" re-drop) and re-drop the same
  // file: the saved hint should now show at the prompt, before any password
  // has been typed.
  console.log('reloading and re-dropping: the saved hint should show at the prompt...');
  const pageErrors2 = [];
  page.removeAllListeners('pageerror');
  page.on('pageerror', (e) => { pageErrors2.push(e); console.log('[pageerror]', e.message); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  await page.$('#file-input').then((el) => el.setInputFiles(TEXT_FIXTURE));
  await page.waitForSelector('.fr-pw-input', { timeout: 30000 });
  const hintText = await page.textContent('.fr-caption').catch(() => null);
  check('remembered hint shown on the next drop of the same statement type', !!hintText && hintText.includes('ID number'), hintText);
  await shot(page, 'text-remembered-hint');
  await page.fill('.fr-pw-input', PASSWORD);
  await page.click('.fr-pw-unlock');
  await page.waitForSelector('.fr-pw-input', { state: 'detached', timeout: 30000 });

  const cleanLog = await assertCleanLog(page, 'encrypted text PDF (password)', [...pageErrors, ...pageErrors2]);
  check('no page errors / no stack-carrying debug log entries', cleanLog.ok, cleanLog.problems.join('; '));
  await context.close();
}

/** Scenario 2: encrypted image-only PDF, wrong then right password, then the same image-only handoff a real unprotected image-only PDF gets (Track 3's OCR territory - this only checks the handoff happens, not OCR accuracy). */
async function runImagePdfScenario() {
  console.log('\n=== scenario: encrypted image-only PDF, wrong then right password ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  await dropAndUnlock(page, IMAGE_FIXTURE, 'image');

  console.log('checking the file fell through to the image-only handoff...');
  await page.waitForSelector(
    '.file-row .badge-danger, button:has-text("Read it with on-device text recognition"), .file-row:has-text("Reading page"), .file-row:has-text("Could not read this PDF")',
    { timeout: 30000 },
  );
  check('unlocked file was treated as image-only (same as an unprotected image-only PDF)', true);
  await shot(page, 'image-final');

  const cleanLog = await assertCleanLog(page, 'encrypted image-only PDF (password)', pageErrors);
  check('no page errors / no stack-carrying debug log entries', cleanLog.ok, cleanLog.problems.join('; '));
  await context.close();
}

/** Scenario 3: cancel path - Remove on the password row cancels the unlock and drops the file, same as removing any other file. */
async function runCancelScenario() {
  console.log('\n=== scenario: cancel path ===');
  const { context, page, pageErrors } = await launchExtensionContext();
  await page.$('#file-input').then((el) => el.setInputFiles(TEXT_FIXTURE));
  await page.waitForSelector('.fr-pw-input', { timeout: 30000 });
  await shot(page, 'cancel-prompt');

  await page.click('.remove-file-btn');
  await page.waitForTimeout(500);
  const remaining = await page.$$('.file-row');
  check('cancelling the password prompt removes the file (no orphaned row)', remaining.length === 0, `${remaining.length} row(s) left`);
  await shot(page, 'cancel-after');

  const cleanLog = await assertCleanLog(page, 'password prompt cancel path', pageErrors);
  check('no page errors / no stack-carrying debug log entries', cleanLog.ok, cleanLog.problems.join('; '));
  await context.close();
}

async function main() {
  await runTextPdfScenario();
  await runImagePdfScenario();
  await runCancelScenario();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}. screenshots in`, shotsDir);
  if (failures > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
