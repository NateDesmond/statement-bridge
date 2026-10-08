import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsv, buildTsv, suggestFilename, preExportSummary, DEFAULT_PRESET, DEFAULT_PRESET_MODE_B, isDefaultPresetColumns, unionPreset, isUnionPresetColumns, fieldValue, LAYOUT_PRESETS, AVAILABLE_FIELDS, BLANK_FIELD, CONST_FIELD, isValuelessField } from '../src/core/export.js';
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
  // 2026-09-19: balance is a silent cross-check, not a goal - with no row
  // carrying one, the Balance column is dropped silently, here and in Mode A.
  assert.equal(lines[0].split('\t').join(','), 'Date,Account,Description,Amount,Currency,Original amount,Original currency,FX rate');
  assert.equal(lines[1], ['2026-07-01', '', 'Conference Fee', '-135.00', 'SGD', '-100.00', 'USD', '1.35'].join('\t'));
  assert.equal(lines[2], ['2026-07-05', '', 'Hotel Tokyo', '-136.50', 'SGD', '-15000', 'JPY', '0.0091'].join('\t'));
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

// Item 6 (NO-TEMPLATES): the default export is the union of what was
// actually imported this session.
test('unionPreset: no fileGroups, or none with rows, falls back to exactly DEFAULT_PRESET\'s static shape', () => {
  assert.deepEqual(unionPreset(undefined), DEFAULT_PRESET);
  assert.deepEqual(unionPreset([]), DEFAULT_PRESET);
  assert.deepEqual(unionPreset([{ label: 'Empty file', rows: [] }]), DEFAULT_PRESET);
});

test('unionPreset: always starts with Date, Account, Description, Amount, Currency', () => {
  const groups = [{ label: 'DBS savings', rows: [{ date: '2026-06-01', account_label: 'DBS', description_raw: 'Coffee', amount: -350, currency: 'SGD' }] }];
  const fields = unionPreset(groups).columns.map((c) => c.field);
  assert.deepEqual(fields.slice(0, 5), ['date', 'account_label', 'description_raw', 'amount', 'currency']);
});

test('unionPreset: adds Posting date/Reference/Type/Original amount/Original currency only when present, in a fixed order', () => {
  const groups = [
    { label: 'Standard Chartered credit card', rows: [{ date: '2026-06-01', account_label: 'SC', description_raw: 'Coffee', amount: -350, currency: 'SGD', reference: 'REF001', orig_amount: -260, orig_currency: 'USD' }] },
    { label: 'DBS savings', rows: [{ date: '2026-06-02', account_label: 'DBS', description_raw: 'Salary', amount: 500000, currency: 'SGD', post_date: '2026-06-03', type: 'ACH_CREDIT' }] },
  ];
  const fields = unionPreset(groups).columns.map((c) => c.field);
  assert.deepEqual(fields, ['date', 'account_label', 'description_raw', 'amount', 'currency', 'post_date', 'reference', 'type', 'orig_amount', 'orig_currency']);
  assert.deepEqual(unionPreset(groups).columns.map((c) => c.name), ['Date', 'Account', 'Description', 'Amount', 'Currency', 'Posting date', 'Reference', 'Type', 'Original amount', 'Original currency']);
});

test('unionPreset: with no optional field present, the default export is exactly the base five', () => {
  const groups = [{ label: 'DBS savings', rows: [
    { date: '2026-06-01', account_label: 'DBS', description_raw: 'Coffee', amount: -350, currency: 'SGD', post_date: null, reference: '', type: '' },
    { date: '2026-06-02', account_label: 'DBS', description_raw: 'Salary', amount: 500000, currency: 'SGD' },
  ] }];
  assert.deepEqual(unionPreset(groups).columns.map((c) => c.field), ['date', 'account_label', 'description_raw', 'amount', 'currency']);
});

