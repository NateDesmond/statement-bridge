// First-run onboarding: three screens (Welcome / How it works / Get your
// first statement), Next/Back only. No settings to configure here (unlike
// Profanity Muter's onboarding) - Statement Bridge has nothing to configure
// before its first drop, so this is a tour, not a wizard.

const TOTAL_STEPS = 3;

// The only piece worth a unit test on its own (see test/onboarding.test.js):
// clamps a step change to the valid range instead of walking off either end.
export function clampStep(current, delta, total = TOTAL_STEPS) {
  return Math.min(total, Math.max(1, current + delta));
}

function wire() {
  let step = 1;

  function render() {
    document.querySelectorAll('.ob-step').forEach((s) => {
      s.hidden = s.id !== `ob-step-${step}`;
    });
    document.getElementById('ob-dots').setAttribute('aria-valuenow', String(step));
    document.getElementById('ob-back').hidden = step === 1;
    document.getElementById('ob-next').hidden = step === TOTAL_STEPS;
  }

  document.getElementById('ob-back').addEventListener('click', () => {
    step = clampStep(step, -1);
    render();
  });
  document.getElementById('ob-next').addEventListener('click', () => {
    step = clampStep(step, 1);
    render();
  });
  document.getElementById('ob-open-workspace').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html') });
  });

  render();
}

if (typeof document !== 'undefined' && document.getElementById('ob-next')) wire();
