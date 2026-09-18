// PDF text extraction with positions, then grouping into statement rows.
// The pure functions (groupItemsIntoLines, assignColumns, extractRows) work on
// plain item arrays shaped like pdf.js getTextContent() output, so they are
// node-testable without a real PDF or pdf.js loaded.

import { log } from './debuglog.js';
import { FOOTER_PHRASE_RE } from './suggest.js';

// Day and month tolerate zero whitespace between them (\s*, not \s+): OCR
// (core/ocr.js) sometimes merges a short day number tight against the
// following month abbreviation into one word-token ("1 Sep" -> "1Sep") when
// they render close together on the source page, and a real pdf.js text
// layer never has this problem (its items always keep the source PDF's own
// spacing) so relaxing this costs nothing there.
const GENERIC_DATE_RE = /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b|^\d{4}-\d{2}-\d{2}\b|^\d{1,2}\s*[A-Za-z]{3,9}\b/;
const COLUMN_CLUSTER_TOLERANCE = 5; // points; item x-starts within this are "the same column"

/**
 * Group text items into lines by y-position, tolerant of small jitter.
 * PDF coordinate space has y increasing upward, so the top-most line on the
 * page (read first) has the largest y; lines are returned in that reading order.
 * @param {{str:string, x:number, y:number}[]} items - one page's text items (pdf.js getTextContent() shape)
 * @param {number} [tolerance=2]
 * @returns {{y:number, items:{str:string,x:number,y:number}[]}[]} lines, top to bottom, items sorted left to right
 */
export function groupItemsIntoLines(items, tolerance = 2) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    let line = lines.find((l) => Math.abs(l.y - item.y) <= tolerance);
    if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

/** Join a line's items into a plain text string (space-joined). */
export function lineText(line) {
  return line.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Assign a line's items to profile-defined columns by x-position.
 * @param {{y:number, items:{str:string,x:number,y:number}[]}} line
 * @param {{field:string, x0:number, x1:number}[]} columns
 * @returns {Record<string,string>} field -> joined text within that column's x-range
 */
export function assignColumns(line, columns) {
  const result = {};
  for (const col of columns) result[col.field] = '';
  for (const item of line.items) {
    const col = columns.find((c) => item.x >= c.x0 && item.x < c.x1);
    if (col) result[col.field] = (result[col.field] ? result[col.field] + ' ' : '') + item.str;
  }
  for (const field of Object.keys(result)) result[field] = result[field].trim();
  return result;
}

function matchesAnchor(text, anchor) {
  return anchor ? text.includes(anchor) : false;
}

/**
 * A line's OCR confidence (the minimum of its items' `confidence`, 0-100), or
 * null when the line has no confidence field at all (real pdf.js text items
 * don't carry one, so a non-OCR line is always null here). Used to tag
 * OCR-derived rows with the lowest-confidence word that composed them, so a
 * misread word doesn't hide inside an otherwise-fine row.
 * @param {{items:{confidence?:number}[]}} line
 */
function lineConfidence(line) {
  const vals = line.items.map((it) => it.confidence).filter((v) => typeof v === 'number');
  return vals.length ? Math.min(...vals) : null;
}

function minConfidenceOf(items) {
  const vals = items.map((it) => it.confidence).filter((v) => typeof v === 'number');
  return vals.length ? Math.min(...vals) : null;
}

function minConfidence(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

/**
 * A line's own visual height in PDF-space points, from its items' `height`
 * (real pdf.js text items and OCR items - core/ocr.js's tesseractLinesToItems
 * - both carry one; a line with none, e.g. an older cached OCR pass from
 * before that field existed, falls back to the same 10pt review.js used to
 * assume for every line).
 * @param {{items:{height?:number}[]}} line
 */
function lineHeight(line) {
  const heights = line.items.map((it) => it.height).filter((h) => typeof h === 'number' && h > 0);
  return heights.length ? Math.max(...heights) : 10;
}

/**
 * Stamp a row/record object with where it came from on the source page:
 * `source_page` (1-indexed, set by extractPdfPagesRows tagging each line
 * before flattening; null when a caller extracts from a single untagged
 * lines array), `source_y` (the line's own PDF-space y, same coordinate
 * space renderPdfPage's items use - real text or OCR items alike, since OCR
 * items are shaped to match pdf.js's getTextContent() output), `source_h`
 * (that line's own height, so review.js's overlay can size a box around its
 * real text instead of a flat guess), and `source_line` (the line's index
 * within its page, for a stable tie-break when two lines share a y). Used by
 * review.js to jump/outline the exact source line a row was extracted from,
 * instead of re-deriving it.
 * @param {object} obj
 * @param {{y:number, page?:number, lineIndex?:number}} line
 */
function tagSource(obj, line) {
  obj.source_page = line.page ?? null;
  obj.source_y = line.y;
  obj.source_h = lineHeight(line);
  obj.source_line = line.lineIndex ?? null;
  return obj;
}

/**
 * Extend an already-tagged row/record's source box down to a LATER line that
 * turned out to belong to the same transaction - a wrapped continuation line
 * in a columns table (extractRows' joinWrappedLines), or a grouped block's
 * trailing type line (extractGroupedRows). `source_y2` becomes the bottom
 * edge of the outline box (review.js draws it from `source_y + source_h`,
 * the first line's top, down to `source_y2`, the last line's bottom); called
 * again for a further continuation line just keeps moving it to the true
 * last one.
 * @param {object} obj
 * @param {{y:number}} line
 */
function extendSourceTo(obj, line) {
  obj.source_y2 = line.y;
}

/**
 * Confidence of just the items inside a line that fall within one x-range
 * (a profile column's x0/x1), the same test assignColumns uses - so a
 * misread merchant-name word in the description column never drags down the
 * confidence of a correctly-read amount elsewhere on the same line. Used to
 * compute per-field confidence (amount, date) instead of one whole-line
 * number (which is what made low_confidence_ocr "too eager": a common-word
 * misread anywhere in a long description line used to flag the whole row).
 */
function columnConfidence(line, x0, x1) {
  return minConfidenceOf(line.items.filter((it) => it.x >= x0 && it.x < x1));
}

/**
 * Confidence of just the items overlapping one character range of a line's
 * joined text (lineText's own `items.map(i=>i.str).join(' ')` - callers pass
 * a regex match's own `.index`/`[0].length` from matching against lineText's
 * output). Same purpose as columnConfidence, for the grouped rowModel, which
 * has no fixed columns to test x-ranges against - only the amount match's own
 * matched substring should set the row's amount confidence, not the whole
 * line (which is mostly the merchant description).
 */
function itemsForTextRange(line, index, length) {
  const items = [];
  let pos = 0;
  for (const item of line.items) {
    const start = pos;
    const end = pos + item.str.length;
    if (end > index && start < index + length) items.push(item);
    pos = end + 1; // +1 for the single space lineText joins items with
  }
  return items;
}

// Item 2/5 (2026-09-17): a PDF's own printed column headings, narrower than
// suggest.js's CSV header dictionary (a PDF's headings are always the
// statement's own primary language; suggest.js's multi-language CSV case
// doesn't come up here) - used both to infer real column bands from the
// data (inferPdfColumns) instead of always guessing a fixed 3-band date/
// description/amount split, and to recognize a table header repeating on a
// later page (isRepeatedHeaderLine) so it's dropped instead of getting
// joined into whichever row happens to precede it (item 5's Chase page-
// break miss: the repeated header landed right after a page break and
// corrupted the previous transaction's own amount).
const PDF_COLUMN_HEADER_WORDS = [
  [/^withdrawal|^debit\b/i, 'debit'],
  [/^deposit|^credit\b/i, 'credit'],
  [/^balance/i, 'balance'],
  [/^amount/i, 'amount'],
  [/^date/i, 'date'],
  [/^description|^particulars|^details/i, 'description_raw'],
];

function headerFieldFor(word) {
  const t = String(word ?? '').trim();
  for (const [re, field] of PDF_COLUMN_HEADER_WORDS) if (re.test(t)) return field;
  return null;
}

/** A line with 2+ recognizable column-header words on it (in any position) - a real header row, or one repeating on a later page. */
function isHeaderLikeLine(line) {
  return line.items.filter((it) => headerFieldFor(it.str)).length >= 2;
}

/** The first header-like line among `lines`, scanning only up to (not including) `stopIdx` (the first date-led line, if any) - a header always sits above the transaction table, never inside it. */
function findHeaderLine(lines, stopIdx) {
  const scanEnd = stopIdx >= 0 ? stopIdx : lines.length;
  for (let i = 0; i < scanEnd; i++) if (isHeaderLikeLine(lines[i])) return lines[i];
  return null;
}

// A single text item that IS a numeric amount token, decorated or not
// (an optional leading sign/currency, optional thousands commas/decimal,
// optional trailing CR/DR marker) - used to cluster amount-column x
// positions the same way inferGenericTable clusters date-led lines' x
// positions into text columns.
const NUMERIC_ITEM_RE = /^[+-]?[$€£¥]?\(?[\d,]+(?:\.\d{1,3})?\)?\s*(?:CR|DR)?\.?$/i;

function isNumericItem(str) {
  const t = String(str ?? '').trim();
  return !!t && NUMERIC_ITEM_RE.test(t);
}

/**
 * Item 2: cluster numeric-item x-starts on `lines` into 1-3 right-hand
 * numeric column bands (an amount column, a debit/credit pair, or those
 * plus a running balance) - the no-header fallback for inferPdfColumns,
 * same clustering idea inferGenericTable uses for text columns.
 * @returns {{x:number, count:number}[]} left to right, at most 3
 */
export function clusterNumericColumns(lines) {
  const xs = [];
  for (const line of lines) for (const item of line.items) if (isNumericItem(item.str)) xs.push(item.x);
  xs.sort((a, b) => a - b);
  const clusters = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.sum / last.count <= COLUMN_CLUSTER_TOLERANCE * 6) { last.sum += x; last.count += 1; }
    else clusters.push({ sum: x, count: 1 });
  }
  // A real column recurs on a real fraction of the sampled lines; a one-off
  // mid-description number (a merchant's own reference digits, say) doesn't.
  const supported = clusters.filter((c) => lines.length === 0 || c.count >= Math.max(2, lines.length * 0.15));
  return supported
    .map((c) => ({ x: c.sum / c.count, count: c.count }))
    .sort((a, b) => a.x - b.x)
    .slice(-3);
}

