import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupItemsIntoLines, lineText, assignColumns, extractRows, extractStatementPeriodText, inferGenericTable, extractGroupedRows, detectPdfRowModel, isImageOnlyPdf, extractPdfPagesRows, matchAmountEnd, matchAmountLine, normalizeOcrCurrencyToken, resolveGroupedSign, learnAmountXBands, detectGroupedSignConvention, INCORRECT_PASSWORD } from '../src/core/pdf.js';
import { normalizeRecords } from '../src/core/normalize.js';

test('groupItemsIntoLines clusters items with close y values into one line', () => {
  const items = [
    { str: '01/06/2026', x: 40, y: 700 },
    { str: 'Coffee', x: 110, y: 701 }, // within tolerance of 700
    { str: '02/06/2026', x: 40, y: 680 },
  ];
  const lines = groupItemsIntoLines(items, 2);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].items.length, 2); // the y~700-701 line, read first (top of page = higher y)
  assert.equal(lines[1].items.length, 1);
});

test('lineText joins items left to right', () => {
  const line = { y: 0, items: [{ str: 'Coffee', x: 10, y: 0 }, { str: '01/06', x: 0, y: 0 }] };
  const sorted = groupItemsIntoLines(line.items)[0];
  assert.equal(lineText(sorted), '01/06 Coffee');
});

test('assignColumns buckets items by x range', () => {
  const line = { y: 0, items: [{ str: '01/06/2026', x: 40, y: 0 }, { str: 'Coffee', x: 110, y: 0 }] };
  const columns = [{ field: 'date', x0: 30, x1: 100 }, { field: 'description_raw', x0: 100, x1: 300 }];
  const result = assignColumns(line, columns);
  assert.equal(result.date, '01/06/2026');
  assert.equal(result.description_raw, 'Coffee');
});

test('extractRows respects tableStart/tableEnd anchors', () => {
  const lines = groupItemsIntoLines([
    { str: 'Statement of Account', x: 0, y: 100 },
    { str: 'Transaction Date', x: 40, y: 90 },
    { str: '01/06/2026', x: 40, y: 80 },
    { str: 'Coffee', x: 110, y: 80 },
    { str: 'Closing Balance', x: 0, y: 60 },
    { str: 'Page 1 of 1', x: 0, y: 50 },
  ]);
  const config = {
    tableStart: { anchor: 'Transaction Date' },
    tableEnd: { anchor: 'Closing Balance' },
    columns: [{ field: 'date', x0: 30, x1: 100 }, { field: 'description_raw', x0: 100, x1: 300 }],
    rowStartPattern: '^\\d{2}/\\d{2}',
  };
  const rows = extractRows(lines, config);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '01/06/2026');
  assert.equal(rows[0].description_raw, 'Coffee');
});

test('extractRows joins wrapped continuation lines into the row above', () => {
  const lines = groupItemsIntoLines([
    { str: '01/06/2026', x: 40, y: 80 },
    { str: 'Coffee', x: 110, y: 80 },
    { str: 'Extra wrapped text', x: 110, y: 70 }, // continuation, no leading date
  ]);
  const config = {
    columns: [{ field: 'date', x0: 30, x1: 100 }, { field: 'description_raw', x0: 100, x1: 300 }],
    rowStartPattern: '^\\d{2}/\\d{2}',
    joinWrappedLines: true,
  };
  const rows = extractRows(lines, config);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description_raw, 'Coffee Extra wrapped text');
});

test('extractRows drops lines matching ignoreLinePatterns', () => {
  const lines = groupItemsIntoLines([
    { str: '01/06/2026', x: 40, y: 80 },
    { str: 'Coffee', x: 110, y: 80 },
    { str: 'Page 1 of 2', x: 0, y: 70 },
    { str: '02/06/2026', x: 40, y: 60 },
    { str: 'Tea', x: 110, y: 60 },
  ]);
  const config = {
    columns: [{ field: 'date', x0: 30, x1: 100 }, { field: 'description_raw', x0: 100, x1: 300 }],
    rowStartPattern: '^\\d{2}/\\d{2}',
    ignoreLinePatterns: ['^Page \\d+ of'],
  };
  const rows = extractRows(lines, config);
  assert.equal(rows.length, 2);
});

test('extractStatementPeriodText captures start/end text', () => {
  const result = extractStatementPeriodText('Statement Period: 01 Jun 2026 to 30 Jun 2026', 'Statement Period: (.+?) to (.+)');
  assert.deepEqual(result, { startText: '01 Jun 2026', endText: '30 Jun 2026' });
});

test('extractStatementPeriodText returns null when pattern absent', () => {
  assert.equal(extractStatementPeriodText('no period here', 'Statement Period: (.+?) to (.+)'), null);
});

