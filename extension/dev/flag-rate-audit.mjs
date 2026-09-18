// REBUILD-HOME leftover (a), 2026-09-18: measures item 5c's OCR flag rate
// before (the old, wider <70-confidence rule) vs after (the actual rule now
// live in normalizeRecords) on the OCR-generalisation fixtures, and - if
// test/private/ has any files - on those too, driven through the REAL
// unpacked extension (numbers only: no filenames, descriptions or amounts
// are ever printed for the private set).
//
// Usage (dev server must be running for the fixture pass):
//   python3 -m http.server 8934 --directory extension   # from the repo root
//   node dev/flag-rate-audit.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const PORT = process.env.SB_DEV_PORT || 8934;
const fixtures = JSON.parse(fs.readFileSync(new URL('./ocr-recall-audit-fixtures.json', import.meta.url)));
// The Northwind Bank fixture used by e2e-presets.mjs/verify-rebuild-home.mjs
// is a real 3rd-party-shaped grouped layout too - worth the same measurement.
fixtures.push({ name: 'Northwind Bank (grouped, transaction history)', pdf: 'test/fixtures/northwind_transaction_history_image.pdf' });

async function runFixtures() {
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const fx of fixtures) {
      const page = await browser.newPage();
      page.setDefaultTimeout(900000);
      page.on('pageerror', (e) => console.error(`[pageerror ${fx.name}]`, e.message));
      const qs = new URLSearchParams({ pdf: `../${fx.pdf}` });
      await page.goto(`http://localhost:${PORT}/dev/flag-rate-audit.html?${qs.toString()}`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('out').textContent !== 'running', { timeout: 300000 });
      const result = JSON.parse(await page.textContent('#out'));
      await page.close();
      if (result.error) { console.error(`ERROR (${fx.name}):`, result.error); continue; }
      results.push({ name: fx.name, ...result });
      console.log(`${fx.name}: ${result.total} rows - before ${result.beforeFlagged} (${result.beforePct}%), after ${result.afterFlagged} (${result.afterPct}%)`);
    }
  } finally {
    await browser.close();
  }
  return results;
}

// test/private/ (numbers only, per REBUILD-HOME's own verification rule):
// drives each real file through the REAL extension, reads the row count and
// the health-badge warning count off the rendered UI - never a filename, a
// description or an amount.
async function runPrivateFiles() {
  const privateDir = path.join(extensionPath, 'test', 'private');
  if (!fs.existsSync(privateDir)) return null;
  const files = fs.readdirSync(privateDir).filter((f) => /\.(csv|pdf|xlsx)$/i.test(f));
  if (!files.length) return null;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-flag-audit-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  });
  const out = [];
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = sw.url().split('/')[2];
    let fileNum = 0;
    for (const name of files) {
      fileNum += 1;
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/workspace.html`);
      await page.waitForSelector('#file-input', { state: 'attached' });
      await (await page.$('#file-input')).setInputFiles(path.join(privateDir, name));
      try {
        await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, .file-row .badge-danger', { timeout: 120000 });
      } catch {
        out.push({ file: `file ${fileNum}`, note: 'did not settle within 120s (not necessarily OCR - unmapped/needs setup)' });
        await page.close();
        continue;
      }
      await page.waitForTimeout(500);
      const badgeText = await page.$eval('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, .file-row .badge-danger', (el) => el.textContent).catch(() => '');
      // "N warning(s)" or "All checks pass" - never row content itself.
      const warnMatch = badgeText.match(/(\d+)\s+warning/);
      const flagged = warnMatch ? Number(warnMatch[1]) : 0;
      const rowCountText = await page.$eval('#export-summary', (el) => el.textContent).catch(() => '');
      const rowMatch = rowCountText.match(/(\d+)\s+transaction/);
      const total = rowMatch ? Number(rowMatch[1]) : null;
      out.push({
        file: `file ${fileNum}`, total, flagged,
        pct: total ? Math.round((flagged / total) * 1000) / 10 : null,
        note: total == null ? 'not mapped this session (no built-in/saved statement type matched); skipped' : undefined,
      });
      await page.close();
    }
  } finally {
    await context.close();
  }
  return out;
}

async function main() {
  console.log('=== OCR fixtures: item 5c flag rate, before vs after ===');
  const fixtureResults = await runFixtures();
  const totalRows = fixtureResults.reduce((s, r) => s + r.total, 0);
  const totalBefore = fixtureResults.reduce((s, r) => s + r.beforeFlagged, 0);
  const totalAfter = fixtureResults.reduce((s, r) => s + r.afterFlagged, 0);
  console.log(`\nOverall (${fixtureResults.length} fixtures, ${totalRows} rows): before ${totalBefore} flagged (${Math.round((totalBefore / totalRows) * 1000) / 10}%), after ${totalAfter} flagged (${Math.round((totalAfter / totalRows) * 1000) / 10}%)`);
  console.log(totalRows ? (totalAfter / totalRows <= 0.03 ? 'PASS - under 3% target' : 'FAIL - at or above 3% target') : 'no rows');

  console.log('\n=== test/private/ files (numbers only) ===');
  const privateResults = await runPrivateFiles();
  if (!privateResults) {
    console.log('test/private/ not present or empty - nothing to measure.');
  } else {
    for (const r of privateResults) console.log(JSON.stringify(r));
    const mapped = privateResults.filter((r) => r.total != null);
    if (mapped.length) {
      const pTotal = mapped.reduce((s, r) => s + r.total, 0);
      const pFlagged = mapped.reduce((s, r) => s + r.flagged, 0);
      console.log(`Overall (${mapped.length} mapped files, ${pTotal} rows): ${pFlagged} flagged (${Math.round((pFlagged / pTotal) * 1000) / 10}%)`);
    } else {
      console.log('No file mapped to a built-in/saved statement type this session - nothing to measure (this run never maps them, only reads whatever already auto-matches).');
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
