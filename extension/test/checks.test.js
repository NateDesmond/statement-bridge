import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceCheck, countCheck, countCheckLabel, countCheckGrouped, groupedCountLabel, fileSummary, flagLabel, rowFlagLabel, diffGroupedExtraction, tagUnmatchedGroupedRows } from '../src/core/checks.js';
import { groupItemsIntoLines, extractGroupedRows } from '../src/core/pdf.js';

test('balanceCheck reconciles a clean sequence', () => {
  const rows = [
    { row_id: '1', amount: -1000, balance: 99000 },
    { row_id: '2', amount: 500000, balance: 599000 },
  ];
  const result = balanceCheck(rows);
  assert.equal(result.opening, 100000);
  assert.equal(result.closing, 599000);
  assert.equal(result.total, 499000);
  assert.equal(result.reconciles, true);
  assert.equal(result.firstFailingRow, null);
});

test('balanceCheck finds first failing row', () => {
  const rows = [
    { row_id: '1', amount: -1000, balance: 99000 },
    { row_id: '2', amount: 500000, balance: 999999 }, // wrong
  ];
  const result = balanceCheck(rows);
  assert.ok(result.firstFailingRow);
  assert.equal(result.firstFailingRow.row_id, '2');
});

test('balanceCheck points at a phantom row (no stated balance) that broke the total', () => {
  // A footer/total row that slipped past footer detection: no balance of its
  // own, so the per-row loop never flags it, but it throws off opening+total.
  const rows = [
    { row_id: '1', amount: -1000, balance: 99000 },
    { row_id: '2', amount: 500000, balance: 599000 },
    { row_id: 'phantom', amount: -520000, balance: null },
  ];
  const result = balanceCheck(rows);
  assert.equal(result.reconciles, false);
  assert.ok(result.firstFailingRow);
  assert.equal(result.firstFailingRow.row_id, 'phantom');
});

test('countCheck compares date-leading source lines to extracted rows', () => {
  const text = '01/06/2026,a,b\n02/06/2026,c,d\nsome continuation line\n03/06/2026,e,f';
  const result = countCheck(text, 3);
  assert.equal(result.sourceLines, 3);
  assert.equal(result.matches, true);
});

test('countCheck also recognizes day-month-name-year dates, quoted CSV style (DBS\'s real export)', () => {
  const text = '"15 Sep 2026","","POS","..."\n"14 Sep 2026","","POS","..."\nnot a date line\n"12 Sep 2026","","POS","..."';
  const result = countCheck(text, 3);
  assert.equal(result.sourceLines, 3);
  assert.equal(result.matches, true);
});

test('countCheck also recognizes a "DD MMM" date with no year at all (summit_card_sample.pdf\'s columns-model date column)', () => {
  const text = ['15 Sep   NETS PAY   -20.83', '14 Sep   SALARY   +5000.00', 'not a date line'].join('\n');
  const result = countCheck(text, 2);
  assert.equal(result.sourceLines, 2, 'a year-less "DD MMM" date must still count as a date-leading line');
  assert.equal(result.matches, true);
});

test('countCheck reports mismatch', () => {
  const text = '01/06/2026,a\n02/06/2026,b\n03/06/2026,c';
  const result = countCheck(text, 2);
  assert.equal(result.matches, false);
  assert.equal(result.diff, -1);
});

test('fileSummary computes date range and per-currency in/out', () => {
  const rows = [
    { date: '2026-06-01', amount: -1000, currency: 'SGD', excluded: false },
    { date: '2026-06-15', amount: 500000, currency: 'SGD', excluded: false },
    { date: '2026-06-20', amount: -2000, currency: 'USD', excluded: false },
    { date: '2026-06-25', amount: 100, currency: 'SGD', excluded: true },
  ];
  const summary = fileSummary(rows);
  assert.equal(summary.rowCount, 3);
  assert.deepEqual(summary.dateRange, { start: '2026-06-01', end: '2026-06-20' });
  assert.equal(summary.byCurrency.SGD.in, 500000);
  assert.equal(summary.byCurrency.SGD.out, 1000);
  assert.equal(summary.byCurrency.USD.out, 2000);
});