test('inferGenericTable builds a raw grid from x-gap clustering on date-led lines', () => {
  const items = [
    { str: '01/06/2026', x: 40, y: 100 }, { str: 'Coffee shop', x: 110, y: 100 }, { str: '5.50', x: 300, y: 100 },
    { str: '02/06/2026', x: 41, y: 90 }, { str: 'Grocery run', x: 108, y: 90 }, { str: '32.10', x: 301, y: 90 },
    { str: 'Statement continues', x: 40, y: 80 }, // not date-led, excluded from the fallback grid
    { str: '03/06/2026', x: 39, y: 70 }, { str: 'Salary', x: 112, y: 70 }, { str: '3000.00', x: 299, y: 70 },
  ];
  const lines = groupItemsIntoLines(items);
  const { grid, columns, confidence } = inferGenericTable(lines);
  assert.equal(columns.length, 3);
  assert.equal(grid.length, 3);
  assert.equal(grid[0][0], '01/06/2026');
  assert.equal(grid[0][1], 'Coffee shop');
  assert.equal(grid[0][2], '5.50');
  assert.equal(grid[2][1], 'Salary');
  assert.ok(confidence > 0.9);
});

test('inferGenericTable returns zero confidence with fewer than 2 date-led lines', () => {
  const items = [{ str: 'No dates here', x: 40, y: 100 }];
  const lines = groupItemsIntoLines(items);
  const result = inferGenericTable(lines);
  assert.equal(result.grid.length, 0);
  assert.equal(result.confidence, 0);
});

test('extractGroupedRows extracts transactions under date-group headers, joining the type line', () => {
  const items = [
    { str: 'Yesterday, 15 Sep 2026', x: 40, y: 700 },
    { str: 'BAT 2C2*LAZADA Singapore SGP', x: 40, y: 686 }, { str: 'SGD - 20.83', x: 400, y: 686 },
    { str: 'Point-of-Sale Transaction', x: 40, y: 674 }, { str: '· POS', x: 250, y: 674 },
    { str: 'Monday, 14 Sep 2026', x: 40, y: 650 },
    { str: 'GIRO SALARY CREDIT', x: 40, y: 636 }, { str: 'SGD + 1,200.00', x: 400, y: 636 },
    { str: 'Advice', x: 40, y: 624 }, { str: '· ADV', x: 100, y: 624 },
  ];
  const lines = groupItemsIntoLines(items);
  const rows = extractGroupedRows(lines, { grouped: { trailingTypeLine: true } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '15 Sep 2026');
  assert.equal(rows[0].description_raw, 'BAT 2C2*LAZADA Singapore SGP');
  assert.equal(rows[0].amount, '-20.83');
  assert.equal(rows[0].currency, 'SGD');
  assert.equal(rows[0].type, 'Point-of-Sale Transaction · POS');
  assert.equal(rows[1].date, '14 Sep 2026');
  assert.equal(rows[1].amount, '1200.00');
  assert.equal(rows[1].type, 'Advice · ADV');
});

test('extractGroupedRows handles a bare "D MMM YYYY" date-group line (no day name)', () => {
  const items = [
    { str: '10 Sep 2026', x: 40, y: 700 },
    { str: 'NETS QR PAYMENT', x: 40, y: 686 }, { str: 'SGD - 4.50', x: 400, y: 686 },
  ];
  const lines = groupItemsIntoLines(items);
  const rows = extractGroupedRows(lines, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '10 Sep 2026');
  assert.equal(rows[0].amount, '-4.50');
});

test('extractGroupedRows recognizes a date-group line even when OCR merges the day and month into one word ("1Sep 2026", no space)', () => {
  // Root-caused 2026-09-16 against a real 3-page statement: Tesseract read a
  // bare "1 Sep 2026" date-group header as the single token "1Sep", which
  // silently failed the old \s+-only DEFAULT_DATE_GROUP_RE (no dateMatch, no
  // error), so every following transaction stayed mis-attributed to the
  // previous date-group instead.
  const items = [
    { str: '1Sep 2026', x: 40, y: 700 },
    { str: 'NETS QR PAYMENT', x: 40, y: 686 }, { str: 'SGD - 4.50', x: 400, y: 686 },
  ];
  const lines = groupItemsIntoLines(items);
  const rows = extractGroupedRows(lines, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '1Sep 2026');
});

test('isImageOnlyPdf flags a page with zero text items', () => {
  const { imageOnly, totalItems, totalChars } = isImageOnlyPdf([{ pageNum: 1, items: [] }]);
  assert.equal(imageOnly, true);
  assert.equal(totalItems, 0);
  assert.equal(totalChars, 0);
});

test('isImageOnlyPdf flags a scanned page carrying only a stamped footer', () => {
  const { imageOnly } = isImageOnlyPdf([{ pageNum: 1, items: [{ str: 'Page 1 of 3' }] }]);
  assert.equal(imageOnly, true);
});

test('isImageOnlyPdf treats a normal text layer as not image-only', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ str: 'word ' }));
  const { imageOnly } = isImageOnlyPdf([{ pageNum: 1, items }]);
  assert.equal(imageOnly, false);
});

