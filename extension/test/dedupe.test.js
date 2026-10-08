import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, mergeAcrossFiles, bytesEqual, isExactDuplicateFile, sha256Hex, findDuplicateByHash } from '../src/core/dedupe.js';

function row(over) {
  return { account_label: 'acc1', date: '2026-06-01', amount: -1000, currency: 'SGD', description_raw: 'Coffee', ...over };
}

// EXPORT-AND-DUPES rule 3: a cross-file overlap is merged silently ONLY when
// the two files are the same statement arriving twice - same statement type,
// same date range. Every file in a merge test therefore carries that
// identity; a file without it is asking a question, not merging (the pair
// tests at the bottom cover that side).
const JUNE_1 = { startISO: '2026-06-01', endISO: '2026-06-01' };
function sameStatementPair(a, b, meta = { statementType: 'savings', range: JUNE_1 }) {
  return [{ ...meta, ...a }, { ...meta, ...b }];
}

test('fingerprint is stable for identical rows and normalizes description', () => {
  const a = fingerprint(row({ description_raw: 'Coffee  Shop' }));
  const b = fingerprint(row({ description_raw: 'coffee shop' }));
  assert.equal(a, b);
});

// Item 5 (2026-09-20): same root cause as normalize.js's within-file
// possible_duplicate flag - a row with no parsed date (date: null, kept as an
// 'unparseable_date' row upstream, not dropped) must never fingerprint-match
// another such row just because both fall back to the same empty value.
test('fingerprint returns null for a row with no parsed date', () => {
  assert.equal(fingerprint(row({ date: null })), null);
});

test('cross-file merge never merges two rows that both have no parsed date, even with the same account/amount/description', () => {
  const fileA = { sourceFile: 'a.csv', rows: [row({ date: null })] };
  const fileB = { sourceFile: 'b.csv', rows: [row({ date: null })] };
  const { merged, removed } = mergeAcrossFiles([fileA, fileB]);
  assert.equal(merged.length, 2, 'both rows kept - a null date is never proof of a real overlap');
  assert.equal(removed.length, 0);
});

test('within-file duplicates are kept as-is', () => {
  const fileRows = [row(), row()]; // identical, same file
  const { merged, removed } = mergeAcrossFiles([{ sourceFile: 'a.csv', rows: fileRows }]);
  assert.equal(merged.length, 2);
  assert.equal(removed.length, 0);
});

test('cross-file overlap is merged, keeping the max-occurrence file', () => {
  // 2 occurrences in A, 1 in B - the same statement re-exported.
  const files = sameStatementPair({ sourceFile: 'a.csv', rows: [row(), row()] }, { sourceFile: 'b.csv', rows: [row()] });
  const { merged, removed } = mergeAcrossFiles(files);
  assert.equal(merged.length, 2); // kept from fileA
  assert.equal(removed.length, 1); // fileB's copy dropped
});

test('cross-file merge keys off the account, not the profile: two files matched to different profile ids/names for the same account still merge', () => {
  // Simulates the real bug: two different saved profiles ("DBS savings, PDF"
  // and "Northwind Bank savings, Transaction History PDF") both extract the
  // same account's rows. The rows themselves carry no consistent
  // account_label (one file's rows even have it null, e.g. a freshly
  // wizard-mapped file whose meta never got an accountLabel) - only the
  // file-level accountLabel passed into mergeAcrossFiles is trustworthy.
  const sharedRows = () => [
    row({ account_label: null, description_raw: 'Lazada' }),
    row({ account_label: null, description_raw: 'Grab' }),
  ];
  const files = sameStatementPair(
    { sourceFile: 'a.pdf', accountLabel: 'DBS savings ****7890', rows: sharedRows() },
    { sourceFile: 'b.pdf', accountLabel: 'DBS savings ****7890', rows: sharedRows() },
  );
  const { merged, removed } = mergeAcrossFiles(files);
  assert.equal(merged.length, 2);
  assert.equal(removed.length, 2);
});