test('fileSummary excludes skipped non-transaction lines from the row count and totals', () => {
  const rows = [
    { date: '2026-06-01', amount: -1000, currency: 'SGD', excluded: false, skipped: false },
    { date: null, amount: null, currency: null, excluded: false, skipped: true },
  ];
  const summary = fileSummary(rows);
  assert.equal(summary.rowCount, 1);
});

test('countCheckGrouped matches when every amount-ended line was extracted', () => {
  const text = [
    '15 Sep 2026',
    'BAT 2C2*LAZADA Singapore SGP SGD - 20.83',
    'Point-of-Sale Transaction - POS',
    'GIRO SALARY CREDIT ACME PTE LTD SGD + 4,200.00',
    'Advice - ADV',
  ].join('\n');
  const result = countCheckGrouped(text, 2);
  assert.equal(result.amountLines, 2);
  assert.equal(result.extracted, 2);
  assert.equal(result.matches, true);
  assert.equal(result.diff, 0);
});

test('countCheckGrouped flags a real row OCR failed to extract (root-caused 2026-09-16: a dropped "+" glyph)', () => {
  const text = [
    '11 Sep 2026',
    'BAT 2C2*LAZADA Singapore SGP SGD 11.63', // note: no sign at all, but still an amount-shaped line
    'Point-of-Sale Transaction - POS',
  ].join('\n');
  // Simulates the old, mandatory-sign extractor: it found 0 rows here even
  // though the raw text clearly has one amount-ended line.
  const result = countCheckGrouped(text, 0);
  assert.equal(result.amountLines, 1);
  assert.equal(result.extracted, 0);
  assert.equal(result.matches, false);
  assert.equal(result.diff, -1);
  assert.match(result.explanation, /not extracted/);
});

test('countCheckGrouped ignores non-amount lines (date groups, type lines, footers) entirely', () => {
  const text = [
    '15 Sep 2026',
    'Point-of-Sale Transaction - POS',
    'Page 1 of 3',
    'Available Balance Ledger Balance Transactions as of:',
    'SGD 33,889.56 SGD 34,031.70 16 Sep 2026',
  ].join('\n');
  const result = countCheckGrouped(text, 0);
  assert.equal(result.amountLines, 0);
  assert.equal(result.matches, true);
});

test('countCheckGrouped never counts a preamble balance line before the first date group (regression 2026-09-16)', () => {
  const text = [
    'DBS Multiplier Account',
    'Account No: 123-4-567890',
    'Available Balance: SGD 8,214.12   Ledger Balance: SGD 8,214.12',
    'Transaction History',
    'Yesterday, 15 Sep 2026',
    'BAT 2C2*LAZADA Singapore SGP 12SEP 4628-XXXX SGD - 20.83',
    'Point-of-Sale Transaction - POS',
    'GIRO SALARY CREDIT ACME PTE LTD SGD + 4,200.00',
    'Advice - ADV',
    'Monday, 14 Sep 2026',
    'NTUC FAIRPRICE FINEST SGP SGD - 48.20',
    'Point-of-Sale Transaction - POS',
    '12 Sep 2026',
    'GRAB* A-1928374 SINGAPORE SG SGD - 14.60',
    'Point-of-Sale Transaction - POS',
    'SHOPEE SG "8823" SGD - 216.30',
    'Point-of-Sale Transaction - POS',
    'End of Transaction History',
  ].join('\n');
  const result = countCheckGrouped(text, 5);
  assert.equal(result.amountLines, 5, 'the preamble balance line must not be counted as a 6th amount line');
  assert.equal(result.extracted, 5);
  assert.equal(result.matches, true);
  assert.equal(result.diff, 0);
});

test('countCheckGrouped drops pdfConfig.ignoreLinePatterns lines too, same as extraction', () => {
  const text = [
    '15 Sep 2026',
    'MERCHANT SGD - 20.83',
    'Page 1 of 2',
    'Available Balance: SGD 100.00',
  ].join('\n');
  const result = countCheckGrouped(text, 1, { ignoreLinePatterns: ['^Page \\d+ of \\d+$', 'Available Balance'] });
  assert.equal(result.amountLines, 1);
  assert.equal(result.matches, true);
});

