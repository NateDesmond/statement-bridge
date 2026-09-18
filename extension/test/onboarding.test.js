import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampStep } from '../onboarding/onboarding.js';
import { shouldShowOnboarding } from '../src/core/onboarding-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

test('clampStep stays within the 3 screens', () => {
  assert.equal(clampStep(1, -1), 1); // can't go before the first screen
  assert.equal(clampStep(1, 1), 2);
  assert.equal(clampStep(3, 1), 3); // can't go past the last screen
  assert.equal(clampStep(2, 1), 3);
});

test('shouldShowOnboarding: shows once, ever, regardless of reason', () => {
  assert.equal(shouldShowOnboarding(undefined), true); // nothing stored yet
  assert.equal(shouldShowOnboarding({}), true);
  assert.equal(shouldShowOnboarding({ onboardingShown: false }), true);
  assert.equal(shouldShowOnboarding({ onboardingShown: true }), false);
  // an unpacked reload can also report reason 'install' - the flag alone decides
  assert.equal(shouldShowOnboarding({ onboardingShown: true }), false);
});

test('background.js gates the onboarding tab on the stored flag, not details.reason', () => {
  const src = fs.readFileSync(path.join(root, 'src/background.js'), 'utf-8');
  assert.match(src, /onInstalled\.addListener/);
  assert.match(src, /shouldShowOnboarding/);
  assert.match(src, /onboardingShown:\s*true/);
  assert.match(src, /onboarding\/onboarding\.html/);
});

test('onboarding.html has all three screens and the workspace hand-off button', () => {
  const html = fs.readFileSync(path.join(root, 'onboarding/onboarding.html'), 'utf-8');
  assert.match(html, /id="ob-step-1"/);
  assert.match(html, /id="ob-step-2"/);
  assert.match(html, /id="ob-step-3"/);
  assert.match(html, /id="ob-open-workspace"/);
});

test('"Show the welcome tour again" is reachable from Settings and How it works', () => {
  const html = fs.readFileSync(path.join(root, 'workspace.html'), 'utf-8');
  assert.match(html, /id="settings-show-tour-link"/);
  assert.match(html, /id="how-show-tour-link"/);
  const appJs = fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf-8');
  assert.match(appJs, /settings-show-tour-link/);
  assert.match(appJs, /how-show-tour-link/);
  assert.match(appJs, /onboarding\/onboarding\.html/);
});
