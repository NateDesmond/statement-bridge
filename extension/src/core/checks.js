// Balance/count checks and per-file summaries over normalized rows.

import { lineText, matchAmountLine, looksLikeNonTransactionLine } from './pdf.js';

/**
 * Human wording for every row flag normalize.js can set, shared by every
 * screen that shows a flag id to a user (the wizard Test step's chips and
 * row captions, Review's row tags) - one map so the same flag always reads
 * the same way everywhere, instead of each screen keeping its own
 * near-duplicate copy that quietly drifts.
 */
export const FLAG_LABELS = {
  unparseable_date: 'Date could not be read',
  missing_amount: 'Amount missing',
  possible_duplicate: 'Possible duplicate',
  date_outside_period: 'Date outside statement period',
  manually_added: 'Added manually, not from the source file',
  ocr: 'Read with text recognition',
  low_confidence_ocr: 'Low confidence, check against the page',
  sign_unclear: 'Direction unconfirmed, check against the page',
  pending: 'Pending, not yet posted',
  unmatched_line: 'Could not match to a line on the page',
};

/** flagLabel('unparseable_date') -> 'Date could not be read'; an id with no entry above shows as-is rather than disappearing. */
export function flagLabel(flag) {
  return FLAG_LABELS[flag] || flag;
}

/**
 * Item 1: label for one row's flag, preferring the row's own
 * low_confidence_hint (normalize.js's OCR safety net "read as X with no
 * decimal point, likely Y" text) over the generic low_confidence_ocr caption
 * - same flag id, more useful wording whenever normalize.js had something
 * concrete to say. Every other flag, or a row with no hint, falls back to
 * flagLabel unchanged.
 * @param {string} flag
 * @param {object} [row]
 */
export function rowFlagLabel(flag, row) {
  if (flag === 'low_confidence_ocr' && row?.low_confidence_hint) return row.low_confidence_hint;
  return flagLabel(flag);
}

/**
 * Verify opening + running sum of amounts reconciles to each row's stated
 * balance, and that opening + total = closing.
 * @param {object[]} rows - normalized rows (with .amount, .balance in minor units), in statement order.
 * @param {{opening?: number, closing?: number}} [opts] - known opening/closing balances (minor units), if not derivable from rows.
 */
export function balanceCheck(rows, opts = {}) {
  const withBalance = rows.filter((r) => r.balance != null && r.amount != null);
  let opening = opts.opening;
  if (opening == null && withBalance.length) opening = withBalance[0].balance - withBalance[0].amount;

  let running = opening;
  let firstFailingRow = null;
  let lastVerifiedIdx = -1;
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    if (row.amount == null) continue;
    running += row.amount;
    if (row.balance != null) {
      if (running !== row.balance) {
        firstFailingRow = { row_id: row.row_id, expected: row.balance, computed: running };
        break;
      }
      lastVerifiedIdx = idx;
    }
  }
  const closing = opts.closing != null ? opts.closing : (withBalance.length ? withBalance[withBalance.length - 1].balance : null);
  const total = rows.reduce((sum, r) => sum + (r.amount || 0), 0);
  const reconciles = opening != null && closing != null ? opening + total === closing : null;

  // A row with no stated balance of its own (a phantom footer/total row that
  // slipped past footer detection, say) never fails the per-row check above,
  // but can still throw off the overall total. Point at the first such row
  // after the last one we could actually verify.
  if (!firstFailingRow && reconciles === false) {
    const suspect = rows.slice(lastVerifiedIdx + 1).find((r) => r.amount != null);
    if (suspect) firstFailingRow = { row_id: suspect.row_id, expected: null, computed: null };
  }

  return { opening: opening ?? null, closing, total, reconciles, firstFailingRow };
}

/**
 * Count check: compare the number of "date-leading" lines in the raw source
 * text against the number of rows actually extracted.
 * @param {string} sourceText - raw file text
 * @param {number} extractedCount
 * @param {RegExp} [dateLineRe] - pattern matching a line that starts a transaction (defaults to common numeric date prefixes)
 */