test('detectPdfRowModel picks "grouped" for date-group + amount-ended lines', () => {
  const items = [
    { str: 'Yesterday, 15 Sep 2026', x: 40, y: 700 },
    { str: 'BAT 2C2*LAZADA Singapore SGP', x: 40, y: 686 }, { str: 'SGD - 20.83', x: 400, y: 686 },
    { str: 'Point-of-Sale Transaction · POS', x: 40, y: 674 },
    { str: 'Monday, 14 Sep 2026', x: 40, y: 650 },
    { str: 'GIRO SALARY CREDIT', x: 40, y: 636 }, { str: 'SGD + 1,200.00', x: 400, y: 636 },
  ];
  const lines = groupItemsIntoLines(items);
  const { rowModel } = detectPdfRowModel(lines);
  assert.equal(rowModel, 'grouped');
});

test('detectPdfRowModel picks "columns" for a fixed-width date-led table', () => {
  const items = [
    { str: '01/06/2026', x: 40, y: 100 }, { str: 'Coffee shop', x: 110, y: 100 }, { str: '5.50', x: 300, y: 100 },
    { str: '02/06/2026', x: 41, y: 90 }, { str: 'Grocery run', x: 108, y: 90 }, { str: '32.10', x: 301, y: 90 },
  ];
  const lines = groupItemsIntoLines(items);
  const { rowModel } = detectPdfRowModel(lines);
  assert.equal(rowModel, 'columns');
});

test('grouped rowModel: extracted rows normalize to correct signed amounts and dates', () => {
  const items = [
    { str: 'Yesterday, 15 Sep 2026', x: 40, y: 700 },
    { str: 'BAT 2C2*LAZADA Singapore SGP', x: 40, y: 686 }, { str: 'SGD - 20.83', x: 400, y: 686 },
    { str: 'Point-of-Sale Transaction · POS', x: 40, y: 674 },
    { str: 'Monday, 14 Sep 2026', x: 40, y: 650 },
    { str: 'GIRO SALARY CREDIT', x: 40, y: 636 }, { str: 'SGD + 1,200.00', x: 400, y: 636 },
    { str: 'Advice · ADV', x: 40, y: 624 },
  ];
  const lines = groupItemsIntoLines(items);
  const records = extractGroupedRows(lines, { grouped: { trailingTypeLine: true } });
  const version = {
    pdf: { rowModel: 'grouped' },
    fields: {
      date: { source: 'date' },
      description_raw: { source: ['description_raw'] },
      amount: { source: 'amount' },
      currency: { mode: 'column', source: 'currency' },
      extra: [{ name: 'extra_type', source: 'type' }],
    },
    dateFormat: 'DD MMM YYYY',
    numberFormat: '1,234.56',
    signConvention: 'signed',
  };
  const rows = normalizeRecords(records, version, { bank: 'DBS', statementType: 'savings', currency: 'SGD', sourceFile: 'x' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-09-15');
  assert.equal(rows[0].amount, -2083);
  assert.equal(rows[0].extra_type, 'Point-of-Sale Transaction · POS');
  assert.equal(rows[1].date, '2026-09-14');
  assert.equal(rows[1].amount, 120000);
});

test('extractPdfPagesRows (rowModel grouped): a date-group header on page 1 still applies to a transaction that only appears on page 2', () => {
  const page1 = groupItemsIntoLines([
    { str: 'Yesterday, 15 Sep 2026', x: 40, y: 700 },
    { str: 'BAT 2C2*LAZADA Singapore SGP', x: 40, y: 686 }, { str: 'SGD - 20.83', x: 400, y: 686 },
  ]);
  const page2 = groupItemsIntoLines([
    // No date-group header repeated here - a real multi-page "Transaction
    // History" export doesn't restate it once a page breaks mid-group.
    { str: 'GIRO SALARY CREDIT', x: 40, y: 700 }, { str: 'SGD + 1,200.00', x: 400, y: 700 },
  ]);
  const rows = extractPdfPagesRows([page1, page2], { rowModel: 'grouped' });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].date, '15 Sep 2026', 'page 2\'s transaction must inherit page 1\'s still-open date group');
});

test('extractPdfPagesRows (rowModel columns): a tableEnd anchor that only appears on the last page still stops extraction there', () => {
  const config = {
    tableStart: { anchor: 'Transaction Date' },
    tableEnd: { anchor: 'Closing Balance' },
    columns: [{ field: 'date', x0: 30, x1: 100 }, { field: 'description_raw', x0: 100, x1: 300 }],
    rowStartPattern: '^\\d{2}/\\d{2}',
  };
  const page1 = groupItemsIntoLines([
    { str: 'Transaction Date', x: 40, y: 700 },
    { str: '01/06/2026', x: 40, y: 680 }, { str: 'Coffee', x: 110, y: 680 },
  ]);
  const page2 = groupItemsIntoLines([
    // No tableStart on this continuation page - a real bank statement never
    // repeats the column header on every page.
    { str: '02/06/2026', x: 40, y: 700 }, { str: 'Lunch', x: 110, y: 700 },
    { str: 'Closing Balance', x: 0, y: 680 },
  ]);
  const rows = extractPdfPagesRows([page1, page2], config);
  assert.equal(rows.length, 2, 'page 2\'s row must be extracted even with no tableStart anchor of its own');
  assert.equal(rows[1].description_raw, 'Lunch');
});

