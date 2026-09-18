import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, decimalsFor, formatMinor, formatMinorDisplay } from '../src/core/amount.js';

test('plain US format', () => {
  assert.deepEqual(parseAmount('1,234.56'), { minor: 123456, currencyHint: null, crdr: null, negative: false });
});

test('European format', () => {
  const r = parseAmount('1.234,56');
  assert.equal(r.minor, 123456);
});

test('parens negative', () => {
  const r = parseAmount('(123.45)');
  assert.equal(r.minor, -12345);
});

test('trailing minus negative', () => {
  assert.equal(parseAmount('123.45-').minor, -12345);
});

test('CR suffix parsed, not auto-signed', () => {
  const r = parseAmount('123.45 CR');
  assert.equal(r.minor, 12345);
  assert.equal(r.crdr, 'CR');
});

test('DR suffix parsed', () => {
  const r = parseAmount('123.45 DR');
  assert.equal(r.crdr, 'DR');
  assert.equal(r.minor, 12345);
});

test('S$ currency hint', () => {
  const r = parseAmount('S$1,234.56');
  assert.equal(r.currencyHint, 'SGD');
  assert.equal(r.minor, 123456);
});

test('US$ currency hint', () => {
  assert.equal(parseAmount('US$99.00').currencyHint, 'USD');
});

test('euro symbol', () => {
  const r = parseAmount('€45,00');
  assert.equal(r.currencyHint, 'EUR');
  assert.equal(r.minor, 4500);
});

test('pound symbol', () => {
  assert.equal(parseAmount('£10.50').currencyHint, 'GBP');
});

test('bare dollar never guesses currency', () => {
  assert.equal(parseAmount('$50.00').currencyHint, null);
});

test('JPY zero-decimal currency', () => {
  assert.equal(decimalsFor('JPY'), 0);
  const r = parseAmount('1,234', { currency: 'JPY' });
  assert.equal(r.minor, 1234);
});

test('unparseable returns null minor', () => {
  assert.equal(parseAmount('n/a').minor, null);
  assert.equal(parseAmount('').minor, null);
  assert.equal(parseAmount(null).minor, null);
});

test('ambiguous comma treated as thousands by default', () => {
  assert.equal(parseAmount('1,234').minor, 123400);
});

test('formatMinor without options stays plain (no thousands separator, safe for cells/CSV)', () => {
  assert.equal(formatMinor(864183, 'SGD'), '8641.83');
});

test('formatMinor grouped inserts thousands separators for a human summary line', () => {
  assert.equal(formatMinor(864183, 'SGD', { grouped: true }), '8,641.83');
  assert.equal(formatMinor(2453, 'SGD', { grouped: true }), '24.53');
  assert.equal(formatMinor(-1234567, 'SGD', { grouped: true }), '-12,345.67');
  assert.equal(formatMinor(1500, 'JPY', { grouped: true }), '1,500');
});

test('formatMinorDisplay is formatMinor grouped by default, the on-screen display formatter', () => {
  assert.equal(formatMinorDisplay(420000, 'SGD'), '4,200.00');
  assert.equal(formatMinorDisplay(null, 'SGD'), '');
});
