// Simple B shell chrome: screen switching, the brand-bar "Back" control, and
// the gear menu overlay (six tiles, the only door to anything outside the
// drop-to-copy path - see SIMPLE-BUILD.md Section 1 item 6). The sidebar and
// its always-visible footer (offline lock, storage meter, retention note)
// are gone; the lock line and storage/clear controls now live in Settings'
// "Privacy and storage" card and How it works' first paragraph (Section 3).

import { computeStorageSplit, storageMeterText, storageContextNote } from './storage-usage.js';

const $ = (sel) => document.querySelector(sel);

// Screens reachable only through the gear menu (never shown a "Back" control
// of their own here) - home has nothing to go back to. The wizard shows the
// shared header Back control like every other screen (item 16); app.js
// registers a back handler that routes it to whichever screen opened the
// wizard, not always Home.
const NO_SHELL_BACK = new Set(['home']);

/**
 * Item A2: one shared `#sr-status` (role="status", aria-live="polite") lives
 * in the shell (workspace.html). Any screen module can announce a text
 * change to assistive tech through this - Review's warnings count, Settings'
 * save/delete actions, Home/Wizard's own toasts and OCR progress (they call
 * this same export from their own files). Re-setting the same text twice in
 * a row (e.g. "Warnings (3)" -> "Warnings (3)") wouldn't fire a fresh
 * announcement in most screen readers, so a zero-width joiner is appended on
 * every other call to force the live region to be seen as changed.
 */
let announceToggle = false;
export function announce(text) {
  const el = document.getElementById('sr-status');
  if (!el) return;
  announceToggle = !announceToggle;
  el.textContent = text + (announceToggle ? '‍' : '');
}

/**
 * Item E4: Profiles/Settings' two-column `.settings-grid` reads as
 * lopsided when one column runs much taller than the other, leaving a big
 * empty gap under the short one. Measured after paint (rAF) since callers
 * re-render their columns' contents first; falls back to single-column
 * whenever one side is more than 2x the other's height.
 * @param {HTMLElement|null} grid - the `.settings-grid` element
 */
export function fitTwoColumnGrid(grid) {
  if (!grid || grid.children.length !== 2) return;
  requestAnimationFrame(() => {
    const [a, b] = grid.children;
    const tall = Math.max(a.offsetHeight, b.offsetHeight);
    const short = Math.min(a.offsetHeight, b.offsetHeight) || 1;
    grid.classList.toggle('single-col', tall / short > 2);
  });
}

/** Closes the gear overlay - exported so home.js's own two action tiles (#tile-export, #tile-clear, which drive a Home action rather than a screen switch) can close it themselves, same as every screen-switching tile does via showScreen. */
export function closeGearMenu() {
  document.getElementById('gear-overlay')?.classList.remove('open');
}

// Item 12 (REBUILD-HOME, 2026-09-18): a real navigation stack, not a single
// hardcoded "Back always goes Home". Every showScreen call (except one
// driven by goBack itself) pushes the screen it's leaving onto this stack, so
// Back returns to wherever the person actually came from. Other modules
// (the gear dropdown, the Report sheet) register a handler here too - goBack
// tries each one first and only moves screens once none of them had
// something open to close instead (a sheet/dropdown always closes before a
// screen changes underneath it).
const historyStack = [];
const backHandlers = [];
/** Register a "close what I have open, if anything" handler for the shared Back button. Returns true from `fn` to consume the Back press (nothing else runs); false/undefined to let Back fall through to screen navigation. */
export function registerBackHandler(fn) {
  backHandlers.push(fn);
}

