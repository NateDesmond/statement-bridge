import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../src/core/storage.js';
import {
  loadProfiles, createProfile, updateProfile, deleteProfile, duplicateProfile,
  matchProfile, serializeBackup, parseBackup, restoreBackup, MATCH_THRESHOLD,
  pdfAnchorCandidates, filenameSignature, isPlausibleAnchorPhrase, fuzzyPhraseInText,
  learnSignatures, setProfilePasswordHint, guessProfileByFilename,
} from '../src/core/profiles.js';
import { parseGrid, applyProfileVersion } from '../src/core/csv.js';
import { builtinProfiles } from '../src/core/builtin-profiles.js';
import { normalizeRecords } from '../src/core/normalize.js';
import { countCheck, balanceCheck } from '../src/core/checks.js';
import { suggestHeaderRow } from '../src/core/suggest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

// Regression suite (item 4): every CSV fixture that has a corresponding
// built-in profile must still match it cleanly - >= 0.9 confidence, never
// formatChanged - using the SAME header-row auto-detection Home actually
// uses (suggestHeaderRow), not a hand-picked index. A scoring change that
// only happens to work against one bank's fixture (the mistake that caused
// this regression) fails this table for every OTHER bank too, instead of
// silently shipping.
const CSV_FIXTURE_PROFILES = [
  ['meridian_savings.csv', 'builtin-meridian-savings', 'builtin-meridian-savings-v1', 0.9],
  ['meridian_savings_real_export.csv', 'builtin-meridian-savings', 'builtin-meridian-savings-v2', 0.9],
  // A deliberate header variant (Transaction Ref instead of Reference) - see
  // the 'meridian_savings_alt_header fixture' test above - so its own bar is lower, just
  // still a clean, non-formatChanged match.
  ['meridian_savings_alt_header.csv', 'builtin-meridian-savings', 'builtin-meridian-savings-v1', 0.8],
  ['harbour_card.csv', 'builtin-harbour-card', 'builtin-harbour-card-v1', 0.9],
  ['harbour_card_crdr.csv', 'builtin-harbour-card', 'builtin-harbour-card-v2-crdr', 0.9],
  ['riverside_savings.csv', 'builtin-riverside-savings', 'builtin-riverside-savings-v1', 0.9],
  ['summit_savings.csv', 'builtin-summit-savings', 'builtin-summit-savings-v1', 0.9],
  ['anchor_checking.csv', 'builtin-anchor-checking', 'builtin-anchor-checking-v1', 0.9],
  ['lattice_card_tabbed.csv', 'builtin-lattice-card', 'builtin-lattice-card-v1', 0.9],
];

for (const [file, profileId, versionId, minConfidence] of CSV_FIXTURE_PROFILES) {
  test(`regression: ${file} matches ${versionId} at >= ${minConfidence} confidence, formatChanged false`, async () => {
    const text = fs.readFileSync(path.join(fixturesDir, file), 'utf-8');
    const grid = await parseGrid(text);
    const guess = suggestHeaderRow(grid);
    assert.ok(guess >= 0, `suggestHeaderRow found no header row in ${file}`);
    const signals = {
      header: grid[guess],
      preambleText: grid.slice(0, guess).flat().join(' '),
      filename: file,
      fileType: 'csv',
    };
    const results = matchProfile(signals, builtinProfiles());
    assert.ok(results.length > 0, `expected a match for ${file}`);
    assert.equal(results[0].profile.id, profileId);
    assert.equal(results[0].version.id, versionId);
    assert.ok(results[0].confidence >= minConfidence, `expected confidence >= ${minConfidence} for ${file}, got ${results[0].confidence}`);
    assert.equal(results[0].formatChanged, false, `expected formatChanged false for ${file}`);
  });
}

async function fixtureSignals(filename, headerRow) {
  const text = fs.readFileSync(path.join(fixturesDir, filename), 'utf-8');
  const grid = await parseGrid(text);
  return {
    header: grid[headerRow],
    preambleText: grid.slice(0, headerRow).map((r) => r.join(' ')).join('\n'),
    filename,
  };
}

