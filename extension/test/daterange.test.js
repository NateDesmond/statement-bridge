import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreset, filterByRange, coverageWarnings, formatShortDate } from '../src/core/daterange.js';

test('resolvePreset: thisMonth', () => {
  const range = resolvePreset('thisMonth', new Date('2026-06-15T00:00:00Z'));
  assert.deepEqual(range, { startISO: '2026-06-01', endISO: '2026-06-30' });
});

test('resolvePreset: lastFullMonth', () => {
  const range = resolvePreset('lastFullMonth', new Date('2026-06-15T00:00:00Z'));
  assert.deepEqual(range, { startISO: '2026-05-01', endISO: '2026-05-31' });
});

test('resolvePreset: last3Months', () => {
  const range = resolvePreset('last3Months', new Date('2026-06-15T00:00:00Z'));
  assert.deepEqual(range, { startISO: '2026-04-01', endISO: '2026-06-30' });
});

test('resolvePreset: ytd', () => {
  const range = resolvePreset('ytd', new Date('2026-06-15T00:00:00Z'));
  assert.deepEqual(range, { startISO: '2026-01-01', endISO: '2026-06-15' });
});

test('resolvePreset: all has no bounds', () => {
  assert.deepEqual(resolvePreset('all'), { startISO: null, endISO: null });
});

test('resolvePreset: year boundary for lastFullMonth', () => {
  const range = resolvePreset('lastFullMonth', new Date('2026-01-15T00:00:00Z'));
  assert.deepEqual(range, { startISO: '2025-12-01', endISO: '2025-12-31' });
});

test('filterByRange splits included/excluded by date field', () => {
  const rows = [{ date: '2026-06-01' }, { date: '2026-07-15' }, { date: '2026-05-01' }];
  const result = filterByRange(rows, { startISO: '2026-06-01', endISO: '2026-06-30' });
  assert.equal(result.includedCount, 1);
  assert.equal(result.excludedCount, 2);
});

test('filterByRange can filter on post_date', () => {
  const rows = [{ date: '2026-06-01', post_date: '2026-07-01' }];
  const result = filterByRange(rows, { startISO: '2026-07-01', endISO: '2026-07-31' }, 'post_date');
  assert.equal(result.includedCount, 1);
});

test('formatShortDate uses a fixed 3-letter month, never "Sept"', () => {
  assert.equal(formatShortDate('2026-09-15'), '15 Sep 2026');
  assert.equal(formatShortDate('2026-09-15', { year: false }), '15 Sep');
  assert.equal(formatShortDate('2026-01-01'), '1 Jan 2026');
});

test('coverageWarnings flags an account whose data stops early', () => {
  const accounts = [{ accountLabel: 'UOB', rows: [{ date: '2026-08-25' }] }];
  const warnings = coverageWarnings(accounts, { startISO: '2026-08-01', endISO: '2026-08-31' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No UOB data after 25 Aug/);
});

test('coverageWarnings silent when account covers full range', () => {
  const accounts = [{ accountLabel: 'UOB', rows: [{ date: '2026-08-31' }] }];
  const warnings = coverageWarnings(accounts, { startISO: '2026-08-01', endISO: '2026-08-31' });
  assert.equal(warnings.length, 0);
});
