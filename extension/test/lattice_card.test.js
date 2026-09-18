// Regression test for a real tab-padded credit card CSV bug
// (2026-09-17): Home showed "Empty / No transactions found" for a real
// export. Root cause was suggestMapping letting a mostly-blank "Foreign
// Currency Amount" column tie with the fully-filled "SGD Amount" column for
// the primary 'amount' field (blank counted as a valid shape for either),
// and win by column order - every local-currency row then had no amount at
// all. Fixture reproduces the file's exact shape (anonymised): three/five
// leading tabs per data row, tab-only separator lines, a preamble above the
// header, DR/CR suffixes, one foreign-currency row, and [UNPOSTED] rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDelimiter, hasTransactionLikeRow } from '../src/core/detect.js';
import { parseGrid, applyProfileVersion } from '../src/core/csv.js';
import { suggestMapping, suggestHeaderRow } from '../src/core/suggest.js';
import { normalizeRecords } from '../src/core/normalize.js';
import { matchProfile, MATCH_THRESHOLD } from '../src/core/profiles.js';
import { builtinProfiles } from '../src/core/builtin-profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'lattice_card_tabbed.csv');

function load() {
  const text = fs.readFileSync(fixturePath, 'utf-8');
  const profile = builtinProfiles().find((p) => p.id === 'builtin-lattice-card');
  const version = profile.versions[0];
  return { text, profile, version };
}

test('delimiter detection picks comma, not tab, for a file padded with leading/trailing tabs', () => {
  const { text } = load();
  assert.equal(detectDelimiter(text), ',');
});

test('parseGrid trims leading/trailing tab padding and drops tab-only separator lines', async () => {
  const { text } = load();
  const grid = await parseGrid(text);
  // 2 preamble rows (account line + "Transaction History:" line) + 1 header
  // + 6 data rows = 9; every blank line (2 leading blanks, 5 tab-only
  // separators) is gone, and no cell carries a stray leading/trailing tab.
  assert.equal(grid.length, 9);
  assert.ok(grid.every((row) => row.every((cell) => cell === cell.trim())), 'no cell keeps leading/trailing whitespace');
  const headerRow = suggestHeaderRow(grid);
  assert.deepEqual(grid[headerRow], ['Date', 'DESCRIPTION', 'Foreign Currency Amount', 'SGD Amount']);
});

test('suggestMapping maps amount to the fully-filled "SGD Amount" column, never the mostly-blank "Foreign Currency Amount" one', async () => {
  const { text } = load();
  const grid = await parseGrid(text);
  const headerRow = suggestHeaderRow(grid);
  const sampleRows = grid.slice(headerRow + 1);
  const mapping = suggestMapping(grid[headerRow], sampleRows);
  const amountSuggestion = mapping.find((m) => m.field === 'amount');
  assert.ok(amountSuggestion, 'an amount field is suggested at all');
  assert.equal(amountSuggestion.source, 'SGD Amount');
  assert.ok(!mapping.some((m) => m.source === 'Foreign Currency Amount' && m.field === 'amount'), 'Foreign Currency Amount never wins amount');
});

test('the built-in Lattice Bank credit card profile matches the fixture at >= 0.9 confidence', async () => {
  const { text, profile } = load();
  const grid = await parseGrid(text);
  const headerRow = suggestHeaderRow(grid);
  const preambleText = grid.slice(0, headerRow).flat().join(' ');
  const results = matchProfile({ header: grid[headerRow], preambleText, filename: 'lattice_card_tabbed.csv', fileType: 'csv' }, builtinProfiles());
  const top = results[0];
  assert.equal(top.profile.id, profile.id);
  assert.ok(top.confidence >= 0.9 - 1e-9, `confidence ${top.confidence} >= 0.9`);
  assert.ok(top.confidence >= MATCH_THRESHOLD);
});

test('normalizeRecords: 6 real transactions, correct DR/CR signs, foreign amount kept as an extra column, [UNPOSTED] rows flagged pending (informational)', async () => {
  const { text, version } = load();
  const grid = await parseGrid(text);
  const { records } = applyProfileVersion(grid, version.csv);
  assert.equal(records.length, 6);

  const rows = normalizeRecords(records, version, { bank: 'Lattice Bank', statementType: 'credit_card', currency: 'SGD', sourceFile: 'lattice_card_tabbed.csv' });
  assert.ok(rows.every((r) => !r.skipped));
  assert.ok(rows.every((r) => r.amount != null), 'every row has a real amount - the root-cause bug left every non-foreign row with amount: null');

  // DR = money out = negative, CR = money in = positive, regardless of the
  // declared signConvention (the marker always wins, normalize.js).
  assert.deepEqual(rows.map((r) => r.amount), [-1250, -480, -8620, 20000, -1598, -920]);

  const foreignRow = rows.find((r) => r.description_raw.includes('GLOBAL WIDGETS'));
  assert.equal(foreignRow.extra_foreign_currency_amount, 'USD 65.00', 'the foreign-currency value is preserved, not lost');

  const pendingRows = rows.filter((r) => r.flags.includes('pending'));
  assert.equal(pendingRows.length, 2);
  assert.ok(pendingRows.every((r) => r.description_raw.startsWith('[UNPOSTED]')), 'description_raw is never stripped of the marker');
});

test('hasTransactionLikeRow is true for this file (never reads as "no transactions found")', async () => {
  const { text } = load();
  const grid = await parseGrid(text);
  assert.ok(hasTransactionLikeRow(grid));
});

test('hasTransactionLikeRow is false for a truly empty/header-only file', async () => {
  const grid = [['Date', 'DESCRIPTION', 'Foreign Currency Amount', 'SGD Amount']];
  assert.ok(!hasTransactionLikeRow(grid));
});
