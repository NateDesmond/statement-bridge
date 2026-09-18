// Pure Home-screen state machine: file status -> attention cards -> export
// enabled/blocked reasons, plus the "since last export" range suggestion.
// No DOM here; src/ui/home.js renders these shapes.

export const HIGH_CONFIDENCE = 0.9;

/**
 * Whether more than half of a file's own (not excluded/skipped) rows are
 * missing a usable date or amount - a failed parse, not a healthy file with
 * a few warning rows (Finding 1/C1b: a mapping gone stale must never let
 * blank-date rows quietly reach Copy/Download).
 * @param {object[]} rows
 */
export function unreadableDateRate(rows) {
  // Bug fix (item 1): a skipped row used to
  // drop out of BOTH the numerator and the denominator, so a mapping that
  // mistakenly skips (or fails to skip) a large share of a file's lines could
  // hide behind a small, mostly-clean "active" set - e.g. a header-row
  // mismatch that makes most transaction lines fail date AND amount parsing
  // marks them `skipped`, so the old `!r.skipped` filter erased exactly the
  // rows this check exists to catch, and unreadableDateRate came back 0. A
  // skipped row is never a valid transaction, so it now counts as bad too;
  // only `excluded` (removed from consideration entirely) is left out.
  const active = (rows || []).filter((r) => !r.excluded);
  if (!active.length) return 0;
  const bad = active.filter((r) => r.skipped || r.date == null || r.amount == null).length;
  return bad / active.length;
}

/** True once more than half of a file's rows have no usable date/amount. */
export function hasUnreadableDates(rows) {
  return (rows || []).length > 0 && unreadableDateRate(rows) > 0.5;
}

/**
 * True when a file actually produced rows but every single one turned out
 * to be a non-transaction line (skipped) - e.g. a picked profile's own
 * headerRow config lands on the wrong row of a file that doesn't really
 * match it, and the one "record" left is entirely boilerplate. Found while
 * verifying item 13: without this, hasUnreadableDates' active-rows check
 * (which only ever counts non-skipped rows) sees an empty active set and
 * returns false, so the file read "All checks pass" with "0 rows" right
 * next to it - a real "nothing here" case gets the same treatment as an
 * empty file, not a false-clean healthy badge.
 */
export function allRowsSkipped(rows) {
  return (rows || []).length > 0 && rows.every((r) => r.skipped);
}

/**
 * True once an applied profile's own extraction produced nothing usable:
 * zero rows, or unreadable dates on more than half of them (hasUnreadableDates'
 * >50% rule) - a real extraction failure, never a healthy match, no matter
 * how confident matchProfile was about the header/preamble alone (a real
 * debug log, 2026-09-17: "sc_all.csv" matched "sc test" at 0.9 confidence and
 * still showed healthy with 0 rows).
 */
export function matchExtractionFailed(rows) {
  return !rows || rows.length === 0 || hasUnreadableDates(rows);
}

// --- Item 1: pick among tied match candidates by extraction quality --------
// A real bug: two candidates ("sc test", a user
// profile, and the built-in "Standard Chartered credit card, CSV") tied at
// 0.9 confidence. Signature score alone can't tell them apart - one of them
// had amount mapped to a sparse column (a stale suggester bug baked into an
// old saved profile) and extracted almost nothing, but tied on header text
// alone and won by list order. Candidates within TIE_MARGIN of the top score
// (capped at MAX_SCORED_CANDIDATES) are actually run through the pipeline and
// scored on what they extract, not just how their header/preamble reads.

export const TIE_MARGIN = 0.1;
export const MAX_SCORED_CANDIDATES = 4;
export const QUALITY_TIE_MARGIN = 0.02;

/**
 * Extraction quality for one candidate's already-built rows: the share of
 * the file's real transaction-looking source lines that came out as valid
 * (date AND amount present, not skipped), minus penalties for how often
 * missing_amount/unparseable_date show up among the rows that WERE kept.
 * 0 when there's nothing to measure against (no date-led lines at all).
 * @param {object[]} rows - normalizeRecords output for this candidate
 * @param {number} dateLedLineCount - core/detect.js's countTransactionLikeRows
 *   over the file's own raw lines/grid, independent of any one candidate's parse
 */