test('loadProfiles seeds built-in profiles on first load', async () => {
  const storage = createMemoryStorage();
  const profiles = await loadProfiles(storage);
  assert.equal(profiles.length, builtinProfiles().length);
  assert.ok(profiles.every((p) => p.builtIn));
});

// Root cause: a device that already seeded profiles (e.g. before
// builtin-meridian-savings-v2 shipped) never re-seeds, so a later
// builtin-profiles.js update - a whole new built-in profile, or just a new
// version on an existing one - silently never reached it. loadProfiles must
// merge those in by id on every load, without touching anything the user
// already has (their own profiles, or learned alternatives on an existing
// built-in version).
test('loadProfiles merges a newly-added builtin version into an already-seeded install', async () => {
  const storage = createMemoryStorage();
  const staleMeridianSavings = {
    schemaVersion: 1, id: 'builtin-meridian-savings', bank: 'Meridian Bank', statementType: 'savings', fileType: 'csv',
    country: 'SG', defaultCurrency: 'SGD', name: 'Meridian Bank savings, CSV', builtIn: true,
    versions: [builtinProfiles().find((p) => p.id === 'builtin-meridian-savings').versions[0]], // only v1, as if seeded before v2-real existed
  };
  await storage.set('profiles', [staleMeridianSavings]);

  const profiles = await loadProfiles(storage);
  const meridianSavings = profiles.find((p) => p.id === 'builtin-meridian-savings');
  assert.equal(meridianSavings.versions.length, 2, 'the newly-added v2-real version must be merged in');
  assert.ok(meridianSavings.versions.some((v) => v.id === 'builtin-meridian-savings-v2'));
  // Every other built-in profile (an entirely new bank added later) must also arrive.
  assert.equal(profiles.length, builtinProfiles().length);
  // Persisted, not just returned in-memory.
  const persisted = await storage.get('profiles');
  assert.ok(persisted.find((p) => p.id === 'builtin-meridian-savings').versions.some((v) => v.id === 'builtin-meridian-savings-v2'));
});

test('loadProfiles never touches a user-created profile or a learned alternative on an existing builtin version', async () => {
  const storage = createMemoryStorage();
  const staleMeridianSavings = JSON.parse(JSON.stringify(builtinProfiles().find((p) => p.id === 'builtin-meridian-savings')));
  staleMeridianSavings.versions[0].signatures.alternatives = [{ headerText: ['learned'], preambleKeywords: [], pdfAnchors: [], filenamePattern: '' }];
  const userProfile = { schemaVersion: 1, id: 'user-1', bank: 'MyBank', name: 'My Bank', builtIn: false, versions: [] };
  await storage.set('profiles', [staleMeridianSavings, userProfile]);

  const profiles = await loadProfiles(storage);
  assert.ok(profiles.some((p) => p.id === 'user-1'));
  const meridianSavings = profiles.find((p) => p.id === 'builtin-meridian-savings');
  assert.deepEqual(meridianSavings.versions[0].signatures.alternatives, staleMeridianSavings.versions[0].signatures.alternatives);
});

test('CRUD: create, update, duplicate, delete', async () => {
  const storage = createMemoryStorage();
  await loadProfiles(storage);
  const created = await createProfile(storage, { name: 'My Bank', bank: 'MyBank', versions: [] });
  assert.ok(created.id);
  const updated = await updateProfile(storage, created.id, { name: 'Renamed Bank' });
  assert.equal(updated.name, 'Renamed Bank');
  const dup = await duplicateProfile(storage, created.id);
  assert.equal(dup.name, 'Renamed Bank (copy)');
  assert.notEqual(dup.id, created.id);
  const afterDelete = await deleteProfile(storage, created.id);
  assert.ok(!afterDelete.some((p) => p.id === created.id));
  assert.ok(afterDelete.some((p) => p.id === dup.id));
});

test('matches Meridian Bank savings fixture above threshold', async () => {
  const signals = await fixtureSignals('meridian_savings.csv', 4);
  const results = matchProfile(signals, builtinProfiles());
  assert.ok(results.length > 0);
  assert.equal(results[0].profile.id, 'builtin-meridian-savings');
  assert.ok(results[0].confidence >= MATCH_THRESHOLD);
});

