import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fileStatus, maskAccountNumber, defaultAccountLabel, warningRowCount, healthBadge,
  attentionCards, exportReadiness, sinceLastExportRange, detectBankHint, accountsSummaryLabel,
  mergedRowsCaption, dateRangeOfRows, DUPLICATE_DROPPED_CAPTION, sameTransactionsCaption, duplicateDroppedCaption, fileRowLineHtml,
  hasUnreadableDates, notIncludedLabel, sourceIncluded, sourceRangeCountLabel, sourcesSummarySegment, allRowsSkipped,
  removeFileAt, restoreFileAt, matchExtractionFailed, unreadableDateRate,
  extractionQuality, selectMatchCandidate, candidateLossCaption, profileHealthLabel, summarizeExtraction,
} from '../src/core/home-state.js';

function row(over) { return { flags: [], excluded: false, currency: 'SGD', amount: -100, date: '2026-06-01', ...over }; }

test('fileStatus: error, processing, new, layoutChanged, lowConfidence, healthy', () => {
  assert.equal(fileStatus({ error: 'boom' }), 'error');
  assert.equal(fileStatus({ processing: true }), 'processing');
  assert.equal(fileStatus({ matches: [] }), 'new');
  assert.equal(fileStatus({ matches: [{ confidence: 0.5, formatChanged: true }] }), 'layoutChanged');
  assert.equal(fileStatus({ matches: [{ confidence: 0.8, formatChanged: false }] }), 'lowConfidence');
  assert.equal(fileStatus({ matches: [{ confidence: 0.95, formatChanged: false }] }), 'matched');
  assert.equal(fileStatus({ rows: [row()] }), 'healthy');
  assert.equal(fileStatus({ imageOnly: true }), 'imageOnly');
});

test('fileStatus: ocrFailed and ocrCancelled outrank imageOnly (auto-OCR already ran)', () => {
  assert.equal(fileStatus({ imageOnly: true, ocrFailed: true }), 'ocrFailed');
  assert.equal(fileStatus({ imageOnly: true, ocrCancelled: true }), 'ocrCancelled');
  assert.equal(fileStatus({ processing: true, ocrFailed: true }), 'processing');
});

test('item 7: fileStatus is ocrQueued for an image-only file waiting behind another one\'s OCR run, not imageOnly/processing', () => {
  assert.equal(fileStatus({ imageOnly: true, ocrQueued: true }), 'ocrQueued');
  // The actively-running file is 'processing', never 'ocrQueued', even
  // though both are still technically imageOnly at this point.
  assert.equal(fileStatus({ imageOnly: true, processing: true }), 'processing');
});

test('detectBankHint reads DBS/POSB, OCBC, UOB from filename or scraps of text', () => {
  assert.equal(detectBankHint('dbs_transaction_history.pdf'), 'DBS');
  assert.equal(detectBankHint('POSB savings statement'), 'DBS');
  assert.equal(detectBankHint('ocbc_statement.pdf'), 'OCBC');
  assert.equal(detectBankHint('UOB One Card'), 'UOB');
  assert.equal(detectBankHint('unknownbank.pdf'), null);
  assert.equal(detectBankHint(''), null);
});

test('attentionCards shows no card for a plain imageOnly file (auto-OCR starts instead, no question asked)', () => {
  const cards = attentionCards([{ name: 'dbs_scan.pdf', imageOnly: true, imageOnlySample: '' }]);
  assert.deepEqual(cards, []);
});

test('attentionCards surfaces an ocrFailed card with a bank hint, only once OCR itself came up empty', () => {
  const cards = attentionCards([{ name: 'dbs_scan.pdf', ocrFailed: true, imageOnlySample: '' }]);
  assert.deepEqual(cards, [{ kind: 'ocrFailed', fileIndex: 0, name: 'dbs_scan.pdf', bank: 'DBS' }]);
});

test('attentionCards shows no card for an ocrCancelled file (the row itself offers "Read again")', () => {
  const cards = attentionCards([{ name: 'dbs_scan.pdf', ocrCancelled: true }]);
  assert.deepEqual(cards, []);
});