export function extractionQuality(rows, dateLedLineCount) {
  if (!dateLedLineCount) return 0;
  const kept = (rows || []).filter((r) => !r.skipped);
  const valid = kept.filter((r) => r.date != null && r.amount != null).length;
  const missingAmountRate = kept.length ? kept.filter((r) => r.flags?.includes('missing_amount')).length / kept.length : 0;
  const unparseableDateRate = kept.length ? kept.filter((r) => r.flags?.includes('unparseable_date')).length / kept.length : 0;
  return valid / dateLedLineCount - missingAmountRate * 0.5 - unparseableDateRate * 0.5;
}

/**
 * Choose one match candidate by extraction quality rather than signature
 * score alone. Every candidate within TIE_MARGIN of the top confidence
 * (capped at MAX_SCORED_CANDIDATES) is actually built via `buildRows` and
 * scored; the highest quality wins. A tie in quality (within
 * QUALITY_TIE_MARGIN of the best) favours the most recently saved USER
 * profile (never a builtin) over an equally-good one, since a builtin's
 * mapping is fixed code while a user's own reflects their latest choice.
 * @param {{profile:object, version:object, confidence:number}[]} matches - matchProfile's ranked candidates
 * @param {number} dateLedLineCount - see extractionQuality
 * @param {(match:object) => object[]|null} buildRows - runs the pipeline for one candidate; may throw/return null on a bad config
 * @returns {{picked:object|null, scored:{match:object, confidence:number, quality:number, rows:object[]|null}[]}}
 */
export function selectMatchCandidate(matches, dateLedLineCount, buildRows) {
  if (!matches?.length) return { picked: null, scored: [] };
  const topScore = matches[0].confidence;
  const tied = matches.filter((m) => topScore - m.confidence <= TIE_MARGIN).slice(0, MAX_SCORED_CANDIDATES);
  const scored = tied.map((match) => {
    let rows = null;
    try { rows = buildRows(match); } catch { rows = null; }
    return { match, confidence: match.confidence, quality: extractionQuality(rows, dateLedLineCount), rows };
  });
  let best = scored[0];
  for (const s of scored.slice(1)) {
    if (s.quality > best.quality) { best = s; continue; }
    const tiedOnQuality = best.quality - s.quality <= QUALITY_TIE_MARGIN;
    const sIsUser = !s.match.profile.builtIn;
    const bestIsUser = !best.match.profile.builtIn;
    // Prefer the more recently saved user profile only among near-tied
    // quality, and only when it isn't already the pick.
    if (tiedOnQuality && sIsUser && (!bestIsUser || (s.match.version.createdAt || '') > (best.match.version.createdAt || ''))) {
      best = s;
    }
  }
  return { picked: best || null, scored };
}

/**
 * Classify one file entry into a fast-path status.
 * @param {{error?:string, processing?:boolean, empty?:boolean, rows?:object[], matches?:{confidence:number, formatChanged:boolean}[]}} entry
 */