test('countCheckGrouped accepts either a rows array or a plain count', () => {
  const text = 'MERCHANT SGD - 20.83';
  const rows = [{ amount: -2083 }];
  assert.equal(countCheckGrouped(text, rows).extracted, 1);
  assert.equal(countCheckGrouped(text, 1).extracted, 1);
});

test('groupedCountLabel: item 5, three tiers - exact match (green), small gap <=5% (neutral, explanatory), large gap (red, offers Update mapping)', () => {
  const exact = groupedCountLabel(31, 31, 0, true);
  assert.deepEqual(exact, { tone: 'ok', text: '31 rows read, 31 amount lines found', showUpdateMappingLink: false });

  const oneAmount = groupedCountLabel(1, 1, 0, true);
  assert.equal(oneAmount.text, '1 rows read, 1 amount line found');

  // 6 of 208 = ~2.9%, within the 5% "normal for text recognition" band.
  const smallGap = groupedCountLabel(208, 202, 6, false);
  assert.equal(smallGap.tone, 'neutral');
  assert.equal(smallGap.showUpdateMappingLink, false);
  assert.equal(smallGap.text, '208 rows read, 202 amount lines found in the page text. Small gaps are normal for text recognition. 6 rows could not be matched to a line, check them.');

  // 29 vs 27 real transactions (diff -2 -> gap 2) is a bigger fraction (>5%)
  // of a small file - a real mismatch, red, with an escape hatch.
  const bigGap = groupedCountLabel(29, 27, -2, false);
  assert.equal(bigGap.tone, 'fail');
  assert.equal(bigGap.showUpdateMappingLink, true);
  assert.equal(bigGap.text, '29 rows read, 27 amount lines found in the page text (diff -2).');
});

test('countCheckLabel: same "N rows read, N ... found" phrasing/tones as groupedCountLabel, for a CSV/columns-model date-led-line count', () => {
  const exact = countCheckLabel(4, 4, 0, true);
  assert.deepEqual(exact, { tone: 'ok', text: '4 rows read, 4 date lines found', showUpdateMappingLink: false });

  const oneLine = countCheckLabel(1, 1, 0, true);
  assert.equal(oneLine.text, '1 rows read, 1 date line found');

  const explained = countCheckLabel(5, 4, 1, false, '1 skipped summary line');
  assert.equal(explained.tone, 'neutral');
  assert.equal(explained.text, '5 rows read, 4 date lines found (1 skipped summary line).');

  const unexplained = countCheckLabel(6, 4, 2, false);
  assert.equal(unexplained.tone, 'fail');
  assert.equal(unexplained.text, '6 rows read, 4 date lines found (diff 2).');
});

// Each merchant name and its amount share one y (one visual line, two
// x-positions), same as a real column layout - groupItemsIntoLines merges
// them into a single line object, so this page has 4 lines total: the date
// group plus 3 amount-ending lines.
function threeAmountLinesPage() {
  return [groupItemsIntoLines([
    { str: '15 Sep 2026', x: 40, y: 700 },
    { str: 'MERCHANT ONE', x: 40, y: 686 }, { str: 'SGD 20.00', x: 400, y: 686 },
    { str: 'MERCHANT TWO', x: 40, y: 672 }, { str: 'SGD 30.00', x: 400, y: 672 },
    { str: 'MERCHANT THREE', x: 40, y: 658 }, { str: 'SGD 40.00', x: 400, y: 658 },
  ])];
}

test('item 6: diffGroupedExtraction reports a missed line when there are fewer rows than counted amount lines', () => {
  const pagesLines = threeAmountLinesPage();
  const rows = [
    { row_id: 'r1', skipped: false, source_line: 0 },
    { row_id: 'r2', skipped: false, source_line: 1 },
  ];
  const { unmatchedRowIds, missedLines } = diffGroupedExtraction(rows, pagesLines);
  assert.equal(unmatchedRowIds.size, 0, 'both rows matched a counted line');
  assert.equal(missedLines.length, 1);
  assert.deepEqual(missedLines[0], { page: 1, lineNumber: 4, text: 'MERCHANT THREE SGD 40.00' });
});

