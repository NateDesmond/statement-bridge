// Regression test for FEEDBACK-2026-09-16.md Section B items 1, 2 and 6, built
// against a fixture modelled on a real DBS credit card CSV export: CR/DR
// suffixes on the amount column, and the exact summary lines a real export showed
// ("Current balance", "Available credit limit", "Reward points available").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGrid, applyProfileVersion } from '../src/core/csv.js';
import { normalizeRecords } from '../src/core/normalize.js';
import { fileSummary, countCheck } from '../src/core/checks.js';
import { builtinProfiles } from '../src/core/builtin-profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'harbour_card_crdr.csv');

function load() {
  const text = fs.readFileSync(fixturePath, 'utf-8');
  const profile = builtinProfiles().find((p) => p.id === 'builtin-harbour-card');
  const version = profile.versions.find((v) => v.id === 'builtin-harbour-card-v2-crdr');
  return { text, profile, version };
}

test('item 1: summary lines with no parseable date or amount are skipped, not flagged transactions', async () => {
  const { text, version } = load();
  const grid = await parseGrid(text);
  const { records } = applyProfileVersion(grid, version.csv);
  assert.equal(records.length, 7, '4 real transactions + 3 summary lines');

  const rows = normalizeRecords(records, version, { bank: 'DBS', statementType: 'credit_card', currency: 'SGD', sourceFile: 'harbour_card_crdr.csv' });
  const skipped = rows.filter((r) => r.skipped);
  const transactions = rows.filter((r) => !r.skipped);
  assert.equal(skipped.length, 3, 'Current balance / Available credit limit / Reward points available');
  assert.equal(transactions.length, 4);
  assert.ok(skipped.every((r) => r.flags.length === 0), 'skipped lines are not flagged');
  assert.ok(transactions.every((r) => r.flags.length === 0), 'zero flagged rows among real transactions');
});

test('item 2: CR/DR marker overrides sign convention for correct signs regardless of profile default', async () => {
  const { text, version } = load();
  const grid = await parseGrid(text);
  const { records } = applyProfileVersion(grid, version.csv);
  const rows = normalizeRecords(records, version, { bank: 'DBS', statementType: 'credit_card', currency: 'SGD', sourceFile: 'harbour_card_crdr.csv' });
  const transactions = rows.filter((r) => !r.skipped);

  assert.deepEqual(transactions.map((r) => r.description_raw), [
    'GRAB* RIDE SINGAPORE SG', 'AMAZON WEB SERVICES SG', 'PAYMENT RECEIVED THANK YOU', 'SHOPEE SINGAPORE',
  ]);
  // DR (debit/charge) = money out = negative; CR (payment) = money in = positive,
  // even though the profile's own signConvention is positiveIsOut.
  assert.deepEqual(transactions.map((r) => r.amount), [-4500, -12050, 50000, -2990]);
});

test('item 6: per-file summary respects post-fix signs and excludes skipped lines from the row count', async () => {
  const { text, version } = load();
  const grid = await parseGrid(text);
  const { records } = applyProfileVersion(grid, version.csv);
  const rows = normalizeRecords(records, version, { bank: 'DBS', statementType: 'credit_card', currency: 'SGD', sourceFile: 'harbour_card_crdr.csv' });

  const summary = fileSummary(rows);
  assert.equal(summary.rowCount, 4, 'skipped summary lines are not counted as rows');
  assert.equal(summary.byCurrency.SGD.in, 50000);
  assert.equal(summary.byCurrency.SGD.out, 4500 + 12050 + 2990);

  // Count check: extractedCount includes the 3 skipped lines (they were still
  // extracted as raw records); sourceLines only counts the 4 date-led lines.
  // The gap is fully explained by the skipped-line count, not a real mismatch.
  const counts = countCheck(text, rows.length);
  assert.equal(counts.extractedCount, 7);
  assert.equal(counts.sourceLines, 4);
  assert.equal(counts.diff, 3);
  const skippedCount = rows.filter((r) => r.skipped).length;
  assert.equal(counts.diff, skippedCount, 'the whole count gap is skipped summary lines, no unexplained flagged remainder');
});
