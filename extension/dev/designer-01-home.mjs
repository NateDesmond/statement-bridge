import { launchExtensionContext, makeShotter, fixturesDir } from './designer-audit-lib.mjs';
import path from 'node:path';

async function main() {
  const { context, page } = await launchExtensionContext();
  const shot3 = makeShotter(0);

  console.log('1. Home empty');
  await shot3(page, 'home-empty');

  console.log('2. gear dropdown (from empty Home)');
  await page.click('#gear-btn');
  await page.waitForSelector('#gear-overlay.open');
  await shot3(page, 'gear-dropdown');
  await page.keyboard.press('Escape').catch(() => {});

  console.log('3. drop CSV + text PDF + image PDF -> processing');
  const input = await page.$('#file-input');
  await input.setInputFiles([
    path.join(fixturesDir, 'meridian_savings.csv'),
    path.join(fixturesDir, 'northwind_transaction_history_3p.pdf'),
    path.join(fixturesDir, 'northwind_transaction_history_image.pdf'),
  ]);
  await page.waitForTimeout(400);
  await shot3(page, 'home-processing');

  for (let i = 0; i < 90; i++) {
    const done = await page.evaluate(() => {
      const rows = document.querySelectorAll('.file-row');
      return rows.length >= 3 && [...rows].every((r) => r.querySelector('.badge-ok, .badge-warn, .badge-low, .badge-danger'));
    });
    if (done) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(400);
  console.log('4. Home ready');
  await shot3(page, 'home-ready');

  console.log('done');
  await context.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
