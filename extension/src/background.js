chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html') });
});

// First-run onboarding tab: opens exactly once, on a plain install only.
// reason === 'install' already fires exactly once per install (never on an
// update or a service-worker respawn), so unlike Profanity Muter's version
// of this listener no extra "already onboarded" flag is needed here - there
// is no second onInstalled listener sharing this function for a different
// job (that one also manages an offscreen document; this extension has none).
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
});
