import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  editCell, excludeRow, restoreRow, addMissingRow, treatAsTransaction, confirmRow, confirmAllLowConfidence, editRow, applyAmountAlt,
  resolveRow, resolveConfirm, resolveExclude, resolveUseAlt, resolveEdit, undoRow, nextUnresolvedAfter, prevUnresolvedBefore,
} from '../src/ui/rowedit.js';

const baseRow = { row_id: 'f:0', description_raw: 'Amazon.com USD 22.40', amount: -3071, excluded: false, edited: false };

test('editCell stashes the original value on first edit and marks edited', () => {
  const edited = editCell(baseRow, 'description_raw', 'Amazon.com (USD 22.40)');
  assert.equal(edited.description_raw, 'Amazon.com (USD 22.40)');
  assert.equal(edited.edited, true);
  assert.equal(edited.editedFields.description_raw, 'Amazon.com USD 22.40');
  assert.equal(baseRow.edited, false, 'original row untouched');
});

test('editCell does not overwrite the stashed original on a second edit', () => {
  const once = editCell(baseRow, 'description_raw', 'first edit');
  const twice = editCell(once, 'description_raw', 'second edit');
  assert.equal(twice.description_raw, 'second edit');
  assert.equal(twice.editedFields.description_raw, 'Amazon.com USD 22.40');
});

test('excludeRow and restoreRow toggle the excluded flag without mutating input', () => {
  const excluded = excludeRow(baseRow);
  assert.equal(excluded.excluded, true);
  assert.equal(baseRow.excluded, false);
  const restored = restoreRow(excluded);
  assert.equal(restored.excluded, false);
});

test('addMissingRow inserts a flagged manual row right after the given row id', () => {
  const rows = [{ row_id: 'a' }, { row_id: 'b' }, { row_id: 'c' }];
  const next = addMissingRow(rows, 'a', { description_raw: 'Cash withdrawal', amount: -10000 });
  assert.equal(next.length, 4);
  assert.equal(next[1].description_raw, 'Cash withdrawal');
  assert.deepEqual(next[1].flags, ['manually_added']);
  assert.equal(next.map((r) => r.row_id).includes('b'), true);
});

test('addMissingRow appends at the end when afterRowId is null or not found', () => {
  const rows = [{ row_id: 'a' }, { row_id: 'b' }];
  const next = addMissingRow(rows, null, { description_raw: 'New row' });
  assert.equal(next.length, 3);
  assert.equal(next[2].description_raw, 'New row');
});

test('treatAsTransaction promotes a skipped summary line and flags its missing date/amount', () => {
  const skippedRow = { row_id: 's:1', date: null, amount: null, flags: [], skipped: true };
  const promoted = treatAsTransaction(skippedRow);
  assert.equal(promoted.skipped, false);
  assert.deepEqual(promoted.flags, ['unparseable_date', 'missing_amount']);
  assert.equal(skippedRow.skipped, true, 'original row untouched');
});

test('treatAsTransaction does not double-flag a row that already has a real date or amount', () => {
  const skippedRow = { row_id: 's:2', date: '2026-06-01', amount: -500, flags: [], skipped: true };
  const promoted = treatAsTransaction(skippedRow);
  assert.deepEqual(promoted.flags, []);
});

test('confirmRow clears warning flags, keeps provenance-only ones, and marks confirmed', () => {
  const row = { row_id: 'f:1', flags: ['low_confidence_ocr', 'sign_unclear', 'ocr'] };
  const confirmed = confirmRow(row);
  assert.deepEqual(confirmed.flags, ['ocr']);
  assert.equal(confirmed.confirmed, true);
  assert.deepEqual(row.flags, ['low_confidence_ocr', 'sign_unclear', 'ocr'], 'original row untouched');
});

test('confirmAllLowConfidence only touches rows flagged low_confidence_ocr', () => {
  const rows = [
    { row_id: 'a', flags: ['low_confidence_ocr', 'ocr'] },
    { row_id: 'b', flags: ['possible_duplicate'] },
    { row_id: 'c', flags: ['ocr'] },
  ];
  const next = confirmAllLowConfidence(rows);
  assert.equal(next[0].confirmed, true);
  assert.deepEqual(next[0].flags, ['ocr']);
  assert.equal(next[1].confirmed, undefined);
  assert.equal(next[2].confirmed, undefined);
});

test('editRow applies several field edits in one shot and stashes each original once', () => {
  const row = { row_id: 'f:2', date: '2026-06-01', description_raw: 'Coffee', amount: -500 };
  const edited = editRow(row, { date: '2026-06-02', description_raw: 'Coffee shop', amount: undefined });
  assert.equal(edited.date, '2026-06-02');
  assert.equal(edited.description_raw, 'Coffee shop');
  assert.equal(edited.amount, -500, 'undefined field left alone');
  assert.equal(edited.edited, true);
  assert.deepEqual(edited.editedFields, { date: '2026-06-01', description_raw: 'Coffee' });
});

test('applyAmountAlt swaps amount for amount_alt, marks edited, keeps original, clears the flag', () => {
  // normalize.js's real shape: amount is the flagged (OCR-read, decimal-
  // dropped) value, amount_alt is the likely-correct one - 100x smaller in
  // minor units, e.g. amount -17300 (read as 173.00) vs. amount_alt -173
  // (likely 1.73).
  const row = {
    row_id: 'f:0', amount: -17300, amount_alt: -173, currency: 'SGD',
    flags: ['ocr', 'low_confidence_ocr'], low_confidence_hint: 'Amount read as 173 with no decimal point. Likely 1.73. Check against the page.',
    edited: false,
  };
  const fixed = applyAmountAlt(row);
  assert.equal(fixed.amount, -173);
  assert.equal(fixed.edited, true);
  assert.equal(fixed.editedFields.amount, -17300, 'original amount stashed');
  assert.deepEqual(fixed.flags, ['ocr'], 'low_confidence_ocr cleared, other flags kept');
  assert.equal(fixed.low_confidence_hint, null);
  assert.equal(row.edited, false, 'original row untouched');
});

