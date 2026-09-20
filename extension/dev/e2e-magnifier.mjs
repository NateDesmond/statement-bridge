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

async function newContext(width = 1440) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-magnifier-'));
  return chromium.launchPersistentContext(tmpDir, {
    headless: false, // MV3 service worker needs a real (bundled Chromium) window context
    viewport: { width, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function openWorkspace(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 60000 });
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text().slice(0, 300)); });
  await page.goto(`chrome-extension://${extId}/workspace.html`);
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 60000 });
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

  // Text recognition on this image-only fixture can take a few minutes on a
  // busy machine; wait for the Set up button itself rather than assuming the
  // OCR wait above was long enough (when it wasn't, the whole confirm-first
  // flow was silently skipped and the "needs a quick look" wait timed out).
  const setupBtn = page.locator('.new-bank-card button:has-text("Set up")');
  await setupBtn.first().waitFor({ state: 'visible', timeout: 240000 }).catch(() => {});
  if (await setupBtn.count()) {
    await setupBtn.click();
    await page.waitForSelector('#confirm-a:not([hidden])', { timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('confirm-a-heading')?.textContent?.trim().length > 0, { timeout: 20000 });
    await page.click('#confirm-yes');
    await page.waitForSelector('#confirm-c:not([hidden])', { timeout: 20000 });
    await page.click('#confirm-save');
  }
  await page.waitForFunction(() => /\d+\s*rows? needs? a quick look/i.test(document.body.textContent || ''), { timeout: 30000 })
    .catch(async (err) => { console.log('[home text]', (await page.evaluate(() => document.body.innerText)).slice(0, 800)); throw err; });
  await page.waitForTimeout(600);
}

const snippetSel = '.decision-row .decision-snippet[tabindex]';

/**
 * Item A: measured (never eyeballed) geometry of the first card's snippet
 * canvas, including the x-height of the text it actually rendered - read off
 * the bitmap itself, not inferred: for the darkest text line in the crop, the
 * rows whose ink coverage is at least half that line's peak are its lowercase
 * core (ascenders and descenders are the sparse rows above and below).
 */
async function snippetMetrics(page) {
  return page.$eval(`${snippetSel} canvas`, (el) => {
    const r = el.getBoundingClientRect();
    const ctx = el.getContext('2d');
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const ink = [];
    for (let y = 0; y < el.height; y++) {
      let n = 0;
      for (let x = 0; x < el.width; x++) {
        const i = (y * el.width + x) * 4;
        if (data[i] < 110 && data[i + 1] < 110 && data[i + 2] < 110) n++;
      }
      ink.push(n);
    }
    // Split into text lines (runs of rows with any ink), take the one with
    // the most ink, and count its rows at >= 50% of its own peak.
    let best = { rows: 0 }, cur = [];
    const flush = () => {
      if (!cur.length) return;
      const peak = Math.max(...cur.map((p) => p.n));
      const rows = cur.filter((p) => p.n >= peak * 0.5).length;
      const total = cur.reduce((s, p) => s + p.n, 0);
      if (total > (best.total || 0)) best = { rows, total };
      cur = [];
    };
    ink.forEach((n, y) => { if (n > 0) cur.push({ y, n }); else flush(); });
    flush();
    const bitmapToCss = r.width / el.width;
    return {
      xHeightCss: best.rows * bitmapToCss,
      cssW: r.width, cssH: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      bitmapW: el.width, bitmapH: el.height,
      cssScale: Number(el.dataset.cssScale),
      sourceH: Number(el.dataset.sourceH),
      lineCssPx: Number(el.dataset.lineCssPx),
    };
  });
}

