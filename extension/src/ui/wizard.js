// 5-step mapping wizard: DOM wiring only. Field-override dropdowns, the
// transforms editor, and the PDF anchor/column-boundary picker all build a
// profile "version" object (src/core/profiles.js + normalize.js consume it);
// the wizard itself does no parsing beyond calling core/pipeline.js's
// buildFileRows (item 5: the one shared function every screen must use to
// turn a file + version into rows) for the live preview/Test/Save, and
// core/pdf.js's extractPdfPagesRows (all pages) for the Locate/Map steps'
// own on-screen previews.

import { formatMinor, formatMinorDisplay, parseAmount } from '../core/amount.js';
import { parseDate } from '../core/date.js';
import {
  suggestMapping, suggestHeaderRow, suggestHeaderRowConfidence, suggestDateFormat,
  suggestSignConvention, suggestNumberFormat, suggestFooterRows,
  detectBankName, detectStatementType, detectCurrency, detectCountry, detectCrDrInSamples,
  isForeignAmountHeader, detectPendingPrefix,
} from '../core/suggest.js';
import { createProfile, addVersion, pdfAnchorCandidates, filenameSignature } from '../core/profiles.js';
import { listXlsxSheets, parseXlsxGrid } from '../core/xlsx.js';
import {
  groupItemsIntoLines, lineText, extractGroupedRows, extractPdfPagesRows,
  detectPdfRowModel, loadPdfPages, detectGroupedSignConvention, matchAmountLine, inferPdfColumns,
} from '../core/pdf.js';
import { balanceCheck, countCheck, countCheckGrouped, groupedCountLabel, fileSummary, flagLabel, rowFlagLabel } from '../core/checks.js';
import { defaultAccountLabel } from '../core/home-state.js';
import { buildFileRows } from '../core/pipeline.js';
import { announce } from './nav.js';
import { renderPdfPage, pdfYToCanvasTop, pdfXToCanvasLeft, canvasLeftToPdfX } from './pdf-render.js';
import { confirmRow, confirmAllLowConfidence, editRow, excludeRow, applyAmountAlt } from './rowedit.js';
import { humanizeExtraField } from './preset-editor.js';
import { log, error as logError, asText as debugLogText } from '../core/debuglog.js';


const HUMAN_FIELD_OPTIONS = [
  ['', 'Ignore this column'],
  ['date', 'Date'],
  ['post_date', 'Posting date'],
  ['description_raw', 'Description'],
  ['amount', 'Amount (already has + and -)'],
  ['debit', 'Money out (debit)'],
  ['credit', 'Money in (credit)'],
  ['balance', 'Balance'],
  ['currency', 'Currency'],
  ['orig_amount', 'Original amount (foreign currency)'],
  ['reference', 'Reference'],
  ['__keep__', 'Keep as extra column'],
  ['__custom__', 'Custom field…'],
];
// PDF zone assignment reuses the same real field ids, minus the meta actions
// that only make sense for a whole CSV column.
const PDF_FIELD_OPTIONS = HUMAN_FIELD_OPTIONS.filter(([v]) => !['', '__keep__', '__custom__'].includes(v));

const SIGN_CONVENTION_OPTIONS = [
  ['signed', 'One amount column, sign already included'],
  ['debitCredit', 'Separate money-out and money-in columns'],
  ['crdr', 'One amount column with CR/DR markers'],
  ['positiveIsOut', 'One amount column, positive means money out (typical for credit cards)'],
  ['positiveIsIn', 'One amount column, positive means money in'],
];

// Module-level (not just createWizard-local): classifyGroupedPreviewLines and
// computedPdfAnchors' firstDataIdx detection both need this outside any one
// wizard instance's closure.
const GROUPED_DATE_GROUP_RE = /^(?:[A-Za-z]+day|Yesterday|Today),?\s*(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})$|^(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})$/;

const TRANSFORM_FIELDS = ['description_raw', 'date', 'amount', 'balance', 'reference'];
const TRANSFORM_OPS = ['trim', 'upper', 'lower', 'replace', 'flipSign', 'fixed'];

const STEP_META = [
  { id: 'basics', label: 'Basics' },
  { id: 'locate', label: 'Locate data' },
  { id: 'map', label: 'Map fields' },
  { id: 'test', label: 'Test' },
  { id: 'save', label: 'Save' },
];

const $ = (sel) => document.querySelector(sel);
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

/** header text -> extra_<slug>, so a hand-typed custom name is a safe column key. */
export function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}

/**
 * Seed a mapping array from an existing profile version's field list, only
 * falling back to fresh header/shape suggestion for source columns that
 * version's fields don't cover (a new column, or one whose old source header
 * no longer exists in this file). Used by "Update mapping" so a re-import of
 * an already-mapped bank format doesn't ask the user to redo every column.
 */
export function seedMappingFromVersion(version, header, sampleRows) {
  const bySource = {};
  const assign = (field, source) => { if (source) bySource[source] = field; };
  const f = (version && version.fields) || {};
  if (f.date?.source) assign('date', f.date.source);
  if (f.post_date?.source) assign('post_date', f.post_date.source);
  const descSources = Array.isArray(f.description_raw?.source) ? f.description_raw.source : [f.description_raw?.source].filter(Boolean);
  descSources.forEach((s) => assign('description_raw', s));
  if (f.amount?.source) assign('amount', f.amount.source);
  if (f.amount?.debit) assign('debit', f.amount.debit);
  if (f.amount?.credit) assign('credit', f.amount.credit);
  if (f.balance?.source) assign('balance', f.balance.source);
  const refSources = Array.isArray(f.reference?.source) ? f.reference.source : [f.reference?.source].filter(Boolean);
  refSources.forEach((s) => assign('reference', s));
  if (f.currency?.mode === 'column' && f.currency.source) assign('currency', f.currency.source);
  for (const e of f.extra || []) assign(`extra:${e.name}`, e.source);

  const suggested = suggestMapping(header, sampleRows);
  const bestBySource = {};
  for (const m of suggested) if (!(m.source in bestBySource)) bestBySource[m.source] = m.field;

  return header.map((h) => ({ source: h, field: h in bySource ? bySource[h] : (bestBySource[h] || '') }));
}

/**
 * Warnings a credit-card/CR-DR sign mistake would produce, computed the same
 * way Review will (kept in sync manually since review.js/checks.js are owned
 * by another agent this round): money-out stuck at zero, or every amount the
 * same sign while the source clearly has CR/DR text.
 */
/**
 * The grouped-rowModel PDF config extractGroupedRows/extractPdfPagesRows
 * expect, built from whatever sign convention/column bands the wizard has
 * detected or the user has since picked. Module-level and exported so the
 * wizard's own "grouped rowModel dropped from the config passed to
 * extractPdfPagesRows" class of bug (Fix 1: the Map-fields step's "Sample
 * values (whole file)" column read as empty for every OCR'd grouped PDF,
 * because extractPdfPagesRows falls back to the columns extractor - which
 * finds nothing without state.pdf.columns configured - whenever
 * pdfConfig.rowModel isn't literally the string 'grouped') has a direct test.
 * @param {string} signConvention
 * @param {object} [columnBands]
 */
export function buildGroupedPdfConfig(signConvention, columnBands) {
  return { rowModel: 'grouped', grouped: { signConvention, columnBands: columnBands || undefined } };
}

/**
 * Item 2: classify each of one page's lines as a date-group header, a
 * transaction line, or neither - for the Locate-data overlay highlight.
 * Uses the exact same matchAmountLine sign-independent test and
 * "nothing is a transaction until a date-group has opened" state machine
 * core/pdf.js's extractGroupedRows itself uses, so a highlighted line and an
 * extracted/counted row can never disagree (the regression this fixes: a
 * no-sign credit line was extracted and counted, but never highlighted,
 * because the overlay used to classify with its own stricter sign-requiring
 * regex).
 * @param {{y:number, items:object[]}[]} lines - one page's lines
 * @returns {{line:object, text:string, isDateGroup:boolean, isTxn:boolean}[]}
 */
export function classifyGroupedPreviewLines(lines) {
  let dateOpened = false;
  const out = [];
  for (const line of lines) {
    const text = lineText(line);
    if (!text) continue;
    const isDateGroup = GROUPED_DATE_GROUP_RE.test(text);
    if (isDateGroup) dateOpened = true;
    const isTxn = !isDateGroup && dateOpened && !!matchAmountLine(text);
    out.push({ line, text, isDateGroup, isTxn });
  }
  return out;
}

/**
 * Coordinator follow-up (2026-09-17): core/pdf.js's detectGroupedSignConvention
 * has no "a date group must already be open" gate the way extraction itself
 * does (extractGroupedRows never treats anything before the first date-
 * group line as a transaction) - so preamble text can read as a false-
 * positive amount line and dilute the sign-convention confidence score on
 * an otherwise completely clean file. Root-caused against the real 3-page
 * fixture: "123 Example Avenue, #01-01, Singapore 123456" (a postal code
 * with no currency/sign), "September 2026" (a bare statement-period year),
 * and "Account No: 123-4-567890" (a hyphenated reference number misread as
 * a negative sign) all matched, pulling a file where every real transaction
 * line carries an explicit sign down to 80% confidence instead of 100% -
 * never enough to trigger item 1's Locate-data skip. Fixed here (this call
 * site is wizard.js's; core/pdf.js's own matching is Section B's) by never
 * handing detection anything before the first date-group line in the first
 * place - extraction's own row/date counts are unaffected either way, since
 * extractGroupedRows already ignores that preamble on its own.
 * @param {{y:number, items:object[]}[]} lines
 */
export function linesAfterFirstDateGroup(lines) {
  const idx = lines.findIndex((l) => GROUPED_DATE_GROUP_RE.test(lineText(l)));
  return idx === -1 ? lines : lines.slice(idx);
}

/**
 * The Map-fields step's "Sample values (whole file)" column for a
 * grouped-layout PDF: first `limit` rows of the whole file, extracted the
 * same way parseForPreview/save() do. Exported so Fix 1 has a test that
 * exercises the exact call shape the wizard renders from, not just
 * core/pdf.js's own extractPdfPagesRows unit tests.
 * @param {{y:number, items:object[]}[][]} allLines - one lines array per page
 * @param {string} signConvention
 * @param {object} [columnBands]
 * @param {number} [limit]
 */
export function groupedWholeFileSampleRows(allLines, signConvention, columnBands, limit = 3) {
  return extractPdfPagesRows(allLines, buildGroupedPdfConfig(signConvention, columnBands)).slice(0, limit);
}

/**
 * Apply the wizard Test step's per-row resolutions (Fix 5: "Looks right" /
 * "Fix" / "Exclude") on top of a freshly-parsed rows array. Test step rows
 * are rebuilt from scratch on every render (parseForPreview reparses the
 * whole file), so resolutions live separately in wizard state keyed by
 * row_id and get reapplied here rather than mutating a row object that's
 * about to be thrown away - this is what makes them survive Back/Continue.
 * Pure: reuses rowedit.js's row-transform functions, never mutates `rows`.
 * @param {object[]} rows
 * @param {Map<string, {kind:'confirmed'|'excluded'|'edited', edits?:object}>} resolutions
 */
export function applyTestResolutions(rows, resolutions) {
  if (!resolutions || !resolutions.size) return rows;
  return rows.map((r) => {
    const res = resolutions.get(r.row_id);
    if (!res) return r;
    if (res.kind === 'excluded') return excludeRow(r);
    if (res.kind === 'confirmed') return confirmRow(r);
    if (res.kind === 'edited') return confirmRow(editRow(r, res.edits));
    if (res.kind === 'appliedAlt') return applyAmountAlt(r);
    return r;
  });
}

export function signConventionWarnings(rows, { statementType, sourceHasCrDr } = {}) {
  const warnings = [];
  const withAmount = rows.filter((r) => r.amount != null);
  const anyOut = withAmount.some((r) => r.amount < 0);
  const anyIn = withAmount.some((r) => r.amount > 0);
  if (statementType === 'credit_card' && withAmount.length && !anyOut) {
    warnings.push('Money out is zero for a credit card statement. Check the sign convention.');
  }
  if (sourceHasCrDr && withAmount.length && (!anyOut || !anyIn)) {
    warnings.push('The source has CR/DR markers but every parsed amount has the same sign. Check the sign convention.');
  }
  return warnings;
}

/**
 * Finding 2: pure per-step validity check, extracted from the wizard's own
 * stepValid() so it has a DOM-free test - no querySelector, no wizard state,
 * just the plain values that decide whether Continue is enabled. The wizard
 * instance's stepValid() is a thin wrapper that reads these values off the
 * DOM/state and calls this.
 * @param {number} step
 * @param {{isPdf:boolean, bank?:string, currency?:string, headerRowIdx?:number,
 *   pdfRowModel?:string, groupedRowCount?:number, tableStart?:object, tableEnd?:object,
 *   pdfColumnFields?:string[], mappingFields?:string[]}} ctx
 */