// Matches a numeric date ("15/06/2026", "2026-06-15") or a day-month-name
// date ("15 Sep 2026", DBS's real CSV/PDF export format) at the start of a
// line, tolerating one leading CSV quote (`"15 Sep 2026",...`). The year is
// optional (2026-09-16: uob_card_sample.pdf's columns-rowModel date column
// prints "DD MMM" with no year at all - countCheck was reporting a false
// mismatch on every such file, requiring a year that was never there).
const DEFAULT_DATE_LINE_RE = /^\s*"?\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b|^\s*"?\d{1,2}\s+[A-Za-z]{3,9}\b(?:\s+\d{4}\b)?/;

export function countCheck(sourceText, extractedCount, dateLineRe = DEFAULT_DATE_LINE_RE) {
  const lines = sourceText.split(/\r\n|\r|\n/);
  const sourceLines = lines.filter((l) => dateLineRe.test(l)).length;
  return { sourceLines, extractedCount, matches: sourceLines === extractedCount, diff: extractedCount - sourceLines };
}

/**
 * Count check label for a CSV/columns-model PDF (date-led lines vs rows
 * extracted) - same {tone, text, showUpdateMappingLink} shape and "N rows
 * read, N ... found" phrasing as groupedCountLabel below, so Review's
 * summary bar reads identically regardless of which extraction path
 * produced the file (a grouped PDF's "N rows read, N amount lines found"
 * next to a CSV's "N rows read, N date lines found").
 * @param {number} extracted
 * @param {number} sourceLines
 * @param {number} diff
 * @param {boolean} matches
 * @param {string|null} [explainNote] - when the gap is fully accounted for
 *   (e.g. by skipped summary lines), what to say why - reads neutral, not a
 *   failure; omit/null for an unexplained gap
 */
export function countCheckLabel(extracted, sourceLines, diff, matches, explainNote = null) {
  const lineWord = `${sourceLines} date line${sourceLines === 1 ? '' : 's'}`;
  const base = `${extracted} rows read, ${lineWord} found`;
  if (matches) return { tone: 'ok', text: base, showUpdateMappingLink: false };
  if (explainNote) return { tone: 'neutral', text: `${base} (${explainNote}).`, showUpdateMappingLink: false };
  return { tone: 'fail', text: `${base} (diff ${diff}).`, showUpdateMappingLink: false };
}

// Loose amount-line detector for the grouped rowModel's count check: an
// optional 2-4 char currency-ish token (no confusion-map correction needed
// here - this only counts candidate lines, it doesn't extract or need the
// exact currency value), an optional sign, a 2-decimal number, at the end of
// the line. Matches core/pdf.js's matchAmountEnd's tolerance (currency
// optional, sign optional) so a dropped "+"/"-" glyph or an unreadable
// currency code still counts as a transaction-shaped line, not a miss.
// One source of truth with the extractor: a line "carries an amount" exactly
// when core/pdf.js's matchAmountLine says so (currency before or after the
// number, CR/DR markers, no decimals, parentheses). A private stricter regex
// here once required the line to END with the number, so a "178.78 SGD CR"
// layout counted zero amount lines and every extracted row was tagged unmatched.
const looksLikeAmountLine = (text) => !looksLikeNonTransactionLine(text) && !!matchAmountLine(text);

// Same default date-group line pattern core/pdf.js's extractGroupedRows uses
// (not exported there, copied - see this function's gating note below).
const DATE_GROUP_RE = /^(?:[A-Za-z]+day|Yesterday|Today),?\s*(\d{1,2}\s*[A-Za-z]{3,}\s+\d{4})$|^(\d{1,2}\s*[A-Za-z]{3,}\s+\d{4})$/;

/**
 * Count check for a rowModel 'grouped' PDF (an OCR'd or app-exported
 * statement with no fixed table, see core/pdf.js's extractGroupedRows):
 * compares the number of amount-ending lines in the raw source text against
 * the rows actually extracted. Same purpose as countCheck (which counts
 * date-led lines for CSV/columns-model PDFs) but grouped statements don't
 * have one date-led line per transaction - they have one amount-ended line
 * per transaction, with a date-group header shared across several - so it
 * needs its own line pattern instead of reusing countCheck's dateLineRe.
 * A real, worked example: a row whose amount ends up 0.00-vs-missing due to
 * a mis-attributed date-group carries on as an extracted row and would not
 * show up here; a row that failed extraction entirely (the "2 missing rows"
 * class of bug root-caused 2026-09-16 - a dropped "+" glyph made the amount
 * regex fail to match at all) does: amountLines counts it, extracted doesn't.
 * Gated the same way extractGroupedRows itself is (2026-09-16 regression:
 * a preamble line like "Available Balance: SGD 8,214.12" ends in a
 * currency+decimal shape and was being counted as a transaction before this
 * gate, even though extraction correctly never treats it as one) - nothing
 * before the first date-group line counts, and pdfConfig.ignoreLinePatterns
 * lines are dropped, same as extraction.
 * @param {string} sourceText - raw OCR/PDF text, newline-separated (core/ocr.js's ocrDocument joins pages this way)
 * @param {object[]} rows - the rows actually extracted for this file (already normalized, or a plain count)
 * @param {{ignoreLinePatterns?:string[], grouped?:{dateGroupPattern?:string}}} [pdfConfig] - the matched profile version's `pdf` config
 * @returns {{extracted:number, amountLines:number, diff:number, matches:boolean, explanation:string}}
 */