async function run(width) {
  console.log(`\n=== scenario: decision-card snippet + magnifier at ${width}px ===`);
  const context = await newContext(width);
  try {
    const page = await openWorkspace(context);
    const fixture = path.join(extensionPath, 'test', 'fixtures', 'northwind_transaction_history_flags.pdf');
    await dropAndMapOnHome(page, fixture);

    await page.waitForSelector(`${snippetSel} canvas`, { timeout: 15000 })
      .catch(async (err) => { console.log('[decision-row html]', (await page.$eval('.decision-row', (el) => el.outerHTML)).slice(0, 700)); throw err; });
    const snippetCount = await page.$$eval(snippetSel, (els) => els.length);
    check('at least one decision-row snippet is magnifiable (has tabindex)', snippetCount > 0, `count=${snippetCount}`);

    // --- Item A requirement 1: the snippet is readable, measured ------------
    const snip = await snippetMetrics(page);
    console.log('  snippet metrics:', JSON.stringify(snip));
    // source_h (the row's line height in PDF units) x the realized CSS scale
    // is the line height the text actually renders at; >= 22 CSS px puts a
    // lowercase x-height around 11 px.
    check('snippet text has a lowercase x-height of at least 11 CSS px', snip.xHeightCss >= 11, `xHeightCss=${snip.xHeightCss.toFixed(2)}`);
    // The scale target itself: the row's own line height (source_h) x the
    // realized scale. It only drops below 22 if even the gutter-squeezed crop
    // is wider than the card, which the workspace's max-width column means
    // does not happen at either width here.
    const lineTarget = 22;
    check(`snippet renders a line of the row at >= ${lineTarget} CSS px`, snip.lineCssPx >= lineTarget, `lineCssPx=${snip.lineCssPx.toFixed(2)} (source_h=${snip.sourceH} x scale=${snip.cssScale.toFixed(3)})`);
    check('snippet canvas is at most 96 CSS px tall', snip.cssH <= 96, `cssH=${snip.cssH}`);
    const cardW = await page.$eval('.decision-row', (el) => el.clientWidth);
    check('snippet canvas fits the card width', snip.cssW <= cardW, `cssW=${snip.cssW} cardW=${cardW}`);
    check('snippet bitmap is oversampled (crisp) vs its CSS size', snip.bitmapW >= snip.cssW * 1.9, `bitmapW=${snip.bitmapW} cssW=${snip.cssW}`);

    const card = await page.$('.decision-row');
    await card.screenshot({ path: path.join(shotsDir, `snippet2-${width}.png`) });

    // --- Item A requirement 2/3: the magnifier ------------------------------
    await page.hover(snippetSel);
    await page.waitForSelector('.snippet-magnifier canvas', { timeout: 15000 });
    await page.waitForTimeout(200);
    const panelBox = await page.$eval('.snippet-magnifier', (el) => el.getBoundingClientRect());
    const mag = await page.$eval('.snippet-magnifier canvas', (el) => {
      const r = el.getBoundingClientRect();
      return { cssW: r.width, cssH: r.height, bitmapW: el.width, bitmapH: el.height, cssScale: Number(el.dataset.cssScale) };
    });
    console.log('  magnifier metrics:', JSON.stringify({ panelBox, mag }));
    // Whole row at 2x when the viewport allows, otherwise the panel scrolls.
    const wantPanelW = Math.min(mag.cssW + 18, width - 32);
    check('magnifier panel shows the whole 2x row or fills the viewport', Math.abs(panelBox.width - wantPanelW) < 1.5, `panelW=${panelBox.width} want=${wantPanelW}`);
    check('magnifier renders at exactly 2x the snippet scale', Math.abs(mag.cssScale / snip.cssScale - 2) < 0.01, `mag=${mag.cssScale.toFixed(3)} snippet=${snip.cssScale.toFixed(3)}`);
    check('magnifier canvas is exactly 2x the snippet canvas (same region)', Math.abs(mag.cssW / snip.cssW - 2) < 0.02 && Math.abs(mag.cssH / snip.cssH - 2) < 0.02, `mag=${mag.cssW}x${mag.cssH} snippet=${snip.cssW}x${snip.cssH}`);
    check('magnifier panel is fully inside the viewport', panelBox.left >= 0 && panelBox.top >= 0 && panelBox.right <= width + 0.5 && panelBox.bottom <= 900.5, JSON.stringify(panelBox));

    // No overlap with the snippet it magnifies.
    const overlapsSnippet = panelBox.left < snip.right && panelBox.right > snip.left && panelBox.top < snip.bottom && panelBox.bottom > snip.top;
    check('magnifier panel does not overlap the snippet', !overlapsSnippet, JSON.stringify({ panelBox, snip }));

    if (width === 1440) await page.screenshot({ path: path.join(shotsDir, 'snippet2-magnifier-1440.png') });

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

run(1440)
  .then(() => run(1280))
  .then(() => {
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => { console.error(err); process.exit(1); });
