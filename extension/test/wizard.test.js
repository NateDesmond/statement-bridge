import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seedMappingFromVersion, signConventionWarnings, slugify,
  buildGroupedPdfConfig, groupedWholeFileSampleRows, applyTestResolutions,
  computeStepValid, computeStepReason, classifyGroupedPreviewLines,
  linesAfterFirstDateGroup, createWizard,
} from '../src/ui/wizard.js';
import { groupItemsIntoLines, extractGroupedRows, detectGroupedSignConvention } from '../src/core/pdf.js';

/** One PDF text item: {str, x, y, ...} shaped like pdf.js's getTextContent items, close enough for groupItemsIntoLines/extractGroupedRows. */
function item(str, x, y) { return { str, x, y, width: str.length * 5, height: 10, fontName: 'F1' }; }
/** One page's worth of grouped-layout lines: a date-group header, then description+amount, then a type line - the exact 3-lines-per-transaction shape core/pdf.js's extractGroupedRows expects. */
function groupedPageLines(y0 = 700) {
  const items = [
    item('Monday, 15 Sep 2026', 40, y0),
    item('Grab GRA-123', 40, y0 - 14), item('SGD - 20.83', 400, y0 - 14),
    item('Transport', 40, y0 - 28),
  ];
  return groupItemsIntoLines(items);
}

test('slugify turns a hand-typed name into a safe extra_<slug> key', () => {
  assert.equal(slugify('Visa Last 4'), 'visa_last_4');
  assert.equal(slugify('  Weird!! Name  '), 'weird_name');
  assert.equal(slugify(''), 'field');
});

test('seedMappingFromVersion keeps a header that still exists mapped from the old version', () => {
  const version = { fields: { date: { source: 'Transaction Date' }, description_raw: { source: ['Description'] }, amount: { source: 'Amount' } } };
  const header = ['Transaction Date', 'Description', 'Amount'];
  const mapping = seedMappingFromVersion(version, header, []);
  assert.deepEqual(mapping, [
    { source: 'Transaction Date', field: 'date' },
    { source: 'Description', field: 'description_raw' },
    { source: 'Amount', field: 'amount' },
  ]);
});

test('seedMappingFromVersion falls back to fresh suggestion for a header the old version never saw', () => {
  const version = { fields: { date: { source: 'Transaction Date' }, amount: { source: 'Amount' } } };
  const header = ['Transaction Date', 'Amount', 'Balance'];
  const sampleRows = [['01/06/2026', '10.00', '500.00']];
  const mapping = seedMappingFromVersion(version, header, sampleRows);
  assert.equal(mapping.find((m) => m.source === 'Balance').field, 'balance');
});

test('seedMappingFromVersion drops a source header the file no longer has, without touching others', () => {
  const version = { fields: { date: { source: 'Old Date Header' }, amount: { source: 'Amount' } } };
  const header = ['Amount'];
  const mapping = seedMappingFromVersion(version, header, []);
  assert.deepEqual(mapping, [{ source: 'Amount', field: 'amount' }]);
});

test('signConventionWarnings flags a credit card with no money out', () => {
  const rows = [{ amount: 500 }, { amount: 200 }];
  const warnings = signConventionWarnings(rows, { statementType: 'credit_card', sourceHasCrDr: false });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Money out is zero/);
});