test('matches Harbour Card credit card fixture', async () => {
  const signals = await fixtureSignals('harbour_card.csv', 4);
  const results = matchProfile(signals, builtinProfiles());
  assert.equal(results[0].profile.id, 'builtin-harbour-card');
});

test('matches Riverside Bank savings fixture', async () => {
  const signals = await fixtureSignals('riverside_savings.csv', 4);
  const results = matchProfile(signals, builtinProfiles());
  assert.equal(results[0].profile.id, 'builtin-riverside-savings');
});

test('matches Summit Bank savings fixture (unusual preamble depth)', async () => {
  const signals = await fixtureSignals('summit_savings.csv', 12);
  const results = matchProfile(signals, builtinProfiles());
  assert.equal(results[0].profile.id, 'builtin-summit-savings');
});

test('matches Anchor Bank checking fixture', async () => {
  const signals = await fixtureSignals('anchor_checking.csv', 0);
  const results = matchProfile(signals, builtinProfiles());
  assert.equal(results[0].profile.id, 'builtin-anchor-checking');
});

test('meridian_savings_alt_header fixture (Transaction Ref column, TOTAL: footer) extracts 5 clean rows with descriptions and a reconciling balance', async () => {
  const text = fs.readFileSync(path.join(fixturesDir, 'meridian_savings_alt_header.csv'), 'utf-8');
  const grid = await parseGrid(text);
  const profile = builtinProfiles().find((p) => p.id === 'builtin-meridian-savings');
  const version = profile.versions[0];

  const signals = await fixtureSignals('meridian_savings_alt_header.csv', 4);
  const results = matchProfile(signals, builtinProfiles());
  assert.equal(results[0].profile.id, 'builtin-meridian-savings', 'still matches on preamble/header overlap despite the header variant');

  const { records } = applyProfileVersion(grid, version.csv);
  assert.equal(records.length, 5, 'the TOTAL: footer row must not be parsed as a transaction');

  const rows = normalizeRecords(records, version, { bank: profile.bank, statementType: profile.statementType, currency: profile.defaultCurrency, sourceFile: 'meridian_savings_alt_header.csv' });
  assert.ok(rows.every((r) => r.description_raw), 'every row must have a non-empty description');
  assert.deepEqual(rows.map((r) => r.description_raw), [
    'NETS PAY 8817 SHENG SIONG', 'GIRO SP SERVICES', 'PAYNOW TRANSFER FROM JANE LEE',
    'SALARY GIRO CREDIT ACME PTE LTD', 'VISA DEBIT NTUC FAIRPRICE',
  ]);

  const counts = countCheck(text, rows.length);
  assert.equal(counts.extractedCount, 5);
  assert.equal(counts.sourceLines, 5);
  assert.ok(counts.matches);

  const balance = balanceCheck(rows);
  assert.equal(balance.reconciles, true);
  assert.equal(balance.firstFailingRow, null);
});

test('meridian_savings_real_export fixture (a real bank CSV export shape, verified 2026-09-16) matches builtin-meridian-savings v2 and parses cleanly', async () => {
  const text = fs.readFileSync(path.join(fixturesDir, 'meridian_savings_real_export.csv'), 'utf-8');
  const grid = await parseGrid(text);
  const signals = await fixtureSignals('meridian_savings_real_export.csv', 8);
  const results = matchProfile(signals, builtinProfiles());
  assert.equal(results[0].profile.id, 'builtin-meridian-savings');
  assert.equal(results[0].version.id, 'builtin-meridian-savings-v2');
  assert.equal(results[0].formatChanged, false);

  const { records } = applyProfileVersion(grid, results[0].version.csv);
  assert.equal(records.length, 5);
  const rows = normalizeRecords(records, results[0].version, { bank: 'Meridian Bank', statementType: 'savings', currency: 'SGD', sourceFile: 'meridian_savings_real_export.csv' });
  assert.deepEqual(rows.map((r) => r.amount), [-2083, 420000, -4820, -1460, -21630]);
  assert.deepEqual(rows.map((r) => r.date), ['2026-09-15', '2026-09-15', '2026-09-14', '2026-09-12', '2026-09-12']);
  assert.ok(rows.every((r) => r.currency === 'SGD'));
  assert.ok(rows.every((r) => !r.flags.length), 'a clean real-shape import should have no flags');

  const counts = countCheck(text, rows.length);
  assert.ok(counts.matches, `count check should recognize the quoted "D Mon YYYY" date lines: ${JSON.stringify(counts)}`);
});