export function createNav({ onShow }) {
  function closeMenu() {
    closeGearMenu();
  }

  function activeScreenName() {
    const active = document.querySelector('.screen.active');
    return active ? active.id.replace(/^screen-/, '') : null;
  }

  function showScreen(name, opts = {}) {
    const current = activeScreenName();
    if (!opts.skipHistoryPush && current && current !== name) historyStack.push(current);
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    $('#shell-back-btn').hidden = NO_SHELL_BACK.has(name);
    // The Drop/Read/Copy strip narrates Home's own flow - it has nothing to
    // say on Review/Statement types/Settings/How it works, so it only shows
    // there (kept for the wizard too, mid-mapping is still part of the flow).
    const progressStrip = $('#progress-strip');
    if (progressStrip) progressStrip.hidden = name !== 'home' && name !== 'wizard';
    closeMenu();
    onShow?.(name);
  }

  /** Item 12: Back closes an open sheet/dropdown first (registered handlers, then the gear menu), and only navigates screens once nothing was open to close. */
  function goBack() {
    for (const fn of backHandlers) {
      if (fn()) return;
    }
    if (document.getElementById('gear-overlay')?.classList.contains('open')) { closeMenu(); return; }
    const prev = historyStack.pop() || 'home';
    showScreen(prev, { skipHistoryPush: true });
  }

  // Item E6: the wizard (opened from Home/Profiles) and How it works (opened
  // from a gear tile) both flip a `.screen`'s own `active` class directly
  // rather than going through showScreen (see app.js), so the shell's own
  // "Back" visibility would otherwise miss those transitions. Watching every
  // `.screen`'s class attribute here - in the one file that owns the brand
  // bar - covers every entry point without wizard.js/home.js needing to know
  // about the shell at all.
  function observeScreenChanges() {
    const screens = document.querySelectorAll('.screen');
    const obs = new MutationObserver(() => {
      const active = document.querySelector('.screen.active');
      if (!active) return;
      const name = active.id.replace(/^screen-/, '');
      $('#shell-back-btn').hidden = NO_SHELL_BACK.has(name);
      const progressStrip = $('#progress-strip');
      if (progressStrip) progressStrip.hidden = name !== 'home' && name !== 'wizard';
    });
    screens.forEach((s) => obs.observe(s, { attributes: true, attributeFilter: ['class'] }));
  }

  function wireGearMenu() {
    const overlay = $('#gear-overlay');
    // Item 10: a compact dropdown anchored to the gear button, not a
    // full-screen overlay - clicking outside it or Escape closes it, same as
    // before, just a much smaller hit area to click outside of.
    $('#gear-btn').addEventListener('click', (e) => { e.stopPropagation(); overlay.classList.toggle('open'); });
    document.addEventListener('click', (e) => {
      if (overlay.classList.contains('open') && !overlay.contains(e.target) && e.target !== $('#gear-btn')) closeMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) closeMenu(); });
    // Generic items: a plain screen switch. "Clear statements" and "Show
    // welcome tour" open a Home/app action instead of a screen - home.js's
    // own wire() attaches #tile-clear, app.js attaches #tile-show-tour.
    overlay.querySelectorAll('.dropdown-item[data-screen]').forEach((item) => {
      item.addEventListener('click', () => showScreen(item.dataset.screen));
    });
  }

  /** Item 12: the brand name/logo click always goes Home (pushing wherever you were onto the back stack, same as any other navigation). */
  function wireBrandHome() {
    const brand = $('.brand-left');
    if (!brand) return;
    brand.style.cursor = 'pointer';
    brand.setAttribute('role', 'button');
    brand.setAttribute('tabindex', '0');
    brand.setAttribute('aria-label', 'Home');
    const go = () => showScreen('home');
    brand.addEventListener('click', go);
    brand.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }

  function wire() {
    wireGearMenu();
    wireBrandHome();
    observeScreenChanges();
    $('#shell-back-btn').addEventListener('click', goBack);
  }

  // Item 10: the two-colour bar now shows what actually counts against the
  // user's disk (totalBytes/quotaBytes, from navigator.storage.estimate()) -
  // previously sessionsBytes/settingsBytes were always divided by their OWN
  // sum, so the two fills summed to 100% of the bar's width no matter how
  // little was actually stored (the "looks full" bug: an empty session and a
  // 14.9MB one rendered an identical, fully-filled bar). The fill still
  // splits sessions-vs-settings by colour, scaled down to their share of the
  // real quota; a warning colour only kicks in past 80% used.
  //
  // Simple B: the sidebar's own storage-meter bar is gone (Settings' own
  // "Privacy and storage" card, Section 3, shows storage now) - this stays a
  // guarded no-op when its old DOM target isn't present, so app.js's several
  // call sites need no change.
  async function renderStorageMeter({ storage, sessionStore }) {
    if (!$('#storage-total')) return;
    const { sessionsBytes, settingsBytes, appBytes, totalBytes, quotaBytes } = await computeStorageSplit({ storage, sessionStore });
    $('#storage-total').textContent = storageMeterText(totalBytes, quotaBytes);
    const pctOfQuota = quotaBytes ? totalBytes / quotaBytes : 0;
    // Item E5: nothing actually stored yet - don't split a couple of bytes
    // of empty-array JSON noise 50/50 across the bar.
    const empty = appBytes < 1024 || !quotaBytes;
    const sessionsPct = empty ? 0 : Math.round((sessionsBytes / quotaBytes) * 1000) / 10;
    const settingsPct = empty ? 0 : Math.round((settingsBytes / quotaBytes) * 1000) / 10;
    $('#storage-fill-sessions').style.width = `${sessionsPct}%`;
    $('#storage-fill-settings').style.width = `${settingsPct}%`;
    $('#storage-meter').classList.toggle('storage-warn', pctOfQuota > 0.8);
    const note = $('#storage-context-note');
    if (note) {
      const text = storageContextNote(totalBytes, appBytes);
      note.textContent = text;
      note.hidden = !text;
    }
  }

  return { showScreen, wire, renderStorageMeter };
}