test('item 6: diffGroupedExtraction flags a row that has no counted line left to match, when there are more rows than lines', () => {
  const pagesLines = threeAmountLinesPage();
  const rows = [
    { row_id: 'r1', skipped: false, source_line: 0 },
    { row_id: 'r2', skipped: false, source_line: 1 },
    { row_id: 'r3', skipped: false, source_line: 2 },
    { row_id: 'r4-manual', skipped: false, source_line: 3 }, // e.g. a manually-added row, one past the last real line
  ];
  const { unmatchedRowIds, missedLines } = diffGroupedExtraction(rows, pagesLines);
  assert.deepEqual([...unmatchedRowIds], ['r4-manual']);
  assert.equal(missedLines.length, 0);
});

test('item 6: diffGroupedExtraction never flags a skipped row and ignores rows before the first date group', () => {
  const pagesLines = threeAmountLinesPage();
  const rows = [
    { row_id: 'skip1', skipped: true, source_line: -1 },
    { row_id: 'r1', skipped: false, source_line: 0 },
  ];
  const { unmatchedRowIds } = diffGroupedExtraction(rows, pagesLines);
  assert.ok(!unmatchedRowIds.has('skip1'));
});

test('item 6: tagUnmatchedGroupedRows mutates flags in place and stashes missedLines on the rows array', () => {
  const pagesLines = threeAmountLinesPage();
  const rows = [
    { row_id: 'r1', skipped: false, source_line: 0, flags: [] },
    { row_id: 'r2', skipped: false, source_line: 1, flags: [] },
  ];
  const result = tagUnmatchedGroupedRows(rows, pagesLines);
  assert.equal(result, rows, 'returns the same array it mutated');
  assert.deepEqual(rows[0].flags, []);
  assert.deepEqual(rows[1].flags, []);
  assert.equal(rows.missedLines.length, 1);
  assert.equal(flagLabel('unmatched_line'), 'Could not match to a line on the page');
});

test('item 6: an extracted row past every counted line gets flagged unmatched_line, via the Warnings filter\'s own generic "any flags" check', () => {
  const pagesLines = threeAmountLinesPage(); // 3 counted amount lines
  const rows = [
    { row_id: 'r1', skipped: false, source_line: 0, flags: [] },
    { row_id: 'r2', skipped: false, source_line: 1, flags: [] },
    { row_id: 'r3', skipped: false, source_line: 2, flags: [] },
    { row_id: 'r4-extra', skipped: false, source_line: 3, flags: [] }, // one past the last real counted line
  ];
  tagUnmatchedGroupedRows(rows, pagesLines);
  assert.deepEqual(rows[0].flags, []);
  assert.deepEqual(rows[1].flags, []);
  assert.deepEqual(rows[2].flags, []);
  assert.deepEqual(rows[3].flags, ['unmatched_line']);
  assert.ok(rows.filter((r) => r.flags.length).every((r) => r.row_id === 'r4-extra'));
});

test('flagLabel returns the shared human label for a known flag, and the raw id for an unknown one', () => {
  assert.equal(flagLabel('unparseable_date'), 'Date could not be read');
  assert.equal(flagLabel('possible_duplicate'), 'Possible duplicate');
  assert.equal(flagLabel('some_future_flag'), 'some_future_flag');
});

test('rowFlagLabel prefers the row\'s own low_confidence_hint over the generic caption', () => {
  const row = { low_confidence_hint: 'Amount read as 1.73 with no decimal point. Likely 173.00. Check against the page.' };
  assert.equal(rowFlagLabel('low_confidence_ocr', row), row.low_confidence_hint);
});

test('rowFlagLabel falls back to flagLabel when the row has no hint, or for any other flag', () => {
  assert.equal(rowFlagLabel('low_confidence_ocr', { low_confidence_hint: null }), flagLabel('low_confidence_ocr'));
  assert.equal(rowFlagLabel('low_confidence_ocr', undefined), flagLabel('low_confidence_ocr'));
  assert.equal(rowFlagLabel('sign_unclear', { low_confidence_hint: 'irrelevant' }), flagLabel('sign_unclear'));
});