test('maskAccountNumber pulls the last 4 digits from free text', () => {
  assert.equal(maskAccountNumber('Account No: 123-4-567890'), '****7890');
  assert.equal(maskAccountNumber('no account here'), null);
  assert.equal(maskAccountNumber(''), null);
});

// Nit 1 (2026-09-16): the real DBS digibank CSV preamble names the account
// type and number together with no "Account No:"-style label at all, and
// also carries a date and a currency amount right alongside it - the mask
// must find the account digits without being thrown off by either.
test('maskAccountNumber handles the real DBS export shape (account number appended to the account type, no label) and common label variants', () => {
  assert.equal(
    maskAccountNumber('Account Details For: DBS Multiplier Account 123-4-567890 Statement as at: 16 Sep 2026 Available Balance: SGD 8214.12'),
    '****7890',
  );
  assert.equal(maskAccountNumber('Account Number 987654321'), '****4321');
  assert.equal(maskAccountNumber('A/C 555-666-777'), '****6777');
  assert.equal(maskAccountNumber('Statement as at: 16 Sep 2026'), null, 'a bare date must never be mistaken for an account number');
});

test('defaultAccountLabel builds "<bank> <statement type> ****<last4>", never the profile display name', () => {
  const profile = { name: 'Northwind Bank savings, Transaction History PDF', bank: 'DBS', statementType: 'savings' };
  assert.equal(defaultAccountLabel(profile, '****7890'), 'DBS savings ****7890');
  assert.equal(defaultAccountLabel(profile, null), 'DBS savings');
});

test('defaultAccountLabel prefers the profile\'s own accountLabel when set', () => {
  const profile = { name: 'Northwind Bank savings, Transaction History PDF', bank: 'DBS', statementType: 'savings', accountLabel: 'My everyday account' };
  assert.equal(defaultAccountLabel(profile, '****7890'), 'My everyday account');
});

test('defaultAccountLabel falls back to the profile name only if bank/statementType are both missing', () => {
  const profile = { name: 'Custom mapping' };
  assert.equal(defaultAccountLabel(profile, '****1234'), 'Custom mapping ****1234');
});

test('accountsSummaryLabel pluralises rows and accounts correctly', () => {
  assert.equal(accountsSummaryLabel(1, 1), '1 row across 1 account');
  assert.equal(accountsSummaryLabel(5, 1), '5 rows across 1 account');
  assert.equal(accountsSummaryLabel(10, 2), '10 rows across 2 accounts');
  assert.equal(accountsSummaryLabel(0, 0), '0 rows across 0 accounts');
});

test('warningRowCount and healthBadge', () => {
  const rows = [row(), row({ flags: ['possible_duplicate'] }), row({ flags: ['x'], excluded: true })];
  assert.equal(warningRowCount(rows), 1);
  assert.deepEqual(healthBadge(rows), { label: '1 warning', tone: 'warn' });
  assert.deepEqual(healthBadge([row()]), { label: 'All checks pass', tone: 'ok' });
});

test('a clean OCR read (flag "ocr" only) is not a warning; "low_confidence_ocr" is', () => {
  const rows = [row({ flags: ['ocr'] }), row({ flags: ['ocr'] })];
  assert.equal(warningRowCount(rows), 0);
  assert.deepEqual(healthBadge(rows), { label: 'All checks pass', tone: 'ok' });

  const withMisread = [row({ flags: ['ocr'] }), row({ flags: ['ocr', 'low_confidence_ocr'] })];
  assert.equal(warningRowCount(withMisread), 1);
  assert.deepEqual(healthBadge(withMisread), { label: '1 warning', tone: 'warn' });
});

test('item 1/5: healthBadge shows a grouped-rowModel count mismatch, tone by severity, and it wins over a clean row set', () => {
  const rows = [row(), row()];
  assert.deepEqual(healthBadge(rows, { groupedMismatch: { tone: 'neutral', text: '208 rows read, 202 amount lines found in the page text. Small gaps are normal for text recognition. 6 rows could not be matched to a line, check them.', showUpdateMappingLink: false } }), {
    label: '208 rows read, 202 amount lines found in the page text. Small gaps are normal for text recognition. 6 rows could not be matched to a line, check them.', tone: 'warn', showUpdateMappingLink: false,
  });
  assert.deepEqual(healthBadge(rows, { groupedMismatch: { tone: 'fail', text: '29 rows read, 27 amount lines found in the page text (diff -2).', showUpdateMappingLink: true } }), {
    label: '29 rows read, 27 amount lines found in the page text (diff -2).', tone: 'danger', showUpdateMappingLink: true,
  });
  assert.deepEqual(healthBadge(rows, { groupedMismatch: null }), { label: 'All checks pass', tone: 'ok' });
});