export function countCheckGrouped(sourceText, rows, pdfConfig = {}) {
  const extracted = Array.isArray(rows) ? rows.length : rows;
  const ignoreRes = (pdfConfig.ignoreLinePatterns || []).map((p) => new RegExp(p));
  const dateRe = pdfConfig.grouped?.dateGroupPattern ? new RegExp(pdfConfig.grouped.dateGroupPattern) : DATE_GROUP_RE;
  const lines = sourceText.split(/\r\n|\r|\n/);
  let dateOpened = false;
  let amountLines = 0;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || ignoreRes.some((re) => re.test(l))) continue;
    if (dateRe.test(l)) { dateOpened = true; continue; }
    if (!dateOpened) continue;
    if (looksLikeAmountLine(l)) amountLines++;
  }
  const diff = extracted - amountLines;
  const matches = diff === 0;
  const explanation = matches
    ? 'count check'
    : `count check (${Math.abs(diff)} ${diff < 0 ? 'amount line(s) not extracted' : 'extra row(s) extracted'})`;
  return { extracted, amountLines, diff, matches, explanation };
}

// A gap this small or smaller (as a fraction of the amount lines actually
// found) reads as ordinary text-recognition noise, not a real mapping
// problem - neutral grey, not a red "something's wrong" warning.
export const GROUPED_COUNT_SMALL_GAP_RATIO = 0.05;

/**
 * Item 6: same ordered walk countCheckGrouped's own counter does (nothing
 * before the first date-group line counts, ignoreLinePatterns dropped), but
 * instead of just a count it lines up EXTRACTED ROWS (in source order,
 * skipped lines excluded) one-for-one against COUNTED LINES (in page/reading
 * order) and reports which side ran out first: a row past the last counted
 * line ("unmatchedRowIds") means extraction produced something the loose
 * counter itself never saw a line for, and a counted line past the last row
 * ("missedLines") means a line that looked like a transaction produced no
 * row at all - with page + in-page line number so the wizard/Review can
 * point straight at it.
 * @param {object[]} rows - normalized rows (skipped ones are excluded automatically)
 * @param {{y:number, items:object[]}[][]} pagesLines - one groupItemsIntoLines()-shaped lines array per page
 * @param {{ignoreLinePatterns?:string[], grouped?:{dateGroupPattern?:string}}} [pdfConfig]
 * @returns {{unmatchedRowIds: Set<string>, missedLines: {page:number, lineNumber:number, text:string}[]}}
 */
export function diffGroupedExtraction(rows, pagesLines, pdfConfig = {}) {
  const ignoreRes = (pdfConfig.ignoreLinePatterns || []).map((p) => new RegExp(p));
  const dateRe = pdfConfig.grouped?.dateGroupPattern ? new RegExp(pdfConfig.grouped.dateGroupPattern) : DATE_GROUP_RE;
  const ordered = (rows || []).filter((r) => !r.skipped).sort((a, b) => (a.source_line ?? 0) - (b.source_line ?? 0));
  const unmatchedRowIds = new Set(ordered.map((r) => r.row_id));
  const missedLines = [];
  let rowIdx = 0;
  let dateOpened = false;
  for (let p = 0; p < (pagesLines || []).length; p++) {
    let lineNumber = 0;
    for (const line of pagesLines[p]) {
      lineNumber++;
      const text = lineText(line).trim();
      if (!text || ignoreRes.some((re) => re.test(text))) continue;
      if (dateRe.test(text)) { dateOpened = true; continue; }
      if (!dateOpened) continue;
      if (!looksLikeAmountLine(text)) continue;
      if (rowIdx < ordered.length) {
        unmatchedRowIds.delete(ordered[rowIdx].row_id);
        rowIdx++;
      } else {
        missedLines.push({ page: p + 1, lineNumber, text });
      }
    }
  }
  return { unmatchedRowIds, missedLines };
}