export function fileStatus(entry) {
  if (entry.error) return 'error';
  if (entry.processing) return 'processing';
  // An image-only PDF starts OCR automatically (no question asked), so this
  // state is normally instantaneous ('processing' takes over within the same
  // tick). ocrFailed/ocrCancelled are the only two ways OCR ends up needing
  // the user; imageOnly lingering past that would mean OCR was never started.
  if (entry.ocrFailed) return 'ocrFailed';
  if (entry.ocrCancelled) return 'ocrCancelled';
  // Item 7: OCR runs one file at a time through the single shared Tesseract
  // worker (home.js's queue) - a second/third image-only PDF dropped in the
  // same batch waits here instead of starting concurrently (which used to
  // make every OCR job slower by fighting over one worker).
  if (entry.ocrQueued) return 'ocrQueued';
  if (entry.imageOnly) return 'imageOnly';
  // A file that parsed with no data rows at all (empty file, or header-only
  // CSV/XLSX) is neither an unmapped statement nor a failed extraction - it
  // is simply empty (F2), and never worth sending through the wizard.
  if (entry.empty) return 'noTransactions';
  // A real bug: an auto-applied profile that scored
  // well on its header/preamble alone but extracted nothing usable (0 rows,
  // or unreadable dates on most of them) must never read as healthy - home.js
  // already tried every other ranked candidate by the time it sets this flag.
  if (entry.matchFailed) return 'matchFailed';
  if (entry.rows) {
    // Item 13: a file whose mapping came from "Use an existing profile" but
    // whose checks then failed reads as Layout changed (with a way back into
    // the picker) - the profile WAS applied, it's just the wrong one, not a
    // generic parse failure.
    if (entry.pickedProfileFailed) return 'layoutChanged';
    if (allRowsSkipped(entry.rows)) return 'noTransactions';
    // Bug D (coordinator, 2026-09-17): entry.rows can since have shrunk to
    // zero because every one of this file's rows cross-file-deduped into
    // another file (mergeDuplicates) - that is a healthy, fully-merged file
    // (it shows "N rows merged into <other file>"), never "no transactions".
    // A matched profile that itself produced zero rows (found live: a
    // scored-well header/preamble match whose actual column mapping doesn't
    // fit this file at all) is the real "nothing here" case - same contract
    // as groupedCheckLabel: home.js stamps rowCountAtMatch once, at parse
    // time, before merge can ever touch `rows`, and that count (never
    // `rows.length` itself) is what decides this. Falls back to `rows.length`
    // when the field was never stamped (e.g. a directly-constructed test
    // entry, or any other caller that hands fileStatus a plain rows array).
    const rowCountAtMatch = entry.rowCountAtMatch ?? entry.rows.length;
    if (rowCountAtMatch === 0) return 'noTransactions';
    return hasUnreadableDates(entry.rows) ? 'unreadableDates' : 'healthy';
  }
  if (!entry.matches?.length) return 'new';
  // Only the top-ranked candidate's formatChanged matters: a weaker candidate
  // further down the list flagging formatChanged shouldn't override a good
  // top match (matchProfile ranks by confidence, ties toward formatChanged).
  if (entry.matches[0].formatChanged) return 'layoutChanged';
  if (entry.matches[0].confidence < HIGH_CONFIDENCE) return 'lowConfidence';
  return 'matched'; // caller auto-applies matches[0] on sight, this state shouldn't linger
}