/**
 * Item 2 fallback: assign amount/debit-credit/balance roles to numeric
 * clusters with no header words to go by - position and count only (the
 * rightmost of 2+ clusters is a running balance; two clusters with no
 * balance context read as a debit/credit pair; one is a plain amount).
 * @param {{x:number}[]} clusters left to right
 * @returns {{x:number, field:string}[]}
 */
export function assignNumericClusterRolesByPosition(clusters) {
  if (clusters.length === 1) return [{ x: clusters[0].x, field: 'amount' }];
  if (clusters.length === 2) return [{ x: clusters[0].x, field: 'debit' }, { x: clusters[1].x, field: 'credit' }];
  if (clusters.length >= 3) {
    const [debit, credit, balance] = clusters.slice(-3);
    return [{ x: debit.x, field: 'debit' }, { x: credit.x, field: 'credit' }, { x: balance.x, field: 'balance' }];
  }
  return [];
}

/**
 * Item 2: infer a columns-rowModel PDF's column bands from the data itself
 * (a real table can have 1-3 right-hand numeric columns: a single combined
 * amount, separate debit/credit, or those plus a running balance) instead
 * of always guessing a fixed 3-band date/description/amount split, which
 * glues every extra numeric column onto "amount" and corrupts any row that
 * has one (root causes 2 and 4, REPORT-OCR-GENERALISATION.md - OCBC's
 * Withdrawal/Deposit/Balance and Maybank's Amount+Balance). Prefers the
 * PDF's own printed header words when a header row is found; falls back to
 * clustering the numeric tokens' x positions by position/count otherwise.
 * @param {{y:number, items:{str:string,x:number,y:number}[]}[]} lines - one page's (or the whole document's) lines
 * @param {number} pageWidthPt
 * @param {RegExp} [dateRe]
 * @returns {{field:string, x0:number, x1:number}[]} column defs, left to right, always starting with date + description_raw
 */
export function inferPdfColumns(lines, pageWidthPt, dateRe = GENERIC_DATE_RE) {
  const dateLineIdxs = [];
  lines.forEach((l, i) => { if (dateRe.test(lineText(l))) dateLineIdxs.push(i); });
  const dataLines = dateLineIdxs.length ? dateLineIdxs.map((i) => lines[i]) : lines;
  const header = findHeaderLine(lines, dateLineIdxs[0] ?? -1);

  let numericFields = header
    ? header.items
      .map((it) => ({ x: it.x, field: headerFieldFor(it.str) }))
      .filter((h) => h.field && h.field !== 'date' && h.field !== 'description_raw')
      .sort((a, b) => a.x - b.x)
    : [];
  if (!numericFields.length) numericFields = assignNumericClusterRolesByPosition(clusterNumericColumns(dataLines));

  if (!numericFields.length) {
    // Nothing numeric detected at all - fall back to the old fixed 3-band split.
    return [
      { field: 'date', x0: 0, x1: pageWidthPt * 0.18 },
      { field: 'description_raw', x0: pageWidthPt * 0.18, x1: pageWidthPt * 0.65 },
      { field: 'amount', x0: pageWidthPt * 0.65, x1: pageWidthPt },
    ];
  }

  const firstNumX = numericFields[0].x;
  const columns = [
    { field: 'date', x0: 0, x1: pageWidthPt * 0.18 },
    { field: 'description_raw', x0: pageWidthPt * 0.18, x1: Math.max(pageWidthPt * 0.18, firstNumX - 24) },
  ];
  numericFields.forEach((f, i) => {
    const x0 = i === 0 ? Math.max(pageWidthPt * 0.18, firstNumX - 24) : (numericFields[i - 1].x + f.x) / 2;
    const x1 = i + 1 < numericFields.length ? (f.x + numericFields[i + 1].x) / 2 : pageWidthPt;
    columns.push({ field: f.field, x0, x1 });
  });
  return columns;
}

/**
 * Extract table rows from a page's lines per a profile's pdf config: locate
 * tableStart/tableEnd anchors, keep only rows matching rowStartPattern,
 * join wrapped continuation lines into the row above, drop ignoreLinePatterns.
 * @param {{y:number, items:object[]}[]} lines
 * @param {object} pdfConfig - profile.pdf per PROFILE_SCHEMA.md
 * @returns {Record<string,string>[]} column-field-keyed row objects
 */
