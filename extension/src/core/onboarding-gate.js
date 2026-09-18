// Gate for auto-opening the first-run onboarding tab (see src/background.js).
//
// Pure so the rule is unit-tested without a live chrome.storage or a
// details.reason from a real onInstalled event.
//
// Deliberately ignores details.reason entirely. reason 'install' does not
// mean "this is the first time ever" - reloading an unpacked extension from
// chrome://extensions can also fire onInstalled with reason 'install', which
// reopened the tour on every reload. onboardingShown is the only source of
// truth: it is set before the tab is opened, so a crash between the two
// can't leave it unset and reopen the tour later.
export function shouldShowOnboarding(stored) {
  return !stored || stored.onboardingShown !== true;
}