// Finding 3 (QA 2026-09-16): a synthetic unrelated-bank CSV with renamed
// headers and no bank branding anywhere was matching "Harbour Card credit card, CSV"
// as "Layout changed" instead of "New statement", because the profile's
// preambleKeywords list ('Harbour Card', 'Cardmember') let a single generic
// word ("Cardmember") alone clear the old keyword-score bar.
test('Finding 3: an unrelated bank CSV with different headers and no bank branding is not matched or flagged layout-changed', () => {
  const signals = {
    header: ['Txn Dt', 'Notes', 'Amt SGD'],
    preambleText: 'Generic Bank Ltd Cardmember Terms Apply',
    filename: 'generic_bank_card.csv',
    fileType: 'csv',
  };
  const results = matchProfile(signals, builtinProfiles());
  assert.equal(results.length, 0, `expected no match/layout-changed candidates, got ${JSON.stringify(results.map((r) => r.profile.id))}`);
});

test('Finding 3: dbs_savings_real_export fixture still matches builtin-meridian-savings v2 at >= 0.9 confidence', async () => {
  const signals = await fixtureSignals('meridian_savings_real_export.csv', 8);
  const results = matchProfile(signals, builtinProfiles());
  assert.equal(results[0].profile.id, 'builtin-meridian-savings');
  assert.equal(results[0].version.id, 'builtin-meridian-savings-v2');
  assert.ok(results[0].confidence >= 0.9, `expected confidence >= 0.9, got ${results[0].confidence}`);
  assert.equal(results[0].formatChanged, false);
});

// Regression: the fixture's preamble now mirrors the a real export's raw
// trailing-comma style (not every empty cell individually quoted), so a
// scoring change that only happens to work against the old, differently-
// encoded fixture text would still be caught here. Exercises the whole
// pipeline (parseGrid -> matchProfile -> buildFileRows), same path Home
// uses, and pins the exact row count of the real 5-transaction export.
test('Finding 3: dbs_savings_real_export fixture parses to 5 flag-free rows via the real pipeline', async () => {
  const grid = await parseGrid(fs.readFileSync(path.join(fixturesDir, 'meridian_savings_real_export.csv'), 'utf-8'));
  const signals = { header: grid[8], preambleText: grid.slice(0, 8).flat().join(' '), filename: 'meridian_savings_real_export.csv', fileType: 'csv' };
  const results = matchProfile(signals, builtinProfiles());
  const best = results[0];
  assert.equal(best.version.id, 'builtin-meridian-savings-v2');
  const records = applyProfileVersion(grid, best.version.csv).records;
  const rows = normalizeRecords(records, best.version, { bank: 'Meridian Bank', statementType: 'savings', currency: 'SGD' });
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((r) => r.flags?.length).length, 0);
});

test('Finding 3: a DBS CSV with one renamed column is flagged layout-changed, not a silent match or a new statement', () => {
  const signals = {
    header: ['Txn Dt', 'Description', 'Amount (SGD)'], // "Transaction Date" renamed
    preambleText: 'Harbour Card Cardmember: JANE TAN',
    filename: 'harbour_export_2026.csv', // no "credit" so filename score alone can't carry it
    fileType: 'csv',
  };
  const results = matchProfile(signals, builtinProfiles());
  const dbsCard = results.find((r) => r.profile.id === 'builtin-harbour-card' && r.version.id === 'builtin-harbour-card-v2-crdr');
  assert.ok(dbsCard, 'expected the Harbour Card v2 version to appear as a candidate');
  assert.ok(dbsCard.formatChanged, 'expected formatChanged to be true (layout changed)');
  assert.ok(dbsCard.confidence < MATCH_THRESHOLD, 'a layout-changed candidate must not also read as a confident match');
});

test('flags format-changed when bank preamble matches but headers differ', () => {
  const signals = {
    header: ['Date', 'Totally Different Header'],
    preambleText: 'Meridian Bank Account Details For',
    filename: 'meridian_savings_new.csv',
  };
  const results = matchProfile(signals, builtinProfiles());
  const dbsResult = results.find((r) => r.profile.id === 'builtin-meridian-savings');
  assert.ok(dbsResult.formatChanged);
});