// --- source_page/source_y/source_line: review.js's row-click "jump to page
// and outline the exact line" needs these stamped at extraction time
// (real extraction order, not a best-effort re-derivation from the rows
// alone) - see FEEDBACK-2026-09-17.md Section B item 1.
test('extractPdfPagesRows (rowModel grouped): every row carries the page and y it was extracted from, across pages', () => {
  const page1 = groupItemsIntoLines([
    { str: 'Yesterday, 15 Sep 2026', x: 40, y: 700 },
    { str: 'BAT 2C2*LAZADA Singapore SGP', x: 40, y: 686 }, { str: 'SGD - 20.83', x: 400, y: 686 },
  ]);
  const page2 = groupItemsIntoLines([
    { str: 'GIRO SALARY CREDIT', x: 40, y: 700 }, { str: 'SGD + 1,200.00', x: 400, y: 700 },
  ]);
  const rows = extractPdfPagesRows([page1, page2], { rowModel: 'grouped' });
  assert.equal(rows[0].source_page, 1);
  assert.equal(rows[0].source_y, 686);
  assert.equal(rows[1].source_page, 2, 'a row on page 2 must carry page 2, not page 1');
  assert.equal(rows[1].source_y, 700);
});

test('extractPdfPagesRows (rowModel columns): every row carries the page/y it was extracted from, and a joined wrapped line keeps the row-start line\'s position', () => {
  const config = {
    columns: [{ field: 'date', x0: 30, x1: 100 }, { field: 'description_raw', x0: 100, x1: 300 }],
    rowStartPattern: '^\\d{2}/\\d{2}',
    joinWrappedLines: true,
  };
  const page1 = groupItemsIntoLines([
    { str: '01/06/2026', x: 40, y: 700 }, { str: 'Coffee', x: 110, y: 700 },
    { str: 'wrapped continuation', x: 110, y: 690 },
  ]);
  const page2 = groupItemsIntoLines([
    { str: '02/06/2026', x: 40, y: 700 }, { str: 'Lunch', x: 110, y: 700 },
  ]);
  const rows = extractPdfPagesRows([page1, page2], config);
  assert.equal(rows[0].source_page, 1);
  assert.equal(rows[0].source_y, 700, 'a joined wrapped continuation line must not move the row\'s own source position');
  assert.equal(rows[1].source_page, 2);
  assert.equal(rows[1].source_y, 700);
});

test('extractRows/extractGroupedRows called directly (not via extractPdfPagesRows) leave source_page null, source_y still set', () => {
  const lines = groupItemsIntoLines([{ str: 'Yesterday, 15 Sep 2026', x: 40, y: 700 }, { str: 'Coffee', x: 40, y: 686 }, { str: 'SGD - 4.50', x: 400, y: 686 }]);
  const rows = extractGroupedRows(lines, {});
  assert.equal(rows[0].source_page, null);
  assert.equal(rows[0].source_y, 686);
});

test('source_page/source_y reach the normalized row via `original` (normalize.js spreads the raw record unchanged)', () => {
  const page1 = groupItemsIntoLines([
    { str: 'Yesterday, 15 Sep 2026', x: 40, y: 700 },
    { str: 'Coffee', x: 40, y: 686 }, { str: 'SGD - 4.50', x: 400, y: 686 },
  ]);
  const records = extractPdfPagesRows([page1], { rowModel: 'grouped' });
  const rows = normalizeRecords(records, { fields: { date: { source: 'date' }, description_raw: { source: 'description_raw' }, amount: { source: 'amount' }, currency: { mode: 'column', source: 'currency' } } }, {});
  assert.equal(rows[0].original.source_page, 1);
  assert.equal(rows[0].original.source_y, 686);
});

// --- matchAmountEnd / normalizeOcrCurrencyToken (root-caused 2026-09-16: two
// real credit transactions were silently dropped entirely because Tesseract
// read their "+" sign glyph as nothing at all, e.g. "SGD 11.63" instead of
// "SGD + 11.63") ------------------------------------------------------------

test('matchAmountEnd: a missing sign is treated as positive, not a non-match', () => {
  const m = matchAmountEnd('BAT 2C2*LAZADA Singapore SGP SGD 11.63');
  assert.ok(m, 'a bare (unsigned) amount must still match');
  assert.equal(m.currency, 'SGD');
  assert.equal(m.sign, '');
  assert.equal(m.digits, '11.63');
});