export function extractRows(lines, pdfConfig) {
  const { tableStart, tableEnd, columns = [], rowStartPattern, joinWrappedLines, ignoreLinePatterns = [] } = pdfConfig;
  const rowStartRe = rowStartPattern ? new RegExp(rowStartPattern) : null;
  const ignoreRes = ignoreLinePatterns.map((p) => new RegExp(p));
  // Only the amount and date columns' own confidence should ever gate
  // low_confidence_ocr (a misread word elsewhere - description, reference -
  // must not flag the row); see columnConfidence's doc comment.
  const amountCols = columns.filter((c) => c.field === 'amount' || c.field === 'debit' || c.field === 'credit');
  const dateCols = columns.filter((c) => c.field === 'date');
  const fieldConfidence = (line, cols) => cols.reduce((acc, c) => minConfidence(acc, columnConfidence(line, c.x0, c.x1)), null);

  let inTable = !tableStart;
  const rows = [];
  let currentRow = null;

  for (const line of lines) {
    const text = lineText(line);
    if (!inTable) {
      if (matchesAnchor(text, tableStart?.anchor)) inTable = true;
      continue;
    }
    if (tableEnd && matchesAnchor(text, tableEnd.anchor)) break;
    if (ignoreRes.some((re) => re.test(text))) continue;
    // Item 5: a table header repeating on a continuation page (or a page
    // footer/balance-summary line, e.g. "Page 2 of 3") is noise, not a new
    // row nor a continuation of the previous one - without this it silently
    // corrupted whichever row precedes it via joinWrappedLines (Chase's
    // page-break miss, REPORT-OCR-GENERALISATION.md).
    if (isHeaderLikeLine(line) || looksLikeNonTransactionLine(text)) continue;

    const isRowStart = !rowStartRe || rowStartRe.test(text);
    const assigned = assignColumns(line, columns);
    // Item 2 (OCBC's "Balance B/F" opening row): a row-start line whose own
    // description column reads as an opening/closing-balance or total
    // phrase (suggest.js's FOOTER_PHRASE_RE, shared with normalize.js's own
    // CSV safety net for the same wording) is never a transaction, even
    // though it happens to lead with a real date the same way every real
    // transaction row does.
    if (isRowStart && FOOTER_PHRASE_RE.test((assigned.description_raw || '').trim())) continue;
    const amtConf = fieldConfidence(line, amountCols);
    const dateConf = fieldConfidence(line, dateCols);

    if (isRowStart || !currentRow) {
      if (currentRow) rows.push(currentRow);
      currentRow = assigned;
      currentRow._amountConfidence = amtConf;
      currentRow._dateConfidence = dateConf;
      tagSource(currentRow, line);
    } else if (joinWrappedLines && currentRow) {
      for (const field of Object.keys(assigned)) {
        if (assigned[field]) currentRow[field] = (currentRow[field] ? currentRow[field] + ' ' : '') + assigned[field];
      }
      currentRow._amountConfidence = minConfidence(currentRow._amountConfidence, amtConf);
      currentRow._dateConfidence = minConfidence(currentRow._dateConfidence, dateConf);
      // The row's own anchor (source_y/source_h) stays its first (row-start)
      // line, but the outline box now extends down to this continuation
      // line too (source_y2) - a UOB-style two-line row (amount wraps to its
      // own line) is a real, visible multi-line block on the page.
      extendSourceTo(currentRow, line);
    } else {
      assigned._amountConfidence = amtConf;
      assigned._dateConfidence = dateConf;
      tagSource(assigned, line);
      rows.push(assigned);
    }
  }
  if (currentRow) rows.push(currentRow);
  return rows;
}

// rowModel 'grouped': "app export" style PDFs (DBS digibank Transaction
// History and similar) that have no fixed table columns at all. Instead a
// date-group line ("Yesterday, 15 Sep 2026") sets the current date, and each
// following line whose text ends in an amount ("SGD - 20.83") starts a new
// transaction (description = everything before the amount); further lines
// until the next amount or date line are a continuation (a transaction-type
// line, e.g. "Point-of-Sale Transaction · POS") joined into `type`.
// Same OCR word-merge tolerance as GENERIC_DATE_RE above (\s* between day and
// month, not \s+): this is the regex that actually broke on a real 3-page
// statement (root-caused 2026-09-16) - Tesseract read a bare "1 Sep 2026"
// date-group line as one token "1Sep 2026", which silently failed the old
// \s+ match entirely (no error, just no dateMatch), leaving every
// transaction under that group mis-attributed to the previous, still-current
// date instead. date.js's 'DD MMM YYYY'/'DD MMM' parsing needs the same
// tolerance (see date.js), since the day+month join survives into date_raw.
const DEFAULT_DATE_GROUP_RE = /^(?:[A-Za-z]+day|Yesterday|Today),?\s*(\d{1,2}\s*[A-Za-z]{3,}\s+\d{4})$|^(\d{1,2}\s*[A-Za-z]{3,}\s+\d{4})$/;

// Digit<->letter OCR confusions common in a 3-letter currency code read off a
// scanned/rasterized statement (e.g. "SGD" -> "S6D", "SGO"). Applied only to
// a captured token that ISN'T already 3 plain letters, and only if the fix
// actually produces 3 plain letters - never invented, never applied to a
// token that already parses cleanly.
const CURRENCY_OCR_CONFUSION = { 0: 'O', 1: 'I', 5: 'S', 6: 'G', 8: 'B' };

/** Correct a captured currency-code token via CURRENCY_OCR_CONFUSION, or return it unchanged if it's already 3 plain letters, or null if it can't be made into one. */
export function normalizeOcrCurrencyToken(token) {
  if (!token) return null;
  if (/^[A-Za-z]{3}$/.test(token)) return token.toUpperCase();
  const fixed = token.split('').map((c) => CURRENCY_OCR_CONFUSION[c] || c).join('');
  return /^[A-Za-z]{3}$/.test(fixed) ? fixed.toUpperCase() : null;
}

// Currencies with a decimal count other than the 2 this app otherwise
// assumes everywhere (PROFILE_SCHEMA.md: amounts are minor-unit integers,
// e.g. cents). Used only to keep the amount-line REGEX from requiring a
// decimal point that a JPY/KRW/IDR/VND statement never prints ("Y12,000",
// not "12,000.00"). ponytail: normalizeAmountDigits below still formats
// every amount as if it had 2 decimals (existing app-wide limitation, not
// something this extractor alone can fix - core/amount.js's minor-unit
// conversion has no currency-decimals concept anywhere in this codebase,
// CSV path included); upgrade path is a currency-decimals-aware
// core/amount.js if a real 0-decimal-currency statement needs correct math,
// not just recognition.
const CURRENCY_ZERO_DECIMALS = new Set(['JPY', 'KRW', 'IDR', 'VND']);

