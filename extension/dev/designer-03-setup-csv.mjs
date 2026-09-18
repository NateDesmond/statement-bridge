import { launchExtensionContext, makeShotter, fixturesDir } from './designer-audit-lib.mjs';
import path from 'node:path';

async function main() {
  const { context, page } = await launchExtensionContext();
  const shot3 = makeShotter(9);

  const input = await page.$('#file-input');
  await input.setInputFiles(path.join(fixturesDir, 'generic_unknown_bank.csv'));
  await page.waitForTimeout(800);
  console.log('decision card (unknown csv)');
  await shot3(page, 'decision-csv-attention-card');

  const setupBtn = await page.$('#attention-cards button:has-text("Set up")');
  console.log('setup btn found:', !!setupBtn);
  if (setupBtn) {
    await setupBtn.click();
    await page.waitForSelector('#screen-wizard.active', { timeout: 10000 }).catch((e) => console.log('wizard wait err', e.message));
    await page.waitForTimeout(400);
    const hasConfirmA = await page.$('#confirm-a:not([hidden])');
    console.log('confirm A visible:', !!hasConfirmA);
    if (hasConfirmA) {
      await shot3(page, 'setup-a-confirm');

      await page.click('#confirm-off');
      await page.waitForTimeout(200);
      console.log('screen B (whats wrong)');
      await shot3(page, 'setup-b-whats-wrong');

      await page.click('#confirm-fix-dates');
      await page.waitForTimeout(200);
      console.log('focus screen (fix dates)');
      await shot3(page, 'setup-focus-fix-dates');

      await page.click('#confirm-focus-done');
      await page.waitForTimeout(200);
      await page.click('#confirm-yes');
      await page.waitForTimeout(200);
      console.log('screen C (name statement)');
      await shot3(page, 'setup-c-name-statement');

      // Now exercise the full detailed wizard via Screen B -> Something else
      await page.click('#confirm-off').catch(() => {});
      await page.waitForTimeout(150);
      await page.click('#confirm-fix-other').catch(() => {});
      await page.waitForTimeout(300);
    }

    const stepLabels = ['wizard-step0-basics', 'wizard-step1-locate', 'wizard-step2-mapfields', 'wizard-step3-test', 'wizard-step4-save'];
    for (let i = 0; i < 5; i++) {
      if (!(await page.$('#screen-wizard.active'))) { console.log('wizard closed at i=', i); break; }
      console.log('shooting', stepLabels[i]);
      await shot3(page, stepLabels[i]);
      const nextBtn = await page.$('#wizard-next');
      if (!nextBtn) { console.log('no next btn'); break; }
      const disabled = await nextBtn.getAttribute('disabled');
      if (disabled !== null) { console.log('next disabled at i=', i); break; }
      await page.click('#wizard-next').catch((e) => console.log('click next err', e.message));
      await page.waitForTimeout(400);
    }
  }

  await context.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