test('healthBadge contract: checks are computed pre-merge - a stored "matches" value (null) wins even when rows has since been emptied by cross-file merge', () => {
  // The exact defect this guards: a file whose rows were all merged away
  // into another file must still show "All checks pass", not recompute the
  // grouped count check against its now-empty `rows` (which would report
  // every pre-merge amount line as missing, e.g. "0 rows read, 5 amount
  // lines found ... diff -5"). Home.js is responsible for computing the
  // grouped mismatch once at parse time, before merge, and always passing
  // that stored value here rather than recomputing it from `rows`.
  assert.deepEqual(healthBadge([], { groupedMismatch: null }), { label: 'All checks pass', tone: 'ok' });
});

test('mergedRowsCaption: full merge vs partial overlap wording', () => {
  assert.equal(mergedRowsCaption(5, 5, 'DBS savings ****7890'), '5 rows merged into DBS savings ****7890');
  assert.equal(mergedRowsCaption(1, 1, 'DBS savings ****7890'), '1 row merged into DBS savings ****7890');
  assert.equal(mergedRowsCaption(3, 5, 'DBS savings ****7890'), '3 of 5 rows merged into DBS savings ****7890');
});

// Finding 1 (QA 2026-09-16): a merged-away file's row must keep reporting
// its OWN pre-merge date range/count, never "no dated rows · 0 rows".
test('dateRangeOfRows: the inclusive [start,end] across a row list, or null when nothing is dated', () => {
  assert.deepEqual(dateRangeOfRows([{ date: '2026-09-15' }, { date: '2026-09-12' }, { date: '2026-09-14' }]),
    { startISO: '2026-09-12', endISO: '2026-09-15' });
  assert.deepEqual(dateRangeOfRows([{ date: '2026-09-12' }]), { startISO: '2026-09-12', endISO: '2026-09-12' });
  assert.equal(dateRangeOfRows([]), null);
  assert.equal(dateRangeOfRows([{ date: null }, {}]), null);
});

test('DUPLICATE_DROPPED_CAPTION is a fixed, non-empty string', () => {
  assert.equal(typeof DUPLICATE_DROPPED_CAPTION, 'string');
  assert.ok(DUPLICATE_DROPPED_CAPTION.length > 0);
});

// C2 wording finding: "Dropped twice" reads as the literal same file dropped
// twice - only the identical-filename (and type) re-drop keeps that wording;
// a different name or a different file type (CSV vs PDF) of the same
// statement gets the "same transactions" caption instead.
test('duplicateDroppedCaption: identical filename dropped twice keeps "Dropped twice, second copy ignored."', () => {
  assert.equal(duplicateDroppedCaption(true, 'anchor_checking.csv'), DUPLICATE_DROPPED_CAPTION);
});

test('duplicateDroppedCaption: a different name or file type (CSV vs PDF) reads as "Same transactions as <other file>, not added again."', () => {
  assert.equal(duplicateDroppedCaption(false, 'chase_checking.pdf'), 'Same transactions as chase_checking.pdf, not added again.');
  assert.equal(sameTransactionsCaption('chase_checking.pdf'), 'Same transactions as chase_checking.pdf, not added again.');
});

// Nit 1 (2026-09-16): a file row with no derivable masked account must never
// render a leading "&middot;" separator.
test('fileRowLineHtml joins only the parts present, never a leading separator when the account is missing', () => {
  assert.equal(fileRowLineHtml('****7890', '12 Sep 2026 to 15 Sep 2026', '<span class="num">5 rows</span>'),
    '****7890 &middot; 12 Sep 2026 to 15 Sep 2026 &middot; <span class="num">5 rows</span>');
  assert.equal(fileRowLineHtml(null, '12 Sep 2026 to 15 Sep 2026', '<span class="num">5 rows</span>'),
    '12 Sep 2026 to 15 Sep 2026 &middot; <span class="num">5 rows</span>');
  assert.equal(fileRowLineHtml(undefined, 'no dated rows', '<span class="num">0 rows</span>'),
    'no dated rows &middot; <span class="num">0 rows</span>');
});