// A line whose SHAPE is never a transaction amount line, regardless of what
// number happens to be on it - checked before the amount regex runs at all.
// This is the DEFAULT list, applied even with no profile/wizard config at
// all (a grouped profile not yet mapped, or a builtin without its own
// ignoreLinePatterns); a matched profile's own ignoreLinePatterns (see
// builtin-profiles.js) is additional, not a replacement. Once
// matchAmountLine stopped requiring a decimal point (some banks print round
// amounts with none), an account summary line like "Available Balance SGD
// 33,889.56" reads exactly like a transaction unless excluded by its own
// wording - real statements' account-summary section reliably uses these
// same handful of phrases.
const NON_TRANSACTION_LINE_RE = /^page\s+\d+\s+of\s+\d+$/i;
// "Ref: SB700001"-style reference lines are common banking vocabulary (not
// tied to any one bank) and never a transaction amount on their own; a
// reference number OCR'd with just enough digits to slip under
// BARE_REFERENCE_MIN_DIGITS could otherwise open a spurious extra
// transaction (the "worst case" fixture's 35 extras, REPORT-OCR-
// GENERALISATION.md item 5's secondary finding).
const NON_TRANSACTION_PHRASES_RE = /transactions as of|available balance|ledger balance|current balance|available credit limit|reward points|^total\b|^subtotal\b|^ref(?:erence)?[:\s]/i;
// A statement-period range ("16 Sep 2026 - 15 Oct 2026") repeats at the top
// of every page (not just page 1, so the "nothing is a transaction before
// the first date group" state check alone doesn't catch it on page 2+, only
// on the very first page) - no real transaction line ever carries two
// 4-digit years.
const TWO_YEARS_RE = /\b(19|20)\d{2}\b.*\b(19|20)\d{2}\b/;
// A month banner line ("September 2026") or a bare 4-digit year on its own
// line - some statements print one of these as a section divider between
// date groups. TWO_YEARS_RE only catches a line with two years on it (a
// statement-period range); this line has just one, and with
// matchAmountLine's decimal now optional, a bare "2026" parses as a clean
// no-currency, no-marker amount ("2026") and becomes a phantom transaction
// (REPORT-OCR-L6MO.md finding, item 8). Exported so extractGroupedRows can
// also skip it outright as a context marker, never merging it into a
// pending row's `type` field the way an unrecognised line otherwise would.
export const MONTH_YEAR_BANNER_RE = /^[A-Za-z]{3,}\s+(?:19|20)\d{2}$/;
const BARE_YEAR_RE = /^(?:19|20)\d{2}$/;

function looksLikeNonTransactionLine(text) {
  const t = text.trim();
  if (NON_TRANSACTION_LINE_RE.test(t) || NON_TRANSACTION_PHRASES_RE.test(text) || TWO_YEARS_RE.test(text)) return true;
  if (MONTH_YEAR_BANNER_RE.test(t) || BARE_YEAR_RE.test(t)) return true;
  // A bare date-group line ("11 Sep 2026", "Yesterday, 15 Sep 2026") is never
  // itself an amount line - without this, making the decimal part optional
  // (some banks print round amounts with none) means a plain "11 Sep 2026"
  // would otherwise parse as currency="Sep" + amount 2026, a false positive.
  // extractGroupedRows already checks its own dateRe first and never reaches
  // here for a real date-group line, but the standalone detector guards
  // against the same shape independently, per the same "exclude by shape,
  // not by requiring a decimal" design this whole function implements.
  if (DEFAULT_DATE_GROUP_RE.test(t)) return true;
  return false;
}

// The number itself: a run of digits with any mix of thousands separators
// (comma, dot, or space/nbsp) - the shape alone is deliberately permissive
// here; resolveGroupedNumber below decides which separator (if any) is the
// DECIMAL one, the same way amount.js's splitSeparators does for CSV. Some
// banks print round amounts with no decimal at all ("500", "1 200"), and
// zero-decimal currencies (JPY/KRW/IDR/VND) never have one.
const NUMBER_RE = '\\d[\\d.,\\u00A0 ]*\\d|\\d';

// Corpus fix (2026-09-18): the original NUMBER_RE only ever treated a comma
// as a thousands separator and a DOT as the (optional) decimal point - a
// European statement's "1.234,56" (dot thousands, comma decimal) or
// "1 234,56" (space thousands) never matched the old pattern's trailing
// `(?:\.\d{1,3})?` at all once the comma decimal appeared after it, so the
// whole line silently failed to read as an amount (real rows dropped, not
// misread). Mirrors amount.js's own heuristic: a trailing 1-2 digit group
// after a comma is the decimal; a trailing dot-decimal of 1-3 digits (the
// original, still-supported shape) is unchanged.
function resolveGroupedNumber(raw) {
  const cleaned = raw.replace(/ /g, ' ');
  const euro = cleaned.match(/^([\d.\s]*\d),(\d{1,2})$/);
  if (euro) return { digits: `${euro[1].replace(/[.\s]/g, '')}.${euro[2]}`, hasDecimal: true };
  const us = cleaned.match(/^([\d,]+)(?:\.(\d{1,3}))?$/);
  if (us) return { digits: us[1].replace(/,/g, '') + (us[2] ? `.${us[2]}` : ''), hasDecimal: !!us[2] };
  return null; // a lone thousands separator with nothing after it, etc - not a real number
}
// A trailing CR/DR/C/D marker, tolerant of a trailing dot and of lowercase
// (OCR case is unreliable): "CR", "Cr.", "DR", "C", "D".
const MARKER_WORD_RE = '(?:CR|DR)\\.?|[CD]';
// Amount-line shape, independent of how (or whether) the sign is expressed:
// optional currency code/symbol, optional sign or open-paren before the
// number, the number, optional close-paren, optional trailing sign, optional
// trailing CR/DR/C/D marker. Whichever marker (if any) is present is
// resolved into an actual +/- by resolveGroupedSign, using the profile's
// signConvention - detecting "is this an amount line" is deliberately kept
// separate from "what does the sign mean" - a misread or
// entirely-dropped sign glyph must never make the line invisible to the
// extractor, only uncertain (flag 'sign_unclear', not a missing row).
// Item 3 (2026-09-17): a currency code can sit AFTER the number instead of
// before it ("20.83 SGD", "150.00 SGD CR" - UOB's own card statement export)
// - matchAmountLine had a currency-prefix slot but no currency-suffix one,
// so every one of these lines failed the whole regex and the transaction
// was never even opened (root cause 3/4, REPORT-OCR-GENERALISATION.md).
// Group 8 below mirrors group 1's shape, just after the number/parens/sign
// instead of before; whichever slot actually matched is what
// matchAmountLine reports as the line's currency.
const AMOUNT_LINE_RE = new RegExp(
  `(?:(?<![A-Za-z0-9])([A-Za-z0-9]{3}|[$€£¥])\\s*)?` + // 1: leading currency code/symbol (must be its own token, not the tail of a longer word)
  `([+-])?\\s*` + // 2: leading sign
  `(\\()?\\s*` + // 3: open paren
  `(${NUMBER_RE})` + // 4: the number
  `\\s*(\\))?` + // 5: close paren
  `\\s*([+-])?` + // 6: trailing sign
  `(?:\\s*([A-Za-z]{3}))?` + // 7: trailing currency code (no bare symbol - a trailing "$" isn't a real-world shape)
  `\\s*(${MARKER_WORD_RE})?` + // 8: trailing CR/DR/C/D
  `\\s*$`,
  'i',
);
// Reference/account numbers routinely run past 8 digits (DBS's own
// transaction reference is 15); a bare digit run this long with no
// currency, no decimal point, and no sign/CR-DR marker at all is an
// identifier, not an amount - matched positionally (must still be at the
// very end of the line) rather than by digit count alone, so a real 9+
// digit amount printed with an explicit currency or marker still counts.
const BARE_REFERENCE_MIN_DIGITS = 8;

