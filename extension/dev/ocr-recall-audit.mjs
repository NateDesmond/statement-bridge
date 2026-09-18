// Driver for dev/ocr-recall-audit.html: runs the OCR-generalisation recall
// measurement over every fixture pair in dev/ocr-recall-audit-fixtures.json,
// one bundled-Chromium page load per fixture, and prints one JSON result per
// line to stdout.
// Usage (dev server must be running):
//   python3 -m http.server 8934 --directory extension   # from the repo root
//   node dev/ocr-recall-audit.mjs > /tmp/ocr-recall-results.json
import { chromium } from 'playwright';
import fs from 'node:fs';

const PORT = process.env.SB_DEV_PORT || 8934;
const fixtures = JSON.parse(fs.readFileSync(new URL('./ocr-recall-audit-fixtures.json', import.meta.url)));

const browser = await chromium.launch();
const results = [];
try {
  for (const fx of fixtures) {
    const page = await browser.newPage();
    page.setDefaultTimeout(900000); // page.waitForFunction below only takes (fn, arg) here, not (fn, options) - this is what actually raises the real per-fixture timeout past Playwright's 30s default
    page.on('pageerror', (e) => console.error(`[pageerror ${fx.name}]`, e.message));
    const qs = new URLSearchParams({ pdf: `../${fx.pdf}`, truth: `../${fx.truth}` });
    await page.goto(`http://localhost:${PORT}/dev/ocr-recall-audit.html?${qs.toString()}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('out').textContent !== 'running', { timeout: 300000 });
    const result = JSON.parse(await page.textContent('#out'));
    await page.close();
    if (result.error) {
      console.error(`ERROR (${fx.name}):`, result.error);
      results.push({ name: fx.name, error: result.error });
      continue;
    }
    results.push({ name: fx.name, ...result });
    const t = result.timing || {};
    console.error(`done: ${fx.name} - detected=${result.detected.rowModel} truth=${result.truthCount} extracted=${result.rowsExtracted} matches=${result.exactMatches} misses=${result.misses.length} extras=${result.extras.length} | pages=${t.pageCount} wallMs=${t.wallMs} avgPageMs=${t.avgPageMs}`);
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ layouts: results }, null, 2));
