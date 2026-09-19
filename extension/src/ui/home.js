// Home (fast path) screen, per FASTPATH.md: drop zone -> file rows with live
// progress -> attention cards -> "Ready to copy" export panel with an inline
// Change drawer. The full process (mapping, checks, presets, currency, date
// range) happens once per statement type; every later month is drop, wait,
// copy. Pure decision logic (file status, attention cards, export
// eligibility, since-last-export) lives in core/home-state.js and is unit
// tested there; this file is DOM wiring + orchestration only.

import { detectFileType, detectEncoding, decodeText, detectDelimiter, hasTransactionLikeRow, countTransactionLikeRows } from '../core/detect.js';
import { parseGrid } from '../core/csv.js';
import { loadPdfPages, groupItemsIntoLines, lineText, INCORRECT_PASSWORD } from '../core/pdf.js';
import { buildFileRows } from '../core/pipeline.js';
import { ocrDocument } from '../core/ocr.js';
import { suggestHeaderRow } from '../core/suggest.js';
import { loadProfiles, matchProfile, learnSignatures, pdfAnchorCandidates, updateVersionLastUsed, guessProfileByFilename, setProfilePasswordHint } from '../core/profiles.js';
import { resolvePreset, filterByRange, coverageWarnings, formatShortDate } from '../core/daterange.js';
import { buildCsv, buildTsv, DEFAULT_PRESET, DEFAULT_PRESET_MODE_B, isDefaultPresetColumns, suggestFilename, LAYOUT_PRESETS } from '../core/export.js';
import { checkFileSize, checkBatchSize } from '../core/limits.js';
import { fileSummary, countCheckGrouped, groupedCountLabel, rowFlagLabel } from '../core/checks.js';
import { mergeAcrossFiles, fingerprint, isExactDuplicateFile, sha256Hex, findDuplicateByHash } from '../core/dedupe.js';
import { detectCurrency, convertToTarget, formatBothDirections } from '../core/currency.js';
import { saveSession, sessionsNearingDeletion } from '../core/sessions.js';
import { renderPresetEditor as renderPresetEditorInto, newPreset, applyLayoutPreset, matchLayoutKey, resolveWorkingPreset } from './preset-editor.js';
import { renderRowSnippet } from './pdf-render.js';
import { resolveConfirm, resolveEdit } from './rowedit.js';
import { parseAmount, decimalsFor } from '../core/amount.js';
import { log, error as logError, asText as debugLogText } from '../core/debuglog.js';
import {
  fileStatus, maskAccountNumber, defaultAccountLabel, healthBadge, attentionCards, exportReadiness, sinceLastExportRange,
  HIGH_CONFIDENCE, accountsSummaryLabel, mergedRowsCaption, dateRangeOfRows, duplicateDroppedCaption,
  notIncludedLabel, sourceIncluded, sourceRangeCountLabel, sourcesSummarySegment, removeFileAt, restoreFileAt,
  matchExtractionFailed, selectMatchCandidate, candidateLossCaption, summarizeExtraction, flaggedDecisionRows,
  resultHeadlineLabel, warningRowCount, ocrTimeEstimateLabel, ocrPartialCaption,
} from '../core/home-state.js';
import { announce, closeGearMenu } from './nav.js';

// ponytail: a literal `"` inside a /regex/ desyncs test/banned_words.test.js's
// naive quote-tracking scanner (it can't tell a regex from a string), so the
// closing-quote escape uses a plain string replaceAll instead of a third
// /"/g regex - functionally identical, just scanner-friendly.
function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replaceAll('"', '&quot;'); }

const $ = (sel) => document.querySelector(sel);
const SESSION_ID = 'current';
const SETTINGS_KEY = 'settings';
const RATES_KEY = 'rates';
const LAST_EXPORTED_KEY = 'lastExported';