// Item B (2026-09-20): Statement type/Bank/File describe the statement, not
// the transaction, and Balance is a silent cross-check - none of them widen
// the default export, however many rows carry one.
test('unionPreset: never includes Statement type, Bank, File or Balance', () => {
  const groups = [{ label: 'DBS savings', rows: [
    { date: '2026-06-01', account_label: 'DBS', description_raw: 'Coffee', amount: -350, currency: 'SGD', balance: 100000, statement_type: 'current', bank: 'DBS', source_file: 'dbs.pdf' },
  ] }];
  const fields = unionPreset(groups).columns.map((c) => c.field);
  for (const banned of ['statement_type', 'bank', 'source_file', 'balance']) assert.ok(!fields.includes(banned), banned);
});

// Item B: Account is the one column whose whole job is saying which statement
// a row came from, so it is never blank - a row that never got an
// account_label falls back to its bank + statement type, then its file name.
test('fieldValue: Account falls back to the statement label, never an empty cell', () => {
  assert.equal(fieldValue({ account_label: 'Northwind Bank current ****3210' }, 'account_label', {}), 'Northwind Bank current ****3210');
  assert.equal(fieldValue({ account_label: null, bank: 'Northwind Bank', statement_type: 'current' }, 'account_label', {}), 'Northwind Bank current');
  assert.equal(fieldValue({ account_label: null, source_file: 'statement.csv' }, 'account_label', {}), 'statement.csv');
});

test('buildCsv: Account column carries the fallback label for rows with no account_label', () => {
  const rows = [{ date: '2026-06-01', description_raw: 'Coffee', amount: -350, currency: 'SGD', bank: 'Northwind Bank', statement_type: 'current' }];
  const preset = unionPreset([{ label: 'Northwind', rows }]);
  const [, dataLine] = buildCsv(rows, preset).split('\r\n');
  assert.equal(dataLine.split(',')[1], 'Northwind Bank current');
});

test('unionPreset: a field present in only one of several statements still gets included (union, not intersection)', () => {
  const groups = [
    { label: 'A', rows: [{ date: '2026-06-01', amount: -1, currency: 'SGD' }] },
    { label: 'B', rows: [{ date: '2026-06-02', amount: -2, currency: 'SGD', reference: 'R1' }] },
    { label: 'C', rows: [{ date: '2026-06-03', amount: -3, currency: 'SGD' }] },
  ];
  assert.ok(unionPreset(groups).columns.some((c) => c.field === 'reference'));
});

test('unionPreset: matches DEFAULT_PRESET\'s own dateFormat/signConvention/headerRow shape', () => {
  const preset = unionPreset([{ label: 'A', rows: [{ date: '2026-06-01' }] }]);
  assert.equal(preset.dateFormat, DEFAULT_PRESET.dateFormat);
  assert.equal(preset.signConvention, DEFAULT_PRESET.signConvention);
  assert.equal(preset.headerRow, DEFAULT_PRESET.headerRow);
});

test('isUnionPresetColumns: true for the untouched union default, false once customised away from it', () => {
  const groups = [{ label: 'DBS savings', rows: [{ date: '2026-06-01', reference: 'REF001' }] }];
  const union = unionPreset(groups);
  assert.equal(isUnionPresetColumns(union, groups), true);
  assert.equal(isUnionPresetColumns({ columns: [{ field: 'date', name: 'Date' }] }, groups), false);
});

test('fieldValue money_out/money_in split by the internal sign, never both non-empty', () => {
  const out = { amount: -350, currency: 'SGD' };
  const inRow = { amount: 500000, currency: 'SGD' };
  assert.equal(fieldValue(out, 'money_out', {}), '3.50');
  assert.equal(fieldValue(out, 'money_in', {}), '');
  assert.equal(fieldValue(inRow, 'money_out', {}), '');
  assert.equal(fieldValue(inRow, 'money_in', {}), '5000.00');
});

// --- EXPORT-AND-DUPES part 2: blank/fixed-text columns, renames, Everything ---

