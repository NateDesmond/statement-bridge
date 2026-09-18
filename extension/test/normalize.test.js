import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecords } from '../src/core/normalize.js';
import { formatMinor } from '../src/core/amount.js';
import { convertToTarget } from '../src/core/currency.js';

const dbsVersion = {
  id: 'v1',
  dateFormat: 'DD/MM/YYYY',
  numberFormat: '1,234.56',
  signConvention: 'debitCredit',
  fields: {
    date: { source: 'Transaction Date' },
    description_raw: { source: ['Reference'], join: ' ' },
    amount: { debit: 'Debit Amount', credit: 'Credit Amount' },
    balance: { source: 'Balance' },
    currency: { mode: 'profileDefault' },
  },
  transforms: [{ field: 'description_raw', op: 'trim' }],
};

test('meta.ocr tags every non-skipped row with flag "ocr"; low_confidence_ocr only fires on the amount/date tokens, at the 70 threshold', () => {
  const records = [
    { 'Transaction Date': '01/06/2026', Reference: 'NETS PAY', 'Debit Amount': '10.00', 'Credit Amount': '', Balance: '990.00', _amountConfidence: 92, _dateConfidence: 95 },
    { 'Transaction Date': '02/06/2026', Reference: 'SALARY', 'Debit Amount': '', 'Credit Amount': '5000.00', Balance: '5990.00', _amountConfidence: 55, _dateConfidence: 95 },
  ];
  const rows = normalizeRecords(records, dbsVersion, { bank: 'DBS', currency: 'SGD', sourceFile: 'a.pdf', ocr: true });
  assert.ok(rows[0].flags.includes('ocr'));
  assert.ok(!rows[0].flags.includes('low_confidence_ocr'));
  assert.ok(rows[1].flags.includes('ocr'));
  assert.ok(rows[1].flags.includes('low_confidence_ocr'));
});

test('low_confidence_ocr ignores description/type confidence entirely - only _amountConfidence/_dateConfidence matter', () => {
  // A misread merchant name must never flag the row when the amount and date
  // both read back confidently (the old whole-line version was "too
  // eager", 2026-09-16).
  const records = [{ 'Transaction Date': '01/06/2026', Reference: 'NETS PAY', 'Debit Amount': '10.00', 'Credit Amount': '', Balance: '990.00', _amountConfidence: 96, _dateConfidence: 97, _someUnrelatedWordConfidence: 12 }];
  const rows = normalizeRecords(records, dbsVersion, { bank: 'DBS', currency: 'SGD', sourceFile: 'a.pdf', ocr: true });
  assert.ok(!rows[0].flags.includes('low_confidence_ocr'));
});

test('low_confidence_ocr fires when only the date token is below threshold, even with a confident amount', () => {
  const records = [{ 'Transaction Date': '01/06/2026', Reference: 'NETS PAY', 'Debit Amount': '10.00', 'Credit Amount': '', Balance: '990.00', _amountConfidence: 96, _dateConfidence: 40 }];
  const rows = normalizeRecords(records, dbsVersion, { bank: 'DBS', currency: 'SGD', sourceFile: 'a.pdf', ocr: true });
  assert.ok(rows[0].flags.includes('low_confidence_ocr'));
});

test('without meta.ocr, no ocr-related flags appear even if a record happens to carry confidence fields', () => {
  const records = [{ 'Transaction Date': '01/06/2026', Reference: 'NETS PAY', 'Debit Amount': '10.00', 'Credit Amount': '', Balance: '990.00', _amountConfidence: 10, _dateConfidence: 10 }];
  const rows = normalizeRecords(records, dbsVersion, { bank: 'DBS', currency: 'SGD', sourceFile: 'a.csv' });
  assert.ok(!rows[0].flags.includes('ocr'));
  assert.ok(!rows[0].flags.includes('low_confidence_ocr'));
});

test('debit/credit combine into signed amount', () => {
  const records = [
    { 'Transaction Date': '01/06/2026', Reference: 'NETS PAY', 'Debit Amount': '10.00', 'Credit Amount': '', Balance: '990.00' },
    { 'Transaction Date': '02/06/2026', Reference: 'SALARY', 'Debit Amount': '', 'Credit Amount': '5000.00', Balance: '5990.00' },
  ];
  const rows = normalizeRecords(records, dbsVersion, { bank: 'DBS', currency: 'SGD', sourceFile: 'a.csv' });
  assert.equal(rows[0].amount, -1000);
  assert.equal(rows[0].date, '2026-06-01');
  assert.equal(rows[1].amount, 500000);
  assert.equal(rows[0].currency, 'SGD');
  assert.equal(rows[0].balance, 99000);
});

test('unparseable date is flagged', () => {
  const records = [{ 'Transaction Date': 'not a date', Reference: 'X', 'Debit Amount': '1.00', 'Credit Amount': '' }];
  const rows = normalizeRecords(records, dbsVersion, {});
  assert.ok(rows[0].flags.includes('unparseable_date'));
});