test('applyAmountAlt is a no-op when the row has no amount_alt', () => {
  const row = { row_id: 'f:0', amount: -173, amount_alt: null, flags: ['low_confidence_ocr'] };
  assert.equal(applyAmountAlt(row), row);
});

// --- resolve + undo (item 4) ------------------------------------------------

test('resolveConfirm resolves via confirmRow and pushes an undo snapshot', () => {
  const row = { row_id: 'f:0', flags: ['sign_unclear'], confirmed: false };
  const resolved = resolveConfirm(row);
  assert.deepEqual(resolved.flags, []);
  assert.equal(resolved.confirmed, true);
  assert.equal(resolved._undo.length, 1);
  assert.deepEqual(resolved._undo[0], { row_id: 'f:0', flags: ['sign_unclear'], confirmed: false });
});

test('resolveExclude and resolveUseAlt also push an undo snapshot', () => {
  const excluded = resolveExclude({ row_id: 'a', excluded: false, flags: ['x'] });
  assert.equal(excluded.excluded, true);
  assert.equal(excluded._undo.length, 1);

  const row = { row_id: 'b', amount: -17300, amount_alt: -173, currency: 'SGD', flags: ['ocr', 'low_confidence_ocr'] };
  const fixed = resolveUseAlt(row);
  assert.equal(fixed.amount, -173);
  assert.equal(fixed._undo.length, 1);
});

test('resolveEdit applies the edit and clears warning flags (edit counts as a resolution)', () => {
  const row = { row_id: 'c', date: '2026-06-01', amount: -500, flags: ['possible_duplicate'] };
  const resolved = resolveEdit(row, { date: '2026-06-02' });
  assert.equal(resolved.date, '2026-06-02');
  assert.deepEqual(resolved.flags, []);
  assert.equal(resolved.confirmed, true);
  assert.equal(resolved._undo.length, 1);
});

test('undoRow restores the exact prior state, including flags/edited/excluded, and shrinks the stack', () => {
  const row = { row_id: 'd', flags: ['sign_unclear', 'ocr'], excluded: false, edited: false, editedFields: {} };
  const resolved = resolveConfirm(row);
  const undone = undoRow(resolved);
  assert.deepEqual(undone.flags, ['sign_unclear', 'ocr']);
  assert.equal(undone.excluded, false);
  assert.equal(undone.confirmed, undefined);
  assert.deepEqual(undone._undo, []);
});

test('undoRow is a no-op on a row with nothing to undo', () => {
  const row = { row_id: 'e', flags: [] };
  assert.equal(undoRow(row), row);
});

test('resolveRow supports resolve -> undo -> resolve again as a real stack', () => {
  let row = { row_id: 'f', flags: ['sign_unclear'], excluded: false };
  row = resolveConfirm(row); // looks-right
  row = undoRow(row); // back to flagged
  assert.deepEqual(row.flags, ['sign_unclear']);
  row = resolveExclude(row); // exclude instead
  assert.equal(row.excluded, true);
  assert.equal(row._undo.length, 1);
  row = undoRow(row);
  assert.equal(row.excluded, false);
  assert.deepEqual(row.flags, ['sign_unclear']);
});

// --- next/prev unresolved navigation, with wraparound (item 2/3/4) --------

test('nextUnresolvedAfter wraps around and starts at 0 from "nothing selected" (-1)', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(nextUnresolvedAfter(list, -1), 0);
  assert.equal(nextUnresolvedAfter(list, 0), 1);
  assert.equal(nextUnresolvedAfter(list, 2), 0);
});

test('prevUnresolvedBefore wraps around to the end', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(prevUnresolvedBefore(list, 0), 2);
  assert.equal(prevUnresolvedBefore(list, 1), 0);
  assert.equal(prevUnresolvedBefore(list, -1), 1);
});

test('next/prevUnresolvedAfter return -1 for an empty list', () => {
  assert.equal(nextUnresolvedAfter([], 0), -1);
  assert.equal(prevUnresolvedBefore([], 0), -1);
});

test('nextUnresolvedAfter(remaining, resolvedIndex - 1) lands on the row that took the resolved row\'s place, wrapping at the end', () => {
  // 4 warnings; resolve the one at index 1 -> it's removed, and the row that
  // slides into position 1 (originally index 2) should be selected next.
  const flagged = ['w0', 'w1', 'w2', 'w3'];
  const resolvedIndex = 1;
  const remaining = flagged.filter((_, i) => i !== resolvedIndex);
  const targetIdx = nextUnresolvedAfter(remaining, resolvedIndex - 1);
  assert.equal(remaining[targetIdx], 'w2');

  // Resolving the LAST one wraps back to the first remaining row.
  const resolvedLast = 3;
  const remainingAfterLast = flagged.filter((_, i) => i !== resolvedLast);
  const targetIdx2 = nextUnresolvedAfter(remainingAfterLast, resolvedLast - 1);
  assert.equal(remainingAfterLast[targetIdx2], 'w0');
});