test('matches the built-in Northwind Bank Transaction History PDF profile from page-1 text alone (no header row exists for a PDF)', () => {
  const signals = {
    pdfText: 'Transaction History Northwind Current Account Available Balance Ledger Balance',
    preambleText: 'Transaction History Northwind Current Account Available Balance Ledger Balance',
    filename: 'northwind_transaction_history_sample.pdf',
  };
  const results = matchProfile(signals, builtinProfiles());
  const dbsPdf = results.find((r) => r.profile.id === 'builtin-northwind-transaction-history-pdf');
  assert.ok(dbsPdf, 'expected the Northwind Bank Transaction History PDF profile to match');
  assert.ok(dbsPdf.confidence >= MATCH_THRESHOLD);
  assert.equal(dbsPdf.formatChanged, false);
});

test('a PDF profile is never marked formatChanged just for having no header row to compare', () => {
  const signals = { pdfText: 'Transaction History', preambleText: '', filename: 'statement.pdf' };
  const results = matchProfile(signals, builtinProfiles());
  const dbsPdf = results.find((r) => r.profile.id === 'builtin-northwind-transaction-history-pdf');
  assert.equal(dbsPdf.formatChanged, false);
});

test('matchProfile never matches a profile whose fileType differs from the file, even via the formatChanged path', () => {
  // A PDF whose OCR'd text happens to echo Summit Bank's preamble/keywords must never
  // surface "Summit Bank savings, CSV" as a candidate, confident or not: the file
  // literally cannot be opened as that profile's CSV parser.
  const signals = {
    pdfText: 'Summit Bank Limited STATEMENT OF ACCOUNT',
    preambleText: 'Summit Bank Limited STATEMENT OF ACCOUNT',
    filename: 'summit_scan.pdf',
    fileType: 'pdf',
  };
  const results = matchProfile(signals, builtinProfiles());
  assert.ok(!results.some((r) => r.profile.id === 'builtin-summit-savings'), 'a CSV profile must not appear for a PDF file');
});

test('matchProfile with no fileType on the signals keeps the old (unfiltered) behaviour', () => {
  const signals = { header: ['Date', 'Description', 'Withdrawal (SGD)', 'Deposit (SGD)', 'Balance (SGD)'], preambleText: 'Summit Bank Limited', filename: 'summit.csv' };
  const results = matchProfile(signals, builtinProfiles());
  assert.ok(results.some((r) => r.profile.id === 'builtin-summit-savings'));
});

// Finding 1 (2026-09-17, C1): a CSV whose header renames exactly one of a
// profile's required field columns ("Transaction Date" -> "Txn Date", every
// other column unchanged) must never silently auto-match: the date column
// the profile would read from no longer exists.
test('Finding 1: a Meridian Bank savings CSV with only "Transaction Date" renamed to "Txn Date" is never a clean match', async () => {
  const signals = await fixtureSignals('meridian_savings.csv', 4);
  signals.header = signals.header.map((h) => (h === 'Transaction Date' ? 'Txn Date' : h));
  const results = matchProfile(signals, builtinProfiles());
  const dbs = results.find((r) => r.profile.id === 'builtin-meridian-savings');
  assert.ok(dbs, 'expected the Meridian Bank savings profile to still surface as a candidate');
  assert.ok(dbs.confidence < MATCH_THRESHOLD, `expected confidence below threshold, got ${dbs.confidence}`);
  assert.ok(dbs.formatChanged, 'expected formatChanged (layout changed), not a silent match');
});

test('Finding 1: the meridian_savings_alt_header fixture\'s "Transaction Ref" header variant still counts as the required description column present (alternative source list)', async () => {
  const signals = await fixtureSignals('meridian_savings_alt_header.csv', 4);
  const results = matchProfile(signals, builtinProfiles());
  const dbs = results.find((r) => r.profile.id === 'builtin-meridian-savings' && r.version.id === 'builtin-meridian-savings-v1');
  assert.ok(dbs);
  assert.equal(dbs.formatChanged, false);
  assert.ok(dbs.confidence >= MATCH_THRESHOLD);
});