test('matchAmountEnd: still handles an explicit sign, negative and positive', () => {
  assert.equal(matchAmountEnd('BAT ... SGD - 20.83').sign, '-');
  assert.equal(matchAmountEnd('GIRO ... SGD + 1,200.00').sign, '+');
});

test('matchAmountEnd: corrects a 1-character OCR confusion in the currency code', () => {
  assert.equal(matchAmountEnd('BAT ... S6D - 20.83').currency, 'SGD');
  assert.equal(matchAmountEnd('BAT ... SG0 - 20.83').currency, 'SGO'); // trailing 0 -> O
  assert.equal(normalizeOcrCurrencyToken('S6D'), 'SGD');
  assert.equal(normalizeOcrCurrencyToken('SGD'), 'SGD', 'a clean token is returned unchanged');
  assert.equal(normalizeOcrCurrencyToken('123'), null, 'not a plausible currency code even after correction');
});

test('matchAmountEnd: falls back to a bare number when the currency code is unreadable', () => {
  const m = matchAmountEnd('BAT ... ### - 20.83');
  assert.ok(m);
  assert.equal(m.currency, null);
  assert.equal(m.sign, '-');
  assert.equal(m.digits, '20.83');
});

test('matchAmountEnd: does not match a line with no trailing 2-decimal number', () => {
  assert.equal(matchAmountEnd('Point-of-Sale Transaction - POS'), null);
  assert.equal(matchAmountEnd('11 Sep 2026'), null);
});

