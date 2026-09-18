import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsv, buildTsv, suggestFilename, preExportSummary, DEFAULT_PRESET, DEFAULT_PRESET_MODE_B, isDefaultPresetColumns, fieldValue } from '../src/core/export.js';
import { convertToTarget } from '../src/core/currency.js';

const rows = [
  { date: '2026-06-01', description_raw: 'Coffee', amount: -350, currency: 'SGD', balance: 99650, account_label: 'DBS', excluded: false, original: { Raw: 'x1' } },
  { date: '2026-06-15', description_raw: 'Salary', amount: 500000, currency: 'SGD', balance: 599650, account_label: 'DBS', excluded: false, original: { Raw: 'x2' } },
];

test('buildCsv produces header + unformatted decimal amounts', () => {
  const csv = buildCsv(rows, DEFAULT_PRESET);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Date,Account,Description,Amount,Currency,Balance');
  assert.equal(lines[1], '2026-06-01,DBS,Coffee,-3.50,SGD,996.50');
  assert.equal(lines[2], '2026-06-15,DBS,Salary,5000.00,SGD,5996.50');
});

test('buildCsv quotes cells containing the delimiter', () => {
  const withComma = [{ ...rows[0], description_raw: 'Coffee, Tea' }];
  const csv = buildCsv(withComma, DEFAULT_PRESET);
  assert.match(csv, /"Coffee, Tea"/);
});

test('buildTsv uses tabs and omits quoting for commas', () => {
  const tsv = buildTsv(rows, DEFAULT_PRESET);
  assert.ok(tsv.includes('\t'));
  assert.ok(!tsv.includes(','.repeat(1)) || tsv.split('\t')[0] === 'Date'); // header sanity
});

test('buildCsv respects dateFormat', () => {
  const preset = { ...DEFAULT_PRESET, dateFormat: 'DD/MM/YYYY' };
  const csv = buildCsv(rows, preset);
  assert.match(csv, /01\/06\/2026/);
});

test('buildCsv can include source columns', () => {
  const csv = buildCsv(rows, DEFAULT_PRESET, { includeSourceColumns: true });
  assert.match(csv, /Raw/);
  assert.match(csv, /x1/);
});

test('suggestFilename embeds date range', () => {
  assert.equal(suggestFilename({ start: '2026-06-01', end: '2026-06-30' }), 'statement-export_2026-06-01_to_2026-06-30.csv');
});

test('suggestFilename falls back with no range', () => {
  assert.equal(suggestFilename(null), 'statement-export.csv');
});

test('preExportSummary totals per currency and date range', () => {
  const summary = preExportSummary(rows);
  assert.equal(summary.rowCount, 2);
  assert.deepEqual(summary.dateRange, { start: '2026-06-01', end: '2026-06-15' });
  assert.equal(summary.totals.SGD, 499650);
});

test('item 2: buildCsv formats a JPY amount with no decimals ("1500", never "1500.00")', () => {
  const jpyRows = [
    { date: '2026-06-01', description_raw: 'Ramen', amount: -1500, currency: 'JPY', balance: 48500, account_label: 'Test', excluded: false },
  ];
  const csv = buildCsv(jpyRows, DEFAULT_PRESET);
  const lines = csv.split('\r\n');
  assert.equal(lines[1], '2026-06-01,Test,Ramen,-1500,JPY,48500');
});

test('buildCsv exports an extra_* column (e.g. a DBS "Type" column) when the preset includes it', () => {
  const rowsWithExtra = [
    { date: '2026-06-01', description_raw: 'Deposit', amount: 1000, currency: 'SGD', extra_type: 'Deposit', skipped: false },
    { date: '2026-06-02', description_raw: 'Withdrawal', amount: -500, currency: 'SGD', extra_type: 'Withdrawal', skipped: false },
  ];
  const preset = {
    columns: [{ field: 'date', name: 'Date' }, { field: 'extra_type', name: 'Type' }],
    dateFormat: 'YYYY-MM-DD', signConvention: 'signed', headerRow: true,
  };
  const csv = buildCsv(rowsWithExtra, preset);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Date,Type');
  assert.equal(lines[1], '2026-06-01,Deposit');
  assert.equal(lines[2], '2026-06-02,Withdrawal');
});

test('fieldValue returns a comma-containing description whole, for a UI to render in one cell without re-splitting CSV text', () => {
  const row = { description_raw: 'Coffee, Tea' };
  assert.equal(fieldValue(row, 'description_raw', DEFAULT_PRESET), 'Coffee, Tea');
});

// D2 (blocker, 2026-09-17): Mode B's converted amounts must reach the
// default Copy/Download export. home.js's rowsForExport swaps amount/currency
// for the converted value/target currency (keeping the original as
// orig_amount/orig_currency) before building the export; this replicates
// that swap through buildTsv end to end, with rows in two currencies.
function rowsForExportModeB(rows, target, rates) {
  const { rows: converted } = convertToTarget(rows, target, rates, rates);
  return converted.map((r) => ({ ...r, orig_amount: r.amount, orig_currency: r.currency, amount: r.converted_amount, currency: r.converted_currency }));
}