test('attentionCards surfaces one card per unresolved file, in file order', () => {
  const files = [
    { name: 'a.csv', matches: [] },
    { name: 'b.csv', matches: [{ confidence: 0.4, formatChanged: true, profile: { name: 'DBS' } }] },
    { name: 'c.csv', matches: [{ confidence: 0.8, formatChanged: false, profile: { name: 'OCBC' } }] },
    { name: 'd.csv', rows: [row({ flags: ['possible_duplicate'] })] },
    { name: 'e.csv', rows: [row({ currency: null })] },
    { name: 'f.csv', rows: [row()] }, // fully healthy, no card
  ];
  const cards = attentionCards(files);
  assert.deepEqual(cards.map((c) => c.kind), ['new', 'layoutChanged', 'lowConfidence', 'warnings', 'currencyUnknown']);
  assert.equal(cards[3].count, 1);
});

test('attentionCards respects dismissal flags', () => {
  const files = [
    { name: 'd.csv', rows: [row({ flags: ['x'] })], warningsDismissed: true },
    { name: 'e.csv', rows: [row({ currency: null })], currencyResolved: true },
  ];
  assert.deepEqual(attentionCards(files), []);
});

test('exportReadiness never blocks on an unmapped/failed file, only on zero rows, missing rate, or no healthy file', () => {
  const healthy = [{ rows: [row()] }];
  assert.deepEqual(exportReadiness(healthy, { rowCountInRange: 5 }), { blocked: false, reasons: [], hasHealthyFile: true, notIncluded: 0, processing: 0 });

  // An unmapped file alongside a healthy one does not block; it's just not included.
  const withUnmapped = [{ rows: [row()] }, { matches: [] }];
  const r1 = exportReadiness(withUnmapped, { rowCountInRange: 5 });
  assert.equal(r1.blocked, false);
  assert.equal(r1.notIncluded, 1);

  const zeroRows = exportReadiness(healthy, { rowCountInRange: 0 });
  assert.equal(zeroRows.blocked, true);
  assert.match(zeroRows.reasons[0], /No rows/);

  const missingRate = exportReadiness(healthy, { rowCountInRange: 5, missingRatePairs: ['USD_SGD'] });
  assert.equal(missingRate.blocked, true);

  const noHealthyFile = exportReadiness([{ matches: [] }], { rowCountInRange: 0 });
  assert.equal(noHealthyFile.blocked, true);
  assert.equal(noHealthyFile.hasHealthyFile, false);
  assert.equal(noHealthyFile.notIncluded, 1);
});

test('sinceLastExportRange starts the day after the earliest marker and flags overlap accounts', () => {
  const result = sinceLastExportRange({ dbs: '2026-08-15', uob: '2026-08-20' }, '2026-09-01');
  assert.equal(result.startISO, '2026-08-16');
  assert.equal(result.endISO, '2026-09-01');
  assert.deepEqual(result.overlapAccounts, ['uob']); // uob's marker is after the suggested start
});

// C1 (2026-09-17): a file whose mapping produced no usable dates (a stale
// profile applied to a renamed-header file, say) must never read as healthy,
// and must never let its rows reach export silently.
test('hasUnreadableDates: false for a clean file, true once more than half the rows are missing date or amount', () => {
  assert.equal(hasUnreadableDates([row(), row(), row()]), false);
  assert.equal(hasUnreadableDates([row({ date: null }), row(), row()]), false); // 1 of 3, not a majority
  assert.equal(hasUnreadableDates([row({ date: null }), row({ date: null }), row()]), true); // 2 of 3
  assert.equal(hasUnreadableDates([row({ amount: null })]), true); // 1 of 1, every row bad
  assert.equal(hasUnreadableDates([]), false);
  // Excluded/skipped rows never count toward the denominator.
  assert.equal(hasUnreadableDates([row({ date: null, excluded: true }), row(), row()]), false);
});