test('unparseable date keeps the raw source text so the UI can still show it', () => {
  const records = [{ 'Transaction Date': 'not a date', Reference: 'X', 'Debit Amount': '1.00', 'Credit Amount': '' }];
  const rows = normalizeRecords(records, dbsVersion, {});
  assert.equal(rows[0].date, null);
  assert.equal(rows[0].date_raw, 'not a date');
});

test('description_raw source lists fall back to a second column name when the first is absent (e.g. DBS "Transaction Ref" instead of "Reference")', () => {
  const version = { ...dbsVersion, fields: { ...dbsVersion.fields, description_raw: { source: ['Reference', 'Transaction Ref'], join: ' ' } } };
  const records = [{ 'Transaction Date': '01/06/2026', 'Transaction Ref': 'NETS PAY 8817 SHENG SIONG', 'Debit Amount': '45.20', 'Credit Amount': '', Balance: '4954.80' }];
  const rows = normalizeRecords(records, version, {});
  assert.equal(rows[0].description_raw, 'NETS PAY 8817 SHENG SIONG');
});

test('missing amount is flagged', () => {
  const records = [{ 'Transaction Date': '01/06/2026', Reference: 'X', 'Debit Amount': '', 'Credit Amount': '' }];
  const rows = normalizeRecords(records, dbsVersion, {});
  assert.ok(rows[0].flags.includes('missing_amount'));
});

test('date outside statement period is flagged', () => {
  const records = [{ 'Transaction Date': '01/06/2026', Reference: 'X', 'Debit Amount': '1.00', 'Credit Amount': '' }];
  const rows = normalizeRecords(records, dbsVersion, { period: { startISO: '2026-07-01', endISO: '2026-07-31' } });
  assert.ok(rows[0].flags.includes('date_outside_period'));
});

test('possible duplicate flagged on repeated fingerprint', () => {
  const records = [
    { 'Transaction Date': '01/06/2026', Reference: 'X', 'Debit Amount': '1.00', 'Credit Amount': '' },
    { 'Transaction Date': '01/06/2026', Reference: 'X', 'Debit Amount': '1.00', 'Credit Amount': '' },
  ];
  const rows = normalizeRecords(records, dbsVersion, {});
  assert.deepEqual(rows[0].flags, []);
  assert.ok(rows[1].flags.includes('possible_duplicate'));
});

test('crdr sign convention', () => {
  const version = {
    id: 'v2', dateFormat: 'DD/MM/YYYY', numberFormat: '1,234.56', signConvention: 'crdr',
    fields: { date: { source: 'Date' }, description_raw: { source: ['Desc'] }, amount: { source: 'Amount', crdr: 'CRDR' } },
  };
  const records = [{ Date: '01/06/2026', Desc: 'x', Amount: '10.00', CRDR: 'DR' }];
  const rows = normalizeRecords(records, version, {});
  assert.equal(rows[0].amount, -1000);
});

test('crdr marker overrides positiveIsOut sign convention', () => {
  const version = {
    id: 'v3', dateFormat: 'DD/MM/YYYY', numberFormat: '1,234.56', signConvention: 'positiveIsOut',
    fields: { date: { source: 'Date' }, description_raw: { source: ['Desc'] }, amount: { source: 'Amount' } },
  };
  // positiveIsOut alone would make this -500 (money out); the CR suffix means
  // it must come out +500 (money in) regardless of the profile's convention.
  const records = [{ Date: '01/06/2026', Desc: 'PAYMENT RECEIVED', Amount: '500.00 CR' }];
  const rows = normalizeRecords(records, version, {});
  assert.equal(rows[0].amount, 50000);
});

test('a row whose date and amount both fail to parse is skipped, not flagged', () => {
  const records = [{ 'Transaction Date': 'Current balance: S$100.00', Reference: '', 'Debit Amount': '', 'Credit Amount': '' }];
  const rows = normalizeRecords(records, dbsVersion, {});
  assert.equal(rows[0].skipped, true);
  assert.deepEqual(rows[0].flags, []);
});

test('a row with only the date unparseable (amount present) remains a flagged transaction, not skipped', () => {
  const records = [{ 'Transaction Date': 'not a date', Reference: 'X', 'Debit Amount': '1.00', 'Credit Amount': '' }];
  const rows = normalizeRecords(records, dbsVersion, {});
  assert.equal(rows[0].skipped, false);
  assert.ok(rows[0].flags.includes('unparseable_date'));
});

test('original snapshot preserved', () => {
  const records = [{ 'Transaction Date': '01/06/2026', Reference: 'X', 'Debit Amount': '1.00', 'Credit Amount': '' }];
  const rows = normalizeRecords(records, dbsVersion, {});
  assert.deepEqual(rows[0].original, records[0]);
});

test('record._signUnclear (core/pdf.js grouped rowModel) becomes flag "sign_unclear", independent of meta.ocr', () => {
  const records = [{ 'Transaction Date': '01/06/2026', Reference: 'NETS PAY', 'Debit Amount': '10.00', 'Credit Amount': '', Balance: '990.00', _signUnclear: true }];
  const rows = normalizeRecords(records, dbsVersion, { bank: 'DBS', currency: 'SGD', sourceFile: 'a.pdf' });
  assert.ok(rows[0].flags.includes('sign_unclear'));
});