// Finding 3 (C3): anchor_checking.csv is an exact match for its own built-in
// profile (every header column present verbatim) but the Anchor Bank CSV export
// has no preamble text at all above its header row, so the old formula
// permanently capped it at headerSc*0.6 + 0 + filenameSc*0.1 = 0.70 - right
// at MATCH_THRESHOLD, needing a Confirm click on every drop of an exact fixture.
test('Finding 3 (C3): anchor_checking.csv matches its own built-in at >= 0.9 confidence (a profile with no preamble/pdf signature must not be penalised for a signal it never had)', async () => {
  const signals = await fixtureSignals('anchor_checking.csv', 0);
  const results = matchProfile(signals, builtinProfiles());
  assert.equal(results[0].profile.id, 'builtin-anchor-checking');
  assert.ok(results[0].confidence >= 0.9, `expected confidence >= 0.9, got ${results[0].confidence}`);
});

test('backup round-trip preserves profiles', async () => {
  const storage = createMemoryStorage();
  const profiles = await loadProfiles(storage);
  const json = serializeBackup(profiles);
  const restored = parseBackup(json);
  assert.equal(restored.length, profiles.length);
});

test('parseBackup rejects malformed JSON', () => {
  assert.throws(() => parseBackup('not json'));
});

test('parseBackup rejects missing profiles array', () => {
  assert.throws(() => parseBackup(JSON.stringify({ foo: 1 })));
});

test('parseBackup rejects malformed profile entries', () => {
  assert.throws(() => parseBackup(JSON.stringify({ profiles: [{ id: 1 }] })));
});

test('restoreBackup merges into existing storage', async () => {
  const storage = createMemoryStorage();
  await loadProfiles(storage);
  const extra = { schemaVersion: 1, id: 'custom-1', bank: 'X', name: 'Custom', versions: [], builtIn: false };
  const json = JSON.stringify({ profiles: [extra] });
  const merged = await restoreBackup(storage, json);
  assert.ok(merged.some((p) => p.id === 'custom-1'));
  assert.ok(merged.some((p) => p.id === 'builtin-meridian-savings'));
});

// --- Signature generation (Fix 6a) ---------------------------------------

test('pdfAnchorCandidates picks distinctive preamble lines above the first transaction', () => {
  const lines = [
    'DBS Bank Ltd', 'DBS Multiplier Account', 'Transaction History',
    'Account No: 123-456789-0', '15 Sep 2026', 'Grab GRA-123 SGD - 20.83',
  ];
  const out = pdfAnchorCandidates(lines, 4);
  assert.deepEqual(out, ['DBS Bank Ltd', 'DBS Multiplier Account', 'Transaction History']);
});

test('pdfAnchorCandidates excludes digit-heavy and personal-data-shaped lines', () => {
  const lines = [
    'OCBC Bank', 'Blk 123 Jalan Besar', 'Mr Tan Ah Kow', 'Postal 123456', 'Statement of Account',
  ];
  const out = pdfAnchorCandidates(lines, lines.length);
  assert.deepEqual(out, ['OCBC Bank', 'Statement of Account']);
});

test('pdfAnchorCandidates never reaches past the first transaction line', () => {
  const lines = ['UOB Bank', 'Transaction History', '15 Sep 2026', 'UOB Bank (again, after the data starts)'];
  const out = pdfAnchorCandidates(lines, 2);
  assert.deepEqual(out, ['UOB Bank', 'Transaction History']);
});

test('filenameSignature wildcards out digits and month names, keeps only the bank token (item 7)', () => {
  assert.equal(filenameSignature('meridian_2026.pdf'), '^.*meridian.*\\.pdf$');
  assert.equal(filenameSignature('Meridian-Sep2026.PDF'), '^.*meridian.*\\.pdf$');
});

test('filenameSignature falls back to keeping every token when no known bank name is in the filename', () => {
  assert.equal(filenameSignature('acme_export_2026.csv'), '^.*acme.*export.*\\.csv$');
});

test('filenameSignature with nothing left to match on returns empty', () => {
  assert.equal(filenameSignature('2026-09-15.pdf'), '');
});

