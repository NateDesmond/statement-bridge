import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseXlsxGrid, listXlsxSheets } from '../src/core/xlsx.js';
import { applyProfileVersion } from '../src/core/csv.js';
import { matchProfile } from '../src/core/profiles.js';

const fixturePath = fileURLToPath(new URL('./fixtures/meridian_savings.xlsx', import.meta.url));
const require = createRequire(import.meta.url);

/** Track 4: a real two-sheet workbook, built in-memory (no fixture file needed) to exercise the sheet picker's plumbing. */
function twoSheetWorkbookBytes() {
  const XLSX = require('../vendor/xlsx.full.min.js');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date', 'Amount'], ['01/06/2026', '10.00']]), 'Savings');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date', 'Amount'], ['02/06/2026', '99.00']]), 'Credit Card');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

test('parseXlsxGrid reads the first sheet into the same raw grid shape as CSV', async () => {
  const bytes = readFileSync(fixturePath);
  const grid = await parseXlsxGrid(bytes);
  assert.equal(grid[4].join(','), 'Transaction Date,Reference,Debit Amount,Credit Amount,Balance');
  assert.equal(grid[5][0], '01/06/2026');
});

test('applyProfileVersion works unchanged against an xlsx-sourced grid', async () => {
  const bytes = readFileSync(fixturePath);
  const grid = await parseXlsxGrid(bytes);
  const { header, records } = applyProfileVersion(grid, {
    headerRow: 4, skipRowsBefore: 4, footerRules: [{ type: 'startsWith', value: 'Total' }],
  });
  assert.deepEqual(header, ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount', 'Balance']);
  assert.equal(records.length, 2);
  assert.equal(records[0]['Reference'], 'Coffee shop');
});

test('xlsx-sourced header matches a profile signature the same way a CSV header does', async () => {
  const bytes = readFileSync(fixturePath);
  const grid = await parseXlsxGrid(bytes);
  const profiles = [{
    id: 'p1', name: 'Meridian Bank savings, XLSX', versions: [{
      id: 'v1',
      signatures: { headerText: ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount', 'Balance'], preambleKeywords: ['Meridian Bank'] },
    }],
  }];
  const matches = matchProfile({ header: grid[4], preambleText: grid.slice(0, 4).flat().join(' '), filename: 'statement.xlsx' }, profiles);
  assert.equal(matches[0].profile.id, 'p1');
  assert.ok(matches[0].confidence > 0.7);
});

test('listXlsxSheets lists every sheet name in workbook order', async () => {
  const sheets = await listXlsxSheets(twoSheetWorkbookBytes());
  assert.deepEqual(sheets, ['Savings', 'Credit Card']);
});

test('parseXlsxGrid reads the requested sheet, not just the first', async () => {
  const bytes = twoSheetWorkbookBytes();
  const first = await parseXlsxGrid(bytes);
  const second = await parseXlsxGrid(bytes, { sheetName: 'Credit Card' });
  assert.equal(first[1][0], '01/06/2026');
  assert.equal(second[1][0], '02/06/2026');
});

test('parseXlsxGrid falls back to the first sheet for an unknown sheetName', async () => {
  const bytes = twoSheetWorkbookBytes();
  const grid = await parseXlsxGrid(bytes, { sheetName: 'nope' });
  assert.equal(grid[1][0], '01/06/2026');
});
