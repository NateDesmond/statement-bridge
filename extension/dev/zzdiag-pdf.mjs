import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const extensionPath = '/Users/nathanaeldesmond2026/Desktop/StatementBridge/extension';
const fixturesDir = path.join(extensionPath, 'test', 'fixtures');

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-diag-'));
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
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    const page = await context.newPage();
    page.on('console', (m) => console.log('[console]', m.text()));
    await page.goto(`chrome-extension://${extId}/workspace.html`, { waitUntil: 'load' });
    await page.waitForSelector('#file-input', { state: 'attached' });

    const input = await page.$('#file-input');
    await input.setInputFiles(path.join(fixturesDir, 'palisade_columns_image.pdf'));
    console.log('dropped, waiting for OCR...');
    let done = false;
    for (let i = 0; i < 180; i++) {
      const state = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.file-row')];
        const r = rows.find((x) => /palisade/i.test(x.textContent || ''));
        return r ? r.textContent.trim() : null;
      });
      if (state && !/reading|read \d+ of \d+ page/i.test(state)) { done = true; console.log('OCR done:', state); break; }
      await page.waitForTimeout(1000);
    }
    if (!done) { console.log('OCR never finished'); }

    const setupBtn = await page.$('#attention-cards button:has-text("Set up")');
    if (setupBtn) { await setupBtn.click(); await page.waitForTimeout(600); }
    else console.log('no Set up button');

    const info = await page.evaluate(() => {
      const $ = (s) => document.querySelector(s);
      return {
        confirmAVisible: $('#screen-wizard.active') ? !$('#wizard-confirm')?.hidden : null,
        wizardVisible: !$('#wizard-steps')?.hidden,
        bank: $('#w-bank')?.value,
        currency: $('#w-currency')?.value,
        country: $('#w-country')?.value,
        introText: $('#wizard-step-intro')?.textContent,
        introHidden: $('#wizard-step-intro')?.hidden,
        anchorHint: $('#pdf-anchor-picker')?.innerText?.slice(0, 500),
        stepReason: $('#wizard-footer-reason')?.textContent,
        stepReasonHidden: $('#wizard-footer-reason')?.hidden,
        nextDisabled: $('#wizard-next')?.disabled,
        confirmAHeading: $('#confirm-a-heading')?.textContent,
      };
    });
    console.log('STATE', JSON.stringify(info, null, 2));

    const previewInfo = await page.evaluate(() => {
      const $ = (s) => document.querySelector(s);
      const rows = [...document.querySelectorAll('#confirm-a-preview tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));
      return {
        rows,
        yesDisabled: $('#confirm-yes')?.disabled,
        yesText: $('#confirm-yes')?.textContent,
        offVisible: $('#confirm-off') ? !$('#confirm-off').hidden : null,
      };
    });
    console.log('PREVIEW', JSON.stringify(previewInfo, null, 2));

    // Try clicking Next a few times and observe
    for (let i = 0; i < 3; i++) {
      const nextBtn = await page.$('#wizard-next');
      if (nextBtn && await nextBtn.isVisible()) {
        await nextBtn.click({ force: true }).catch((e) => console.log('click err', e.message));
        await page.waitForTimeout(300);
      }
    }
    const info2 = await page.evaluate(() => {
      const $ = (s) => document.querySelector(s);
      return {
        stepReason: $('#wizard-footer-reason')?.textContent,
        nextDisabled: $('#wizard-next')?.disabled,
        currentStepLabel: $('#wizard-footer-stepname')?.textContent,
      };
    });
    console.log('AFTER NEXT CLICKS', JSON.stringify(info2, null, 2));

    // Download debug log
    await page.click('#gear-btn, #settings-btn, [aria-label="Settings"]').catch(() => {});
  } finally {
    await context.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
