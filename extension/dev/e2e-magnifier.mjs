// Item 7 (NO-TEMPLATES, 2026-09-20): the decision-card snippet magnifier.
// Drops the flags fixture (produces at least one "N rows need a quick look"
// decision row on Home), hovers/focuses its snippet, and asserts a floating
// magnifier panel appears with a canvas roughly the target width - then
// Escape closes it. Bundled Chromium only, never the user's Chrome - same
// launchPersistentContext shape as dev/e2e-review-source-anchors.mjs.
//
// Run with: cd extension && node dev/e2e-magnifier.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(extensionPath, '..', 'audit', 'fix-shots');
fs.mkdirSync(shotsDir, { recursive: true });

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

async function newContext() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-magnifier-'));
  return chromium.launchPersistentContext(tmpDir, {
    headless: false, // MV3 service worker needs a real (bundled Chromium) window context
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function openWorkspace(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`chrome-extension://${extId}/workspace.html`);
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return page;
}

/**
 * Drops the fixture and drives it through the real confirm-first flow
 * (NO-TEMPLATES item 1: nothing auto-matches any more, every file - even a
 * fixture that used to have a shipped builtin profile - goes through
 * "New bank statement" -> Set up -> confirm-first -> Save, same as a first-
 * time user), stopping on Home rather than opening Review - the decision-
 * row snippet this test needs lives on Home's own "N rows need a quick
 * look" banner.
 */
async function dropAndMapOnHome(page, fixturePath) {
  const input = await page.$('#file-input');
  await input.setInputFiles(fixturePath);
  await page.waitForSelector('.file-row', { timeout: 30000 });

  // An image-only PDF starts text recognition automatically (no button to
  // click) - just wait for it to clear before looking for "Set up".
  await page.waitForFunction(() => {
    const row = document.querySelector('.file-row');
    return row && !/Cancel/.test(row.textContent || '');
  }, { timeout: 120000 }).catch(() => {});

  const setupBtn = page.locator('.new-bank-card button:has-text("Set up")');
  if (await setupBtn.count()) {
    await setupBtn.click();
    await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('confirm-a-heading')?.textContent?.trim().length > 0, { timeout: 20000 });
    await page.click('#confirm-yes');
    await page.waitForSelector('#confirm-c:not([hidden])', { timeout: 20000 });
    await page.click('#confirm-save');
  }
  await page.waitForFunction(() => /\d+\s*rows? need a quick look/i.test(document.body.textContent || ''), { timeout: 20000 });
  await page.waitForTimeout(600);
}

async function run() {
  console.log('\n=== scenario: snippet magnifier (item 7) ===');
  const context = await newContext();
  try {
    const page = await openWorkspace(context);
    const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_flags.pdf');
    await dropAndMapOnHome(page, fixture);

    const snippetSel = '.decision-row .decision-snippet[tabindex]';
    await page.waitForSelector(snippetSel, { timeout: 15000 });
    const snippetCount = await page.$$eval(snippetSel, (els) => els.length);
    check('at least one decision-row snippet is magnifiable (has tabindex)', snippetCount > 0, `count=${snippetCount}`);

    // Hover: the panel appears with a canvas roughly the target ~560 CSS px width.
    await page.hover(snippetSel);
    await page.waitForSelector('.snippet-magnifier canvas', { timeout: 10000 });
    const panelBox = await page.$eval('.snippet-magnifier', (el) => el.getBoundingClientRect());
    const canvasWidth = await page.$eval('.snippet-magnifier canvas', (el) => el.getBoundingClientRect().width);
    check('magnifier panel is visible on hover', panelBox.width > 0 && panelBox.height > 0, `w=${panelBox.width} h=${panelBox.height}`);
    // Width is normally the binding constraint (renderRowMagnifier caps at
    // ~560 CSS px and only shrinks further for an unusually tall block), but
    // allow generous headroom below that so this doesn't flake on a
    // short/narrow block that's height-bound instead.
    check('magnifier canvas is roughly the ~560px target width', canvasWidth > 150 && canvasWidth <= 570, `canvasWidth=${canvasWidth}`);

    await page.screenshot({ path: path.join(shotsDir, 'item7-magnifier-hover.png'), fullPage: true });

    // The panel must not overlap the card's own text/buttons.
    const cardBox = await page.$eval('.decision-row .decision-body', (el) => el.getBoundingClientRect());
    const overlapsBody = panelBox.left < cardBox.right && panelBox.right > cardBox.left && panelBox.top < cardBox.bottom && panelBox.bottom > cardBox.top;
    check('magnifier panel does not overlap the card body/buttons', !overlapsBody, JSON.stringify({ panelBox, cardBox }));

    // Escape closes it.
    await page.keyboard.press('Escape');
    await page.waitForSelector('.snippet-magnifier', { state: 'detached', timeout: 5000 });
    check('Escape closes the magnifier panel', true);

    // mouseleave also closes it. Move away first - the mouse never actually
    // left after the Escape check above, so hovering the same spot again
    // fires no new mouseenter (real browser behaviour, not a bug).
    await page.mouse.move(5, 5);
    await page.hover(snippetSel);
    await page.waitForSelector('.snippet-magnifier canvas', { timeout: 10000 });
    await page.mouse.move(5, 5);
    await page.waitForSelector('.snippet-magnifier', { state: 'detached', timeout: 5000 });
    check('mouseleave closes the magnifier panel', true);

    // Keyboard focus also opens it (and only one panel exists at a time).
    await page.focus(snippetSel);
    await page.waitForSelector('.snippet-magnifier canvas', { timeout: 10000 });
    const panelCount = await page.$$eval('.snippet-magnifier', (els) => els.length);
    check('focusing the snippet opens exactly one magnifier panel', panelCount === 1, `count=${panelCount}`);
  } finally {
    await context.close();
  }
}

run()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => { console.error(err); process.exit(1); });
