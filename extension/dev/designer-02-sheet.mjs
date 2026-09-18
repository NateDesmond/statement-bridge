import { launchExtensionContext, makeShotter, fixturesDir } from './designer-audit-lib.mjs';
import path from 'node:path';

async function main() {
  const { context, page } = await launchExtensionContext();
  const shot3 = makeShotter(4);

  const input = await page.$('#file-input');
  await input.setInputFiles([
    path.join(fixturesDir, 'meridian_savings.csv'),
    path.join(fixturesDir, 'northwind_transaction_history_3p.pdf'),
  ]);
  for (let i = 0; i < 60; i++) {
    const done = await page.evaluate(() => {
      const rows = document.querySelectorAll('.file-row');
      return rows.length >= 2 && [...rows].every((r) => r.querySelector('.badge-ok, .badge-warn, .badge-low, .badge-danger'));
    });
    if (done) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(300);

  console.log('sheet closed');
  await shot3(page, 'sheet-closed');

  await page.click('#change-link');
  await page.waitForSelector('#change-drawer:not([hidden])');
  await page.waitForTimeout(300);
  console.log('sheet open');
  await shot3(page, 'sheet-open');

  const layoutCards = await page.$$('#home-preset-editor .layout-card');
  if (layoutCards.length > 1) {
    await layoutCards[1].click();
    await page.waitForTimeout(300);
  }
  console.log('sheet layout chosen', layoutCards.length);
  await shot3(page, 'sheet-layout-chosen');

  await page.click('#home-preset-editor .columns-customise summary').catch((e) => console.log('customise open err', e.message));
  await page.waitForTimeout(200);
  const disabledPill = await page.$('#home-preset-editor .column-pill:not(.enabled)');
  if (disabledPill) {
    await disabledPill.click();
    await page.waitForTimeout(300);
  }
  console.log('sheet customised, pill found:', !!disabledPill);
  await shot3(page, 'sheet-customised');

  console.log('Check a statement via file row link');
  const checkLink = await page.$('a:has-text("Check")');
  console.log('check link found:', !!checkLink);
  if (checkLink) {
    await checkLink.click();
    await page.waitForSelector('#screen-review.active', { timeout: 8000 }).catch((e) => console.log('review wait err', e.message));
    await page.waitForTimeout(300);
    await shot3(page, 'check-a-statement');
  }

  await context.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
