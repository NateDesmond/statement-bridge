import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, inferDayMonthOrder, inferYearFromPeriod } from '../src/core/date.js';

test('DD/MM/YYYY', () => {
  assert.equal(parseDate('25/12/2025', 'DD/MM/YYYY'), '2025-12-25');
});

test('MM/DD/YYYY', () => {
  assert.equal(parseDate('12/25/2025', 'MM/DD/YYYY'), '2025-12-25');
});

test('YYYY-MM-DD', () => {
  assert.equal(parseDate('2025-12-25', 'YYYY-MM-DD'), '2025-12-25');
});

test('DD MMM YYYY', () => {
  assert.equal(parseDate('25 Dec 2025', 'DD MMM YYYY'), '2025-12-25');
});

test('DD MMM YYYY tolerates a day+month OCR word-merge with no space ("1Sep 2026")', () => {
  assert.equal(parseDate('1Sep 2026', 'DD MMM YYYY'), '2026-09-01');
  assert.equal(parseDate('15Dec 2025', 'DD MMM YYYY'), '2025-12-15');
});

test('invalid date returns null', () => {
  assert.equal(parseDate('31/02/2025', 'DD/MM/YYYY'), null);
  assert.equal(parseDate('garbage', 'DD/MM/YYYY'), null);
});

test('DD/MM no year needs opts.year', () => {
  assert.equal(parseDate('05/03', 'DD/MM', { year: 2026 }), '2026-03-05');
  assert.equal(parseDate('05/03', 'DD/MM'), null);
});

test('inferDayMonthOrder: value over 12 in first slot -> dayFirst', () => {
  assert.equal(inferDayMonthOrder(['25/12/2025', '01/02/2025']), 'dayFirst');
});

test('inferDayMonthOrder: value over 12 in second slot -> monthFirst', () => {
  assert.equal(inferDayMonthOrder(['12/25/2025', '01/02/2025']), 'monthFirst');
});

test('inferDayMonthOrder: all ambiguous', () => {
  assert.equal(inferDayMonthOrder(['01/02/2025', '03/04/2025']), 'ambiguous');
});

test('inferYearFromPeriod: same year', () => {
  const y = inferYearFromPeriod(6, 15, { startISO: '2026-01-01', endISO: '2026-12-31' });
  assert.equal(y, 2026);
});

test('inferYearFromPeriod: crosses boundary, month near end uses end year', () => {
  const period = { startISO: '2025-12-15', endISO: '2026-01-15' };
  assert.equal(inferYearFromPeriod(1, 5, period), 2026);
  assert.equal(inferYearFromPeriod(12, 20, period), 2025);
});