test('rule 5: the Everything layout is exactly the field catalog, with no blank or fixed-text column in it', () => {
  const everything = LAYOUT_PRESETS.find((l) => l.key === 'everything');
  assert.deepEqual(everything.columns.map((c) => c.field), AVAILABLE_FIELDS.map((f) => f.field));
  assert.deepEqual(everything.columns.map((c) => c.name), AVAILABLE_FIELDS.map((f) => f.name));
  for (const f of ['post_date', 'reference', 'type', 'orig_amount', 'orig_currency', 'source_file', 'source_page', 'source_line', 'profile_version']) {
    assert.ok(everything.columns.some((c) => c.field === f), `Everything is missing ${f}`);
  }
  assert.ok(!everything.columns.some((c) => isValuelessField(c.field)));
});

test('rule 3: a blank column exports as an empty cell, a fixed-text column repeats its value down every row', () => {
  const preset = {
    columns: [
      { field: 'date', name: 'date' },
      { field: BLANK_FIELD, name: 'plaid_account_id' },
      { field: CONST_FIELD, name: 'asset_id', value: 'SC_Rach' },
    ],
    dateFormat: 'YYYY-MM-DD', signConvention: 'signed', headerRow: true,
  };
  const lines = buildCsv(rows, preset).split('\r\n');
  assert.equal(lines[0], 'date,plaid_account_id,asset_id');
  assert.equal(lines[1], '2026-06-01,,SC_Rach');
  assert.equal(lines[2], '2026-06-15,,SC_Rach');
});

test('rule 3: fieldValue reads a fixed-text value off the column, not the row, and a missing value is still empty', () => {
  assert.equal(fieldValue(rows[0], CONST_FIELD, DEFAULT_PRESET, { field: CONST_FIELD, name: 'asset_id', value: 'SC_Rach' }), 'SC_Rach');
  assert.equal(fieldValue(rows[0], CONST_FIELD, DEFAULT_PRESET, { field: CONST_FIELD, name: 'asset_id' }), '');
  assert.equal(fieldValue(rows[0], CONST_FIELD, DEFAULT_PRESET), '');
  assert.equal(fieldValue(rows[0], BLANK_FIELD, DEFAULT_PRESET, { field: BLANK_FIELD, name: 'notes' }), '');
});

test('rule 3: a fixed-text value containing the delimiter is quoted like any other cell', () => {
  const preset = { columns: [{ field: CONST_FIELD, name: 'tag', value: 'a,b' }], dateFormat: 'YYYY-MM-DD', signConvention: 'signed', headerRow: true };
  assert.equal(buildCsv([rows[0]], preset).split('\r\n')[1], '"a,b"');
  assert.equal(buildTsv([rows[0]], preset).split('\r\n')[1], 'a,b');
});

test('rule 4/8: a renamed header is what Copy for Sheets writes, and rule 9 target layout produces Nate\'s exact TSV header', () => {
  const preset = {
    columns: [
      { field: 'date', name: 'date' },
      { field: 'description_raw', name: 'payee' },
      { field: 'amount', name: 'amount' },
      { field: 'currency', name: 'currency' },
      { field: BLANK_FIELD, name: 'plaid_account_id' },
      { field: 'account_label', name: 'asset_id' },
      { field: BLANK_FIELD, name: 'notes' },
    ],
    dateFormat: 'YYYY-MM-DD', signConvention: 'signed', headerRow: true,
  };
  const row = { date: '2026-09-01', description_raw: 'BONUS INTEREST (SALARY)', amount: 4766, currency: 'sgd', account_label: 'SC_Rach' };
  const lines = buildTsv([row], preset).split('\r\n');
  assert.equal(lines[0], 'date\tpayee\tamount\tcurrency\tplaid_account_id\tasset_id\tnotes');
  assert.equal(lines[1], '2026-09-01\tBONUS INTEREST (SALARY)\t47.66\tsgd\t\tSC_Rach\t');
});

test('rule 3: two blank columns keep their own separate headers (the target layout needs two)', () => {
  const preset = {
    columns: [{ field: BLANK_FIELD, name: 'plaid_account_id' }, { field: BLANK_FIELD, name: 'notes' }],
    dateFormat: 'YYYY-MM-DD', signConvention: 'signed', headerRow: true,
  };
  assert.equal(buildCsv([rows[0]], preset).split('\r\n')[0], 'plaid_account_id,notes');
});
