// First-timer pass-2 walkthrough driver.
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, '..');
const shotsDir = path.join(__dirname, '..', '..', 'audit', 'pass2');
fs.mkdirSync(shotsDir, { recursive: true });

const phase = process.argv[2];

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-p2-'));
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
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/workspace.html`, { waitUntil: 'load' });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  return { context, page, pageErrors };
}

async function shot(page, name, widths = [1440]) {
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shotsDir, `first-timer-${name}-${w}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function dropFile(page, fixturePath) {
  await page.$('#file-input').then((el) => el.setInputFiles(fixturePath));
  await page.waitForSelector('.file-row .badge-ok, .file-row .badge-warn, .file-row .badge-low, #attention-cards button:has-text("Set up")', { timeout: 90000 });
}

async function openWizard(page) {
  const mapBtn = await page.$('#attention-cards button:has-text("Set up")');
  if (mapBtn) {
    await mapBtn.click();
  } else {
    await page.click('#change-link');
    await page.waitForSelector('#accounts-table-body tr');
    await page.click('#accounts-table-body a:has-text("Set up again")');
  }
  await page.waitForSelector('#screen-wizard.active', { timeout: 10000 });
}

async function textOf(page, sel) {
  return page.textContent(sel).catch(() => null);
}

async function main() {
  const { context, page, pageErrors } = await launch();
  try {
    if (phase === 'csv') {
      await shot(page, '00-home-empty', [1440, 1280]);

      const fixture = path.join(extensionPath, 'test', 'fixtures', 'generic_unknown_bank.csv');
      await dropFile(page, fixture);
      await shot(page, '01-home-after-csv-drop', [1440]);

      await openWizard(page);
      await shot(page, '02-wizard-screen-a', [1440, 1280]);
      const heading = await textOf(page, '#confirm-a-heading');
      const previewRows = await page.$$eval('#confirm-a-preview tbody tr', (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()))).catch(() => []);
      const yesDisabled = await page.$eval('#confirm-yes', (b) => b.disabled).catch(() => null);
      fs.writeFileSync('/tmp/p2-csv-screen-a.json', JSON.stringify({ heading, previewRows, yesDisabled }, null, 2));

      if (yesDisabled) {
        // A non-technical user sees a broken/empty preview and clicks "Something's off" as the only path forward.
        await page.click('#confirm-off');
        await page.waitForTimeout(200);
        await shot(page, '03-wizard-screen-b', [1440]);
        // Pick whichever option looks closest to "the columns are wrong" for a naive user.
      } else {
        await page.click('#confirm-yes');
        await page.waitForTimeout(300);
        await shot(page, '03-wizard-screen-c', [1440, 1280]);
        await page.click('#confirm-save');
        await page.waitForTimeout(800);
        await shot(page, '04-home-after-save', [1440]);
      }

      // Home / export state
      await shot(page, '05-home-ready-to-copy', [1440, 1280]);
      const copyBtn = await page.$('#copy-tsv-btn');
      if (copyBtn) {
        const disabled = await copyBtn.getAttribute('disabled');
        fs.appendFileSync('/tmp/p2-csv-screen-a.json', `\ncopy button disabled: ${disabled}\n`);
        if (disabled === null) {
          await copyBtn.click();
          await page.waitForTimeout(400);
          await shot(page, '06-after-copy-click', [1440, 1280]);
        }
      }
      fs.writeFileSync('/tmp/p2-csv-pageerrors.json', JSON.stringify(pageErrors, null, 2));
    } else if (phase === 'pdf') {
      const fixture = path.join(extensionPath, 'test', 'fixtures', 'summit_grouped_2line_image.pdf');
      await dropFile(page, fixture);
      await shot(page, '10-home-after-pdf-drop', [1440]);

      await openWizard(page);
      await shot(page, '11-wizard-screen-a-pdf', [1440, 1280]);
      const heading = await textOf(page, '#confirm-a-heading');
      const previewRows = await page.$$eval('#confirm-a-preview tbody tr', (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()))).catch(() => []);
      const yesDisabled = await page.$eval('#confirm-yes', (b) => b.disabled).catch(() => null);
      fs.writeFileSync('/tmp/p2-pdf-screen-a.json', JSON.stringify({ heading, previewRows, yesDisabled }, null, 2));

      if (yesDisabled) {
        await page.click('#confirm-off');
        await page.waitForTimeout(200);
        await shot(page, '12-wizard-screen-b-pdf', [1440]);
      } else {
        await page.click('#confirm-yes');
        await page.waitForTimeout(300);
        await shot(page, '12-wizard-screen-c-pdf', [1440, 1280]);
        await page.click('#confirm-save');
        await page.waitForTimeout(800);
        await shot(page, '13-home-after-save-pdf', [1440]);
      }

      await shot(page, '14-home-ready-to-copy-pdf', [1440, 1280]);
      const copyBtn = await page.$('#copy-tsv-btn');
      if (copyBtn) {
        const disabled = await copyBtn.getAttribute('disabled');
        fs.appendFileSync('/tmp/p2-pdf-screen-a.json', `\ncopy button disabled: ${disabled}\n`);
        if (disabled === null) {
          await copyBtn.click();
          await page.waitForTimeout(400);
          await shot(page, '15-after-copy-click-pdf', [1440, 1280]);
        }
      }
      fs.writeFileSync('/tmp/p2-pdf-pageerrors.json', JSON.stringify(pageErrors, null, 2));
    } else if (phase === 'csv-fix-flow') {
      // Continue from screen B if Screen A's Yes was disabled for the CSV case.
      const fixture = path.join(extensionPath, 'test', 'fixtures', 'generic_unknown_bank.csv');
      await dropFile(page, fixture);
      await openWizard(page);
      const yesDisabled = await page.$eval('#confirm-yes', (b) => b.disabled).catch(() => null);
      if (yesDisabled) {
        await page.click('#confirm-off');
        await page.waitForTimeout(200);
        // list the options on screen B
        const opts = await page.$$eval('#screen-confirm-b button, #confirm-b button', (btns) => btns.map((b) => b.textContent.trim())).catch(() => []);
        fs.writeFileSync('/tmp/p2-csv-screen-b-options.json', JSON.stringify(opts, null, 2));
        await shot(page, '20-screen-b-options', [1440]);
        // A first-timer with wrong columns would click something like "Something else" (fields wrong) - try id
        const fixOther = await page.$('#confirm-fix-other');
        if (fixOther) {
          await fixOther.click();
          await page.waitForSelector('#step-2.active, #screen-wizard.active', { timeout: 8000 }).catch(() => {});
          await shot(page, '21-map-fields', [1440, 1280]);
          const selects = await page.$$('#w-mapping-table select.map-select');
          fs.writeFileSync('/tmp/p2-csv-map-selects.json', JSON.stringify({ count: selects.length }, null, 2));
          if (selects.length >= 2) {
            await selects[0].selectOption('date');
            await selects[1].selectOption('description_raw');
            await page.waitForTimeout(200);
            await shot(page, '22-map-fields-mapped', [1440, 1280]);
          }
          // advance through remaining steps to Save
          for (let i = 0; i < 6; i++) {
            const stillWizard = await page.$('#screen-wizard.active');
            if (!stillWizard) break;
            const saveVisible = await page.$('#step-4.active');
            if (saveVisible) { await shot(page, '23-save-step', [1440]); break; }
            await page.click('#wizard-next');
            await page.waitForTimeout(400);
          }
          await page.click('#wizard-next').catch(() => {});
          await page.waitForTimeout(800);
          await shot(page, '24-home-after-manual-save', [1440]);
          await shot(page, '25-home-ready-to-copy', [1440, 1280]);
          const copyBtn = await page.$('#copy-tsv-btn');
          if (copyBtn) {
            const disabled = await copyBtn.getAttribute('disabled');
            fs.writeFileSync('/tmp/p2-csv-copy-state.json', JSON.stringify({ disabled }, null, 2));
            if (disabled === null) {
              await copyBtn.click();
              await page.waitForTimeout(400);
              await shot(page, '26-after-copy-click', [1440, 1280]);
            }
          }
        }
      } else {
        fs.writeFileSync('/tmp/p2-csv-screen-b-options.json', 'yes was enabled, no need for screen B');
      }
    }
  } finally {
    await context.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
