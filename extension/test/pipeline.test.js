import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileRows } from '../src/core/pipeline.js';
import { groupItemsIntoLines } from '../src/core/pdf.js';
import { applyTestResolutions } from '../src/ui/wizard.js';

/** One synthetic OCR text item: {str, x, y, confidence, ...} - close enough for groupItemsIntoLines/extractGroupedRows, same shape core/ocr.js's real output uses. */
function ocrItem(str, x, y, confidence = 95) {
  return { str, x, y, confidence, width: str.length * 5, height: 10, fontName: 'F1' };
}

/**
 * A synthetic OCR'd grouped-layout page: one clean row, one row whose amount
 * token itself was misread at low confidence, and one no-sign credit (which
 * resolveGroupedSign can't resolve under signConvention 'signed' without a
 * marker, so it comes back sign_unclear).
 */
function ocrPageLines() {
  const items = [
    ocrItem('Monday, 15 Sep 2026', 40, 700, 97),
    ocrItem('Grab GRA-123', 40, 686, 96), ocrItem('SGD - 20.83', 400, 686, 96), // clean
    ocrItem('Transport', 40, 672, 95),
    ocrItem('Coffee House', 40, 658, 94), ocrItem('SGD - 4.50', 400, 658, 0), // amount token confidence 0: item 5c's retry-disagreement signal
    ocrItem('Dining', 40, 644, 93),
    ocrItem('Salary ABC Corp', 40, 630, 96), ocrItem('SGD 3,000.00', 400, 630, 96), // no-sign credit
    ocrItem('Payroll', 40, 616, 95),
  ];
  return groupItemsIntoLines(items);
}

// Same shape wizard.js's buildFieldsFromMapping produces from
// ensureGroupedMapping()'s fixed date/description_raw/amount/currency
// mapping for a grouped-rowModel PDF.
const version = {
  id: 'v1',
  pdf: { rowModel: 'grouped', grouped: { signConvention: 'signed', trailingTypeLine: true } },
  fields: {
    date: { source: 'date' },
    description_raw: { source: ['description_raw'] },
    amount: { source: 'amount' },
    currency: { mode: 'column', source: 'currency' },
  },
  dateFormat: 'DD MMM YYYY', numberFormat: '1,234.56', signConvention: 'signed',
};

test('buildFileRows sets OCR confidence flags (item 5 root cause fix) - the one function both Test and Save/Home must call', () => {
  const entry = { type: 'pdf', name: 'dbs_scan.pdf', ocr: true };
  const rows = buildFileRows(entry, { pagesLines: [ocrPageLines()] }, version, { bank: 'DBS', statementType: 'savings', currency: 'SGD' });
  assert.equal(rows.length, 3);
  const byDesc = Object.fromEntries(rows.map((r) => [r.description_raw, r]));
  assert.ok(byDesc['Grab GRA-123'].flags.includes('ocr'));
  assert.ok(!byDesc['Grab GRA-123'].flags.includes('low_confidence_ocr'), 'clean row stays clean');
  assert.ok(byDesc['Coffee House'].flags.includes('low_confidence_ocr'), 'misread amount token flags low confidence');
  assert.ok(byDesc['Salary ABC Corp'].flags.includes('sign_unclear'), 'no-sign credit under signConvention signed is sign_unclear');
});

test('wizard Test and Save calling buildFileRows the same way produce the same flags histogram (no meta drift possible)', () => {
  const entry = { type: 'pdf', name: 'dbs_scan.pdf', ocr: true };
  const source = { pagesLines: [ocrPageLines()] };
  // "Test step" call shape (no ocr in metaOverrides - buildFileRows reads entry.ocr itself)
  const testRows = buildFileRows(entry, source, version, { bank: 'DBS', statementType: 'savings', currency: 'SGD', year: undefined });
  // "Save"/Home call shape - same entry, same source, same version
  const saveRows = buildFileRows(entry, source, version, { bank: 'DBS', statementType: 'savings', currency: 'SGD', year: undefined });
  const histogram = (rows) => rows.reduce((h, r) => { for (const f of r.flags) h[f] = (h[f] || 0) + 1; return h; }, {});
  assert.deepEqual(histogram(testRows), histogram(saveRows));
  assert.deepEqual(testRows.map((r) => r.row_id), saveRows.map((r) => r.row_id));
});

test('a row confirmed "Looks right" in Test survives Save: same row_id, resolution re-applies cleanly', () => {
  const entry = { type: 'pdf', name: 'dbs_scan.pdf', ocr: true };
  const source = { pagesLines: [ocrPageLines()] };
  const meta = { bank: 'DBS', statementType: 'savings', currency: 'SGD' };
  const testRows = buildFileRows(entry, source, version, meta);
  const flaggedRow = testRows.find((r) => r.flags.includes('sign_unclear'));
  const resolutions = new Map([[flaggedRow.row_id, { kind: 'confirmed' }]]);

  // Save rebuilds rows from scratch via the same buildFileRows call...
  const savedRows = applyTestResolutions(buildFileRows(entry, source, version, meta), resolutions);
  const savedRow = savedRows.find((r) => r.row_id === flaggedRow.row_id);
  assert.ok(savedRow, 'row_id is stable between Test and Save (both go through buildFileRows the same way)');
  assert.ok(savedRow.confirmed, 'the Test-step confirmation carried into the saved row');
  assert.ok(!savedRow.flags.includes('sign_unclear'), 'confirmRow clears the resolved warning');
});

// EXPORT-AND-DUPES rule 1: balance_mismatch is produced by checks.js after
// normalize.js, so the suppression for a CSV/XLSX source lives here, at the
// one call site - a balance column that does not add up in the bank's own
// export is the bank's arithmetic, not a misread to check against a page.
test('rule 1: buildFileRows never flags balance_mismatch on a CSV source, though the same rows do fail the balance check', async () => {
  const { tagBalanceMismatches } = await import('../src/core/checks.js');
  const csvVersion = {
    id: 'v-csv',
    csv: { headerRow: 0, skipRowsBefore: 0, footerRules: [], ignoreRowRules: [] },
    fields: {
      date: { source: 'Date' },
      description_raw: { source: ['Description'] },
      amount: { source: 'Amount' },
      balance: { source: 'Balance' },
      currency: { mode: 'profileDefault' },
    },
    dateFormat: 'DD/MM/YYYY', numberFormat: '1,234.56', signConvention: 'signed',
  };
  const grid = [
    ['Date', 'Description', 'Amount', 'Balance'],
    ['01/06/2026', 'Coffee', '-5.00', '1000.00'],
    ['02/06/2026', 'Salary', '100.00', '1100.00'],
    ['03/06/2026', 'Groceries', '-50.00', '1050.00'],
    ['04/06/2026', 'Refund', '20.00', '2000.00'], // does not reconcile
  ];
  const entry = { type: 'csv', name: 'bank_export.csv', grid };
  const rows = buildFileRows(entry, {}, csvVersion, { currency: 'SGD' });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => !r.flags.includes('balance_mismatch')), 'no "check it against the page" on authoritative text');
  tagBalanceMismatches(rows);
  assert.ok(rows[3].flags.includes('balance_mismatch'), 'the same rows really do fail the balance check - only the CSV call site skips it');
});