test('pdfAnchorCandidates excludes a bare ALL-CAPS account-holder name with no bank vocabulary (real regression: 2026-09-16)', () => {
  const lines = ['DBS Bank Ltd', 'JANE SAMPLE TAN', 'DBS Multiplier Account', 'Transaction History'];
  const out = pdfAnchorCandidates(lines, lines.length);
  assert.deepEqual(out, ['DBS Bank Ltd', 'DBS Multiplier Account', 'Transaction History']);
  assert.ok(!out.includes('JANE SAMPLE TAN'));
});

test('pdfAnchorCandidates keeps an ALL-CAPS bank title that does carry statement vocabulary', () => {
  const lines = ['OCBC BANK LTD', 'STATEMENT OF ACCOUNT'];
  const out = pdfAnchorCandidates(lines, lines.length);
  assert.deepEqual(out, ['OCBC BANK LTD', 'STATEMENT OF ACCOUNT']);
});

// --- Item 7: plausibility filter + at-most-3 cap + fuzzy matching --------

test('pdfAnchorCandidates rejects garbage OCR text (mixed-case, no bank/statement vocabulary, never repeats)', () => {
  const lines = ['DBS Bank Ltd', 'Ross Ion Telesty', 'Transaction History'];
  const out = pdfAnchorCandidates(lines, lines.length);
  assert.deepEqual(out, ['DBS Bank Ltd', 'Transaction History']);
});

test('pdfAnchorCandidates keeps a phrase whose tokens simply repeat elsewhere in the file, even with no bank/statement word', () => {
  const lines = ['Acme Financial Corp', 'Acme Financial Corp', 'Transaction History'];
  const out = pdfAnchorCandidates(lines, lines.length, 3, lines.join('\n'));
  assert.ok(out.includes('Acme Financial Corp'));
});

test('pdfAnchorCandidates never returns more than 3, most distinctive first', () => {
  const lines = ['DBS Bank Ltd', 'DBS Multiplier Account', 'Transaction History', 'Savings Statement', '15 Sep 2026'];
  const out = pdfAnchorCandidates(lines, lines.length - 1);
  assert.equal(out.length, 3);
});

test('isPlausibleAnchorPhrase: known bank/statement phrases always pass, one-off garbage never does', () => {
  assert.ok(isPlausibleAnchorPhrase('Transaction History'));
  assert.ok(isPlausibleAnchorPhrase('Meridian Bank Statement'));
  assert.ok(!isPlausibleAnchorPhrase('Ross Ion Telesty', 'Ross Ion Telesty only ever appears once'));
});

test('fuzzyPhraseInText matches a near-miss OCR phrase (Levenshtein <= 2)', () => {
  assert.ok(fuzzyPhraseInText('Transaction History', 'Meridian Bank Transaction Histor Account No 123'));
});

test('fuzzyPhraseInText matches on >=85% token overlap', () => {
  assert.ok(fuzzyPhraseInText('Meridian Bank Statement', 'welcome Meridian Bank Statment of account'));
});

test('fuzzyPhraseInText does not match an unrelated phrase', () => {
  assert.ok(!fuzzyPhraseInText('Transaction History', 'Riverside Bank Ltd Savings Account'));
});

test('matchProfile matches a saved pdfAnchor fuzzily against a slightly different OCR read', async () => {
  const storage = createMemoryStorage();
  const profile = await createProfile(storage, {
    name: 'Test PDF', bank: 'Test Bank', statementType: 'savings', fileType: 'pdf',
    versions: [{
      id: 'v1',
      signatures: { headerText: [], preambleKeywords: [], pdfAnchors: ['Transaction History'], filenamePattern: '' },
      pdf: { rowModel: 'grouped', grouped: { signConvention: 'signed' } },
    }],
  });
  const results = matchProfile({ pdfText: 'Test Bank Transaction Histor Account No 123', filename: 'scan.pdf', fileType: 'pdf' }, [profile]);
  assert.ok(results.some((r) => r.profile.id === profile.id && r.confidence >= MATCH_THRESHOLD));
});

// --- Item 8: learnSignatures ---------------------------------------------