/**
 * Applies diffGroupedExtraction to a rows array in place: tags every
 * unmatched row's flags with 'unmatched_line' (informational-actionable,
 * shows up in the Warnings filter same as any other flag), and stashes the
 * missed-line details as `rows.missedLines` for the count-check UI to read
 * (a plain extra property on the array - survives postMessage's structured
 * clone across the worker boundary and a same-thread call alike). Called
 * from both core/pipeline.js's buildFileRows and src/worker.js's own PDF
 * path, so a real drop (which goes through the worker) and the wizard's
 * Test/Save (buildFileRows) never disagree about which rows are tagged.
 * @param {object[]} rows
 * @param {{y:number, items:object[]}[][]} pagesLines
 * @param {object} [pdfConfig]
 * @returns {object[]} the same rows array, mutated
 */
export function tagUnmatchedGroupedRows(rows, pagesLines, pdfConfig = {}) {
  const { unmatchedRowIds, missedLines } = diffGroupedExtraction(rows, pagesLines, pdfConfig);
  for (const r of rows) {
    if (!r.skipped && unmatchedRowIds.has(r.row_id) && !r.flags.includes('unmatched_line')) r.flags.push('unmatched_line');
  }
  rows.missedLines = missedLines;
  return rows;
}

/**
 * Human wording + severity for a countCheckGrouped result, shared by the
 * wizard's Test step, Home's health badge, and Review's summary so a
 * missing-row count mismatch reads identically everywhere it appears. Item
 * 5 (coordinator round 2026-09-17): the old single-sentence wording ("rows
 * extracted, but N amount lines found... diff N") read as scary and gave no
 * next step for an ordinary OCR gap - now three tiers: an exact match is a
 * plain green confirmation, a small gap (<=5% of the amount lines found) is
 * calm and explanatory ("small gaps are normal for text recognition"), and
 * only a real mismatch above that gets the red "something needs fixing"
 * treatment.
 * @param {number} extracted - rows actually extracted (countCheckGrouped's `extracted`)
 * @param {number} amountLines
 * @param {number} diff - extracted - amountLines
 * @param {boolean} matches
 * @returns {{tone:'ok'|'neutral'|'fail', text:string, showUpdateMappingLink:boolean}}
 */
export function groupedCountLabel(extracted, amountLines, diff, matches) {
  const amountWord = `${amountLines} amount line${amountLines === 1 ? '' : 's'}`;
  if (matches) {
    return { tone: 'ok', text: `${extracted} rows read, ${amountWord} found`, showUpdateMappingLink: false };
  }
  const gap = Math.abs(diff);
  const ratio = amountLines > 0 ? gap / amountLines : 1;
  if (ratio <= GROUPED_COUNT_SMALL_GAP_RATIO) {
    return {
      tone: 'neutral',
      text: `${extracted} rows read, ${amountWord} found in the page text. Small gaps are normal for text recognition. ${gap} row${gap === 1 ? '' : 's'} could not be matched to a line, check them.`,
      showUpdateMappingLink: false,
    };
  }
  return {
    tone: 'fail',
    text: `${extracted} rows read, ${amountWord} found in the page text (diff ${diff}).`,
    showUpdateMappingLink: true,
  };
}

/**
 * Summarize a file's normalized rows: row count, date range, in/out totals per currency.
 */
export function fileSummary(rows) {
  const active = rows.filter((r) => !r.excluded && !r.skipped);
  const dates = active.map((r) => r.date).filter(Boolean).sort();
  const byCurrency = {};
  for (const r of active) {
    if (r.amount == null) continue;
    const cur = r.currency || 'UNKNOWN';
    byCurrency[cur] ??= { in: 0, out: 0 };
    if (r.amount >= 0) byCurrency[cur].in += r.amount;
    else byCurrency[cur].out += -r.amount;
  }
  return {
    rowCount: active.length,
    dateRange: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
    byCurrency,
  };
}
