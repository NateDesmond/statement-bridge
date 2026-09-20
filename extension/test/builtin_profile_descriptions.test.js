// No statement type ships with the extension any more (see NO-TEMPLATES.md
// item 1) - every profile is created by a user through the wizard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinProfiles } from '../src/core/builtin-profiles.js';

test('builtinProfiles() returns an empty list', () => {
  assert.deepEqual(builtinProfiles(), []);
});
