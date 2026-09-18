import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeAmountOrDate,
  pixelBoxToPdfSpace,
  tesseractLinesToItems,
  mergeSecondPass,
  findAmountRetryCandidates,
  retryCropBoxPdf,
  applyAmountRetryResults,
  groupOcrItemsIntoLines,
} from '../src/core/ocr.js';

test('looksLikeAmountOrDate matches amounts, dates, currency codes, bare day/month numbers', () => {
  assert.equal(looksLikeAmountOrDate('20.83'), true);
  assert.equal(looksLikeAmountOrDate('-20.83'), true);
  assert.equal(looksLikeAmountOrDate('4,200.00'), true);
  assert.equal(looksLikeAmountOrDate('01/06/2026'), true);
  assert.equal(looksLikeAmountOrDate('15'), true);
  assert.equal(looksLikeAmountOrDate('SGD'), true);
  assert.equal(looksLikeAmountOrDate('USD'), true);
  assert.equal(looksLikeAmountOrDate('LAZADA'), false);
  assert.equal(looksLikeAmountOrDate(''), false);
});

test('pixelBoxToPdfSpace divides by scale and flips y to PDF-space (origin bottom-left)', () => {
  // A page rendered at scale 2.5, page height 792pt (US Letter). A word bbox
  // near the top of the page (small pixel y) should land near y=792 in PDF
  // space; one near the bottom (large pixel y) should land near y=0.
  const scale = 2.5;
  const pageHeightPt = 792;
  const topWord = { x0: 100, y0: 20, x1: 200, y1: 40 }; // near top of page
  const top = pixelBoxToPdfSpace(topWord, scale, pageHeightPt);
  assert.equal(top.x, 40); // 100/2.5
  assert.equal(top.width, 40); // (200-100)/2.5
  assert.equal(top.height, 8); // (40-20)/2.5
  assert.ok(top.y > 770 && top.y < 792, `expected near top, got ${top.y}`);

  const bottomWord = { x0: 100, y0: 1950, x1: 200, y1: 1970 }; // near bottom (792*2.5=1980)
  const bottom = pixelBoxToPdfSpace(bottomWord, scale, pageHeightPt);
  assert.ok(bottom.y < 20, `expected near bottom, got ${bottom.y}`);
  assert.ok(bottom.y < top.y);
});

test('tesseractLinesToItems gives every word in a Tesseract line the same shared y', () => {
  const lines = [
    {
      bbox: { x0: 40, y0: 100, x1: 400, y1: 130 },
      words: [
        { text: 'Coffee', confidence: 92, bbox: { x0: 40, y0: 98, x1: 150, y1: 128 } }, // slightly jittery bbox
        { text: 'House', confidence: 90, bbox: { x0: 155, y0: 102, x1: 250, y1: 131 } },
      ],
    },
    {
      bbox: { x0: 40, y0: 200, x1: 300, y1: 230 },
      words: [{ text: '20.83', confidence: 95, bbox: { x0: 250, y0: 199, x1: 320, y1: 229 } }],
    },
  ];
  const scale = 2;
  const pageHeightPt = 400;
  const items = tesseractLinesToItems(lines, scale, pageHeightPt);
  assert.equal(items.length, 3);
  assert.equal(items[0].y, items[1].y, 'words in the same Tesseract line share one y');
  assert.notEqual(items[0].y, items[2].y, 'words in different lines get different y');
  assert.equal(items[0].str, 'Coffee');
  assert.equal(items[2].confidence, 95);
});

test('tesseractLinesToItems drops blank/whitespace-only words', () => {
  const lines = [{ bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, words: [{ text: '  ', confidence: 10, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }] }];
  assert.deepEqual(tesseractLinesToItems(lines, 1, 100), []);
});

test('mergeSecondPass replaces an item only when the second pass improves confidence', () => {
  const items = [
    { str: 'Z0.83', x: 0, y: 0, width: 10, height: 5, confidence: 55 },
    { str: 'LAZADA', x: 20, y: 0, width: 10, height: 5, confidence: 91 },
  ];
  const merged = mergeSecondPass(items, [0], [{ str: '20.83', confidence: 88 }]);
  assert.equal(merged[0].str, '20.83');
  assert.equal(merged[0].confidence, 88);
  assert.equal(merged[1].str, 'LAZADA', 'untouched item unchanged');
});

test('mergeSecondPass keeps the original when the second pass is not better', () => {
  const items = [{ str: '20.83', x: 0, y: 0, width: 10, height: 5, confidence: 91 }];
  const merged = mergeSecondPass(items, [0], [{ str: '2O.83', confidence: 60 }]);
  assert.equal(merged[0].str, '20.83');
  assert.equal(merged[0].confidence, 91);
});

test('mergeSecondPass ignores a blank second-pass result even if "higher confidence"', () => {
  const items = [{ str: '20.83', x: 0, y: 0, width: 10, height: 5, confidence: 40 }];
  const merged = mergeSecondPass(items, [0], [{ str: '   ', confidence: 99 }]);
  assert.equal(merged[0].str, '20.83');
});

test('findAmountRetryCandidates flags a fused currency+sign+digits token with no decimal (never caught by shape alone)', () => {
  const items = [
    { str: 'LAZADA', x: 40, y: 500, width: 60, height: 10, confidence: 90 },
    { str: 'SGD-173', x: 110, y: 500, width: 50, height: 10, confidence: 88 },
  ];
  assert.equal(looksLikeAmountOrDate('SGD-173'), false, 'the fused token never looks like an amount or date on its own');
  const candidates = findAmountRetryCandidates(items);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].hasDecimal, false);
  assert.equal(candidates[0].matchedText, 'SGD-173');
  assert.equal(candidates[0].prefixEnd, 3);
  assert.deepEqual(candidates[0].itemIndexes, [1]);
});

