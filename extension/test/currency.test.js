import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCurrency, totalsPerCurrency, convertToTarget, formatBothDirections } from '../src/core/currency.js';

test('detectCurrency prefers column over everything', () => {
  const r = detectCurrency({ columnValue: 'USD', headerHint: 'SGD', rowText: 'S$10', profileDefault: 'EUR' });
  assert.deepEqual(r, { currency: 'USD', source: 'column' });
});

test('detectCurrency falls back to header when no column', () => {
  const r = detectCurrency({ headerHint: 'SGD', rowText: 'US$10', profileDefault: 'EUR' });
  assert.equal(r.currency, 'SGD');
  assert.equal(r.source, 'header');
});

test('detectCurrency falls back to row symbol', () => {
  const r = detectCurrency({ rowText: 'US$10.00', profileDefault: 'EUR' });
  assert.equal(r.currency, 'USD');
  assert.equal(r.source, 'symbol');
});

test('detectCurrency falls back to profile default last', () => {
  const r = detectCurrency({ profileDefault: 'SGD' });
  assert.equal(r.currency, 'SGD');
  assert.equal(r.source, 'profileDefault');
});

test('detectCurrency never guesses from bare dollar sign', () => {
  const r = detectCurrency({ rowText: '$10.00', profileDefault: 'SGD' });
  assert.equal(r.source, 'profileDefault');
});

test('detectCurrency returns null when nothing available', () => {
  assert.deepEqual(detectCurrency({}), { currency: null, source: null });
});

test('totalsPerCurrency groups by currency', () => {
  const rows = [{ amount: 100, currency: 'SGD' }, { amount: -50, currency: 'SGD' }, { amount: 200, currency: 'USD' }];
  assert.deepEqual(totalsPerCurrency(rows), { SGD: 50, USD: 200 });
});

test('convertToTarget converts using rate and skips same-currency rows', () => {
  const rows = [{ amount: 10000, currency: 'USD' }, { amount: 5000, currency: 'SGD' }];
  const result = convertToTarget(rows, 'SGD', { USD_SGD: 1.35 });
  assert.equal(result.rows[0].converted_amount, 13500);
  assert.equal(result.rows[1].converted_amount, 5000);
  assert.equal(result.blocked, false);
});

test('convertToTarget blocks export and lists missing pairs', () => {
  const rows = [{ amount: 10000, currency: 'EUR' }];
  const result = convertToTarget(rows, 'SGD', {});
  assert.equal(result.blocked, true);
  assert.deepEqual(result.missingPairs, ['EUR_SGD']);
});

test('convertToTarget flags >20% deviation from saved rate', () => {
  const rows = [{ amount: 10000, currency: 'USD' }];
  const result = convertToTarget(rows, 'SGD', { USD_SGD: 2.0 }, { USD_SGD: 1.35 });
  assert.equal(result.deviationWarnings.length, 1);
});

test('formatBothDirections shows both sides', () => {
  const s = formatBothDirections('SGD', 'USD', 0.74);
  assert.match(s, /1 SGD = 0.74 USD/);
  assert.match(s, /1 USD = .* SGD/);
});

test('item 2: convertToTarget scales for a zero-decimal source into a 2-decimal target (JPY minor units are whole yen, not cents)', () => {
  // 1000 JPY minor units (=¥1000) at a rate of 0.0067 JPY->USD should
  // land at 670 USD minor units (=$6.70), not 7 (the pre-fix bug: multiplying
  // minor units directly by a plain currency rate with no decimals scaling).
  const rows = [{ amount: 1000, currency: 'JPY' }];
  const result = convertToTarget(rows, 'USD', { JPY_USD: 0.0067 });
  assert.equal(result.rows[0].converted_amount, 670);
});

test('item 2: convertToTarget is unchanged for two same-decimal currencies', () => {
  const rows = [{ amount: 10000, currency: 'USD' }];
  const result = convertToTarget(rows, 'SGD', { USD_SGD: 1.35 });
  assert.equal(result.rows[0].converted_amount, 13500);
});

// D4: per-month rates. A pair's stored rate can be a per-month map instead
// of a single flat number; each row must convert using ITS OWN month's rate.
test('D4: convertToTarget picks the row\'s own month rate from a per-month rate map', () => {
  const rows = [
    { date: '2026-07-01', amount: -10000, currency: 'USD' }, // Jul
    { date: '2026-08-15', amount: 25000, currency: 'USD' }, // Aug
  ];
  const result = convertToTarget(rows, 'SGD', { USD_SGD: { '2026-07': 1.30, '2026-08': 1.40 } });
  assert.equal(result.blocked, false);
  assert.equal(result.rows[0].converted_amount, -13000);
  assert.equal(result.rows[0].fx_rate, 1.30);
  assert.equal(result.rows[1].converted_amount, 35000);
  assert.equal(result.rows[1].fx_rate, 1.40);
});

test('D4: a per-month rate map missing one month blocks export for that pair', () => {
  const rows = [
    { date: '2026-07-01', amount: -10000, currency: 'USD' },
    { date: '2026-09-01', amount: -10000, currency: 'USD' }, // no Sep rate entered
  ];
  const result = convertToTarget(rows, 'SGD', { USD_SGD: { '2026-07': 1.30 } });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.missingPairs, ['USD_SGD']);
  assert.equal(result.rows[0].converted_amount, -13000);
  assert.equal(result.rows[1].converted_amount, null);
});
