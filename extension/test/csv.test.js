import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrid, applyProfileVersion, trimLines } from '../src/core/csv.js';

test('parseGrid splits a simple CSV into a grid', async () => {
  const grid = await parseGrid('a,b,c\n1,2,3\n4,5,6');
  assert.deepEqual(grid, [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
});

// Corpus fix (2026-09-18): a real TAB-delimited file's blank last column
// (e.g. a debit/credit pair leaving whichever side didn't apply empty) is
// ONE real trailing tab, not padding - trimLines used to strip any trailing
// tab/space unconditionally, silently dropping that column from every row
// with a blank last field before Papa ever saw it.
test('trimLines keeps a trailing tab that is the delimiter itself (a real blank last field)', () => {
  const cleaned = trimLines('Date\tDebit\tCredit\n01/06/2026\t10.00\t\n02/06/2026\t\t5000.00', '\t');
  assert.deepEqual(cleaned.split('\n'), ['Date\tDebit\tCredit', '01/06/2026\t10.00\t', '02/06/2026\t\t5000.00']);
});

test('parseGrid preserves a tab-delimited row\'s blank trailing field', async () => {
  const grid = await parseGrid('Date\tDebit\tCredit\n01/06/2026\t10.00\t', { delimiter: '\t' });
  assert.deepEqual(grid, [['Date', 'Debit', 'Credit'], ['01/06/2026', '10.00', '']]);
});

test('trimLines still strips leading tab padding and trailing padding for a non-tab delimiter', () => {
  const cleaned = trimLines('\t\tAccount: 123\ta,b,c   \n1,2,3', ',');
  assert.deepEqual(cleaned.split('\n'), ['Account: 123\ta,b,c', '1,2,3']);
});

test('applyProfileVersion locates header row after preamble and reads records', () => {
  const grid = [
    ['Account Details For: John'],
    [''],
    ['Some other preamble line'],
    [''],
    [''],
    ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount'],
    ['01/06/2026', 'NETS PAY', '10.00', ''],
    ['02/06/2026', 'SALARY', '', '5000.00'],
  ];
  const { header, records } = applyProfileVersion(grid, { headerRow: 5, skipRowsBefore: 5 });
  assert.deepEqual(header, ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount']);
  assert.equal(records.length, 2);
  assert.equal(records[0]['Transaction Date'], '01/06/2026');
  assert.equal(records[1]['Credit Amount'], '5000.00');
});

test('footerRules cut off trailing summary rows', () => {
  const grid = [
    ['Date', 'Amount'],
    ['01/06/2026', '10.00'],
    ['Total', '10.00'],
    ['garbage after total', ''],
  ];
  const { records } = applyProfileVersion(grid, { headerRow: 0, footerRules: [{ type: 'startsWith', value: 'Total' }] });
  assert.equal(records.length, 1);
});

test('ignoreRowRules drop interspersed non-data rows', () => {
  const grid = [
    ['Date', 'Amount'],
    ['01/06/2026', '10.00'],
    ['Balance brought forward', '100.00'],
    ['02/06/2026', '20.00'],
  ];
  const { records } = applyProfileVersion(grid, {
    headerRow: 0,
    ignoreRowRules: [{ type: 'regex', value: '^Balance brought forward' }],
  });
  assert.equal(records.length, 2);
  assert.equal(records[1]['Date'], '02/06/2026');
});

test('footerRules match regardless of case (real statements vary Total/TOTAL/total)', () => {
  const grid = [
    ['Date', 'Amount'],
    ['01/06/2026', '10.00'],
    ['TOTAL:', '10.00'],
    ['garbage after total', ''],
  ];
  const { records } = applyProfileVersion(grid, { headerRow: 0, footerRules: [{ type: 'startsWith', value: 'Total' }] });
  assert.equal(records.length, 1);
});

test('blank rows are skipped', () => {
  const grid = [['Date', 'Amount'], ['01/06/2026', '10.00'], ['', ''], ['02/06/2026', '20.00']];
  const { records } = applyProfileVersion(grid, { headerRow: 0 });
  assert.equal(records.length, 2);
});

// Track 4: rangeRules (manual grid selection) plumbing.

test('rangeRules.headerRow overrides the plain headerRow field', () => {
  const grid = [['ignore'], ['Date', 'Amount'], ['01/06/2026', '10.00']];
  const { header } = applyProfileVersion(grid, { headerRow: 0, rangeRules: { headerRow: 1 } });
  assert.deepEqual(header, ['Date', 'Amount']);
});

test('rangeRules.firstDataRow/lastDataRow bound the data block on both ends', () => {
  const grid = [
    ['Date', 'Amount'],
    ['note row, not a transaction', ''],
    ['01/06/2026', '10.00'],
    ['02/06/2026', '20.00'],
    ['Total', '30.00'],
    ['page 1 of 1', ''],
  ];
  const { records } = applyProfileVersion(grid, { headerRow: 0, rangeRules: { firstDataRow: 2, lastDataRow: 3 } });
  assert.equal(records.length, 2);
  assert.equal(records[0]['Date'], '01/06/2026');
  assert.equal(records[1]['Date'], '02/06/2026');
});

test('rangeRules.excludedColumns drops a column from every record and the header', () => {
  const grid = [
    ['Date', 'Foreign Currency Amount', 'Amount'],
    ['01/06/2026', 'USD 5.00', '10.00'],
  ];
  const { header, records } = applyProfileVersion(grid, { headerRow: 0, rangeRules: { excludedColumns: [1] } });
  assert.deepEqual(header, ['Date', 'Amount']);
  assert.equal(records[0]['Amount'], '10.00');
  assert.equal(records[0]['Foreign Currency Amount'], undefined);
});