test('fileStatus: a file whose rows are mostly missing a date is "unreadableDates", not "healthy"', () => {
  assert.equal(fileStatus({ rows: [row({ date: null }), row({ date: null }), row()] }), 'unreadableDates');
  assert.equal(fileStatus({ rows: [row(), row()] }), 'healthy');
});

test('fileStatus: an empty or header-only file is "noTransactions"', () => {
  assert.equal(fileStatus({ empty: true }), 'noTransactions');
  assert.equal(fileStatus({ empty: true, matches: [] }), 'noTransactions');
});

test('attentionCards surfaces unreadableDates and noTransactions cards', () => {
  const files = [
    { name: 'a.csv', empty: true },
    { name: 'b.csv', rows: [row({ date: null }), row({ date: null })] },
  ];
  const cards = attentionCards(files);
  assert.deepEqual(cards, [
    { kind: 'noTransactions', fileIndex: 0, name: 'a.csv' },
    { kind: 'unreadableDates', fileIndex: 1, name: 'b.csv' },
  ]);
});

test('notIncludedLabel groups by reason, skips healthy/processing files', () => {
  const files = [
    { rows: [row()] }, // healthy, not counted
    { processing: true }, // not counted
    { matches: [] }, // not mapped yet
    { empty: true }, // not mapped yet (F2 grouped same as "new")
    { rows: [row({ date: null }), row({ date: null })] }, // dates could not be read
  ];
  assert.equal(notIncludedLabel(files), '2 files not included (not mapped yet), 1 file not included (dates could not be read)');
});

test('notIncludedLabel returns empty string when nothing is excluded', () => {
  assert.equal(notIncludedLabel([{ rows: [row()] }]), '');
});

test('sinceLastExportRange with no markers suggests everything up to today, no overlap', () => {
  const result = sinceLastExportRange({}, '2026-09-01');
  assert.equal(result.startISO, null);
  assert.deepEqual(result.overlapAccounts, []);
});

// Item 13: a file whose mapping came from "Use an existing profile" but
// whose checks then failed reads as Layout changed, not a generic parse
// failure - the profile WAS applied, it's just the wrong one.
test('fileStatus: pickedProfileFailed overrides to layoutChanged even with rows present', () => {
  assert.equal(fileStatus({ rows: [{ date: null, amount: null }], pickedProfileFailed: true }), 'layoutChanged');
  assert.equal(fileStatus({ rows: [{ date: '2026-09-01', amount: -100 }], pickedProfileFailed: true }), 'layoutChanged');
});

test('fileStatus: without pickedProfileFailed, a clean apply from an existing profile just reads healthy', () => {
  assert.equal(fileStatus({ rows: [{ date: '2026-09-01', amount: -100 }] }), 'healthy');
});

// Item 14a: Sources section composition logic (pure).
test('sourceIncluded defaults to true, false once unchecked, false for a failed parse regardless', () => {
  assert.equal(sourceIncluded({ rows: [row()] }), true);
  assert.equal(sourceIncluded({ rows: [row()], includeInExport: false }), false);
  assert.equal(sourceIncluded({ rows: [row({ date: null, amount: null }), row({ date: null, amount: null }), row({ date: null, amount: null })] }), false);
});

test('sourceRangeCountLabel', () => {
  assert.equal(sourceRangeCountLabel(27, 31), '27 of 31 in range');
  assert.equal(sourceRangeCountLabel(0, 0), '0 in range');
  assert.equal(sourceRangeCountLabel(0, 5), '0 of 5 in range');
});

test('sourcesSummarySegment is empty unless a source is actually excluded', () => {
  assert.equal(sourcesSummarySegment(1, 1), '');
  assert.equal(sourcesSummarySegment(3, 3), '');
  assert.equal(sourcesSummarySegment(0, 0), '');
  assert.equal(sourcesSummarySegment(2, 3), '2 of 3 sources');
});