/**
 * Detect whether a line carries a transaction amount, decoupled from what
 * its sign means (see resolveGroupedSign for that step) and tolerant of
 * missing decimals, an unreadable currency code, or a missing/misread sign.
 * A line is only ever excluded outright for its SHAPE (a page footer, an
 * "as of" balance line, or a bare long reference number) - never for having
 * an ambiguous sign.
 * @param {string} text
 * @param {RegExp} [customRe] - a profile-supplied override (capture groups: currency, sign, digits); used as-is, no fallback/guards
 * @returns {{index:number, length:number, currency:string|null, digits:string, hasDecimal:boolean, markerType:'SIGN'|'CRDR'|'PAREN'|null, markerSign:'+'|'-'|null}|null}
 */
export function matchAmountLine(text, customRe) {
  if (customRe) {
    const m = text.match(customRe);
    return m ? { index: m.index, length: m[0].length, currency: m[1] || null, digits: (m[3] || '').replace(/,/g, ''), hasDecimal: /\./.test(m[3] || ''), markerType: m[2] ? 'SIGN' : null, markerSign: m[2] || null } : null;
  }
  if (looksLikeNonTransactionLine(text)) return null;
  const m = text.match(AMOUNT_LINE_RE);
  if (!m) return null;
  const [, curRaw, leadSign, openParen, digitsRaw, closeParen, trailSign, curRawTrail, trailMarker] = m;

  const resolved = resolveGroupedNumber(digitsRaw);
  if (!resolved) return null;
  const { digits: bareDigits, hasDecimal } = resolved;
  const hasMarker = !!(leadSign || trailSign || trailMarker || (openParen && closeParen));
  // Item 3: a currency code can sit before OR after the number - whichever
  // slot matched (never both on the same line, the regex only allows one).
  const curToken = curRaw || curRawTrail;
  const currency = curToken
    ? (/[A-Za-z0-9]{3}/.test(curToken) ? normalizeOcrCurrencyToken(curToken) : curToken)
    : null;
  // Reference-number guard: reject a bare long digit run with nothing else
  // (no currency, no decimal, no marker) to lean on.
  if (!hasDecimal && !currency && !hasMarker && bareDigits.length > BARE_REFERENCE_MIN_DIGITS) return null;
  // Item 5: a completely undecorated 1-digit number (no currency, no
  // decimal, no marker) is almost never a real amount - a real bank never
  // prints a bare "3" as a transaction total - and is far more often a
  // stray page-count fragment ("Page 1 of 3") that happened to land on the
  // same line as something else (the "worst case" fixture's per-page footer,
  // merged with its balance-summary line by a shared y-position).
  if (!hasDecimal && !currency && !hasMarker && bareDigits.length < 2) return null;

  let markerType = null;
  let markerSign = null;
  if (openParen && closeParen) { markerType = 'PAREN'; markerSign = '-'; }
  else if (leadSign) { markerType = 'SIGN'; markerSign = leadSign; }
  else if (trailSign) { markerType = 'SIGN'; markerSign = trailSign; }
  else if (trailMarker) {
    const norm = trailMarker.toUpperCase().replace('.', '');
    if (norm === 'CR' || norm === 'C') { markerType = 'CRDR'; markerSign = '+'; }
    else if (norm === 'DR' || norm === 'D') { markerType = 'CRDR'; markerSign = '-'; }
  }

  return { index: m.index, length: m[0].length, currency, digits: bareDigits, hasDecimal, markerType, markerSign };
}

// Backward-compatible alias: existing callers/tests that only care about a
// literal +/- (the common case, DBS's own export) still get the same
// {index,length,currency,sign,digits} shape matchAmountEnd always returned.
export function matchAmountEnd(text, customRe) {
  const m = matchAmountLine(text, customRe);
  if (!m) return null;
  return { index: m.index, length: m.length, currency: m.currency, sign: m.markerType === 'SIGN' ? m.markerSign : '', digits: m.digits };
}

/** Format a bare digit string (from matchAmountLine, commas already stripped) as a 2-decimal amount string, e.g. "500" -> "500.00", "20.83" stays "20.83". See CURRENCY_ZERO_DECIMALS's doc comment for the known limitation this papers over. */
function normalizeAmountDigits(digits) {
  return digits.includes('.') ? digits : `${digits}.00`;
}

/**
 * Resolve an amount line's actual sign from its detected marker (see
 * matchAmountLine) plus the profile's signConvention - CSV's own
 * signConvention values (`signed`, `crdr`, `positiveIsOut`, `positiveIsIn`)
 * apply the same way here, plus `columnBands` (two x-ranges, debit/credit,
 * for statements that print them in separate right-hand columns instead of
 * a marker at all). A marker that IS present (an explicit sign, CR/DR, or
 * parens) always resolves cleanly; only a truly marker-less line is a
 * guess (default: positive, `unclear: true`) - the row is never dropped for
 * this, only flagged (normalize.js's 'sign_unclear').
 * @param {{markerType:string|null, markerSign:string|null}} match
 * @param {number|null} x - the matched amount's own left x-position (for columnBands)
 * @param {string} [signConvention='signed']
 * @param {{debit:{x0:number,x1:number}, credit:{x0:number,x1:number}}} [columnBands]
 * @returns {{sign:'+'|'-', unclear:boolean}}
 */
export function resolveGroupedSign(match, x, signConvention = 'signed', columnBands) {
  if (columnBands && x != null) {
    if (x >= columnBands.debit.x0 && x < columnBands.debit.x1) return { sign: '-', unclear: false };
    if (x >= columnBands.credit.x0 && x < columnBands.credit.x1) return { sign: '+', unclear: false };
  }
  if (match.markerType === 'CRDR' || match.markerType === 'PAREN') return { sign: match.markerSign, unclear: false };
  if (match.markerType === 'SIGN') {
    const sign = signConvention === 'positiveIsOut' ? (match.markerSign === '+' ? '-' : '+') : match.markerSign;
    return { sign, unclear: false };
  }
  // 'positiveIsOut'/'positiveIsIn' on a marker-less line is NOT a guess: this
  // convention only gets picked (detectGroupedSignConvention, the
  // crCount>=drCount branch) when the file's own marked lines establish that
  // an unmarked amount reliably means the OTHER direction - a card export
  // that marks every credit "CR" and leaves every debit bare. The absence of
  // a marker there is itself the signal, same confidence as a marker would
  // give; flagging it 'sign_unclear' just because a bare-amount debit is 90%+
  // of the file's rows is the false trigger behind item 5c's Summit Bank
  // regression (92.1% flagged, see dev/flag-rate-audit.mjs). Only 'signed'/
  // 'crdr' (where EVERY line is expected to carry its own marker) and no
  // convention at all fall through to a real guess below.
  if (signConvention === 'positiveIsOut') return { sign: '-', unclear: false };
  if (signConvention === 'positiveIsIn') return { sign: '+', unclear: false };
  return { sign: '+', unclear: true };
}

/**
 * Learn two right-hand amount x-bands (debit/credit columns) from a set of
 * amount matches' own x positions, when they form two clearly separated
 * clusters - the largest gap in sorted x splits them, rejected as "not
 * really two columns" if the split is too lopsided or the gap too small.
 * @param {{x:number|null}[]} matches
 */
