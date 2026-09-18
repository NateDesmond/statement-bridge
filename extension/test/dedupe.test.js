import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, mergeAcrossFiles, bytesEqual, isExactDuplicateFile, sha256Hex, findDuplicateByHash } from '../src/core/dedupe.js';

function row(over) {
  return { account_label: 'acc1', date: '2026-06-01', amount: -1000, currency: 'SGD', description_raw: 'Coffee', ...over };
}

test('fingerprint is stable for identical rows and normalizes description', () => {
  const a = fingerprint(row({ description_raw: 'Coffee  Shop' }));
  const b = fingerprint(row({ description_raw: 'coffee shop' }));
  assert.equal(a, b);
});

test('within-file duplicates are kept as-is', () => {
  const fileRows = [row(), row()]; // identical, same file
  const { merged, removed } = mergeAcrossFiles([{ sourceFile: 'a.csv', rows: fileRows }]);
  assert.equal(merged.length, 2);
  assert.equal(removed.length, 0);
});

test('cross-file overlap is merged, keeping the max-occurrence file', () => {
  const fileA = { sourceFile: 'a.csv', rows: [row(), row()] }; // 2 occurrences
  const fileB = { sourceFile: 'b.csv', rows: [row()] }; // 1 occurrence, overlaps with A
  const { merged, removed } = mergeAcrossFiles([fileA, fileB]);
  assert.equal(merged.length, 2); // kept from fileA
  assert.equal(removed.length, 1); // fileB's copy dropped
});

test('cross-file merge keys off the account, not the profile: two files matched to different profile ids/names for the same account still merge', () => {
  // Simulates the real bug: a user-saved profile ("DBS savings, PDF") and a
  // builtin one ("Northwind Bank savings, Transaction History PDF") both extract the
  // same account's rows. The rows themselves carry no consistent
  // account_label (one file's rows even have it null, e.g. a freshly
  // wizard-mapped file whose meta never got an accountLabel) - only the
  // file-level accountLabel passed into mergeAcrossFiles is trustworthy.
  const sharedRows = () => [
    row({ account_label: null, description_raw: 'Lazada' }),
    row({ account_label: null, description_raw: 'Grab' }),
  ];
  const fileA = { sourceFile: 'a.pdf', accountLabel: 'DBS savings ****7890', rows: sharedRows() };
  const fileB = { sourceFile: 'b.pdf', accountLabel: 'DBS savings ****7890', rows: sharedRows() };
  const { merged, removed } = mergeAcrossFiles([fileA, fileB]);
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
  const csvFile = {
    sourceFile: 'statement.csv', accountLabel: 'DBS ****7890', ocr: false,
    rows: [row({ description_raw: 'BAT 2C2*LAZADA Singapore SGP' })],
  };
  const pdfFile = {
    sourceFile: 'statement.pdf', accountLabel: 'DBS ****7890', ocr: true,
    rows: [row({ description_raw: 'BAT 2C2*LAZADA Singapore SGP 12SEP 4628-XXXX' })],
  };
  const { merged, removed } = mergeAcrossFiles([csvFile, pdfFile]);
  assert.equal(merged.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(merged[0].description_raw, 'BAT 2C2*LAZADA Singapore SGP');
});

test('D3: an OCR misread character (curly quote for asterisk) still fingerprints the same as the CSV description', () => {
  const csvFile = { sourceFile: 'statement.csv', accountLabel: 'DBS ****7890', ocr: false, rows: [row({ description_raw: 'SHOPEE SG *8823' })] };
  const pdfFile = { sourceFile: 'statement.pdf', accountLabel: 'DBS ****7890', ocr: true, rows: [row({ description_raw: 'SHOPEE SG “8823' })] };
  const { merged, removed } = mergeAcrossFiles([csvFile, pdfFile]);
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