test('signConventionWarnings flags same-sign amounts when the source has CR/DR markers', () => {
  const rows = [{ amount: -10 }, { amount: -20 }];
  const warnings = signConventionWarnings(rows, { statementType: 'savings', sourceHasCrDr: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CR\/DR markers/);
});

test('signConventionWarnings is quiet when signs look right', () => {
  const rows = [{ amount: -10 }, { amount: 20 }];
  const warnings = signConventionWarnings(rows, { statementType: 'savings', sourceHasCrDr: true });
  assert.equal(warnings.length, 0);
});

// --- Fix 1: grouped-PDF whole-file sample values --------------------------

test('buildGroupedPdfConfig always sets rowModel: grouped (Fix 1 root cause)', () => {
  const config = buildGroupedPdfConfig('signed', null);
  assert.equal(config.rowModel, 'grouped');
  assert.equal(config.grouped.signConvention, 'signed');
});

test('groupedWholeFileSampleRows returns real values for the Map-fields "Sample values (whole file)" column', () => {
  const allLines = [groupedPageLines()];
  const rows = groupedWholeFileSampleRows(allLines, 'signed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '15 Sep 2026');
  assert.equal(rows[0].description_raw, 'Grab GRA-123');
  assert.equal(rows[0].amount, '-20.83');
  assert.equal(rows[0].currency, 'SGD');
  // Item 4 (2026-09-17): an unmapped file's generic preview no longer
  // assumes DBS's own "type line right after the amount" layout by default
  // - a trailing continuation line only becomes `type` when a matched
  // profile opts in (grouped.trailingTypeLine, e.g. DBS's builtin profile).
  // With no next transaction to claim it as description either, it's
  // simply dropped here.
  assert.equal(rows[0].type, '');
});

test('groupedWholeFileSampleRows reads every page, not just the first', () => {
  const allLines = [groupedPageLines(700), groupedPageLines(500)];
  const rows = groupedWholeFileSampleRows(allLines, 'signed', null, 10);
  assert.equal(rows.length, 2);
});

// --- Fix 5: Test step per-row resolutions ---------------------------------

test('applyTestResolutions confirms a row: flags clear, row is marked confirmed', () => {
  const rows = [{ row_id: 'f:0', flags: ['low_confidence_ocr'] }, { row_id: 'f:1', flags: ['sign_unclear'] }];
  const resolutions = new Map([['f:0', { kind: 'confirmed' }]]);
  const next = applyTestResolutions(rows, resolutions);
  assert.deepEqual(next[0].flags, []);
  assert.equal(next[0].confirmed, true);
  assert.deepEqual(next[1].flags, ['sign_unclear'], 'untouched row unaffected');
});

test('applyTestResolutions excludes a row without touching its flags', () => {
  const rows = [{ row_id: 'f:0', flags: ['missing_amount'] }];
  const resolutions = new Map([['f:0', { kind: 'excluded' }]]);
  const next = applyTestResolutions(rows, resolutions);
  assert.equal(next[0].excluded, true);
  assert.deepEqual(next[0].flags, ['missing_amount']);
});

test('applyTestResolutions applies an edit, stashes the original, and clears flags', () => {
  const rows = [{ row_id: 'f:0', date: null, date_raw: '31 Feb 2026', amount: null, flags: ['unparseable_date', 'missing_amount'] }];
  const resolutions = new Map([['f:0', { kind: 'edited', edits: { date: '2026-02-28', amount: -1000 } }]]);
  const next = applyTestResolutions(rows, resolutions);
  assert.equal(next[0].date, '2026-02-28');
  assert.equal(next[0].amount, -1000);
  assert.equal(next[0].editedFields.date, null);
  assert.equal(next[0].confirmed, true);
  assert.deepEqual(next[0].flags, []);
});

test('applyTestResolutions with no resolutions returns the same rows unchanged', () => {
  const rows = [{ row_id: 'f:0', flags: [] }];
  assert.equal(applyTestResolutions(rows, new Map()), rows);
});

// --- Finding 2: Map-fields step's Continue never re-evaluates after a --------
// manual mapping (a select's change handler called renderLivePreview() but
// not renderFooter(), so stepValid() never re-ran) --------------------------

test('computeStepValid step 0 (Basics) needs a bank and a currency', () => {
  assert.equal(computeStepValid(0, { bank: '', currency: 'SGD' }), false);
  assert.equal(computeStepValid(0, { bank: 'DBS', currency: '' }), false);
  assert.equal(computeStepValid(0, { bank: 'DBS', currency: 'SGD' }), true);
});

test('computeStepValid step 1 (Locate data): CSV needs a header row, PDF needs anchors or grouped rows', () => {
  assert.equal(computeStepValid(1, { isPdf: false, headerRowIdx: -1 }), false);
  assert.equal(computeStepValid(1, { isPdf: false, headerRowIdx: 0 }), true);
  assert.equal(computeStepValid(1, { isPdf: true, pdfRowModel: 'columns', tableStart: null, tableEnd: null }), false);
  assert.equal(computeStepValid(1, { isPdf: true, pdfRowModel: 'columns', tableStart: {}, tableEnd: {} }), true);
  assert.equal(computeStepValid(1, { isPdf: true, pdfRowModel: 'grouped', groupedRowCount: 0 }), false);
  assert.equal(computeStepValid(1, { isPdf: true, pdfRowModel: 'grouped', groupedRowCount: 3 }), true);
});

test('computeStepValid step 2 (Map fields): a manual CSV mapping of just Date and Description is not enough, Date+Amount is', () => {
  assert.equal(computeStepValid(2, { isPdf: false, mappingFields: ['date', 'description_raw'] }), false);
  assert.equal(computeStepValid(2, { isPdf: false, mappingFields: ['date', 'description_raw', 'amount'] }), true);
  assert.equal(computeStepValid(2, { isPdf: false, mappingFields: ['date', 'debit', 'credit'] }), true);
});

test('computeStepValid step 2 (Map fields): PDF zone assignment mirrors CSV mapping; grouped PDFs are always valid', () => {
  assert.equal(computeStepValid(2, { isPdf: true, pdfRowModel: 'columns', pdfColumnFields: ['date', 'description_raw'] }), false);
  assert.equal(computeStepValid(2, { isPdf: true, pdfRowModel: 'columns', pdfColumnFields: ['date', 'description_raw', 'amount'] }), true);
  assert.equal(computeStepValid(2, { isPdf: true, pdfRowModel: 'grouped' }), true);
});

test('Pass 3 item 1: computeStepValid step 2 also gates on the date/number format actually matching the file', () => {
  const base = { isPdf: false, mappingFields: ['date', 'description_raw', 'amount'] };
  assert.equal(computeStepValid(2, base), true, 'no gate info yet (undefined) reads as ok');
  assert.equal(computeStepValid(2, { ...base, dateFormatOk: false, dateFailedCount: 6, dateSampleTotal: 6 }), false);
  assert.equal(computeStepValid(2, { ...base, numberFormatOk: false }), false);
  assert.equal(computeStepValid(2, { ...base, dateFormatOk: true, numberFormatOk: true }), true);
  // Grouped PDFs skip the field-mapping check but not the format gate.
  assert.equal(computeStepValid(2, { isPdf: true, pdfRowModel: 'grouped', dateFormatOk: false }), false);
  assert.equal(computeStepValid(2, { isPdf: true, pdfRowModel: 'grouped' }), true);
});

test('Pass 3 item 1: computeStepReason names the format mismatch once fields are mapped', () => {
  const base = { isPdf: false, mappingFields: ['date', 'amount'] };
  assert.equal(
    computeStepReason(2, { ...base, dateFormatOk: false, dateFailedCount: 6, dateSampleTotal: 6 }),
    'This date format does not match your file: 6 of 6 dates could not be read',
  );
  assert.equal(
    computeStepReason(2, { ...base, numberFormatOk: false, numberFailedCount: 2, numberSampleTotal: 10 }),
    'This number format does not match your file: 2 of 10 amounts could not be read',
  );
  assert.equal(computeStepReason(2, { ...base, dateFormatOk: true, numberFormatOk: true }), '');
});

test('computeStepValid step 3+ (Test, Save) has nothing left to validate', () => {
  assert.equal(computeStepValid(3, {}), true);
  assert.equal(computeStepValid(4, {}), true);
});

test('Finding B1: computeStepReason names exactly what is missing on Basics', () => {
  assert.equal(computeStepReason(0, { bank: '', currency: 'SGD' }), 'Bank name is required');
  assert.equal(computeStepReason(0, { bank: 'DBS', currency: '' }), 'a default currency is required');
  assert.equal(computeStepReason(0, { bank: '', currency: '' }), 'Bank name and a default currency are required');
  assert.equal(computeStepReason(0, { bank: 'DBS', currency: 'SGD' }), '');
});

test('Finding B1: computeStepReason names exactly what is missing on Map fields (CSV and PDF zones)', () => {
  assert.equal(computeStepReason(2, { isPdf: false, mappingFields: [] }), 'Map a Date column and an Amount column (or Money out and Money in columns) to continue');
  assert.equal(computeStepReason(2, { isPdf: false, mappingFields: ['date'] }), 'Map an Amount column (or Money out and Money in columns) to continue');
  assert.equal(computeStepReason(2, { isPdf: false, mappingFields: ['date', 'amount'] }), '');
  assert.equal(computeStepReason(2, { isPdf: true, pdfRowModel: 'columns', pdfColumnFields: [] }), 'Map a Date column and an Amount column (or Money out and Money in columns) to continue');
  assert.equal(computeStepReason(2, { isPdf: true, pdfRowModel: 'grouped' }), '');
});

// --- Item 2: overlay highlight must use the same classifier as extraction ---

test('classifyGroupedPreviewLines highlights a no-sign credit the same way extraction counts it (regression)', () => {
  const items = [
    item('Monday, 15 Sep 2026', 40, 700),
    item('Grab GRA-123', 40, 686), item('SGD + 20.83', 400, 686), // explicit "+"
    item('Transport', 40, 672),
    item('Salary ABC Corp', 40, 658), item('SGD 3,000.00', 400, 658), // no-sign credit
    item('Payroll', 40, 644),
  ];
  const lines = groupItemsIntoLines(items);
  const extracted = extractGroupedRows(lines, buildGroupedPdfConfig('positiveIsIn'));
  const classified = classifyGroupedPreviewLines(lines);
  const txnLines = classified.filter((c) => c.isTxn);
  // The overlay's own count of highlighted transaction lines must match the
  // number of rows extraction actually produced - the exact regression a
  // stricter sign-requiring classifier used to break (the "+" line
  // highlighted, the no-sign credit line silently not).
  assert.equal(txnLines.length, extracted.length);
  assert.equal(txnLines.length, 2);
  assert.ok(txnLines.some((c) => /SGD \+ 20\.83/.test(c.text)));
  assert.ok(txnLines.some((c) => /SGD 3,000\.00/.test(c.text)));
});

// --- Item 1 confidence fix: preamble must never dilute sign detection ------

test('linesAfterFirstDateGroup drops preamble text (an address ending in digits, a bare statement-period year, a hyphenated account number) that used to false-positive-match as amount lines', () => {
  const items = [
    item('DBS Bank Ltd', 40, 800),
    item('123 Example Avenue, #01-01, Singapore 123456', 40, 786),
    item('Account No: 123-4-567890', 40, 772),
    item('September 2026', 40, 758),
    item('Wednesday, 16 Sep 2026', 40, 700),
    item('Coffee House', 40, 686), item('SGD - 7.80', 400, 686),
    item('Salary ABC Corp', 40, 672), item('SGD + 4,200.00', 400, 672),
  ];
  const lines = groupItemsIntoLines(items);
  // Unfiltered: the preamble false-positives dilute confidence well below 0.9.
  const before = detectGroupedSignConvention(lines);
  assert.ok(before.confidence < 0.9, `expected diluted confidence, got ${before.confidence}`);
  // Filtered: only the 2 real, both-signed transaction lines remain, 100%.
  const after = detectGroupedSignConvention(linesAfterFirstDateGroup(lines));
  assert.equal(after.signConvention, 'signed');
  assert.equal(after.confidence, 1);
});

test('applyTestResolutions applies the suggested amount_alt, marks edited, clears low_confidence_ocr', () => {
  // normalize.js's real shape: amount is the flagged (decimal-dropped) read,
  // amount_alt the likely-correct value, 100x smaller in minor units.
  const rows = [{
    row_id: 'f:0', amount: -17300, amount_alt: -173, currency: 'SGD',
    flags: ['ocr', 'low_confidence_ocr'], low_confidence_hint: 'Amount read as 173 with no decimal point. Likely 1.73. Check against the page.',
  }];
  const resolutions = new Map([['f:0', { kind: 'appliedAlt' }]]);
  const next = applyTestResolutions(rows, resolutions);
  assert.equal(next[0].amount, -173);
  assert.equal(next[0].edited, true);
  assert.deepEqual(next[0].flags, ['ocr']);
  assert.equal(next[0].low_confidence_hint, null);
});

// --- Item 1 root cause: buildVersionFromWizard for every state.pdf shape --
// state.pdf is null for a csv/xlsx entry (only a pdf entry gets a state.pdf
// object at all) - any state.pdf.* read in buildVersionFromWizard not
// guarded by isPdf() throws "Cannot read properties of null" for every
// non-pdf file, on every preview/test render. domOverride replaces the
// wizard's own $('#w-...').value reads, which need a real DOM.
function wizardFor(entry, extra = {}) {
  const wiz = createWizard({ storage: {}, onSaved: () => {} });
  Object.assign(wiz.state, { entry, headerRowIdx: 0, footerSkip: new Set(), transforms: [] }, extra);
  return wiz;
}
const domValues = { dateFormat: 'DD/MM/YYYY', numberFormat: '1,234.56', signConvention: 'signed', bank: 'Test Bank' };

test('buildVersionFromWizard builds a csv version (state.pdf is null)', () => {
  const wiz = wizardFor(
    { type: 'text', name: 'statement.csv', grid: [['Date', 'Amount'], ['01/01/2026', '10.00']] },
    { mapping: [{ source: 'Date', field: 'date' }, { source: 'Amount', field: 'amount' }] },
  );
  const version = wiz.buildVersionFromWizard(domValues);
  assert.equal(version.pdf, undefined);
  assert.ok(version.csv);
  assert.equal(version.fields.date.source, 'Date');
  assert.equal(version.fields.amount.source, 'Amount');
  assert.equal(version.csv.rangeRules, undefined, 'a file nobody touched in the grid never gets a rangeRules block');
});

test('buildVersionFromWizard writes rangeRules once the grid has been touched (Track 4)', () => {
  const wiz = wizardFor(
    { type: 'text', name: 'statement.csv', grid: [['Date', 'Amount'], ['01/01/2026', '10.00']] },
    {
      mapping: [{ source: 'Date', field: 'date' }, { source: 'Amount', field: 'amount' }],
      rangeFirstDataRow: 2, rangeLastDataRow: 10, excludedColumns: new Set([1]),
    },
  );
  const version = wiz.buildVersionFromWizard(domValues);
  assert.deepEqual(version.csv.rangeRules, { headerRow: 0, firstDataRow: 2, lastDataRow: 10, excludedColumns: [1], sheetName: undefined });
});

test('buildVersionFromWizard builds an xlsx version (state.pdf is also null)', () => {
  const wiz = wizardFor(
    { type: 'xlsx', name: 'statement.xlsx', grid: [['Date', 'Amount'], ['01/01/2026', '10.00']] },
    { mapping: [{ source: 'Date', field: 'date' }, { source: 'Amount', field: 'amount' }] },
  );
  const version = wiz.buildVersionFromWizard(domValues);
  assert.equal(version.pdf, undefined);
  assert.ok(version.csv);
  assert.equal(version.fields.amount.source, 'Amount');
});

test('buildVersionFromWizard builds a columns-rowModel pdf version', () => {
  const wiz = wizardFor(
    { type: 'pdf', name: 'statement.pdf' },
    {
      pdf: {
        rowModel: 'columns',
        columns: [{ field: 'date', x0: 0, x1: 10 }, { field: 'amount', x0: 10, x1: 20 }],
        tableStart: { anchor: 'a' }, tableEnd: { anchor: 'b' }, rowStartPattern: '', joinWrappedLines: true, columnBands: null,
      },
    },
  );
  const version = wiz.buildVersionFromWizard(domValues);
  assert.equal(version.csv, undefined);
  assert.equal(version.pdf.rowModel, 'columns');
  assert.equal(version.fields.date.source, 'date');
  assert.equal(version.signConvention, 'signed');
});

test('buildVersionFromWizard builds a grouped-rowModel pdf version, forcing signConvention "signed" regardless of the picker', () => {
  const wiz = wizardFor(
    { type: 'pdf', name: 'statement2.pdf' },
    { pdf: { rowModel: 'grouped', columnBands: null } },
  );
  const version = wiz.buildVersionFromWizard({ ...domValues, signConvention: 'positiveIsOut' });
  assert.equal(version.csv, undefined);
  assert.equal(version.pdf.rowModel, 'grouped');
  assert.equal(version.fields.date.source, 'date');
  assert.equal(version.fields.amount.source, 'amount');
  assert.equal(version.signConvention, 'signed');
});
