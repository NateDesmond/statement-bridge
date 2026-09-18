// Simple B shell navigation helper for Playwright-driven e2e scripts. The
// sidebar (data-screen buttons always on screen) is gone - Review, Statement
// types (profiles), Settings and How it works are reachable only through the
// gear menu overlay now (SIMPLE-BUILD.md Section 1 item 6). Home stays the
// default/return screen; a screen opened this way gets a "Back" control in
// the brand bar (#shell-back-btn) instead of a second sidebar click.
//
// Every e2e script that used to do `page.click('nav.primary [data-screen="x"]')`
// should use `gotoScreen(page, 'x')` instead.

/**
 * Open the gear menu and click the tile for `screenName` (review, profiles,
 * settings, how) - anything reachable by a *screen-switching* tile. Waits
 * for the target screen's `.active` class before returning.
 * @param {import('playwright').Page} page
 * @param {'review'|'profiles'|'settings'|'how'} screenName
 */
export async function gotoScreen(page, screenName) {
  await page.click('#gear-btn');
  await page.waitForSelector('#gear-overlay.open');
  await page.click(`#gear-overlay .tile[data-screen="${screenName}"]`);
  await page.waitForSelector(`#screen-${screenName}.active`);
}

/** Click the shell's "Back" control (visible on every screen except Home/the wizard) to return to Home. */
export async function goBack(page) {
  await page.click('#shell-back-btn');
  await page.waitForSelector('#screen-home.active');
}

/** Open the gear menu without clicking a tile - for a script that needs to reach a Home-only action tile (#tile-export, #tile-clear) instead of a screen switch. */
export async function openGearMenu(page) {
  await page.click('#gear-btn');
  await page.waitForSelector('#gear-overlay.open');
}