test('findAmountRetryCandidates leaves an already-decimalled amount alone (hasDecimal true, no retry needed)', () => {
  const items = [{ str: 'SGD-20.83', x: 100, y: 200, width: 60, height: 10, confidence: 91 }];
  const candidates = findAmountRetryCandidates(items);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].hasDecimal, true);
});

test('retryCropBoxPdf starts past the currency prefix, spans to the end of the matched items', () => {
  const items = [{ str: 'SGD-173', x: 110, y: 500, width: 49, height: 10, confidence: 88 }];
  const candidate = { itemIndexes: [0], matchedText: 'SGD-173', prefixEnd: 3 };
  const box = retryCropBoxPdf(items, candidate);
  assert.ok(box.x0 > 110 && box.x0 < 159, `expected x0 between item bounds, got ${box.x0}`);
  assert.equal(Math.round(box.x0 * 100), Math.round((110 + (3 / 7) * 49) * 100));
  assert.equal(box.xEnd, 159);
  assert.equal(box.yBot, 500);
  assert.equal(box.yTop, 510);
});

test('applyAmountRetryResults merges an accepted retry, preserving the currency prefix from the first pass', () => {
  const items = [{ str: 'SGD-173', x: 100, y: 500, width: 50, height: 10, confidence: 55 }];
  const candidates = [
    { itemIndexes: [0], matchedText: 'SGD-173', prefixEnd: 3, hasDecimal: false, retryStr: '-1.73', retryConfidence: 92 },
  ];
  const out = applyAmountRetryResults(items, candidates);
  assert.equal(out.length, 1);
  assert.equal(out[0].str, 'SGD-1.73');
  assert.equal(out[0].confidence, 92);
});

test('applyAmountRetryResults rejects a retry that is still not a well-formed decimal', () => {
  const items = [{ str: 'SGD-173', x: 100, y: 500, width: 50, height: 10, confidence: 55 }];
  const candidates = [
    { itemIndexes: [0], matchedText: 'SGD-173', prefixEnd: 3, hasDecimal: false, retryStr: '-173', retryConfidence: 92 },
  ];
  const out = applyAmountRetryResults(items, candidates);
  assert.equal(out[0].str, 'SGD-173', 'unchanged - retry text has no decimal either');
});

test('applyAmountRetryResults never lets a still-round-numbered amount pass silently when the page is mostly 2-decimal (safety net)', () => {
  const items = [
    { str: 'SGD-1.73', x: 0, y: 0, width: 10, height: 10, confidence: 90 },
    { str: 'SGD-4.20', x: 0, y: 20, width: 10, height: 10, confidence: 90 },
    { str: 'SGD-500', x: 0, y: 40, width: 10, height: 10, confidence: 80 }, // retry never fixed this one
  ];
  const candidates = [
    { itemIndexes: [0], matchedText: 'SGD-1.73', prefixEnd: 3, hasDecimal: true },
    { itemIndexes: [1], matchedText: 'SGD-4.20', prefixEnd: 3, hasDecimal: true },
    { itemIndexes: [2], matchedText: 'SGD-500', prefixEnd: 3, hasDecimal: false },
  ];
  const out = applyAmountRetryResults(items, candidates);
  assert.equal(out[0].confidence, 90, 'untouched - already had a decimal');
  assert.equal(out[1].confidence, 90, 'untouched - already had a decimal');
  assert.equal(out[2].confidence, 0, 'flagged - the one holdout on an otherwise 2-decimal page');
});

test('applyAmountRetryResults does not fire the safety net when round amounts are the norm on the page', () => {
  const items = [
    { str: 'JPY-500', x: 0, y: 0, width: 10, height: 10, confidence: 90 },
    { str: 'JPY-1200', x: 0, y: 20, width: 10, height: 10, confidence: 90 },
    { str: 'JPY-15000', x: 0, y: 40, width: 10, height: 10, confidence: 90 },
  ];
  const candidates = items.map((it, i) => ({ itemIndexes: [i], matchedText: it.str, prefixEnd: 3, hasDecimal: false }));
  const out = applyAmountRetryResults(items, candidates);
  for (const it of out) assert.notEqual(it.confidence, 0);
});

test('groupOcrItemsIntoLines keeps lines clearly outside tolerance separate regardless of x position', () => {
  const items = [
    { str: 'top1', x: 10, y: 200, width: 20, height: 10 },
    { str: 'top2', x: 200, y: 200, width: 20, height: 10 },
    { str: 'bottom1', x: 10, y: 100, width: 20, height: 10 },
    { str: 'bottom2', x: 200, y: 100, width: 20, height: 10 },
  ];
  const lines = groupOcrItemsIntoLines(items);
  assert.equal(lines.length, 2);
  const lineOf = (str) => lines.find((l) => l.items.some((it) => it.str === str));
  assert.equal(lineOf('top1'), lineOf('top2'));
  assert.equal(lineOf('bottom1'), lineOf('bottom2'));
  assert.notEqual(lineOf('top1'), lineOf('bottom1'));
});

test('groupOcrItemsIntoLines tolerance scales with median word height, not a fixed px value', () => {
  const items = [
    { str: 'A', x: 0, y: 100, width: 10, height: 20 }, // large font
    { str: 'B', x: 20, y: 108, width: 10, height: 20 }, // 8pt lower, within 0.5*20=10 tolerance
    { str: 'C', x: 0, y: 200, width: 10, height: 6 }, // small font elsewhere on the page
    { str: 'D', x: 20, y: 204, width: 10, height: 6 }, // 4pt lower, within 0.5*median tolerance
  ];
  const lines = groupOcrItemsIntoLines(items);
  assert.equal(lines.length, 2);
});