// Found verifying item 13 live: a picked profile whose headerRow lands on
// the wrong row of a file can leave one all-skipped "record" - that must
// never read as a false-clean "healthy, 0 rows".
test('allRowsSkipped / fileStatus: a file whose only row(s) are all skipped reads as noTransactions, not healthy', () => {
  assert.equal(allRowsSkipped([{ skipped: true }]), true);
  assert.equal(allRowsSkipped([{ skipped: true }, { skipped: false }]), false);
  assert.equal(allRowsSkipped([]), false);
  assert.equal(fileStatus({ rows: [{ skipped: true, date: null, amount: null }] }), 'noTransactions');
  assert.equal(fileStatus({ rows: [{ skipped: false, date: '2026-09-01', amount: -100 }] }), 'healthy');
});

// --- Remove a statement / Undo -------------------------------------------

test('removeFileAt drops the entry at index and returns it as `removed`, leaving the input array untouched', () => {
  const a = { name: 'a.csv' }, b = { name: 'b.csv' }, c = { name: 'c.csv' };
  const files = [a, b, c];
  const { files: next, removed } = removeFileAt(files, 1);
  assert.deepEqual(next.map((f) => f.name), ['a.csv', 'c.csv']);
  assert.equal(removed, b); // same object, not a copy
  assert.equal(files.length, 3); // input array untouched (pure)
});

test('removeFileAt is a no-op (removed: null, same array) for an out-of-range index', () => {
  const files = [{ name: 'a.csv' }];
  assert.deepEqual(removeFileAt(files, 5), { files, removed: null });
  assert.deepEqual(removeFileAt(files, -1), { files, removed: null });
});

test('restoreFileAt reinserts the exact same object at the given index (Undo)', () => {
  const a = { name: 'a.csv' }, c = { name: 'c.csv' };
  const b = { name: 'b.csv', rows: [row({ excluded: true })] }; // an edit/exclusion survives on the object itself
  const { files: withoutB, removed } = removeFileAt([a, b, c], 1);
  const restored = restoreFileAt(withoutB, 1, removed);
  assert.deepEqual(restored, [a, b, c]);
  assert.equal(restored[1], b); // identity preserved, so rows/edits/review resolutions come back unchanged
  assert.equal(restored[1].rows[0].excluded, true);
});

test('restoreFileAt clamps a stale index past the current length onto the end', () => {
  const a = { name: 'a.csv' }, removed = { name: 'gone.csv' };
  assert.deepEqual(restoreFileAt([a], 9, removed), [a, removed]);
});

// Export composition after removal: exportReadiness/notIncludedLabel react
// correctly once a file is gone (not merely "still counts the old array").
test('exportReadiness after removeFileAt: removing the only healthy file blocks export again', () => {
  const healthy = { rows: [row()] };
  const unmapped = { matches: [] };
  const { files: afterRemove } = removeFileAt([healthy, unmapped], 0);
  const before = exportReadiness([healthy, unmapped], { rowCountInRange: 1 });
  const after = exportReadiness(afterRemove, { rowCountInRange: 0 });
  assert.equal(before.blocked, false);
  assert.equal(after.blocked, true);
  assert.deepEqual(after.reasons, ['No file has been mapped yet', 'No rows in the selected date range']);
});

test('notIncludedLabel after removeFileAt: removing the unreadable-dates file drops its count from the label', () => {
  const healthy = { rows: [row()] };
  const unreadable = { rows: [row({ date: null, amount: null }), row({ date: null, amount: null })] };
  assert.equal(notIncludedLabel([healthy, unreadable]), '1 file not included (dates could not be read)');
  const { files: afterRemove } = removeFileAt([healthy, unreadable], 1);
  assert.equal(notIncludedLabel(afterRemove), '');
});

// --- Item A: a matched profile that extracts nothing usable never shows healthy ---

test('matchExtractionFailed: true for zero rows or >50% unreadable dates, false for a healthy read', () => {
  assert.equal(matchExtractionFailed([]), true);
  assert.equal(matchExtractionFailed(null), true);
  assert.equal(matchExtractionFailed([row({ date: null, amount: null }), row({ date: null, amount: null }), row()]), true);
  assert.equal(matchExtractionFailed([row(), row()]), false);
});

test("fileStatus: a matched profile that extracted zero rows reads as noTransactions, not healthy", () => {
  assert.equal(fileStatus({ rows: [] }), 'noTransactions');
});

