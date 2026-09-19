// Review screen: split source/extracted view, two-way row highlighting, and the
// row-level actions the README flagged as missing (confirm/edit/exclude a row,
// add a missing row). State logic lives in rowedit.js; this file is DOM glue.

import { balanceCheck, countCheck, countCheckLabel, countCheckGrouped, groupedCountLabel, fileSummary, rowFlagLabel } from '../core/checks.js';
import {
  restoreRow, addMissingRow, treatAsTransaction, confirmAllLowConfidence, editRow,
  resolveConfirm, resolveExclude, resolveUseAlt, resolveEdit, undoRow, nextUnresolvedAfter, prevUnresolvedBefore,
  hasUnresolvableFlag,
} from './rowedit.js';
import { renderPdfPage, pdfYToCanvasTop, pdfYToCanvasPixel, getPdfPageInfo } from './pdf-render.js';
import { groupItemsIntoLines, lineText } from '../core/pdf.js';
import { formatMinorDisplay, decimalsFor } from '../core/amount.js';
import { log } from '../core/debuglog.js';
import { announce } from './nav.js';

const $ = (sel) => document.querySelector(sel);
// 'ocr'/'pending' record provenance/context only; they should not by
// themselves make a row look like it "needs a look" (that's
// 'low_confidence_ocr'/a real misread, or an actual warning flag).
const INFO_ONLY_FLAGS = new Set(['ocr', 'pending']);
// Pass 3 item 2 follow-up: an excluded row never "needs a look" again,
// regardless of what flags it still carries - confirmRow (rowedit.js) now
// deliberately keeps unparseable_date/missing_amount on a row until the
// value is actually fixed, so "Exclude" (never intended to fix the value,
// just drop the row) must be the thing that clears it from every warning
// count/all-done check here, same as home-state.js's warningRowCount/
// flaggedDecisionRows already do.
const hasWarningFlag = (row) => !row.excluded && (row.flags || []).some((f) => !INFO_ONLY_FLAGS.has(f));
// Row tags hide 'ocr' (already said once in the summary bar) but 'pending'
// is per-transaction context worth seeing on the row itself.
const HIDDEN_ROW_TAGS = new Set(['ocr']);

// extra_type (the grouped-rowModel PDF's transaction-category line, e.g.
// "Fund Transfer") reads as a caption under the description, not its own
// column; any other extra_* field a profile defines still gets one.
const CAPTION_EXTRA_FIELD = 'extra_type';

// Same loose amount-ending-line pattern checks.js's countCheckGrouped uses
// (kept as a separate copy rather than exported from there - it's a Review-
// only concern: aligning extracted rows back to the page/line they came
// from for the source-pane outline, not a count check).
const AMOUNT_LINE_LOOSE_RE = /(?:[A-Za-z0-9]{2,4}\s*)?[+-]?\s*[\d,]+\.\d{2}\s*$/;
// Same default date-group line pattern core/pdf.js's extractGroupedRows uses
// (also copied rather than imported - not exported there). Needed here for
// the same reason extractGroupedRows itself gates on it: an unsigned balance
// figure in the preamble ("Available Balance: SGD 8,214.12") also ends in a
// currency+decimal-number shape and would otherwise be mistaken for a
// transaction's amount line, throwing off every anchor after it.
const DATE_GROUP_RE = /^(?:[A-Za-z]+day|Yesterday|Today),?\s*(\d{1,2}\s*[A-Za-z]{3,}\s+\d{4})$|^(\d{1,2}\s*[A-Za-z]{3,}\s+\d{4})$/;

/**
 * Match each non-skipped row (in source order) to the page/line it came from
 * by walking every page's lines in reading order and consuming one
 * amount-shaped line per row - the same order extractGroupedRows itself
 * produces rows in, gated the same way it is (ignoreLinePatterns dropped,
 * nothing counted until the first date-group line opens). core/pdf.js
 * doesn't thread a page/y pointer through its extracted records today (see
 * review.js's module notes / README), so this is a best-effort
 * re-derivation from its own line-grouping output, not a change to the
 * extractor itself.
 * ponytail: only covers rowModel 'grouped' PDFs (the OCR'd-statement case
 * this was asked for); a columns-rowModel PDF falls back to no anchor and
 * the source pane just won't jump pages for it, upgrade if that's needed too.
 * @param {object[]} rows
 * @param {{y:number, items:object[]}[][]} pagesLines - one lines array per page, 1-indexed pages
 * @param {{ignoreLinePatterns?:string[], grouped?:{dateGroupPattern?:string}}} [pdfConfig] - the matched profile version's `pdf` config
 * @returns {Map<string,{page:number,y:number}>}
 */
export function alignRowsToPageLines(rows, pagesLines, pdfConfig = {}) {
  const ignoreRes = (pdfConfig.ignoreLinePatterns || []).map((p) => new RegExp(p));
  const dateRe = pdfConfig.grouped?.dateGroupPattern ? new RegExp(pdfConfig.grouped.dateGroupPattern) : DATE_GROUP_RE;
  const ordered = [...rows].filter((r) => !r.skipped).sort((a, b) => (a.source_line ?? 0) - (b.source_line ?? 0));
  const anchors = new Map();
  let rowIdx = 0;
  let dateOpened = false;
  for (let p = 0; p < pagesLines.length && rowIdx < ordered.length; p++) {
    for (const line of pagesLines[p]) {
      if (rowIdx >= ordered.length) break;
      const text = lineText(line).trim();
      if (!text || ignoreRes.some((re) => re.test(text))) continue;
      if (dateRe.test(text)) { dateOpened = true; continue; }
      if (!dateOpened) continue;
      if (AMOUNT_LINE_LOOSE_RE.test(text)) {
        anchors.set(ordered[rowIdx].row_id, { page: p + 1, y: line.y });
        rowIdx++;
      }
    }
  }
  return anchors;
}

// Coordinator round 3: shared with settings.js/home.js's own preferences
// object (same 'settings' storage key) so this one extra field doesn't grow
// a whole new storage entry - read-merge-write like every other write to it.
const SETTINGS_KEY = 'settings';

