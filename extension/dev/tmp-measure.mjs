// scratch: measure the flags fixture's row geometry inside the real extension page
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const extensionPath = '/Users/nathanaeldesmond2026/Desktop/StatementBridge/extension';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-measure-'));
const context = await chromium.launchPersistentContext(tmpDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`chrome-extension://${extId}/workspace.html`);
await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
const b64 = fs.readFileSync(path.join(extensionPath, 'test/fixtures/northwind_transaction_history_flags.pdf')).toString('base64');
const out = await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
  const { getPdfPageInfo } = await import('./src/ui/pdf-render.js');
  const { groupItemsIntoLines } = await import('./src/core/pdf.js');
  const info = await getPdfPageInfo(bytes, 1);
  const lines = groupItemsIntoLines(info.items);
  return {
    page: { w: info.width, h: info.height, numPages: info.numPages },
    heights: [...new Set(info.items.map((i) => Math.round(i.height * 10) / 10))].sort(),
    lines: lines.slice(0, 40).map((l) => ({
      y: Math.round(l.y),
      x0: Math.round(l.items[0].x),
      x1: Math.round(l.items[l.items.length - 1].x),
      h: Math.round((l.items[0].height || 0) * 10) / 10,
      text: l.items.map((i) => i.str).join(' ').slice(0, 90),
    })),
  };
}, b64);
console.log(JSON.stringify(out, null, 1));
await context.close();