/** Mask an account number found in free text down to its last 4 digits, e.g. "Account No: 123-4-567890" -> "****7890". */
export function maskAccountNumber(text) {
  if (!text) return null;
  const m = String(text).match(/\b[\d][\d\s-]{5,20}\d\b/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `****${digits.slice(-4)}`;
}

/**
 * The account label a matched file displays/dedupes/exports under: the
 * profile's own accountLabel if one has been set, else "<bank> <statement
 * type> ****<last4>" - never the profile's own display name (e.g. "DBS
 * savings, Transaction History PDF"), which describes the mapping, not the
 * account.
 * @param {{accountLabel?:string, bank?:string, statementType?:string, name:string}} profile
 * @param {string|null} masked - maskAccountNumber's output, or null
 */
export function defaultAccountLabel(profile, masked) {
  if (profile.accountLabel) return profile.accountLabel;
  const base = [profile.bank, profile.statementType].filter(Boolean).join(' ') || profile.name;
  return masked ? `${base} ${masked}` : base;
}

/** "5 rows across 1 account" / "10 rows across 2 accounts" - proper singular/plural, never a bare count. */
export function accountsSummaryLabel(rowCount, accountCount) {
  return `${rowCount} row${rowCount === 1 ? '' : 's'} across ${accountCount} account${accountCount === 1 ? '' : 's'}`;
}

// --- Track 3: OCR speed + partial results ---------------------------------

/**
 * "About 40 seconds left" from measured OCR page timings - null once there's
 * nothing left to wait for, or no timing sample yet (the first page is still
 * running). Rounds to whole seconds under a minute, whole minutes above.
 * @param {number} pagesDone - pages recognised so far
 * @param {number} totalPages
 * @param {number|null} avgMsPerPage - mean of the pages recognised so far
 */
export function ocrTimeEstimateLabel(pagesDone, totalPages, avgMsPerPage) {
  if (!avgMsPerPage || pagesDone >= totalPages) return null;
  const seconds = Math.round((avgMsPerPage * (totalPages - pagesDone)) / 1000);
  if (seconds < 5) return 'A few seconds left';
  if (seconds < 60) return `About ${seconds} seconds left`;
  const minutes = Math.round(seconds / 60);
  return `About ${minutes} minute${minutes === 1 ? '' : 's'} left`;
}

/** "12 of 15 pages read so far" - partial-results caption while OCR is still running on later pages. */
export function ocrPartialCaption(pagesDone, totalPages) {
  return `${pagesDone} of ${totalPages} pages read so far`;
}

/** Which bank a filename or scrap of PDF text hints at, for the image-only card's CSV-export tip. */
export function detectBankHint(text) {
  // Not \b-bounded: real inputs are filenames ("dbs_scan.pdf") where "_"/"."
  // are word characters, so a \b boundary would never fire against them.
  const t = String(text || '').toLowerCase();
  if (t.includes('dbs') || t.includes('posb')) return 'DBS';
  if (t.includes('ocbc')) return 'OCBC';
  if (t.includes('uob')) return 'UOB';
  return null;
}

// Flags that record provenance/context but are not, by themselves, something
// the user needs to look at (a clean OCR read still shows a plain health
// badge; only an actual misread, flag 'low_confidence_ocr', is a warning).
const INFO_ONLY_FLAGS = new Set(['ocr', 'pending']);

/** Count of not-excluded rows carrying any real (non-informational) flag (a "needs a look" row). */
export function warningRowCount(rows) {
  return (rows || []).filter((r) => !r.excluded && r.flags?.some((f) => !INFO_ONLY_FLAGS.has(f))).length;
}

/**
 * Simple B's "N rows need a quick look" decision list: every not-excluded,
 * not-skipped row across every healthy, included file that carries a real
 * (non-informational) warning flag, paired with the file it came from. One
 * flat list across files (not grouped per file) - a person clearing warnings
 * from Home doesn't care which file a row belongs to until they look at it.
 * @param {object[]} files - entries as tracked by home.js
 * @returns {{file: object, fileIndex: number, row: object}[]}
 */
export function flaggedDecisionRows(files) {
  const out = [];
  files.forEach((file, fileIndex) => {
    if (!file.rows?.length || file.includeInExport === false) return;
    for (const row of file.rows) {
      if (row.excluded || row.skipped) continue;
      if (row.flags?.some((f) => !INFO_ONLY_FLAGS.has(f))) out.push({ file, fileIndex, row });
    }
  });
  return out;
}

/**
 * Caption for a file row whose own extracted rows were dropped by cross-file
 * dedupe merge, e.g. "5 rows merged into DBS savings ****7890" when every row
 * merged away, or "3 of 5 rows merged into ..." for a partial overlap. The
 * Undo action itself lives in the session-wide "duplicates merged" card, not
 * here - this is just the file row saying what happened to it.
 * @param {number} count - rows removed from this file
 * @param {number} total - rows this file had before merge
 * @param {string} intoName - the surviving file's name/label the rows now live under
 */
export function mergedRowsCaption(count, total, intoName) {
  const noun = count === 1 ? 'row' : 'rows';
  return count === total
    ? `${count} ${noun} merged into ${intoName}`
    : `${count} of ${total} rows merged into ${intoName}`;
}

/** Caption for the surviving file when a later drop of the same file was a whole-file exact duplicate (QA Finding 1). */
export const DUPLICATE_DROPPED_CAPTION = 'Dropped twice, second copy ignored.';

/**
 * Caption for a whole-file exact duplicate (see DUPLICATE_DROPPED_CAPTION)
 * when the dropped file differs in type (CSV vs PDF) or name from the file
 * it duplicated. "Dropped twice" reads as if the literal same file was
 * dropped twice, which is confusing for two different-looking exports of
 * the same statement (C2 wording finding) - only the identical-filename
 * re-drop keeps that wording.
 * @param {string} otherName - the file that was dropped
 */
export function sameTransactionsCaption(otherName) {
  return `Same transactions as ${otherName}, not added again.`;
}

/**
 * Picks between DUPLICATE_DROPPED_CAPTION and sameTransactionsCaption for a
 * whole-file exact duplicate: the identical filename AND file type dropped a
 * second time keeps "Dropped twice"; anything else (a different name, or the
 * same statement exported as both CSV and PDF) reads as two different-looking
 * files, so it gets the "same transactions" wording instead.
 * @param {boolean} sameNameAndType - whether the dropped file and the
 *   surviving file share both name and type
 * @param {string} otherName - the file that was dropped
 */
export function duplicateDroppedCaption(sameNameAndType, otherName) {
  return sameNameAndType ? DUPLICATE_DROPPED_CAPTION : sameTransactionsCaption(otherName);
}

/**
 * Inclusive [startISO, endISO] date range across a row list's `date` field,
 * or null if none are dated. Used for a merged-away file's own row so its
 * badge line still reflects its real pre-merge extraction instead of
 * whatever's left in `rows` (which cross-file dedupe can shrink to zero).
 * @param {object[]} rows
 */
export function dateRangeOfRows(rows) {
  const dates = (rows || []).map((r) => r.date).filter(Boolean).sort();
  return dates.length ? { startISO: dates[0], endISO: dates[dates.length - 1] } : null;
}

/**
 * Fix item 2 (2026-09-18): the result card's own headline - what's actually
 * about to be copied, nothing about how it's configured ("5 transactions
 * from 1 statement &middot; 1 Jun to 20 Jun 2026"). Columns/date-range-filter/
 * currency settings live in "Adjust what's exported" instead (see
 * settingsSummaryLabel below) - a person doesn't need to read the export
 * configuration just to see that their statements are ready.
 * @param {number} rowCount
 * @param {number} statementCount - included source files, not accounts (two files can share one account)
 * @param {string|null} rangeLabel - already-formatted date range, or null when there's nothing dated to show
 */
export function resultHeadlineLabel(rowCount, statementCount, rangeLabel) {
  const txns = `${rowCount} transaction${rowCount === 1 ? '' : 's'}`;
  const stmts = `${statementCount} statement${statementCount === 1 ? '' : 's'}`;
  return rangeLabel ? `${txns} from ${stmts} · ${rangeLabel}` : `${txns} from ${stmts}`;
}

/**
 * A file row's summary line ("****7890 · 12 Sep 2026 to 15 Sep 2026 · 5
 * rows"), joining only the parts that are actually present - when no masked
 * account was derivable, that segment AND its separator are omitted
 * entirely, never a leading "&middot;" (QA Finding: nit 1).
 * @param {string|null} maskedAccount
 * @param {string} rangeLabelHtml
 * @param {string} rowCountHtml
 */
export function fileRowLineHtml(maskedAccount, rangeLabelHtml, rowCountHtml) {
  return [maskedAccount, rangeLabelHtml, rowCountHtml].filter(Boolean).join(' &middot; ');
}

/**
 * Health badge for a healthy (mapped) file row.
 * @param {object[]} rows
 * @param {{groupedMismatch?: {tone:'ok'|'neutral'|'fail', text:string, showUpdateMappingLink:boolean}|null}} [opts] -
 * item 1: for a grouped-rowModel PDF, home.js precomputes a
 * countCheckGrouped mismatch (checks.js's groupedCountLabel, same wording
 * the wizard's Test step uses) and passes it here so a missing row shows up
 * as a badge too. Contract: home.js computes this once at parse time,
 * against that file's own extracted row count, and stores it on the entry -
 * it must never be recomputed later against `rows`, because cross-file
 * dedupe merge can mutate a file's `rows` (even down to zero, when every row
 * merged into another file) well after parsing. A null/absent value here
 * always means "the file's own pre-merge check passed", regardless of what
 * `rows` holds now.
 */
export function healthBadge(rows, opts = {}) {
  if (opts.groupedMismatch) {
    // Item 5: a small (<=5%) gap reads as ordinary text-recognition noise -
    // 'warn' (amber), informational, no "Update mapping" push. A real
    // mismatch above that is 'danger' (red) and does offer it.
    return { label: opts.groupedMismatch.text, tone: opts.groupedMismatch.tone === 'fail' ? 'danger' : 'warn', showUpdateMappingLink: opts.groupedMismatch.showUpdateMappingLink };
  }
  const warnCount = warningRowCount(rows);
  if (warnCount > 0) return { label: `${warnCount} warning${warnCount === 1 ? '' : 's'}`, tone: 'warn' };
  return { label: 'All checks pass', tone: 'ok' };
}

/**
 * One attention card per thing that needs the user, in FASTPATH.md's order:
 * OCR failed/empty, new statement type, layout changed, low confidence, rows
 * with warnings, currency unknown. Missing-rate and duplicates-merged are
 * session-wide, not per-file, so callers append those separately (see
 * exportReadiness / the dedupe undo notice in home.js). An image-only PDF
 * itself never gets a card: OCR starts automatically at drop, no question
 * asked; only outright OCR failure or a read with no transaction-like lines
 * surfaces here as 'ocrFailed'.
 * @param {object[]} files - entries as tracked by home.js (index order preserved)
 */
export function attentionCards(files) {
  const cards = [];
  files.forEach((entry, index) => {
    const status = fileStatus(entry);
    if (status === 'ocrFailed') {
      cards.push({ kind: 'ocrFailed', fileIndex: index, name: entry.name, bank: detectBankHint(`${entry.name} ${entry.imageOnlySample || ''}`) });
    } else if (status === 'noTransactions') {
      cards.push({ kind: 'noTransactions', fileIndex: index, name: entry.name });
    } else if (status === 'unreadableDates') {
      cards.push({ kind: 'unreadableDates', fileIndex: index, name: entry.name });
    } else if (status === 'matchFailed') {
      // Item A: every candidate profile was tried (home.js) and none
      // produced usable rows - entry.matchFailed names the last one tried.
      cards.push({ kind: 'matchFailed', fileIndex: index, name: entry.name, profileName: entry.matchFailed });
    } else if (status === 'new') {
      cards.push({ kind: 'new', fileIndex: index, name: entry.name });
    } else if (status === 'layoutChanged') {
      cards.push({ kind: 'layoutChanged', fileIndex: index, name: entry.name, profileName: entry.matches[0].profile.name });
    } else if (status === 'lowConfidence') {
      cards.push({ kind: 'lowConfidence', fileIndex: index, name: entry.name, profileName: entry.matches[0].profile.name, confidence: entry.matches[0].confidence });
    } else if (status === 'healthy') {
      const warnCount = warningRowCount(entry.rows);
      if (warnCount > 0 && !entry.warningsDismissed) {
        cards.push({ kind: 'warnings', fileIndex: index, name: entry.name, count: warnCount });
      }
      if (entry.rows.some((r) => !r.excluded && r.currency == null) && !entry.currencyResolved) {
        const sample = entry.rows.find((r) => !r.excluded && r.currency == null);
        cards.push({ kind: 'currencyUnknown', fileIndex: index, name: entry.name, sample: sample?.description_raw, sampleAmount: sample?.amount });
      }
    }
  });
  return cards;
}

/**
 * Copy/Download eligibility. An unmapped or failed file is informational
 * only (surfaced via `notIncluded`, e.g. "1 file not included (not mapped
 * yet)") and never blocks export of the healthy files: only "zero rows in
 * the selected range" and "missing exchange rate" are real blockers, plus
 * the degenerate case of no healthy file at all. Reasons are user-facing.
 * @param {object[]} files
 * @param {{missingRatePairs?: string[], rowCountInRange: number}} opts
 */
export function exportReadiness(files, { missingRatePairs = [], rowCountInRange } = {}) {
  const reasons = [];
  const hasHealthyFile = files.some((f) => fileStatus(f) === 'healthy');
  const notIncluded = files.filter((f) => fileStatus(f) !== 'healthy' && fileStatus(f) !== 'processing').length;
  if (!hasHealthyFile) reasons.push('No file has been mapped yet');
  if (missingRatePairs.length) reasons.push(`Missing exchange rate for ${missingRatePairs.join(', ')}`);
  if (rowCountInRange === 0) reasons.push('No rows in the selected date range');
  return { blocked: reasons.length > 0, reasons, hasHealthyFile, notIncluded };
}

/**
 * "1 file not included (not mapped yet)" / "1 file not included (dates could
 * not be read)" - a file excluded from export reads by ITS OWN reason, never
 * a single generic "not mapped yet" covering both a truly unmapped file
 * and one whose mapping produced unusable dates (C1b). Files still
 * processing are never "not included" (they just aren't done yet).
 * @param {object[]} files
 */
export function notIncludedLabel(files) {
  const counts = {};
  for (const f of files) {
    const status = fileStatus(f);
    if (status === 'healthy' || status === 'processing') continue;
    const reason = status === 'unreadableDates' ? 'dates could not be read' : status === 'matchFailed' ? 'could not be read' : 'not mapped yet';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([reason, count]) => `${count} file${count === 1 ? '' : 's'} not included (${reason})`)
    .join(', ');
}

// --- Item 14a: the drawer's Sources list (per-file include/exclude) -------

/**
 * Whether a mapped file's own rows currently count toward the export
 * composition - unchecked in the drawer's Sources list (entry.includeInExport
 * === false), or a file whose own checks already failed so hard its rows
 * never counted anywhere export-adjacent to begin with (C1b). Defaults to
 * included: a freshly-mapped file with no explicit choice yet is "on".
 * @param {object} entry
 */
export function sourceIncluded(entry) {
  return entry.includeInExport !== false && fileStatus(entry) !== 'unreadableDates';
}

/**
 * "27 of 31 in range" for a source row in the drawer, or "0 in range" when
 * the source has no rows falling inside the current date range at all - the
 * caller greys this text out itself (nothing to say to a screen reader that
 * the plain count doesn't already say).
 * @param {number} includedCount - this file's own rows inside the current range
 * @param {number} totalCount - this file's own total (non-excluded, non-skipped) rows
 */
export function sourceRangeCountLabel(includedCount, totalCount) {
  if (totalCount === 0) return '0 in range';
  return `${includedCount} of ${totalCount} in range`;
}

/**
 * "2 of 3 sources" - the Ready to copy summary's leading segment, but only
 * once a source is actually excluded (nothing to say when every mapped file
 * is included - same "only when relevant" rule as the storage meter's
 * context note). Empty string when there's nothing to add.
 * @param {number} includedSourceCount
 * @param {number} totalSourceCount
 */
export function sourcesSummarySegment(includedSourceCount, totalSourceCount) {
  if (totalSourceCount <= 1 || includedSourceCount >= totalSourceCount) return '';
  return `${includedSourceCount} of ${totalSourceCount} sources`;
}

// --- Remove a statement / Undo (delete individual files or
// clear all of them without touching profiles) --------------------------

/**
 * Remove the file at `index`, pure: returns the new files array (a fresh
 * array, `files` itself untouched) plus the removed entry object itself -
 * the SAME object, never a copy, so its rows/edits/review resolutions are
 * whatever they already were and Undo has something to hand straight back.
 * @param {object[]} files
 * @param {number} index
 */
export function removeFileAt(files, index) {
  if (index < 0 || index >= files.length) return { files, removed: null };
  return { files: [...files.slice(0, index), ...files.slice(index + 1)], removed: files[index] };
}

/**
 * Undo removeFileAt: reinsert `entry` at `index` (clamped to the current
 * length, in case other files were added/removed since). Pure; `entry` is
 * put back exactly as it was handed to removeFileAt, so its rows/edits/
 * review resolutions come back unchanged too.
 * @param {object[]} files
 * @param {number} index
 * @param {object} entry
 */
export function restoreFileAt(files, index, entry) {
  const at = Math.min(Math.max(index, 0), files.length);
  return [...files.slice(0, at), entry, ...files.slice(at)];
}

/**
 * Item 2: the file-row caption when a user profile lost a quality-scored tie
 * to another candidate - names which profile actually got used and which of
 * the user's own profiles couldn't read this file, with a link (wired by the
 * caller) into Profiles focused on the loser.
 * @param {string} winnerName
 * @param {string} loserName
 */
export function candidateLossCaption(winnerName, loserName) {
  return `Used '${winnerName}'. Your statement type '${loserName}' could not read amounts in this file.`;
}

/**
 * Item 3: a profile version's health line from the last time it was actually
 * applied to a file - "Last used: 310 of 310 rows read" when every row had a
 * usable date+amount, or "Last used: amounts missing on 309 of 314 rows"
 * naming the dominant problem otherwise. null (render nothing) when the
 * version has never been used.
 * @param {{rows:number, validRows:number, missingAmountRows:number, unparseableDateRows:number}|null|undefined} lastUsed
 */
export function profileHealthLabel(lastUsed) {
  if (!lastUsed || !lastUsed.rows) return null;
  const { rows, validRows, missingAmountRows = 0, unparseableDateRows = 0 } = lastUsed;
  if (validRows >= rows) return `Last used: ${rows} of ${rows} rows read`;
  const dominant = missingAmountRows >= unparseableDateRows
    ? { count: missingAmountRows, label: 'amounts missing' }
    : { count: unparseableDateRows, label: 'dates unreadable' };
  return `Last used: ${dominant.label} on ${dominant.count} of ${rows} rows`;
}

/**
 * Item 3/4: summarise one applied candidate's rows into the shape
 * profileHealthLabel/storage want, stamped onto a profile version right
 * after a match is applied (home.js). Pure; the caller persists it.
 * @param {object[]} rows
 */
export function summarizeExtraction(rows) {
  const list = rows || [];
  return {
    rows: list.length,
    validRows: list.filter((r) => !r.skipped && r.date != null && r.amount != null).length,
    missingAmountRows: list.filter((r) => !r.skipped && r.amount == null).length,
    unparseableDateRows: list.filter((r) => !r.skipped && r.date == null).length,
    at: new Date().toISOString(),
  };
}

/**
 * Suggest a "Since last export" range per account, and flag accounts whose
 * suggested range would re-include already-exported rows (only possible if
 * a marker is missing or newer data arrived before the marker's date).
 * @param {Record<string,string>} lastExportedByAccount - account label -> ISO date of the last exported row
 * @param {string} todayISO
 */
export function sinceLastExportRange(lastExportedByAccount, todayISO) {
  const markers = Object.values(lastExportedByAccount || {}).filter(Boolean).sort();
  if (!markers.length) return { startISO: null, endISO: todayISO, overlapAccounts: [] };
  // Start the day after the earliest account's marker; accounts exported more
  // recently than that will re-see some already-exported rows, so surface them.
  const earliest = markers[0];
  const startDate = new Date(earliest + 'T00:00:00Z');
  startDate.setUTCDate(startDate.getUTCDate() + 1);
  const startISO = startDate.toISOString().slice(0, 10);
  const overlapAccounts = Object.entries(lastExportedByAccount || {})
    .filter(([, marker]) => marker && marker >= startISO)
    .map(([account]) => account);
  return { startISO, endISO: todayISO, overlapAccounts };
}