test('record._signUnclear: false or absent never adds the flag', () => {
  const records = [
    { 'Transaction Date': '01/06/2026', Reference: 'NETS PAY', 'Debit Amount': '10.00', 'Credit Amount': '', Balance: '990.00', _signUnclear: false },
    { 'Transaction Date': '02/06/2026', Reference: 'SALARY', 'Debit Amount': '', 'Credit Amount': '5000.00', Balance: '5990.00' },
  ];
  const rows = normalizeRecords(records, dbsVersion, { bank: 'DBS', currency: 'SGD', sourceFile: 'a.pdf' });
  assert.ok(!rows[0].flags.includes('sign_unclear'));
  assert.ok(!rows[1].flags.includes('sign_unclear'));
});

test('Finding D1: a trailing Total row (CSV/XLSX source) is skipped even though one of its cells parses as a real amount', () => {
  const csvVersion = { ...dbsVersion, csv: { headerRow: 0 } };
  const records = [
    { 'Transaction Date': '01/06/2026', Reference: 'Coffee shop', 'Debit Amount': '5.50', 'Credit Amount': '', Balance: '1000.00' },
    { 'Transaction Date': '02/06/2026', Reference: 'Salary', 'Debit Amount': '', 'Credit Amount': '3000.00', Balance: '4000.00' },
    { 'Transaction Date': 'Total', Reference: '', 'Debit Amount': '5.50', 'Credit Amount': '3000.00', Balance: '' },
  ];
  const rows = normalizeRecords(records, csvVersion, { bank: 'DBS', currency: 'SGD', sourceFile: 'a.csv' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].skipped, false);
  assert.equal(rows[1].skipped, false);
  assert.equal(rows[2].skipped, true);
});

test('Finding D1: the footer-phrase safety net never fires on a PDF-sourced row (no version.csv)', () => {
  const records = [{ 'Transaction Date': 'Total', Reference: '', 'Debit Amount': '5.50', 'Credit Amount': '3000.00', Balance: '' }];
  const rows = normalizeRecords(records, dbsVersion, { bank: 'DBS', currency: 'SGD', sourceFile: 'a.pdf' });
  assert.equal(rows[0].skipped, false);
});

test('item 2: a JPY amount normalizes to whole-yen minor units (no /100), zero-decimal currency end to end', () => {
  const jpyVersion = {
    id: 'v-jpy',
    dateFormat: 'DD/MM/YYYY',
    numberFormat: '1,234.56',
    signConvention: 'signed',
    fields: {
      date: { source: 'Date' },
      description_raw: { source: ['Description'] },
      amount: { source: 'Amount' },
      currency: { mode: 'profileDefault' },
    },
  };
  const records = [{ Date: '01/06/2026', Description: 'Ramen', Amount: '-1,500' }];
  const rows = normalizeRecords(records, jpyVersion, { bank: 'Test', currency: 'JPY', sourceFile: 'a.csv' });
  // decimalsFor('JPY') === 0: the minor unit IS the yen, not a hundredth of it.
  assert.equal(rows[0].amount, -1500);
  assert.equal(rows[0].currency, 'JPY');
});

test('D2 finding 6: a saved profile whose default currency is SGD, reused on rows with a column-detected JPY currency, scales the amount by JPY decimals (0), not the profile default (2)', () => {
  const columnCurrencyVersion = {
    id: 'v-col-currency',
    dateFormat: 'DD/MM/YYYY',
    numberFormat: '1,234.56',
    signConvention: 'signed',
    fields: {
      date: { source: 'Date' },
      description_raw: { source: ['Description'] },
      amount: { source: 'Amount' },
      balance: { source: 'Balance' },
      currency: { mode: 'column', source: 'Currency' },
    },
  };
  const records = [{ Date: '01/06/2026', Description: 'Ramen', Amount: '-15000', Balance: '85000', Currency: 'JPY' }];
  // meta.currency: 'SGD' is this profile's default (e.g. every other version
  // saved against it was SGD) - the row's own JPY column must win.
  const rows = normalizeRecords(records, columnCurrencyVersion, { bank: 'Test', currency: 'SGD', sourceFile: 'a.csv' });
  assert.equal(rows[0].currency, 'JPY');
  // Wrong (pre-fix) behaviour scaled by SGD's 2 decimals: -1,500,000.
  assert.equal(rows[0].amount, -15000);
  assert.equal(rows[0].orig_amount, -15000);
  assert.equal(rows[0].orig_currency, 'JPY');
  assert.equal(rows[0].balance, 85000);
  assert.equal(formatMinor(rows[0].amount, rows[0].currency), '-15000');

  const { rows: converted } = convertToTarget(rows, 'SGD', { JPY_SGD: 0.009 });
  // scale = decimalsFor('SGD') - decimalsFor('JPY') = 2 - 0 = 2 -> x100 after the rate.
  assert.equal(converted[0].converted_amount, Math.round(-15000 * 0.009 * 100));
  assert.equal(converted[0].converted_currency, 'SGD');
});