export function createHome({ storage, state, sessionStore, onOpenWizard, onReviewFile, onFilesChanged, onShowHow, onFocusProfile, onOpenReport }) {
  // Ephemeral UI state, not shared with app.js (home.js owns the whole fast path).
  let currencyMode = 'A'; // 'A' keep original, 'B' convert to a target
  let targetCurrency = 'SGD';
  let rates = {}; // pairKey -> flat rate (number), or {"YYYY-MM": rate} when rateMode is 'perMonth'
  let rateMode = 'flat'; // 'flat' one rate for all months, 'perMonth' D4
  let dateField = 'date';
  let customRange = null; // { startISO, endISO } when rangePreset === 'custom'
  // Item 7: the six built-in layouts, each already shaped as a full preset
  // (dateFormat/signConvention/headerRow included) - "Start from" in Settings
  // indexes into this same list. No user-named saved presets any more.
  const presets = LAYOUT_PRESETS.map((l) => applyLayoutPreset(newPreset(l.name), l.key));
  let activePreset = DEFAULT_PRESET; // item 6/7: the persisted "Last used" working set (layout + customisation) once loadPrefs() runs
  let includeSourceColumns = false;
  let drawerOpen = false;
  let dedupeNotice = null; // { removed: [], accountLabel } for the merged/Undo card
  let restorePending = false;
  let profilesCache = []; // for the preset editor's extra_* column discovery; refreshed on drawer open
  // Item 12: whether "Use a statement type I already set up" has anywhere
  // useful to go. loadProfiles() always includes the app's own seeded
  // built-in bank profiles (Meridian, Northwind, ...) even before a user has
  // ever saved one themselves - "I already set up" means the user's own, so
  // built-ins (id starts with "builtin-") don't count. Always 0 for a
  // first-time user with no saved statement type of their own.
  let savedProfileCount = 0;
  async function refreshSavedProfileCount() {
    const profiles = await loadProfiles(storage).catch(() => []);
    savedProfileCount = profiles.filter((p) => !p.id?.startsWith('builtin-')).length;
    renderAttentionCards();
  }
  let lastExportCompositionKey = null; // dedupes the "export composition" debug log line (see renderExportPanel)

  // --- Worker (CSV/XLSX parse off the main thread; item 4) -----------------
  // ponytail: worker.js's 'csv'/'xlsx' kinds re-parse the file themselves
  // rather than taking an already-parsed grid, so applying a match re-parses
  // once more than the main-thread path needed to (the initial grid parse for
  // matching still runs on the main thread, since matching happens before a
  // profile/version is known). Upgrade path: a worker message kind that
  // accepts a pre-parsed grid, if large-file re-parse cost ever measurably
  // matters.
  let worker = null;
  let workerUnavailable = false;
  let workerUnavailableReason = null;
  let jobSeq = 0;
  const pendingJobs = new Map(); // jobId -> { resolve, reject }

  function getWorker() {
    if (worker || workerUnavailable) return worker;
    try {
      worker = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => handleWorkerMessage(e.data);
      worker.onerror = (e) => {
        log('home.worker', 'worker errored, falling back to main-thread parsing', { message: e.message });
        workerUnavailable = true;
        workerUnavailableReason = e.message;
        worker = null;
      };
    } catch (err) {
      workerUnavailable = true;
      workerUnavailableReason = err.message;
      log('home.worker', 'worker unavailable in this environment, falling back to main-thread parsing', { message: err.message });
      worker = null;
    }
    return worker;
  }

  function handleWorkerMessage(msg) {
    const job = pendingJobs.get(msg.jobId);
    if (!job) return;
    if (msg.type === 'progress') {
      job.onProgress?.(msg.done, msg.total);
    } else if (msg.type === 'result') {
      pendingJobs.delete(msg.jobId);
      job.resolve(msg.rows);
    } else if (msg.type === 'error') {
      pendingJobs.delete(msg.jobId);
      job.reject(new Error(msg.message));
    } else if (msg.type === 'cancelled') {
      pendingJobs.delete(msg.jobId);
      job.reject(new Error('cancelled'));
    }
  }

  // Parses CSV/XLSX in the worker using today's { type:'parse', kind } protocol
  // (worker.js exposes 'csv', 'xlsx' and 'pdf'). Resolves null (no throw) when
  // no worker is available, so callers fall back to the identical main-thread
  // path and log why.
  function parseInWorker(entry, kind, version, meta, onProgress) {
    const w = getWorker();
    if (!w) return Promise.resolve(null);
    const jobId = ++jobSeq;
    entry.workerJobId = jobId;
    return new Promise((resolve, reject) => {
      pendingJobs.set(jobId, { resolve, reject, onProgress });
      try {
        const payload = { type: 'parse', jobId, kind, version, meta };
        if (kind === 'csv') payload.text = entry.text; else payload.bytes = entry.bytes;
        w.postMessage(payload);
      } catch (err) {
        pendingJobs.delete(jobId);
        reject(err);
      }
    });
  }

  // --- Persistence -------------------------------------------------------

  async function loadPrefs() {
    const prefs = (await storage.get(SETTINGS_KEY)) || {};
    state.rangePreset = prefs.defaultRange || state.rangePreset || 'all';
    currencyMode = prefs.homeCurrencyMode || 'A';
    targetCurrency = prefs.homeCurrency || 'SGD';
    rateMode = prefs.homeRateMode || 'flat';
    rates = (await storage.get(RATES_KEY)) || {};
    // Item 6/7: the drawer's working set (layout + customisation) persists
    // as-is across sessions ("Last used") - no "Save as preset" needed for an
    // edit to stick. With nothing persisted yet, prefs.defaultPreset is the
    // "Start from" preference (an index into the six layouts in `presets`,
    // or null/missing for "Last used", which - having nothing to resume -
    // also just means presets[0], "Simple").
    activePreset = resolveWorkingPreset(prefs.workingPreset, presets, prefs.defaultPreset);
  }

  async function saveLastUsedPrefs() {
    const prefs = (await storage.get(SETTINGS_KEY)) || {};
    await storage.set(SETTINGS_KEY, {
      ...prefs,
      defaultRange: state.rangePreset,
      homeCurrencyMode: currencyMode,
      homeCurrency: targetCurrency,
      homeRateMode: rateMode,
      workingPreset: activePreset,
    });
  }

  // Item 9: round a persisted OCR item's geometry/confidence to the
  // precision anything downstream actually reads (review/wizard's overlay
  // draws boxes, nothing needs sub-hundredth-point placement or a
  // 15-significant-digit Tesseract confidence) - a raw float like
  // 96.3555908203125 costs far more JSON bytes than 96.4 for no real gain.
  function compactOcrItems(items) {
    return (items || []).map((it) => ({
      str: it.str,
      x: Math.round(it.x * 100) / 100,
      y: Math.round(it.y * 100) / 100,
      width: Math.round(it.width * 100) / 100,
      height: Math.round(it.height * 100) / 100,
      confidence: Math.round((it.confidence ?? 0) * 10) / 10,
    }));
  }

  function serializableFiles() {
    // Sessions autosave rows + identity, not the raw bytes/grid (large, and
    // only needed transiently to run the parse / wizard against). OCR items
    // (item 4, per-file OCR cache) are the one exception worth the size: they
    // are the expensive-to-recompute result (a Tesseract pass per page), are
    // plain JSON (unlike a <canvas>, which isn't structured-cloneable at
    // all), and without entry.bytes surviving a reload there is nothing to
    // re-run OCR against anyway - caching them just means a same-session
    // screen change (Home -> Wizard -> Home) never repeats the recognition.
    // Item 9: ocrText itself is never read again once matching has happened
    // (review.js/wizard.js only ever read ocrPages[].items) - it is the same
    // text already sitting inside those items' `str` fields, so persisting
    // it a second time was pure duplication, dropped here.
    return state.files.map((f) => ({
      name: f.name, error: f.error, rows: f.rows,
      profile: f.profile ? { id: f.profile.id, name: f.profile.name, bank: f.profile.bank } : null,
      accountLabel: f.accountLabel, maskedAccount: f.maskedAccount,
      warningsDismissed: f.warningsDismissed, currencyResolved: f.currencyResolved,
      includeInExport: f.includeInExport, // item 14a: survives a session reload
      ocr: f.ocr,
      ocrPages: f.ocrPages ? f.ocrPages.map((p) => ({ pageNum: p.pageNum, items: compactOcrItems(p.items), avgConfidence: Math.round((p.avgConfidence ?? 0) * 10) / 10 })) : undefined,
    }));
  }

  async function autosave() {
    if (!sessionStore) return;
    await saveSession(sessionStore, { id: SESSION_ID, files: serializableFiles() }).catch(() => {});
  }

  // --- Drop zone / parsing -------------------------------------------------

  function wireDropzone() {
    const input = $('#file-input');
    input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });
    for (const zone of [$('#dropzone-full'), $('#dropzone')]) {
      zone.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') input.click(); });
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
      });
    }
    for (const btn of [$('#choose-files-btn'), $('#choose-files-btn-slim')]) {
      btn.addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
    }
  }

  async function handleFiles(fileList) {
    const files = [...fileList];
    // Item 5: "Restore your last statements?" is a dead question the moment
    // any new file is dropped - the person has already answered it by
    // acting, so the banner (and the restore-session offer behind it) goes
    // away instead of sitting next to a session it no longer describes.
    if (files.length) {
      restorePending = null;
      const banner = $('#restore-banner');
      if (banner) banner.hidden = true;
    }
    const batchWarnings = checkBatchSize(state.files.length + files.length, 0);
    $('#batch-warning').textContent = batchWarnings.join(' ');
    $('#batch-warning').hidden = !batchWarnings.length;

    for (const file of files) {
      // Item B: hash the raw bytes BEFORE anything else - an exact re-drop of
      // a file already in this session never enters parsing/OCR again (the
      // old check only compared post-parse, too late to skip the work).
      let buf, hash;
      try {
        buf = await file.arrayBuffer();
        hash = await sha256Hex(buf);
      } catch (err) {
        const errEntry = { name: file.name, error: 'This file could not be read.', readError: true };
        state.files.push(errEntry);
        logError('home.parse', err, { file: file.name });
        renderAll(); onFilesChanged?.(); await autosave();
        continue;
      }
      const dup = findDuplicateByHash(state.files, hash);
      if (dup) {
        log('home.drop', 'exact duplicate re-drop ignored before parsing', { file: file.name, existing: dup.name });
        flashDroppedAgain(dup);
        continue;
      }

      const entry = { name: file.name, processing: true, contentHash: hash };
      state.files.push(entry);
      renderAll();

      try {
        log('home.drop', 'file dropped', { name: file.name, size: buf.byteLength });
        const sizeCheck = checkFileSize(buf.byteLength);
        if (!sizeCheck.ok) { entry.processing = false; entry.error = sizeCheck.reason; renderAll(); onFilesChanged?.(); continue; }

        entry.bytes = buf;
        const type = detectFileType(buf);
        entry.type = type;
        log('home.drop', 'file type detected', { name: file.name, type });

        if (type === 'text') {
          const encoding = detectEncoding(buf);
          entry.text = decodeText(buf, encoding);
          entry.delimiter = detectDelimiter(entry.text);
          entry.grid = await parseGrid(entry.text, { delimiter: entry.delimiter });
        } else if (type === 'xlsx' && globalThis.XLSX) {
          const wb = globalThis.XLSX.read(buf, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          entry.grid = globalThis.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
        }

        if (entry.grid) {
          const headerRowGuess = suggestHeaderRow(entry.grid);
          entry.headerRowGuess = headerRowGuess >= 0 ? headerRowGuess : 0;
          // F2 / item f: a file is truly empty only when, after trimming,
          // no line anywhere in it contains both a date-like token and a
          // number - not merely "no non-blank cell after our own header
          // guess", which false-positived a real statement whose header
          // row guess landed in the wrong place. A file with only a header
          // row and no data rows still has no such line, so it still reads
          // as empty (F2).
          const hasDataRow = hasTransactionLikeRow(entry.grid);
          if (!hasDataRow) {
            entry.empty = true;
          } else {
            const preambleText = entry.grid.slice(0, entry.headerRowGuess).flat().join(' ');
            const profiles = await loadProfiles(storage);
            entry.matches = matchProfile({ header: entry.grid[entry.headerRowGuess], preambleText, filename: file.name, fileType: type === 'xlsx' ? 'xlsx' : 'csv' }, profiles);
            entry.accountLabel = maskAccountNumber(preambleText) || file.name;
            log('home.match', 'match result', {
              file: file.name, headerRowGuess: entry.headerRowGuess,
              candidates: entry.matches.map((m) => ({ profile: m.profile.name, confidence: m.confidence, formatChanged: m.formatChanged })),
            });
          }
        } else if (type === 'pdf') {
          // Same matchProfile path CSV/XLSX use, fed from page-1 text instead
          // of a grid: an image-only PDF throws here (no pages to read text
          // from) and is handled below as its own attention card, never a
          // failed match. A password-protected PDF (see the delimited block
          // below) is handled the same way, just with an extra prompt-and-
          // unlock detour before there's any page text to read at all.
          try {
            let pages;
            try {
              pages = await loadPdfPages(buf);
            } catch (err) {
              if (err?.name !== 'PasswordException') throw err;
              // ponytail: this suspends handleFiles' per-file loop until the
              // prompt resolves, so a multi-file drop with a locked PDF in
              // it waits on that one file before starting the next. Upgrade
              // path if a real multi-file drop with a password in the batch
              // ever shows up as an actual complaint: fire unlockEncryptedPdf
              // off and let the loop move on, same pattern enqueueOcr uses.
              pages = await unlockEncryptedPdf(entry, buf, file.name);
            }
            if (pages === 'cancelled') {
              entry.error = 'Password entry cancelled.';
            } else {
              const pageOneText = groupItemsIntoLines(pages[0].items).map(lineText).join(' ');
              entry.pdfPageOneText = pageOneText;
              const profiles = await loadProfiles(storage);
              entry.matches = matchProfile({ pdfText: pageOneText, preambleText: pageOneText, filename: file.name, fileType: 'pdf' }, profiles);
              entry.accountLabel = maskAccountNumber(pageOneText) || file.name;
              log('home.match', 'match result', {
                file: file.name, pdf: true,
                candidates: entry.matches.map((m) => ({ profile: m.profile.name, confidence: m.confidence, formatChanged: m.formatChanged })),
              });
            }
          } catch (err) {
            if (!err.imageOnly) throw err;
            entry.imageOnly = true;
            entry.imageOnlySample = err.sampleText || '';
            log('home.pdf', 'image-only PDF detected at drop, starting on-device text recognition automatically', { file: file.name, totalChars: err.totalChars, pages: err.pageCount });
          }
        } else {
          entry.error = 'Unrecognised file type.';
        }

        entry.processing = false;

        // Fast path: a confident, unchanged match applies itself, no click needed.
        // Item 1: which candidate that is gets decided by extraction quality
        // among near-tied signature scores, not just entry.matches[0].
        if (entry.matches?.length && !entry.matches[0].formatChanged && entry.matches[0].confidence >= HIGH_CONFIDENCE) {
          applyBestMatch(entry, applyMatchToFile); // fire-and-forget; it self-renders/autosaves once parsed
        } else if (entry.imageOnly) {
          // No card, no question: an image-only PDF starts text recognition
          // immediately, or waits its turn (item 7's queue) if another file
          // is already reading - the one shared Tesseract worker can only
          // usefully do one document at a time. enqueueOcr sets
          // entry.processing back to true for the file that actually starts
          // (its own synchronous prefix, before this call returns) so the
          // renderAll() below still shows the right row state either way.
          enqueueOcr(entry); // fire-and-forget; it self-renders/autosaves once done
        }
      } catch (err) {
        entry.processing = false;
        entry.error = 'This file could not be read.';
        entry.readError = true;
        logError('home.parse', err, { file: file.name });
      }

      renderAll();
      onFilesChanged?.();
      await autosave();
    }
  }

  // ===== PASSWORD PROMPT BLOCK (Track 2: password-protected PDFs) - start =====
  // A PDF encrypted with a user password (core/pdf.js's opts.getPassword
  // hook) gets one extra row state, right on the file row, before there is
  // anything to match/OCR against at all. The typed password lives ONLY on
  // entry._pdfPassword - a plain in-memory field, deliberately not one of
  // serializableFiles()'s allowlisted keys, so a session autosave never
  // writes it to storage and it never reaches core/debuglog.js (nothing in
  // this block ever calls log()/error() with the password itself, only with
  // the file name and attempt count). Once known, it's reused for every
  // later re-parse of the same encrypted bytes this session (candidate
  // scoring, Update mapping's grouped-PDF re-read) via loadPdfPagesForEntry.

  /** loadPdfPages, reusing an already-typed password for this entry when one is known - see the block doc comment above. */
  function loadPdfPagesForEntry(entry, extra = {}) {
    const opts = entry._pdfPassword ? { getPassword: () => Promise.resolve(entry._pdfPassword) } : {};
    return loadPdfPages(entry.bytes, { ...opts, ...extra });
  }

  const PW_CANCELLED = 'sb-password-cancelled';

  /**
   * Prompts for a PDF's password right on its file row. core/pdf.js's own
   * onPassword retry loop calls the getPassword hook again (reason ==
   * INCORRECT_PASSWORD) for every wrong entry on the SAME loadPdfPages call,
   * so this one call spans as many tries as the person needs - no re-entrant
   * loadPdfPages call from here. Resolves the decrypted pages array on
   * success, or the string 'cancelled' (never throws for a cancel - that's a
   * normal end state, not a parse failure).
   */
  async function unlockEncryptedPdf(entry, buf, filename) {
    const profiles = await loadProfiles(storage);
    // Best-effort only: there's no header/page text to match against before
    // this file is decrypted, so a filename guess is all a remembered hint
    // can go on (see profiles.js's guessProfileByFilename doc comment).
    const hintProfile = guessProfileByFilename(filename, profiles);
    entry.pwPrompt = { hint: hintProfile?.passwordHint || '', attempts: 0, wrongPassword: false, submit: null, cancel: null };
    log('home.pdf', 'password-protected PDF, prompting', { file: filename });
    renderFileRows();

    const getPassword = (reason) => new Promise((resolve, reject) => {
      if (reason === INCORRECT_PASSWORD) {
        entry.pwPrompt.attempts += 1;
        entry.pwPrompt.wrongPassword = true;
        log('home.pdf', 'wrong password entered', { file: filename, attempts: entry.pwPrompt.attempts });
      }
      entry.pwPrompt.submit = (password) => { entry._pdfPassword = password; resolve(password); };
      entry.pwPrompt.cancel = () => reject(new Error(PW_CANCELLED));
      renderFileRows();
    });

    try {
      const pages = await loadPdfPages(buf, { getPassword });
      entry.pwPrompt = null;
      entry.pwUnlockedProfileGuess = hintProfile; // lets the "remember a hint" offer below know one may already exist
      log('home.pdf', 'password accepted', { file: filename });
      return pages;
    } catch (err) {
      entry.pwPrompt = null;
      if (err?.message === PW_CANCELLED) {
        log('home.pdf', 'password prompt cancelled', { file: filename });
        return 'cancelled';
      }
      throw err;
    }
  }

  /** The password-prompt row: shown instead of every other file-row status while entry.pwPrompt is set (renderFileRows checks this first). */
  function renderPasswordPromptRow(entry) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', entry.name);
    const p = entry.pwPrompt;
    const hintLine = p.hint ? `<div class="fr-caption">Hint: ${escapeHtml(p.hint)}</div>` : '';
    const wrongLine = p.wrongPassword
      ? `<div class="fr-caption fr-pw-wrong">That password didn't work. Try again.${p.attempts >= 3 ? ' Check the bank\'s password rules.' : ''}</div>`
      : '';
    row.innerHTML = `
      <div class="fr-main">
        <div class="fr-name">${escapeHtml(entry.name)}</div>
        <div class="fr-line">This statement is protected. Enter the password the bank gave you.</div>
        ${hintLine}
        ${wrongLine}
        <div class="fr-pw-form">
          <input type="password" class="fr-pw-input" aria-label="Statement password" autocomplete="off">
          <button type="button" class="icon-btn fr-pw-toggle" aria-label="Show password">Show</button>
          <button type="button" class="btn btn-brass btn-sm fr-pw-unlock">Unlock</button>
        </div>
      </div>`;
    const input = row.querySelector('.fr-pw-input');
    const toggle = row.querySelector('.fr-pw-toggle');
    toggle.onclick = () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggle.textContent = showing ? 'Show' : 'Hide';
      toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    };
    const submit = () => { if (input.value) p.submit?.(input.value); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.querySelector('.fr-pw-unlock').onclick = submit;
    row.appendChild(renderRemoveButton(entry)); // Remove doubles as the row's own cancel path
    const removeBtn = row.querySelector('.remove-file-btn');
    removeBtn.onclick = () => { p.cancel?.(); removeFile(entry); };
    return row;
  }

  /** Offered once, right after a successful unlock, on a profile that doesn't already have a passwordHint saved - see profiles.js's setProfilePasswordHint. */
  function renderRememberHintCaption(entry) {
    if (!entry.profile || entry.profile.passwordHint || !entry._pdfPassword) return '';
    return `<div class="fr-caption fr-learn-prompt">Remember a hint for this statement type? <a href="#" class="pw-remember-hint">Yes</a></div>`;
  }

  async function wireRememberHintLink(row, entry) {
    const link = row.querySelector('.pw-remember-hint');
    if (!link) return;
    link.onclick = async (e) => {
      e.preventDefault();
      const hint = window.prompt('A short reminder of the password formula (never the password itself), e.g. "Usually your ID number plus date of birth":');
      if (hint == null) return; // cancelled
      await setProfilePasswordHint(storage, entry.profile.id, hint);
      log('home.pdf', 'password hint saved for statement type', { profile: entry.profile.name });
      entry.profile = { ...entry.profile, passwordHint: hint };
      renderFileRows();
    };
  }
  // ===== PASSWORD PROMPT BLOCK - end =====

  /** Item B: a transient "Dropped again, already here" caption on the existing row - no state change beyond the flag itself, nothing to persist. */
  function flashDroppedAgain(entry) {
    entry.dropAgainNotice = true;
    renderFileRows();
    clearTimeout(entry._dropAgainTimer);
    entry._dropAgainTimer = setTimeout(() => { entry.dropAgainNotice = false; renderFileRows(); }, 4000);
  }

  // --- Item A: a scored-well match that extracts nothing usable tries the
  // next candidate before ever showing "healthy" -----------------------
  // A real bug: a file matched a broken saved statement type at 0.9
  // confidence, extracted 0 rows, and still showed a healthy badge. A match
  // is only ever trusted once it actually produces usable rows; entry.matches
  // (matchProfile's own ranked candidate list from drop time) is walked in
  // order until one does, or every candidate has been tried.

  function matchKey(m) { return `${m.profile.id}::${m.version.id}`; }

  /** Next ranked candidate this file hasn't already been tried against, or null once every one has. */
  function nextUntriedCandidate(entry) {
    const tried = entry._triedMatches;
    return (entry.matches || []).find((m) => !tried.has(matchKey(m))) || null;
  }

  // --- Item 1: quality-scored candidate selection --------------------------
  // A real bug: two candidates tied on signature score alone (a broken
  // user profile and the correct built-in), and the broken
  // one won by list order. Before auto-applying the top-scored candidate,
  // every candidate within selectMatchCandidate's TIE_MARGIN is actually run
  // through the pipeline (main thread - this file isn't parsed for real
  // until a candidate is picked either way) and scored on what it extracts.

  /** dateLedLineCount + a sync buildRows(match) closure, reusing one PDF page load for every scored candidate instead of one per candidate. */
  async function prepareCandidateScoring(entry) {
    let pagesLines = null;
    let lineSource = entry.grid;
    if (entry.type === 'pdf') {
      const pages = entry.ocr ? entry.ocrPages : await loadPdfPagesForEntry(entry);
      pagesLines = pages.map((p) => groupItemsIntoLines(p.items));
      lineSource = pagesLines.flatMap((lines) => lines.map(lineText));
    }
    const dateLedLineCount = countTransactionLikeRows(lineSource);
    const buildRows = (match) => buildFileRows(entry, { pagesLines }, match.version, {
      bank: match.profile.bank, statementType: match.profile.statementType, currency: match.profile.defaultCurrency,
    });
    return { dateLedLineCount, buildRows };
  }

  /** The best-quality USER profile that scored worse than the picked candidate - item 2's "your profile could not read amounts" caption names this one, never a builtin. */
  function findQualityLoser(scored, pickedMatch) {
    const pickedQuality = scored.find((s) => s.match === pickedMatch)?.quality ?? 0;
    const losers = (scored || [])
      .filter((s) => s.match !== pickedMatch && !s.match.profile.builtIn && s.match.profile.id !== pickedMatch.profile.id && s.quality < pickedQuality)
      .sort((a, b) => b.quality - a.quality);
    return losers[0]?.match.profile || null;
  }

  /**
   * Scores every near-tied candidate, logs the full table, and hands the
   * winner to `applyFn` (applyMatchToFile / applyOcrMatchToFile) - same
   * contract as calling applyFn(entry, entry.matches[0]) directly, just with
   * a quality-checked pick instead of a bare signature-score one. Candidates
   * already known (from scoring) to fail matchExtractionFailed are pre-marked
   * "tried" so applyFn's own serial fallback never re-parses them.
   */
  async function applyBestMatch(entry, applyFn) {
    const { dateLedLineCount, buildRows } = await prepareCandidateScoring(entry);
    const { picked, scored } = selectMatchCandidate(entry.matches, dateLedLineCount, buildRows);
    log('home.match', 'candidate extraction quality', {
      file: entry.name, dateLedLineCount,
      scored: scored.map((s) => ({ profile: s.match.profile.name, confidence: s.confidence, quality: Math.round(s.quality * 1000) / 1000, rows: s.rows?.length ?? null })),
    });
    if (!picked) return;
    entry._candidateScored = scored;
    entry._triedMatches = new Set(
      scored.filter((s) => s.match !== picked.match && matchExtractionFailed(s.rows)).map((s) => matchKey(s.match)),
    );
    await applyFn(entry, picked.match);
  }

  /** Stamps entry.qualityLoser (item 2) from the scoring pass applyBestMatch ran, once the actually-applied match is known; a no-op (clears it) for any apply path that didn't go through applyBestMatch (an explicit user pick has nothing to blame a tie on). */
  function stampQualityLoser(entry, appliedMatch) {
    const scored = entry._candidateScored;
    entry._candidateScored = null;
    entry.qualityLoser = scored ? findQualityLoser(scored, appliedMatch) : null;
  }

  /** Item 3: best-effort - persist this version's extraction health so the Profiles screen's health line reflects the last real apply. Never blocks or fails the apply itself. */
  async function persistProfileHealth(match, rows) {
    try {
      await updateVersionLastUsed(storage, match.profile.id, match.version.id, summarizeExtraction(rows));
    } catch (err) {
      logError('home.profileHealth', err, { profile: match.profile.name });
    }
  }

  async function applyMatchToFile(entry, match, opts = {}) {
    // An OCR'd file has no real pdf.js text layer to re-extract from
    // (loadPdfPages would just throw "no readable text" again); it has its
    // own extraction path over the cached OCR items instead.
    if (entry.ocr) return applyOcrMatchToFile(entry, match, opts);
    let preambleText;
    if (entry.type === 'pdf') {
      preambleText = entry.pdfPageOneText || '';
    } else {
      entry.headerRowUsed = match.version.csv.headerRow;
      preambleText = entry.grid.slice(0, entry.headerRowUsed).flat().join(' ');
    }
    // Scope the masked digits to the bank/profile: two different banks can
    // legitimately end in the same last-4 digits, and account_label also
    // drives cross-file dedupe fingerprints, so an unscoped mask would wrongly
    // treat unrelated accounts as one for both display and merging.
    const masked = maskAccountNumber(preambleText);
    entry.maskedAccount = masked;
    entry.accountLabel = defaultAccountLabel(match.profile, masked);
    const meta = {
      bank: match.profile.bank,
      statementType: match.profile.statementType,
      currency: match.profile.defaultCurrency,
      sourceFile: entry.name,
      accountLabel: entry.accountLabel,
    };

    entry.processing = true;
    renderAll();

    let rows = null;
    const kind = entry.type === 'text' ? 'csv' : entry.type === 'xlsx' ? 'xlsx' : entry.type === 'pdf' ? 'pdf' : null;
    if (kind) {
      try {
        rows = await parseInWorker(entry, kind, match.version, meta, (done, total) => {
          entry.progress = total ? done / total : 0;
          renderFileRows();
        });
        if (rows) log('home.parse', `${kind} parsed in worker`, { file: entry.name, rows: rows.length });
      } catch (err) {
        entry.workerJobId = null;
        if (err.message === 'cancelled') {
          entry.processing = false;
          entry.progress = null;
          renderAll();
          return;
        }
        log('home.worker', 'worker parse failed, falling back to main-thread parsing', { file: entry.name, kind, message: err.message });
      }
    }
    if (!rows) {
      // core/pipeline.js's buildFileRows: the one function every screen (Home,
      // wizard Test, wizard Save) now calls to turn a file+version into rows,
      // so OCR-confidence flags and every other normalize.js flag compute
      // identically everywhere instead of each call site hand-building its
      // own meta (the Test-step drift that caused "6 rows need a look" - see
      // pipeline.js's own doc comment).
      if (kind === 'pdf') {
        // A password-protected PDF's worker attempt above always fails
        // (worker.js has no password to hand pdf.js) and falls back to here,
        // which does - see loadPdfPagesForEntry in the delimited block below.
        const pages = await loadPdfPagesForEntry(entry);
        rows = buildFileRows(entry, { pagesLines: pages.map((p) => groupItemsIntoLines(p.items)) }, match.version, meta);
      } else {
        rows = buildFileRows(entry, {}, match.version, meta);
      }
      log('home.parse', `${kind || entry.type} parsed on main thread`, {
        file: entry.name, rows: rows.length, flagCounts: flagHistogram(rows),
        reason: kind ? (workerUnavailableReason || 'worker unavailable') : `no worker kind for file type "${entry.type}"`,
      });
    }
    entry.progress = null;

    // Item A: only the automatic candidate-list path retries - an explicit
    // "Use an existing profile" pick (opts.noFallback) keeps its own distinct
    // pickedProfileFailed/"Pick a different profile" handling instead.
    if (!opts.noFallback && matchExtractionFailed(rows)) {
      entry._triedMatches = entry._triedMatches || new Set();
      entry._triedMatches.add(matchKey(match));
      const next = nextUntriedCandidate(entry);
      entry.processing = false;
      entry.workerJobId = null;
      log('home.match', 'match yielded no usable rows, trying next candidate', { file: entry.name, profile: match.profile.name, rows: rows.length, next: next?.profile.name ?? null });
      if (next) return applyMatchToFile(entry, next);
      // ponytail: candidates tied at the same confidence are tried in
      // matchProfile's own order, first usable one wins - not re-scored by
      // row count across the whole tied group. Upgrade if two tied
      // candidates both fail and which failure to report ever matters.
      entry.matchFailed = match.profile.name;
      entry.rows = null;
      renderAll();
      onFilesChanged?.();
      await autosave();
      return;
    }
    entry._triedMatches = null;
    entry.matchFailed = null;

    // Item 1: keep the matched version around (rowModel, grouped signConvention/
    // columnBands) so Home's health badge and Review's summary can run the
    // same countCheckGrouped a grouped-rowModel PDF's wizard Test step does.
    entry.matchedVersion = match.version;
    if (entry.type === 'pdf' && match.version.pdf?.rowModel === 'grouped') {
      // ponytail: reloads the PDF a second time rather than threading the
      // already-loaded pages through the worker path too; only grouped-
      // rowModel PDFs pay this, upgrade if that ever shows up as slow.
      try {
        const pdfPages = await loadPdfPagesForEntry(entry);
        entry.pdfSourceText = pdfPages.map((p) => groupItemsIntoLines(p.items).map(lineText).join('\n')).join('\n');
      } catch (err) {
        logError('home.pdfSourceText', err, { file: entry.name });
      }
    }

    entry.processing = false;
    entry.workerJobId = null;
    entry.rows = rows;
    entry.profile = match.profile;
    entry.matches = [match, ...entry.matches.filter((m) => m !== match)];
    // Item: count/balance checks must run against this file's OWN extracted
    // rows, before cross-file dedupe merge can shrink (even to zero) its
    // `rows` - compute and store the badge label now, never recompute it
    // from `rows` later (see home-state.js's healthBadge doc).
    entry.groupedCheckLabel = groupedMismatchLabel(entry);
    // Bug D: same contract, same reason - fileStatus needs this file's own
    // pre-merge row count to tell "matched but extracted nothing" apart from
    // "every row merged into another file" once mergeDuplicates() below can
    // shrink entry.rows to zero either way.
    entry.rowCountAtMatch = entry.rows.length;
    stampQualityLoser(entry, match); // item 2
    persistProfileHealth(match, entry.rows); // item 3, fire-and-forget
    mergeDuplicates();
    log('home.match', 'match applied', { file: entry.name, profile: match.profile.name, confidence: match.confidence, rows: entry.rows.length });
    renderAll();
    onFilesChanged?.();
    await autosave();
  }

  // --- OCR (image-only PDFs) -----------------------------------------------
  // Runs OCR, then feeds the result through the exact same profile-match +
  // extract path a real-text PDF uses (matchProfile against OCR'd page text,
  // extractRows/extractGroupedRows against OCR'd items instead of pdf.js's
  // own getTextContent items - the two are shaped identically, see
  // core/ocr.js's module doc comment).

  // Item 7: OCR runs one FILE at a time through core/ocr.js's small worker
  // pool (2-3 Tesseract workers) - two files OCR'd concurrently used to
  // fight over it and both come out slower (a real 3-page file took 102s
  // instead of 16s). Within one file, the pool now recognises that file's
  // own pages in parallel (Track 3 speed pass) - the one-file-at-a-time
  // queue below is unchanged, it's the unit of work that got faster inside.
  // ocrActiveEntry is the one file actually reading; ocrQueue holds the
  // rest, in drop order, each waiting its turn.
  let ocrActiveEntry = null;
  const ocrQueue = [];

  /** 1-based "Nth in queue" for a waiting entry (the active file is always "1st"), or null if it isn't queued. */
  function ocrQueuePosition(entry) {
    const idx = ocrQueue.indexOf(entry);
    return idx === -1 ? null : idx + 2;
  }

  function enqueueOcr(entry) {
    if (!ocrActiveEntry) {
      ocrActiveEntry = entry;
      runOcrOnFile(entry); // fire-and-forget; its own finally drains the queue
    } else {
      entry.ocrQueued = true;
      ocrQueue.push(entry);
      log('home.ocr', 'Text recognition queued behind another file', { file: entry.name, position: ocrQueuePosition(entry) });
      renderAll();
    }
  }

  /** Cancel a file's OCR: aborts it if actively running, or just removes it from the queue if it hasn't started yet. */
  function cancelOcr(entry) {
    if (entry === ocrActiveEntry) { entry.ocrCancel?.abort(); return; }
    const idx = ocrQueue.indexOf(entry);
    if (idx !== -1) {
      ocrQueue.splice(idx, 1);
      entry.ocrQueued = false;
      entry.ocrCancelled = true; // same "Read again" row the active-run cancel path uses
      log('home.ocr', 'Text recognition cancelled while queued', { file: entry.name });
      renderAll();
    }
  }

  function drainOcrQueue() {
    ocrActiveEntry = null;
    const next = ocrQueue.shift();
    if (next) {
      next.ocrQueued = false;
      ocrActiveEntry = next;
      runOcrOnFile(next);
    }
  }

  // Track 3 (partial results): best-effort, run after each page finishes -
  // matches the pages OCR'd SO FAR against known profiles and, if one
  // matches confidently, builds rows from just those pages so the file row
  // can show something before OCR is fully done. Never authoritative: the
  // real, final match + rows (below, once every page is in) always replaces
  // whatever this produced, count check and dedupe included.
  function updatePartialOcrResults(entry, pagesSoFar, profiles) {
    try {
      const pagesLines = pagesSoFar.map((p) => groupItemsIntoLines(p.items));
      const text = pagesLines.flatMap((lines) => lines.map(lineText)).join('\n');
      const top = matchProfile({ pdfText: text, preambleText: text, filename: entry.name, fileType: 'pdf' }, profiles)[0];
      if (!top || top.formatChanged) return; // too uncertain to show yet, wait for the final pass
      const rows = buildFileRows(entry, { pagesLines }, top.version, {
        bank: top.profile.bank, statementType: top.profile.statementType, currency: top.profile.defaultCurrency, ocr: true,
      });
      if (rows?.length) {
        entry.rows = rows;
        entry.partialOcr = true;
      }
    } catch (err) {
      log('home.ocr', 'partial-result extraction skipped (best effort only)', { file: entry.name, message: err.message });
    }
  }

  async function runOcrOnFile(entry) {
    entry.processing = true;
    entry.progress = 0;
    // Item 11: shown the instant OCR starts (renderAll below runs before the
    // first onProgress tick even knows the page count) - a first-timer
    // dropping a scanned PDF from the setup path sees this immediately
    // instead of a silent gap that could read as "did this stall?".
    entry.progressLabel = 'Reading your scan…';
    entry.ocrRunning = true;
    entry.ocrFailed = false;
    entry.ocrCancelled = false;
    entry.ocrQueued = false;
    entry.ocrCancel = new AbortController();
    entry.ocr = true; // set up front: buildFileRows/normalize need it for partial results too, see below
    entry.pagesRead = 0;
    entry.pagesTotal = null;
    entry.partialOcr = false;
    entry.rows = null;
    renderAll();
    const startedAt = performance.now();
    const profiles = await loadProfiles(storage); // loaded once, reused for every partial-result attempt below
    const pageTimingsMs = [];
    try {
      const { pages, text } = await ocrDocument(entry.bytes, {
        signal: entry.ocrCancel.signal,
        fileName: entry.name, // item 7: every [ocr] log line names the file, not just the wrapping home.ocr ones
        onProgress: (done, total) => {
          entry.progress = total ? done / total : 0;
          const avgMs = pageTimingsMs.length ? pageTimingsMs.reduce((a, b) => a + b, 0) / pageTimingsMs.length : null;
          const estimate = ocrTimeEstimateLabel(done, total, avgMs);
          entry.progressLabel = `Reading page ${done} of ${total}${estimate ? ` &middot; ${estimate}` : ''}`;
          renderFileRows();
        },
        onPage: (pageResult, pagesSoFar, total) => {
          pageTimingsMs.push(pageResult.ms);
          entry.pagesRead = pagesSoFar.length;
          entry.pagesTotal = total;
          updatePartialOcrResults(entry, pagesSoFar, profiles);
          renderFileRows();
        },
      });
      const elapsedSec = (performance.now() - startedAt) / 1000;
      entry.imageOnly = false;
      entry.ocrPages = pages; // [{pageNum, items, avgConfidence, canvas}], kept for the wizard/Review source pane this session
      entry.ocrText = text;
      entry.partialOcr = false; // the real, final rows (below) take over from here
      log('home.ocr', 'Text recognition completed', {
        file: entry.name, pages: pages.length, elapsedSec: Math.round(elapsedSec * 10) / 10,
        avgConfidence: Math.round(pages.reduce((s, p) => s + p.avgConfidence, 0) / (pages.length || 1)),
      });

      entry.matches = matchProfile({ pdfText: text, preambleText: text, filename: entry.name, fileType: 'pdf' }, profiles);
      entry.accountLabel = maskAccountNumber(text) || entry.name;
      entry.processing = false;
      entry.ocrRunning = false;
      entry.progress = null;

      if (entry.matches?.length && !entry.matches[0].formatChanged && entry.matches[0].confidence >= HIGH_CONFIDENCE) {
        await applyBestMatch(entry, applyOcrMatchToFile);
      } else if (!entry.matches?.length) {
        // Recognised no known statement type at all: text recognition itself
        // worked (it produced readable text), this is a mapping question,
        // not an OCR failure, so it flows into the normal "new statement"
        // card rather than "Could not read this PDF". A partial-results guess
        // from mid-OCR never got confirmed by the full document - drop it, so
        // fileStatus falls through to 'new' instead of reading the leftover
        // rows as a healthy match.
        entry.rows = null;
        renderAll();
        onFilesChanged?.();
        await autosave();
      } else {
        // A candidate matched but at low confidence / a changed layout: the
        // normal lowConfidence/layoutChanged cards handle it from here - same
        // "drop the unconfirmed partial guess" reasoning as above.
        entry.rows = null;
        renderAll();
        onFilesChanged?.();
        await autosave();
      }
    } catch (err) {
      entry.processing = false;
      entry.ocrRunning = false;
      entry.progress = null;
      if (err.name === 'AbortError') {
        entry.ocrCancelled = true; // row offers "Read again", no card
        log('home.ocr', 'Text recognition cancelled', { file: entry.name });
        renderAll();
        return;
      }
      entry.ocrFailed = true; // "Could not read this PDF" card, no generic error row
      logError('home.ocr', err, { file: entry.name });
      renderAll();
    } finally {
      // Item 7: whichever way this file's OCR ended (clean match, no match,
      // cancelled, failed), the next queued file (if any) starts now - never
      // left waiting forever behind a finished one.
      drainOcrQueue();
    }
  }

  async function applyOcrMatchToFile(entry, match, opts = {}) {
    const masked = maskAccountNumber(entry.ocrText || '');
    entry.maskedAccount = masked;
    entry.accountLabel = defaultAccountLabel(match.profile, masked);
    // ocr is no longer set here - buildFileRows reads entry.ocr itself
    // (already true by the time this runs), so no caller can drop it.
    const meta = {
      bank: match.profile.bank,
      statementType: match.profile.statementType,
      currency: match.profile.defaultCurrency,
      sourceFile: entry.name,
      accountLabel: entry.accountLabel,
    };
    entry.processing = true;
    renderAll();

    const rows = buildFileRows(entry, { pagesLines: entry.ocrPages.map((p) => groupItemsIntoLines(p.items)) }, match.version, meta);
    log('home.parse', 'pdf (text recognition) parsed on main thread', { file: entry.name, rows: rows.length, flagCounts: flagHistogram(rows) });

    entry.processing = false;

    if (!opts.noFallback && matchExtractionFailed(rows)) {
      entry._triedMatches = entry._triedMatches || new Set();
      entry._triedMatches.add(matchKey(match));
      const next = nextUntriedCandidate(entry);
      log('home.match', 'text recognition match yielded no usable rows, trying next candidate', { file: entry.name, profile: match.profile.name, rows: rows.length, next: next?.profile.name ?? null });
      if (next) return applyOcrMatchToFile(entry, next);
      if (rows.length === 0) {
        // Text recognition and every candidate profile all produced nothing:
        // a real OCR failure, not a mapping question.
        entry.ocrFailed = true;
      } else {
        // Text recognition worked fine - no candidate profile's mapping fit
        // what it read (item A).
        entry.matchFailed = match.profile.name;
      }
      entry.rows = null;
      log('home.ocr', 'no saved statement type produced usable rows from the text recognition output', { file: entry.name, rows: rows.length });
      renderAll();
      onFilesChanged?.();
      await autosave();
      return;
    }
    entry._triedMatches = null;
    entry.matchFailed = null;

    entry.rows = rows;
    entry.profile = match.profile;
    entry.matchedVersion = match.version;
    if (match.version.pdf?.rowModel === 'grouped') {
      entry.pdfSourceText = entry.ocrPages.map((p) => groupItemsIntoLines(p.items).map(lineText).join('\n')).join('\n');
    }
    entry.matches = [match, ...entry.matches.filter((m) => m !== match)];
    // See the note in applyMatchToFile: computed pre-merge, stored, never recomputed.
    entry.groupedCheckLabel = groupedMismatchLabel(entry);
    entry.rowCountAtMatch = entry.rows.length; // Bug D: see applyMatchToFile's note
    stampQualityLoser(entry, match); // item 2
    persistProfileHealth(match, entry.rows); // item 3, fire-and-forget
    mergeDuplicates();
    log('home.match', 'text recognition match applied', { file: entry.name, profile: match.profile.name, confidence: match.confidence, rows: entry.rows.length });
    renderAll();
    onFilesChanged?.();
    await autosave();
  }

  // --- Item 13: "Use an existing profile" -----------------------------

  function normalizedFileType(entry) { return entry.type === 'text' ? 'csv' : entry.type; }

  // Coordinator note (2026-09-17): logged alongside every parse so Home's
  // own flags (via pipeline.js's buildFileRows, same as the wizard's Test
  // step) can be diffed against Test's histogram directly from the debug
  // log - the two must always agree now that both call sites share one
  // function (see core/pipeline.js's doc comment on the bug this replaced).
  function flagHistogram(rows) {
    return (rows || []).reduce((h, r) => { for (const f of r.flags || []) h[f] = (h[f] || 0) + 1; return h; }, {});
  }

  // Best-effort signals for profiles.js's learnSignatures - short candidate
  // phrases pulled from this file's own preamble/page-1 text, the same
  // plausibility-checked candidate generator the wizard's anchor picker uses
  // (profiles.js's pdfAnchorCandidates), so a learned signature never carries
  // garbage OCR noise or account-specific digits either.
  //
  // Deliberately prefers entry.headerRowGuess (this FILE's own detected
  // header position, from suggestHeaderRow at drop time) over
  // entry.headerRowUsed (the PICKED PROFILE's own csv.headerRow config,
  // which applyMatchToFile stamps onto the entry once applied): with "Use an
  // existing profile", the applied profile's headerRow can point at
  // completely the wrong row of THIS file (that mismatch is exactly why the
  // picker exists) - learning that row as the file's header would poison the
  // new signature with garbage instead of this file's own real columns.
  function buildLearnSignals(entry) {
    const fileType = normalizedFileType(entry);
    const headerRow = entry.headerRowGuess ?? 0;
    const preambleText = fileType === 'pdf'
      ? (entry.pdfPageOneText || entry.pdfSourceText || '')
      : (entry.grid || []).slice(0, headerRow).flat().join(' ');
    const lines = String(preambleText).split(/\r?\n/).filter(Boolean);
    const candidates = lines.length ? pdfAnchorCandidates(lines, -1, 3, preambleText) : [];
    return {
      headerText: fileType !== 'pdf' && entry.grid ? (entry.grid[headerRow] || []) : [],
      preambleKeywords: fileType !== 'pdf' ? candidates : [],
      pdfAnchors: fileType === 'pdf' ? candidates : [],
      filename: entry.name,
    };
  }

  // Applies a user-picked existing profile exactly like an auto-match (same
  // parse + checks + badge path as applyMatchToFile/applyOcrMatchToFile),
  // then decides which of item 13's two follow-ups applies: checks passed ->
  // offer to learn this file's signals onto the profile; checks failed ->
  // relabel the row as Layout changed with a way back into the picker.
  async function useExistingProfile(entry, profile) {
    const version = profile.versions[profile.versions.length - 1];
    const match = { profile, version, confidence: 1, formatChanged: false };
    entry.pickedProfileFailed = false;
    entry.offerLearnSignatures = null;
    entry.matchFailed = null;
    entry._triedMatches = null;
    // noFallback: an explicit pick keeps its own pickedProfileFailed/"Pick a
    // different profile" handling below, not item A's automatic candidate-list retry.
    if (entry.ocr) await applyOcrMatchToFile(entry, match, { noFallback: true }); else await applyMatchToFile(entry, match, { noFallback: true });
    // Found verifying this flow live: a picked profile whose headerRow lands
    // on the wrong row of this file can leave exactly one all-skipped
    // "record" (rows.length > 0, but nothing real in it) - home-state.js's
    // fileStatus now reads that as 'noTransactions', not a false-clean
    // 'healthy', so it belongs in the same failed bucket as a truly
    // unreadable parse.
    const status = fileStatus(entry);
    const failed = status === 'unreadableDates' || status === 'error' || status === 'noTransactions' || !entry.rows?.length;
    if (failed) {
      entry.pickedProfileFailed = true;
    } else {
      entry.offerLearnSignatures = { profileId: profile.id, versionId: version.id };
    }
    renderAll();
  }

  async function openProfilePicker(entry) {
    const fileType = normalizedFileType(entry);
    const profiles = await loadProfiles(storage);
    const byBank = new Map();
    for (const p of profiles) {
      const key = p.bank || 'Other';
      byBank.set(key, [...(byBank.get(key) || []), p]);
    }

    const overlay = document.createElement('div');
    overlay.className = 'profile-picker-overlay';
    const box = document.createElement('div');
    box.className = 'profile-picker';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Use a statement type I already set up');

    const heading = document.createElement('h3');
    heading.textContent = 'Use a statement type I already set up';
    const hint = document.createElement('p');
    hint.className = 'pdf-anchor-hint';
    hint.textContent = `Only statement types for the same file type (${fileType.toUpperCase()}) as "${entry.name}" can be used.`;

    const groupsHost = document.createElement('div');
    groupsHost.className = 'profile-picker-groups';
    for (const [bank, list] of byBank) {
      const groupTitle = document.createElement('div');
      groupTitle.className = 'pp-group-title';
      groupTitle.textContent = bank;
      groupsHost.appendChild(groupTitle);
      for (const p of list) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pp-profile-btn';
        const enabled = p.fileType === fileType;
        btn.disabled = !enabled;
        btn.innerHTML = `<span>${p.name}</span><span class="pp-filetype">${(p.fileType || '').toUpperCase()}</span>`;
        if (enabled) btn.onclick = () => { close(); useExistingProfile(entry, p); };
        groupsHost.appendChild(btn);
      }
    }

    const footer = document.createElement('div');
    footer.className = 'profile-picker-footer';
    const newLink = document.createElement('a');
    newLink.href = '#'; newLink.textContent = 'Map this as a new statement';
    newLink.onclick = (e) => { e.preventDefault(); close(); onOpenWizard(entry); };
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn btn-ghost btn-sm'; cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => close();
    footer.append(newLink, cancelBtn);

    box.append(heading, hint, groupsHost, footer);
    overlay.appendChild(box);
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  }

  function mergeDuplicates() {
    const filesWithRows = state.files.filter((f) => f.rows);
    for (const f of state.files) {
      f.mergedInto = null;
      f.exactDuplicateOf = null;
      f.duplicateDropped = false;
      f.duplicateDroppedSameFile = false;
      f.duplicateDroppedFrom = null;
    }
    if (filesWithRows.length < 2) { dedupeNotice = null; return; }
    // accountLabel is the file's own account identity (bank + masked account,
    // or the user's saved label) - always pass it so the merge keys off the
    // account, never off which profile matched (a user-saved profile and a
    // builtin one for the same account must fingerprint the same).
    const preMergeCounts = filesWithRows.map((f) => f.rows.length);
    // ocr: true routes D3's CSV-over-OCR tie-break (mergeAcrossFiles keeps
    // the CSV/text file's row when two files' occurrence counts for the same
    // fingerprint are equal).
    const { removed } = mergeAcrossFiles(filesWithRows.map((f) => ({ sourceFile: f.name, rows: f.rows, accountLabel: f.accountLabel, ocr: !!f.ocr })));
    if (!removed.length) { dedupeNotice = null; return; }
    // Filter by row object identity, not row_id string: row_id is
    // `${sourceFile}:${idx}`, and the exact scenario this merge exists for -
    // the same filename dropped twice - gives both files' rows identical
    // row_ids, so a string-keyed Set would wrongly strip the kept file's
    // rows too. The same identity problem rules out keying the caption logic
    // below by file NAME as well (two files can share a name), so it's all
    // done positionally over filesWithRows/preMergeCounts instead.
    const removedSet = new Set(removed);
    // Before filtering rows out, work out which surviving file (by index)
    // each removed row's fingerprint now lives under, so a fully/partially
    // merged-away file's row can caption "N rows merged into <that file>".
    const fpToFileIdx = new Map();
    filesWithRows.forEach((f, i) => {
      for (const r of f.rows) {
        if (removedSet.has(r)) continue;
        fpToFileIdx.set(fingerprint(r, f.accountLabel), i);
      }
    });
    filesWithRows.forEach((f, i) => {
      let count = 0;
      let intoIdx = null;
      for (const r of f.rows) {
        if (!removedSet.has(r)) continue;
        count++;
        intoIdx ??= fpToFileIdx.get(fingerprint(r, f.accountLabel));
      }
      if (count > 0) {
        const into = intoIdx != null ? filesWithRows[intoIdx] : null;
        // Captured from f.rows BEFORE the filter below strips the merged-away
        // rows out - this file's own pre-merge extraction, never "0 rows".
        const range = dateRangeOfRows(f.rows);
        f.mergedInto = { count, total: preMergeCounts[i], into: into?.name ?? null, range };
        // A whole file that dissolved entirely into another one (every row
        // merged away) and is a byte-for-byte or same-size re-drop gets a
        // single-row "Dropped twice" treatment instead of its own zero-row
        // entry (QA Finding 1).
        if (into && isExactDuplicateFile({ count, total: preMergeCounts[i], bytesA: f.bytes, bytesB: into.bytes, otherFileTotal: preMergeCounts[intoIdx] })) {
          f.exactDuplicateOf = into.name;
          into.duplicateDropped = true;
          // Wording fix (C2): only the identical filename dropped a second
          // time reads as "Dropped twice" - a different name or file type
          // (CSV vs PDF) is a different-looking export of the same
          // statement, so it gets its own "same transactions" wording.
          into.duplicateDroppedSameFile = f.name === into.name && f.type === into.type;
          into.duplicateDroppedFrom = f.name;
        }
      }
    });
    // Undo must put each removed row back on the exact file OBJECT it came
    // from, not "whichever file has this name" - the same filename dropped
    // twice means both files share a name, so a name lookup would put every
    // removed row back on whichever one `find` happens to hit first.
    const rowOrigin = new Map();
    filesWithRows.forEach((f) => { for (const r of f.rows) if (removedSet.has(r)) rowOrigin.set(r, f); });
    // An exact whole-file duplicate already gets its own "Dropped twice"
    // caption on the surviving file (above) - it must not ALSO trigger the
    // session-wide "N rows merged, Undo" notice, since there is nothing to
    // undo (the second copy was never really added). Only rows removed from
    // an actual partial-overlap file still surface that notice.
    const noticeRows = removed.filter((r) => !rowOrigin.get(r)?.exactDuplicateOf);
    for (const f of filesWithRows) f.rows = f.rows.filter((r) => !removedSet.has(r));
    dedupeNotice = noticeRows.length ? { removed: noticeRows, rowOrigin, count: noticeRows.length } : null;
  }

  function undoDedupe() {
    if (!dedupeNotice) return;
    // Put each removed row back onto the exact file object it came from.
    for (const row of dedupeNotice.removed) {
      const file = dedupeNotice.rowOrigin.get(row) ?? state.files.find((f) => f.name === row.source_file);
      if (file) file.rows.push(row);
    }
    // Undo reverses every derived merge/duplicate flag, not just per-row
    // membership: a "Dropped twice" caption or a hidden exact-duplicate row
    // must not survive an Undo (they'd otherwise never clear on their own).
    for (const f of state.files) {
      f.mergedInto = null;
      f.exactDuplicateOf = null;
      f.duplicateDropped = false;
      f.duplicateDroppedSameFile = false;
      f.duplicateDroppedFrom = null;
    }
    dedupeNotice = null;
    renderAll();
    onFilesChanged?.();
    autosave();
  }

  // --- Remove a statement / Undo -------------------------------------------
  // "Delete individual statements or even clear all
  // statements without clearing profiles". One removal path for every file
  // row regardless of its status (healthy, warning, new, failed, reading,
  // queued, merged, excluded) - reused by the row's own Remove button, the
  // ocrFailed/noTransactions/unreadableDates cards' Remove link, Review's
  // header Remove, and the drawer's Sources rows.

  /**
   * Remove one file: cancels its OCR/parse if still running, drops it from
   * `state.files` (home-state.js's removeFileAt is the pure part), re-runs
   * cross-file dedupe and the export composition, persists the session, and
   * offers an 8s "Removed <file>. Undo" toast. Profiles/versions/learned
   * signatures/presets/rates/preferences are never touched - this only ever
   * mutates state.files.
   */
  function removeFile(entry) {
    // Stop in-flight work first so a mid-OCR/mid-parse Remove ends cleanly
    // instead of leaving an orphaned job running against a file no longer in
    // the list - cancelOcr already covers both the actively-reading and the
    // merely-queued case.
    if (entry.ocrRunning || entry === ocrActiveEntry || entry.ocrQueued) cancelOcr(entry);
    if (entry.workerJobId && worker) worker.postMessage({ type: 'cancel', jobId: entry.workerJobId });

    const index = state.files.indexOf(entry);
    if (index === -1) return;
    state.files = removeFileAt(state.files, index).files;
    mergeDuplicates();
    renderAll();
    onFilesChanged?.();
    autosave();
    announce(`Removed ${entry.name}.`);
    toast(`Removed ${entry.name}.`, { onUndo: () => undoRemoveFile(entry, index), duration: 8000 });
  }

  /** Undo removeFile: puts the exact same file object back, rows/edits/review resolutions untouched. */
  function undoRemoveFile(entry, index) {
    state.files = restoreFileAt(state.files, index, entry);
    mergeDuplicates();
    renderAll();
    onFilesChanged?.();
    autosave();
    announce(`Restored ${entry.name}.`);
  }

  // --- Rows / range helpers ------------------------------------------------

  // C1b: a file whose own rows failed the date/amount safety net never
  // contributes rows anywhere export-adjacent (export itself, per-account
  // coverage, currency/rate tables) - not just when a date-range filter
  // happens to exclude its blank dates (the "All dates" range does not).
  // Item 14a: neither does a file the user unchecked in the drawer's Sources
  // list (sourceIncluded folds both checks into one).
  function allRows() { return state.files.filter(sourceIncluded).flatMap((f) => f.rows || []); }

  function currentRange() {
    if (state.rangePreset === 'all') return { startISO: null, endISO: null };
    if (state.rangePreset === 'sinceLastExport') return customRange || { startISO: null, endISO: null };
    if (state.rangePreset === 'custom') return customRange || { startISO: null, endISO: null };
    return resolvePreset(state.rangePreset);
  }

  function rowsInRange() {
    // Skipped lines (non-transaction summary/footer text, see checks.fileSummary)
    // never count as rows: not on the Home badge, not in Review's summary, and
    // not in what actually gets copied/downloaded.
    return filterByRange(allRows(), currentRange(), dateField).included.filter((r) => !r.excluded && !r.skipped);
  }

  // D2 (blocker): the export's Amount/Currency columns must carry the
  // CONVERTED value/target currency, not the original ones sitting quietly
  // underneath - convertToTarget only ever adds converted_amount/
  // converted_currency/fx_rate alongside the original fields, so without
  // this swap a preset that lists plain 'amount'/'currency' (the default)
  // exports the unconverted numbers no matter what rate was entered.
  // Original values move to orig_amount/orig_currency so a preset (see
  // DEFAULT_PRESET_MODE_B) can still show both.
  function rowsForExport() {
    const rows = rowsInRange();
    if (currencyMode === 'B') {
      const { rows: converted } = convertToTarget(rows, targetCurrency, rates, rates);
      return converted.map((r) => ({
        ...r,
        orig_amount: r.amount,
        orig_currency: r.currency,
        amount: r.converted_amount,
        currency: r.converted_currency,
      }));
    }
    return rows;
  }

  function missingRatePairs() {
    if (currencyMode !== 'B') return [];
    const { missingPairs } = convertToTarget(rowsInRange(), targetCurrency, rates, rates);
    return missingPairs;
  }

  // Item 3: one coverage group per mapped file, labeled by its profile's own
  // display name (e.g. "DBS savings, PDF") - the preset editor's Coverage
  // column names which of these actually carry a given field.
  function fileCoverageGroups() {
    return state.files
      .filter((f) => f.rows?.length && sourceIncluded(f))
      .map((f) => ({ label: f.profile?.name || f.name, rows: f.rows }));
  }

  function accountsWithRows() {
    const byAccount = new Map();
    for (const f of state.files) {
      if (!f.rows || !sourceIncluded(f)) continue;
      const label = f.accountLabel || f.name;
      byAccount.set(label, [...(byAccount.get(label) || []), ...f.rows]);
    }
    return byAccount;
  }

  // Item 14a: mapped files this session offers as export "sources" - one row
  // per file (a re-dropped exact duplicate stays folded into the file it
  // merged into, same as the old Mapping list), each carrying whether it's
  // currently checked in.
  function sourceFiles() {
    const seen = new Set();
    return state.files.filter((f) => {
      if (!f.profile || f.exactDuplicateOf) return false;
      const key = JSON.stringify([f.name, f.profile.id]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // --- Rendering -------------------------------------------------------

  function renderAll() {
    renderFileRows();
    renderAttentionCards();
    renderExportPanel();
    const hasFiles = state.files.length > 0;
    $('#empty-state').hidden = hasFiles;
    $('#dropzone-slim').hidden = !hasFiles;
    $('#dropzone').hidden = !hasFiles;
    updateStepStrip();
  }

  // Simple B's Drop/Read/Copy strip (item 2): no files -> Drop is current; any
  // file still being read (parsing/OCR, running or queued) -> Read is
  // current; nothing left to do -> Copy is current, whether or not there's
  // actually anything to export (Home has no fourth "nothing here" state, and
  // "Copy" reads fine as "you're at the end of the flow" either way).
  let lastAnnouncedStep = null;
  function updateStepStrip() {
    const hasFiles = state.files.length > 0;
    const anyProcessing = state.files.some((f) => f.processing || f.ocrRunning || f.ocrQueued || f.imageOnly);
    const step = !hasFiles ? 1 : anyProcessing ? 2 : 3;
    const STEP_NAMES = { 1: 'Drop', 2: 'Read', 3: 'Copy' };
    for (let i = 1; i <= 3; i++) {
      const circle = $(`#strip-${i}`);
      if (!circle) continue;
      circle.classList.remove('done', 'current');
      if (i < step) circle.classList.add('done');
      else if (i === step) circle.classList.add('current');
    }
    $('#line-1')?.classList.toggle('filled', step > 1);
    $('#line-2')?.classList.toggle('filled', step > 2);
    if (step !== lastAnnouncedStep) {
      lastAnnouncedStep = step;
      announce(`Step ${step} of 3: ${STEP_NAMES[step]}`);
    }
  }

  function renderFileRows() {
    const container = $('#file-rows');
    container.innerHTML = '';
    state.files.forEach((entry, index) => {
      // A whole-file exact re-drop gets folded into the surviving file's own
      // row (its "Dropped twice" caption below) - no second, zero-row entry.
      if (entry.exactDuplicateOf) return;
      // Password prompt block (Track 2): a locked PDF pre-empts every other
      // row status until it's unlocked or cancelled - there's nothing to
      // match/OCR/show a badge for yet.
      if (entry.pwPrompt) { container.appendChild(renderPasswordPromptRow(entry)); return; }
      const row = document.createElement('div');
      row.className = 'file-row';
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-label', entry.name);
      const status = fileStatus(entry);

      if (status === 'processing') {
        const pct = entry.progress != null ? Math.round(entry.progress * 100) : 60;
        const label = entry.progressLabel || 'Reading statement&hellip;';
        // Item (d), partial results: once a page's OCR is in,
        // updatePartialOcrResults may have already put real rows on this
        // (still 'processing') entry - show them and offer to copy what's
        // ready, rather than making the user wait for every page.
        const partialRowCount = entry.partialOcr ? (entry.rows || []).filter((r) => !r.excluded && !r.skipped).length : 0;
        const partialCaption = entry.partialOcr && entry.pagesTotal
          ? `<div class="fr-caption">${ocrPartialCaption(entry.pagesRead, entry.pagesTotal)} &middot; ${partialRowCount} row${partialRowCount === 1 ? '' : 's'} so far</div>`
          : '';
        row.innerHTML = `
          <div class="fr-main">
            <div class="fr-name">${entry.name}</div>
            <div class="fr-line" role="status" aria-live="polite">${label}</div>
            ${partialCaption}
          </div>
          <div class="prog prog-active"><span style="width:${pct}%;"></span></div>`;
        if (partialRowCount > 0) {
          const copyPartialBtn = document.createElement('button');
          copyPartialBtn.className = 'icon-btn'; copyPartialBtn.type = 'button';
          copyPartialBtn.textContent = `Copy ${partialRowCount} row${partialRowCount === 1 ? '' : 's'} so far`;
          copyPartialBtn.onclick = async () => {
            const ready = (entry.rows || []).filter((r) => !r.excluded && !r.skipped);
            const tsv = buildTsv(ready, exportPreset(), { includeSourceColumns });
            try {
              await navigator.clipboard.writeText(tsv);
              toast(`Copied ${ready.length} rows (${ocrPartialCaption(entry.pagesRead, entry.pagesTotal)})`);
            } catch {
              toast('Clipboard access was denied.');
            }
          };
          row.appendChild(copyPartialBtn);
        }
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'icon-btn'; cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => {
          if (entry.ocrRunning) { cancelOcr(entry); return; }
          if (entry.workerJobId && worker) worker.postMessage({ type: 'cancel', jobId: entry.workerJobId });
          state.files = state.files.filter((f) => f !== entry);
          mergeDuplicates();
          renderAll(); onFilesChanged?.();
        };
        row.appendChild(cancelBtn);
      } else if (status === 'error') {
        row.innerHTML = `
          <div class="fr-main">
            <div class="fr-name">${escapeHtml(entry.name)}</div>
            <div class="fr-line"><span class="badge badge-danger">${escapeHtml(entry.error)}</span></div>
          </div>`;
        // The row's own Remove control (appended below, every status gets one)
        // already covers this file - no bespoke removeBtn needed here.
        if (entry.readError) {
          const copyBtn = document.createElement('button');
          copyBtn.className = 'icon-btn'; copyBtn.type = 'button'; copyBtn.textContent = 'Copy debug log';
          copyBtn.onclick = () => copyDebugLog();
          row.appendChild(copyBtn);
        }
      } else if (status === 'healthy') {
        // A file some/all of whose rows were merged away must still show its
        // OWN pre-merge extraction here, not whatever's left in `entry.rows`
        // (which cross-file dedupe can shrink to zero) - never "no dated
        // rows · 0 rows" for a file that actually had dated rows (Finding 1).
        const rowCount = entry.mergedInto ? entry.mergedInto.total : fileSummary(entry.rows).rowCount;
        // groupedCheckLabel was computed and stored at parse time, against
        // this file's own pre-merge row count - never recomputed here, since
        // entry.rows can since have shrunk (even to zero) from dedupe merge.
        const badge = healthBadge(entry.rows, { groupedMismatch: entry.groupedCheckLabel ?? null });
        const flagged = badge.tone !== 'ok';
        // Fix item 1: the row heading is the account (or, before anything's
        // known about it yet, the filename) - never the profile's own mapping
        // name - and the one status line is plain words, not a coloured
        // pill. Every hook below (data-*) exists for dev/e2e-*.mjs scripts
        // that used to read the old badge text/profile name - nothing here
        // is rendered as visible text.
        const displayName = entry.accountLabel || entry.profile?.name || entry.name;
        // Item 8: the row's label can change once (filename -> account label)
        // right after Save - fade it in over 300ms so it reads as a rename,
        // never a silent swap, and never on every render (only when the text
        // just changed since the last one).
        const renamed = entry._prevDisplayName != null && entry._prevDisplayName !== displayName;
        entry._prevDisplayName = displayName;
        // The original file name stays visible as a quiet caption whenever
        // the label is no longer just the filename, so "where did my file
        // go" never has to be asked.
        const sourceNameCaption = displayName !== entry.name ? `<div class="fr-caption">${escapeHtml(entry.name)}</div>` : '';
        const statusText = flagged ? 'Needs a quick look' : `Done, ${rowCount} transaction${rowCount === 1 ? '' : 's'}`;
        row.dataset.profileName = entry.profile?.name || '';
        row.dataset.fileType = normalizedFileType(entry);
        row.dataset.rowCount = String(rowCount);
        row.dataset.warnCount = String(warningRowCount(entry.rows));
        const ocrCaption = entry.ocr ? '<div class="fr-caption">Read with text recognition</div>' : '';
        const mergedCaption = entry.mergedInto
          ? `<div class="fr-caption">${mergedRowsCaption(entry.mergedInto.count, entry.mergedInto.total, entry.mergedInto.into)}</div>`
          : '';
        const dupCaption = entry.duplicateDropped
          ? `<div class="fr-caption">${duplicateDroppedCaption(entry.duplicateDroppedSameFile, entry.duplicateDroppedFrom)}</div>`
          : '';
        // Item 13: after "Use an existing profile" applies cleanly, a quiet
        // inline confirm offers to teach that profile this file's own
        // signals (learnSignatures) - Yes/No, no separate card.
        const learnCaption = entry.offerLearnSignatures
          ? `<div class="fr-caption fr-learn-prompt">Recognise files like this as ${entry.profile?.name || 'this statement type'} from now on? <a href="#" class="learn-yes">Yes</a> / <a href="#" class="learn-no">No</a></div>`
          : '';
        // Password prompt block (Track 2): offered once, right after a
        // password-protected PDF's first successful unlock this session.
        const rememberHintCaption = renderRememberHintCaption(entry);
        // Item 14a: a file unchecked in the drawer's Sources list still shows
        // up here (nothing was removed), just with a quiet note that it
        // isn't part of the export right now.
        const notIncludedCaption = entry.includeInExport === false
          ? '<div class="fr-caption">Not included in export</div>'
          : '';
        // Item 2: a user profile that lost a quality-scored tie to the
        // profile actually used gets named here, with a way straight into
        // Profiles to fix or delete it - never silent about which of the
        // user's own saved profiles couldn't read this file.
        const qualityLoserCaption = entry.qualityLoser
          ? `<div class="fr-caption">${candidateLossCaption(entry.profile?.name || entry.name, entry.qualityLoser.name)} <a href="#" class="fix-or-delete-profile-link">Fix or delete '${entry.qualityLoser.name}'</a></div>`
          : '';
        // Item 5: a grouped-count mismatch severe enough to be 'danger' (red,
        // > 5% gap) also offers a direct "Update mapping" link next to the
        // status line - a small ('warn'/neutral) gap does not, it's just a caption.
        const updateMappingLink = badge.showUpdateMappingLink
          ? ' <a href="#" class="rs-link badge-update-mapping">Set up again</a>'
          : '';
        // The status stays a real link (not just coloured text) when there's
        // somewhere for it to go - Review, pre-filtered to this file's
        // flagged rows - but it's plain text otherwise ("no badges" - see
        // workspace.css's .file-row .badge, which drops every bit of pill
        // chrome so this never looks like the old coloured chip).
        const statusTag = flagged ? 'a' : 'span';
        const statusHref = flagged ? ' href="#"' : '';
        row.innerHTML = `
          <div class="fr-main">
            <div class="fr-name${renamed ? ' fr-name-renamed' : ''}">${escapeHtml(displayName)}</div>
            ${sourceNameCaption}
            <div class="fr-line"><${statusTag} class="badge badge-${badge.tone}"${statusHref}>${escapeHtml(statusText)}</${statusTag}>${updateMappingLink}</div>
            ${ocrCaption}
            ${mergedCaption}
            ${dupCaption}
            ${notIncludedCaption}
            ${qualityLoserCaption}
            ${learnCaption}
            ${rememberHintCaption}
          </div>`;
        wireRememberHintLink(row, entry);
        if (flagged) {
          // Item 5: opens Review pre-filtered to warnings, first flagged row
          // selected (Section B's review.showFile signature) - the row's own
          // decision cards (above, on Home) cover fixing a flagged row
          // without ever needing this; it stays as a fallback into the full
          // Review screen.
          row.querySelector(`.badge-${badge.tone}`).addEventListener('click', (e) => {
            e.preventDefault();
            onReviewFile?.(entry, { filter: 'warnings' });
          });
          row.querySelector('.badge-update-mapping')?.addEventListener('click', (e) => {
            e.preventDefault();
            onOpenWizard(entry, { forceUpdateMapping: true });
          });
        }
        if (entry.qualityLoser) {
          row.querySelector('.fix-or-delete-profile-link').addEventListener('click', (e) => {
            e.preventDefault();
            onFocusProfile?.(entry.qualityLoser.id);
          });
        }
        if (entry.offerLearnSignatures) {
          row.querySelector('.learn-yes').addEventListener('click', async (e) => {
            e.preventDefault();
            const { profileId, versionId } = entry.offerLearnSignatures;
            entry.offerLearnSignatures = null;
            try {
              await learnSignatures(storage, profileId, versionId, buildLearnSignals(entry));
              log('home.learnSignatures', 'learned new signatures for a re-matched file', { profileId, versionId, file: entry.name });
            } catch (err) {
              logError('home.learnSignatures', err, { profileId, versionId, file: entry.name });
            }
            renderAll();
          });
          row.querySelector('.learn-no').addEventListener('click', (e) => {
            e.preventDefault();
            entry.offerLearnSignatures = null;
            renderAll();
          });
        }
        // Fix item 1: no standalone "Review" link any more - Check a
        // statement lives in the gear menu and, for a flagged row, right on
        // this row's own status text (see the "flagged" branch above) or the
        // "N rows need a quick look" decision cards.
      } else if (status === 'unreadableDates') {
        // C1b: the action (Update mapping / Remove) lives in the attention
        // card; the row itself just carries the plain status, same pattern as
        // ocrFailed/layoutChanged below.
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${escapeHtml(entry.name)}</div><div class="fr-line"><span class="badge badge-danger">Most rows have no usable date</span></div></div>`;
      } else if (status === 'noTransactions') {
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${escapeHtml(entry.name)}</div><div class="fr-line"><span class="badge badge-new">No transactions found</span></div></div>`;
      } else if (status === 'ocrCancelled') {
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${entry.name}</div><div class="fr-line">Reading cancelled</div></div>`;
        const again = document.createElement('a');
        again.className = 'rs-link'; again.href = '#'; again.textContent = 'Read again';
        again.style.color = 'var(--ink-dim)'; again.style.textDecoration = 'underline';
        again.onclick = (e) => { e.preventDefault(); entry.ocrCancelled = false; enqueueOcr(entry); };
        row.appendChild(again);
      } else if (status === 'ocrFailed') {
        // The action (use the CSV instead, or remove) lives in the
        // "Could not read this PDF" card below; the row's own caption is
        // just the one-line status, per every other row on Home.
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${escapeHtml(entry.name)}</div><div class="fr-line"><span class="badge badge-danger">Could not read this PDF</span></div></div>`;
      } else if (status === 'imageOnly') {
        // Transient: enqueueOcr is called in the same tick an image-only
        // PDF is detected, so this normally never paints (see home.js's
        // handleFiles). Kept as a safe fallback caption, no card.
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${entry.name}</div><div class="fr-line">Preparing text recognition&hellip;</div></div>`;
      } else if (status === 'ocrQueued') {
        // Item 7: waiting behind another file's OCR run (one shared
        // Tesseract worker, one file at a time) - "Cancel" here just drops
        // it out of the queue, no abort needed since it never started.
        const position = ocrQueuePosition(entry);
        const ordinal = position === 2 ? '2nd' : position === 3 ? '3rd' : `${position}th`;
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${entry.name}</div><div class="fr-line">Waiting for text recognition (${ordinal} in queue)</div></div>`;
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'icon-btn'; cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => cancelOcr(entry);
        row.appendChild(cancelBtn);
      } else if (status === 'new') {
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${escapeHtml(entry.name)}</div><div class="fr-line"><span class="badge badge-new">New bank statement</span></div></div>`;
      } else if (status === 'layoutChanged') {
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${escapeHtml(entry.name)}</div><div class="fr-line"><span class="badge badge-danger">Layout seems to have changed</span></div></div>`;
      } else if (status === 'matchFailed') {
        // Item A: the action (Update mapping / Use an existing profile) lives
        // in the card below; the row just carries the plain status.
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${escapeHtml(entry.name)}</div><div class="fr-line"><span class="badge badge-danger">None of your statement types could read this file</span></div></div>`;
      } else {
        // lowConfidence
        row.innerHTML = `<div class="fr-main"><div class="fr-name">${escapeHtml(entry.name)}</div><div class="fr-line"><span class="badge badge-low">Needs confirmation</span></div></div>`;
      }
      // Item B: a transient notice when this exact file was just re-dropped -
      // works regardless of the row's own status above.
      if (entry.dropAgainNotice) {
        const notice = document.createElement('div');
        notice.className = 'fr-caption';
        notice.textContent = 'Dropped again, already here.';
        row.querySelector('.fr-main')?.appendChild(notice);
      }
      // Item: every row, whatever its status, gets a quiet Remove control at
      // the right end - appended last so it's always the rightmost child.
      row.appendChild(renderRemoveButton(entry));
      container.appendChild(row);
    });
  }

  /** Quiet icon button, visible on hover/focus, reachable by keyboard always - see removeFile(). */
  function renderRemoveButton(entry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn remove-file-btn';
    btn.setAttribute('aria-label', `Remove ${entry.name}`);
    btn.title = 'Remove';
    btn.textContent = '✕';
    btn.onclick = () => removeFile(entry);
    return btn;
  }

  /**
   * Item 1: for a grouped-rowModel PDF, run the same countCheckGrouped the
   * wizard's Test step runs, and return its mismatch label (or null when it
   * matches) for healthBadge. Must only be called at parse time, before
   * mergeDuplicates() can shrink entry.rows - callers store the result on
   * the entry rather than calling this again later (see the pre-merge note
   * where it's invoked).
   */
  function groupedMismatchLabel(entry) {
    if (entry.matchedVersion?.pdf?.rowModel !== 'grouped' || !entry.pdfSourceText) return null;
    const cc = countCheckGrouped(entry.pdfSourceText, entry.rows.length);
    if (cc.matches) return null;
    return groupedCountLabel(cc.extracted, cc.amountLines, cc.diff, cc.matches);
  }

  function formatRangeLabel(startISO, endISO) {
    return startISO === endISO ? formatShortDate(startISO) : `${formatShortDate(startISO)} to ${formatShortDate(endISO)}`;
  }

  let lastCardKeys = '';
  function renderAttentionCards() {
    const container = $('#attention-cards');
    container.innerHTML = '';
    // A stale toast must never sit over a newly mounted card: when the set of
    // cards changes, hide any toast that is still showing.
    const cardKeys = attentionCards(state.files).map((c) => `${c.kind || c.type || ''}:${c.name || c.fileId || ''}`).join('|');
    if (cardKeys !== lastCardKeys) {
      lastCardKeys = cardKeys;
      const t = $('#home-toast');
      if (t && !t.hidden) { t.hidden = true; t.classList.remove('shown'); clearTimeout(t._timer); }
    }
    // Item 5: a row-level warning is no longer its own per-file card (a
    // single "Review N rows" button that jumped to Review) - every flagged
    // row across every file becomes one decision-row in the shared "N rows
    // need a quick look" banner rendered below instead (renderDecisionBanner).
    const cards = [...attentionCards(state.files)].filter((c) => c.kind !== 'warnings');

    // The duplicate-merge notice is purely informational (nothing to
    // decide, just an Undo) - it lives in its own quiet line under the file
    // list, never inside "Needs a look" (C2), which is reserved for real
    // action items (missingRate really does block export, so it stays here).
    const missing = missingRatePairs();
    if (missing.length) cards.push({ kind: 'missingRate', pairs: missing });

    // Fix item 3: no shared "Needs a look" section label above these - each
    // card/the decision banner already carries its own plain heading
    // ("New bank statement", "3 rows need a quick look", ...).
    const decisionRows = flaggedDecisionRows(state.files);
    for (const card of cards) container.appendChild(renderCard(card));
    if (decisionRows.length) container.appendChild(renderDecisionBanner(decisionRows));

    renderDedupeNotice();
  }

  // --- Item 5: the "N rows need a quick look" decision list -----------------
  // One flat, collapsible list across every healthy file's flagged rows
  // (home-state.js's flaggedDecisionRows), each row showing a snippet of the
  // page/line it came from, the plain reason it was flagged, and two actions:
  // "Looks right" (rowedit.js's resolveConfirm - clears the row's warning
  // flags) or "Fix" (an inline date/description/amount edit, resolveEdit).
  // Both reuse Review's own pure row-action logic rather than re-implementing
  // confirm/edit here, so a row resolved from Home behaves identically to one
  // resolved from Review (same undo stack, same "edited from X" bookkeeping).

  function renderDecisionBanner(entries) {
    const details = document.createElement('details');
    details.className = 'decision-banner';
    details.open = true;
    details.setAttribute('role', 'listitem');
    const count = entries.length;
    details.innerHTML = `<summary>${count} row${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} a quick look</summary><div class="decision-list"></div>`;
    const list = details.querySelector('.decision-list');
    for (const entry of entries) list.appendChild(renderDecisionRow(entry));
    return details;
  }

  /** First real (non-informational) flag on a row, worded plainly - reuses checks.js's shared flag-label map so Home, Review and the wizard never word the same flag differently. */
  function decisionReasonLabel(row) {
    const flag = (row.flags || []).find((f) => f !== 'ocr' && f !== 'pending');
    return flag ? rowFlagLabel(flag, row) : 'Needs a second look.';
  }

  function renderDecisionRow({ file, row }) {
    const el = document.createElement('div');
    el.className = 'decision-row';
    el.setAttribute('role', 'listitem');

    const snippet = document.createElement('div');
    snippet.className = 'decision-snippet';
    snippet.textContent = 'Loading…';
    loadDecisionSnippet(file, row, snippet);

    const body = document.createElement('div');
    body.className = 'decision-body';
    body.innerHTML = decisionBodyHtml(row);

    const choices = document.createElement('div');
    choices.className = 'decision-choices';
    const goodBtn = document.createElement('button');
    goodBtn.type = 'button'; goodBtn.className = 'btn btn-choice good'; goodBtn.textContent = 'Looks right';
    goodBtn.onclick = () => resolveDecisionRow(file, row, resolveConfirm(row), 'Marked as looks right.');
    const fixBtn = document.createElement('button');
    fixBtn.type = 'button'; fixBtn.className = 'btn btn-choice fix'; fixBtn.textContent = 'Fix';
    fixBtn.onclick = () => openDecisionFix(body, file, row);
    choices.append(goodBtn, fixBtn);

    el.append(snippet, body, choices);
    return el;
  }

  function decisionBodyHtml(row) {
    const amount = row.amount != null ? (row.amount / (10 ** decimalsFor(row.currency))).toFixed(decimalsFor(row.currency)) : '';
    const amountClass = row.amount != null ? (row.amount < 0 ? 'amount-out' : 'amount-in') : '';
    const parts = [row.date, escapeHtml(row.description_raw || ''), amount ? `<span class="num ${amountClass}">${amount}${row.currency ? ` ${row.currency}` : ''}</span>` : null].filter(Boolean);
    return `<div class="db-txn">${parts.join(' &middot; ')}</div><div class="db-why">${escapeHtml(decisionReasonLabel(row))}</div>`;
  }

  /** Item 5's page/line snippet: a small crop around the row's own page anchor for a PDF (pdf-render.js's renderRowSnippet), or the raw CSV source line in monospace when there's no page to crop (a columns-rowModel PDF, or any CSV/XLSX row). */
  async function loadDecisionSnippet(file, row, container) {
    try {
      // Item 5a (root cause): source_y2 - the block's LAST line (e.g. the
      // amount line, when the description spans lines above it) - was being
      // dropped here, so the snippet crop only ever spanned one line around
      // source_y and could miss the row's own amount line entirely, or show
      // a neighbouring transaction's text instead. See pdf-render.js's
      // blockLines/renderRowSnippet doc comments.
      const anchor = row.original?.source_page != null && row.original?.source_y != null
        ? { page: row.original.source_page, y: row.original.source_y, h: row.original.source_h, y2: row.original.source_y2 ?? null }
        : null;
      if (file.type === 'pdf' && anchor && file.bytes) {
        const items = file.ocr ? file.ocrPages?.[anchor.page - 1]?.items : null;
        const canvas = await renderRowSnippet(file.bytes, anchor, items ? { items } : {});
        if (canvas) { container.innerHTML = ''; container.appendChild(canvas); return; }
      }
    } catch (err) {
      logError('home.decisionSnippet', err, { file: file.name });
    }
    const line = row.original ? Object.values(row.original).map((v) => String(v ?? '').trim()).filter(Boolean).join('  ') : '';
    container.classList.add('decision-snippet-text');
    // ~2 lines of 13px monospace in the card's 320px box; a raw line longer
    // than that gets its middle elided so the trailing field (the amount,
    // almost always last in a bank export) stays visible instead of getting
    // clipped off the bottom of the 2-line box.
    const MAX_CHARS = 90;
    const shown = line.length > MAX_CHARS ? `${line.slice(0, MAX_CHARS - 20)} … ${line.slice(-17)}` : (line || 'Source line not available.');
    // Item 17: labeled, not a bare monospace dump - "From your file:" makes
    // clear this is the row's own source text, not a debug artifact.
    container.innerHTML = line
      ? `<span class="decision-snippet-label">From your file:</span><span class="decision-snippet-line">${escapeHtml(shown)}</span>`
      : escapeHtml(shown);
  }

  function resolveDecisionRow(file, row, nextRow, announcement) {
    const idx = file.rows.indexOf(row);
    if (idx === -1) return;
    file.rows[idx] = nextRow;
    renderAll();
    onFilesChanged?.();
    autosave();
    if (announcement) announce(announcement);
  }

  /** "Fix": an inline date/description/amount edit in place of the row's own body text, reusing rowedit.js's resolveEdit (same undo-stack contract "Looks right" uses). */
  function openDecisionFix(body, file, row) {
    const original = body.innerHTML;
    const amountStr = row.amount != null ? (row.amount / (10 ** decimalsFor(row.currency))).toFixed(decimalsFor(row.currency)) : '';
    body.innerHTML = `
      <div class="decision-fix-form">
        <input type="date" class="decision-fix-date" value="${row.date || ''}" aria-label="Date">
        <input type="text" class="decision-fix-desc" value="${escapeHtml(row.description_raw || '')}" aria-label="Description">
        <input type="text" class="decision-fix-amount" value="${amountStr}" aria-label="Amount">
        <button type="button" class="btn btn-brass btn-sm decision-fix-save">Save</button>
        <button type="button" class="btn btn-ghost btn-sm decision-fix-cancel">Cancel</button>
      </div>`;
    body.querySelector('.decision-fix-cancel').onclick = () => { body.innerHTML = original; };
    body.querySelector('.decision-fix-save').onclick = () => {
      const fields = {
        date: body.querySelector('.decision-fix-date').value || row.date,
        description_raw: body.querySelector('.decision-fix-desc').value,
      };
      const parsed = parseAmount(body.querySelector('.decision-fix-amount').value, { currency: row.currency });
      if (parsed.minor != null) fields.amount = parsed.minor;
      resolveDecisionRow(file, row, resolveEdit(row, fields), 'Fix saved.');
    };
  }

  function renderDedupeNotice() {
    const el = $('#dedupe-notice-line');
    el.innerHTML = '';
    if (!dedupeNotice) { el.hidden = true; return; }
    el.hidden = false;
    el.appendChild(renderCard({ kind: 'duplicatesMerged', count: dedupeNotice.count }));
  }

  function renderCard(card) {
    const entry = card.fileIndex != null ? state.files[card.fileIndex] : null;
    const el = document.createElement('div');

    // Every card: a short title, one line of body text, exactly one primary
    // brass button (2-4 word verb label) and at most one quiet secondary
    // text link. No badges here, the file row already carries one; "Copy
    // debug log" stays in the Home header, not on cards.
    if (card.kind === 'ocrFailed') {
      el.className = 'file-card';
      const hint = card.bank
        ? ' Look for Download or Export as CSV on your bank\'s transaction history page.'
        : '';
      el.innerHTML = `<div class="fc-name">Could not read this PDF</div>
        <p class="fc-body">Text recognition could not find any transaction rows in "${card.name}".</p>
        <p class="fc-hint"><strong>Use the CSV from your bank instead.</strong>${hint}</p>
        <div class="fc-actions"></div>`;
      const actionsOcrFailed = el.querySelector('.fc-actions');
      appendSecondaryLink(actionsOcrFailed, 'Report a problem', () => onOpenReport?.(entry));
      const remove = document.createElement('a');
      remove.className = 'rs-link fc-secondary'; remove.href = '#'; remove.textContent = 'Remove';
      remove.onclick = (e) => { e.preventDefault(); removeFile(entry); };
      actionsOcrFailed.appendChild(remove);
    } else if (card.kind === 'noTransactions') {
      // F2: an empty/header-only file has nothing to map - only Remove, no
      // "Map this statement" (mirrors ocrFailed's Remove-only shape above).
      el.className = 'file-card';
      el.innerHTML = `<div class="fc-name">This file has no transactions</div>
        <p class="fc-body">"${card.name}" has no rows to import.</p>
        <div class="fc-actions"></div>`;
      const remove = document.createElement('a');
      remove.className = 'rs-link fc-secondary'; remove.href = '#'; remove.textContent = 'Remove';
      remove.onclick = (e) => { e.preventDefault(); removeFile(entry); };
      el.querySelector('.fc-actions').appendChild(remove);
    } else if (card.kind === 'unreadableDates') {
      // C1b: a failed parse (date/amount unreadable on most rows), not a
      // healthy file with a few warnings - primary action reopens the wizard
      // seeded from the profile that was applied, same as layoutChanged.
      el.className = 'file-card';
      el.innerHTML = `<div class="fc-name">Could not read dates</div>
        <p class="fc-body">"${card.name}" has no usable date (or amount) for most rows. Its saved mapping likely no longer matches this file's columns.</p>
        <div class="fc-actions"></div>`;
      const actions = el.querySelector('.fc-actions');
      actions.appendChild(mkBtn('btn-brass', 'Set up again', () => onOpenWizard(entry)));
      appendSecondaryLink(actions, 'Remove', () => removeFile(entry));
      appendSecondaryLink(actions, 'Report a problem', () => onOpenReport?.(entry));
    } else if (card.kind === 'new') {
      // Item 5: the mockup's "New bank statement" card - one brass primary
      // action ("Set up", calling the same wizard.open entry point every
      // other statement-mapping path uses) and a quiet fallback for a file
      // that's actually a known layout that slipped under the match threshold.
      el.className = 'file-card new-bank-card';
      el.innerHTML = `<div class="nb-text"><div class="fc-name">New bank statement</div>
        <p class="fc-body">"${card.name}". Let's set it up, takes about a minute.</p></div>
        <div class="fc-actions"></div>`;
      const actions = el.querySelector('.fc-actions');
      actions.appendChild(mkBtn('btn-brass', 'Set up', () => onOpenWizard(entry)));
      // Item 12: dead weight on a first run with zero saved profiles - there is nowhere for
      // it to go with zero saved statement types.
      if (savedProfileCount > 0) appendSecondaryLink(actions, 'Use a statement type I already set up', () => openProfilePicker(entry));
    } else if (card.kind === 'layoutChanged') {
      el.className = 'file-card';
      el.innerHTML = `<div class="fc-name">Layout changed</div>
        <p class="fc-body">"${card.name}" no longer matches ${card.profileName}'s saved layout.</p>
        <div class="fc-actions"></div>`;
      const actions = el.querySelector('.fc-actions');
      actions.appendChild(mkBtn('btn-brass', 'Set up again', () => onOpenWizard(entry)));
      // Item 13: when this "Layout changed" reading came from a wrong pick
      // in the existing-profile picker (checks failed), the way out is back
      // into that picker, not a blind "use it anyway" over failing checks.
      if (entry.pickedProfileFailed) {
        appendSecondaryLink(actions, 'Pick a different statement type', () => openProfilePicker(entry));
      } else {
        appendSecondaryLink(actions, 'Use anyway', () => applyMatchToFile(entry, entry.matches[0]));
      }
    } else if (card.kind === 'matchFailed') {
      // Item A: every ranked candidate profile was tried automatically and
      // none produced usable rows - a real extraction failure, not a
      // confirm-this-guess question.
      el.className = 'file-card';
      el.innerHTML = `<div class="fc-name">Could not read this statement with ${card.profileName}</div>
        <p class="fc-body">"${card.name}" didn't match ${card.profileName} well enough to extract any transactions, and no other saved statement type fit either.</p>
        <div class="fc-actions"></div>`;
      const actions = el.querySelector('.fc-actions');
      actions.appendChild(mkBtn('btn-brass', 'Set up again', () => onOpenWizard(entry)));
      if (savedProfileCount > 0) appendSecondaryLink(actions, 'Use a statement type I already set up', () => openProfilePicker(entry));
      appendSecondaryLink(actions, 'Report a problem', () => onOpenReport?.(entry));
    } else if (card.kind === 'lowConfidence') {
      // Item 13: no raw confidence number in front of a non-technical user -
      // plain words carry the same "this isn't certain" signal.
      el.className = 'file-card';
      el.innerHTML = `<div class="fc-name">Confirm statement type</div>
        <p class="fc-body">This looks like ${card.profileName}, with a small difference. Use it?</p>
        <div class="fc-actions"></div>`;
      const actions = el.querySelector('.fc-actions');
      actions.appendChild(mkBtn('btn-brass', 'Confirm', () => applyMatchToFile(entry, entry.matches[0])));
      // Item 13: "Pick another" now opens the same existing-profile picker
      // the "New statement" card uses, rather than jumping straight to the
      // wizard - the picker's own "Map this as a new statement" link still
      // covers the true new-mapping case.
      appendSecondaryLink(actions, 'Pick another', () => openProfilePicker(entry));
      // 'warnings' is never generated here any more (renderAttentionCards
      // filters it out) - every flagged row is its own decision-row in the
      // shared "N rows need a quick look" banner instead (item 5).
    } else if (card.kind === 'currencyUnknown') {
      el.className = 'file-card';
      el.innerHTML = `<div class="fc-name">Currency unknown</div>
        <p class="fc-body">"${card.name}" has a row with no recognisable currency, e.g. "${card.sample || ''}".</p>
        <div class="fc-actions"></div>`;
      const select = document.createElement('select');
      select.className = 'map-select';
      select.setAttribute('aria-label', `Currency for "${card.name}"`);
      select.innerHTML = ['SGD', 'USD', 'HKD', 'AUD', 'EUR', 'GBP', 'JPY'].map((c) => `<option value="${c}">${c}</option>`).join('');
      const applyBtn = mkBtn('btn-brass', 'Use this currency', () => {
        for (const r of entry.rows) if (r.currency == null) r.currency = select.value;
        entry.currencyResolved = true;
        renderAll(); onFilesChanged?.(); autosave();
      });
      el.querySelector('.fc-actions').append(select, applyBtn);
    } else if (card.kind === 'duplicatesMerged') {
      el.className = 'merge-notice';
      el.innerHTML = `<span><strong>${card.count} row${card.count === 1 ? '' : 's'} merged</strong> from overlapping files.</span>`;
      const undo = document.createElement('a');
      undo.href = '#'; undo.textContent = 'Undo';
      undo.onclick = (e) => { e.preventDefault(); undoDedupe(); };
      el.appendChild(undo);
    } else if (card.kind === 'missingRate') {
      el.className = 'file-card';
      if (rateMode === 'perMonth') {
        // D4: this quick single-flat-rate entry would clobber a per-month
        // rate map with a plain number - send the user to the drawer's full
        // per-month table instead of offering a mismatched shortcut here.
        el.innerHTML = `<div class="fc-name">Missing exchange rate</div>
          <p class="fc-body">Converting to ${targetCurrency} needs a rate for every month for: ${card.pairs.join(', ')}.</p>
          <div class="fc-actions"></div>`;
        appendSecondaryLink(el.querySelector('.fc-actions'), 'Open export settings', () => { drawerOpen = true; renderAll(); });
      } else {
        el.innerHTML = `<div class="fc-name">Missing exchange rate</div>
          <p class="fc-body">Converting to ${targetCurrency} needs a rate for: ${card.pairs.join(', ')}.</p>
          <div class="fc-rate-inputs"></div>
          <div class="fc-actions"></div>`;
        const inputs = el.querySelector('.fc-rate-inputs');
        const pairInputs = new Map();
        for (const pair of card.pairs) {
          const [from] = pair.split('_');
          const wrap = document.createElement('span');
          wrap.style.display = 'inline-flex'; wrap.style.gap = '6px'; wrap.style.alignItems = 'center'; wrap.style.marginRight = '10px';
          const input = document.createElement('input');
          input.className = 'num'; input.placeholder = `1 ${from} =`; input.style.width = '70px';
          input.setAttribute('aria-label', `Rate, ${from} to ${targetCurrency}`);
          pairInputs.set(pair, input);
          const label = document.createElement('span');
          label.textContent = `${from} → ${targetCurrency}`;
          label.style.fontSize = '12px'; label.style.color = 'var(--ink-dim)';
          wrap.append(label, input);
          inputs.appendChild(wrap);
        }
        el.querySelector('.fc-actions').appendChild(mkBtn('btn-brass', 'Enter rate', async () => {
          const next = { ...rates };
          let any = false;
          for (const [pair, input] of pairInputs) {
            const value = Number(input.value);
            if (Number.isFinite(value) && value > 0) { next[pair] = value; any = true; }
          }
          if (!any) return;
          rates = next;
          await storage.set(RATES_KEY, rates);
          renderAll();
        }));
      }
    }
    // duplicatesMerged renders into its own quiet line (#dedupe-notice-line),
    // not the "Needs a look" list, so it never claims a listitem role there.
    if (card.kind !== 'duplicatesMerged') {
      el.setAttribute('role', 'listitem');
      const heading = el.querySelector('.fc-name')?.textContent?.trim();
      if (heading) el.setAttribute('aria-label', heading);
    }
    return el;
  }

  function appendSecondaryLink(actions, label, onClick) {
    const link = document.createElement('a');
    link.className = 'rs-link fc-secondary'; link.href = '#'; link.textContent = label;
    link.onclick = (e) => { e.preventDefault(); onClick(); };
    actions.appendChild(link);
  }

  function mkBtn(cls, label, onClick) {
    const btn = document.createElement('button');
    btn.className = `btn ${cls} btn-sm`; btn.type = 'button'; btn.textContent = label;
    btn.onclick = onClick;
    return btn;
  }

  function renderExportPanel() {
    const panel = $('#export-panel');
    const rows = rowsInRange();
    const readiness = exportReadiness(state.files, { missingRatePairs: missingRatePairs(), rowCountInRange: rows.length });
    panel.hidden = !readiness.hasHealthyFile;
    if (!readiness.hasHealthyFile) return;

    const byAccount = accountsWithRows();
    const warnings = coverageWarnings([...byAccount.entries()].map(([accountLabel, accRows]) => ({ accountLabel, rows: accRows })), currentRange());
    const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];
    const currencyText = currencyMode === 'A'
      ? `Original currencies (${currencies.join(', ') || 'none'})`
      : `Converted to ${targetCurrency}`;
    const notIncludedText = readiness.notIncluded ? `, ${notIncludedLabel(state.files)}` : '';
    // Item 14a: "2 of 3 sources · " only appears once a source is actually
    // unchecked in the drawer - otherwise it's noise on top of the existing
    // account/row summary.
    const sources = sourceFiles();
    const includedSources = sources.filter(sourceIncluded);
    const sourcesSegment = sourcesSummarySegment(includedSources.length, sources.length);
    const sourcesText = sourcesSegment ? `${sourcesSegment} · ` : '';
    // Item 6: no more "(unsaved)" nagging - the working set already IS what
    // exports, whether or not it's ever saved as a named preset.
    // Fix item 2: the result card's own headline is just what's about to be
    // copied (count · statements · date range) - the export configuration
    // (columns/date range filter/sources/currency) moved into the "Adjust
    // what's exported" sheet's own header below, never duplicated here.
    const headlineRange = dateRangeOfRows(rows);
    const headlineRangeLabel = headlineRange ? formatRangeLabel(headlineRange.startISO, headlineRange.endISO) : null;
    $('#export-summary').textContent = resultHeadlineLabel(rows.length, includedSources.length, headlineRangeLabel);
    const settingsSummary = `${sourcesText}Columns: ${columnsSummaryLabel()} · ${rangeSummaryLabel()} · ${accountsSummaryLabel(rows.length, byAccount.size)}${notIncludedText} · ${currencyText}`;
    const drawerTitle = $('#change-drawer-title');
    if (drawerTitle) drawerTitle.innerHTML = `Export settings<br><span class="drawer-settings-summary">${settingsSummary}</span>`;
    // Coordinator note (2026-09-17): renderExportPanel runs on every drawer
    // interaction (a chip click, a picker change), which used to log this
    // line dozens of times a minute for one drop-and-fiddle session with
    // nothing new to say - only log when the composition actually changed.
    const composition = {
      rows: rows.length, accounts: byAccount.size, notIncluded: readiness.notIncluded,
      currencyMode, blocked: readiness.blocked, reasons: readiness.reasons,
    };
    const compositionKey = JSON.stringify(composition);
    if (compositionKey !== lastExportCompositionKey) {
      lastExportCompositionKey = compositionKey;
      log('home.export', 'export composition', composition);
    }

    const copyBtn = $('#copy-tsv-btn');
    const downloadBtn = $('#download-csv-btn');
    copyBtn.disabled = readiness.blocked;
    downloadBtn.disabled = readiness.blocked && rows.length === 0;
    $('#export-blocked-note').textContent = readiness.blocked ? readiness.reasons.join('; ') : '';
    $('#export-warn-note').textContent = warnings.length ? warnings.join('; ') : '';

    // Item 4: while any decision row (the "N rows need a quick look" list)
    // is still unresolved, the headline softens to "Almost ready" and Copy
    // stays clickable but secondary-weighted - never a flat "ready" claim
    // next to a card that's simultaneously asking for a decision. The moment
    // every row is resolved this flips back to the plain ready state.
    const pendingDecisions = flaggedDecisionRows(state.files).length;
    const headingEl = $('#export-heading');
    const pendingNoteEl = $('#export-pending-note');
    if (headingEl) headingEl.textContent = pendingDecisions ? 'Almost ready' : 'Your transactions are ready.';
    if (pendingNoteEl) {
      pendingNoteEl.hidden = !pendingDecisions;
      if (pendingDecisions) pendingNoteEl.textContent = `Resolve ${pendingDecisions} row${pendingDecisions === 1 ? '' : 's'} below, or copy now and check later.`;
    }
    copyBtn.classList.toggle('btn-brass', !pendingDecisions);
    copyBtn.classList.toggle('btn-ghost', !!pendingDecisions);

    renderResultTable();
    renderDrawer();
  }

  // Item 4: the full-width table under the result card, in tableOnly mode -
  // the exact rows/columns Copy for Sheets would produce right now (same
  // rowsForExport() the Copy/Download buttons use), 5 rows visible and
  // scrolling for the rest (preset-editor.js's own footer caption).
  function renderResultTable() {
    const container = $('#result-table');
    if (!container) return;
    renderPresetEditorInto({
      container,
      preset: activePreset,
      previewRows: rowsForExport(),
      previewPreset: exportPreset(),
      tableOnly: true,
    });
  }

  function rangeSummaryLabel() {
    const range = currentRange();
    if (state.rangePreset === 'all') return 'All dates';
    if (!range.startISO && !range.endISO) return 'All dates';
    return formatRangeLabel(range.startISO || '0001-01-01', range.endISO || new Date().toISOString().slice(0, 10));
  }

  // --- Change drawer -----------------------------------------------------

  // Item 9: date range as one compact row of chips plus "Custom" - picking
  // Custom reveals the two date inputs right under the chip row; any other
  // chip hides them again.
  const RANGE_OPTIONS = [
    ['lastFullMonth', 'Last full month'], ['thisMonth', 'This month'],
    ['sinceLastExport', 'Since last export'], ['last3Months', 'Last 3 months'],
    ['ytd', 'Year to date'], ['all', 'All'], ['custom', 'Custom'],
  ];

  function renderRangeChips() {
    const chipRow = $('#range-chip-row');
    chipRow.innerHTML = '';
    for (const [value, label] of RANGE_OPTIONS) {
      const chip = document.createElement('button');
      chip.className = `chip${state.rangePreset === value ? ' active' : ''}`;
      chip.type = 'button'; chip.textContent = label;
      chip.onclick = async () => {
        state.rangePreset = value;
        if (value === 'sinceLastExport') {
          const markers = (await storage.get(LAST_EXPORTED_KEY)) || {};
          const { startISO, endISO, overlapAccounts } = sinceLastExportRange(markers, new Date().toISOString().slice(0, 10));
          customRange = { startISO, endISO };
          $('#since-export-overlap').textContent = overlapAccounts.length
            ? `Re-exporting rows already exported for: ${overlapAccounts.join(', ')}` : '';
        } else {
          $('#since-export-overlap').textContent = '';
        }
        renderAll();
      };
      chipRow.appendChild(chip);
    }
    const customInputs = $('#range-custom-inputs');
    customInputs.hidden = state.rangePreset !== 'custom';
    if (state.rangePreset === 'custom') {
      $('#range-custom-start').value = customRange?.startISO || '';
      $('#range-custom-end').value = customRange?.endISO || '';
    }
  }

  // Item 8: "Your accounts" - one row per account (mapped files sharing an
  // accountLabel), Statements listing the file names that make it up. Merges
  // the old "Coverage by account" and "Sources" tables into one; nothing
  // about accounts lives anywhere else in the sheet.
  function accountGroupsForTable() {
    const byAccount = new Map();
    for (const entry of sourceFiles()) {
      const label = entry.accountLabel || entry.name;
      if (!byAccount.has(label)) byAccount.set(label, []);
      byAccount.get(label).push(entry);
    }
    return [...byAccount.entries()].map(([label, files]) => ({ label, files }));
  }

  function renderAccountsTable() {
    const body = $('#accounts-table-body');
    body.innerHTML = '';
    const groups = accountGroupsForTable();
    if (!groups.length) {
      body.innerHTML = '<tr><td colspan="5" class="pdf-anchor-hint">No statements mapped yet.</td></tr>';
      return;
    }
    const range = currentRange();
    for (const { label, files } of groups) {
      const row = document.createElement('tr');

      const acctCell = document.createElement('td');
      acctCell.textContent = label;

      const stmtCell = document.createElement('td');
      stmtCell.className = 'acc-statements';
      stmtCell.textContent = files.map((f) => f.name).join(', ');

      let includedCount = 0, totalCount = 0;
      for (const f of files) {
        const activeRows = (f.rows || []).filter((r) => !r.excluded && !r.skipped);
        totalCount += activeRows.length;
        includedCount += filterByRange(activeRows, range, dateField).includedCount;
      }
      const rangeCell = document.createElement('td');
      rangeCell.className = totalCount === 0 ? 'mr-count-zero' : '';
      rangeCell.textContent = sourceRangeCountLabel(includedCount, totalCount);

      const includeCell = document.createElement('td');
      const switchLabel = document.createElement('label');
      switchLabel.className = 'switch';
      const switchInput = document.createElement('input');
      switchInput.type = 'checkbox';
      switchInput.checked = files.every((f) => f.includeInExport !== false);
      switchInput.setAttribute('aria-label', `Include ${label} in the export`);
      switchInput.onchange = () => {
        for (const f of files) f.includeInExport = switchInput.checked;
        renderAll();
        onFilesChanged?.();
        autosave();
      };
      switchLabel.append(switchInput, Object.assign(document.createElement('span'), { className: 'slider' }));
      includeCell.appendChild(switchLabel);

      // Actions act on the account's primary (most recently mapped) file -
      // the common case is one statement per account; a multi-statement
      // account still gets a per-file Remove via its Statements list below.
      const primary = files[files.length - 1];
      const actionsCell = document.createElement('td');
      actionsCell.className = 'acc-actions';
      const check = document.createElement('a');
      check.href = '#'; check.textContent = 'Check';
      check.onclick = (e) => { e.preventDefault(); onReviewFile?.(primary); };
      const setup = document.createElement('a');
      setup.href = '#'; setup.textContent = 'Set up again';
      setup.onclick = (e) => { e.preventDefault(); onOpenWizard(primary); };
      const remove = document.createElement('a');
      remove.href = '#'; remove.textContent = 'Remove';
      remove.onclick = (e) => { e.preventDefault(); files.forEach(removeFile); };
      actionsCell.append(check, setup, remove);

      row.append(acctCell, stmtCell, rangeCell, includeCell, actionsCell);
      body.appendChild(row);
    }
  }

  /** "With balance" (a matched built-in layout) or "Customised" (edited away from every layout's own shape). */
  function columnsSummaryLabel() {
    const key = matchLayoutKey(activePreset);
    return key ? LAYOUT_PRESETS.find((l) => l.key === key)?.name : 'Customised';
  }

  function renderDrawer() {
    const drawer = $('#change-drawer');
    drawer.hidden = !drawerOpen;
    if (!drawerOpen) return;

    renderRangeChips();
    $('#date-field-select').value = dateField;
    renderAccountsTable();

    // Currency
    $('#currency-mode-a input').checked = currencyMode === 'A';
    $('#currency-mode-b input[type="radio"]').checked = currencyMode === 'B';
    if (document.activeElement !== $('#target-currency-input')) $('#target-currency-input').value = targetCurrency;
    renderRateTable();

    // Preset editor. Item 1: the same rows/preset Copy for Sheets would
    // produce right now feed the live preview (previewRows/previewPreset) -
    // rowsForExport() already applies the current date range, included
    // sources and currency mode, in export order.
    const liveRows = rowsForExport();
    renderPresetEditorInto({
      container: $('#home-preset-editor'),
      preset: activePreset,
      sampleRows: liveRows,
      previewRows: liveRows,
      previewPreset: exportPreset(),
      profiles: profilesCache,
      fileGroups: fileCoverageGroups(),
      // Item 2 (REBUILD-HOME): no second preview inside the drawer - the
      // ONE result table above it (renderResultTable) is what live-updates.
      showPreview: false,
      // Item 6/7: every edit (a new layout, or a Customise pill) updates the
      // working set immediately and persists it as "Last used" - no "Save as
      // preset" step exists any more.
      onChange: (next) => { activePreset = next; saveLastUsedPrefs(); renderExportPanel(); },
    });

    $('#source-cols-home').checked = includeSourceColumns;
  }

  // D4: 'flat' keeps the original single-rate-per-pair table; 'perMonth'
  // lists one row per (pair, month actually present in the export), each
  // prefilled from any rate already saved for that month - export stays
  // blocked (via the existing missingRatePairs/convertToTarget path) until
  // every month has one.
  function renderRateTable() {
    const body = $('#rate-table-body');
    body.innerHTML = '';
    if (currencyMode !== 'B') { $('#rate-table-wrap').hidden = true; return; }
    $('#rate-table-wrap').hidden = false;
    $('#rate-mode-flat').classList.toggle('active', rateMode === 'flat');
    $('#rate-mode-permonth').classList.toggle('active', rateMode === 'perMonth');
    const rows = allRows();
    const currencies = [...new Set(rows.map((r) => r.currency).filter((c) => c && c !== targetCurrency))];
    for (const cur of currencies) {
      const pair = `${cur}_${targetCurrency}`;
      if (rateMode === 'flat') {
        const rate = typeof rates[pair] === 'number' ? rates[pair] : null;
        const row = document.createElement('tr');
        row.innerHTML = `<td>${cur} &rarr; ${targetCurrency}</td>
          <td><input class="num" data-pair="${pair}" aria-label="Rate, ${cur} to ${targetCurrency}" value="${rate ?? ''}"> ${targetCurrency}</td>
          <td>${rate ? formatBothDirections(cur, targetCurrency, rate) : ''}</td>`;
        const input = row.querySelector('input');
        input.onchange = async () => {
          const value = Number(input.value);
          if (!Number.isFinite(value) || value <= 0) return;
          const saved = typeof rates[pair] === 'number' ? rates[pair] : null;
          if (saved && Math.abs(value - saved) / saved > 0.2) {
            if (!confirm(`New rate for ${pair} differs from the saved rate by more than 20%. Save anyway?`)) return;
          }
          rates = { ...rates, [pair]: value };
          await storage.set(RATES_KEY, rates);
          renderAll();
        };
        body.appendChild(row);
      } else {
        const months = [...new Set(rows.filter((r) => r.currency === cur).map((r) => (r.date || '').slice(0, 7)).filter(Boolean))].sort();
        const savedForPair = typeof rates[pair] === 'object' && rates[pair] ? rates[pair] : {};
        for (const month of months) {
          const rate = savedForPair[month] ?? null;
          const row = document.createElement('tr');
          row.innerHTML = `<td>${cur} &rarr; ${targetCurrency} (${month})</td>
            <td><input class="num" data-pair="${pair}" data-month="${month}" aria-label="Rate, ${cur} to ${targetCurrency} for ${month}" value="${rate ?? ''}"> ${targetCurrency}</td>
            <td>${rate ? formatBothDirections(cur, targetCurrency, rate) : ''}</td>`;
          const input = row.querySelector('input');
          input.onchange = async () => {
            const value = Number(input.value);
            if (!Number.isFinite(value) || value <= 0) return;
            const current = (typeof rates[pair] === 'object' && rates[pair]) ? rates[pair] : {};
            rates = { ...rates, [pair]: { ...current, [month]: value } };
            await storage.set(RATES_KEY, rates);
            renderAll();
          };
          body.appendChild(row);
        }
      }
    }
  }

  function wireDrawer() {
    $('#change-link').addEventListener('click', async (e) => {
      e.preventDefault();
      drawerOpen = !drawerOpen;
      $('#change-link').setAttribute('aria-expanded', String(drawerOpen));
      if (drawerOpen) profilesCache = await loadProfiles(storage);
      renderDrawer();
    });
    $('#date-field-select').addEventListener('change', (e) => { dateField = e.target.value; renderAll(); });
    $('#range-custom-start').addEventListener('change', (e) => {
      customRange = { ...customRange, startISO: e.target.value || null };
      renderAll();
    });
    $('#range-custom-end').addEventListener('change', (e) => {
      customRange = { ...customRange, endISO: e.target.value || null };
      renderAll();
    });
    // Item 9: a single compact currency row - picking a mode is a plain radio
    // choice; typing into the target-currency box also switches to Convert,
    // since editing it only makes sense once that mode is chosen.
    $('#currency-mode-a').addEventListener('click', () => { currencyMode = 'A'; saveLastUsedPrefs(); renderAll(); });
    $('#currency-mode-b').addEventListener('click', () => { currencyMode = 'B'; saveLastUsedPrefs(); renderAll(); });
    $('#target-currency-input').addEventListener('change', (e) => {
      const value = e.target.value.trim().toUpperCase();
      if (!value) return;
      targetCurrency = value;
      currencyMode = 'B';
      saveLastUsedPrefs();
      renderAll();
    });
    $('#rate-mode-flat').addEventListener('click', () => { rateMode = 'flat'; renderAll(); });
    $('#rate-mode-permonth').addEventListener('click', () => { rateMode = 'perMonth'; renderAll(); });
    $('#source-cols-home').addEventListener('change', (e) => { includeSourceColumns = e.target.checked; renderExportPanel(); });
  }

  // --- Export actions ------------------------------------------------------

  async function markLastExported(rows) {
    const markers = (await storage.get(LAST_EXPORTED_KEY)) || {};
    const byAccount = new Map();
    for (const r of rows) {
      if (!r.date || !r.account_label) continue;
      const cur = byAccount.get(r.account_label);
      if (!cur || r.date > cur) byAccount.set(r.account_label, r.date);
    }
    for (const [account, date] of byAccount) {
      if (!markers[account] || date > markers[account]) markers[account] = date;
    }
    await storage.set(LAST_EXPORTED_KEY, markers);
  }

  /** @param {{onUndo?: Function, duration?: number}} [opts] - onUndo adds an "Undo" link, duration overrides the default 3s hide */
  function toast(message, opts = {}) {
    const el = $('#home-toast');
    const hide = () => { el.hidden = true; el.classList.remove('shown'); clearTimeout(el._timer); };
    el.innerHTML = '';
    el.append(message);
    if (opts.onUndo) {
      const undo = document.createElement('a');
      undo.href = '#'; undo.textContent = 'Undo';
      undo.onclick = (e) => { e.preventDefault(); hide(); opts.onUndo(); };
      el.appendChild(undo);
    }
    el.hidden = false;
    el.classList.add('shown');
    clearTimeout(el._timer);
    el._timer = setTimeout(hide, opts.duration ?? 3000);
  }

  async function copyDebugLog() {
    try {
      await navigator.clipboard.writeText(debugLogText());
      log('home.debuglog', 'debug log copied to clipboard');
      toast('Debug log copied to the clipboard');
    } catch (err) {
      logError('home.debuglog', err, { action: 'copy' });
      toast('Clipboard access was denied.');
    }
  }

  // Simple B: Home's own header "Copy debug log" button is gone (no header
  // left on Home at all) - Settings' "Advanced" card (Section 3,
  // #settings-copy-debuglog-btn) covers it now. copyDebugLog() itself stays,
  // still used by a readError file row's own "Copy debug log" button.

  // D2: the untouched default preset widens to include the original amount/
  // currency and the FX rate used, in Mode B (a saved/custom preset the user
  // built themselves is left exactly as they built it - they can add those
  // fields via the preset editor if they want them).
  // Item 6: headerRow lives on the preset itself now (the shared preset-editor
  // component's own "Include header row" checkbox), not a second, separate
  // Home-only checkbox that silently overrode it at export time.
  function exportPreset() {
    if (currencyMode === 'B' && isDefaultPresetColumns(activePreset)) {
      return { ...activePreset, columns: DEFAULT_PRESET_MODE_B.columns };
    }
    return activePreset;
  }

  function wireExport() {
    $('#copy-tsv-btn').addEventListener('click', async () => {
      const rows = rowsForExport();
      const tsv = buildTsv(rows, exportPreset(), { includeSourceColumns });
      try {
        await navigator.clipboard.writeText(tsv);
        toast(`Copied ${rows.length} rows to the clipboard`);
        log('home.export', 'copy outcome', { ok: true, rows: rows.length });
        await markLastExported(rows);
        await saveLastUsedPrefs();
      } catch (err) {
        $('#export-blocked-note').textContent = 'Clipboard access was denied. Use Download CSV instead.';
        logError('home.export', err, { action: 'copy' });
      }
    });
    $('#download-csv-btn').addEventListener('click', async () => {
      const rows = rowsForExport();
      const csv = buildCsv(rows, exportPreset(), { includeSourceColumns });
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dates = rows.map((r) => r.date).filter(Boolean).sort();
      a.href = url;
      a.download = suggestFilename(dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null);
      a.click();
      URL.revokeObjectURL(url);
      toast(`Downloaded ${rows.length} rows`);
      log('home.export', 'download outcome', { ok: true, rows: rows.length });
      await markLastExported(rows);
      await saveLastUsedPrefs();
    });
  }

  // --- Session restore + retention ----------------------------------------

  async function checkRestore() {
    if (!sessionStore || state.files.length) return;
    const saved = await sessionStore.get(SESSION_ID).catch(() => null);
    if (!saved?.files?.length) return;
    restorePending = saved;
    const banner = $('#restore-banner');
    banner.hidden = false;
    const nearing = await sessionsNearingDeletion(sessionStore).catch(() => []);
    const mine = nearing.find((s) => s.id === SESSION_ID);
    $('#restore-deletes-in').textContent = mine ? `Deletes in ${mine.daysRemaining} days.` : '';
  }

  function wireRestoreBanner() {
    $('#restore-yes').addEventListener('click', () => {
      if (restorePending) state.files = restorePending.files;
      restorePending = null;
      $('#restore-banner').hidden = true;
      renderAll();
      onFilesChanged?.();
    });
    $('#restore-no').addEventListener('click', () => {
      restorePending = null;
      $('#restore-banner').hidden = true;
    });
    const clearSessions = async () => {
      if (!confirm('Remove all statements from this tab? Your statement types, column layouts and saved rates are kept.')) return;
      state.files = [];
      if (sessionStore) await sessionStore.delete(SESSION_ID).catch(() => {});
      renderAll();
      onFilesChanged?.();
      announce('All statements removed. Statement types kept.');
      toast('All statements removed. Statement types kept.');
    };
    // Item 6/Section 1: the gear menu's "Clear statements" tile runs this
    // exact confirm - Settings' own "Clear statements" button (Section 3)
    // does the same action independently; this is Home's copy for the tile
    // that sits right next to Home's own drop-to-copy flow.
    $('#tile-clear')?.addEventListener('click', () => { closeGearMenu(); clearSessions(); });
    $('#storage-clear-now-link')?.addEventListener('click', (e) => { e.preventDefault(); clearSessions(); });
  }

  // --- Public ---------------------------------------------------------

  async function render() {
    renderAll();
  }

  function wire() {
    wireDropzone();
    wireExport();
    wireDrawer();
    wireRestoreBanner();
    $('#first-run-how-link').addEventListener('click', () => onShowHow?.());
    $('#add-more-link')?.addEventListener('click', () => $('#file-input').click());
    // Item 6: the gear menu's "Adjust what's exported" tile opens the same
    // drawer as the result card's own quiet link, just from outside it.
    $('#tile-export')?.addEventListener('click', () => { closeGearMenu(); drawerOpen = true; renderDrawer(); });
    loadPrefs().then(() => { checkRestore(); renderAll(); });
    refreshSavedProfileCount();
  }

  // persistSession: exposed so Review can autosave a row resolution (confirm/
  // edit/exclude) into the session the same way Home's own row/file
  // mutations already do, without duplicating the session-shape logic here.
  // Called after the wizard saves a mapping (new profile or updated version):
  // the wizard writes entry.rows/entry.profile directly onto the shared file
  // entry and never goes through applyMatchToFile/applyOcrMatchToFile, so
  // without this the cross-file merge would never run for a freshly-mapped
  // file (item 1: "the merge must run whenever the session's file set
  // changes - drop, remove, mapping saved, undo").
  function onMappingSaved() {
    mergeDuplicates();
    renderAll();
    autosave();
    refreshSavedProfileCount(); // a first-ever Save just created the first profile - the link can now appear
  }

  return { render, wire, renderFileCards: renderFileRows, renderExportPanel, undoDedupe, onMappingSaved, persistSession: autosave, removeFile };
}
