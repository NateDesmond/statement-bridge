import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFileSize, checkBatchSize, safeCompileRegex, MAX_FILE_BYTES } from '../src/core/limits.js';

test('checkFileSize rejects files over 25MB', () => {
  assert.equal(checkFileSize(MAX_FILE_BYTES + 1).ok, false);
  assert.equal(checkFileSize(MAX_FILE_BYTES).ok, true);
});

test('checkBatchSize warns above 50 files or 100k rows, not below', () => {
  assert.deepEqual(checkBatchSize(10, 100), []);
  assert.equal(checkBatchSize(51, 100).length, 1);
  assert.equal(checkBatchSize(10, 100001).length, 1);
  assert.equal(checkBatchSize(60, 200000).length, 2);
});

test('safeCompileRegex rejects patterns over 200 chars', () => {
  const long = 'a'.repeat(201);
  const result = safeCompileRegex(long, 'sample');
  assert.equal(result.ok, false);
  assert.match(result.reason, /too long/);
});

test('safeCompileRegex rejects invalid patterns', () => {
  assert.equal(safeCompileRegex('(unclosed', 'x').ok, false);
});

test('safeCompileRegex accepts a normal pattern', () => {
  const result = safeCompileRegex('^\\d{2}/\\d{2}/\\d{4}$', '01/06/2026');
  assert.equal(result.ok, true);
  assert.ok(result.regex.test('01/06/2026'));
});

test('safeCompileRegex catches a pattern that is slow on the sample', () => {
  // classic catastrophic backtracking pattern, sized to blow the 50ms budget
  // without taking more than a couple seconds for the test itself to run.
  const result = safeCompileRegex('^(a+)+$', 'a'.repeat(24) + '!');
  assert.equal(result.ok, false);
});