test('extractGroupedRows: a real credit line with a dropped "+" glyph is extracted as a positive amount, not silently missing', () => {
  const items = [
    { str: '11', x: 40, y: 700 }, { str: 'Sep', x: 60, y: 700 }, { str: '2026', x: 90, y: 700 },
    { str: 'BAT', x: 40, y: 686 }, { str: '2C2*LAZADA', x: 70, y: 686 }, { str: 'SGP', x: 150, y: 686 },
    { str: 'SGD', x: 400, y: 686 }, { str: '11.63', x: 430, y: 686 },
  ];
  const rows = extractGroupedRows(groupItemsIntoLines(items), {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, '11.63');
  assert.equal(rows[0].currency, 'SGD');
});

test('extractGroupedRows: only the amount token\'s own confidence sets _amountConfidence, not the whole line', () => {
  const items = [
    { str: '11', x: 40, y: 700, confidence: 92 }, { str: 'Sep', x: 60, y: 700, confidence: 90 }, { str: '2026', x: 90, y: 700, confidence: 95 },
    { str: 'GARBLED', x: 40, y: 686, confidence: 12 }, { str: 'MERCHANT', x: 120, y: 686, confidence: 15 },
    { str: 'SGD', x: 400, y: 686, confidence: 96 }, { str: '-', x: 430, y: 686, confidence: 94 }, { str: '20.83', x: 440, y: 686, confidence: 97 },
  ];
  const rows = extractGroupedRows(groupItemsIntoLines(items), {});
  assert.equal(rows.length, 1);
  assert.ok(rows[0]._amountConfidence >= 94, `expected the amount-token confidence (~94-97), got ${rows[0]._amountConfidence}`);
  assert.ok(rows[0]._dateConfidence >= 90, `expected the date-group confidence (~90-95), got ${rows[0]._dateConfidence}`);
});

test('extractGroupedRows: the type line never affects the row\'s tracked confidence', () => {
  const items = [
    { str: '11', x: 40, y: 700, confidence: 92 }, { str: 'Sep', x: 60, y: 700, confidence: 90 }, { str: '2026', x: 90, y: 700, confidence: 95 },
    { str: 'MERCHANT', x: 40, y: 686, confidence: 90 }, { str: 'SGD', x: 400, y: 686, confidence: 96 }, { str: '-', x: 430, y: 686, confidence: 94 }, { str: '20.83', x: 440, y: 686, confidence: 97 },
    { str: 'GARBLED', x: 40, y: 676, confidence: 3 }, { str: 'TYPE', x: 100, y: 676, confidence: 4 },
  ];
  const rows = extractGroupedRows(groupItemsIntoLines(items), {});
  assert.equal(rows.length, 1);
  assert.ok(rows[0]._amountConfidence >= 94, 'the type line\'s near-zero confidence must not drag the amount confidence down');
});

test('extractGroupedRows: ignoreLinePatterns drops a page footer instead of merging it into the previous row\'s type', () => {
  const items = [
    { str: '11', x: 40, y: 700 }, { str: 'Sep', x: 60, y: 700 }, { str: '2026', x: 90, y: 700 },
    { str: 'MERCHANT', x: 40, y: 686 }, { str: 'SGD', x: 400, y: 686 }, { str: '-', x: 430, y: 686 }, { str: '20.83', x: 440, y: 686 },
    { str: 'Page', x: 40, y: 13 }, { str: '1', x: 80, y: 13 }, { str: 'of', x: 100, y: 13 }, { str: '3', x: 120, y: 13 },
  ];
  const lines = groupItemsIntoLines(items);
  const withoutIgnore = extractGroupedRows(lines, { grouped: { trailingTypeLine: true } });
  assert.equal(withoutIgnore[0].type, 'Page 1 of 3', 'without an ignore pattern, the footer merges into the row above (the bug)');

  const withIgnore = extractGroupedRows(lines, { grouped: { trailingTypeLine: true }, ignoreLinePatterns: ['^Page \\d+ of \\d+$'] });
  assert.equal(withIgnore[0].type, '', 'with the ignore pattern, the footer is dropped instead');
});

// --- Decimal-optional amounts, sign-independent detection, and the
// preamble/balance false-positive fixes (2026-09-16) -----------------------

test('matchAmountLine: round amounts with no decimal at all are recognized ("500", "1,200")', () => {
  const a = matchAmountLine('BAT MERCHANT SGD 500');
  assert.ok(a);
  assert.equal(a.digits, '500');
  assert.equal(a.hasDecimal, false);

  const b = matchAmountLine('GIRO SALARY CREDIT SGD 1,200');
  assert.ok(b);
  assert.equal(b.digits, '1200');
});

test('matchAmountLine: a trailing CR/DR marker resolves independently of sign - "SGD 500 CR"', () => {
  const m = matchAmountLine('REFUND FROM MERCHANT SGD 500 CR');
  assert.ok(m);
  assert.equal(m.digits, '500');
  assert.equal(m.markerType, 'CRDR');
  assert.equal(m.markerSign, '+');
});

test('matchAmountLine: a "DR" marker resolves to money out', () => {
  const m = matchAmountLine('CARD PURCHASE SGD 42.50 DR');
  assert.equal(m.markerType, 'CRDR');
  assert.equal(m.markerSign, '-');
});

test('matchAmountLine: a foreign currency symbol with no decimals at all ("¥12,000", JPY-style)', () => {
  const m = matchAmountLine('KYOTO STATION SHOP ¥12,000');
  assert.ok(m, 'a currency-symbol amount with no decimal point must still be recognized');
  assert.equal(m.digits, '12000');
  assert.equal(m.currency, '¥');
});

test('matchAmountLine: parentheses mean negative (accounting notation)', () => {
  const m = matchAmountLine('LATE FEE SGD (15.00)');
  assert.equal(m.markerType, 'PAREN');
  assert.equal(m.markerSign, '-');
});

test('matchAmountLine: never drops a line just because the sign/marker is unreadable - markerType is null, not a non-match', () => {
  const m = matchAmountLine('BAT MERCHANT SGD 20.83');
  assert.ok(m, 'a bare amount with no marker at all must still match');
  assert.equal(m.markerType, null);
});

test('matchAmountLine: rejects a bare long reference number with no currency, decimal, or marker', () => {
  assert.equal(matchAmountLine('Account 000003084243665'), null);
});

test('matchAmountLine: a real account-summary header line is excluded regardless of wording variant', () => {
  assert.equal(matchAmountLine('Available Balance SGD 33,889.56'), null);
  assert.equal(matchAmountLine('Ledger Balance SGD 34,031.70'), null);
  assert.equal(matchAmountLine('Current balance SGD 1,204.50'), null);
  assert.equal(matchAmountLine('Available credit limit SGD 5,000.00'), null);
  assert.equal(matchAmountLine('Reward points SGD 120.00'), null);
});

test('matchAmountLine: a statement-period range line (two years) is excluded even mid-document', () => {
  assert.equal(matchAmountLine('16 Sep 2026 - 15 Oct 2026'), null);
});

test('extractGroupedRows: nothing before the first date-group line becomes a row, even a bare-number preamble line', () => {
  const items = [
    // Preamble: an account/postal number with no date-group opened yet.
    { str: '120-275409-2', x: 40, y: 760 },
    { str: '413', x: 40, y: 740 }, { str: 'SOME', x: 60, y: 740 }, { str: 'ROAD', x: 100, y: 740 }, { str: '5', x: 140, y: 740 },
    // First real date-group opens here.
    { str: '15', x: 40, y: 700 }, { str: 'Sep', x: 60, y: 700 }, { str: '2026', x: 90, y: 700 },
    { str: 'MERCHANT', x: 40, y: 686 }, { str: 'SGD', x: 400, y: 686 }, { str: '-', x: 430, y: 686 }, { str: '20.83', x: 440, y: 686 },
  ];
  const rows = extractGroupedRows(groupItemsIntoLines(items), {});
  assert.equal(rows.length, 1, 'the preamble lines must never become rows, no matter what bare numbers they contain');
  assert.equal(rows[0].amount, '-20.83');
});

test('extractGroupedRows: a repeated account-summary/period line AFTER the first date-group (e.g. page 2\'s restated header) is still excluded', () => {
  const items = [
    { str: '15', x: 40, y: 700 }, { str: 'Sep', x: 60, y: 700 }, { str: '2026', x: 90, y: 700 },
    { str: 'MERCHANT', x: 40, y: 686 }, { str: 'SGD', x: 400, y: 686 }, { str: '-', x: 430, y: 686 }, { str: '20.83', x: 440, y: 686 },
    // A repeated per-page header, well after currentDate is already set.
    { str: '16', x: 40, y: 650 }, { str: 'Sep', x: 60, y: 650 }, { str: '2026', x: 90, y: 650 },
    { str: '-', x: 110, y: 650 }, { str: '15', x: 130, y: 650 }, { str: 'Oct', x: 150, y: 650 }, { str: '2026', x: 180, y: 650 },
    { str: '14', x: 40, y: 600 }, { str: 'Sep', x: 60, y: 600 }, { str: '2026', x: 90, y: 600 },
    { str: 'OTHER', x: 40, y: 586 }, { str: 'SGD', x: 400, y: 586 }, { str: '-', x: 430, y: 586 }, { str: '5.00', x: 440, y: 586 },
  ];
  const rows = extractGroupedRows(groupItemsIntoLines(items), {});
  assert.equal(rows.length, 2, 'the repeated period-range line must not become a spurious third row');
  assert.deepEqual(rows.map((r) => r.amount), ['-20.83', '-5.00']);
});

// --- resolveGroupedSign / learnAmountXBands / detectGroupedSignConvention --

test('resolveGroupedSign: signed convention takes an explicit sign as-is', () => {
  assert.deepEqual(resolveGroupedSign({ markerType: 'SIGN', markerSign: '-' }, null, 'signed'), { sign: '-', unclear: false });
  assert.deepEqual(resolveGroupedSign({ markerType: 'SIGN', markerSign: '+' }, null, 'signed'), { sign: '+', unclear: false });
});

test('resolveGroupedSign: crdr marker resolves regardless of the stated convention', () => {
  assert.deepEqual(resolveGroupedSign({ markerType: 'CRDR', markerSign: '+' }, null, 'signed'), { sign: '+', unclear: false });
  assert.deepEqual(resolveGroupedSign({ markerType: 'CRDR', markerSign: '-' }, null, 'crdr'), { sign: '-', unclear: false });
});

test('resolveGroupedSign: positiveIsOut flips an explicit sign (credit-card convention)', () => {
  assert.deepEqual(resolveGroupedSign({ markerType: 'SIGN', markerSign: '+' }, null, 'positiveIsOut'), { sign: '-', unclear: false });
  assert.deepEqual(resolveGroupedSign({ markerType: 'SIGN', markerSign: '-' }, null, 'positiveIsOut'), { sign: '+', unclear: false });
});

test('resolveGroupedSign: no marker at all under signed/crdr is a real guess, flagged unclear, never null/dropped', () => {
  assert.deepEqual(resolveGroupedSign({ markerType: null, markerSign: null }, null, 'signed'), { sign: '+', unclear: true });
  assert.deepEqual(resolveGroupedSign({ markerType: null, markerSign: null }, null), { sign: '+', unclear: true });
});

// Item 5c regression (Summit Bank, 92.1% false-flagged): positiveIsOut/
// positiveIsIn only gets picked when the file's marked lines establish that
// an unmarked line reliably means the OTHER direction (e.g. every credit
// prints "CR", every debit is bare) - the absence of a marker there IS the
// signal, not a guess, so it must never carry 'unclear'.
test('resolveGroupedSign: positiveIsOut/positiveIsIn on a marker-less line is the convention itself, not a guess', () => {
  assert.deepEqual(resolveGroupedSign({ markerType: null, markerSign: null }, null, 'positiveIsOut'), { sign: '-', unclear: false });
  assert.deepEqual(resolveGroupedSign({ markerType: null, markerSign: null }, null, 'positiveIsIn'), { sign: '+', unclear: false });
});

test('resolveGroupedSign: columnBands decides by x-position, even with no marker', () => {
  const bands = { debit: { x0: 0, x1: 300 }, credit: { x0: 300, x1: 600 } };
  assert.deepEqual(resolveGroupedSign({ markerType: null, markerSign: null }, 100, 'signed', bands), { sign: '-', unclear: false });
  assert.deepEqual(resolveGroupedSign({ markerType: null, markerSign: null }, 400, 'signed', bands), { sign: '+', unclear: false });
});

// Item 5c regression, end-to-end: Summit Bank's own shape (2-line grouped,
// currency printed AFTER the amount, credits marked "CR", debits bare) drove
// 92.1% of its rows into 'sign_unclear' before the resolveGroupedSign fix
// above - every bare debit line, which is most of the file, was flagged.
test('extractGroupedRows + positiveIsOut: a file of mostly-bare debit lines and one CR credit line marks none of them sign-unclear', () => {
  const items = [
    { str: '11', x: 40, y: 700 }, { str: 'Sep', x: 60, y: 700 }, { str: '2026', x: 90, y: 700 },
    { str: 'DECATHLON', x: 40, y: 686 }, { str: '178.78', x: 400, y: 686 }, { str: 'SGD', x: 450, y: 686 },
    { str: 'KOPITIAM', x: 40, y: 672 }, { str: '158.80', x: 400, y: 672 }, { str: 'SGD', x: 450, y: 672 },
    { str: 'SHOPEE', x: 40, y: 658 }, { str: 'REFUND', x: 100, y: 658 }, { str: '244.36', x: 400, y: 658 }, { str: 'SGD', x: 450, y: 658 }, { str: 'CR', x: 480, y: 658 },
  ];
  const rows = extractGroupedRows(groupItemsIntoLines(items), { grouped: { signConvention: 'positiveIsOut' } });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].amount, '-178.78');
  assert.equal(rows[1].amount, '-158.80');
  assert.equal(rows[2].amount, '244.36');
  assert.ok(!rows.some((r) => r._signUnclear), 'bare debit lines under a detected positiveIsOut convention are not a guess');
});