test('cross-file merge does not collapse different accounts even with identical row content', () => {
  const fileA = { sourceFile: 'a.pdf', accountLabel: 'DBS savings ****7890', rows: [row({ account_label: null })] };
  const fileB = { sourceFile: 'b.pdf', accountLabel: 'UOB savings ****1234', rows: [row({ account_label: null })] };
  const { merged, removed } = mergeAcrossFiles([fileA, fileB]);
  assert.equal(merged.length, 2);
  assert.equal(removed.length, 0);
});

test('non-overlapping rows across files are all kept', () => {
  const fileA = { sourceFile: 'a.csv', rows: [row({ description_raw: 'Coffee' })] };
  const fileB = { sourceFile: 'b.csv', rows: [row({ description_raw: 'Groceries' })] };
  const { merged, removed } = mergeAcrossFiles([fileA, fileB]);
  assert.equal(merged.length, 2);
  assert.equal(removed.length, 0);
});

// Finding 1 (QA 2026-09-16): re-dropping the exact same CSV must be
// captioned "Dropped twice", not treated like an ordinary partial overlap.
// D3 (2026-09-17): a CSV export and a PDF/OCR export of the same statement
// describe the same real transaction with differing description tails (a
// CSV truncation, or an OCR misread character) - these must still merge, and
// the surviving row must be the CSV one.
test('D3: a CSV row and an OCR row of the same transaction merge despite a differing description tail, keeping the CSV version', () => {
  const files = sameStatementPair(
    { sourceFile: 'statement.csv', accountLabel: 'DBS ****7890', ocr: false, rows: [row({ description_raw: 'BAT 2C2*LAZADA Singapore SGP' })] },
    { sourceFile: 'statement.pdf', accountLabel: 'DBS ****7890', ocr: true, rows: [row({ description_raw: 'BAT 2C2*LAZADA Singapore SGP 12SEP 4628-XXXX' })] },
  );
  const { merged, removed } = mergeAcrossFiles(files);
  assert.equal(merged.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(merged[0].description_raw, 'BAT 2C2*LAZADA Singapore SGP');
});

test('D3: an OCR misread character (curly quote for asterisk) still fingerprints the same as the CSV description', () => {
  const files = sameStatementPair(
    { sourceFile: 'statement.csv', accountLabel: 'DBS ****7890', ocr: false, rows: [row({ description_raw: 'SHOPEE SG *8823' })] },
    { sourceFile: 'statement.pdf', accountLabel: 'DBS ****7890', ocr: true, rows: [row({ description_raw: 'SHOPEE SG “8823' })] },
  );
  const { merged, removed } = mergeAcrossFiles(files);
  assert.equal(merged.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(merged[0].description_raw, 'SHOPEE SG *8823');
});

test('bytesEqual: identical vs differing byte buffers, and missing input', () => {
  const a = new Uint8Array([1, 2, 3]).buffer;
  const b = new Uint8Array([1, 2, 3]).buffer;
  const c = new Uint8Array([1, 2, 4]).buffer;
  const d = new Uint8Array([1, 2]).buffer;
  assert.equal(bytesEqual(a, b), true);
  assert.equal(bytesEqual(a, c), false);
  assert.equal(bytesEqual(a, d), false);
  assert.equal(bytesEqual(null, b), false);
  assert.equal(bytesEqual(a, null), false);
});

test('isExactDuplicateFile: only when every row merged away (count === total), by identical bytes or identical file size', () => {
  const bytesX = new Uint8Array([9, 9, 9]).buffer;
  const bytesY = new Uint8Array([9, 9, 9]).buffer;
  const bytesZ = new Uint8Array([1, 1, 1]).buffer;
  // Same bytes, whole file absorbed.
  assert.equal(isExactDuplicateFile({ count: 5, total: 5, bytesA: bytesX, bytesB: bytesY, otherFileTotal: 5 }), true);
  // Different bytes (e.g. re-saved with different encoding) but the same
  // total row count on both sides, and every row absorbed.
  assert.equal(isExactDuplicateFile({ count: 5, total: 5, bytesA: bytesZ, bytesB: bytesY, otherFileTotal: 5 }), true);
  // A partial overlap (not every row merged away) is never an exact duplicate.
  assert.equal(isExactDuplicateFile({ count: 3, total: 5, bytesA: bytesX, bytesB: bytesY, otherFileTotal: 5 }), false);
  // Fully absorbed, but the surviving file has MORE rows: this file is a
  // real subset, not a whole-file duplicate of it.
  assert.equal(isExactDuplicateFile({ count: 5, total: 5, bytesA: bytesZ, bytesB: bytesY, otherFileTotal: 8 }), false);
});

// --- Item B: drop-time duplicate detection by content hash ----------------

test('sha256Hex is stable for identical bytes and differs for different bytes', async () => {
  const a = new TextEncoder().encode('same content').buffer;
  const b = new TextEncoder().encode('same content').buffer;
  const c = new TextEncoder().encode('different content').buffer;
  const [ha, hb, hc] = await Promise.all([sha256Hex(a), sha256Hex(b), sha256Hex(c)]);
  assert.equal(ha, hb);
  assert.notEqual(ha, hc);
  assert.match(ha, /^[0-9a-f]{64}$/);
});

test('findDuplicateByHash finds the file sharing a content hash, or null for none/no hash', () => {
  const files = [{ name: 'a.pdf', contentHash: 'aaa' }, { name: 'b.pdf', contentHash: 'bbb' }];
  assert.equal(findDuplicateByHash(files, 'bbb'), files[1]);
  assert.equal(findDuplicateByHash(files, 'ccc'), null);
  assert.equal(findDuplicateByHash(files, null), null);
  assert.equal(findDuplicateByHash([], 'aaa'), null);
});

// --- EXPORT-AND-DUPES rule 3/4: exact twins merge, near twins ask once per pair ---

test('an exact cross-file twin merges silently whatever the files date ranges or types are', () => {
  const fileA = { sourceFile: 'june.csv', statementType: 'savings', rows: [row()] };
  const fileB = { sourceFile: 'june-july.csv', statementType: 'current', rows: [row()] };
  const { merged, removed, pairs } = mergeAcrossFiles([fileA, fileB]);
  assert.equal(merged.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(pairs.length, 0);
});

test('a near twin (same date and amount, different description) is a decision: both rows kept, one pair raised', () => {
  const fileA = { sourceFile: 'a.csv', rows: [row({ description_raw: 'VISA DEBIT MERCHANT 001' })] };
  const fileB = { sourceFile: 'b.csv', rows: [row({ description_raw: 'MERCHANT001 SINGAPORE' })] };
  const { merged, removed, pairs } = mergeAcrossFiles([fileA, fileB]);
  assert.equal(merged.length, 2, 'nothing is dropped until the user answers');
  assert.equal(removed.length, 0);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].keep.sourceFile, 'a.csv');
  assert.equal(pairs[0].drop.sourceFile, 'b.csv');
});

test('one pair per near key per file pair, even when one file repeats the transaction', () => {
  const fileA = { sourceFile: 'a.csv', rows: [row({ description_raw: 'Coffee A' }), row({ description_raw: 'Coffee A' })] };
  const fileB = { sourceFile: 'b.csv', rows: [row({ description_raw: 'Coffee B' }), row({ description_raw: 'Coffee B' })] };
  const { pairs, merged } = mergeAcrossFiles([fileA, fileB]);
  assert.equal(pairs.length, 1, 'one question about this transaction, not four cards');
  assert.equal(merged.length, 4);
});

test('a pair keeps the CSV/text row and drops the OCR one', () => {
  const pdfFile = { sourceFile: 'statement.pdf', ocr: true, rows: [row({ description_raw: 'GRAB A9PHM SINGAP0RE' })] };
  const csvFile = { sourceFile: 'statement.csv', ocr: false, rows: [row({ description_raw: 'Grab* A-9PHM9C8W Singapore' })] };
  const { pairs } = mergeAcrossFiles([pdfFile, csvFile]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].keep.sourceFile, 'statement.csv');
  assert.equal(pairs[0].drop.sourceFile, 'statement.pdf');
});

test('a pair key is stable across runs, so an answered "Keep both" is never asked again', () => {
  const files = () => [
    { sourceFile: 'a.csv', rows: [row({ description_raw: 'Coffee A' })] },
    { sourceFile: 'b.csv', rows: [row({ description_raw: 'Coffee B' })] },
  ];
  assert.equal(mergeAcrossFiles(files()).pairs[0].key, mergeAcrossFiles(files()).pairs[0].key);
});