test('fileStatus: entry.matchFailed (every candidate profile tried, none worked) wins over any stale matches list', () => {
  assert.equal(fileStatus({ matchFailed: 'sc test', matches: [{ confidence: 0.9, formatChanged: false }], rows: null }), 'matchFailed');
});

test('attentionCards surfaces a matchFailed card naming the last profile tried', () => {
  const cards = attentionCards([{ name: 'lattice_test.csv', matchFailed: 'sc test', rows: null }]);
  assert.deepEqual(cards, [{ kind: 'matchFailed', fileIndex: 0, name: 'lattice_test.csv', profileName: 'sc test' }]);
});

test('notIncludedLabel: a matchFailed file reads as "could not be read", not the generic "not mapped yet"', () => {
  assert.equal(notIncludedLabel([{ matchFailed: 'sc test', rows: null }]), '1 file not included (could not be read)');
});

// --- Bug D: fileStatus must use the PRE-merge row count, not entry.rows.length ---

test('fileStatus: a fully merged-away file (rowCountAtMatch > 0, rows shrunk to 0 by dedupe) still reads healthy', () => {
  assert.equal(fileStatus({ rowCountAtMatch: 31, rows: [] }), 'healthy');
});

test('fileStatus: a profile that itself extracted zero rows (no rowCountAtMatch stamped, or stamped 0) reads noTransactions', () => {
  assert.equal(fileStatus({ rows: [] }), 'noTransactions');
  assert.equal(fileStatus({ rowCountAtMatch: 0, rows: [] }), 'noTransactions');
});

test('fileStatus: a partially merged file (some rows left) is judged on those remaining rows as usual', () => {
  assert.equal(fileStatus({ rowCountAtMatch: 5, rows: [row()] }), 'healthy');
});

// --- Item 1: matchExtractionFailed must count a mass-skipped row set too ---
// A real bug: a bad mapping that makes most rows fail
// BOTH date and amount gets them marked `skipped`, which used to fall out of
// unreadableDateRate's denominator entirely - a file that is almost all
// skipped junk used to read as "0% bad" instead of "extraction failed".

test('unreadableDateRate: a mostly-skipped row set reads as bad, not as an empty (0%) active set', () => {
  const skippedJunk = row({ date: null, amount: null, skipped: true });
  const goodRow = row();
  assert.equal(unreadableDateRate([skippedJunk, skippedJunk, skippedJunk, goodRow]), 0.75);
  assert.equal(matchExtractionFailed([skippedJunk, skippedJunk, skippedJunk, goodRow]), true);
});

test('unreadableDateRate: a few legitimately-skipped footer rows among mostly-good ones stays healthy', () => {
  const skippedFooter = row({ date: null, amount: 300000, skipped: true });
  const good = Array.from({ length: 20 }, () => row());
  assert.equal(matchExtractionFailed([skippedFooter, ...good]), false);
});

// --- Item 1: extractionQuality / selectMatchCandidate ----------------------

test('extractionQuality: 0 with no date-led lines to measure against', () => {
  assert.equal(extractionQuality([row()], 0), 0);
});

test('extractionQuality: penalises missing_amount/unparseable_date rates, rewards valid coverage', () => {
  const good = extractionQuality([row(), row(), row()], 3);
  assert.equal(good, 1);
  const missingAmounts = extractionQuality(
    [row({ amount: null, flags: ['missing_amount'] }), row({ amount: null, flags: ['missing_amount'] }), row()],
    3,
  );
  assert.ok(missingAmounts < good, `${missingAmounts} should be worse than a clean read`);
  assert.ok(missingAmounts < 0.5, `${missingAmounts} should read as clearly bad`);
});

test('selectMatchCandidate: a tied-confidence broken user profile loses to a working built-in on quality', () => {
  const brokenUserProfile = { profile: { id: 'user-1', name: 'sc test', builtIn: false }, version: { id: 'v1', createdAt: '2026-09-16T00:00:00Z' }, confidence: 0.9 };
  const workingBuiltin = { profile: { id: 'builtin-sc', name: 'Lattice Bank credit card, CSV', builtIn: true }, version: { id: 'v1', createdAt: '2026-09-01T00:00:00Z' }, confidence: 0.9 };
  const matches = [brokenUserProfile, workingBuiltin]; // broken one first, the harder order to get right
  const rowsByProfile = {
    'user-1': [row({ amount: null, flags: ['missing_amount'] }), row({ amount: null, flags: ['missing_amount'] }), row()],
    'builtin-sc': [row(), row(), row()],
  };
  const { picked, scored } = selectMatchCandidate(matches, 3, (m) => rowsByProfile[m.profile.id]);
  assert.equal(picked.match.profile.id, 'builtin-sc');
  assert.equal(scored.length, 2);
  assert.ok(scored.every((s) => typeof s.quality === 'number'));
});