test('learnAmountXBands: two clearly separated x-clusters are learned as debit/credit bands', () => {
  const matches = [
    { x: 100 }, { x: 105 }, { x: 98 }, { x: 102 }, // debit cluster
    { x: 400 }, { x: 398 }, { x: 405 }, // credit cluster
  ];
  const bands = learnAmountXBands(matches);
  assert.ok(bands);
  assert.ok(bands.debit.x1 > 105 && bands.debit.x1 < 400);
  assert.equal(bands.credit.x1, Infinity);
});

test('learnAmountXBands: a single tight cluster (no real second column) returns null', () => {
  const matches = [{ x: 100 }, { x: 102 }, { x: 98 }, { x: 101 }, { x: 103 }];
  assert.equal(learnAmountXBands(matches), null);
});

test('item 8: a "September 2026" month banner between date groups produces 0 extra rows, not a phantom transaction', () => {
  const items = [
    { str: 'Yesterday, 15 Sep 2026', x: 40, y: 700 },
    { str: 'BAT 2C2*LAZADA Singapore SGP', x: 40, y: 686 }, { str: 'SGD - 20.83', x: 400, y: 686 },
    { str: 'Point-of-Sale Transaction', x: 40, y: 674 },
    { str: 'September 2026', x: 40, y: 660 }, // the banner line under test
    { str: 'Monday, 14 Sep 2026', x: 40, y: 650 },
    { str: 'GIRO SALARY CREDIT', x: 40, y: 636 }, { str: 'SGD + 1,200.00', x: 400, y: 636 },
    { str: 'Advice', x: 40, y: 624 },
  ];
  const lines = groupItemsIntoLines(items);
  const rows = extractGroupedRows(lines, { grouped: { trailingTypeLine: true } });
  // Exactly 2 real transactions - the banner produces no extra row, and
  // never gets absorbed into either row's `type` field.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'Point-of-Sale Transaction');
  assert.equal(rows[1].date, '14 Sep 2026');
  assert.equal(rows[1].type, 'Advice');
});

