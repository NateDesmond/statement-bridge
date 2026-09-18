// Pass-1 first-timer audit, stage 2: reopen the same extension state (fixed
// userDataDir, SB_UDD env var) and drop an unknown-bank IMAGE-ONLY PDF, which
// needs on-device OCR before it can be set up. Bundled headless Chromium only.
// 1440-only full-page shots for this stage (INDIE-STANDARD wants both widths
// per screen across the pass; 1280 was already covered for every screen KIND
// in stage 1 - this stage adds the OCR-specific screens at 1440 only, per
// explicit instruction, to keep each stage short and non-hanging).
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');
const shotsDir = path.join(extensionPath, '..', 'audit', 'pass1');
fs.mkdirSync(shotsDir, { recursive: true });
const userDataDir = process.env.SB_UDD;
if (!userDataDir) throw new Error('SB_UDD env var required');

let n = Number(process.env.SB_N_START || '18');
function nextName(label) { n += 1; return `first-timer-${String(n).padStart(2, '0')}-${label}`; }
async function shot(page, label) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotsDir, `${nextName(label)}-1440.png`), fullPage: true });
}

async function main() {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: chromium.executablePath ? chromium.executablePath() : undefined,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = sw.url().split('/')[2];
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/workspace.html`);
    await page.waitForSelector('#file-input', { state: 'attached' });
    await page.waitForTimeout(300);

    const restoreBtn = await page.$('button:has-text("Restore")');
    if (restoreBtn && (await restoreBtn.isVisible())) {
      await restoreBtn.click();
      await page.waitForTimeout(500);
    }

    console.log('drop unknown-bank image-only PDF...');
    const input = await page.$('#file-input');
    await input.setInputFiles(path.join(fixturesDir, 'palisade_columns_image.pdf'));
    await page.waitForTimeout(700);
    await shot(page, 'pdf-reading-started');

    console.log('waiting for OCR to finish (up to ~3 min)...');
    let ocrDone = false;
    for (let i = 0; i < 170; i++) {
      const state = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.file-row')];
        const pdfRow = rows.find((r) => /palisade/i.test(r.textContent || ''));
        return pdfRow ? pdfRow.textContent.trim() : null;
      });
      if (state && !/reading|read \d+ of \d+ page/i.test(state)) { ocrDone = true; break; }
      await page.waitForTimeout(1000);
    }
    console.log('OCR done:', ocrDone);
    await page.waitForTimeout(500);
    await shot(page, 'pdf-ocr-result-card');

    const setupBtn = await page.$('button:has-text("Set up")');
    if (setupBtn && (await setupBtn.isVisible())) {
      await setupBtn.click();
      await page.waitForTimeout(600);
      await shot(page, 'pdf-wizard-opened');
    } else {
      console.log('(no visible Set up button after OCR)');
    }

    if (await page.isVisible('#confirm-yes').catch(() => false)) {
      await shot(page, 'pdf-confirm-a');
      await page.click('#confirm-yes');
      await page.waitForTimeout(300);
      await shot(page, 'pdf-confirm-c-name');
      if (await page.isVisible('#confirm-save').catch(() => false)) {
        await page.click('#confirm-save');
        await page.waitForTimeout(600);
        await shot(page, 'pdf-after-save');
      }
    } else {
      console.log('confirm-a not visible - trying full wizard stepper');
      for (let step = 0; step < 5; step++) {
        await shot(page, `pdf-wizard-step-${step}`);
        const nextBtn = await page.$('#wizard-next');
        if (nextBtn && (await nextBtn.isVisible())) {
          const label = (await nextBtn.textContent()) || '';
          await nextBtn.click();
          await page.waitForTimeout(600);
          if (label.trim().toLowerCase() === 'save') break;
        } else break;
      }
      await shot(page, 'pdf-wizard-final');
    }

    console.log('LAST_N=' + n);
  } finally {
    await context.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