export function learnAmountXBands(matches) {
  const xs = matches.map((m) => m.x).filter((x) => x != null).sort((a, b) => a - b);
  if (xs.length < 4) return null;
  let bestGap = -1;
  let splitAt = -1;
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    if (gap > bestGap) { bestGap = gap; splitAt = i; }
  }
  const left = xs.slice(0, splitAt);
  const right = xs.slice(splitAt);
  if (bestGap < 20) return null; // not clearly separated
  if (left.length < xs.length * 0.15 || right.length < xs.length * 0.15) return null; // too lopsided to be two real columns
  const mid = (left[left.length - 1] + right[0]) / 2;
  return { debit: { x0: -Infinity, x1: mid }, credit: { x0: mid, x1: Infinity } };
}

/**
 * Auto-detect a grouped PDF's sign convention from every amount-shaped line
 * in the document: an explicit +/- on most lines -> 'signed'; a CR/DR
 * marker on most lines -> 'crdr'; two distinct x-clusters of amounts with no
 * marker -> 'columnBands' (bands included, ready to save on the profile);
 * otherwise null (caller should default by statement type and ask, e.g. the
 * mapping wizard).
 * @param {{y:number, items:object[]}[]} lines
 * @param {RegExp} [customAmountRe]
 */
export function detectGroupedSignConvention(lines, customAmountRe) {
  const matches = [];
  for (const line of lines) {
    const text = lineText(line);
    const m = matchAmountLine(text, customAmountRe);
    if (!m) continue;
    const items = itemsForTextRange(line, m.index, m.length);
    const x = items.length ? Math.min(...items.map((it) => it.x)) : null;
    matches.push({ ...m, x });
  }
  const total = matches.length;
  if (!total) return { signConvention: null, confidence: 0 };
  const withSign = matches.filter((m) => m.markerType === 'SIGN').length;
  const withCrDr = matches.filter((m) => m.markerType === 'CRDR').length;
  if (withSign / total > 0.5) return { signConvention: 'signed', confidence: withSign / total };
  if (withCrDr / total > 0.5) return { signConvention: 'crdr', confidence: withCrDr / total };
  // Item 3 (UOB card statement, REPORT-OCR-GENERALISATION.md): a card
  // statement that marks credits with an explicit trailing "CR" but leaves
  // the (usually much more common) debits completely bare - no sign, no
  // "DR" - reads as "an unmarked amount means money out" once any real CR
  // marker exists at all and no line carries an explicit +/- sign anywhere;
  // resolveGroupedSign's positiveIsOut default (a marker-less line -> '-')
  // is exactly this rule, only never CHOSEN for a grouped PDF before now.
  if (withCrDr > 0 && withSign === 0) {
    const crCount = matches.filter((m) => m.markerSign === '+').length;
    const drCount = matches.filter((m) => m.markerSign === '-').length;
    if (crCount >= drCount) return { signConvention: 'positiveIsOut', confidence: withCrDr / total };
  }
  const columnBands = learnAmountXBands(matches);
  if (columnBands) return { signConvention: 'columnBands', columnBands, confidence: 1 };
  return { signConvention: null, confidence: 0 };
}

/**
 * Items 3/4 (2026-09-17): a "grouped" transaction is a BLOCK, not a fixed
 * two lines - it runs from wherever the previous block closed until the
 * next amount-ending (or date-group) line, which closes it; every
 * non-amount line seen since the last close is the description, joined,
 * plus whatever text (if any) sits before the amount on the amount line
 * itself (DBS's own layout: description and amount share one line, so
 * there's nothing accumulated ahead of it and the inline text alone IS the
 * description). This replaces the old fixed "two lines: description+amount,
 * then exactly one type line" assumption, which left every non-DBS layout's
 * multi-line-before-the-amount transactions (UOB's separate description
 * line, the "worst case" fixture's description+reference lines) either
 * empty or wrong (root cause 4, REPORT-OCR-GENERALISATION.md).
 * A line AFTER an amount line, before the next one, is ambiguous by shape
 * alone - it could be a type/category line for the transaction that just
 * closed (DBS's real layout: a "Point-of-Sale Transaction · POS" line right
 * after the amount) or the start of the NEXT block's description (UOB,
 * worst case). Guessing "it's a type line" by default overfit to DBS
 * specifically, so it's opt-in: `pdfConfig.grouped.trailingTypeLine: true`
 * (set on DBS's own builtin profile) claims exactly the first such line as
 * `type` and drops any further one as trailing boilerplate (unchanged from
 * the old behavior); without it, that same line instead becomes part of the
 * NEXT block's description, per the block rule above.
 * @param {{y:number, items:object[]}[]} lines
 * @param {{grouped?: {dateGroupPattern?:string, amountEndPattern?:string, trailingTypeLine?:boolean}, ignoreLinePatterns?:string[]}} pdfConfig
 * @returns {{date:string, description_raw:string, amount:string, currency:string, type:string}[]}
 */