test('item 8: a bare "2026" line alone never parses as an amount', () => {
  assert.equal(matchAmountLine('2026'), null);
  assert.equal(matchAmountLine('September 2026'), null);
});

test('detectGroupedSignConvention: mostly-signed lines auto-detect as "signed"', () => {
  const lines = [
    groupItemsIntoLines([{ str: '15', x: 40, y: 100 }, { str: 'Sep', x: 60, y: 100 }, { str: '2026', x: 90, y: 100 }])[0],
    groupItemsIntoLines([{ str: 'MERCHANT', x: 40, y: 90 }, { str: 'SGD', x: 400, y: 90 }, { str: '-', x: 430, y: 90 }, { str: '20.83', x: 440, y: 90 }])[0],
    groupItemsIntoLines([{ str: 'SALARY', x: 40, y: 80 }, { str: 'SGD', x: 400, y: 80 }, { str: '+', x: 430, y: 80 }, { str: '1200.00', x: 440, y: 80 }])[0],
  ];
  const result = detectGroupedSignConvention(lines);
  assert.equal(result.signConvention, 'signed');
});

// --- Track 2: password path -----------------------------------------------
// loadPdfPages's real pdf.js wiring isn't node-testable (no headless PDF
// renderer here - see loadPdfPages's own ponytail comment); the actual
// prompt/retry/cancel behaviour against a real encrypted PDF is covered by
// dev/e2e-password.mjs against the bundled Chromium instead. This just pins
// the one exported value home.js's password-prompt block depends on to tell
// a fresh NEED_PASSWORD prompt from a wrong-password INCORRECT_PASSWORD
// reprompt - pdf.js's own PasswordResponses.INCORRECT_PASSWORD is 2 (1 is
// NEED_PASSWORD), and this constant must never drift from that.
test('INCORRECT_PASSWORD matches pdf.js\'s own PasswordResponses.INCORRECT_PASSWORD value', () => {
  assert.equal(INCORRECT_PASSWORD, 2);
});
