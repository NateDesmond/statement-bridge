import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreHeader, suggestMapping, suggestHeaderRow, suggestDateFormat,
  suggestSignConvention, suggestNumberFormat,
  detectBankName, detectStatementType, detectCurrency, detectCountry,
  detectCrDrInSamples, suggestHeaderRowConfidence, suggestFooterRows,
} from '../src/core/suggest.js';

test('scoreHeader matches exact known term', () => {
  assert.equal(scoreHeader('Transaction Date', 'date'), 1);
  assert.equal(scoreHeader('Withdrawal', 'debit'), 1);
});

test('scoreHeader recognises Chinese and Malay terms', () => {
  assert.ok(scoreHeader('交易日期', 'date') > 0);
  assert.ok(scoreHeader('Tarikh Urus Niaga', 'date') > 0);
});

// Corpus fix (2026-09-18): the formal zh debit/credit terms and a few common
// zh/ms description/amount/balance words had no dictionary entry at all,
// even though the plain/less-formal term for the SAME field already did
// (e.g. debit had "借方金额" missing while credit had no formal term at all).
test('scoreHeader recognises the formal zh debit/credit amount terms', () => {
  assert.equal(scoreHeader('借方金额', 'debit'), 1);
  assert.equal(scoreHeader('贷方金额', 'credit'), 1);
});

test('scoreHeader recognises zh/ms description, amount and balance synonyms', () => {
  assert.equal(scoreHeader('备注', 'description_raw'), 1);
  assert.equal(scoreHeader('Catatan', 'description_raw'), 1);
  assert.equal(scoreHeader('净额', 'amount'), 1);
  assert.equal(scoreHeader('Amaun Bersih', 'amount'), 1);
  assert.equal(scoreHeader('结余', 'balance'), 1);
  assert.equal(scoreHeader('Bayaran Keluar', 'debit'), 1);
  assert.equal(scoreHeader('Bayaran Masuk', 'credit'), 1);
});

// 2026-09-18: HEADER_DICTIONARY extended to de/fr/es/ja/it/nl/pt/ko (see
// docs/KNOWN-GAPS.md's now-resolved "Unsupported header languages" gap).
test('scoreHeader recognises German, French and Spanish bank-specific terms', () => {
  assert.equal(scoreHeader('Buchungstag', 'date'), 1);
  assert.equal(scoreHeader('Wertstellung', 'date'), 1);
  assert.equal(scoreHeader('Verwendungszweck', 'description_raw'), 1);
  assert.equal(scoreHeader('Soll', 'debit'), 1);
  assert.equal(scoreHeader('Haben', 'credit'), 1);
  assert.equal(scoreHeader('Saldo', 'balance'), 1);
  assert.equal(scoreHeader('Date opération', 'date'), 1);
  assert.equal(scoreHeader('Date valeur', 'date'), 1);
  assert.equal(scoreHeader('Libellé', 'description_raw'), 1);
  assert.equal(scoreHeader('Débit', 'debit'), 1);
  assert.equal(scoreHeader('Crédit', 'credit'), 1);
  assert.equal(scoreHeader('Solde', 'balance'), 1);
  assert.equal(scoreHeader('Montant', 'amount'), 1);
  assert.equal(scoreHeader('Fecha valor', 'date'), 1);
  assert.equal(scoreHeader('Concepto', 'description_raw'), 1);
  assert.equal(scoreHeader('Cargo', 'debit'), 1);
  assert.equal(scoreHeader('Abono', 'credit'), 1);
  assert.equal(scoreHeader('Importe', 'amount'), 1);
  assert.equal(scoreHeader('Saldo', 'balance'), 1);
});

test('scoreHeader recognises Japanese and Korean bank header terms', () => {
  assert.equal(scoreHeader('日付', 'date'), 1);
  assert.equal(scoreHeader('取引日', 'date'), 1);
  assert.equal(scoreHeader('摘要', 'description_raw'), 1);
  assert.equal(scoreHeader('出金', 'debit'), 1);
  assert.equal(scoreHeader('入金', 'credit'), 1);
  assert.equal(scoreHeader('残高', 'balance'), 1);
  assert.equal(scoreHeader('金額', 'amount'), 1);
  assert.equal(scoreHeader('거래일', 'date'), 1);
  assert.equal(scoreHeader('적요', 'description_raw'), 1);
  assert.equal(scoreHeader('출금', 'debit'), 1);
  assert.equal(scoreHeader('입금', 'credit'), 1);
  assert.equal(scoreHeader('잔액', 'balance'), 1);
});