test('learnSignatures folds a new file\'s signals in as an alternative, letting a previously-below-threshold file match', async () => {
  const storage = createMemoryStorage();
  const profile = await createProfile(storage, {
    name: 'Test PDF', bank: 'Test Bank', statementType: 'savings', fileType: 'pdf',
    versions: [{
      id: 'v1',
      signatures: { headerText: [], preambleKeywords: [], pdfAnchors: ['Transaction History'], filenamePattern: '' },
      pdf: { rowModel: 'grouped', grouped: { signConvention: 'signed' } },
    }],
  });
  const newFileSignals = { pdfText: 'Test Bank eStatement Savings Plus', filename: 'test_estatement.pdf', fileType: 'pdf' };
  const before = matchProfile(newFileSignals, [profile]);
  assert.ok(!before.some((r) => r.profile.id === profile.id && r.confidence >= MATCH_THRESHOLD));

  await learnSignatures(storage, profile.id, 'v1', {
    pdfAnchors: ['Test Bank eStatement Savings Plus', 'Ross Ion Telesty'],
    filename: 'test_estatement.pdf',
  });
  const profiles = await loadProfiles(storage);
  const version = profiles.find((p) => p.id === profile.id).versions[0];
  assert.ok(version.signatures.alternatives[0].pdfAnchors.includes('Test Bank eStatement Savings Plus'));
  assert.ok(!version.signatures.alternatives[0].pdfAnchors.includes('Ross Ion Telesty'));

  const after = matchProfile(newFileSignals, profiles);
  assert.ok(after.some((r) => r.profile.id === profile.id && r.confidence >= MATCH_THRESHOLD));
});

// --- Track 2: password-hint per statement type ---------------------------

test('setProfilePasswordHint saves a hint, guessProfileByFilename finds it by filenamePattern', async () => {
  const storage = createMemoryStorage();
  const profile = await createProfile(storage, {
    name: 'Test Bank savings, PDF', bank: 'Test Bank', statementType: 'savings', fileType: 'pdf',
    versions: [{ id: 'v1', signatures: { headerText: [], preambleKeywords: [], pdfAnchors: [], filenamePattern: '^.*test.*\\.pdf$' } }],
  });
  assert.equal(guessProfileByFilename('test_statement.pdf', [profile]), null); // no hint saved yet

  await setProfilePasswordHint(storage, profile.id, 'Usually your ID number plus date of birth');
  const profiles = await loadProfiles(storage);
  assert.equal(profiles.find((p) => p.id === profile.id).passwordHint, 'Usually your ID number plus date of birth');

  const guessed = guessProfileByFilename('test_statement.pdf', profiles);
  assert.equal(guessed?.id, profile.id);
});

test('guessProfileByFilename falls back to the only hinted profile when no filenamePattern matches (a PDF profile usually has none)', async () => {
  const storage = createMemoryStorage();
  const profile = await createProfile(storage, {
    name: 'Test Bank savings, Transaction History PDF', bank: 'Test Bank', statementType: 'savings', fileType: 'pdf',
    versions: [{ id: 'v1', signatures: { headerText: [], preambleKeywords: [], pdfAnchors: ['Transaction History'], filenamePattern: '' } }],
  });
  await setProfilePasswordHint(storage, profile.id, 'Usually your ID number plus date of birth');
  const profiles = await loadProfiles(storage);
  assert.equal(guessProfileByFilename('whatever_export.pdf', profiles)?.id, profile.id);
});

test('guessProfileByFilename shows nothing when two or more profiles have a hint and neither filename matches (ambiguous)', async () => {
  const storage = createMemoryStorage();
  const a = await createProfile(storage, { name: 'Bank A', bank: 'Bank A', statementType: 'savings', fileType: 'pdf', versions: [{ id: 'v1', signatures: { filenamePattern: '' } }] });
  const b = await createProfile(storage, { name: 'Bank B', bank: 'Bank B', statementType: 'savings', fileType: 'pdf', versions: [{ id: 'v1', signatures: { filenamePattern: '' } }] });
  await setProfilePasswordHint(storage, a.id, 'hint a');
  await setProfilePasswordHint(storage, b.id, 'hint b');
  const profiles = await loadProfiles(storage);
  assert.equal(guessProfileByFilename('anything.pdf', profiles), null);
});