export function extractGroupedRows(lines, pdfConfig = {}) {
  const cfg = pdfConfig.grouped || {};
  const dateRe = cfg.dateGroupPattern ? new RegExp(cfg.dateGroupPattern) : DEFAULT_DATE_GROUP_RE;
  const customAmountRe = cfg.amountEndPattern ? new RegExp(cfg.amountEndPattern) : null;
  const signConvention = cfg.signConvention || 'signed';
  const columnBands = cfg.columnBands || null;
  const trailingTypeLine = !!cfg.trailingTypeLine;
  // A page footer ("Page 2 of 3") or the "Transactions as of" balance summary
  // line doesn't match a date-group or an amount-ending line, so without
  // this it would silently get merged into a block's description - drop
  // these first (a profile's own list; item 5's general noise filter below
  // handles the common phrases every layout shares even with none set).
  const ignoreRes = (pdfConfig.ignoreLinePatterns || []).map((p) => new RegExp(p));

  let currentDate = null;
  let currentDateConfidence = null;
  const rows = [];
  let current = null; // the most recently closed row - only ever touched again to receive a trailingTypeLine's one claimed line
  let typeConsumed = true; // whether `current`'s trailingTypeLine slot has already been filled (or there is no `current` yet)
  let pendingLines = []; // Item 3/4: non-amount, non-date lines seen since the last block close - the next block's description
  let pendingLineRefs = []; // same lines, kept alongside for tagSource - a UOB-style block ("2line": description on its own line, amount on the NEXT line) has to anchor the outline box to the FIRST of these, not the amount line itself

  for (const line of lines) {
    const text = lineText(line);
    if (!text) continue;
    if (ignoreRes.some((re) => re.test(text))) continue;

    const dateMatch = text.match(dateRe);
    if (dateMatch) {
      currentDate = dateMatch[1] || dateMatch[2];
      currentDateConfidence = lineConfidence(line); // the date-group token itself, see pdf.js's PROFILE_SCHEMA note
      pendingLines = []; pendingLineRefs = []; // a stray leftover line right before a date group is preamble noise, not part of any block
      continue;
    }

    // Item 8: a "September 2026" month banner or bare "2026" year line is a
    // context marker, not a transaction and not a date group of its own -
    // skip it outright so it never falls into the amount check (a bare year
    // reads as a no-currency, no-marker amount) or the block-description
    // accumulation below.
    if (MONTH_YEAR_BANNER_RE.test(text.trim()) || BARE_YEAR_RE.test(text.trim())) continue;

    // Nothing is a transaction until the first date-group line has been
    // seen: a grouped statement's preamble (address, account/postal numbers,
    // the statement period, the balance summary) sits above the whole
    // transaction list, structurally, regardless of its exact wording - a
    // state check on "has a date group opened yet" is robust to preamble
    // phrasing an anchor/ignoreLinePatterns list can't fully enumerate
    // (though NON_TRANSACTION_PHRASES_RE and a profile's own
    // ignoreLinePatterns still help for a stray balance line printed WITHIN
    // the transaction list itself, e.g. a running total between rows).
    const amt = currentDate ? matchAmountLine(text, customAmountRe) : null;
    if (amt) {
      const amtItems = itemsForTextRange(line, amt.index, amt.length);
      const amtX = amtItems.length ? Math.min(...amtItems.map((it) => it.x)) : null;
      const { sign, unclear } = resolveGroupedSign(amt, amtX, signConvention, columnBands);
      const inline = text.slice(0, amt.index).trim();
      const descLines = inline ? [...pendingLines, inline] : pendingLines;
      current = {
        date: currentDate || '',
        description_raw: descLines.join(' ').trim(),
        amount: `${sign === '-' ? '-' : ''}${normalizeAmountDigits(amt.digits)}`,
        currency: amt.currency || '',
        type: '',
        // Only the amount token's own confidence, not the whole line (which
        // is mostly the merchant description) - a misread merchant name must
        // never flag the row as low-confidence when the amount read cleanly.
        _amountConfidence: minConfidenceOf(amtItems),
        _dateConfidence: currentDateConfidence,
        _signUnclear: unclear,
      };
      // The outline box anchors to the TOPMOST line of this block: the
      // amount line itself for a same-line description+amount ("DBS-style")
      // block, or the first accumulated pending line for a UOB-style block
      // where the description sits on its own line ABOVE the amount line -
      // extending down to the amount line as the block's bottom edge in
      // that case (extendSourceTo always means "further down the page").
      const topLine = pendingLineRefs.length ? pendingLineRefs[0] : line;
      tagSource(current, topLine);
      if (topLine !== line) extendSourceTo(current, line);
      rows.push(current);
      pendingLines = []; pendingLineRefs = [];
      typeConsumed = !trailingTypeLine;
      continue;
    }

    if (trailingTypeLine) {
      // The type line's own confidence never affects the row (per product
      // decision: a low-confidence type/category word is not worth a
      // warning); a second continuation line is trailing boilerplate (a
      // footer, "End of ..." notice) rather than more of this transaction,
      // so only the first one is ever claimed - matches the old behavior.
      if (current && !typeConsumed) { current.type = text; typeConsumed = true; extendSourceTo(current, line); }
      continue;
    }
    // Item 5: a page footer/header or an account-summary line is noise, not
    // part of any transaction's description, whichever block it would
    // otherwise fall into - drop it before it can pollute the next block.
    if (!looksLikeNonTransactionLine(text)) { pendingLines.push(text); pendingLineRefs.push(line); }
  }
  return rows;
}

/**
 * Extract rows across a whole multi-page PDF for one profile version:
 * concatenates every page's lines into one sequence before dispatching to
 * extractRows/extractGroupedRows, rather than calling either once per page.
 * A rowModel 'grouped' date-group header, or a rowModel 'columns'
 * tableStart/tableEnd anchor, does not repeat on every continuation page -
 * extracting page-by-page would lose the date for transactions carrying onto
 * the next page, or miss the table on every page after the first entirely.
 * @param {{y:number, items:object[]}[][]} pagesLines - one lines array per page (groupItemsIntoLines output)
 * @param {object} pdfConfig - profile.pdf per PROFILE_SCHEMA.md
 */
export function extractPdfPagesRows(pagesLines, pdfConfig = {}) {
  // Tag each line with its 1-indexed page number and its index within that
  // page (source_line) before flattening - extractRows/extractGroupedRows
  // read these off the line to stamp source_page/source_y/source_line onto
  // every row they produce (tagSource above). A direct extractRows/
  // extractGroupedRows call with an untagged lines array (single-page
  // callers, e.g. the wizard's per-page preview) just gets source_page: null,
  // same as today.
  pagesLines.forEach((pageLines, pageIdx) => {
    pageLines.forEach((line, lineIdx) => {
      line.page = pageIdx + 1;
      line.lineIndex = lineIdx;
    });
  });
  const lines = pagesLines.flat();
  return pdfConfig.rowModel === 'grouped' ? extractGroupedRows(lines, pdfConfig) : extractRows(lines, pdfConfig);
}

/**
 * Decide whether a page's lines fit rowModel 'columns' (date-led lines
 * aligned into a fixed-width table) or 'grouped' (date-group headers +
 * amount-ended transaction lines), so the wizard can pre-select one without
 * the user having to know the difference.
 * @returns {{rowModel:'columns'|'grouped', columnsScore:number, groupedScore:number}}
 */
export function detectPdfRowModel(lines) {
  const dateLedCount = lines.filter((l) => GENERIC_DATE_RE.test(lineText(l))).length;
  const dateGroupCount = lines.filter((l) => DEFAULT_DATE_GROUP_RE.test(lineText(l))).length;
  const amountEndCount = lines.filter((l) => matchAmountEnd(lineText(l))).length;
  const groupedScore = Math.min(dateGroupCount, amountEndCount) > 0 ? dateGroupCount + amountEndCount : 0;
  const columnsScore = dateLedCount;
  return { rowModel: groupedScore > columnsScore ? 'grouped' : 'columns', columnsScore, groupedScore };
}

/**
 * Generic "table by x-gaps" fallback for an unmapped PDF: no profile config
 * exists yet, so instead of failing, infer column boundaries from where item
 * x-starts cluster on date-led lines, and shape those lines into a raw grid
 * the mapping wizard can show (same idea as the CSV raw-grid step, just built
 * from geometry instead of a delimiter). Non-date-led lines (wrapped
 * continuations, headers, footers) are not part of this rough grid; a real
 * profile with joinWrappedLines/tableStart/tableEnd does better once mapped.
 * @param {{y:number, items:{str:string,x:number,y:number}[]}[]} lines
 * @param {RegExp} [dateRe] override for statements whose date format needs it
 * @returns {{grid:string[][], columns:{x0:number,x1:number}[], confidence:number}}
 */
export function inferGenericTable(lines, dateRe = GENERIC_DATE_RE) {
  const dateLines = lines.filter((l) => dateRe.test(lineText(l)));
  if (dateLines.length < 2) {
    log('pdf', 'generic table fallback found too few date-led lines', { dateLines: dateLines.length, confidence: 0 });
    return { grid: [], columns: [], confidence: 0 };
  }

  // Cluster item x-starts across date-led lines into candidate column boundaries.
  const starts = dateLines.flatMap((l) => l.items.map((i) => i.x)).sort((a, b) => a - b);
  const clusters = [];
  for (const x of starts) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.sum / last.count <= COLUMN_CLUSTER_TOLERANCE) { last.sum += x; last.count += 1; }
    else clusters.push({ sum: x, count: 1 });
  }
  // Keep only boundaries that recur in at least half the date-led lines (real
  // columns line up across rows; one-off mid-line word starts don't).
  const support = clusters.map((c) => c.count / dateLines.length);
  const boundaryXs = clusters.filter((_, i) => support[i] >= 0.5).map((c) => c.sum / c.count);

  // Column edges sit at the midpoint between adjacent column-center means, so
  // an item slightly left of "its" center (jitter) never spills into the
  // previous column's range.
  const columns = boundaryXs.map((x0, i) => ({
    x0: i === 0 ? -Infinity : (boundaryXs[i - 1] + x0) / 2,
    x1: i + 1 < boundaryXs.length ? (x0 + boundaryXs[i + 1]) / 2 : Infinity,
  }));
  const assignCols = columns.map((c, i) => ({ field: `col_${i}`, ...c }));
  const grid = dateLines.map((line) => {
    const assigned = assignColumns(line, assignCols);
    return assignCols.map((c) => assigned[c.field] || '');
  });

  const confidence = support.length ? support.reduce((a, b) => a + b, 0) / support.length : 0;
  log('pdf', 'generic table fallback inferred columns from x-gaps', {
    dateLines: dateLines.length, columnCount: columns.length, confidence,
  });
  return { grid, columns, confidence };
}