function joinEnglish(parts) {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * Finding B1: the inline reason shown above the wizard footer whenever
 * Continue is disabled, naming exactly what's still missing instead of
 * leaving a disabled button as the only clue (extracted alongside
 * computeStepValid, same DOM-free shape, so the two can never disagree about
 * what's required). Empty string when the step is already valid.
 * @param {number} step
 * @param {{isPdf:boolean, bank?:string, currency?:string, pdfRowModel?:string,
 *   pdfColumnFields?:string[], mappingFields?:string[]}} ctx
 */
export function computeStepReason(step, ctx) {
  if (computeStepValid(step, ctx)) return '';
  if (step === 0) {
    const missing = [];
    if (!ctx.bank?.trim()) missing.push('Bank name');
    if (!ctx.currency?.trim()) missing.push('a default currency');
    if (!missing.length) return '';
    return `${joinEnglish(missing)} ${missing.length > 1 ? 'are' : 'is'} required`;
  }
  if (step === 2) {
    if (ctx.isPdf && ctx.pdfRowModel === 'grouped') return '';
    const fs = ctx.isPdf ? (ctx.pdfColumnFields || []) : (ctx.mappingFields || []);
    const hasDate = fs.includes('date');
    const hasAmount = fs.includes('amount') || (fs.includes('debit') && fs.includes('credit'));
    const missing = [];
    if (!hasDate) missing.push('a Date column');
    if (!hasAmount) missing.push('an Amount column (or Money out and Money in columns)');
    if (!missing.length) return '';
    return `Map ${joinEnglish(missing)} to continue`;
  }
  if (step === 1) {
    return ctx.isPdf ? 'Click the first and last transaction rows on the page to continue' : 'Pick the row your columns are named on to continue';
  }
  return '';
}

export function computeStepValid(step, ctx) {
  if (step === 0) return !!(ctx.bank?.trim() && ctx.currency?.trim());
  if (step === 1) {
    if (!ctx.isPdf) return (ctx.headerRowIdx ?? -1) >= 0;
    return ctx.pdfRowModel === 'grouped' ? (ctx.groupedRowCount || 0) > 0 : !!(ctx.tableStart && ctx.tableEnd);
  }
  if (step === 2) {
    if (ctx.isPdf && ctx.pdfRowModel === 'grouped') return true; // fixed date/description/amount fields, always present
    const fs = ctx.isPdf ? (ctx.pdfColumnFields || []) : (ctx.mappingFields || []);
    return fs.includes('date') && (fs.includes('amount') || (fs.includes('debit') && fs.includes('credit')));
  }
  return true;
}

export function createWizard({ storage, onSaved, onOpenReport, onBack }) {
  const state = {
    entry: null,
    step: 0,
    mapping: [], // [{ source, field, customName? }] for csv, or [{ field, x0, x1 }] zones for pdf
    footerSkip: new Set(), // raw grid row indices (below the header) treated as skipped, not data
    dateFormat: 'DD/MM/YYYY',
    numberFormat: '1,234.56',
    signConvention: 'signed',
    transforms: [],
    pdf: null, // { tableStart, tableEnd, columns, rowStartPattern, joinWrappedLines, allLines, rawItemsByPage, numPages, currentPage, groupedMapping }
    basics: { bank: '', statementType: 'savings', currency: '', country: '', suggested: {} },
    testResolutions: new Map(), // row_id -> {kind, edits?} (Fix 5), survives Back/Continue within one wizard session
    signaturePhrases: null, // null = use freshly-computed pdfAnchors; array once the Save step's editable list has been seeded/edited (Fix 6b)
    // Item 4: what detection actually proposed for each of the three
    // format pickers, kept separately from the (possibly user-edited)
    // current state.dateFormat/numberFormat/signConvention values above.
    detected: { dateFormat: null, numberFormat: null, signConvention: null },
    pendingPrefix: null, // item e: "[UNPOSTED]"-style marker to flag as pending, null = not offered/set
    // Track 4 (manual range/sheet selection): initialised here (not just
    // reset in open()) so buildVersionFromWizard has real values even for a
    // unit test that drives it directly against a hand-built state, no open() call.
    rangeFirstDataRow: null,
    rangeLastDataRow: null,
    excludedColumns: new Set(),
    sheetNames: null,
    sheetName: null,
  };

  function isPdf() { return state.entry?.type === 'pdf'; }
  function headerRow() { return state.headerRowIdx ?? 0; }

  function detectionText(entry) {
    if (entry.text) return entry.text;
    if (entry.grid) return entry.grid.flat().join(' ');
    return '';
  }

  /** Every line of the whole PDF (all pages), one string per line - source text for the Test step's checks (Fix 1/3), not just page 1. Respects item 1's groupedBounds (a "Mark the first/last transaction" click), same as pdfPagesLinesForExtraction. */
  function pdfSourceLines() {
    return groupedPagesLinesForExtraction().flat().map(lineText);
  }

  /**
   * Item 1: what every actual extraction call (Map fields' preview, Test,
   * Save) reads pages from - the whole file, or (for a grouped/OCR PDF once
   * the user has marked a first/last transaction bound) just that slice, so
   * "Mark the first/last transaction" actually changes what gets extracted
   * and not just the Locate-data preview's own row count.
   */
  function groupedPagesLinesForExtraction() {
    if (state.pdf?.rowModel === 'grouped' && state.pdf.groupedBounds) return [groupedFlatLines()];
    return state.pdf?.allLines || [];
  }

  const STATEMENT_TYPE_LABELS = { savings: 'savings', current: 'current', credit_card: 'credit card', other: 'other' };
  /** Item 9: the file-format tag shown beside the name field, kept out of the name itself. */
  function fmtLabel() { return isPdf() ? 'PDF' : 'CSV'; }

  /**
   * Fix 6c / Item 9: a ready-to-confirm profile name from Basics, e.g.
   * "DBS savings" - the user only needs to type one when Basics itself
   * couldn't guess a bank. No file-format suffix ("PDF"/"CSV") in the name
   * itself - it reads as a category label, not a name a person would pick.
   * The format shows separately as a small tag next to the name field
   * instead (see #confirm-name-fmt / #w-name-fmt).
   */
  function suggestedProfileName() {
    const b = state.basics;
    const bank = b.bank || 'Statement';
    const typeLabel = STATEMENT_TYPE_LABELS[b.statementType] || b.statementType || '';
    return typeLabel ? `${bank} ${typeLabel}` : bank;
  }

  /**
   * (Re)compute Step 1 Basics from statement text and re-render it. Called
   * once at open() with whatever text is available up front (empty for a
   * fresh PDF, since it hasn't loaded yet), and again once a PDF's real page
   * text is in hand (see renderAnchorPicker), so the "Suggested from your
   * file" fields end up reflecting the file's actual content, not just its
   * name.
   */
  /** Title-cased first word of the file name (letters only), so the Bank field is never empty; "My bank" when the name has no letters. */
  function bankNameFromFilename(name) {
    const m = String(name || '').replace(/\.[^.]+$/, '').match(/[A-Za-z]+/);
    if (!m) return 'My bank';
    const w = m[0];
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }

  function refreshBasics(text) {
    state.basics = state.updateProfile
      ? { bank: state.updateProfile.bank || '', statementType: state.updateProfile.statementType || 'savings', currency: state.updateProfile.defaultCurrency || '', suggested: {} }
      : (() => {
          const detectedBank = detectBankName(text, state.entry.name);
          // Finding 3: a bank detection never found in text or filename must
          // still not leave the Basics field empty (an empty required field
          // is exactly what let "Next" silently no-op with no visible next
          // action) - fall back to the file's own first word, title-cased,
          // so there is always something to confirm or edit.
          const bank = detectedBank || bankNameFromFilename(state.entry.name);
          const detectedType = detectStatementType(text);
          const detectedCurrency = detectCurrency(text);
          const currency = detectedCurrency || 'SGD';
          // Finding B2: country from the SGD fallback (not a real currency
          // detection) would read as "Suggested from your file" for a
          // country that was never actually implied by anything in the
          // file - only ever derive it from a bank/currency the file itself
          // gave up.
          const country = detectCountry(bank, detectedCurrency);
          // 'savings' below is this wizard's own fallback, not something
          // read from the file - only cap it "Suggested from your file" when
          // detectStatementType actually found a signal.
          return {
            bank, statementType: detectedType || 'savings', currency, country,
            suggested: { bank: !!bank, statementType: !!detectedType, currency: !!detectedCurrency, country: !!country },
          };
        })();
    renderBasicsStep();
  }

  /** First 4-digit year found in statement text, for dateFormat variants that need one (DD MMM, DD/MM with no year column). */
  function yearHintFromText(text) {
    const m = String(text).match(/\b(20\d{2}|19\d{2})\b/);
    return m ? +m[1] : undefined;
  }

  async function open(entry, opts = {}) {
    state.entry = entry;
    state.transforms = [];
    state.footerSkip = new Set();
    state.testResolutions = new Map();
    state.signaturePhrases = null;
    state._testEditingRowId = null;
    state.pendingPrefix = null;
    // Track 4 (manual range/sheet selection): reset per-file, re-seeded by
    // recomputeCsvSuggestions/loadSheetNames below. excludedColumns/first-
    // /lastDataRow are null (auto) until the user actually clicks something
    // in the grid - buildVersionFromWizard only writes non-null picks into
    // rangeRules, so a file nobody touched keeps behaving exactly like the
    // old headerRow/skipRowsBefore-only path.
    state.rangeFirstDataRow = null;
    state.rangeLastDataRow = null;
    state.excludedColumns = new Set();
    state.sheetNames = null;
    state.sheetName = null;
    // "Update mapping" (layout changed, or a caller explicitly asking for it,
    // e.g. Review's sign-convention hint) reopens the wizard against the
    // file's already-matched profile: save() appends a new version instead
    // of creating a duplicate profile, and basics/mapping prefill from it.
    const match = entry.matches?.[0];
    state.updateProfile = (opts.forceUpdateMapping || match?.formatChanged) ? (match?.profile || null) : null;
    $('#screen-wizard').classList.add('active');
    document.querySelectorAll('.screen').forEach((s) => { if (s.id !== 'screen-wizard') s.classList.remove('active'); });

    // PDF entries have no entry.text/entry.grid at open() time (that only
    // exists once the PDF is actually loaded, in renderAnchorPicker below),
    // so basics start from the filename alone and get recomputed from the
    // page's real text once it's available.
    refreshBasics(detectionText(entry));
    log('wizard.open', 'opened mapping wizard', { file: entry.name, type: entry.type, updateProfile: !!state.updateProfile, basics: { bank: state.basics.bank, statementType: state.basics.statementType, currency: state.basics.currency, country: state.basics.country } });

    if (!isPdf()) {
      // Track 4: a multi-sheet xlsx workbook gets a sheet picker above the
      // grid - entry.bytes is the raw workbook (home.js keeps it around the
      // same way it does for PDFs), entry.grid stays whatever sheet Home
      // already parsed (sheet 1) until the user actually picks a different
      // one via setSheet below.
      if (entry.type === 'xlsx' && entry.bytes) {
        try {
          const sheets = await listXlsxSheets(entry.bytes);
          state.sheetNames = sheets.length > 1 ? sheets : null;
          state.sheetName = sheets[0];
        } catch (err) { logError('wizard.xlsxSheets', err, { file: entry.name }); }
      }
      const guess = entry.headerRowGuess ?? suggestHeaderRow(entry.grid);
      state.headerRowIdx = guess >= 0 ? guess : 0;
      recomputeCsvSuggestions();
      $('#pdf-anchor-picker').hidden = true;
      $('#csv-header-picker').hidden = false;
      renderRawGrid();
    } else {
      state.pdf = { tableStart: null, tableEnd: null, columns: [], rowStartPattern: '', joinWrappedLines: true, rowModel: 'columns', groupedRowCount: 0, groupedDateCount: 0 };
      $('#csv-header-picker').hidden = true;
      $('#pdf-anchor-picker').hidden = false;
      try {
        await renderAnchorPicker();
      } catch (err) {
        // A scanned/rasterized statement (all content baked into page
        // images, no text layer at all) can't be mapped as a table no
        // matter what the user clicks; say so plainly and point at the
        // export the bank almost always also offers.
        logError('wizard.pdf', err, { file: entry.name });
        $('#pdf-anchor-picker').innerHTML = `
          <p class="pdf-anchor-hint">This PDF has no readable text (it looks like a scanned
          image rather than a digital statement), so there is nothing here to map.
          Most banks also offer a CSV export for the same statement; try that instead.</p>`;
      }
    }

    renderBasicsStep();
    $('#w-dateformat').value = state.dateFormat;
    $('#w-numberformat').value = state.numberFormat;
    $('#w-signconvention').value = state.signConvention;
    // Fix 6c: prefill from Basics ("DBS savings") so the user just confirms
    // instead of typing a name from scratch for a brand-new profile.
    if (state.updateProfile) $('#w-name').value = state.updateProfile.name || '';
    else $('#w-name').value = suggestedProfileName();
    if ($('#w-name-fmt')) $('#w-name-fmt').textContent = fmtLabel();
    renderMappingTable();
    renderTransforms();
    renderLivePreview();
    enterConfirmOrWizard();
  }

  // --- Confirm-first setup: Screens A/B/focus/C, the default entry point ---
  // (SIMPLE-BUILD.md Section 2). Reuses every existing detection/render
  // function above (Basics/mapping/pdf state is already computed by the time
  // this runs) - these screens are just a different front door onto the same
  // state, never a second parsing path.

  /**
   * Screen A's rows: whatever the wizard's own auto-detection already
   * produces, non-skipped/non-excluded. Empty when detection actually found
   * nothing to show (a columns-rowModel PDF with no date-led line at all, or
   * a real parse error) - callers fall back to the full step-by-step wizard
   * in that case, per item 1 ("If detection cannot produce rows at all, skip
   * A and go to the existing detailed wizard with a plain intro").
   */
  function tryComputeConfirmRows() {
    if (isPdf() && state.pdf.rowModel === 'columns' && !(state.pdf.tableStart && state.pdf.tableEnd)) return [];
    try {
      const { rows } = parseForPreview();
      return rows.filter((r) => !r.skipped && !r.excluded);
    } catch (e) {
      logError('wizard.confirmDetect', e, { file: state.entry?.name });
      return [];
    }
  }

  /** Toggle between the confirm screens and the full guided stepper (they are siblings under #screen-wizard, never both visible). */
  function setConfirmMode(on) {
    for (const sel of ['#wizard-stepper', '#wizard-step-heading', '#wizard-step-intro', '#wizard-steps', '#wizard-footer-reason', '#wizard-footer']) {
      const el = $(sel);
      if (el) el.hidden = on;
    }
    const host = $('#wizard-confirm');
    if (host) host.hidden = !on;
  }

  function showConfirmScreen(name) {
    for (const id of ['confirm-a', 'confirm-b', 'confirm-focus', 'confirm-c']) {
      const el = document.getElementById(id);
      if (el) el.hidden = id !== `confirm-${name}`;
    }
    state.confirmScreen = name;
    const labels = { a: 'does this look right', b: "what's wrong", focus: 'fix it', c: 'name this statement' };
    announce(`Setup: ${labels[name] || name}`);
  }

  /**
   * Track 4: a CSV/xlsx whose header-row guess itself is shaky (below 0.7,
   * suggest.js's own suggestHeaderRowConfidence) skips the confirm-first
   * screens entirely and lands straight on the Locate-data grid with the
   * guess highlighted - confirming a wrong header row on Screen A ("Does
   * this look right?") is a worse first impression than just asking. A PDF's
   * own low-confidence gate (shouldSkipLocateStep) is unrelated and untouched.
   */
  function csvHeaderLowConfidence() {
    return !isPdf() && suggestHeaderRowConfidence(state.entry.grid, state.headerRowIdx) < 0.7;
  }

  /** Entry point called once at the end of open(): confirm-first when detection produced something to show, else the plain detailed wizard from Basics (item 1). */
  function enterConfirmOrWizard() {
    state.lowConfidenceLocate = csvHeaderLowConfidence();
    if (!state.lowConfidenceLocate && tryComputeConfirmRows().length) {
      setConfirmMode(true);
      renderConfirmA();
    } else if (state.lowConfidenceLocate) {
      setConfirmMode(false);
      setStep(1);
      renderRawGrid();
    } else {
      setConfirmMode(false);
      const intro = $('#wizard-step-intro');
      if (intro) {
        intro.hidden = false;
        intro.textContent = 'We could not read this file automatically. A few quick questions will get it set up.';
      }
      setStep(0);
    }
  }

  /**
   * Screen A: "We found N transactions from X to Y. Does this look right?"
   * (or, reopened against an already-matched profile whose layout changed,
   * "This looks different from last time...") plus money in/out totals and a
   * 5-row date/description/amount preview. Recomputed every time something
   * underneath it changes (a Locate/format fix via Screen B, coming back
   * from the focus screen) - never a snapshot taken once at open().
   */
  /** Share of rows with a usable value for a field; the confirm screen must never invite a Yes on a mostly-empty column. */
  function fieldFill(rows, pick) {
    if (!rows.length) return 0;
    return rows.filter((r) => pick(r) != null && String(pick(r)).trim() !== '').length / rows.length;
  }

  function renderConfirmA() {
    const rows = tryComputeConfirmRows();
    if (!rows.length) { enterConfirmOrWizard(); return; }
    const dateFill = fieldFill(rows, (r) => r.date);
    const amountFill = fieldFill(rows, (r) => (r.amount == null ? null : String(r.amount)));
    const descFill = fieldFill(rows, (r) => r.description_raw);
    if (dateFill < 0.5 || amountFill < 0.5) {
      // Detection could not fill a required column: go straight to the one step that fixes it, never a Yes on blank data.
      setConfirmMode(false);
      state.gateIntro = dateFill < 0.5
        ? 'We could not find the dates with this header row. Click the real header row below, then continue.'
        : 'We could not tell which column holds the amount. Match the Amount column on the next step.';
      const intro = $('#wizard-step-intro');
      if (intro) { intro.hidden = false; intro.textContent = state.gateIntro; }
      setStep(dateFill < 0.5 ? 1 : 2);
      return;
    }
    const summary = fileSummary(rows);
    const count = summary.rowCount;
    const range = summary.dateRange ? ` from ${summary.dateRange.start} to ${summary.dateRange.end}` : '';
    $('#confirm-a-heading').textContent = state.updateProfile
      ? 'This looks different from last time. Does this look right?'
      : `We found ${count} transaction${count === 1 ? '' : 's'}${range}. Does this look right?`;

    const cur = state.basics.currency || Object.keys(summary.byCurrency)[0] || '';
    const totals = summary.byCurrency[cur] || { in: 0, out: 0 };
    $('#confirm-a-totals').innerHTML = `
      <div class="confirm-total-item in"><span class="num">${escapeHtml(formatMinorDisplay(totals.in, cur))}</span><span class="lbl">Money in</span></div>
      <div class="confirm-total-item out"><span class="num">-${escapeHtml(formatMinorDisplay(totals.out, cur))}</span><span class="lbl">Money out</span></div>`;

    // Item 10: every row is in the DOM (not just the first 5) inside a
    // scroll box sized to show 5 at a time - same scroll pattern Home's own
    // result table uses (preset-editor.js's preset-preview-scroll-live) -
    // plus a caption so confirming "does this look right" is never silently
    // vouching for rows that were never shown at all.
    $('#confirm-a-preview').innerHTML = `
      <div class="preset-preview-scroll preset-preview-scroll-live" style="--preview-rows:5;" tabindex="0" role="region" aria-label="Transaction preview, scroll for more rows">
        <table class="txn-table map-table">
          <thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${escapeHtml(r.date ?? r.date_raw ?? '')}</td>
            <td>${escapeHtml(r.description_raw ?? '')}</td>
            <td class="num ${r.amount < 0 ? 'amount-out' : 'amount-in'}">${escapeHtml(formatMinorDisplay(r.amount, r.currency))}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      <p class="pdf-anchor-hint">${rows.length > 5 ? `Showing 5 of ${rows.length}. Scroll to see all.` : `All ${rows.length} row${rows.length === 1 ? '' : 's'}.`}</p>`;
    const yesBtn = $('#confirm-yes');
    const offBtn = $('#confirm-off');
    let notice = $('#confirm-a-notice');
    if (!notice) {
      notice = document.createElement('p');
      notice.id = 'confirm-a-notice';
      notice.className = 'confirm-notice';
      $('#confirm-a-preview').after(notice);
    }
    if (descFill < 0.5) {
      notice.hidden = false;
      notice.textContent = 'We could not find the description column, so the descriptions are blank. Fix that first.';
      if (yesBtn) yesBtn.disabled = true;
      if (offBtn) offBtn.textContent = 'Fix the description column';
    } else {
      notice.hidden = true;
      if (yesBtn) yesBtn.disabled = false;
      if (offBtn) offBtn.textContent = "Something's off";
    }
    setConfirmMode(true);
    showConfirmScreen('a');
  }

  /** Screen C: "Name this statement" - the same save() the full wizard's own Save step uses, seeded from this screen's own name input via #w-name (never a second save path). */
  function renderConfirmC() {
    const input = $('#confirm-name');
    if (input) input.value = state.updateProfile ? (state.updateProfile.name || '') : suggestedProfileName();
    if ($('#confirm-name-fmt')) $('#confirm-name-fmt').textContent = fmtLabel();
    showConfirmScreen('c');
  }

  /**
   * Screen B's "Dates are wrong" / "Amounts or +/- are wrong": moves the
   * real date-format / (sign-convention + number-format) picker group(s) -
   * with their own live examples and mismatch warnings, already computed by
   * renderMappingTable - out of the full wizard's Map-fields panel and into
   * the confirm screen, so fixing one thing never opens the whole step.
   * "Rows are missing or extra": the real Locate-data panel (the raw-grid
   * header/footer picker for a CSV, the anchor/column-boundary picker for a
   * PDF), already fully rendered at open() time.
   *
   * Nodes are MOVED (appendChild), never cloned, so every input/select
   * change listener wire()/renderMappingTable attached earlier stays live;
   * closeConfirmFocus() puts them back exactly where the full wizard expects
   * them to be.
   */
  function openConfirmFocus(kind) {
    renderMappingTable(); // fresh captions/samples/live-preview before pulling nodes out
    const host = $('#confirm-focus-host');
    host.innerHTML = '';
    state._confirmFocusKind = kind;
    if (kind === 'locate') {
      host.appendChild($('#csv-header-picker'));
      host.appendChild($('#pdf-anchor-picker'));
    } else {
      const selectors = kind === 'dates' ? ['#w-dateformat'] : ['#w-signconvention', '#w-numberformat'];
      for (const sel of selectors) {
        const group = $(sel)?.closest('.picker-group');
        if (group) host.appendChild(group);
      }
      // Scoped to #wizard-steps even though the shell's own Drop/Read/Copy
      // progress circles now use strip-1/strip-2/strip-3 (never step-N) -
      // kept explicit so a future id ever reused here still can't collide.
      const livePreview = document.querySelector('#wizard-steps #step-2 .live-preview');
      if (livePreview) host.appendChild(livePreview);
      renderLivePreview();
    }
    showConfirmScreen('focus');
  }

  /** Puts every node openConfirmFocus may have moved back into its home in the full wizard's step-1/step-2 panels, in their original fixed order, then re-renders Screen A against whatever the fix changed. */
  function closeConfirmFocus() {
    // Scoped to #wizard-steps (see openConfirmFocus's comment above).
    const step1 = $('#wizard-steps #step-1');
    if (step1) { step1.appendChild($('#csv-header-picker')); step1.appendChild($('#pdf-anchor-picker')); }
    const mapRow = document.querySelector('#wizard-steps #step-2 .picker-row');
    if (mapRow) {
      for (const sel of ['#w-dateformat', '#w-signconvention', '#w-numberformat']) {
        const group = $(sel)?.closest('.picker-group');
        if (group) mapRow.appendChild(group);
      }
    }
    const livePreview = $('#confirm-focus-host .live-preview');
    const transformsHost = document.querySelector('#wizard-steps #step-2 .transforms-editor');
    if (livePreview && transformsHost) transformsHost.after(livePreview);
    state._confirmFocusKind = null;
    renderConfirmA();
  }

  // --- Step 1: Basics ------------------------------------------------------

  function renderBasicsStep() {
    const b = state.basics;
    $('#w-bank').value = b.bank;
    $('#w-type').value = b.statementType;
    $('#w-currency').value = b.currency;
    $('#w-country').value = b.country || '';
    const cap = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
    cap('#w-bank-cap', !state.updateProfile && b.suggested.bank);
    cap('#w-type-cap', !state.updateProfile && b.suggested.statementType);
    cap('#w-currency-cap', !state.updateProfile && b.suggested.currency);
    cap('#w-country-cap', !state.updateProfile && b.suggested.country);
  }

  // --- Step 2 (CSV): raw grid header/footer picker -------------------------

  function recomputeCsvSuggestions() {
    const entry = state.entry;
    const hRow = headerRow();
    const sampleRows = entry.grid.slice(hRow + 1, hRow + 6);
    const header = entry.grid[hRow] || [];
    const rawMapping = state.updateProfile
      ? (() => {
          const lastVersion = state.updateProfile.versions[state.updateProfile.versions.length - 1];
          state.pendingPrefix = lastVersion.pendingPrefix ?? null;
          return seedMappingFromVersion(lastVersion, header, sampleRows);
        })()
      : (() => {
          const suggested = suggestMapping(header, sampleRows);
          const byHeader = {};
          for (const m of suggested) { if (!(m.source in byHeader)) byHeader[m.source] = m.field; }
          return header.map((h, colIdx) => {
            if (byHeader[h]) return { source: h, field: byHeader[h] };
            // A "Foreign Currency Amount" style column never competes for
            // the primary 'amount' field (suggestMapping already keeps it
            // out), but it shouldn't be silently ignored either - keep it
            // as a named extra column so its value survives to export.
            if (isForeignAmountHeader(h) && sampleRows.some((r) => String(r[colIdx] ?? '').trim() !== '')) {
              return { source: h, field: `extra:${slugify(h)}` };
            }
            return { source: h, field: '' };
          });
        })();
    // Track 4: a column the grid's own checkbox excluded never reaches the
    // Map-fields table at all - both mapping arrays above are built one
    // entry per header cell, in header order, so the array index IS the
    // column index to check against excludedColumns.
    state.mapping = rawMapping.filter((_, colIdx) => !state.excludedColumns.has(colIdx));
    state.dateFormat = suggestDateFormat(sampleRows.map((r) => r[0])) || state.dateFormat;
    state.numberFormat = suggestNumberFormat(sampleRows.flat());
    state.signConvention = pickSignConvention(state.mapping, sampleRows);
    // Item e: a source whose sample descriptions carry a leading
    // "[UNPOSTED]" marker (pending/not-yet-posted transactions) gets this
    // pre-ticked - saved as version.pendingPrefix, consumed by
    // normalize.js to set the informational 'pending' flag. Never
    // overrides an explicit choice already made this session.
    if (!state.updateProfile && state.pendingPrefix == null) {
      const descCol = state.mapping.findIndex((m) => m.field === 'description_raw');
      if (descCol >= 0 && detectPendingPrefix(sampleRows.map((r) => r[descCol]))) {
        state.pendingPrefix = '[UNPOSTED]';
      }
    }
    // Item 4: remember what was actually detected, separately from the
    // current (possibly user-edited) selection, so the picker caption can
    // read "Detected from your file" vs "Changed by you. Detected: X" and
    // a failing choice can offer "Use detected: X" as a one-click fix.
    state.detected.dateFormat = state.dateFormat;
    state.detected.numberFormat = state.numberFormat;
    state.detected.signConvention = state.signConvention;
    // Finding D1: pre-tick a trailing Total/Balance/... row's footer-skip
    // checkbox on a fresh mapping, so it ships as a footerRules entry on the
    // saved profile without the user having to notice and tick it by hand.
    // Never overrides an "Update mapping" reopen (seedMappingFromVersion's
    // profile already carries its own footerRules), and only adds to
    // footerSkip, never removes a row the user has since unticked.
    if (!state.updateProfile) {
      for (const idx of suggestFooterRows(entry.grid, hRow)) state.footerSkip.add(idx);
    }
  }

  function pickSignConvention(mapping, sampleRows) {
    const byField = suggestSignConvention(mapping);
    if (byField === 'debitCredit') return 'debitCredit';
    const amountCol = mapping.find((m) => m.field === 'amount');
    if (amountCol) {
      const colIdx = state.entry.grid[headerRow()].indexOf(amountCol.source);
      const samples = sampleRows.map((r) => r[colIdx]);
      if (detectCrDrInSamples(samples)) return 'crdr';
    }
    if (state.basics.statementType === 'credit_card') return 'positiveIsOut';
    return 'signed';
  }

  /** Spreadsheet-style column letters: A, B, ..., Z, AA, AB, ... */
  function columnLetter(idx) {
    let n = idx, s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }

  /** Track 4: bounds a data row is inside, given the current firstDataRow/lastDataRow picks (null = no explicit bound on that end). */
  function inDataRange(idx) {
    if (state.rangeFirstDataRow != null && idx < state.rangeFirstDataRow) return false;
    if (state.rangeLastDataRow != null && idx > state.rangeLastDataRow) return false;
    return true;
  }

  /** Track 4: switch which xlsx sheet the grid/mapping is built from - reparses via core/xlsx.js (never re-reads through home.js's own duplicate xlsx-to-grid path) and resets every row/column pick, since a different sheet is a different table entirely. */
  async function setSheet(sheetName) {
    if (sheetName === state.sheetName) return;
    try {
      state.entry.grid = await parseXlsxGrid(state.entry.bytes, { sheetName });
    } catch (err) { logError('wizard.xlsxSheets', err, { file: state.entry.name, sheetName }); return; }
    state.sheetName = sheetName;
    state.footerSkip = new Set();
    state.rangeFirstDataRow = null;
    state.rangeLastDataRow = null;
    state.excludedColumns = new Set();
    const guess = suggestHeaderRow(state.entry.grid);
    state.headerRowIdx = guess >= 0 ? guess : 0;
    log('wizard.xlsxSheet', 'sheet changed', { file: state.entry.name, sheetName });
    recomputeCsvSuggestions();
    renderRawGrid();
    renderMappingTable();
    refresh();
  }

  function renderSheetPicker() {
    const host = $('#w-sheet-picker');
    if (!host) return;
    if (!state.sheetNames) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = `<label>Sheet: <select id="w-sheet-select" class="map-select"></select></label>`;
    const select = $('#w-sheet-select');
    for (const name of state.sheetNames) {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      if (name === state.sheetName) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => setSheet(select.value));
  }

  function renderRawGrid() {
    const host = $('#w-rawgrid');
    if (!host) return;
    renderSheetPicker();
    const entry = state.entry;
    const rows = entry.grid.slice(0, 40);
    const hRow = headerRow();
    const confidence = suggestHeaderRowConfidence(entry.grid, hRow);
    $('#w-headerrow-suggestion').textContent = `row ${hRow + 1}${confidence > 0.9 && !state.gateIntro ? ' (high confidence)' : ''}`;
    const lowHint = $('#w-lowconfidence-hint');
    if (lowHint) lowHint.hidden = !state.lowConfidenceLocate;

    const width = Math.max(...rows.map((r) => r.length), 1);
    const table = document.createElement('table');
    table.className = 'raw-grid';

    // Frozen column-letter header row: a checkbox per column to exclude it
    // (Track 4's "excludedColumns") - the header row's own text is shown
    // above each letter once it's known, so the checkbox reads like a real
    // column header, not a bare "A"/"B".
    const thead = document.createElement('thead');
    const headTr = document.createElement('tr');
    headTr.appendChild(document.createElement('th')); // skip-cell column
    headTr.appendChild(document.createElement('th')); // row-number column
    const headerCells = entry.grid[hRow] || [];
    for (let c = 0; c < width; c++) {
      const th = document.createElement('th');
      th.className = 'raw-col-header';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !state.excludedColumns.has(c);
      const label = `Include column ${columnLetter(c)}${headerCells[c] ? ` (${headerCells[c]})` : ''}`;
      cb.title = label;
      cb.setAttribute('aria-label', label);
      cb.addEventListener('change', () => {
        if (cb.checked) state.excludedColumns.delete(c); else state.excludedColumns.add(c);
        log('wizard.excludeColumn', 'column excluded/included', { file: entry.name, col: c, excluded: !cb.checked });
        recomputeCsvSuggestions();
        renderRawGrid();
        renderMappingTable();
        refresh();
      });
      th.append(cb, document.createTextNode(columnLetter(c)));
      headTr.appendChild(th);
    }
    thead.appendChild(headTr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row, idx) => {
      const tr = document.createElement('tr');
      const excludedRange = idx > hRow && !inDataRange(idx);
      tr.className = idx < hRow ? 'raw-row-dim'
        : idx === hRow ? 'raw-row-header'
        : (state.footerSkip.has(idx) || excludedRange) ? 'raw-row-skip' : '';

      const skipTd = document.createElement('td');
      skipTd.className = 'raw-skip-cell';
      if (idx !== hRow) {
        // Accessibility (A2 minor): dedicated buttons, not a role="button"
        // <tr>, so the skip checkbox below is a sibling control rather than
        // an interactive element nested inside another one (nested-interactive
        // axe violation). Enter/Space on a button stop here so the wizard's
        // step-level Enter listener never also advances the step.
        const actionBtn = (text, title, onClick, cls = 'raw-use-header-btn') => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = cls;
          btn.textContent = text;
          btn.title = title;
          btn.setAttribute('aria-label', title);
          btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
          btn.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.stopPropagation();
            e.preventDefault();
            onClick();
          });
          return btn;
        };
        skipTd.appendChild(actionBtn('↑', `Use row ${idx + 1} as header row`, () => setHeaderRow(idx)));
        skipTd.appendChild(actionBtn('1st', `Row ${idx + 1} is the first data row`, () => setFirstDataRow(idx), 'raw-row-action-btn'));
        skipTd.appendChild(actionBtn('last', `Row ${idx + 1} is the last data row`, () => setLastDataRow(idx), 'raw-row-action-btn'));

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.footerSkip.has(idx);
        const label = `Skip row ${idx + 1} (footer/summary line, not a transaction)`;
        cb.title = label;
        cb.setAttribute('aria-label', label);
        cb.addEventListener('click', (e) => { e.stopPropagation(); toggleFooterSkip(idx, cb.checked); });
        skipTd.appendChild(cb);
      }
      tr.appendChild(skipTd);

      const numTd = document.createElement('td');
      numTd.className = 'raw-row-num';
      numTd.textContent = String(idx + 1);
      tr.appendChild(numTd);

      for (let c = 0; c < width; c++) {
        const td = document.createElement('td');
        td.textContent = row[c] ?? '';
        if (state.excludedColumns.has(c)) td.className = 'raw-col-excluded';
        // Track 4: "Data starts at a cell" - clicking a data cell sets the
        // header row to this row AND excludes every column to its left, the
        // same one click sets both the row and the first real column.
        if (idx !== hRow) {
          td.style.cursor = 'pointer';
          td.title = `Header row here, starting at column ${columnLetter(c)}`;
          td.addEventListener('click', (e) => { e.stopPropagation(); setHeaderCell(idx, c); });
        }
        tr.appendChild(td);
      }
      if (idx === hRow) {
        const capTd = tr.children[2];
        if (capTd) capTd.innerHTML = `<span class="brass-caption">Suggested header row</span> ${capTd.textContent}`;
      }
      // Accessibility (Finding 6 / A2 minor): keyboard access to "use this
      // row as header" is the dedicated button above, not the row itself -
      // avoids nesting the skip checkbox inside a role="button" ancestor.
      // The row keeps its click handler so the mouse shortcut still works.
      tr.addEventListener('click', () => setHeaderRow(idx));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.innerHTML = '';
    host.appendChild(table);
  }

  function setHeaderRow(idx) {
    if (idx === headerRow()) return;
    state.headerRowIdx = idx;
    state.footerSkip = new Set([...state.footerSkip].filter((i) => i > idx));
    if (state.rangeFirstDataRow != null && state.rangeFirstDataRow <= idx) state.rangeFirstDataRow = null;
    recomputeCsvSuggestions();
    state.lowConfidenceLocate = false; // a user pick is always trusted, whatever the guess's own confidence was
    log('wizard.headerRow', 'header row changed', { file: state.entry.name, headerRow: idx });
    renderRawGrid();
    renderMappingTable();
    refresh();
  }

  /** Track 4: "Data starts at a cell" - one click sets both the header row and the first real column (every column left of it excluded). */
  function setHeaderCell(idx, col) {
    state.excludedColumns = new Set(Array.from({ length: col }, (_, i) => i));
    setHeaderRow(idx);
  }

  function setFirstDataRow(idx) {
    state.rangeFirstDataRow = idx;
    log('wizard.rangeFirstDataRow', 'first data row set', { file: state.entry.name, row: idx });
    renderRawGrid();
    renderMappingTable();
    refresh();
  }

  function setLastDataRow(idx) {
    state.rangeLastDataRow = idx;
    log('wizard.rangeLastDataRow', 'last data row set', { file: state.entry.name, row: idx });
    renderRawGrid();
    refresh();
  }

  function toggleFooterSkip(idx, on) {
    if (on) state.footerSkip.add(idx); else state.footerSkip.delete(idx);
    log('wizard.footerSkip', 'row skip toggled', { file: state.entry.name, row: idx, skip: on });
    renderRawGrid();
    refresh();
  }

  // --- Step 2 (PDF): anchor + column-boundary picker ------------------------
  // Detection, anchor suggestion, and the grouped/columns row counts all run
  // over EVERY page's lines (state.pdf.allLines), not just the displayed
  // page - Locate-data itself still shows one rendered page at a time (Prev/
  // Next below), since that is all a screen can usefully show at once.

  const PDF_DATE_LINE_RE = /^\s*\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|^\s*\d{4}-\d{2}-\d{2}\b|^\s*\d{1,2}\s+[A-Za-z]{3,9}\b/;

  /** Load every page's positioned text items once: OCR's cached per-page items for an OCR'd file, or a real loadPdfPages() pass otherwise. */
  async function loadAllPdfPageItems(entry) {
    if (entry.ocr && entry.ocrPages) return entry.ocrPages.map((p) => p.items);
    const pages = await loadPdfPages(entry.bytes);
    return pages.map((p) => p.items);
  }

  /** Suggested tableStart/tableEnd anchors + dateFormat/signConvention, from the WHOLE document's date-led lines (Fix 1), not just whatever page happens to be on screen. */
  function computeWholeFileColumnAnchors(flatLines) {
    const dateLineIdxs = flatLines.map((l, i) => (PDF_DATE_LINE_RE.test(lineText(l)) ? i : -1)).filter((i) => i >= 0);
    if (!dateLineIdxs.length) return;
    const firstDateIdx = dateLineIdxs[0];
    const lastDateIdx = dateLineIdxs[dateLineIdxs.length - 1];
    // See the exclusive-boundary comments this replaces below for why start/end sit one line off the first/last transaction.
    const startIdx = firstDateIdx > 0 ? firstDateIdx - 1 : firstDateIdx;
    const endIdx = lastDateIdx + 1 < flatLines.length ? lastDateIdx + 1 : lastDateIdx;
    state.pdf.tableStart = { anchor: lineText(flatLines[startIdx]) };
    state.pdf.tableEnd = { anchor: lineText(flatLines[endIdx]) };
    state.pdf.rowStartPattern = PDF_DATE_LINE_RE.source;
    log('wizard.pdfSuggest', 'auto-suggested pdf table anchors (whole file)', { file: state.entry.name, tableStart: state.pdf.tableStart.anchor, tableEnd: state.pdf.tableEnd.anchor, confidence: dateLineIdxs.length / flatLines.length });

    const dateSamples = dateLineIdxs.map((i) => (lineText(flatLines[i]).match(PDF_DATE_LINE_RE) || [])[0]?.trim()).filter(Boolean);
    const suggested = suggestDateFormat(dateSamples);
    if (suggested) { state.dateFormat = suggested; $('#w-dateformat').value = suggested; }
    state.detected.dateFormat = state.dateFormat;
    state.detected.numberFormat = state.numberFormat;

    if (state.basics.statementType === 'credit_card') {
      state.signConvention = 'positiveIsOut';
      $('#w-signconvention').value = 'positiveIsOut';
    }
    state.detected.signConvention = state.signConvention;
  }

  /** Every line of the whole PDF, or the manually-marked first/last transaction slice of it when set (item 1's "Mark the first/last transaction" actions). */
  function groupedFlatLines() {
    const all = (state.pdf.allLines || []).flat();
    const b = state.pdf.groupedBounds;
    return b ? all.slice(b.startIdx, b.endIdx + 1) : all;
  }

  /**
   * Item 1: (re)run detection for a grouped-rowModel PDF, over the whole
   * file or the manually-marked slice of it - shared by the initial
   * Locate-data pass and every "Mark the first/last transaction"/"Switch to
   * column layout" action, so they all update state.pdf the same way.
   * `locateConfidence` (detectGroupedSignConvention's own confidence) is
   * what decides whether Locate-data can be skipped: below 0.9 the step
   * shows real actions instead of an inert "click Next if it looks right".
   */
  function recomputeGroupedDetection() {
    const scoped = groupedFlatLines();
    const signDetection = detectGroupedSignConvention(linesAfterFirstDateGroup(scoped));
    state.pdf.groupedSignDetection = signDetection;
    state.pdf.columnBands = signDetection.signConvention === 'columnBands' ? signDetection.columnBands : null;
    state.signConvention = signDetection.signConvention || 'signed';
    const wholeRows = extractGroupedRows(scoped, buildGroupedPdfConfig(state.signConvention, state.pdf.columnBands));
    state.pdf.groupedRowCount = wholeRows.length;
    state.pdf.groupedDateCount = new Set(wholeRows.map((r) => r.date).filter(Boolean)).size;
    state.pdf.locateConfidence = signDetection.confidence || 0;
    state.detected.signConvention = state.signConvention;
    if ($('#w-signconvention')) $('#w-signconvention').value = state.signConvention;
    log('wizard.pdfSignConvention', 'grouped sign convention (re)computed', {
      file: state.entry.name, ...signDetection, bounds: state.pdf.groupedBounds, rowCount: state.pdf.groupedRowCount,
    });
  }

  /** Item 1: a grouped/OCR PDF's Locate-data step is only skippable (nothing to confirm) once detection is confident enough to trust unattended. */
  function shouldSkipLocateStep() {
    return isPdf() && state.pdf?.rowModel === 'grouped' && (state.pdf.locateConfidence || 0) >= 0.9;
  }

  async function renderAnchorPicker() {
    const entry = state.entry;
    const pageItems = await loadAllPdfPageItems(entry);
    state.pdf.rawItemsByPage = pageItems;
    state.pdf.allLines = pageItems.map((items) => groupItemsIntoLines(items));
    state.pdf.numPages = pageItems.length;
    state.pdf.currentPage = 1;
    const flatLines = state.pdf.allLines.flat();

    const wholeText = flatLines.map(lineText).join(' ');
    refreshBasics(wholeText);
    state.pdf.yearHint = yearHintFromText(wholeText);

    // Auto-detect which layout this PDF fits: a fixed-width table (rowModel
    // 'columns', the anchor/column-boundary tool below) or an "app export"
    // style date-group + amount-ended-line layout (rowModel 'grouped', no
    // fixed columns to draw at all). See core/pdf.js's detectPdfRowModel.
    const detected = detectPdfRowModel(flatLines);
    state.pdf.rowModel = detected.rowModel;
    log('wizard.pdfRowModel', 'auto-detected pdf row model (whole file)', { file: entry.name, ...detected });

    if (state.pdf.rowModel === 'grouped') {
      state.pdf.groupedBounds = null;
      state.dateFormat = 'DD MMM YYYY'; // extractGroupedRows always emits "D MMM YYYY" text
      state.detected.dateFormat = state.dateFormat;
      $('#w-dateformat').value = state.dateFormat;
      recomputeGroupedDetection();
    } else {
      computeWholeFileColumnAnchors(flatLines);
    }

    await renderLocatePage(1);
  }

  /** Render one page of the Locate-data preview: canvas + line strips for that page, plus Prev/Next and the whole-file totals caption. Anchors/rowModel/counts are already fixed for the whole file (renderAnchorPicker above); navigating pages only changes what is shown. */
  async function renderLocatePage(pageNum) {
    state.pdf.currentPage = pageNum;
    const host = $('#pdf-anchor-picker');
    const numPages = state.pdf.numPages;
    const lines = state.pdf.allLines[pageNum - 1] || [];
    const items = state.pdf.rawItemsByPage[pageNum - 1];

    host.innerHTML = `
      <p class="pdf-anchor-hint">Showing page ${pageNum} of ${numPages} as a preview. The whole file is read at the Test step.</p>
      <p class="pdf-anchor-hint" id="pdf-suggest-caption"></p>
      <div id="pdf-locate-actions"></div>
      <p class="pdf-anchor-hint" id="pdf-wholefile-caption"></p>
      <div class="pdf-page-nav">
        <button type="button" class="btn btn-ghost btn-sm" id="pdf-page-prev" ${pageNum <= 1 ? 'disabled' : ''}>Prev</button>
        <span class="pdf-page-indicator">Page ${pageNum} of ${numPages}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="pdf-page-next" ${pageNum >= numPages ? 'disabled' : ''}>Next</button>
      </div>
      <div class="pdf-anchor-stage" id="anchor-stage"></div>`;
    $('#pdf-page-prev')?.addEventListener('click', () => renderLocatePage(pageNum - 1));
    $('#pdf-page-next')?.addEventListener('click', () => renderLocatePage(pageNum + 1));

    const stage = $('#anchor-stage');
    const { canvas, viewport } = await renderPdfPage(state.entry.bytes, pageNum, 1.3, { items });
    state.pdf.viewport = viewport; // current page's viewport, for "Add boundary" below
    stage.appendChild(canvas);

    if (state.pdf.rowModel === 'grouped') {
      renderGroupedAnchorPreview(stage, viewport, lines);
      return;
    }

    const strips = [];
    for (const line of lines) {
      const text = lineText(line);
      const top = pdfYToCanvasTop(line.y, viewport);
      const strip = document.createElement('div');
      strip.className = 'anchor-row-highlight';
      strip.style.top = `${top - 11}px`;
      strip.style.height = '15px';
      strip.style.pointerEvents = 'auto';
      strip.style.cursor = 'pointer';
      strip.title = text;
      if (text && (text === state.pdf.tableStart?.anchor || text === state.pdf.tableEnd?.anchor)) {
        strip.style.background = text === state.pdf.tableStart?.anchor ? 'rgba(63,120,86,.35)' : 'rgba(161,64,47,.30)';
      }
      strip.addEventListener('click', () => onAnchorLineClick(line, strip));
      stage.appendChild(strip);
      strips.push(strip);
    }

    $('#pdf-suggest-caption').textContent = state.pdf.tableStart && state.pdf.tableEnd
      ? 'We suggested this transaction table (from the whole file). Click Next if it looks right, or click other rows on any page to adjust.'
      : 'Click the first transaction row, then the last. Drag the brass lines to set column boundaries.';
    const wholeRowCount = extractPdfPagesRows(state.pdf.allLines, state.pdf).length;
    $('#pdf-wholefile-caption').textContent = `Whole file: ${wholeRowCount} row${wholeRowCount === 1 ? '' : 's'} across ${numPages} page${numPages === 1 ? '' : 's'}.`;

    if (!state.pdf.columns.length) {
      // Item 2: infer real column bands from the data (header words if the
      // file prints them, else clustered numeric x-positions) instead of
      // always guessing a fixed date/description/amount 3-way split, which
      // glued a second numeric column (a running balance, a separate
      // debit/credit pair) onto "amount" on any table that had one.
      const pageWidthPt = canvasLeftToPdfX(viewport.width, viewport);
      state.pdf.columns = inferPdfColumns((state.pdf.allLines || []).flat(), pageWidthPt);
    }
    renderBoundaries(stage, viewport);
    renderColumnAssignSelects();
  }

  /** The grouped-rowModel config (signConvention/columnBands) as extractGroupedRows/extractPdfPagesRows expect it, from the Locate-data detection or whatever the user has since picked. Module-level + exported: see groupedPdfConfig's own doc comment for the bug this shape fixes. */
  function groupedPdfConfig() { return buildGroupedPdfConfig(state.signConvention, state.pdf.columnBands); }

  // Grouped-mode "Locate data": no fixed columns to draw, just show the
  // detected structure over the CURRENT page (date-group lines vs.
  // transaction lines) so the user can confirm it before moving on, plus a
  // whole-file totals line (Fix 1) computed from every page so the per-page
  // caption below never reads as "the whole story".
  function renderGroupedAnchorPreview(stage, viewport, lines) {
    const pageRows = extractGroupedRows(lines, groupedPdfConfig());
    const pageDates = new Set(pageRows.map((r) => r.date).filter(Boolean));
    const confident = shouldSkipLocateStep();

    // Item 2: same classifier extraction itself uses (see
    // classifyGroupedPreviewLines's doc comment for the bug this replaced).
    for (const { line, text, isDateGroup, isTxn } of classifyGroupedPreviewLines(lines)) {
      if (!isDateGroup && !isTxn) continue;
      const top = pdfYToCanvasTop(line.y, viewport);
      const strip = document.createElement('div');
      strip.className = 'anchor-row-highlight';
      strip.style.top = `${top - 11}px`;
      strip.style.height = '15px';
      strip.style.background = isDateGroup ? 'rgba(63,120,86,.35)' : 'rgba(196,155,74,.35)';
      strip.title = text;
      // Item 1: while marking the first/last transaction, any highlighted
      // line on any page can be clicked to set that bound.
      if (state.pdf._markingBound) {
        strip.style.pointerEvents = 'auto';
        strip.style.cursor = 'pointer';
        strip.addEventListener('click', () => commitGroupedBoundClick(line));
      }
      stage.appendChild(strip);
    }

    const signCaption = groupedSignCaptionText();
    $('#pdf-suggest-caption').textContent = (pageRows.length
      ? `Found ${pageRows.length} transaction${pageRows.length === 1 ? '' : 's'} under ${pageDates.size} date${pageDates.size === 1 ? '' : 's'} on this page.` + (confident ? ' Click Next if that looks right.' : '')
      : 'No date groups or transaction lines found on this page yet.') + (signCaption ? ` ${signCaption}` : '');
    $('#pdf-wholefile-caption').textContent = `Whole file: ${state.pdf.groupedRowCount} transaction${state.pdf.groupedRowCount === 1 ? '' : 's'} under ${state.pdf.groupedDateCount} date${state.pdf.groupedDateCount === 1 ? '' : 's'}.`;

    // Item 1: never show a step with no action - below 0.9 detection
    // confidence, offer real actions instead of an inert "click Next if it
    // looks right" (there was, until now, nothing else to do here at all).
    const actionsHost = $('#pdf-locate-actions');
    if (actionsHost) renderGroupedLocateActions(actionsHost);

    if (state.signConvention === 'columnBands' && state.pdf.columnBands) renderColumnBandsOverlay(stage, viewport);
  }

  /** Item 1: the three real actions a low-confidence grouped/OCR Locate-data step offers, each re-running detection. */
  function renderGroupedLocateActions(host) {
    if (shouldSkipLocateStep() && !state.pdf._markingBound) { host.innerHTML = ''; return; }
    if (state.pdf._markingBound) {
      host.innerHTML = `<p class="pdf-anchor-hint">Click the ${state.pdf._markingBound} transaction line on any page.</p>
        <button type="button" class="btn btn-ghost btn-sm" id="pdf-mark-cancel">Cancel</button>`;
      $('#pdf-mark-cancel')?.addEventListener('click', () => { state.pdf._markingBound = null; renderLocatePage(state.pdf.currentPage); });
      return;
    }
    host.innerHTML = `
      <div class="picker-row" style="margin:8px 0;">
        <button type="button" class="btn btn-ghost btn-sm" id="pdf-mark-first">Mark the first transaction</button>
        <button type="button" class="btn btn-ghost btn-sm" id="pdf-mark-last">Mark the last transaction</button>
        <button type="button" class="btn btn-ghost btn-sm" id="pdf-switch-columns">Switch to column layout</button>
      </div>`;
    $('#pdf-mark-first')?.addEventListener('click', () => { state.pdf._markingBound = 'first'; renderLocatePage(state.pdf.currentPage); });
    $('#pdf-mark-last')?.addEventListener('click', () => { state.pdf._markingBound = 'last'; renderLocatePage(state.pdf.currentPage); });
    $('#pdf-switch-columns')?.addEventListener('click', () => {
      log('wizard.pdfRowModel', 'user switched grouped PDF to column layout', { file: state.entry.name });
      state.pdf.rowModel = 'columns';
      computeWholeFileColumnAnchors((state.pdf.allLines || []).flat());
      renderLocatePage(state.pdf.currentPage);
      renderFooter();
    });
  }

  /** Item 1: commit a "Mark the first/last transaction" click - narrows groupedBounds to the marked line, then re-runs detection over just that slice (trims preamble/footer false-positives out of both sign detection and the row count). */
  function commitGroupedBoundClick(line) {
    const all = (state.pdf.allLines || []).flat();
    const idx = all.indexOf(line);
    if (idx === -1) return;
    const prev = state.pdf.groupedBounds || { startIdx: 0, endIdx: all.length - 1 };
    const bounds = state.pdf._markingBound === 'first' ? { startIdx: idx, endIdx: prev.endIdx } : { startIdx: prev.startIdx, endIdx: idx };
    state.pdf.groupedBounds = bounds;
    state.pdf._markingBound = null;
    recomputeGroupedDetection();
    renderLocatePage(state.pdf.currentPage);
    renderFooter();
  }

  /** "Detected from your file (84% of amount lines carry a sign)" style caption, same detection score for both Locate data and the Map-fields picker. */
  function groupedSignCaptionText() {
    const d = state.pdf.groupedSignDetection;
    if (!d || !d.signConvention) return '';
    const pct = Math.round((d.confidence || 0) * 100);
    if (d.signConvention === 'signed') return `Detected from your file (${pct}% of amount lines carry a sign).`;
    if (d.signConvention === 'crdr') return `Detected from your file (${pct}% of amount lines carry a CR/DR marker).`;
    if (d.signConvention === 'columnBands') return 'Detected from your file (separate debit/credit columns by position, drag the line if it looks off).';
    return '';
  }

  /** Draw the two detected debit/credit column bands over the rendered page, with a draggable divider between them (columnBands' shared midpoint - the only real "edge" between two semi-infinite bands). */
  function renderColumnBandsOverlay(stage, viewport) {
    stage.querySelectorAll('.grouped-band, .col-boundary').forEach((el) => el.remove());
    const bands = state.pdf.columnBands;
    const mid = bands.debit.x1; // === bands.credit.x0
    const midLeft = pdfXToCanvasLeft(mid, viewport);
    const debit = document.createElement('div');
    debit.className = 'grouped-band debit';
    debit.style.left = '0'; debit.style.width = `${midLeft}px`;
    debit.title = 'Detected money-out (debit) column';
    const credit = document.createElement('div');
    credit.className = 'grouped-band credit';
    credit.style.left = `${midLeft}px`; credit.style.right = '0';
    credit.title = 'Detected money-in (credit) column';
    stage.append(debit, credit);

    const divider = document.createElement('div');
    divider.className = 'col-boundary';
    divider.style.left = `${midLeft}px`;
    divider.style.pointerEvents = 'auto';
    divider.title = 'Drag to adjust the debit/credit column split';
    divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => {
        const rect = stage.getBoundingClientRect();
        const left = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
        const pdfX = canvasLeftToPdfX(left, viewport);
        state.pdf.columnBands = { debit: { x0: -Infinity, x1: pdfX }, credit: { x0: pdfX, x1: Infinity } };
        renderColumnBandsOverlay(stage, viewport);
        refresh();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    stage.appendChild(divider);
  }

  function onAnchorLineClick(line, strip) {
    const text = lineText(line);
    if (!state.pdf.tableStart) {
      state.pdf.tableStart = { anchor: text };
      strip.style.background = 'rgba(63,120,86,.35)';
    } else if (!state.pdf.tableEnd) {
      state.pdf.tableEnd = { anchor: text };
      strip.style.background = 'rgba(161,64,47,.30)';
    } else {
      state.pdf.tableStart = { anchor: text };
      state.pdf.tableEnd = null;
      strip.style.background = 'rgba(63,120,86,.35)';
    }
    log('wizard.pdfAnchor', 'anchor picked manually', { file: state.entry.name, tableStart: state.pdf.tableStart?.anchor, tableEnd: state.pdf.tableEnd?.anchor });
  }

  function renderBoundaries(stage, viewport) {
    stage.querySelectorAll('.col-boundary').forEach((el) => el.remove());
    for (let i = 0; i < state.pdf.columns.length - 1; i++) {
      const col = state.pdf.columns[i];
      const left = pdfXToCanvasLeft(col.x1, viewport);
      const el = document.createElement('div');
      el.className = 'col-boundary';
      el.style.left = `${left}px`;
      el.dataset.index = String(i);
      el.addEventListener('pointerdown', (e) => startDragBoundary(e, i, stage, viewport));
      stage.appendChild(el);
    }
  }

  function startDragBoundary(e, index, stage, viewport) {
    e.preventDefault();
    const move = (ev) => {
      const rect = stage.getBoundingClientRect();
      const left = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
      const pdfX = canvasLeftToPdfX(left, viewport);
      state.pdf.columns[index].x1 = pdfX;
      state.pdf.columns[index + 1].x0 = pdfX;
      renderBoundaries(stage, viewport);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); refresh(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function renderColumnAssignSelects() {
    let host = $('#pdf-column-assign');
    if (!host) {
      host = document.createElement('div');
      host.id = 'pdf-column-assign';
      host.style.marginTop = '10px';
      $('#pdf-anchor-picker').appendChild(host);
    }
    host.innerHTML = '';
    state.pdf.columns.forEach((col, idx) => {
      const wrap = document.createElement('span');
      wrap.style.marginRight = '10px';
      const select = document.createElement('select');
      select.className = 'map-select';
      select.setAttribute('aria-label', `Zone ${idx + 1} maps to`);
      for (const [value, label] of PDF_FIELD_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = `Zone ${idx + 1}: ${label}`;
        if (value === col.field) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => { col.field = select.value; refresh(); });
      wrap.appendChild(select);
      host.appendChild(wrap);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-ghost btn-sm';
    addBtn.type = 'button';
    addBtn.textContent = 'Add boundary';
    addBtn.onclick = () => {
      const last = state.pdf.columns[state.pdf.columns.length - 1];
      const mid = (last.x0 + last.x1) / 2;
      state.pdf.columns.splice(state.pdf.columns.length - 1, 0, { field: 'reference', x0: last.x0, x1: mid });
      last.x0 = mid;
      renderBoundaries($('#anchor-stage'), state.pdf.viewport);
      renderColumnAssignSelects();
      refresh();
    };
    host.appendChild(addBtn);
  }

  // --- Step 3 (Map fields): field-override dropdowns + samples --------------

  // The derived source "columns" for a grouped-layout PDF (Fix 4): looks and
  // behaves exactly like a CSV column mapping row (label, 3 samples, target
  // dropdown the user can change), just fed from extractGroupedRows' fixed
  // record keys instead of a real header. Computed once per file; not reset
  // by page navigation.
  function ensureGroupedMapping() {
    if (!state.pdf.groupedMapping) {
      state.pdf.groupedMapping = [
        { label: 'Date (from the date line above each transaction)', source: 'date', field: 'date' },
        { label: 'Description (first line)', source: 'description_raw', field: 'description_raw' },
        { label: 'Type (second line)', source: 'type', field: 'extra:type' },
        { label: 'Amount (right side)', source: 'amount', field: 'amount' },
        { label: 'Currency (from the amount)', source: 'currency', field: 'currency' },
      ];
    }
    return state.pdf.groupedMapping;
  }

  /** One "source -> target field" row, shared by the CSV mapping table and the grouped-PDF derived-fields table (Fix 4 reuses the exact CSV row instead of a separate one-off). */
  function appendMapRow(tbody, label, m, sampleValues, onChanged, fieldOptions = HUMAN_FIELD_OPTIONS) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = label;

    const td2 = document.createElement('td');
    td2.className = 'map-samples';
    td2.textContent = sampleValues.filter((v) => v != null && v !== '').join(', ');

    const td3 = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'map-select';
    select.setAttribute('aria-label', `${label} maps to`);
    const selectedValue = m.field.startsWith('extra:') ? (m.field === `extra:${slugify(m.source)}` && !m.customName ? '__keep__' : '__custom__') : m.field;
    for (const [value, optLabel] of fieldOptions) {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = optLabel;
      if (value === selectedValue) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      if (select.value === '__keep__') {
        m.field = `extra:${slugify(m.source)}`;
        delete m.customName;
      } else if (select.value === '__custom__') {
        const name = window.prompt('Name this field (used as the export column header)', m.customName || slugify(m.source));
        if (name) { m.field = `extra:${slugify(name)}`; m.customName = name; }
        else { select.value = m.field.startsWith('extra:') ? selectedValue : (m.field || ''); return; }
      } else {
        m.field = select.value;
        delete m.customName;
      }
      onChanged?.();
    });
    td3.append(select);
    tr.append(td1, td2, td3);
    tbody.appendChild(tr);
  }

  /**
   * The raw source cell text for one amount sample, verbatim - never
   * reformatted (no currency prefix, no inserted space, no thousands
   * separator added or removed). parseAmount is only used as a gate: a
   * value that wouldn't actually parse under the current numberFormat is
   * dropped rather than shown, but a value that does parse is shown exactly
   * as it appears in the source, e.g. "3000.00" stays "3000.00", not
   * reformatted to "SGD + 3,000.00" - a sample's whole point is letting the
   * user compare it against their own statement's actual text.
   */
  function amountSampleTexts(rawAmount, currency) {
    if (rawAmount == null || rawAmount === '') return null;
    const { minor } = parseAmount(rawAmount, { numberFormat: state.numberFormat, currency });
    if (minor == null) return null;
    const raw = String(rawAmount).trim();
    return { signed: raw, magnitude: raw };
  }

  /**
   * Item 4: caption logic shared by every format picker - "Detected from
   * your file" only while the current value still equals what was
   * detected; once the user has changed it, "Changed by you. Detected: X".
   */
  function pickerDetectionCaption(current, detected, optionLabel) {
    if (!detected) return '';
    return current === detected ? 'Detected from your file' : `Changed by you. Detected: ${optionLabel(detected)}`;
  }

  /**
   * Item 4: a live "raw value → parsed result" example under a format
   * picker, from the first real sample that actually has a raw value, plus
   * a red mismatch warning (with a one-click "Use detected: X" fallback)
   * once more than 10% of the sampled values fail to parse under the
   * CURRENTLY selected format. Shared by the date and number pickers -
   * only the parse function and field names differ.
   * @param {string[]} rawSamples - real values from the file (wider pool than the 3 shown as "e.g. ...")
   * @param {(raw:string) => *} parseFn - returns null/undefined on failure
   * @param {(parsed:*) => string} formatResult
   * @param {{exampleEl:string, warnEl:string, capEl:string, selectEl:string, current:string, detected:string|null, optionLabel:(v:string)=>string, noun:string}} opts
   */
  function renderFormatDiagnostic(rawSamples, parseFn, formatResult, opts) {
    const capEl = $(opts.capEl);
    if (capEl) {
      const caption = pickerDetectionCaption(opts.current, opts.detected, opts.optionLabel);
      capEl.hidden = !caption;
      if (caption) capEl.textContent = caption;
    }
    const exampleEl = $(opts.exampleEl);
    const withRaw = (rawSamples || []).filter((v) => v != null && String(v).trim() !== '');
    if (exampleEl) {
      const sample = withRaw[0];
      if (sample == null) { exampleEl.hidden = true; }
      else {
        const parsed = parseFn(sample);
        exampleEl.hidden = false;
        exampleEl.textContent = `e.g. ${sample} → ${parsed == null ? 'not read' : formatResult(parsed)}`;
      }
    }
    const warnEl = $(opts.warnEl);
    if (warnEl) {
      const failed = withRaw.filter((v) => parseFn(v) == null).length;
      const showWarning = withRaw.length > 0 && failed / withRaw.length > 0.1;
      warnEl.hidden = !showWarning;
      if (showWarning) {
        const detectedLabel = opts.detected ? opts.optionLabel(opts.detected) : '';
        warnEl.innerHTML = `This format does not match your file: ${failed} of ${withRaw.length} ${opts.noun}${failed === 1 ? '' : 's'} could not be read.`
          + (opts.detected && opts.detected !== opts.current ? ` <a href="#" class="rs-link w-use-detected" data-select="${opts.selectEl}" data-value="${escapeHtml(opts.detected)}">Use detected: ${escapeHtml(detectedLabel)}</a>` : '');
        warnEl.querySelector('.w-use-detected')?.addEventListener('click', (e) => {
          e.preventDefault();
          const sel = $(opts.selectEl);
          if (sel) { sel.value = opts.detected; sel.dispatchEvent(new Event('change')); }
        });
      }
    }
  }

  /**
   * Item 4 (coordinator follow-up): the sign-convention picker's own live
   * example - up to 3 raw amounts paired with what the CURRENTLY selected
   * convention resolves them to ("SGD - 20.83 -> -20.83 (money out)"), plus
   * the same red mismatch warning as the other two pickers, here counting
   * `sign_unclear` rows instead of a parse failure. Reuses parseForPreview()
   * (the one shared pipeline, item 5) for the resolved side; `rawAmountTexts`
   * is a raw-record amount-text sample in the SAME order/config as that
   * call, so index i of one lines up with index i of the other's non-
   * skipped rows (both come from extracting the same source with the same
   * version).
   * ponytail: for a grouped-rowModel PDF the "raw" text is reconstructed
   * from the already-sign-resolved extracted record (currency + resolved
   * sign + digits), not the literal source glyph (a CR/DR marker prints as
   * a plain sign here) - upgrade to the literal source substring if that
   * distinction ever matters to a user.
   * @param {string[]} rawAmountTexts
   */
  function renderSignConventionExample(rawAmountTexts) {
    const exampleEl = $('#w-signconvention-example');
    const warnEl = $('#w-signconvention-warn');
    if (!exampleEl && !warnEl) return;
    let rows = [];
    try { ({ rows } = parseForPreview()); } catch (e) { logError('wizard.signExample', e, { file: state.entry?.name }); }
    const active = rows.filter((r) => !r.skipped && r.amount != null);
    if (exampleEl) {
      const parts = rawAmountTexts.slice(0, active.length).map((raw, i) => {
        const row = active[i];
        if (!row) return null;
        const dir = row.amount < 0 ? 'money out' : 'money in';
        return `${raw} → ${formatMinorDisplay(row.amount, row.currency)} (${dir})`;
      }).filter(Boolean).slice(0, 3);
      exampleEl.hidden = !parts.length;
      exampleEl.textContent = parts.length ? `e.g. ${parts.join(' · ')}` : '';
    }
    if (warnEl) {
      const unclear = active.filter((r) => r.flags.includes('sign_unclear')).length;
      const showWarning = active.length > 0 && unclear / active.length > 0.1;
      warnEl.hidden = !showWarning;
      if (showWarning) warnEl.textContent = `This convention leaves the direction unclear on ${unclear} of ${active.length} amounts - check them against the source.`;
    }
  }

  /** Fix 2: 3 real sample values next to each of the date format/sign convention/number format pickers, so the user can judge the detected choice instead of trusting it blind. Item 4: plus a live example and mismatch warning per format picker, from a wider sample pool (dateAllSamples/numberAllSamples) than the 3 shown here. */
  function renderPickerSamples(dateSamples, signSamples, numberSamples, dateAllSamples, numberAllSamples) {
    const setCap = (id, samples) => {
      const el = $(id);
      if (!el) return;
      el.hidden = !samples.length;
      el.textContent = samples.length ? `e.g. ${samples.join(', ')}` : '';
    };
    setCap('#w-dateformat-samples', dateSamples);
    setCap('#w-signconvention-samples', signSamples);
    setCap('#w-numberformat-samples', numberSamples);

    // Reads the <select>s' own live DOM value, not state.dateFormat/
    // numberFormat - those only sync from a buildVersionFromWizard() call
    // (parseForPreview/save), which may not have run yet for a selection
    // just made this tick, and must never show a stale example/warning for
    // a format the user just picked.
    const dateFormatLabels = { 'DD/MM/YYYY': 'DD/MM/YYYY', 'MM/DD/YYYY': 'MM/DD/YYYY', 'YYYY-MM-DD': 'YYYY-MM-DD', 'DD MMM YYYY': 'DD MMM YYYY', 'DD MMM': 'DD MMM' };
    const currentDateFormat = $('#w-dateformat')?.value || state.dateFormat;
    const currentNumberFormat = $('#w-numberformat')?.value || state.numberFormat;
    renderFormatDiagnostic(
      dateAllSamples || dateSamples, (raw) => parseDate(raw, currentDateFormat, { year: state.pdf?.yearHint }), (v) => v,
      { exampleEl: '#w-dateformat-example', warnEl: '#w-dateformat-warn', capEl: '#w-dateformat-cap', selectEl: '#w-dateformat',
        current: currentDateFormat, detected: state.detected.dateFormat, optionLabel: (v) => dateFormatLabels[v] || v, noun: 'date' },
    );
    renderFormatDiagnostic(
      numberAllSamples || numberSamples, (raw) => parseAmount(raw, { numberFormat: currentNumberFormat }).minor, (v) => formatMinorDisplay(v, $('#w-currency')?.value),
      { exampleEl: '#w-numberformat-example', warnEl: '#w-numberformat-warn', capEl: '#w-numberformat-cap', selectEl: '#w-numberformat',
        current: currentNumberFormat, detected: state.detected.numberFormat, optionLabel: (v) => v, noun: 'value' },
    );
  }

  function renderMappingTable() {
    const container = $('#w-mapping-table');
    container.innerHTML = '';
    const entry = state.entry;
    // Fix 4: date format and sign convention are fixed by extractGroupedRows'
    // own output shape for a grouped-layout PDF, not guessed from samples -
    // say so next to the pickers, same wording Basics uses for its own suggestions.
    const groupedDetected = isPdf() && state.pdf.rowModel === 'grouped';
    // Item 4: w-dateformat-cap/w-numberformat-cap are now set by
    // renderFormatDiagnostic (via renderPickerSamples below) for every
    // rowModel, not just grouped - "Detected from your file" while
    // unchanged, "Changed by you. Detected: X" once edited.
    if ($('#w-signconvention-cap')) {
      // Grouped PDFs get the richer "(84% of amount lines carry a sign)"
      // wording; everything else falls back to the same plain detected/
      // changed-by-you caption the other two pickers use.
      const caption = (groupedDetected && groupedSignCaptionText())
        || pickerDetectionCaption($('#w-signconvention')?.value || state.signConvention, state.detected.signConvention, (v) => SIGN_CONVENTION_OPTIONS.find(([id]) => id === v)?.[1] || v);
      $('#w-signconvention-cap').hidden = !caption;
      if (caption) $('#w-signconvention-cap').textContent = caption;
    }

    // Item e: only shown once a "[UNPOSTED]"-style prefix has actually been
    // seen in this file's sample descriptions (state.pendingPrefix set by
    // recomputeCsvSuggestions, or carried over from an "Update mapping"
    // reopen) - never shown for a file with no such marker.
    const pendingRow = $('#w-pending-prefix-row');
    if (pendingRow) {
      pendingRow.hidden = state.pendingPrefix == null && !state._pendingPrefixEverOffered;
      if (state.pendingPrefix != null) state._pendingPrefixEverOffered = true;
      const box = $('#w-pending-prefix');
      if (box) box.checked = !!state.pendingPrefix;
      const marker = $('#w-pending-prefix-marker');
      if (marker && state.pendingPrefix) marker.textContent = state.pendingPrefix;
    }

    // Item 1: when Locate data was confident enough to skip, Map fields
    // gets a compact summary line instead - "Change" jumps back to the
    // page preview on demand, it's just never shown as a required step.
    const summaryEl = $('#w-locate-summary');
    if (summaryEl) {
      if (groupedDetected && shouldSkipLocateStep()) {
        summaryEl.hidden = false;
        summaryEl.innerHTML = `Found ${state.pdf.groupedRowCount} transaction${state.pdf.groupedRowCount === 1 ? '' : 's'} under ${state.pdf.groupedDateCount} date${state.pdf.groupedDateCount === 1 ? '' : 's'} across ${state.pdf.numPages} page${state.pdf.numPages === 1 ? '' : 's'}. <a href="#" class="rs-link" id="w-locate-change">Change</a>`;
        $('#w-locate-change')?.addEventListener('click', (e) => { e.preventDefault(); setStep(1); });
      } else {
        summaryEl.hidden = true;
      }
    }

    if (isPdf() && state.pdf.rowModel === 'grouped') {
      const mapping = ensureGroupedMapping();
      const wholeRows = extractPdfPagesRows(groupedPagesLinesForExtraction(), groupedPdfConfig()).slice(0, 3);
      const table = document.createElement('table');
      table.className = 'map-table';
      table.innerHTML = '<thead><tr><th>Source field</th><th>Sample values (whole file)</th><th>Maps to</th></tr></thead>';
      const tbody = document.createElement('tbody');
      mapping.forEach((m) => {
        appendMapRow(tbody, m.label, m, wholeRows.map((r) => r[m.source]), () => {
          log('wizard.mapField', 'grouped-pdf field mapping changed', { file: entry.name, source: m.source, field: m.field });
          refresh();
        });
      });
      table.appendChild(tbody);
      container.appendChild(table);

      // A wider pool than the 3-row mapping table above: enough rows that 3
      // distinct dates/amounts are actually available to show, not just
      // whatever the first 3 transactions happen to repeat, and (item 4)
      // wide enough to give the format-mismatch check a real percentage.
      const captionPool = groupedWholeFileSampleRows(groupedPagesLinesForExtraction(), state.signConvention, state.pdf.columnBands, 30);
      const wideDates = [...new Set(captionPool.map((r) => r.date).filter(Boolean))];
      const wideAmounts = captionPool.map((r) => amountSampleTexts(r.amount, r.currency)).filter(Boolean).map((s) => s.magnitude);
      const amtSamples = wideAmounts.slice(0, 3).map((magnitude) => ({ signed: magnitude, magnitude }));
      renderPickerSamples(wideDates.slice(0, 3), amtSamples.map((s) => s.signed), amtSamples.map((s) => s.magnitude), wideDates, wideAmounts);
      renderSignConventionExample(captionPool.map((r) => `${r.currency || ''} ${r.amount}`.trim()));
      return;
    }
    if (isPdf()) {
      // Finding B5: the same Source/Sample values/Maps to table CSV gets,
      // fed from the column zones drawn on the previous step (Locate data)
      // instead of a header row - only the source names differ ("Zone 1"
      // instead of a real column header), so a user who just learned the CSV
      // table isn't handed a different interaction two minutes later.
      const wholeRows = extractPdfPagesRows(state.pdf.allLines, state.pdf).slice(0, 3);
      const table = document.createElement('table');
      table.className = 'map-table';
      table.innerHTML = '<thead><tr><th>Source column</th><th>Sample values</th><th>Maps to</th></tr></thead>';
      const tbody = document.createElement('tbody');
      state.pdf.columns.forEach((col, idx) => {
        appendMapRow(tbody, `Zone ${idx + 1}`, col, wholeRows.map((r) => r[col.field]), () => {
          log('wizard.mapField', 'pdf zone field mapping changed', { file: entry.name, zone: idx, field: col.field });
          renderColumnAssignSelects();
          refresh();
        }, PDF_FIELD_OPTIONS);
      });
      table.appendChild(tbody);
      container.appendChild(table);

      // Item 4: a wider pool (unsliced) than the 3-row mapping table above,
      // so the format-mismatch check has a real percentage to work with.
      const allRows = extractPdfPagesRows(state.pdf.allLines, state.pdf);
      const wideDates = allRows.map((r) => r.date).filter(Boolean);
      const wideAmounts = allRows.map((r) => amountSampleTexts(r.amount, r.currency)).filter(Boolean).map((s) => s.magnitude);
      renderPickerSamples(wideDates.slice(0, 3), wideAmounts.slice(0, 3), wideAmounts.slice(0, 3), wideDates, wideAmounts);
      renderSignConventionExample(wideAmounts);
      return;
    }

    const hRow = headerRow();
    const header = entry.grid[hRow] || [];
    const sampleRows = entry.grid.slice(hRow + 1, hRow + 4);
    // Item 4: a wider pool than the 3 shown in the table above, so the
    // format-mismatch check has a real percentage to work with.
    const wideSampleRows = entry.grid.slice(hRow + 1, hRow + 31);
    const table = document.createElement('table');
    table.className = 'map-table';
    table.innerHTML = '<thead><tr><th>Source column</th><th>Sample values</th><th>Maps to</th></tr></thead>';
    const tbody = document.createElement('tbody');
    state.mapping.forEach((m) => {
      const colIdx = header.indexOf(m.source);
      appendMapRow(tbody, m.source, m, sampleRows.map((r) => r[colIdx]), () => {
        log('wizard.mapField', 'field mapping changed', { file: entry.name, source: m.source, field: m.field });
        state.signConvention = $('#w-signconvention').value;
        refresh();
      });
    });
    table.appendChild(tbody);
    container.appendChild(table);

    // Fix 2: samples for the date/sign/number-format pickers, from whatever
    // column is currently mapped to each - a single amount column (sign
    // already included, CR/DR marker, positive-is-X) or separate debit/
    // credit columns (shown as -debit / +credit, matching how they'll parse).
    const dateCol = state.mapping.find((mp) => mp.field === 'date');
    const dateSamples = dateCol
      ? sampleRows.map((r) => r[header.indexOf(dateCol.source)]).filter(Boolean).slice(0, 3)
      : [];
    const amountCol = state.mapping.find((mp) => mp.field === 'amount');
    const debitCol = state.mapping.find((mp) => mp.field === 'debit');
    const creditCol = state.mapping.find((mp) => mp.field === 'credit');
    const rawAmounts = [];
    for (const row of sampleRows) {
      if (amountCol) {
        const v = row[header.indexOf(amountCol.source)];
        if (v) rawAmounts.push(v);
      } else if (debitCol || creditCol) {
        const d = debitCol && row[header.indexOf(debitCol.source)];
        const c = creditCol && row[header.indexOf(creditCol.source)];
        if (d) rawAmounts.push(`-${d}`); else if (c) rawAmounts.push(`+${c}`);
      }
    }
    const currency = $('#w-currency').value;
    const amtSamples = rawAmounts.map((raw) => amountSampleTexts(raw, currency)).filter(Boolean).slice(0, 3);
    const wideDates = dateCol ? wideSampleRows.map((r) => r[header.indexOf(dateCol.source)]).filter(Boolean) : [];
    const wideRawAmounts = [];
    for (const row of wideSampleRows) {
      if (amountCol) { const v = row[header.indexOf(amountCol.source)]; if (v) wideRawAmounts.push(v); }
      else if (debitCol || creditCol) {
        const d = debitCol && row[header.indexOf(debitCol.source)];
        const c = creditCol && row[header.indexOf(creditCol.source)];
        if (d) wideRawAmounts.push(`-${d}`); else if (c) wideRawAmounts.push(`+${c}`);
      }
    }
    renderPickerSamples(dateSamples, amtSamples.map((s) => s.signed), amtSamples.map((s) => s.magnitude), wideDates, wideRawAmounts);
    renderSignConventionExample(wideRawAmounts);
  }

  // --- Transforms editor ------------------------------------------------

  function renderTransforms() {
    const host = $('#transforms-list');
    host.innerHTML = '';
    state.transforms.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'transform-row';

      const fieldSel = document.createElement('select');
      fieldSel.className = 'transform-select';
      fieldSel.setAttribute('aria-label', `Transform ${idx + 1}: field`);
      for (const f of TRANSFORM_FIELDS) {
        const opt = document.createElement('option'); opt.value = f; opt.textContent = f;
        if (f === t.field) opt.selected = true;
        fieldSel.appendChild(opt);
      }
      fieldSel.onchange = () => { t.field = fieldSel.value; refresh(); };

      const opSel = document.createElement('select');
      opSel.className = 'transform-select';
      opSel.setAttribute('aria-label', `Transform ${idx + 1}: operation`);
      for (const op of TRANSFORM_OPS) {
        const opt = document.createElement('option'); opt.value = op; opt.textContent = op;
        if (op === t.op) opt.selected = true;
        opSel.appendChild(opt);
      }
      opSel.onchange = () => { t.op = opSel.value; renderTransforms(); refresh(); };

      row.append(fieldSel, opSel);

      if (t.op === 'replace') {
        const find = document.createElement('input'); find.placeholder = 'find'; find.value = t.find || ''; find.setAttribute('aria-label', `Transform ${idx + 1}: find`);
        find.oninput = () => { t.find = find.value; refresh(); };
        const replace = document.createElement('input'); replace.placeholder = 'replace with'; replace.value = t.replace || ''; replace.setAttribute('aria-label', `Transform ${idx + 1}: replace with`);
        replace.oninput = () => { t.replace = replace.value; refresh(); };
        row.append(find, replace);
      } else if (t.op === 'fixed') {
        const value = document.createElement('input'); value.placeholder = 'fixed value'; value.value = t.value || ''; value.setAttribute('aria-label', `Transform ${idx + 1}: fixed value`);
        value.oninput = () => { t.value = value.value; refresh(); };
        row.append(value);
      }

      const del = document.createElement('button');
      del.className = 'icon-btn danger'; del.type = 'button'; del.textContent = 'Remove';
      del.onclick = () => { state.transforms.splice(idx, 1); renderTransforms(); refresh(); };
      row.appendChild(del);

      host.appendChild(row);
    });
  }

  // --- Build version / preview / test / save --------------------------------------

  /** source-column-name -> target-field mapping array ({source, field, customName?}) into a profile version's `fields` object. Shared by CSV mapping and the grouped-PDF derived-fields mapping (Fix 4), so a changed target on either behaves identically. */
  function buildFieldsFromMapping(mapping) {
    const fields = {};
    const extra = [];
    const byField = {};
    for (const m of mapping) {
      if (!m.field) continue;
      if (m.field.startsWith('extra:')) { extra.push({ name: m.field.slice(6), source: m.source }); continue; }
      (byField[m.field] ??= []).push(m.source);
    }
    if (byField.date) fields.date = { source: byField.date[0] };
    if (byField.post_date) fields.post_date = { source: byField.post_date[0] };
    if (byField.description_raw) fields.description_raw = { source: byField.description_raw };
    if (byField.debit || byField.credit) fields.amount = { debit: byField.debit?.[0], credit: byField.credit?.[0] };
    else if (byField.amount) fields.amount = { source: byField.amount[0] };
    if (byField.balance) fields.balance = { source: byField.balance[0] };
    if (byField.orig_amount) fields.orig_amount = { source: byField.orig_amount[0] };
    if (byField.reference) fields.reference = { source: byField.reference };
    if (byField.currency) fields.currency = { mode: 'column', source: byField.currency[0] };
    if (extra.length) fields.extra = extra;
    return fields;
  }

  /** Fix 6a: the PDF signature phrases this file would actually match on next time - lines from page 1 above the first transaction/date-group, digit-heavy and personal-data-shaped lines already excluded by core/profiles.js's pdfAnchorCandidates. Empty for a CSV (headerText/its own overlap score is that signature instead). */
  function computedPdfAnchors() {
    if (!isPdf() || !state.pdf.allLines?.length) return [];
    const page1Lines = state.pdf.allLines[0].map(lineText);
    let firstDataIdx = -1;
    if (state.pdf.rowModel === 'grouped') {
      firstDataIdx = page1Lines.findIndex((t) => GROUPED_DATE_GROUP_RE.test(t));
    } else {
      firstDataIdx = state.pdf.tableStart ? page1Lines.indexOf(state.pdf.tableStart.anchor) : -1;
      if (firstDataIdx === -1) firstDataIdx = page1Lines.findIndex((t) => PDF_DATE_LINE_RE.test(t));
    }
    // Item 7: plausibility needs the whole file's text (a token that never
    // repeats on page 1 alone can still repeat elsewhere in a multi-page
    // statement), and at most 3 anchors, most distinctive first.
    return pdfAnchorCandidates(page1Lines, firstDataIdx, 3, pdfSourceLines().join('\n'));
  }

  /**
   * @param {{dateFormat?:string, numberFormat?:string, signConvention?:string, bank?:string}} [domOverride] -
   *   test-only escape hatch: buildVersionFromWizard otherwise reads these off
   *   the wizard's own <select>/<input> elements, which don't exist outside a
   *   real page. Passing them lets a node:test unit test drive this function
   *   directly against a csv/xlsx/pdf-shaped state without a DOM, which is
   *   exactly how it caught the state.pdf.rowModel-with-no-isPdf()-guard bug
   *   (item 1: crashed for every non-pdf file).
   */
  function buildVersionFromWizard(domOverride) {
    state.dateFormat = domOverride?.dateFormat ?? $('#w-dateformat').value;
    state.numberFormat = domOverride?.numberFormat ?? $('#w-numberformat').value;
    state.signConvention = domOverride?.signConvention ?? $('#w-signconvention').value;
    const fields = { currency: { mode: 'profileDefault' } };

    if (isPdf() && state.pdf.rowModel === 'grouped') {
      Object.assign(fields, buildFieldsFromMapping(ensureGroupedMapping()));
    } else if (isPdf()) {
      for (const col of state.pdf.columns) {
        if (col.field === 'date') fields.date = { source: col.field };
        else if (col.field === 'description_raw') fields.description_raw = { source: [col.field] };
        else if (col.field === 'amount') fields.amount = { source: col.field };
        else if (col.field === 'debit' || col.field === 'credit') {
          // Item 2: a debit/credit PAIR of zones (OCBC-style separate
          // Withdrawal/Deposit columns) - same {debit,credit} amount shape
          // buildFieldsFromMapping uses for a CSV mapping, keyed by the
          // zone's own field id since assignColumns keys a PDF row by it.
          fields.amount = { ...fields.amount, [col.field]: col.field };
        }
        else if (col.field === 'balance') fields.balance = { source: col.field };
        else if (col.field === 'reference') fields.reference = { source: col.field };
      }
    } else {
      Object.assign(fields, buildFieldsFromMapping(state.mapping));
    }

    const footerRules = !isPdf()
      ? [...state.footerSkip].map((idx) => ({ type: 'contains', value: (state.entry.grid[idx] || []).join(' ').trim() })).filter((r) => r.value)
      : [];

    // Fix 6a: pdfAnchors/preambleKeywords used to be [] for anything but a
    // columns-rowModel PDF with a tableStart anchor already picked (never
    // true for a grouped-layout OCR'd PDF), so a saved profile for one of
    // those could never match again. state.signaturePhrases is the Save
    // step's editable override once the user has seen/edited the list
    // (Fix 6b); until then this always reflects the freshly-detected anchors.
    const pdfAnchors = isPdf() ? (state.signaturePhrases ?? computedPdfAnchors()) : [];
    const version = {
      id: `manual-${Date.now()}`,
      createdAt: new Date().toISOString(),
      signatures: {
        headerText: isPdf() ? [] : (state.entry.grid[headerRow()] || []),
        preambleKeywords: pdfAnchors, pdfAnchors, filenamePattern: filenameSignature(state.entry.name, domOverride?.bank ?? $('#w-bank').value),
      },
      csv: isPdf() ? undefined : {
        encoding: 'auto', delimiter: 'auto',
        headerRow: headerRow(), skipRowsBefore: headerRow(),
        footerRules, ignoreRowRules: [],
        // Track 4: only written when the user actually touched the grid -
        // headerRow always mirrors the plain field above (rangeRules.headerRow
        // is what a saved version's own "next month" auto-match reads, see
        // csv.js's applyProfileVersion), so leaving it out for an untouched
        // file changes nothing about how it parses.
        rangeRules: (state.rangeFirstDataRow != null || state.rangeLastDataRow != null || state.excludedColumns.size || state.sheetName)
          ? {
              headerRow: headerRow(),
              firstDataRow: state.rangeFirstDataRow ?? undefined,
              lastDataRow: state.rangeLastDataRow ?? undefined,
              excludedColumns: state.excludedColumns.size ? [...state.excludedColumns].sort((a, b) => a - b) : undefined,
              sheetName: state.sheetName || undefined,
            }
          : undefined,
      },
      pdf: !isPdf() ? undefined : state.pdf.rowModel === 'grouped'
        ? { rowModel: 'grouped', grouped: { signConvention: state.signConvention, columnBands: state.pdf.columnBands || undefined } }
        : {
          rowModel: 'columns',
          tableStart: state.pdf.tableStart, tableEnd: state.pdf.tableEnd,
          columns: state.pdf.columns.map((c) => ({ field: c.field, x0: c.x0, x1: c.x1 })),
          rowStartPattern: state.pdf.rowStartPattern || undefined,
          joinWrappedLines: state.pdf.joinWrappedLines,
        },
      fields,
      transforms: state.transforms.filter((t) => t.field && t.op),
      dateFormat: state.dateFormat,
      numberFormat: state.numberFormat,
      // Item 3 (2026-09-17): a rowModel 'grouped' PDF's amount text ALREADY
      // has its final sign baked in by extractGroupedRows/resolveGroupedSign
      // (using pdf.grouped.signConvention, above) - passing the SAME
      // convention here too made normalize.js's resolveAmount apply
      // 'positiveIsOut'/'negativeIsOut' a second time and flip an
      // already-correct sign back to wrong (surfaced by UOB's own real
      // convention: unmarked = out, CR = in). The outer signConvention only
      // ever matters for CSV/columns rows, whose raw text isn't pre-signed.
      signConvention: isPdf() && state.pdf.rowModel === 'grouped' ? 'signed' : state.signConvention,
      pendingPrefix: state.pendingPrefix || undefined,
    };
    return version;
  }

  function parseForPreview(limit) {
    const entry = state.entry;
    const version = buildVersionFromWizard();
    // Item 5 root cause: this meta used to be hand-built here, separately
    // from save()'s own meta, and dropped `ocr` - an OCR'd file's Test step
    // never computed low_confidence_ocr/sign_unclear (normalize.js only
    // sets them when meta.ocr is set), so a file could look clean in Test
    // and then show "N rows need a look" on Home right after a clean Save,
    // once save()'s own (correct, separately-built) call finally set those
    // flags for the first time. Now both call buildFileRows (core/
    // pipeline.js), which reads entry.ocr itself - no meta to drift.
    const meta = { bank: $('#w-bank').value, statementType: $('#w-type').value, currency: $('#w-currency').value, year: isPdf() ? state.pdf.yearHint : undefined };
    if (isPdf()) {
      if (!state.pdf.allLines) return { version, rows: [] };
      // Whole file (Fix 1): every page's lines, not just whatever page
      // Locate-data has on screen - or the marked first/last-transaction
      // slice, once set (item 1).
      const rows = buildFileRows(entry, { pagesLines: groupedPagesLinesForExtraction() }, version, meta);
      return { version, rows: limit ? rows.slice(0, limit) : rows };
    }
    const rows = buildFileRows(entry, {}, version, meta);
    return { version, rows: limit ? rows.slice(0, limit) : rows };
  }

  /** Fix 3: the live preview's columns, in the fixed order date/description/extras/amount/currency/[balance]/[reference] - only the fields actually mapped right now, so a PDF without a balance column never shows an empty Balance column, and Type/Currency (the grouped-PDF derived fields) always show real values, not blanks. */
  function mappedPreviewColumns() {
    const cols = [{ key: 'date', label: 'Date' }, { key: 'description_raw', label: 'Description' }];
    let extraNames = [];
    let hasBalance = false;
    let hasReference = false;
    if (isPdf() && state.pdf.rowModel === 'grouped') {
      const mapping = ensureGroupedMapping();
      extraNames = mapping.filter((m) => m.field.startsWith('extra:')).map((m) => m.field.slice(6));
      hasBalance = mapping.some((m) => m.field === 'balance');
      hasReference = mapping.some((m) => m.field === 'reference');
    } else if (isPdf()) {
      const fields = state.pdf.columns.map((c) => c.field);
      hasBalance = fields.includes('balance');
      hasReference = fields.includes('reference');
    } else {
      extraNames = state.mapping.filter((m) => m.field.startsWith('extra:')).map((m) => m.field.slice(6));
      hasBalance = state.mapping.some((m) => m.field === 'balance');
      hasReference = state.mapping.some((m) => m.field === 'reference');
    }
    for (const name of extraNames) cols.push({ key: name, label: humanizeExtraField(`extra_${name}`) });
    cols.push({ key: 'amount', label: 'Amount' }, { key: 'currency', label: 'Currency' });
    if (hasBalance) cols.push({ key: 'balance', label: 'Balance' });
    if (hasReference) cols.push({ key: 'reference', label: 'Reference' });
    return cols;
  }

  /**
   * Item 2: no wizard error may be shown without its cause and a next
   * action. A known, expected cause (mapping still incomplete - same check
   * that disables Continue on Map fields, computeStepReason/step 2) gets
   * its plain-English reason; anything else is a real bug, not a mapping
   * problem, and gets a generic message plus a way to report it and a way
   * out, instead of a dead-end "unavailable" line.
   */
  function renderWizardStepError(host, e, stage) {
    logError(stage, e, { file: state.entry?.name });
    const reason = computeStepReason(2, stepValidCtx());
    if (reason) {
      host.innerHTML = `<p class="pdf-anchor-hint">${escapeHtml(reason)}</p>`;
      return;
    }
    host.innerHTML = `
      <p class="pdf-anchor-hint">Something went wrong building the preview. This is a bug, not your mapping.</p>
      <div class="wizard-error-actions">
        <button class="btn btn-ghost-dark btn-sm" type="button" id="w-error-copy-log">Copy debug log</button>
        <button class="btn btn-ghost-dark btn-sm" type="button" id="w-error-report">Report a problem</button>
        <button class="btn btn-ghost-dark btn-sm" type="button" id="w-error-back">Back to files</button>
      </div>`;
    $('#w-error-copy-log')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(debugLogText()); }
      catch { /* clipboard denied - the log stays visible via Download in Settings */ }
    });
    $('#w-error-report')?.addEventListener('click', () => onOpenReport?.(state.entry));
    $('#w-error-back')?.addEventListener('click', () => onBack?.());
  }

  function renderLivePreview() {
    const host = $('#w-live-preview');
    if (!host) return;
    let rows;
    try {
      ({ rows } = parseForPreview(8));
    } catch (e) {
      renderWizardStepError(host, e, 'wizard.preview');
      return;
    }
    if (!rows.length) { host.innerHTML = '<p class="pdf-anchor-hint">No rows parsed yet.</p>'; return; }
    const cols = mappedPreviewColumns();
    const table = document.createElement('table');
    table.className = 'map-table';
    table.innerHTML = `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = cols.map((c) => {
        if (c.key === 'amount' || c.key === 'balance') return `<td class="num">${formatMinor(r[c.key], r.currency)}</td>`;
        return `<td>${escapeHtml(r[c.key] ?? '')}</td>`;
      }).join('');
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.innerHTML = '';
    host.appendChild(table);
  }

  function renderTestStep() {
    const host = $('#w-test-results');
    let version, rows;
    try {
      ({ version, rows } = parseForPreview());
    } catch (e) {
      renderWizardStepError(host, e, 'wizard.test');
      return;
    }
    // Fix 5: rows are rebuilt from scratch on every render (parseForPreview
    // reparses the whole file), so a "Looks right"/"Fix"/"Exclude" resolution
    // from a previous render would vanish here unless reapplied - state.testResolutions
    // is what survives Back/Continue within this wizard session.
    rows = applyTestResolutions(rows, state.testResolutions);
    const summary = fileSummary(rows);
    const skippedRows = rows.filter((r) => r.skipped);
    const excludedRows = rows.filter((r) => !r.skipped && r.excluded);
    const flagCounts = {};
    for (const r of rows) { if (r.skipped || r.excluded) continue; for (const f of r.flags) flagCounts[f] = (flagCounts[f] || 0) + 1; }
    // Fix 1: the whole file's text (every page), not just page 1 - a PDF entry
    // never had entry.text/entry.grid at all, so detectionText(entry) always
    // read as empty for a PDF before this.
    const sourceText = isPdf() ? pdfSourceLines().join('\n') : detectionText(state.entry);
    const isGrouped = isPdf() && state.pdf.rowModel === 'grouped';
    // Fix 3: "date-led lines" is meaningless for a grouped layout (no
    // per-transaction date line); core/checks.js's countCheckGrouped compares
    // against amount-ended lines instead. Reshaped to the same {sourceLines,
    // extractedCount, matches, diff} shape countCheck returns, so the render
    // code below doesn't need two parallel branches.
    const cc = isGrouped
      ? (({ amountLines, extracted, matches, diff }) => ({ sourceLines: amountLines, extractedCount: extracted, matches, diff }))(countCheckGrouped(sourceText, rows.length))
      : countCheck(sourceText, rows.length);
    const bc = balanceCheck(rows);
    const sourceHasCrDr = /\bCR\b|\bDR\b/.test(sourceText);
    const warnings = signConventionWarnings(rows, { statementType: $('#w-type').value, sourceHasCrDr });

    log('wizard.test', 'test parse run', { file: state.entry.name, rowCount: rows.length, flagCounts, countCheck: cc, balanceCheck: { reconciles: bc.reconciles }, warnings });

    const currencyLines = Object.entries(summary.byCurrency)
      .map(([cur, v]) => `${cur}: in ${formatMinorDisplay(v.in, cur)}, out ${formatMinorDisplay(v.out, cur)}`)
      .join(' · ') || 'no amounts parsed';

    const flagChips = Object.entries(flagCounts)
      .map(([flag, n]) => `<button type="button" class="badge badge-warn flag-chip" data-flag="${flag}">${flagLabel(flag)} (${n})</button>`)
      .join(' ') || 'none';

    // Item 5: groupedCountLabel now returns {tone, text, showUpdateMappingLink}
    // (three severities - exact/small-gap/real-mismatch) instead of a plain
    // string; a non-grouped file's date-led-line check stays the old plain
    // pass/fail wording, reshaped the same way so the render code below has
    // one shape to work with either way.
    const countResult = isGrouped
      ? groupedCountLabel(cc.extractedCount, cc.sourceLines, cc.diff, cc.matches)
      : { tone: cc.matches ? 'ok' : 'fail', text: cc.matches ? `matches ${cc.sourceLines} date-led lines in source` : `vs ${cc.sourceLines} date-led lines in source (diff ${cc.diff})` };
    const countLabel = countResult.text;
    const countRowClass = countResult.tone === 'ok' ? 'pass' : countResult.tone === 'neutral' ? 'neutral' : 'fail';
    // Fix 3: no balance column is a neutral "not applicable", never a red fail.
    const balanceClass = bc.reconciles == null ? 'neutral' : bc.reconciles ? 'pass' : 'fail';
    const balanceLabel = bc.reconciles == null
      ? 'No balance column in this statement, balance check skipped'
      : bc.reconciles ? 'Balance reconciles' : `Balance does not reconcile${bc.firstFailingRow ? ` (first mismatch: ${bc.firstFailingRow.row_id})` : ''}`;

    const showAll = !!state._testShowAll;
    const flaggedOnly = !!state._testFlaggedOnly;
    const nonSkippedRows = rows.filter((r) => !r.skipped && !r.excluded);
    const flaggedRows = nonSkippedRows.filter((r) => r.flags.length);
    const filteredRows = flaggedOnly ? flaggedRows : nonSkippedRows;
    const visibleRows = showAll ? filteredRows : filteredRows.slice(0, 50);
    const lowConfidenceCount = nonSkippedRows.filter((r) => r.flags.includes('low_confidence_ocr')).length;
    const editingRowId = state._testEditingRowId;

    // Same collapsed-group presentation Review uses for skipped non-transaction
    // lines (see review.js's renderSkippedGroup), so the counts on this step
    // match what Home and Review both show later.
    const skippedGroupHtml = skippedRows.length ? `
      <div class="skipped-group">
        <details><summary>${skippedRows.length} line${skippedRows.length === 1 ? '' : 's'} skipped, not transactions</summary>
          <ul class="skipped-list">${skippedRows.map((r) => `<li><span>${escapeHtml(r.date_raw || r.description_raw || '(blank line)')}</span></li>`).join('')}</ul>
        </details>
      </div>` : '';
    // Fix 5: excluded rows dropped out of the counts above (fileSummary/
    // flagCounts/flaggedRows all skip them) but stay visible in their own
    // collapsed group, same shape as the skipped-lines one, so "Exclude"
    // never reads as the row silently vanishing.
    const excludedGroupHtml = excludedRows.length ? `
      <div class="skipped-group">
        <details><summary>${excludedRows.length} row${excludedRows.length === 1 ? '' : 's'} excluded, not transactions</summary>
          <ul class="skipped-list">${excludedRows.map((r) => `<li><span>${escapeHtml(r.date || r.description_raw || '(blank)')}</span></li>`).join('')}</ul>
        </details>
      </div>` : '';

    /**
     * Item 6: "Fix" edits the row's own Date/Description/Amount cells in
     * place (see the table body below) instead of a separate form - this
     * cell only ever holds the three resolve actions, or Save/Cancel while
     * editing.
     */
    function resolveCellHtml(r) {
      if (!r.flags.length) return '';
      if (editingRowId === r.row_id) {
        return `<div class="row-resolve-actions" data-row-id="${r.row_id}">
          <button type="button" class="rs-link row-fix-save">Save fix</button>
          <button type="button" class="rs-link row-fix-cancel">Cancel</button>
        </div>`;
      }
      // Item 1: a row with a suggested alt amount (normalize.js's OCR
      // no-decimal safety net) gets a one-click "Use $X" action right next
      // to Fix, so accepting the likely-correct value never requires typing
      // it in by hand.
      const useAltBtn = r.low_confidence_hint && r.amount_alt != null
        ? `<button type="button" class="rs-link row-use-alt-btn">Use ${escapeHtml(formatMinorDisplay(r.amount_alt, r.currency))}</button>`
        : '';
      return `<div class="row-resolve-actions" data-row-id="${r.row_id}">
        <button type="button" class="rs-link row-confirm-btn">Looks right</button>
        <button type="button" class="rs-link row-fix-btn">Fix</button>
        ${useAltBtn}
        <button type="button" class="rs-link row-exclude-btn">Exclude</button>
      </div>`;
    }

    // Fix (2026-09-16 follow-up): a clean file with no balance column and no
    // flagged rows was still showing an empty Balance column and an empty
    // Resolve column - both only earn a place in the table when there is
    // actually something to put in them.
    const hasBalance = nonSkippedRows.some((r) => r.balance != null);
    const hasFlagged = flaggedRows.length > 0;
    host.innerHTML = `
      <div class="review-summary">
        <div class="rs-item"><span class="num">${summary.rowCount}</span>rows parsed</div>
        <div class="rs-item ${countRowClass}">${isGrouped ? countLabel : `<span class="num">${cc.extractedCount}</span>${countLabel}`}</div>
        <div class="rs-item ${balanceClass}">${balanceLabel}</div>
      </div>
      ${warnings.length ? `<div class="confirm-note" style="color:var(--warn);">${warnings.join('<br>')}</div>` : ''}
      <p class="pdf-anchor-hint">${currencyLines}</p>
      <p class="pdf-anchor-hint">Flags: ${flagChips}</p>
      ${lowConfidenceCount ? `<p class="pdf-anchor-hint"><a href="#" id="w-test-confirm-all">Confirm all ${lowConfidenceCount} low-confidence row${lowConfidenceCount === 1 ? '' : 's'}</a></p>` : ''}
      ${flaggedRows.length ? `<label class="flagged-only-toggle"><input type="checkbox" id="w-test-flaggedonly" ${flaggedOnly ? 'checked' : ''}> Show only flagged rows (${flaggedRows.length})</label>` : ''}
      ${skippedGroupHtml}
      ${excludedGroupHtml}
      <div class="grid-scroll" style="max-height:420px;">
        <table class="txn-table" id="w-test-table">
          <thead><tr><th>Date</th><th>Description</th><th>Amount</th>${hasBalance ? '<th>Balance</th>' : ''}${hasFlagged ? '<th>Resolve</th>' : ''}</tr></thead>
          <tbody>${visibleRows.map((r) => {
            // Item 6: "Fix" edits the row's own cells in place - Date/
            // Description/Amount become inputs on the row being edited,
            // never a separate form. Enter saves, Escape cancels (wired
            // below); an edited row keeps the existing tr.edited marker
            // (rowedit.js's editRow sets r.edited/r.editedFields).
            const editing = editingRowId === r.row_id;
            const dateCell = editing
              ? `<input type="text" class="cell-edit-input row-fix-date" value="${escapeHtml(r.date ?? r.date_raw ?? '')}" aria-label="Edit date for this row">`
              : `${escapeHtml(r.date ?? r.date_raw ?? '')}`;
            const descCell = editing
              ? `<input type="text" class="cell-edit-input row-fix-desc" value="${escapeHtml(r.description_raw ?? '')}" aria-label="Edit description for this row">`
              : `${escapeHtml(r.description_raw ?? '')}${r.flags.length ? `<span class="row-tag">${r.flags.map((f) => rowFlagLabel(f, r)).join(', ')}</span>` : ''}`;
            // Item 2: Fix's inline amount input pre-fills with the suggested
            // amount_alt when present, not the flagged (likely wrong) amount
            // - the user is expected to confirm/adjust the likely value, not
            // retype the one the safety net already flagged as probably off.
            const prefillAmount = r.amount_alt != null ? r.amount_alt : r.amount;
            const amountCell = editing
              ? `<input type="text" class="cell-edit-input row-fix-amount" value="${prefillAmount != null ? escapeHtml(formatMinor(prefillAmount, r.currency)) : ''}" aria-label="Edit amount for this row">`
              : formatMinorDisplay(r.amount, r.currency);
            return `
            <tr class="${r.flags.length ? 'warn' : ''}${r.edited ? ' edited' : ''}${editing ? ' editing-row' : ''}" data-row-id="${r.row_id}" data-flags="${r.flags.join(',')}">
              <td>${dateCell}</td>
              <td>${descCell}</td>
              <td class="num ${r.amount < 0 ? 'amount-out' : 'amount-in'}">${amountCell}</td>
              ${hasBalance ? `<td class="num">${formatMinorDisplay(r.balance, r.currency)}</td>` : ''}
              ${hasFlagged ? `<td>${resolveCellHtml(r)}</td>` : ''}
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      ${filteredRows.length > 50 ? `<button type="button" class="btn btn-ghost btn-sm" id="w-test-showall" style="margin-top:10px;">${showAll ? 'Show first 50' : `Show all ${filteredRows.length}`}</button>` : ''}
    `;
    const showAllBtn = $('#w-test-showall');
    if (showAllBtn) showAllBtn.addEventListener('click', () => { state._testShowAll = !showAll; renderTestStep(); });
    const flaggedOnlyToggle = $('#w-test-flaggedonly');
    if (flaggedOnlyToggle) flaggedOnlyToggle.addEventListener('change', () => { state._testFlaggedOnly = flaggedOnlyToggle.checked; state._testShowAll = false; renderTestStep(); });
    host.querySelectorAll('.flag-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const flag = chip.dataset.flag;
        const target = host.querySelector(`tr[data-flags~="${flag}"]`) || [...host.querySelectorAll('tr[data-flags]')].find((tr) => tr.dataset.flags.split(',').includes(flag));
        target?.scrollIntoView({ block: 'center' });
        target?.classList.add('selected');
      });
    });
    $('#w-test-confirm-all')?.addEventListener('click', (e) => {
      e.preventDefault();
      for (const r of confirmAllLowConfidence(nonSkippedRows)) {
        if (r.confirmed) state.testResolutions.set(r.row_id, { kind: 'confirmed' });
      }
      log('wizard.test', 'confirmed all low-confidence rows', { file: state.entry.name, count: lowConfidenceCount });
      renderTestStep();
    });
    host.querySelectorAll('.row-resolve-actions').forEach((el) => {
      const rowId = el.dataset.rowId;
      el.querySelector('.row-confirm-btn')?.addEventListener('click', () => {
        state.testResolutions.set(rowId, { kind: 'confirmed' });
        log('wizard.test', 'row confirmed looks right', { file: state.entry.name, rowId });
        renderTestStep();
      });
      el.querySelector('.row-fix-btn')?.addEventListener('click', () => {
        state._testEditingRowId = rowId;
        renderTestStep();
      });
      el.querySelector('.row-use-alt-btn')?.addEventListener('click', () => {
        state.testResolutions.set(rowId, { kind: 'appliedAlt' });
        log('wizard.test', 'row applied suggested alt amount', { file: state.entry.name, rowId });
        renderTestStep();
      });
      el.querySelector('.row-exclude-btn')?.addEventListener('click', () => {
        state.testResolutions.set(rowId, { kind: 'excluded' });
        log('wizard.test', 'row excluded', { file: state.entry.name, rowId });
        renderTestStep();
      });
    });
    // Item 6: the row being edited lives entirely in tr.editing-row - Save
    // reads its own three inputs, Cancel/Escape drops them, Enter in any of
    // them saves the whole row (not just that one cell).
    host.querySelectorAll('tr.editing-row').forEach((tr) => {
      const rowId = tr.dataset.rowId;
      const saveEdit = () => {
        const dateEl = tr.querySelector('.row-fix-date');
        const descEl = tr.querySelector('.row-fix-desc');
        const amountEl = tr.querySelector('.row-fix-amount');
        const edits = {};
        const dateValue = dateEl?.value.trim();
        if (dateValue) edits.date = dateValue;
        if (descEl) edits.description_raw = descEl.value;
        const amountValue = amountEl?.value.trim();
        if (amountValue) { const { minor } = parseAmount(amountValue, { numberFormat: state.numberFormat }); if (minor != null) edits.amount = minor; }
        state.testResolutions.set(rowId, { kind: 'edited', edits });
        state._testEditingRowId = null;
        log('wizard.test', 'row fixed', { file: state.entry.name, rowId, edits });
        renderTestStep();
      };
      const cancelEdit = () => { state._testEditingRowId = null; renderTestStep(); };
      tr.querySelectorAll('input').forEach((input) => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        });
      });
      tr.querySelector('.row-fix-save')?.addEventListener('click', saveEdit);
      tr.querySelector('.row-fix-cancel')?.addEventListener('click', cancelEdit);
    });
    entryLastVersion = version;
    state.entry._testVersion = version;
  }
  let entryLastVersion = null;

  /** Turn a filenamePattern regex like "^.*dbs.*\.pdf$" back into the wildcard shorthand a non-technical user reads at a glance ("*dbs*.pdf"). Display only - the saved profile keeps the real regex. */
  function humanizeFilenamePattern(pattern) {
    return pattern.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\./g, '.').replace(/\.\*/g, '*');
  }

  /** Fix 6b: "This profile will be recognised by" as a plain list instead of raw JSON - each PDF anchor phrase removable, an "Add phrase" input to add one the auto-detection missed. Seeds state.signaturePhrases from the freshly-computed anchors the first time the Save step is seen this session. */
  function renderSignaturesHuman(version) {
    const host = $('#w-signatures-human');
    if (!host) return;
    const sig = version.signatures;
    const items = [];
    if (isPdf()) {
      state.signaturePhrases.forEach((phrase, idx) => items.push({ text: `page text "${phrase}"`, removable: true, idx }));
    } else if (sig.headerText?.length) {
      items.push({ text: `column headers ${sig.headerText.join(', ')}`, removable: false });
    }
    if (sig.filenamePattern) items.push({ text: `file names like ${humanizeFilenamePattern(sig.filenamePattern)}`, removable: false });
    host.innerHTML = items.length
      ? items.map((it) => `<li><span>${escapeHtml(it.text)}</span>${it.removable ? `<button type="button" class="icon-btn danger sig-remove" data-idx="${it.idx}">Remove</button>` : ''}</li>`).join('')
      : '<li class="pdf-anchor-hint">No distinctive phrase found yet - add one below, or this statement type may need to be picked by hand next time.</li>';
    host.querySelectorAll('.sig-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.signaturePhrases.splice(Number(btn.dataset.idx), 1);
        renderSaveStep();
      });
    });
  }

  function renderSaveStep() {
    // Seed the editable phrase list from freshly-detected anchors before
    // building the version, so the very first render shows the real
    // detection (not an empty override) and buildVersionFromWizard's own
    // signatures always match what's on screen from then on.
    if (isPdf() && !state.signaturePhrases) state.signaturePhrases = computedPdfAnchors();
    const version = buildVersionFromWizard();
    renderSignaturesHuman(version);
    const sigHost = $('#w-signatures-preview');
    if (sigHost) sigHost.textContent = JSON.stringify(version.signatures, null, 2);

    // Fix 5: whole-file totals here too, so it's visible at Save that every
    // page was read, not just whatever page Locate-data happened to show.
    const totalsHost = $('#w-save-totals');
    if (!totalsHost) return;
    let rows = [];
    try { ({ rows } = parseForPreview()); rows = applyTestResolutions(rows, state.testResolutions); } catch (e) { logError('wizard.saveTotals', e, { file: state.entry?.name }); }
    const summary = fileSummary(rows);
    const range = summary.dateRange ? `${summary.dateRange.start} to ${summary.dateRange.end}` : 'no dates parsed';
    // Fix 6d: thousands separators on this human summary line
    // (formatMinorDisplay) - never on a table cell or export value.
    const perCurrency = Object.entries(summary.byCurrency)
      .map(([cur, v]) => `${cur}: in ${formatMinorDisplay(v.in, cur)}, out ${formatMinorDisplay(v.out, cur)}`)
      .join(' · ') || 'no amounts parsed';
    const pageNote = isPdf() && state.pdf.numPages > 1 ? ` across all ${state.pdf.numPages} pages` : '';
    totalsHost.innerHTML = `
      <div class="review-summary"><div class="rs-item"><span class="num">${summary.rowCount}</span>rows${pageNote}</div></div>
      <p class="pdf-anchor-hint">${range} &middot; ${perCurrency}</p>`;
  }

  async function save() {
    const entry = state.entry;
    const version = entry._testVersion || buildVersionFromWizard();
    let profile;
    try {
      if (state.updateProfile) {
        await addVersion(storage, state.updateProfile.id, version);
        profile = { ...state.updateProfile, versions: [...state.updateProfile.versions, version] };
      } else {
        profile = await createProfile(storage, {
          name: $('#w-name').value || `${$('#w-bank').value} ${$('#w-type').value}`,
          bank: $('#w-bank').value,
          statementType: $('#w-type').value,
          fileType: isPdf() ? 'pdf' : 'csv',
          country: $('#w-country').value || undefined,
          defaultCurrency: $('#w-currency').value,
          versions: [version],
        });
      }
      // Item 5: buildFileRows (core/pipeline.js) - the same call parseForPreview
      // uses for Test, and the one Home must switch to - so Save can never
      // compute a different set of flags than what Test already showed.
      const rowsMeta = { bank: profile.bank, statementType: profile.statementType, currency: profile.defaultCurrency, year: isPdf() ? state.pdf.yearHint : undefined };
      const rows = isPdf()
        ? buildFileRows(entry, { pagesLines: groupedPagesLinesForExtraction() }, version, rowsMeta) // Fix 1/5: every page (or the marked bound slice, item 1)
        : buildFileRows(entry, {}, version, rowsMeta);
      // Fix 5: carry the Test step's row resolutions into the saved rows, so
      // a "Looks right"/"Fix"/"Exclude" a user already worked through isn't
      // silently redone by Home's own flag-based badge on the same file.
      entry.rows = applyTestResolutions(rows, state.testResolutions);
      entry.profile = profile;
      // Item 8: pre-save, entry.accountLabel (when set at all) is just a bare
      // masked account number with no bank name - fine as a rough preview,
      // but a first-timer coming off Save must see "<Bank> <type> ****1234",
      // not the number alone with the filename simply gone. Re-derive it now
      // that the profile (and its bank/statement type) actually exists;
      // home.js's file-row render fades old -> new text over 300ms whenever
      // this value visibly changes, so it reads as a rename, not a swap.
      const maskedOnly = entry.accountLabel && /^\*{4}\d{4}$/.test(entry.accountLabel) ? entry.accountLabel : null;
      entry.accountLabel = defaultAccountLabel(profile, maskedOnly);
      // A saved mapping always supersedes an earlier "no candidate profile
      // could read this" outcome (item A) or a failed "Use an existing
      // profile" pick (item 13) - this file just got its own real mapping.
      entry.matchFailed = null;
      entry.pickedProfileFailed = false;
      entry._triedMatches = null;
      // Item 5: recompute the same groupedCheckLabel Home's own healthBadge
      // reads (core/checks.js's countCheckGrouped/groupedCountLabel, the one
      // function both screens share) against the just-saved rows - a stale
      // label from before this fix (e.g. "Update mapping" reopened because
      // of a count mismatch) must never survive a Save that resolved it.
      entry.matchedVersion = version;
      if (isPdf() && version.pdf?.rowModel === 'grouped') {
        entry.pdfSourceText = pdfSourceLines().join('\n');
        const cc = countCheckGrouped(entry.pdfSourceText, entry.rows.length);
        entry.groupedCheckLabel = cc.matches ? null : groupedCountLabel(cc.extracted, cc.amountLines, cc.diff, cc.matches);
      } else {
        entry.groupedCheckLabel = null;
      }
      log('wizard.save', 'statement type saved', { file: entry.name, profileId: profile.id, versionId: version.id, rowCount: rows.length });
      announce(`Statement type saved: ${profile.name}. Back on Home.`);
      onSaved?.(entry);
    } catch (e) {
      logError('wizard.save', e, { file: entry.name });
      throw e;
    }
  }

  // --- Guided flow: stepper, sticky footer, focus/Enter ---------------------

  function stepValidCtx() {
    return {
      isPdf: isPdf(),
      bank: $('#w-bank').value,
      currency: $('#w-currency').value,
      headerRowIdx: headerRow(),
      pdfRowModel: state.pdf?.rowModel,
      groupedRowCount: state.pdf?.groupedRowCount,
      tableStart: state.pdf?.tableStart,
      tableEnd: state.pdf?.tableEnd,
      pdfColumnFields: state.pdf?.columns?.map((c) => c.field) || [],
      mappingFields: state.mapping.map((m) => m.field),
    };
  }

  function stepValid(step) {
    return computeStepValid(step, stepValidCtx());
  }

  /**
   * Finding 2: the single place every input/select/change handler in the
   * wizard calls after touching state, so the live preview and the footer's
   * Continue button are never out of sync. Before this, most handlers called
   * renderLivePreview() directly and only the Basics-step text inputs and
   * setStep()/goNext() called renderFooter() - so a valid manual mapping
   * (map fields' target <select>, a PDF zone assignment, a date/number/sign
   * format change, a footer-skip toggle, a header-row pick) never
   * re-evaluated stepValid(), leaving Continue disabled with no visible
   * reason and no discoverable way past it short of Back then Continue.
   */
  function refresh() {
    renderLivePreview();
    renderFooter();
  }

  function renderFooter() {
    const footer = $('#wizard-footer');
    if (!footer) return;
    const step = state.step;
    const backBtn = $('#wizard-back');
    const nextBtn = $('#wizard-next');
    if (backBtn) {
      backBtn.hidden = step === 0;
      backBtn.textContent = step > 0 ? `Back: ${STEP_META[step - 1].label}` : '';
    }
    // Finding B1: the reason Continue is disabled, in plain words, right
    // above the footer - live via refresh() so it updates the moment a
    // mapping/basics field changes, same as the button itself.
    const reasonEl = $('#wizard-footer-reason');
    const reason = computeStepReason(step, stepValidCtx());
    if (reasonEl) {
      reasonEl.textContent = reason;
      reasonEl.hidden = !reason;
    }
    if (nextBtn) {
      const last = step === STEP_META.length - 1;
      nextBtn.textContent = last ? 'Save and finish' : `Continue: ${STEP_META[step + 1].label}`;
      nextBtn.disabled = !stepValid(step);
      if (nextBtn.disabled && reason) nextBtn.setAttribute('aria-describedby', 'wizard-footer-reason');
      else nextBtn.removeAttribute('aria-describedby');
    }
  }

  function setStep(step) {
    state.step = step;
    document.querySelectorAll('#wizard-stepper .step').forEach((el, idx) => {
      el.classList.toggle('current', idx === step);
      el.classList.toggle('done', idx < step);
      // Accessibility (Finding 6): the stepper is a nav; aria-current="step"
      // is how a screen reader announces which step is active, same as the
      // "current" class does visually.
      if (idx === step) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
    });
    document.querySelectorAll('#wizard-steps > div').forEach((div, idx) => div.classList.toggle('active', idx === step));
    // Item 1's plain intro ("A few quick questions...") only makes sense on
    // the first step of the fallback detailed wizard - never on later steps.
    const intro = $('#wizard-step-intro');
    if (intro && !intro.hidden) intro.hidden = !(step === 0 || (step === 1 && state.gateIntro) || (step === 2 && state.gateIntro));
    if (step === 2) renderLivePreview();
    if (step === 3) renderTestStep();
    if (step === 4) renderSaveStep();
    renderFooter();
    log('wizard.step', 'step changed', { file: state.entry?.name, step: STEP_META[step].id });
    // Item 3: scroll position otherwise leaks between steps - #wizard-steps
    // is the real scroller (see the Fix 4 CSS note below on this file's own
    // workspace.css block), not <main>, so it's the one that must reset.
    const stepsHost = $('#wizard-steps');
    if (stepsHost) stepsHost.scrollTop = 0;
    // Accessibility (Finding 6): focus moves to the step heading on every
    // step change, so a screen-reader user hears which step they landed on
    // instead of silently landing on whatever input happens to be first.
    const heading = $('#wizard-step-heading');
    if (heading) {
      heading.textContent = STEP_META[step].label;
      heading.focus();
    }
    announce(`Step ${step + 1} of ${STEP_META.length}, ${STEP_META[step].label}`);
  }

  async function goNext() {
    if (!stepValid(state.step)) {
      // Never a silent no-op: show the reason, disable Continue, focus the first empty required field.
      renderFooter();
      const firstEmpty = Array.from(document.querySelectorAll('#wizard-steps input, #wizard-steps select')).find((el) => !el.hidden && el.offsetParent && el.hasAttribute('required') && !String(el.value || '').trim());
      (firstEmpty || $('#wizard-footer-reason'))?.focus?.();
      return;
    }
    if (state.step === STEP_META.length - 1) {
      await save();
      return;
    }
    // Item 1: never show a step with no action - a confidently-detected
    // grouped/OCR PDF has nothing to confirm on Locate data, so skip
    // straight to Map fields (which gets a compact "Found N transactions
    // ... Change" line instead, see renderMappingTable).
    const next = state.step === 0 && shouldSkipLocateStep() ? 2 : state.step + 1;
    setStep(next);
  }

  function goBack() {
    if (state.step === 0) return;
    const prev = state.step === 2 && shouldSkipLocateStep() ? 0 : state.step - 1;
    setStep(prev);
  }

  function wire() {
    document.querySelectorAll('#wizard-stepper .step').forEach((btn) => {
      btn.addEventListener('click', () => setStep(Number(btn.dataset.step)));
    });
    $('#wizard-back')?.addEventListener('click', goBack);
    $('#wizard-next')?.addEventListener('click', goNext);
    $('#confirm-yes')?.addEventListener('click', () => renderConfirmC());
    $('#confirm-off')?.addEventListener('click', () => showConfirmScreen('b'));
    $('#confirm-fix-dates')?.addEventListener('click', () => openConfirmFocus('dates'));
    $('#confirm-fix-amounts')?.addEventListener('click', () => openConfirmFocus('amounts'));
    $('#confirm-fix-rows')?.addEventListener('click', () => openConfirmFocus('locate'));
    $('#confirm-fix-other')?.addEventListener('click', () => { setConfirmMode(false); setStep(2); });
    $('#confirm-focus-done')?.addEventListener('click', () => closeConfirmFocus());
    $('#confirm-save')?.addEventListener('click', async () => {
      $('#w-name').value = $('#confirm-name')?.value || suggestedProfileName();
      await save();
    });
    $('#w-pending-prefix')?.addEventListener('change', (e) => {
      state.pendingPrefix = e.target.checked ? '[UNPOSTED]' : null;
      log('wizard.pendingPrefix', 'pending-prefix suggestion toggled', { file: state.entry?.name, on: e.target.checked });
    });
    $('#transform-add-btn').addEventListener('click', () => {
      state.transforms.push({ field: TRANSFORM_FIELDS[0], op: 'trim' });
      renderTransforms();
    });
    for (const id of ['#w-bank', '#w-type', '#w-currency', '#w-country']) {
      $(id)?.addEventListener('input', () => { if (state.basics) { state.basics.suggested[id.replace('#w-', '')] = false; } refresh(); });
    }
    for (const id of ['#w-dateformat', '#w-numberformat', '#w-signconvention']) {
      $(id)?.addEventListener('change', () => {
        log('wizard.signConvention', 'sign/date/number format changed', { file: state.entry?.name, field: id, value: $(id).value });
        // Item 4: the caption ("Detected from your file" vs "Changed by
        // you"), live example and mismatch warning under each picker only
        // live inside renderMappingTable (via renderPickerSamples) - refresh()
        // alone (live preview + footer) never touched them, so picking a
        // format used to leave last render's stale example/warning on
        // screen until the next full Map-fields render.
        renderMappingTable();
        refresh();
      });
    }
    $('#w-signature-add-btn')?.addEventListener('click', () => {
      const input = $('#w-signature-add-input');
      const phrase = input.value.trim();
      if (!phrase) return;
      if (!state.signaturePhrases) state.signaturePhrases = [];
      state.signaturePhrases.push(phrase);
      input.value = '';
      renderSaveStep();
    });
    $('#w-signatures-details-toggle')?.addEventListener('click', (e) => {
      e.preventDefault();
      const pre = $('#w-signatures-preview');
      if (!pre) return;
      pre.hidden = !pre.hidden;
      e.target.textContent = pre.hidden ? 'Show details' : 'Hide details';
    });
    document.getElementById('wizard-steps')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const target = e.target;
      const tag = target.tagName;
      // A2 major: the raw grid's own row/header controls, any <select>, any
      // <textarea>, and any button that isn't the wizard's own Next button
      // handle their own Enter - this listener must not also advance the step.
      if (tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (tag === 'BUTTON' && target.id !== 'wizard-next') return;
      if (target.closest?.('.raw-grid')) return;
      // Item 6: the Test step's inline Fix editor (Date/Description/Amount
      // <input>s in the row being edited) handles its own Enter (saves the
      // row) - this global listener must not also fire and skip a whole
      // wizard step out from under it.
      if (tag === 'INPUT' && target.closest?.('tr.editing-row')) return;
      e.preventDefault();
      goNext();
    });
  }

  return { open, wire, state, buildVersionFromWizard };
}
