// Regression suite over five non-grouped-PDF layout fixtures
// (test/fixtures/gen/gen-{uob-grouped-2line,ocbc,chase,maybank,worstcase}-*.mjs,
// renamed to fictional banks: Summit/Riverside/Anchor/Palisade), run through
// the exact auto-detect path an unmapped file gets (dev/auto-version.mjs,
// shared with the OCR/image dev harness so both measure the same thing) -
// TEXT versions here (pdf.js's real text layer, no OCR, fast), asserting
// recall === 100% and extras === 0 on every one. The OCR/image versions of
// the same fixtures are measured by dev/ocr-recall-audit.mjs (bundled
// Chromium; not part of `node --test`, since Tesseract has no meaningful
// Node harness here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPdfPages, groupItemsIntoLines } from '../src/core/pdf.js';
import { normalizeRecords } from '../src/core/normalize.js';
import { buildAutoVersion, pdfPageWidthPt } from '../dev/auto-version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const FIXTURES = [
  { name: 'summit_grouped_2line', expectRowModel: 'grouped' },
  { name: 'riverside_columns', expectRowModel: 'columns' },
  { name: 'anchor_columns', expectRowModel: 'columns' },
  { name: 'palisade_columns', expectRowModel: 'columns' },
  { name: 'worstcase_grouped_3line', expectRowModel: 'grouped' },
];

async function measure(name) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.pdf`)));
  const truth = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.truth.json`), 'utf-8'));
  const pages = await loadPdfPages(bytes);
  const pagesLines = pages.map((p) => groupItemsIntoLines(p.items));
  const pageWidthPt = await pdfPageWidthPt(bytes);
  const { detected, version, records } = buildAutoVersion(pagesLines, pageWidthPt);
  const rows = normalizeRecords(records, version, { ocr: false, currency: 'SGD' }).filter((r) => !r.skipped);

  // Match by (date ISO, signed amount in MINOR units - row.amount is
  // already minor units/cents; truth.amount is dollars).
  const key = (dateISO, amountMinor) => `${dateISO}|${Math.round(amountMinor)}`;
  const truthByKey = new Map();
  truth.forEach((t, i) => {
    const k = key(t.date, Math.round(t.amount * 100));
    if (!truthByKey.has(k)) truthByKey.set(k, []);
    truthByKey.get(k).push(i);
  });
  const matchedTruthIdx = new Set();
  const extras = [];
  for (const row of rows) {
    const k = key(row.date, row.amount);
    const bucket = truthByKey.get(k);
    if (bucket && bucket.length) matchedTruthIdx.add(bucket.shift());
    else extras.push(row);
  }
  const misses = truth.map((t, i) => ({ ...t, idx: i })).filter((t) => !matchedTruthIdx.has(t.idx));
  return { detected, truth, rows, matches: matchedTruthIdx.size, misses, extras };
}

for (const { name, expectRowModel } of FIXTURES) {
  test(`OCR-generalisation (text version): ${name} - recall 100%, 0 extras`, async () => {
    const { detected, truth, matches, misses, extras } = await measure(name);
    assert.equal(detected.rowModel, expectRowModel, `rowModel auto-detected as ${expectRowModel}`);
    assert.equal(matches, truth.length, `all ${truth.length} truth transactions matched (misses: ${JSON.stringify(misses.map((m) => m.idx))})`);
    assert.equal(extras.length, 0, `no extra/phantom rows (found ${extras.length}: ${JSON.stringify(extras.map((r) => ({ date: r.date, amount: r.amount })))})`);
  });
}