/** Extract a statement period {startISO, endISO} from page text via a regex with two capture groups (start, end), parsed by the caller's date parser. */
export function extractStatementPeriodText(fullText, statementPeriodPattern) {
  if (!statementPeriodPattern) return null;
  const m = fullText.match(new RegExp(statementPeriodPattern));
  if (!m) return null;
  return { startText: m[1], endText: m[2] };
}

/**
 * Load a PDF with pdf.js and extract per-page text items with positions.
 * Encrypted PDFs invoke `getPassword()` to obtain a password (never persisted);
 * a PDF with zero extractable text items reports "no readable text".
 * ponytail: real pdf.js wiring is thin and not covered by node tests (no headless PDF renderer here);
 * the row-extraction logic above is exercised directly with synthetic item arrays.
 * @param {ArrayBuffer} bytes
 * @param {{getPassword?: () => Promise<string>}} [opts]
 */
// Serves pdf.js's own standard-font substitutes (see vendor/standard-fonts-data.js)
// out of an in-memory Uint8Array instead of a real fetch: the manifest's
// connect-src 'none' blocks any actual network fetch, even to a same-origin
// extension resource, and pdf.js needs this data to read non-embedded
// Helvetica/Times/Courier text (common in bank statement PDFs) at all.
const STANDARD_FONT_PREFIX = 'https://sb-standard-font.invalid/';

function installStandardFontFetchShim(fontBytesByName) {
  const realFetch = globalThis.fetch?.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url.startsWith(STANDARD_FONT_PREFIX)) {
      const name = url.slice(STANDARD_FONT_PREFIX.length);
      const bytes = fontBytesByName[name];
      if (bytes) return new Response(bytes, { status: 200 });
      return new Response(null, { status: 404 });
    }
    if (!realFetch) throw new Error(`fetch is unavailable and no shim matched: ${url}`);
    return realFetch(input, init);
  };
  return () => { globalThis.fetch = realFetch; };
}

/**
 * Load pdf.js and run `fn(pdfjsLib, standardFontDataUrl)` with the standard-font
 * fetch shim installed for its duration. Shared by loadPdfPages (text
 * extraction) and the UI's pdf-render.js (canvas + anchor-picker items), so
 * both get real Helvetica/Times/Courier text without a real network fetch
 * (blocked by the manifest's connect-src 'none').
 */
export async function withPdfjs(fn) {
  const pdfjsLib = await import('../../vendor/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;

  const { STANDARD_FONTS_BASE64 } = await import('../../vendor/standard-fonts-data.js');
  const fontBytesByName = Object.fromEntries(
    Object.entries(STANDARD_FONTS_BASE64).map(([name, b64]) => [name, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]),
  );
  const restoreFetch = installStandardFontFetchShim(fontBytesByName);
  try {
    return await fn(pdfjsLib, STANDARD_FONT_PREFIX);
  } finally {
    restoreFetch();
  }
}

// A scanned/rasterized statement (all content baked into page images) can
// still carry a handful of real text items per page, e.g. a "Page N of M"
// footer stamped on top; a real text layer runs to hundreds of characters
// per page, so a near-empty average means there is nothing here to map, not
// a table that failed to be found.
export const MIN_CHARS_PER_PAGE = 40;

/**
 * Decide whether a set of loaded pages carries a real text layer or is
 * effectively image-only. Pure (works on plain {items} arrays, pdf.js
 * getTextContent() shape), so it is node-testable without a real PDF.
 * @param {{items:{str:string}[]}[]} pages
 */
export function isImageOnlyPdf(pages) {
  const totalItems = pages.reduce((n, p) => n + p.items.length, 0);
  const totalChars = pages.reduce((n, p) => n + p.items.reduce((s, it) => s + it.str.length, 0), 0);
  const imageOnly = totalItems === 0 || totalChars < MIN_CHARS_PER_PAGE * pages.length;
  return { imageOnly, totalItems, totalChars };
}

// pdf.js's own PasswordResponses.INCORRECT_PASSWORD value (the other one,
// NEED_PASSWORD, is 1) - exported so a caller's getPassword hook (home.js's
// password-prompt UI) can tell a fresh prompt from a wrong-password reprompt
// without importing the whole pdf.js lib just for this one constant.
export const INCORRECT_PASSWORD = 2;

export async function loadPdfPages(bytes, opts = {}) {
  return withPdfjs(async (pdfjsLib, standardFontDataUrl) => {
    // pdf.js transfers (detaches) the ArrayBuffer it's handed to its worker,
    // so a caller reusing `bytes` afterward (Home matches on page-1 text,
    // then parses the same entry.bytes again) would find it unusable; hand
    // pdf.js a copy instead (pdf-render.js does the same for this reason).
    const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(0), standardFontDataUrl });
    if (opts.getPassword) {
      // pdf.js calls onPassword again, on this SAME loadingTask, every time
      // the previous callback(password) turned out to be wrong (reason
      // flips to INCORRECT_PASSWORD) - so one getPassword hook transparently
      // covers the whole first-try/retry/retry cycle across however many
      // times a real person needs to re-type it, no re-entrant loadPdfPages
      // call needed. The password itself only ever flows: user input -> this
      // callback -> pdf.js's worker; it is never assigned to a variable that
      // outlives this closure and never passed to log()/debuglog.js.
      loadingTask.onPassword = async (callback, reason) => {
        try {
          const password = await opts.getPassword(reason);
          callback(password);
        } catch {
          // opts.getPassword's promise rejected - the person cancelled the
          // prompt. Tear the load down so `await loadingTask.promise` below
          // rejects too, instead of hanging forever waiting for a callback
          // that will never come.
          loadingTask.destroy();
        }
      };
    }
    const doc = await loadingTask.promise;

    const pages = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      // `height` (pdf.js's own em-height estimate for the run, already in
      // PDF-space points) lets tagSource below record a real per-line
      // height instead of review.js's old flat 10pt guess.
      const items = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], height: it.height }));
      pages.push({ pageNum, items });
    }
    const { imageOnly, totalItems, totalChars } = isImageOnlyPdf(pages);
    if (imageOnly) {
      log('pdf', 'no meaningful text layer found', { pages: pages.length, totalItems, totalChars });
      const err = new Error('no readable text');
      err.imageOnly = true;
      err.totalChars = totalChars;
      err.pageCount = pages.length;
      err.sampleText = pages.flatMap((p) => p.items.map((it) => it.str)).join(' ');
      throw err;
    }
    return pages;
  });
}
