import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockLines } from '../src/ui/pdf-render.js';
import { groupItemsIntoLines, extractPdfPagesRows } from '../src/core/pdf.js';

// REBUILD-HOME item 5a (2026-09-18): the decision-card snippet's root-cause
// bug was that it never looked past a single line (source_y alone) - a
// multi-line block whose amount sits below its own description lines fell
// outside that window. blockLines is the pure piece of that fix: given a
// row's real extraction anchor (source_y/source_h/source_y2), does the
// region it defines actually contain every line of the row's own block,
// amount line included? Tested directly against extractPdfPagesRows's real
// output (not a hand-rolled anchor), the same fixture shape as
// test/pdf.test.js's own grouped-rowModel tests, for both a single-line and
// a multi-line (description above its amount line) block.

test('blockLines: a single-line block spans exactly its own line', () => {
  const page1 = groupItemsIntoLines([
    { str: 'Yesterday, 15 Sep 2026', x: 40, y: 700 },
    { str: 'Coffee', x: 40, y: 686 }, { str: 'SGD - 4.50', x: 400, y: 686 },
  ]);
  const rows = extractPdfPagesRows([page1], { rowModel: 'grouped' });
  const row = rows[0];
  const anchor = { y: row.source_y, h: row.source_h, y2: row.source_y2 };
  const region = blockLines(page1, anchor);
  assert.ok(region.some((l) => l.y === 686), 'the region must include the row\'s own (only) line');
  assert.ok(region.every((l) => l.y !== 700), 'the region must not reach up into the date-group header line');
});

test('blockLines: a multi-line block (description above its amount line) spans down to the amount line, not just the anchor line', () => {
  // A block whose description sits on its own line above the amount-ending
  // line - core/pdf.js's extractGroupedRows anchors source_y at the FIRST
  // pending line and stamps source_y2 at the amount line (see pdf.js's
  // tagSource/extendSourceTo).
  const page1 = groupItemsIntoLines([
    { str: 'Yesterday, 15 Sep 2026', x: 40, y: 720 },
    { str: 'BAT 2C2*LAZADA SINGAPORE', x: 40, y: 690 },
    { str: 'SGP REF-XXXX', x: 40, y: 680 },
    { str: 'SGD - 128.40', x: 400, y: 670 },
  ]);
  const rows = extractPdfPagesRows([page1], { rowModel: 'grouped' });
  const row = rows[0];
  assert.ok(row.source_y2 != null, 'a multi-line block must record where it ends (source_y2)');
  const anchor = { y: row.source_y, h: row.source_h, y2: row.source_y2 };
  const region = blockLines(page1, anchor);
  const regionYs = region.map((l) => l.y);
  assert.ok(regionYs.includes(670), 'the region must reach down to the amount line, not stop at the description\'s own first line');
  assert.ok(!regionYs.includes(720), 'the region must not reach up into the date-group header line');
});
