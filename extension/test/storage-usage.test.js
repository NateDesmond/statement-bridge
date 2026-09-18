import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatBytesAuto, storageMeterText, storageContextNote } from '../src/ui/storage-usage.js';

test('formatBytes stays in MB', () => {
  assert.equal(formatBytes(1024 * 1024 * 14.9), '14.9 MB');
});

test('formatBytesAuto switches to GB at 1GB and above', () => {
  assert.equal(formatBytesAuto(1024 * 1024 * 14.9), '14.9 MB');
  assert.equal(formatBytesAuto(1024 * 1024 * 1024 * 1.2), '1.2 GB');
});

// Item 4: the sidebar headline is short enough to never wrap at 216px -
// "X of Y used", quota rounded to a whole GB ("310 GB", never "310.5 GB").
test('storageMeterText reads "X of Y used" when a quota is known', () => {
  const used = 1024 * 1024 * 14.9;
  const quota = 1024 * 1024 * 1024 * 120;
  assert.equal(storageMeterText(used, quota), '14.9 MB of 120 GB used');
});

test('storageMeterText rounds a fractional GB quota down ("310.5 GB" -> "310 GB")', () => {
  const used = 0;
  const quota = 1024 * 1024 * 1024 * 310.5;
  assert.equal(storageMeterText(used, quota), '0.0 MB of 310 GB used');
});

test('storageMeterText falls back to a plain used figure with no quota', () => {
  assert.equal(storageMeterText(1024 * 1024 * 3, null), '3.0 MB used');
});

// Item 9/10: a quiet context note only when the browser's own usage figure
// runs well past what the app's own JSON actually accounts for.
test('storageContextNote is silent when usage is close to the app\'s own data', () => {
  assert.equal(storageContextNote(1024 * 1024, 900 * 1024), '');
});

test('storageContextNote explains the gap once usage is far above the app\'s own data', () => {
  const note = storageContextNote(1024 * 1024 * 20, 1024 * 50);
  assert.match(note, /browser's own storage overhead/);
});
