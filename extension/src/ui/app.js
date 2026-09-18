// App shell orchestrator: wires the sidebar nav to each screen module. Each
// screen's own DOM handling lives in its module (home.js, review.js,
// profiles.js, settings.js, wizard.js); this file only owns shared state and
// the nav-driven render calls.

import { createChromeStorage } from '../core/storage.js';
import { createIndexedDbSessionStore, cleanupOldSessions } from '../core/sessions.js';
import { createNav } from './nav.js';
import { createHome } from './home.js';
import { createReview } from './review.js';
import { createProfilesScreen } from './profiles.js';
import { createSettingsScreen } from './settings.js';
import { createWizard } from './wizard.js';
import { createReportScreen } from './report.js';

const storage = createChromeStorage();
const sessionStore = createIndexedDbSessionStore();

const state = {
  files: [],
  rangePreset: 'all',
};

const nav = createNav({
  onShow: (name) => {
    if (name === 'review') review.render();
    if (name === 'profiles') profiles.render();
    if (name === 'settings') settings.render();
    if (name === 'home') { home.render(); nav.renderStorageMeter({ storage, sessionStore }); }
    // Section D: reached directly via the gear-menu tile (bypassing
    // openReport() below, which is only for entry points that carry a
    // specific file) - re-render with no file prefilled either way.
    if (name === 'report') report.open();
  },
});

let wizardReturnScreen = 'home';

// Section D: every entry point into "Report a problem" (the gear menu,
// Settings, the wizard's error state, Home's "Could not read" cards) goes
// through this one function - it prefills the screen from whichever file
// (if any) prompted the report, then shows it. No return-screen bookkeeping
// like the wizard's: the shell's own Back always goes to Home from here.
// showScreen's own onShow('report') already calls report.open() with no
// file (see above, for the plain gear-menu entry point) - open() again
// afterwards so a specific caller's file wins over that default.
const openReport = (fileName) => { nav.showScreen('report'); report.open(fileName); };

const home = createHome({
  storage,
  state,
  sessionStore,
  onOpenWizard: (entry, opts) => { wizardReturnScreen = 'home'; wizard.open(entry, opts); },
  // review.showFile's second (opts) param is Section B's addition (e.g.
  // {filter:'warnings'}); passing it is safe even before it lands there,
  // since a plain-arity JS function just ignores an extra argument.
  onReviewFile: (entry, opts) => { review.showFile(entry, opts); nav.showScreen('review'); },
  onFilesChanged: () => { home.renderExportPanel(); nav.renderStorageMeter({ storage, sessionStore }); },
  onShowHow: () => nav.showScreen('how'),
  // Item 2: "Fix or delete '<profile>'" on a file row that lost a quality
  // tie jumps straight into Profiles, scrolled to and highlighting that one.
  onFocusProfile: (profileId) => { nav.showScreen('profiles'); profiles.render(profileId); },
  onOpenReport: (entry) => openReport(entry?.name),
});

const review = createReview({
  storage,
  getFiles: () => state.files,
  onUpdateMapping: (entry) => { wizardReturnScreen = 'review'; wizard.open(entry, { forceUpdateMapping: true }); },
  // Item 2: a row resolution (confirm/edit/exclude) survives reload the same
  // way Home's own row edits do - reuse Home's session save, don't duplicate it.
  persist: () => { home.persistSession(); nav.renderStorageMeter({ storage, sessionStore }); },
  // Remove in Review's header for the open file reuses Home's own removeFile
  // (cancel/remove/dedupe re-run/Undo toast) - review.js just re-renders
  // itself afterward onto whatever's left.
  onRemoveFile: (entry) => home.removeFile(entry),
  // Item 3: "Export"/"Add a statement" on the completion panel and footer bar
  // hand off to Home via this same nav instance - there is no Home hook to
  // land deeper (e.g. straight on the Ready-to-copy card), see review.js's
  // goHome() doc comment.
  nav,
});

const profiles = createProfilesScreen({
  storage,
  onMapNewStatement: () => {
    const entry = { name: 'New statement', type: 'text', grid: [[]], bytes: new ArrayBuffer(0) };
    state.files.push(entry);
    wizardReturnScreen = 'profiles';
    wizard.open(entry);
  },
});

const settings = createSettingsScreen({
  storage, sessionStore,
  getSampleRows: () => state.files.flatMap((f) => f.rows || []),
  onCleared: () => { state.files = []; home.render(); nav.renderStorageMeter({ storage, sessionStore }); },
  onOpenReport: () => openReport(),
});

const wizard = createWizard({
  storage,
  onSaved: () => {
    nav.showScreen(wizardReturnScreen);
    home.onMappingSaved(); // re-run cross-file dedupe now this file has rows (item 1)
    home.render();
    profiles.render();
    nav.renderStorageMeter({ storage, sessionStore });
  },
  onOpenReport: (entry) => openReport(entry?.name),
});

const report = createReportScreen({
  getFiles: () => state.files,
});

async function init() {
  await cleanupOldSessions(sessionStore).catch(() => {}); // best-effort; IndexedDB may be unavailable in some test shells
  nav.wire();
  home.wire();
  review.wire();
  profiles.wire();
  settings.wire();
  wizard.wire();
  report.wire();
  document.getElementById('wizard-back-btn').addEventListener('click', () => nav.showScreen(wizardReturnScreen));
  // Simple B: the sidebar's own "How it works" lock-indicator link is gone -
  // its gear-menu tile (data-screen="how") is wired generically by nav.js's
  // wireGearMenu instead. The How screen's own Back button stays.
  document.getElementById('how-back-btn').addEventListener('click', () => nav.showScreen('home'));
  // Item C: "Show the welcome tour again" - Settings and How it works both
  // reopen the same first-run onboarding tab background.js opens on install.
  const openTour = () => chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  document.getElementById('settings-show-tour-link').addEventListener('click', openTour);
  document.getElementById('how-show-tour-link').addEventListener('click', openTour);

  home.render();
  await nav.renderStorageMeter({ storage, sessionStore });
}

init();