export function createReview({ storage, getFiles, onUpdateMapping, persist, nav, onRemoveFile }) {
  let activeIdx = 0;
  let selectedRowId = null;
  let warningsFilter = false;
  let editingRowId = null;
  // 'side-by-side' | 'stacked' | null (null = automatic, decided by updateSplitLayout).
  let layoutOverride = null;
  const layoutPrefLoaded = (async () => {
    const prefs = (await storage?.get(SETTINGS_KEY)) || {};
    if (prefs.reviewLayout === 'side-by-side' || prefs.reviewLayout === 'stacked') layoutOverride = prefs.reviewLayout;
    renderLayoutToggle();
  })();

  function files() { return getFiles().filter((f) => f.rows && f.rows.length); }

  /**
   * Jump straight to one file's review (the quiet "Review" link on Home, or
   * the warnings badge on a file row). opts.filter === 'warnings' turns the
   * warnings filter on and selects the first flagged row.
   */
  function showFile(entry, opts = {}) {
    const idx = files().indexOf(entry);
    if (idx !== -1) activeIdx = idx;
    editingRowId = null;
    warningsFilter = opts.filter === 'warnings';
    if (warningsFilter) {
      const file = files()[activeIdx];
      const firstWarn = file?.rows.find((r) => !r.skipped && hasWarningFlag(r));
      selectedRowId = firstWarn ? firstWarn.row_id : selectedRowId;
    }
  }

  function render() {
    const list = files();
    const empty = $('#review-empty');
    const body = $('#review-body');
    if (!list.length) { empty.hidden = false; body.hidden = true; return; }
    empty.hidden = true; body.hidden = false;
    if (activeIdx >= list.length) activeIdx = list.length - 1;
    const file = list[activeIdx];

    renderSummary(file, list);
    renderConfirmAllButton(file);
    renderWarningsChip(file);
    renderCompletion(file, list);
    renderFooterActions(list);
    renderSourcePane(file);
    renderSkippedGroup(file);
    renderExtractedTable(file);
    $('#review-warnings-filter')?.classList.toggle('active', warningsFilter);
    // Item 1: the selected row's highlight/label follows it regardless of
    // whether the Warnings filter is on - not just while filtering.
    const selectedRow = selectedRowId ? file.rows.find((r) => r.row_id === selectedRowId) : null;
    renderShowingLabel(selectedRow);
    if (selectedRow) {
      highlightSource(file, selectedRow);
      $(`#review-table tr[data-row-id="${selectedRow.row_id}"]`)?.scrollIntoView({ block: 'center' });
    }
  }

  /**
   * Item 1: date/description/amount for the row currently in focus, e.g.
   * "14 Sep 2026 · NTUC FAIRPRICE · -48.20" - shared by the source pane's
   * "Showing:" label and screen-reader announcements on navigation.
   */
  function formatShowingDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  }
  function describeRow(row) {
    if (!row) return '';
    const dateText = formatShowingDate(row.date) || row.date_raw || '';
    const desc = row.merchant || row.description_raw || '';
    const amt = row.amount == null ? '' : formatMinorDisplay(row.amount, row.currency);
    return [dateText, desc, amt].filter(Boolean).join(' · ');
  }
  function renderShowingLabel(row) {
    const label = $('#source-showing-label');
    if (!label) return;
    const text = describeRow(row);
    label.textContent = text ? `Showing: ${text}` : '';
    label.hidden = !text;
  }

  /**
   * Item 1/2/3: the one place that changes which row is "in focus" - moves
   * both panes (table scroll + source pane jump/outline), updates the
   * "Showing:" label, and optionally announces the move for screen readers.
   */
  function selectRow(file, row, opts = {}) {
    if (!row) return;
    selectedRowId = row.row_id;
    renderExtractedTable(file);
    renderWarningsChip(file); // item 2: position indicator ("Warning N of M") follows the selection too
    highlightSource(file, row);
    renderShowingLabel(row);
    $(`#review-table tr[data-row-id="${row.row_id}"]`)?.scrollIntoView({ block: 'center' });
    if (opts.announceText) announce(opts.announceText);
  }

  function renderSummary(file, list) {
    const rows = file.rows.filter((r) => !r.excluded);
    const summary = fileSummary(file.rows);
    // Item 1: a grouped-rowModel PDF (app-export / OCR'd statement, no
    // per-transaction date-led line) needs countCheckGrouped's amount-line
    // count instead of countCheck's date-led-line count - see checks.js.
    const isGroupedPdf = file.type === 'pdf' && file.matchedVersion?.pdf?.rowModel === 'grouped';
    const groupedCounts = isGroupedPdf && file.pdfSourceText
      ? countCheckGrouped(file.pdfSourceText, rows.length, file.matchedVersion?.pdf || {})
      : null;
    const counts = !groupedCounts && file.text ? countCheck(file.text, rows.length) : null;
    const balance = balanceCheck(file.rows);
    const totalsByCur = summary.byCurrency;
    const cur = Object.keys(totalsByCur)[0];
    const totals = cur ? totalsByCur[cur] : { in: 0, out: 0 };

    let mismatchNote = '';
    if (balance.reconciles === false && balance.firstFailingRow) {
      const rowNum = file.rows.findIndex((r) => r.row_id === balance.firstFailingRow.row_id) + 1;
      if (rowNum > 0) {
        mismatchNote = ` <button type="button" class="balance-mismatch-link" data-row-id="${escapeHtml(balance.firstFailingRow.row_id)}" style="background:none;border:none;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer;">first mismatch at row ${rowNum}</button>`;
      }
    }

    // Count check, explained: extractedCount includes skipped summary lines
    // (they were still extracted as raw records by csv.js), sourceLines only
    // counts date-led lines. When they differ, break the gap down instead of
    // just flashing a bare pass/fail.
    let countsHtml = '';
    if (groupedCounts) {
      // Same wording the wizard's Test step uses (checks.js's groupedCountLabel,
      // item 5's three severities), so a missing-row count mismatch reads
      // identically here and there.
      const result = groupedCountLabel(groupedCounts.extracted, groupedCounts.amountLines, groupedCounts.diff, groupedCounts.matches);
      const cls = result.tone === 'ok' ? 'pass' : result.tone === 'neutral' ? 'neutral' : 'fail';
      const updateLink = result.showUpdateMappingLink ? ` <a href="#" class="rs-link" id="review-update-mapping-from-count">Set up again</a>` : '';
      // Item 6: the reverse of a missing row - a counted amount line that
      // produced no row at all - named with page/line numbers so it's a
      // place to look, not just a number (checks.js's tagUnmatchedGroupedRows,
      // stashed on file.rows by pipeline.js/worker.js).
      const missed = file.rows.missedLines || [];
      const missedHtml = missed.length
        ? `<div class="pdf-anchor-hint">${missed.length} amount line${missed.length === 1 ? '' : 's'} produced no row: ${missed.map((m) => `page ${m.page} line ${m.lineNumber}`).join(', ')}</div>`
        : '';
      countsHtml = `<div class="rs-item ${cls}">${result.text}${updateLink}</div>${missedHtml}`;
      log('review', 'grouped count check rendered', { sourceFile: file.name, extracted: groupedCounts.extracted, amountLines: groupedCounts.amountLines, matches: groupedCounts.matches, tone: result.tone });
    } else if (counts) {
      // Same wording/tone rules as the grouped-PDF path just above
      // (checks.js's countCheckLabel, mirroring groupedCountLabel) - "N rows
      // read, N ... found" either way, so a CSV and a PDF read identically.
      const skippedCount = file.rows.filter((r) => r.skipped).length;
      const flaggedRemainder = counts.diff - skippedCount;
      const explainNote = !counts.matches && flaggedRemainder === 0 && skippedCount
        ? `${skippedCount} skipped summary line${skippedCount === 1 ? '' : 's'}`
        : null;
      const result = countCheckLabel(counts.extractedCount, counts.sourceLines, counts.diff, counts.matches, explainNote);
      const cls = result.tone === 'ok' ? 'pass' : result.tone === 'neutral' ? 'neutral' : 'fail';
      countsHtml = `<div class="rs-item ${cls}">${result.text}</div>`;
      log('review', 'count check rendered', { sourceFile: file.name, extractedCount: counts.extractedCount, sourceLines: counts.sourceLines, matches: counts.matches, skippedCount, flaggedRemainder });
    }

    let outHint = '';
    if (totals.out === 0 && summary.rowCount > 5) {
      outHint = `<div class="rs-item"><span class="num">$0.00</span>All amounts are positive. If some should be money out, <button type="button" id="review-update-mapping-hint" style="background:none;border:none;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer;">set this statement up again</button>.</div>`;
    }

    const ocrNote = file.rows.some((r) => r.flags?.includes('ocr'))
      ? '<div class="rs-item rs-ocr-note">Read by text recognition, check amounts against the page</div>'
      : '';

    const flagsHistogram = {};
    for (const r of file.rows) {
      if (r.skipped) continue;
      for (const f of r.flags || []) flagsHistogram[f] = (flagsHistogram[f] || 0) + 1;
    }
    log('review', 'file summary + checks', {
      sourceFile: file.name, rowCount: summary.rowCount, byCurrency: summary.byCurrency,
      balanceReconciles: balance.reconciles, flagsHistogram,
    });

    const host = $('#review-summary');
    host.innerHTML = '';
    if (list.length > 1) {
      const select = document.createElement('select');
      select.className = 'map-select';
      select.setAttribute('aria-label', 'File to review');
      list.forEach((f, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx); opt.textContent = f.name;
        if (idx === activeIdx) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => { activeIdx = Number(select.value); editingRowId = null; render(); });
      host.appendChild(select);
    }
    // Remove this file straight from Review, same removeFile as Home's row
    // control - cancels/removes rows, kicks off dedupe re-run + the "Removed
    // <file>. Undo" toast, then Review just re-renders onto whatever's left.
    if (onRemoveFile) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'icon-btn danger';
      removeBtn.setAttribute('aria-label', `Remove ${file.name}`);
      removeBtn.title = 'Remove';
      removeBtn.textContent = '✕ Remove';
      removeBtn.onclick = () => { onRemoveFile(file); render(); };
      host.appendChild(removeBtn);
    }
    // Item 5: balance check's "n/a" reads as a neutral, non-alarming "No
    // balance column" (grey, not red/green) when there's simply nothing to
    // check; money in/out get thousands separators.
    const balanceCls = balance.reconciles === false ? 'fail' : balance.reconciles === true ? 'pass' : 'neutral';
    const balanceLabel = balance.reconciles === false ? 'Fails' : balance.reconciles === true ? 'Passes' : 'No balance column';
    host.insertAdjacentHTML('beforeend', `
      <div class="rs-item"><span class="num">${summary.rowCount}</span>rows</div>
      <div class="rs-item"><span class="num">${summary.dateRange ? `${summary.dateRange.start} to ${summary.dateRange.end}` : 'n/a'}</span>date range</div>
      <div class="rs-item pass"><span class="num">+${formatMinorDisplay(totals.in, cur)} ${cur || ''}</span>money in</div>
      <div class="rs-item"><span class="num">-${formatMinorDisplay(totals.out, cur)} ${cur || ''}</span>money out</div>
      <div class="rs-item ${balanceCls}"><span class="num">${balanceLabel}</span>balance check${mismatchNote}</div>
      ${countsHtml}
      ${outHint}
      ${ocrNote}
    `);
  }

  // Item A2: only announce the warnings count to screen readers when it
  // actually changes, per file - re-announcing an unchanged count on every
  // render() call would be noise, not a live update.
  let lastAnnouncedWarnings = null;
  /** Warnings chip shows its own count and disables itself when there's nothing to filter to. */
  function renderWarningsChip(file) {
    const chip = $('#review-warnings-filter');
    const nextBtn = $('#review-next-warning');
    const prevBtn = $('#review-prev-warning');
    const posEl = $('#review-warning-position');
    const flagged = file.rows.filter((r) => !r.skipped && hasWarningFlag(r));
    const count = flagged.length;
    // Item 6: remembers whether this file has EVER actually had a warning to
    // resolve - a file that simply never had one (a clean CSV, or an OCR
    // pass with no flags this time) must never trigger the completion/
    // all-done treatment, which would otherwise hide its normal table.
    if (count > 0) file._hadWarnings = true;
    if (chip) {
      chip.textContent = `Quick look (${count})`;
      chip.disabled = count === 0;
    }
    if (nextBtn) nextBtn.disabled = count === 0;
    if (prevBtn) prevBtn.disabled = count === 0;
    // Item 2: "Quick look 3 of 8" - the selected row's 1-based position among
    // this file's current rows needing a look, or blank once there are none/nothing selected.
    if (posEl) {
      const idx = flagged.findIndex((r) => r.row_id === selectedRowId);
      posEl.textContent = count === 0 ? '' : `Quick look ${idx === -1 ? '–' : idx + 1} of ${count}`;
    }
    const key = `${file.name}:${count}`;
    if (lastAnnouncedWarnings !== null && lastAnnouncedWarnings !== key) {
      announce(count === 0 ? 'Nothing left to check in this file.' : `${count} row${count === 1 ? '' : 's'} need a quick look in this file.`);
    }
    lastAnnouncedWarnings = key;
  }

  /** Item 2: OCR files get a bulk "Confirm all N low-confidence rows" action next to the Warnings chip. */
  function renderConfirmAllButton(file) {
    const btn = $('#review-confirm-all-btn');
    if (!btn) return;
    const count = file.rows.filter((r) => !r.skipped && !r.excluded && (r.flags || []).includes('low_confidence_ocr')).length;
    btn.hidden = !(file.ocr && count > 0);
    btn.textContent = `Confirm all ${count} low-confidence row${count === 1 ? '' : 's'}`;
  }

  function fileHasWarnings(file) { return file.rows.some((r) => !r.skipped && hasWarningFlag(r)); }

  /** Index (in `list`) of the nearest OTHER file that still has warnings, or -1. */
  function nextWarningFileIndex(list, excludeIdx) {
    for (let i = 0; i < list.length; i++) {
      if (i !== excludeIdx && fileHasWarnings(list[i])) return i;
    }
    return -1;
  }

  function jumpToFileWarnings(idx) {
    const list = files();
    if (idx < 0 || idx >= list.length) return;
    activeIdx = idx;
    editingRowId = null;
    warningsFilter = true;
    const first = list[idx].rows.find((r) => !r.skipped && hasWarningFlag(r));
    selectedRowId = first ? first.row_id : selectedRowId;
    render();
  }

  /** Item 3, "Export"/"Add a statement": both hand off to Home via the shared nav hook - there is no deeper "scroll to Ready to copy" hook exposed from Home today, so this lands on Home plain and logs that gap rather than guessing at DOM inside a screen this file doesn't own. */
  function goHome(reason) {
    if (nav?.showScreen) { nav.showScreen('home'); return; }
    log('review', `${reason}: no nav.showScreen hook wired, cannot navigate to Home`, {});
  }

  function anyFileHasWarnings(list) { return list.some(fileHasWarnings); }

  let completionCountdownTimer = null;
  function cancelCompletionCountdown() {
    if (completionCountdownTimer) { clearTimeout(completionCountdownTimer); completionCountdownTimer = null; }
    const wrap = $('#review-complete-countdown');
    if (wrap) wrap.hidden = true;
  }
  // Item 6b: 3s auto-advance to the next statement with warnings, "Stay
  // here" cancels it. prefers-reduced-motion only drops the visual sweep
  // (the CSS media query on .countdown-fill's transition) - the timer itself
  // still runs either way, so the advance behaves the same for everyone.
  function startCompletionCountdown(targetIdx) {
    cancelCompletionCountdown();
    const wrap = $('#review-complete-countdown');
    const fill = $('#review-complete-countdown-fill');
    if (wrap) wrap.hidden = false;
    if (fill) {
      fill.style.transition = 'none';
      fill.style.width = '0%';
      void fill.offsetWidth; // restart the transition on the next frame
      fill.style.transition = 'width 3s linear';
      fill.style.width = '100%';
    }
    completionCountdownTimer = setTimeout(() => { completionCountdownTimer = null; jumpToFileWarnings(targetIdx); }, 3000);
  }

  let allDoneAnnounced = false;
  /** Item 6c: replaces both panes with a calm all-done state once every statement has zero warnings left. */
  function showAllDone(list) {
    const host = $('#review-all-done');
    if (!host) return;
    $('#review-split').hidden = true;
    $('#review-warnings-bar').hidden = true;
    $('#review-skipped-group').hidden = true;
    $('#review-footer-actions').hidden = true;
    host.hidden = false;
    const totalTx = list.reduce((s, f) => s + f.rows.filter((r) => !r.skipped).length, 0);
    const totalResolved = list.reduce((s, f) => s + (f._resolvedCount || 0), 0);
    const summaryText = `${list.length} statement${list.length === 1 ? '' : 's'}, ${totalTx} transaction${totalTx === 1 ? '' : 's'}, ${totalResolved} quick look${totalResolved === 1 ? '' : 's'} resolved`;
    const summary = $('#review-all-done-summary');
    if (summary) summary.textContent = summaryText;
    const select = $('#review-all-done-reselect');
    if (select && select.dataset.builtFor !== String(list.length)) {
      select.innerHTML = '<option value="">Review a statement again</option>'
        + list.map((f, i) => `<option value="${i}">${escapeHtml(f.name)}</option>`).join('');
      select.dataset.builtFor = String(list.length);
    }
    if (!allDoneAnnounced) { announce(`All statements reviewed. ${summaryText}`); allDoneAnnounced = true; }
  }
  function hideAllDone() {
    const host = $('#review-all-done');
    if (host && !host.hidden) {
      host.hidden = true;
      $('#review-split').hidden = false;
      $('#review-warnings-bar').hidden = false;
      $('#review-skipped-group').hidden = false;
      $('#review-footer-actions').hidden = false;
    }
    allDoneAnnounced = false;
  }

  /**
   * Item 3/6: Review never ends blank ONCE THERE WAS SOMETHING TO RESOLVE - a
   * file/batch that simply never had a warning (file._hadWarnings unset)
   * gets none of this, just its normal table, so a clean statement isn't
   * hidden behind a "reviewed" screen it never earned. Once every warning in
   * the active file that DID have some is resolved: if another statement
   * still has warnings, a completion panel offers "Review next: <name> (N
   * warnings)", auto-advancing on a 3s countdown right after a resolve
   * action resolved the last one (`opts.justResolved`) - "Stay here" cancels
   * it, and just revisiting an already-done file (no opts) shows the panel
   * without restarting a countdown. Once NO statement anywhere has warnings
   * left, AND at least one ever did, the calm all-done state (showAllDone)
   * replaces both panes instead.
   */
  function renderCompletion(file, list, opts = {}) {
    const host = $('#review-complete');
    const anyEverHadWarnings = list.some((f) => f._hadWarnings);

    if (!anyFileHasWarnings(list)) {
      if (host) host.hidden = true;
      cancelCompletionCountdown();
      if (anyEverHadWarnings) showAllDone(list); else hideAllDone();
      return;
    }

    hideAllDone();
    if (!fileHasWarnings(file) && file._hadWarnings) {
      if (!host) return;
      host.hidden = false;
      const nextIdx = nextWarningFileIndex(list, activeIdx);
      const nextFile = list[nextIdx];
      const n = file._resolvedCount || 0;
      const msg = $('#review-complete-msg');
      if (msg) msg.textContent = `All ${n} quick look${n === 1 ? '' : 's'} resolved in ${file.name}.`;
      const primary = $('#review-complete-primary');
      if (primary && nextFile) {
        const nextCount = nextFile.rows.filter((r) => !r.skipped && hasWarningFlag(r)).length;
        primary.textContent = `Check next: ${nextFile.name} (${nextCount} row${nextCount === 1 ? '' : 's'} to look at)`;
        primary.dataset.action = 'next';
        primary.dataset.targetIdx = String(nextIdx);
      }
      if (opts.justResolved && nextFile) startCompletionCountdown(nextIdx); else cancelCompletionCountdown();
      return;
    }
    if (host) host.hidden = true;
    cancelCompletionCountdown();
    hideAllDone();
  }

  /** Item 3: the same three actions as a persistent footer, so leaving Review always has a next step regardless of the active file's own state. */
  function renderFooterActions(list) {
    const nextBtn = $('#review-footer-next');
    const exportBtn = $('#review-footer-export');
    const nextIdx = nextWarningFileIndex(list, activeIdx);
    if (nextBtn) { nextBtn.hidden = nextIdx === -1; nextBtn.dataset.targetIdx = String(nextIdx); }
    if (exportBtn) exportBtn.hidden = nextIdx !== -1;
  }

  /** Collapsed group listing skipped non-transaction lines (item 1). */
  function renderSkippedGroup(file) {
    const host = $('#review-skipped-group');
    const skipped = file.rows.filter((r) => r.skipped);
    if (!skipped.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = `<details><summary>${skipped.length} line${skipped.length === 1 ? '' : 's'} skipped, not transactions</summary><ul class="skipped-list"></ul></details>`;
    const ul = host.querySelector('.skipped-list');
    for (const row of skipped) {
      const li = document.createElement('li');
      const text = row.date_raw || row.description_raw || '(blank line)';
      li.innerHTML = `<span>${escapeHtml(text)}</span><button type="button" data-treat-row-id="${escapeHtml(row.row_id)}">Treat as transaction</button>`;
      ul.appendChild(li);
    }
  }

  // --- Source pane (CSV grid, or PDF fit-to-pane with page nav/zoom) ------

  async function renderSourcePane(file) {
    const label = $('#source-pane-label');
    const grid = $('#source-csv-grid');
    const pdfScroll = $('#source-pdf-scroll');
    const controls = $('#source-pdf-controls');
    const notKept = $('#source-not-kept');
    // Finding 4 (coordinator round 2): a restored session persists the
    // extracted rows but not the original file bytes/grid (that's the whole
    // point of not keeping raw statement data around) - the pane used to
    // just render nothing (an empty "raw view" table, or a page-render
    // error swallowed by renderPdfPageInto's own try/catch) with no
    // explanation. Say so plainly instead of leaving it blank, on whichever
    // side actually lost its source (a PDF's bytes, or a CSV's grid).
    // Coordinator round 3: the pane-head toolbar must stay one line even at
    // its 440px floor, so the label is just the filename (ellipsised by
    // CSS), with the full name (plus what kind of view it is) as the title
    // attribute instead of spelled out inline as "Source: <name>, raw view".
    const setLabel = (title) => { label.textContent = file.name; label.title = title; };
    const hasSource = file.type === 'pdf' ? !!file.bytes : !!(file.grid && file.grid.length);
    if (!hasSource) {
      if (controls) controls.hidden = true;
      grid.hidden = true; pdfScroll.hidden = true;
      setLabel(file.name);
      if (notKept) notKept.hidden = false;
      return;
    }
    if (notKept) notKept.hidden = true;
    if (file.type === 'pdf') {
      if (controls) controls.hidden = false;
      grid.hidden = true; pdfScroll.hidden = false;
      setLabel(file.name);
      file._reviewPage ||= 1;
      file._reviewZoom ||= 1;
      await renderPdfPageInto(file, file._reviewPage);
    } else {
      if (controls) controls.hidden = true;
      setLabel(`${file.name}, raw view`);
      grid.hidden = false; pdfScroll.hidden = true;
      const table = document.createElement('table');
      table.className = 'csv-table';
      const headerRow = file.headerRowUsed ?? 0;
      (file.grid || []).forEach((row, rowIdx) => {
        const tr = document.createElement('tr');
        tr.dataset.gridIdx = String(rowIdx);
        if (rowIdx > headerRow) tr.dataset.sourceLine = String(rowIdx - headerRow - 1);
        tr.innerHTML = row.map((c) => `<td>${escapeHtml(String(c ?? ''))}</td>`).join('');
        table.appendChild(tr);
      });
      grid.innerHTML = '';
      grid.appendChild(table);
    }
  }

  /**
   * Page geometry (PDF points, at scale 1) + text items + page count for one
   * PDF page, cached per file. OCR'd files still ask pdf.js for the page's
   * real width/height (OCR only gives text, not page geometry) but use the
   * OCR'd items instead of pdf.js's own (empty, for an image-only page) text.
   */
  async function getPageData(file, pageNum) {
    file._pageCache ??= new Map();
    if (file._pageCache.has(pageNum)) return file._pageCache.get(pageNum);
    const info = await getPdfPageInfo(file.bytes, pageNum);
    const items = file.ocr && file.ocrPages?.[pageNum - 1] ? file.ocrPages[pageNum - 1].items : info.items;
    const data = { width: info.width, height: info.height, items, numPages: info.numPages };
    file._pageCache.set(pageNum, data);
    file._numPages = info.numPages;
    return data;
  }

  /**
   * Render one PDF page into the source pane at a scale computed from the
   * pane's own width (item 4's "fit the page to the pane"), with zoom
   * relative to that fit. Re-run on Prev/Next, zoom, and window resize.
   */
  async function renderPdfPageInto(file, pageNum) {
    const pdfScroll = $('#source-pdf-scroll');
    if (!pdfScroll) return;
    let data;
    try { data = await getPageData(file, pageNum); } catch { data = null; }
    if (!data) { pdfScroll.innerHTML = 'Could not render the PDF page.'; return; }
    const total = data.numPages || 1;
    file._reviewPage = Math.min(Math.max(1, pageNum), total);
    const zoom = file._reviewZoom || 1;
    const paneWidth = Math.max(200, pdfScroll.clientWidth - 40 || 560); // minus the pane's own padding
    const scale = (paneWidth / data.width) * zoom;
    const ocrItems = file.ocr ? data.items : null;

    let rendered;
    try {
      rendered = await renderPdfPage(file.bytes, file._reviewPage, scale, ocrItems ? { items: ocrItems } : {});
    } catch { pdfScroll.innerHTML = 'Could not render the PDF page.'; return; }
    const { canvas, viewport, items } = rendered;

    pdfScroll.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.style.width = `${canvas.width}px`;
    wrap.appendChild(canvas);
    pdfScroll.appendChild(wrap);

    const lines = groupItemsIntoLines(items);
    file._pdfLines = lines;
    file._pdfViewport = viewport;
    lines.forEach((line) => {
      const top = pdfYToCanvasTop(line.y, viewport);
      const strip = document.createElement('div');
      strip.className = 'anchor-row-highlight';
      strip.dataset.y = String(line.y);
      strip.style.top = `${top - 11}px`;
      strip.style.height = '15px';
      strip.style.left = '0'; strip.style.right = '0';
      wrap.appendChild(strip);
    });

    const pageLabel = $('#pdf-page-label');
    const zoomLabel = $('#pdf-zoom-label');
    const prevBtn = $('#pdf-prev-page');
    const nextBtn = $('#pdf-next-page');
    // Coordinator round 3: "N/M" not "Page N of M" - the toolbar has to stay
    // one line down to a 440px pane, and the page nav's own Prev/Next
    // buttons already make "page" the obvious context.
    if (pageLabel) pageLabel.textContent = `${file._reviewPage}/${total}`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    if (prevBtn) prevBtn.disabled = file._reviewPage <= 1;
    if (nextBtn) nextBtn.disabled = file._reviewPage >= total;

    await ensurePdfAnchors(file);
    if (selectedRowId) {
      const row = file.rows.find((r) => r.row_id === selectedRowId);
      if (row) outlineIfCurrentPage(file, row);
    }
  }

  /**
   * Build (once per rows array) the row_id -> {page, y, h, y2} anchor map so
   * clicking a row can jump the source pane to the page it came from and
   * outline it there (item 4). Item 1 (Section B, 2026-09-17): core/pdf.js
   * now stamps source_page/source_y on every extracted row (both rowModels,
   * text and OCR) - normalize.js's `original = {...record}` spread carries
   * them onto row.original untouched, so this is the row's OWN recorded
   * extraction position, not a re-derivation. Preferred whenever present;
   * falls back to the old best-effort line-walk (alignRowsToPageLines) only
   * for a grouped-rowModel PDF extracted before this change (a restored
   * session) or any row missing it. `h` (source_h, the line's own real
   * height) and `y2` (source_y2, a second/trailing line's bottom edge for a
   * two-line transaction) default to a flat 10pt / none for a row extracted
   * before those fields existed (an older restored session).
   */
  async function ensurePdfAnchors(file) {
    if (file._pdfAnchorsFor === file.rows) return;
    const direct = new Map();
    for (const row of file.rows) {
      if (row.skipped) continue;
      const page = row.original?.source_page;
      const y = row.original?.source_y;
      if (page != null && y != null) {
        direct.set(row.row_id, { page, y, h: row.original?.source_h ?? 10, y2: row.original?.source_y2 ?? null });
      }
    }
    if (direct.size === file.rows.filter((r) => !r.skipped).length) {
      file._pdfAnchors = direct;
      file._pdfAnchorsFor = file.rows;
      return;
    }
    if (file.matchedVersion?.pdf?.rowModel !== 'grouped') {
      file._pdfAnchors = direct.size ? direct : null;
      file._pdfAnchorsFor = file.rows;
      return;
    }
    const total = file._numPages || 1;
    const pagesLines = [];
    for (let p = 1; p <= total; p++) {
      let data;
      try { data = await getPageData(file, p); } catch { continue; }
      pagesLines.push(groupItemsIntoLines(data.items));
    }
    const fallback = alignRowsToPageLines(file.rows, pagesLines, file.matchedVersion?.pdf || {});
    file._pdfAnchors = new Map([...fallback, ...direct]); // direct (real extraction data) wins where both exist
    file._pdfAnchorsFor = file.rows;
  }

  /**
   * Draw the brass outline around the selected row's own text on the source
   * page - a dedicated box computed from its real anchor (source_y/source_h,
   * plus source_y2 for a two-line transaction), not one of the ambient
   * per-line tint strips picked by an approximate y match. PDF space is
   * y-up: the box runs from `anchor.y + anchor.h` (the top of the FIRST
   * line, its own height above its baseline-ish y) down to `anchor.y2 ??
   * anchor.y` (the bottom of the LAST line - the same line again for a
   * single-line transaction), converted to canvas pixels with the same
   * viewport every other overlay in this pane uses.
   */
  function outlineIfCurrentPage(file, row) {
    const scroll = $('#source-pdf-scroll');
    const wrap = scroll?.querySelector('.pdf-page-wrap');
    scroll?.querySelectorAll('.anchor-row-highlight.outlined').forEach((el) => el.remove());
    const anchor = file._pdfAnchors?.get(row.row_id);
    const viewport = file._pdfViewport;
    if (!anchor || !wrap || !viewport || anchor.page !== file._reviewPage) return;
    const topY = anchor.y + anchor.h;
    const bottomY = anchor.y2 ?? anchor.y;
    const topPx = pdfYToCanvasPixel(topY, viewport);
    const bottomPx = pdfYToCanvasPixel(bottomY, viewport);
    const box = document.createElement('div');
    box.className = 'anchor-row-highlight outlined';
    box.style.top = `${topPx}px`;
    box.style.height = `${Math.max(4, bottomPx - topPx)}px`;
    box.style.left = '0'; box.style.right = '0';
    // Not read by any layout/paint - just so tooling (e2e checks, debugging)
    // can see exactly which PDF-space anchor this box came from.
    box.dataset.y = String(anchor.y);
    if (anchor.y2 != null) box.dataset.y2 = String(anchor.y2);
    wrap.appendChild(box);
    box.scrollIntoView({ block: 'center', inline: 'center' });
  }

  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  async function highlightSource(file, row) {
    if (file.type === 'pdf') {
      await ensurePdfAnchors(file);
      const anchor = file._pdfAnchors?.get(row.row_id);
      if (anchor && anchor.page !== file._reviewPage) {
        await renderPdfPageInto(file, anchor.page);
      } else {
        outlineIfCurrentPage(file, row);
      }
    } else {
      $('#source-csv-grid').querySelectorAll('tr').forEach((tr) => {
        tr.classList.toggle('src-selected', tr.dataset.sourceLine === String(row.source_line));
      });
      const target = $(`#source-csv-grid tr[data-source-line="${row.source_line}"]`);
      target?.scrollIntoView({ block: 'center' });
    }
  }

  // --- Extracted-transactions table (item 3: date-first, data-driven columns) --

  /** Which optional columns have at least one row with a value, for this file. */
  function visibleColumns(file) {
    const rows = file.rows.filter((r) => !r.skipped);
    const has = (pick) => rows.some((r) => { const v = pick(r); return v !== null && v !== undefined && v !== ''; });
    const extraFields = new Set();
    for (const r of rows) {
      for (const key of Object.keys(r)) {
        if (key.startsWith('extra_') && key !== CAPTION_EXTRA_FIELD) extraFields.add(key);
      }
    }
    return {
      balance: has((r) => r.balance),
      account: has((r) => r.account_label),
      reference: has((r) => r.reference),
      extras: [...extraFields].filter((f) => has((r) => r[f])),
    };
  }

  function extraLabel(field) {
    return field.replace(/^extra_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Findings 4/5 (coordinator round 2): the fixed per-column px widths that
  // never truncate (workspace.css's #review-table rules) plus Description's
  // own 220px floor - kept here as the one source of truth so the CSS and
  // this sum can't drift apart. table-layout:fixed doesn't honour a
  // width:auto column's own min-width (verified empirically: it just
  // shrinks the column instead of ever growing the table), so this total is
  // applied to the TABLE's min-width instead, which fixed layout DOES
  // honour - forcing a real horizontal scrollbar (via .grid-scroll's
  // existing overflow:auto) rather than ever truncating a value when even
  // the stacked/full-width table pane is narrower than this sum.
  const COL_W = { date: 90, amount: 120, mid: 130, actions: 185, descMin: 220 };

  function renderExtractedTable(file) {
    const nonSkipped = file.rows.filter((r) => !r.skipped);
    const visible = warningsFilter ? nonSkipped.filter((r) => hasWarningFlag(r)) : nonSkipped;
    $('#extracted-count').textContent = `${nonSkipped.filter((r) => !r.excluded).length} rows${warningsFilter ? ` (${visible.length} need a look)` : ''}`;

    const cols = visibleColumns(file);
    const headers = ['Date', 'Description', 'Amount'];
    if (cols.balance) headers.push('Balance');
    if (cols.account) headers.push('Account');
    if (cols.reference) headers.push('Reference');
    for (const f of cols.extras) headers.push(extraLabel(f));
    const thead = $('#review-thead');
    // axe's empty-table-header rule flags a bare <th></th> - the actions
    // column has no visible heading by design (Section B's finding), so give
    // it a screen-reader-only label instead of leaving the cell empty.
    if (thead) {
      thead.innerHTML = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}<th><span class="sr-only">Row actions</span></th></tr>`;
    }

    const midCount = (cols.balance ? 1 : 0) + (cols.account ? 1 : 0) + (cols.reference ? 1 : 0) + cols.extras.length;
    const table = $('#review-table');
    // +40, not +8: collapsed cell borders and sub-pixel layout rounding
    // otherwise ate enough of the leftover that Description measured a few
    // px under its 220px floor in practice - this slop keeps a real margin
    // above the floor instead of landing exactly on (or just under) it.
    const minTableW = COL_W.date + COL_W.amount + midCount * COL_W.mid + COL_W.actions + COL_W.descMin + 40;
    if (table) table.style.minWidth = `${minTableW}px`;
    // The table's own pane needs this same min-width so, in side-by-side
    // mode, flexbox never squeezes it smaller than its columns need -
    // that's what CSS's 45%/55% split (workspace.css's .split .pane rules)
    // is a PREFERENCE for, not a guarantee on its own.
    const tablePane = table?.closest('.pane');
    if (tablePane) tablePane.style.minWidth = `${minTableW}px`;

    const tbody = $('#review-table tbody');
    tbody.innerHTML = '';
    // Item 6a: the Warnings filter must never just show an empty table - a
    // clear "resolved" row takes its place instead of leaving it blank.
    if (warningsFilter && !visible.length && nonSkipped.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${headers.length + 1}" class="all-resolved-row">Nothing left to check in this statement.</td>`;
      tbody.appendChild(tr);
    } else {
      for (const row of visible) {
        tbody.appendChild(row.row_id === editingRowId ? buildEditRow(row, cols) : buildDisplayRow(row, cols));
      }
    }
    updateSplitLayout(minTableW);
  }

  // Coordinator round 3: the source pane must never render illegibly narrow
  // (~240px made the PDF page unreadable and wrapped its own toolbar), so
  // side-by-side is only allowed when the pane can have its full 440px floor
  // AND the table still gets its own min-width after that - not just "the
  // total happens to add up" (round 2's bug: an even 50/50 split still
  // squeezed one side even when the sum fit). A quiet toggle lets the user
  // force either mode; even a forced 'side-by-side' still falls back to
  // stacked if the two truly don't fit (a forced layout that clips data
  // would just recreate findings 4/5).
  const SOURCE_PANE_MIN = 440;
  const SPLIT_GAP = 16;
  function updateSplitLayout(minTableW) {
    const split = $('#review-split');
    const table = $('#review-table');
    if (!split || !table) return;
    const w = minTableW ?? (parseFloat(table.style.minWidth) || 0);
    const available = split.clientWidth;
    const fitsSideBySide = available > 0 && (available - SPLIT_GAP - SOURCE_PANE_MIN) >= w;
    const stacked = layoutOverride === 'stacked' ? true : !fitsSideBySide;
    split.classList.toggle('stacked', stacked);
    renderLayoutToggle(stacked, fitsSideBySide);
  }

  /** The quiet "Side by side / Stacked" toggle - shows which mode is in effect, lets the user force either one (remembered in preferences), and disables "Side by side" outright once it really wouldn't fit. */
  function renderLayoutToggle(stacked, fitsSideBySide) {
    const sideBtn = $('#review-layout-side');
    const stackBtn = $('#review-layout-stacked');
    if (!sideBtn || !stackBtn) return;
    sideBtn.classList.toggle('active', !stacked);
    stackBtn.classList.toggle('active', !!stacked);
    sideBtn.disabled = fitsSideBySide === false;
    sideBtn.title = sideBtn.disabled ? "Too narrow for side by side right now" : 'Show source and table side by side';
  }

  async function setLayoutOverride(value) {
    layoutOverride = value;
    const prefs = (await storage?.get(SETTINGS_KEY)) || {};
    await storage?.set(SETTINGS_KEY, { ...prefs, reviewLayout: value });
    updateSplitLayout();
  }

  function actionButtons(row) {
    const parts = [];
    if (hasWarningFlag(row) && !hasUnresolvableFlag(row)) parts.push('<button type="button" class="primary" data-act="confirm">Looks right</button>');
    parts.push('<button type="button" data-act="edit">Edit</button>');
    // Item 1: a row with a suggested alt amount (normalize.js's OCR
    // no-decimal safety net) gets a one-click "Use $X" action next to Edit.
    if (row.low_confidence_hint && row.amount_alt != null) {
      parts.push(`<button type="button" data-act="use-alt">Use ${escapeHtml(formatMinorDisplay(row.amount_alt, row.currency))}</button>`);
    }
    parts.push(row.excluded
      ? '<button type="button" data-act="restore">Restore</button>'
      : '<button type="button" data-act="exclude">Exclude</button>');
    // Item 3: a resolved row keeps its own Undo link for the rest of the
    // session, independent of the 8s inline bar.
    if (row._undo?.length) parts.push('<button type="button" data-act="undo">Undo</button>');
    return parts.join('');
  }

  function buildDisplayRow(row, cols) {
    const tr = document.createElement('tr');
    tr.dataset.rowId = row.row_id;
    const classes = [];
    if (row.row_id === selectedRowId) classes.push('selected');
    if (hasWarningFlag(row)) classes.push('warn');
    if (row.excluded) classes.push('excluded');
    if (row.edited) classes.push('edited');
    tr.className = classes.join(' ');

    const amountCls = row.amount == null ? '' : row.amount >= 0 ? 'amount-in' : 'amount-out';
    const amountStr = `${formatMinorDisplay(row.amount, row.currency)}${row.currency ? ` ${row.currency}` : ''}`;
    // Info-only flags (e.g. 'ocr') are provenance, not a per-row warning -
    // showing "Read by text recognition" under every single OCR'd row is
    // pure noise once it's already said once in the summary bar; only a
    // real warning flag earns a row-tag caption here.
    const tags = (row.flags || []).filter((f) => !HIDDEN_ROW_TAGS.has(f)).map((f) => rowFlagLabel(f, row)).filter(Boolean);
    const caption = row[CAPTION_EXTRA_FIELD];
    // Findings 4/5: description is the only flexible column (workspace.css's
    // table-layout:fixed rules for #review-table), so a long one is
    // ellipsised here - the title attribute is the "full text on hover"
    // half of the fix, not just a decoration.
    const descRaw = row.description_raw || '';
    // A flex row (not a bare inline-block span) so the ellipsis actually has
    // a definite width to shrink against inside a table-layout:fixed cell -
    // an inline-block child with max-width:100% collapsed to 0 width instead
    // of ellipsising, in a narrow column, because "auto" width plus a
    // percentage max-width has no content-box basis to shrink from in that
    // context. min-width:0 on the flex child is what lets it actually shrink
    // below its text's natural width instead of overflowing the row.
    const descHtml = `<div class="desc-row">${hasWarningFlag(row) ? '<span class="flag-dot"></span>' : ''}<span class="desc-text" title="${escapeHtml(descRaw)}">${escapeHtml(descRaw)}</span></div>`;

    const cells = [
      `<td>${row.date ?? escapeHtml(row.date_raw || '')}</td>`,
      `<td>${descHtml}${caption ? `<span class="row-caption">${escapeHtml(caption)}</span>` : ''}${tags.length ? `<span class="row-tag">${escapeHtml(tags.join('; '))}</span>` : ''}</td>`,
      `<td class="num ${amountCls}">${amountStr}</td>`,
    ];
    if (cols.balance) cells.push(`<td class="num">${formatMinorDisplay(row.balance, row.currency)}</td>`);
    if (cols.account) cells.push(`<td>${escapeHtml(row.account_label || '')}</td>`);
    if (cols.reference) cells.push(`<td>${escapeHtml(row.reference || '')}</td>`);
    for (const f of cols.extras) cells.push(`<td>${escapeHtml(row[f] || '')}</td>`);
    cells.push(`<td class="cell-actions"><div class="row-actions">${actionButtons(row)}</div></td>`);
    tr.innerHTML = cells.join('');
    return tr;
  }

  function buildEditRow(row, cols) {
    const tr = document.createElement('tr');
    tr.dataset.rowId = row.row_id;
    tr.className = 'editing';
    const decimals = decimalsFor(row.currency);
    // Item 2: pre-fill with the suggested amount_alt when present, not the
    // flagged (likely wrong) amount - see wizard.js's same prefillAmount note.
    const prefillAmount = row.amount_alt != null ? row.amount_alt : row.amount;
    const amountVal = prefillAmount == null ? '' : (prefillAmount / Math.pow(10, decimals)).toFixed(decimals);
    const cells = [
      `<td><input class="edit-date" value="${escapeHtml(row.date ?? row.date_raw ?? '')}" placeholder="YYYY-MM-DD" aria-label="Date"></td>`,
      `<td><input class="edit-desc" value="${escapeHtml(row.description_raw || '')}" aria-label="Description"></td>`,
      `<td class="num"><input class="edit-amount" value="${escapeHtml(amountVal)}" aria-label="Amount"></td>`,
    ];
    const blanks = (cols.balance ? 1 : 0) + (cols.account ? 1 : 0) + (cols.reference ? 1 : 0) + cols.extras.length;
    for (let i = 0; i < blanks; i++) cells.push('<td></td>');
    cells.push('<td class="cell-actions"><div class="row-actions"><button type="button" data-act="save">Save</button><button type="button" data-act="cancel">Cancel</button></div></td>');
    tr.innerHTML = cells.join('');
    return tr;
  }

  function updateFile(file, nextRows, opts = {}) {
    file.rows = nextRows;
    const list = files();
    renderExtractedTable(file);
    renderSummary(file, list);
    renderSkippedGroup(file);
    renderConfirmAllButton(file);
    renderWarningsChip(file);
    renderCompletion(file, list, opts); // item 3/6: e.g. the last warning on this file just got resolved
    renderFooterActions(list);
    persist?.();
  }

  function warningNavState(file) {
    const flagged = file.rows.filter((r) => !r.skipped && hasWarningFlag(r));
    const curIdx = flagged.findIndex((r) => r.row_id === selectedRowId);
    return { flagged, curIdx };
  }

  /** Item 2: Next/Previous warning buttons + N/P keys, both wrap around. */
  function nextWarning() {
    const file = files()[activeIdx];
    if (!file) return;
    const { flagged, curIdx } = warningNavState(file);
    if (!flagged.length) return;
    const idx = nextUnresolvedAfter(flagged, curIdx);
    selectRow(file, flagged[idx], { announceText: `Quick look ${idx + 1} of ${flagged.length}` });
  }
  function prevWarning() {
    const file = files()[activeIdx];
    if (!file) return;
    const { flagged, curIdx } = warningNavState(file);
    if (!flagged.length) return;
    const idx = prevUnresolvedBefore(flagged, curIdx === -1 ? 0 : curIdx);
    selectRow(file, flagged[idx], { announceText: `Quick look ${idx + 1} of ${flagged.length}` });
  }

  // Item 3: "Marked as ..." wording shared by the 8s undo bar and the
  // screen-reader announcement for each resolve action.
  const RESOLVE_LABELS = { confirm: 'Marked as looks right.', exclude: 'Marked as excluded.', 'use-alt': 'Amount updated.', edit: 'Edit saved.' };

  let undoBarTimer = null;
  function showUndoBar(rowId, label) {
    const bar = $('#review-undo-bar');
    const text = $('#review-undo-bar-text');
    if (!bar || !text) return;
    clearTimeout(undoBarTimer);
    text.textContent = `${label} `;
    bar.hidden = false;
    bar.dataset.rowId = rowId;
    undoBarTimer = setTimeout(() => { bar.hidden = true; }, 8000);
  }
  function hideUndoBar() {
    clearTimeout(undoBarTimer);
    const bar = $('#review-undo-bar');
    if (bar) bar.hidden = true;
  }

  /**
   * Item 3/4: apply a resolve action (Looks right/Use alt/Edit saved/
   * Exclude) to `row`, then auto-advance the selection to the next
   * unresolved warning after the resolved row's own position, wrapping -
   * always, regardless of whether the Warnings filter is on. Moves both
   * panes via selectRow.
   */
  function resolveWarning(file, row, act, resolver) {
    const flaggedBefore = file.rows.filter((r) => !r.skipped && hasWarningFlag(r));
    const resolvedIdx = flaggedBefore.findIndex((r) => r.row_id === row.row_id);
    const next = file.rows.map((r) => (r.row_id === row.row_id ? resolver(r) : r));
    file._resolvedCount = (file._resolvedCount || 0) + 1;
    updateFile(file, next, { justResolved: true });
    const label = RESOLVE_LABELS[act] || 'Resolved.';
    showUndoBar(row.row_id, label);
    const remaining = next.filter((r) => !r.skipped && hasWarningFlag(r));
    if (resolvedIdx !== -1 && remaining.length) {
      const targetIdx = nextUnresolvedAfter(remaining, resolvedIdx - 1);
      selectRow(file, remaining[targetIdx], { announceText: `${label} Quick look ${targetIdx + 1} of ${remaining.length}: ${describeRow(remaining[targetIdx])}` });
    } else {
      announce(remaining.length ? label : `${label} Nothing left to check in this file.`);
    }
  }

  /** Item 3: Undo (the 8s bar, or a resolved row's own persistent link) - restores the row's exact prior state and reselects it. */
  function performUndo(file, rowId) {
    const next = file.rows.map((r) => (r.row_id === rowId ? undoRow(r) : r));
    updateFile(file, next);
    hideUndoBar();
    const restored = next.find((r) => r.row_id === rowId);
    if (restored) selectRow(file, restored, { announceText: `Undone. ${describeRow(restored)}` });
  }

  function wire() {
    // Stacked-layout collapse toggle - CSS only shows this button while
    // #review-split carries the .stacked class (updateSplitLayout), so it
    // only ever does anything once actually stacked.
    $('#source-pane-collapse')?.addEventListener('click', () => {
      const pane = $('#source-pane');
      if (!pane) return;
      const collapsed = pane.classList.toggle('pane-collapsed');
      const label = collapsed ? 'Expand the source pane' : 'Collapse the source pane';
      $('#source-pane-collapse').title = label;
      $('#source-pane-collapse').setAttribute('aria-label', label);
    });

    // Quiet Side-by-side/Stacked override (coordinator round 3) - remembered
    // in preferences; updateSplitLayout still forces stacked regardless if
    // the two panes really don't fit, even with 'side-by-side' chosen.
    $('#review-layout-side')?.addEventListener('click', () => setLayoutOverride('side-by-side'));
    $('#review-layout-stacked')?.addEventListener('click', () => setLayoutOverride('stacked'));

    $('#review-warnings-filter').addEventListener('click', () => {
      warningsFilter = !warningsFilter;
      $('#review-warnings-filter').classList.toggle('active', warningsFilter);
      const file = files()[activeIdx];
      if (!file) return;
      // Item 1/2: turning the filter on puts a warning in focus right away
      // (unless one's already selected) so the position indicator/highlight
      // aren't blank the moment you enable it.
      const flagged = file.rows.filter((r) => !r.skipped && hasWarningFlag(r));
      if (warningsFilter && flagged.length && !flagged.some((r) => r.row_id === selectedRowId)) {
        selectRow(file, flagged[0]);
        return;
      }
      renderExtractedTable(file);
      renderWarningsChip(file);
    });

    $('#review-next-warning').addEventListener('click', nextWarning);
    $('#review-prev-warning')?.addEventListener('click', prevWarning);

    // Item 1: Up/Down moves the selected row (within whatever the Warnings
    // filter currently shows) and the source pane follows it - same jump/
    // outline path a click uses, via row.original.source_page/source_y.
    // Item 2: N/Shift+N/P move to the next/previous warning, wrapping.
    document.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      const body = $('#review-body');
      if (!body || body.hidden) return;
      const file = files()[activeIdx];
      if (!file || editingRowId) return;

      const key = e.key.toLowerCase();
      if (key === 'n' || key === 'p') {
        e.preventDefault();
        if (key === 'p' || e.shiftKey) prevWarning(); else nextWarning();
        return;
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const nonSkipped = file.rows.filter((r) => !r.skipped);
      const visible = warningsFilter ? nonSkipped.filter(hasWarningFlag) : nonSkipped;
      if (!visible.length) return;
      e.preventDefault();
      const curIdx = visible.findIndex((r) => r.row_id === selectedRowId);
      const nextIdx = curIdx === -1 ? 0
        : e.key === 'ArrowDown' ? Math.min(visible.length - 1, curIdx + 1)
        : Math.max(0, curIdx - 1);
      selectRow(file, visible[nextIdx]);
    });

    // Item 3/6: completion panel (per-file done, other statements still need
    // review) + persistent footer actions.
    $('#review-complete-primary')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.action === 'next') jumpToFileWarnings(Number(btn.dataset.targetIdx));
      else goHome('Export');
    });
    $('#review-complete-secondary')?.addEventListener('click', () => cancelCompletionCountdown());
    $('#review-footer-next')?.addEventListener('click', (e) => jumpToFileWarnings(Number(e.currentTarget.dataset.targetIdx)));
    $('#review-footer-export')?.addEventListener('click', () => goHome('Export'));
    $('#review-footer-add')?.addEventListener('click', () => goHome('Add a statement'));

    // Item 6c: all-statements-done state (replaces both panes).
    $('#review-all-done-home')?.addEventListener('click', () => {
      goHome('Back to Home to copy');
      requestAnimationFrame(() => {
        const panel = document.getElementById('export-panel');
        if (panel && !panel.hidden) {
          panel.setAttribute('tabindex', '-1');
          panel.scrollIntoView({ block: 'start' });
          panel.focus();
        }
      });
    });
    $('#review-all-done-add')?.addEventListener('click', () => goHome('Add a statement'));
    $('#review-all-done-reselect')?.addEventListener('change', (e) => {
      const idx = Number(e.target.value);
      const list = files();
      if (!Number.isInteger(idx) || !list[idx]) return;
      activeIdx = idx;
      editingRowId = null;
      warningsFilter = false;
      e.target.value = '';
      render();
    });

    // Item 3: the 8s inline undo bar.
    $('#review-undo-bar-btn')?.addEventListener('click', () => {
      const file = files()[activeIdx];
      const rowId = $('#review-undo-bar')?.dataset.rowId;
      if (file && rowId) performUndo(file, rowId);
    });

    $('#review-confirm-all-btn')?.addEventListener('click', () => {
      const file = files()[activeIdx];
      if (!file) return;
      const next = confirmAllLowConfidence(file.rows);
      updateFile(file, next);
      log('review', 'confirmed all low-confidence rows', { sourceFile: file.name });
    });

    // Prev/Next page + zoom (item 4).
    $('#pdf-prev-page')?.addEventListener('click', () => {
      const file = files()[activeIdx];
      if (file) renderPdfPageInto(file, (file._reviewPage || 1) - 1);
    });
    $('#pdf-next-page')?.addEventListener('click', () => {
      const file = files()[activeIdx];
      if (file) renderPdfPageInto(file, (file._reviewPage || 1) + 1);
    });
    $('#pdf-zoom-in')?.addEventListener('click', () => {
      const file = files()[activeIdx];
      if (!file) return;
      file._reviewZoom = Math.min(3, (file._reviewZoom || 1) + 0.25);
      renderPdfPageInto(file, file._reviewPage || 1);
    });
    $('#pdf-zoom-out')?.addEventListener('click', () => {
      const file = files()[activeIdx];
      if (!file) return;
      file._reviewZoom = Math.max(0.5, (file._reviewZoom || 1) - 0.25);
      renderPdfPageInto(file, file._reviewPage || 1);
    });
    // Re-fit on resize: a fixed render scale is exactly the bug item 4 reports.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const body = $('#review-body');
        if (!body || body.hidden) return;
        const file = files()[activeIdx];
        if (file?.type === 'pdf') renderPdfPageInto(file, file._reviewPage || 1);
        updateSplitLayout(); // Findings 4/5: side-by-side vs. stacked depends on available width too
      }, 150);
    });

    $('#review-skipped-group').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-treat-row-id]');
      if (!btn) return;
      const file = files()[activeIdx];
      if (!file) return;
      const next = file.rows.map((r) => (r.row_id === btn.dataset.treatRowId ? treatAsTransaction(r) : r));
      updateFile(file, next);
      log('review', 'skipped line treated as transaction', { sourceFile: file.name, rowId: btn.dataset.treatRowId });
    });

    $('#review-summary').addEventListener('click', (e) => {
      if (e.target.closest('#review-update-mapping-hint') || e.target.closest('#review-update-mapping-from-count')) {
        e.preventDefault();
        const file = files()[activeIdx];
        if (file) onUpdateMapping?.(file);
        return;
      }
      const link = e.target.closest('.balance-mismatch-link');
      if (!link) return;
      const file = files()[activeIdx];
      const row = file?.rows.find((r) => r.row_id === link.dataset.rowId);
      if (!row) return;
      selectedRowId = row.row_id;
      renderExtractedTable(file);
      highlightSource(file, row);
      $(`#review-table tr[data-row-id="${row.row_id}"]`)?.scrollIntoView({ block: 'center' });
    });

    $('#review-table').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-row-id]');
      if (!tr) return;
      const file = files()[activeIdx];
      const row = file.rows.find((r) => r.row_id === tr.dataset.rowId);
      if (!row) return;

      const actBtn = e.target.closest('button[data-act]');
      if (actBtn) {
        const act = actBtn.dataset.act;
        if (act === 'edit') { editingRowId = row.row_id; renderExtractedTable(file); return; }
        if (act === 'cancel') { editingRowId = null; renderExtractedTable(file); return; }
        if (act === 'save') {
          const decimals = decimalsFor(row.currency);
          const amountRaw = tr.querySelector('.edit-amount').value.trim();
          const fields = {
            date: tr.querySelector('.edit-date').value.trim() || null,
            description_raw: tr.querySelector('.edit-desc').value.trim(),
            amount: amountRaw === '' ? null : Math.round(Number(amountRaw) * Math.pow(10, decimals)),
          };
          editingRowId = null;
          // Item 3/4: saving an edit on a currently-flagged row counts as
          // resolving it too (a human just corrected it by hand) - undo bar,
          // per-row Undo, and auto-advance all apply the same as "Looks right".
          if (hasWarningFlag(row)) resolveWarning(file, row, 'edit', (r) => resolveEdit(r, fields));
          else updateFile(file, file.rows.map((r) => (r.row_id === row.row_id ? editRow(r, fields) : r)));
          return;
        }
        if (act === 'undo') { performUndo(file, row.row_id); return; }
        const RESOLVERS = { confirm: resolveConfirm, exclude: resolveExclude, 'use-alt': resolveUseAlt };
        if (RESOLVERS[act]) { resolveWarning(file, row, act, RESOLVERS[act]); return; }
        if (act === 'restore') {
          updateFile(file, file.rows.map((r) => (r.row_id === row.row_id ? restoreRow(r) : r)));
        }
        return;
      }

      if (editingRowId) return; // ignore row-select clicks while a row is mid-edit
      selectRow(file, row);
    });

    $('#source-csv-grid').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-source-line]');
      if (!tr) return;
      const file = files()[activeIdx];
      const row = file.rows.find((r) => String(r.source_line) === tr.dataset.sourceLine);
      if (!row) return;
      selectedRowId = row.row_id;
      renderExtractedTable(file);
      highlightSource(file, row);
      $(`#review-table tr[data-row-id="${row.row_id}"]`)?.scrollIntoView({ block: 'center' });
    });

    $('#add-row-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const file = files()[activeIdx];
      if (!file) return;
      const form = e.target;
      const amountRaw = form.amount.value.trim();
      const fields = {
        date: form.date.value.trim() || null,
        description_raw: form.description_raw.value.trim(),
        amount: amountRaw ? Math.round(Number(amountRaw) * Math.pow(10, decimalsFor(file.rows[0]?.currency))) : null,
        currency: file.rows[0]?.currency ?? null,
        account_label: file.rows[0]?.account_label ?? null,
        source_file: file.name,
      };
      const next = addMissingRow(file.rows, selectedRowId, fields);
      updateFile(file, next);
      form.reset();
    });
  }

  return { render, wire, showFile };
}
