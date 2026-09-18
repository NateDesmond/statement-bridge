import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignRowsToPageLines } from '../src/ui/review.js';

// A grouped-rowModel PDF row-to-page/y anchor map (item 4): rows are matched,
// in source order, to the amount-ending lines in each page's own lines, in
// reading order - the same order extractGroupedRows produces rows in, gated
// the same way (nothing before the first date-group line, ignoreLinePatterns
// dropped) so a preamble balance figure never eats a row's slot.

function line(y, str) { return { y, items: [{ str, x: 0, y }] }; }

test('alignRowsToPageLines maps rows in order to amount-shaped lines after a date group opens', () => {
  const rows = [
    { row_id: 'a', source_line: 0 },
    { row_id: 'b', source_line: 1 },
    { row_id: 'c', source_line: 2 },
  ];
  const page1 = [line(720, 'Yesterday, 15 Sep 2026'), line(700, 'Coffee Shop -4.50'), line(680, 'Fund Transfer')];
  const page2 = [line(700, 'Groceries +120.00'), line(680, 'Petrol -60.00')];
  const anchors = alignRowsToPageLines(rows, [page1, page2]);
  assert.deepEqual(anchors.get('a'), { page: 1, y: 700 });
  assert.deepEqual(anchors.get('b'), { page: 2, y: 700 });
  assert.deepEqual(anchors.get('c'), { page: 2, y: 680 });
});

test('alignRowsToPageLines skips skipped rows and sorts by source_line', () => {
  const rows = [
    { row_id: 'b', source_line: 1, skipped: false },
    { row_id: 'skip', source_line: 0, skipped: true },
    { row_id: 'a', source_line: 0.5, skipped: false },
  ];
  const page1 = [line(720, 'Yesterday, 15 Sep 2026'), line(700, 'Petrol -60.00'), line(680, 'Groceries +120.00')];
  const anchors = alignRowsToPageLines(rows, [page1]);
  assert.equal(anchors.has('skip'), false);
  assert.deepEqual(anchors.get('a'), { page: 1, y: 700 });
  assert.deepEqual(anchors.get('b'), { page: 1, y: 680 });
});

test('alignRowsToPageLines returns an empty map when no date group has opened', () => {
  const anchors = alignRowsToPageLines([{ row_id: 'a', source_line: 0 }], [[line(700, 'Coffee Shop -4.50')]]);
  assert.equal(anchors.size, 0);
});

test('alignRowsToPageLines never lets a preamble balance line eat a row slot (real regression: 2026-09-16)', () => {
  const rows = [
    { row_id: 'a', source_line: 0 },
    { row_id: 'b', source_line: 1 },
  ];
  const page1 = [
    line(760, 'Available Balance: SGD 8,214.12'), // looks amount-shaped, but before any date group
    line(740, 'Yesterday, 15 Sep 2026'),
    line(720, 'BAT 2C2*LAZADA Singapore SGD -20.83'),
    line(700, 'Point-of-Sale Transaction'),
    line(680, 'GIRO SALARY CREDIT ACME PTE LTD SGD +4,200.00'),
  ];
  const anchors = alignRowsToPageLines(rows, [page1], { ignoreLinePatterns: [] });
  assert.deepEqual(anchors.get('a'), { page: 1, y: 720 });
  assert.deepEqual(anchors.get('b'), { page: 1, y: 680 });
});

test('alignRowsToPageLines drops ignoreLinePatterns lines even after a date group opens', () => {
  const rows = [{ row_id: 'a', source_line: 0 }];
  const page1 = [
    line(740, 'Yesterday, 15 Sep 2026'),
    line(720, 'Page 1 of 2'),
    line(700, 'Coffee Shop -4.50'),
  ];
  const anchors = alignRowsToPageLines(rows, [page1], { ignoreLinePatterns: ['^Page \\d+ of \\d+$'] });
  assert.deepEqual(anchors.get('a'), { page: 1, y: 700 });
});