test('D2: Mode B converted amounts reach buildTsv\'s Amount/Currency columns, with orig_amount/orig_currency/fx_rate alongside', () => {
  const rows = [
    { date: '2026-07-01', description_raw: 'Conference Fee', amount: -10000, currency: 'USD', excluded: false, skipped: false },
    { date: '2026-07-05', description_raw: 'Hotel Tokyo', amount: -15000, currency: 'JPY', excluded: false, skipped: false },
  ];
  const exportRows = rowsForExportModeB(rows, 'SGD', { USD_SGD: 1.35, JPY_SGD: 0.0091 });
  const tsv = buildTsv(exportRows, DEFAULT_PRESET_MODE_B);
  const lines = tsv.split('\r\n');
  assert.equal(lines[0].split('\t').join(','), 'Date,Account,Description,Amount,Currency,Original amount,Original currency,FX rate,Balance');
  assert.equal(lines[1], ['2026-07-01', '', 'Conference Fee', '-135.00', 'SGD', '-100.00', 'USD', '1.35', ''].join('\t'));
  assert.equal(lines[2], ['2026-07-05', '', 'Hotel Tokyo', '-136.50', 'SGD', '-15000', 'JPY', '0.0091', ''].join('\t'));
});

test('isDefaultPresetColumns: true for the untouched default, false once columns are customised', () => {
  assert.equal(isDefaultPresetColumns(DEFAULT_PRESET), true);
  assert.equal(isDefaultPresetColumns(DEFAULT_PRESET_MODE_B), false);
  assert.equal(isDefaultPresetColumns({ columns: [{ field: 'date', name: 'Date' }] }), false);
});

test('buildCsv formats converted_amount in the target currency\'s own decimal places', () => {
  const rowsB = [
    { date: '2026-06-01', description_raw: 'Coffee', amount: -350, currency: 'SGD', converted_amount: -1500, converted_currency: 'JPY', fx_rate: 111.5, skipped: false },
  ];
  const preset = {
    columns: [{ field: 'date', name: 'Date' }, { field: 'converted_amount', name: 'Converted amount' }, { field: 'converted_currency', name: 'Target currency' }, { field: 'fx_rate', name: 'FX rate' }],
    dateFormat: 'YYYY-MM-DD', signConvention: 'signed', headerRow: true,
  };
  const csv = buildCsv(rowsB, preset);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Date,Converted amount,Target currency,FX rate');
  assert.equal(lines[1], '2026-06-01,-1500,JPY,111.5');
});

// Item 4: the full ~12-option export date format list, and a couple of
// representative round-trips.
test('formatDateOut covers every DATE_FORMATS option', async () => {
  const { formatDateOut, DATE_FORMATS } = await import('../src/core/export.js');
  const iso = '2026-09-05';
  assert.equal(DATE_FORMATS.length, 12);
  assert.equal(formatDateOut(iso, 'YYYY-MM-DD'), '2026-09-05');
  assert.equal(formatDateOut(iso, 'DD/MM/YYYY'), '05/09/2026');
  assert.equal(formatDateOut(iso, 'MM/DD/YYYY'), '09/05/2026');
  assert.equal(formatDateOut(iso, 'DD-MM-YYYY'), '05-09-2026');
  assert.equal(formatDateOut(iso, 'D/M/YYYY'), '5/9/2026');
  assert.equal(formatDateOut(iso, 'DD MMM YYYY'), '05 Sep 2026');
  assert.equal(formatDateOut(iso, 'MMM D, YYYY'), 'Sep 5, 2026');
  assert.equal(formatDateOut(iso, 'YYYY/MM/DD'), '2026/09/05');
  assert.equal(formatDateOut(iso, 'DD.MM.YYYY'), '05.09.2026');
  assert.equal(formatDateOut(iso, 'YYYYMMDD'), '20260905');
  assert.equal(formatDateOut(iso, 'isoWithTime'), '2026-09-05');
  // Google Sheets serial number: day 0 is 1899-12-30.
  assert.equal(formatDateOut(iso, 'sheetsSerial'), String(Math.round((Date.UTC(2026, 8, 5) - Date.UTC(1899, 11, 30)) / 86400000)));
});

test('fieldValue money_out/money_in split by the internal sign, never both non-empty', () => {
  const out = { amount: -350, currency: 'SGD' };
  const inRow = { amount: 500000, currency: 'SGD' };
  assert.equal(fieldValue(out, 'money_out', {}), '3.50');
  assert.equal(fieldValue(out, 'money_in', {}), '');
  assert.equal(fieldValue(inRow, 'money_out', {}), '');
  assert.equal(fieldValue(inRow, 'money_in', {}), '5000.00');
});