test('scoreHeader recognises Italian and Dutch bank header terms', () => {
  assert.equal(scoreHeader('Data contabile', 'date'), 1);
  assert.equal(scoreHeader('Data valuta', 'date'), 1);
  assert.equal(scoreHeader('Descrizione', 'description_raw'), 1);
  assert.equal(scoreHeader('Dare', 'debit'), 1);
  assert.equal(scoreHeader('Avere', 'credit'), 1);
  assert.equal(scoreHeader('Importo', 'amount'), 1);
  assert.equal(scoreHeader('Saldo', 'balance'), 1);
  assert.equal(scoreHeader('Datum', 'date'), 1);
  assert.equal(scoreHeader('Omschrijving', 'description_raw'), 1);
  assert.equal(scoreHeader('Af', 'debit'), 1);
  assert.equal(scoreHeader('Bij', 'credit'), 1);
  assert.equal(scoreHeader('Bedrag', 'amount'), 1);
});

test('scoreHeader recognises Portuguese bank header terms', () => {
  assert.equal(scoreHeader('Data', 'date'), 1);
  assert.equal(scoreHeader('Descrição', 'description_raw'), 1);
  assert.equal(scoreHeader('Débito', 'debit'), 1);
  assert.equal(scoreHeader('Crédito', 'credit'), 1);
  assert.equal(scoreHeader('Valor', 'amount'), 1);
  assert.equal(scoreHeader('Saldo', 'balance'), 1);
});

test('scoreHeader matches accented headers accent-insensitively and case-insensitively', () => {
  assert.equal(scoreHeader('BUCHUNGSTAG', 'date'), 1);
  assert.equal(scoreHeader('buchungstag', 'date'), 1);
  assert.equal(scoreHeader('DESCRIÇÃO', 'description_raw'), 1);
  assert.equal(scoreHeader('descricao', 'description_raw'), 1);
  assert.equal(scoreHeader('Währung', 'currency'), 1);
  assert.equal(scoreHeader('wahrung', 'currency'), 1);
});

test('scoreHeader returns 0 for unrelated header', () => {
  assert.equal(scoreHeader('Zebra Column', 'date'), 0);
});

test('suggestMapping proposes date/debit/credit from headers + shapes', () => {
  const header = ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount'];
  const rows = [
    ['01/06/2026', 'NETS', '10.00', ''],
    ['02/06/2026', 'SALARY', '', '5000.00'],
  ];
  const suggestions = suggestMapping(header, rows);
  const byField = Object.fromEntries(suggestions.map((s) => [s.field, s]));
  assert.equal(byField.date.source, 'Transaction Date');
  assert.equal(byField.debit.source, 'Debit Amount');
  assert.equal(byField.credit.source, 'Credit Amount');
  assert.ok(byField.date.confidence > 0.7);
});

test('suggestHeaderRow finds first wide row followed by a same-width row', () => {
  const grid = [
    ['Account Details For: John'],
    [''],
    ['Date', 'Ref', 'Amount'],
    ['01/06/2026', 'X', '10.00'],
  ];
  assert.equal(suggestHeaderRow(grid), 2);
});

test('suggestHeaderRow returns -1 when nothing matches', () => {
  assert.equal(suggestHeaderRow([['a'], ['b']]), -1);
});

test('suggestDateFormat detects ISO', () => {
  assert.equal(suggestDateFormat(['2026-06-01', '2026-06-02']), 'YYYY-MM-DD');
});

test('suggestDateFormat detects day-first from an over-12 day', () => {
  assert.equal(suggestDateFormat(['25/12/2026', '01/02/2026']), 'DD/MM/YYYY');
});

test('suggestDateFormat detects month-first from an over-12 second slot', () => {
  assert.equal(suggestDateFormat(['12/25/2026', '01/02/2026']), 'MM/DD/YYYY');
});