test('selectMatchCandidate: a near-tied quality gap favours the more recently saved user profile over an equally-good builtin', () => {
  const olderBuiltin = { profile: { id: 'builtin', name: 'Builtin', builtIn: true }, version: { id: 'v1', createdAt: '2026-01-01T00:00:00Z' }, confidence: 0.95 };
  const newerUser = { profile: { id: 'user', name: 'My profile', builtIn: false }, version: { id: 'v2', createdAt: '2026-09-01T00:00:00Z' }, confidence: 0.9 };
  const matches = [olderBuiltin, newerUser];
  const rowsByProfile = { builtin: [row(), row()], user: [row(), row()] }; // identical quality
  const { picked } = selectMatchCandidate(matches, 2, (m) => rowsByProfile[m.profile.id]);
  assert.equal(picked.match.profile.id, 'user');
});

test('selectMatchCandidate: only scores candidates within TIE_MARGIN of the top score, capped at 4', () => {
  const matches = [0.95, 0.9, 0.5, 0.94, 0.93, 0.92].map((confidence, i) => ({
    profile: { id: `p${i}`, name: `p${i}`, builtIn: true }, version: { id: 'v1' }, confidence,
  }));
  const { scored } = selectMatchCandidate(matches, 1, () => [row()]);
  assert.ok(scored.length <= 4, `expected at most 4 scored, got ${scored.length}`);
  assert.ok(scored.every((s) => 0.95 - s.confidence <= 0.1));
});

test('candidateLossCaption names the winner and the losing user profile', () => {
  assert.equal(
    candidateLossCaption('Lattice Bank credit card, CSV', 'sc test'),
    "Used 'Lattice Bank credit card, CSV'. Your statement type 'sc test' could not read amounts in this file.",
  );
});

// --- Item 3: per-version health line ---------------------------------------

test('profileHealthLabel: null when never used, "N of N read" when clean, names the dominant problem otherwise', () => {
  assert.equal(profileHealthLabel(null), null);
  assert.equal(profileHealthLabel({ rows: 0, validRows: 0 }), null);
  assert.equal(profileHealthLabel({ rows: 310, validRows: 310 }), 'Last used: 310 of 310 rows read');
  assert.equal(
    profileHealthLabel({ rows: 314, validRows: 5, missingAmountRows: 309, unparseableDateRows: 0 }),
    'Last used: amounts missing on 309 of 314 rows',
  );
});

test('summarizeExtraction: counts valid/missing-amount/unparseable-date rows, skipping skipped ones', () => {
  const rows = [
    row(),
    row({ amount: null, flags: ['missing_amount'] }),
    row({ date: null, flags: ['unparseable_date'] }),
    row({ date: null, amount: null, skipped: true }),
  ];
  const summary = summarizeExtraction(rows);
  assert.equal(summary.rows, 4);
  assert.equal(summary.validRows, 1);
  assert.equal(summary.missingAmountRows, 1);
  assert.equal(summary.unparseableDateRows, 1);
  assert.ok(summary.at);
});

test('exportReadiness holds Copy while any statement is still being read (returner defect, pass 1)', () => {
  const files = [
    { id: 'a', rows: [{ date: '2026-06-01', amount: -100 }, { date: '2026-06-02', amount: -200 }, { date: '2026-06-03', amount: 300 }], rowCountAtMatch: 3, matchedVersion: {} },
    { id: 'b', processing: true, rows: [] },
  ];
  const r = exportReadiness(files, { rowCountInRange: 3 });
  assert.equal(r.blocked, true);
  assert.match(r.reasons.join(' '), /Reading 1 of 2 statements, 3 rows so far/);
});
