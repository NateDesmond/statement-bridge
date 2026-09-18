import { shouldShowOnboarding } from './core/onboarding-gate.js';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html') });
});

// First-run onboarding tab: opens exactly once, ever. Gated on a stored
// onboardingShown flag rather than details.reason - an unpacked extension
// reload can also fire onInstalled with reason 'install', which reopened
// the tour on every reload during development. The flag is set BEFORE the
// tab is created, so a failure to open the tab can't leave it unset and
// re-trigger next time. "Show the welcome tour again" (src/ui/app.js)
// bypasses this entirely by opening the tab directly.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['onboardingShown'], (stored) => {
    if (!shouldShowOnboarding(stored)) return;
    chrome.storage.local.set({ onboardingShown: true }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
    });
  });
});