test('suggestSignConvention picks debitCredit when both columns present', () => {
  const mapping = [{ field: 'debit', source: 'Debit' }, { field: 'credit', source: 'Credit' }];
  assert.equal(suggestSignConvention(mapping), 'debitCredit');
});

test('suggestNumberFormat detects European style', () => {
  assert.equal(suggestNumberFormat(['1.234,56', '2.000,00']), '1.234,56');
});

test('suggestNumberFormat defaults to US style', () => {
  assert.equal(suggestNumberFormat(['1,234.56']), '1,234.56');
});

test('detectBankName finds a known bank in preamble text', () => {
  assert.equal(detectBankName('DBS Bank Ltd\nAccount Details For: John', 'export.csv'), 'DBS');
});

test('detectBankName falls back to filename', () => {
  assert.equal(detectBankName('', 'uob_statement.csv'), 'UOB');
});

test('detectBankName falls back to first capitalised "...Bank" phrase', () => {
  assert.equal(detectBankName('Some Regional Bank of Testing statement', ''), 'Some Regional Bank');
});

test('detectBankName returns empty when nothing matches', () => {
  assert.equal(detectBankName('no bank mentioned here', 'file.csv'), '');
});

test('detectStatementType recognises credit card markers', () => {
  assert.equal(detectStatementType('Your Credit Limit is $5,000. Minimum Payment due.'), 'credit_card');
});

test('detectStatementType returns empty (a real caller falls back to savings itself) when the text has no signal', () => {
  assert.equal(detectStatementType('Account Details For: John, Balance Brought Forward'), '');
});

test('detectStatementType recognises a current account', () => {
  assert.equal(detectStatementType('Current Account statement'), 'current');
});

test('detectCurrency finds an ISO code', () => {
  assert.equal(detectCurrency('Amount (SGD)'), 'SGD');
});

test('detectCurrency finds a symbol', () => {
  assert.equal(detectCurrency('Balance: S$1,234.56'), 'SGD');
});

test('detectCurrency returns empty when nothing found', () => {
  assert.equal(detectCurrency('no currency here'), '');
});

test('detectCountry prefers bank over currency', () => {
  assert.equal(detectCountry('DBS', 'USD'), 'Singapore');
});

test('detectCountry falls back to currency', () => {
  assert.equal(detectCountry('', 'GBP'), 'United Kingdom');
});

test('detectCrDrInSamples finds a trailing CR/DR marker', () => {
  assert.equal(detectCrDrInSamples(['120.00 DR', '50.00 CR']), true);
  assert.equal(detectCrDrInSamples(['120.00', '50.00']), false);
});

test('suggestHeaderRowConfidence is high for a text header followed by a same-width data row', () => {
  const grid = [['Date', 'Description', 'Amount'], ['01/06/2026', 'X', '10.00']];
  assert.ok(suggestHeaderRowConfidence(grid, 0) > 0.9);
});

test('suggestHeaderRowConfidence is 0 for a negative index', () => {
  assert.equal(suggestHeaderRowConfidence([['a']], -1), 0);
});

test('Finding D1: suggestFooterRows finds a trailing Total row with fewer filled cells than the header', () => {
  const grid = [
    ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount', 'Balance'],
    ['01/06/2026', 'Coffee shop', '5.50', '', '1000.00'],
    ['02/06/2026', 'Salary', '', '3000.00', '4000.00'],
    ['Total', '', '5.50', '3000.00', ''],
  ];
  assert.deepEqual(suggestFooterRows(grid, 0), [3]);
});

test('Finding D1: suggestFooterRows catches a full-width row whose first cell starts with a footer keyword', () => {
  const grid = [
    ['Date', 'Description', 'Amount'],
    ['01/06/2026', 'Coffee', '-5.50'],
    ['Sub-total', 'for June', '-5.50'],
  ];
  assert.deepEqual(suggestFooterRows(grid, 0), [2]);
});

test('Finding D1: suggestFooterRows never marks a real transaction row, and stops at the first non-footer row scanning up', () => {
  const grid = [
    ['Date', 'Description', 'Amount'],
    ['01/06/2026', 'Coffee', '-5.50'],
    ['02/06/2026', 'Salary', '3000.00'],
  ];
  assert.deepEqual(suggestFooterRows(grid, 0), []);
});
