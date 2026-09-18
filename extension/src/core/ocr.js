// On-device OCR for image-only PDFs (DBS digibank-style scanned statements),
// fully offline: vendor/tesseract/ has no reachable remote fallback (see
// README's "Vendoring Tesseract.js offline" section). The pure parts (word
// grouping, pixel<->PDF-space conversion, whitelist second-pass merge) are
// node-testable with plain objects; ocrPageCanvas itself needs a real
// Tesseract worker + canvas, so it is exercised via the dev harness
// end-to-end check instead (see FASTPATH.md's OCR section).
//
// Output shape matches core/pdf.js's pdf.js-sourced items exactly (str, x, y
// in PDF-space points, plus width/height and a per-item confidence 0-100),
// so groupItemsIntoLines/extractRows/extractGroupedRows consume OCR text the
// same way they consume real pdf.js text content.

import { log } from './debuglog.js';
import { withPdfjs, groupItemsIntoLines, lineText, matchAmountLine } from './pdf.js';
import { renderPageToCanvas } from './pdf-image.js';

const WORKER_PATH = new URL('../../vendor/tesseract/worker.min.js', import.meta.url).href;
const CORE_PATH = new URL('../../vendor/tesseract/tesseract-core-lstm.wasm.js', import.meta.url).href;
const LANG_PATH = new URL('../../vendor/tesseract/', import.meta.url).href; // dir containing eng.traineddata.gz
const AMOUNT_DATE_WHITELIST = '0123456789.,-+SGDUSD/ ';

// Second pass just for amount tokens (see findAmountRetryCandidates below):
// digits, thousands comma, decimal point, sign only - no currency letters,
// since a currency code is already read fine by the first pass and the
// crop is deliberately positioned past it (see retryCropBoxPdf).
const RETRY_WHITELIST = '0123456789.,-+';
// Re-render the source PDF page at this scale for the amount retry crop
// (real extra pixel density from the vector page, not just an upscale of
// the first-pass canvas). 4x, not 3x (2026-09-17 follow-up): compared
// against the source image's own native resolution (real scanned statements
// often embed a 1191x1684px raster on a 595x842pt page, ~2x -
// lower than either retry scale, so there's no real extra detail past
// native resolution either way), then verified empirically via
// dev/_debug-recover.html against three real dropped-decimal
// transactions: 4x alone did not recover any of the three (Tesseract's
// character segmentation gets LESS confident at 4x with no other change,
// see PREPROCESS_RETRY's doc comment for what does help). Kept at 4x since
// it's what the preprocessed fallback pass was validated at.
const RETRY_SCALE = 4;
// A retry result that looks like a properly-decimalled amount: optional
// sign, digits (thousands commas allowed), a decimal point, 1-3 fraction
// digits - same number shape core/pdf.js's matchAmountLine tolerates,
// just requiring the decimal part the first pass was missing.
const RETRY_AMOUNT_WITH_DECIMAL_RE = /^[+-]?[\d,]+\.\d{1,3}$/;

/** Word text that looks like an amount or a date, worth a digit-restricted second pass. */
export function looksLikeAmountOrDate(str) {
  const s = (str || '').trim();
  if (!s) return false;
  if (/^[+-]?[\d,]+\.\d{2}$/.test(s)) return true; // 1,234.56 / -20.83
  if (/^\d{1,2}[/\-.]\d{1,2}([/\-.]\d{2,4})?$/.test(s)) return true; // 01/06/2026
  if (/^[A-Z]{3}$/.test(s)) return true; // SGD / USD
  if (/^\d{1,2}$/.test(s)) return true; // bare day/month number
  return false;
}

/**
 * Convert a Tesseract pixel-space bbox (origin top-left, y down) to
 * PDF-space {x, y, width, height} (origin bottom-left, y up), matching
 * core/pdf.js's item.y convention (larger y = higher on the page). Divides
 * by the render scale used to rasterize the page (see pdf-image.js's
 * renderPageToCanvas), same scale the caller rasterized at.
 * @param {{x0:number,y0:number,x1:number,y1:number}} bbox
 * @param {number} scale
 * @param {number} pageHeightPt - the PDF page height in points
 */
export function pixelBoxToPdfSpace(bbox, scale, pageHeightPt) {
  const x = bbox.x0 / scale;
  const width = (bbox.x1 - bbox.x0) / scale;
  const height = (bbox.y1 - bbox.y0) / scale;
  const y = pageHeightPt - bbox.y1 / scale; // bottom edge of the glyph box, PDF-space
  return { x, y, width, height };
}

/**
 * Turn Tesseract's line/word hierarchy into flat pdf.js-shaped items, one
 * per word, all words in a Tesseract-detected line sharing that line's y
 * (rather than each word's own slightly-jittery bbox), so
 * core/pdf.js's groupItemsIntoLines (tolerance ~2pt) clusters them back
 * into the same line reliably instead of splitting on OCR noise.
 * @param {{bbox:{x0:number,y0:number,x1:number,y1:number}, words:{text:string,confidence:number,bbox:object}[]}[]} lines - Tesseract recognize() result's data.lines
 * @param {number} scale
 * @param {number} pageHeightPt
 * @returns {{str:string,x:number,y:number,width:number,height:number,confidence:number}[]}
 */
export function tesseractLinesToItems(lines, scale, pageHeightPt) {
  const items = [];
  for (const line of lines || []) {
    const lineBox = pixelBoxToPdfSpace(line.bbox, scale, pageHeightPt);
    for (const word of line.words || []) {
      if (!word.text || !word.text.trim()) continue;
      const box = pixelBoxToPdfSpace(word.bbox, scale, pageHeightPt);
      items.push({
        str: word.text,
        x: box.x,
        y: lineBox.y, // shared per-line y, see doc comment above
        width: box.width,
        height: box.height,
        confidence: word.confidence,
      });
    }
  }
  return items;
}

/**
 * Group OCR items into lines by y-CENTER (not top y - a word's own height
 * jitters between OCR runs, but a whole line's vertical center is stable),
 * with a tolerance proportional to this page's own median word height
 * instead of a fixed point value (a scanned page's effective font size
 * varies more than a real pdf.js text layer's does, so one fixed pt
 * tolerance is either too tight for a big-font statement or too loose for a
 * small one). NOT currently wired into ocrPageCanvas/ocrDocument - kept as a
 * tested, working building block. Does not replace core/pdf.js's own
 * groupItemsIntoLines, which every downstream row extractor uses on
 * ocrDocument's final output either way.
 *
 * ponytail (2026-09-17): built for a per-column-band re-OCR pass meant to
 * fix OCBC's 8 misses (REPORT-OCR-GENERALISATION.md - a wrapped
 * description's continuation fusing with the row-below's amount cell at
 * tight leading). That pass (crop each numeric/description column's own
 * x-range for the page's full height, re-recognize each separately, rebuild
 * items from the results) was tried and REVERTED: verified via
 * dev/ocr-recall-audit.mjs to regress previously-clean fixtures (Chase,
 * Maybank) and make OCBC itself worse, not better, after two attempts at a
 * fix (y-alignment snapping across independently-OCR'd bands; excluding the
 * header/preamble from being re-cropped). Root causes that surfaced and
 * weren't fully solved: (1) a column-header word (e.g. "Withdrawal") sits
 * centred over its column rather than aligned to where the DATA cells
 * start, so a crop at a data column's exact x0/x1 can slice straight
 * through it; (2) each band is its own recognize() call, so Tesseract's own
 * line segmentation draws slightly different y's for the same physical row
 * across bands, needing more robust cross-band alignment than a
 * nearest-line snap gave it; (3) inferPdfColumns's own numeric-cluster
 * fallback (when the header can't be read) is sensitive to which OCR
 * misreads happen to show up on a given run, and re-cropping cemented
 * whatever wrong column boundaries came out of a bad run instead of
 * correcting them. Upgrade path: a real 2D layout analysis (cluster by
 * column first using ALL pages worth of numeric samples for stability, not
 * one page's single OCR pass, then re-OCR per band with per-symbol - not
 * per-line - y anchoring) if this bug resurfaces and is worth another pass.
 * @param {{str:string,x:number,y:number,width:number,height:number}[]} items
 * @returns {{y:number, items:object[]}[]} lines, top to bottom, items sorted left to right
 */
export function groupOcrItemsIntoLines(items) {
  if (!items.length) return [];
  const heights = items.map((it) => it.height).filter((h) => typeof h === 'number' && h > 0).sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const tolerance = medianHeight * 0.5;
  const centerY = (it) => it.y + it.height / 2;

  const sorted = [...items].sort((a, b) => centerY(b) - centerY(a) || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    const cy = centerY(item);
    let target = lines.find((l) => Math.abs(l.centerY - cy) <= tolerance);
    if (!target) {
      target = { centerY: cy, items: [] };
      lines.push(target);
    } else {
      target.centerY = (target.centerY * target.items.length + cy) / (target.items.length + 1);
    }
    target.items.push(item);
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  lines.sort((a, b) => b.centerY - a.centerY);
  return lines.map((l) => ({ y: Math.min(...l.items.map((it) => it.y)), items: l.items }));
}

/**
 * Merge a digit/currency-restricted second-pass re-recognition back into the
 * first-pass items: for each entry in `passes` (one per retried item, in the
 * same order as `candidateIndexes`), replace the item only if the second
 * pass reports higher confidence. Pure so it is testable without Tesseract.
 * @param {object[]} items - first-pass items (as from tesseractLinesToItems)
 * @param {number[]} candidateIndexes - indexes into `items` that were retried
 * @param {{str:string, confidence:number}[]} passes - second-pass results, same length/order as candidateIndexes
 * @returns {object[]} new array; items not retried, or not improved, are unchanged
 */
export function mergeSecondPass(items, candidateIndexes, passes) {
  const out = items.slice();
  candidateIndexes.forEach((itemIndex, i) => {
    const pass = passes[i];
    const original = out[itemIndex];
    if (!pass || !original) return;
    if (pass.confidence > original.confidence && pass.str.trim()) {
      out[itemIndex] = { ...original, str: pass.str.trim(), confidence: pass.confidence };
    }
  });
  return out;
}

/**
 * Find amount tokens worth a digit-restricted retry, driven by
 * core/pdf.js's matchAmountLine (the same detector that decides whether a
 * line is a transaction amount at all) rather than by a first-pass word's
 * own shape. This is what catches a fused token like "SGD-173" (currency +
 * sign + digits read as one Tesseract word, no space to split on): it never
 * looks like a bare amount or a currency code on its own, but the LINE it
 * sits on still matches as an amount line, so it is still found here.
 * @param {{str:string,x:number,y:number,width:number,height:number,confidence?:number}[]} items - one page's items (as from tesseractLinesToItems)
 * @returns {{itemIndexes:number[], matchedText:string, prefixEnd:number, hasDecimal:boolean}[]}
 */
export function findAmountRetryCandidates(items) {
  const lines = groupItemsIntoLines(items);
  const candidates = [];
  for (const line of lines) {
    const text = lineText(line);
    const amt = matchAmountLine(text);
    if (!amt) continue;

    // Items whose text overlaps the matched character range, same walk as
    // core/pdf.js's own (unexported) itemsForTextRange over lineText's
    // single-space join.
    const matchItems = [];
    let pos = 0;
    for (const item of line.items) {
      const start = pos;
      const end = pos + item.str.length;
      if (end > amt.index && start < amt.index + amt.length) matchItems.push(item);
      pos = end + 1;
    }
    if (!matchItems.length) continue;
    const itemIndexes = matchItems.map((it) => items.indexOf(it)).filter((i) => i >= 0);
    if (!itemIndexes.length) continue;

    const matchedText = text.slice(amt.index, amt.index + amt.length);
    // Skip past any recognised currency-code/symbol prefix: matchAmountLine's
    // currency capture is always either 3 alnum chars or 1 symbol char, so
    // its length in the raw matched text is exactly amt.currency.length -
    // the retry only ever needs the sign/digits/decimal after it.
    let prefixEnd = amt.currency ? amt.currency.length : 0;
    while (matchedText[prefixEnd] === ' ') prefixEnd++;

    candidates.push({ itemIndexes, matchedText, prefixEnd, hasDecimal: amt.hasDecimal });
  }
  return candidates;
}

/**
 * PDF-space bounding box for one candidate's retry crop: starts just after
 * the currency prefix (candidate.prefixEnd, proportionally placed inside
 * whichever item that character offset falls in - items don't carry
 * per-character geometry, so this is an approximation, good enough for a
 * crop pad to absorb) and spans to the right edge of the matched items.
 * @param {object[]} items - the full page items array (see findAmountRetryCandidates)
 * @param {{itemIndexes:number[], matchedText:string, prefixEnd:number}} candidate
 */
export function retryCropBoxPdf(items, candidate) {
  const matchItems = candidate.itemIndexes.map((i) => items[i]);
  let pos = 0;
  let x0 = null;
  let xEnd = -Infinity;
  let yTop = -Infinity;
  let yBot = Infinity;
  for (const it of matchItems) {
    const start = pos;
    const end = pos + it.str.length;
    if (x0 == null && end > candidate.prefixEnd) {
      const withinOffset = Math.max(0, candidate.prefixEnd - start);
      const frac = it.str.length ? withinOffset / it.str.length : 0;
      x0 = it.x + frac * it.width;
    }
    xEnd = Math.max(xEnd, it.x + it.width);
    yTop = Math.max(yTop, it.y + it.height);
    yBot = Math.min(yBot, it.y);
    pos = end + 1;
  }
  if (x0 == null) x0 = matchItems[0].x;
  return { x0, xEnd, yTop, yBot };
}

/**
 * Merge amount-retry results back into `items`, and apply the low-confidence
 * safety net. Two things happen here, both driven by the SAME candidate
 * list (see findAmountRetryCandidates):
 *  1. Accept a retry: only when the first pass had no decimal and the retry
 *     text is a well-formed decimal amount (RETRY_AMOUNT_WITH_DECIMAL_RE) -
 *     merged as (original currency-prefix text) + (retry text), replacing
 *     every item the match spanned with one item, so a fused token stays
 *     one word and a split token collapses into one corrected word.
 *  2. Safety net: if most of this page's amount candidates DO have a
 *     decimal (by first pass or by a successful retry above), any candidate
 *     that still has none gets its item's confidence forced to 0 - so
 *     normalize.js's low_confidence_ocr flag fires instead of a misread
 *     100x value (e.g. "173" for "1.73") passing silently.
 * @param {object[]} items
 * @param {{itemIndexes:number[], matchedText:string, prefixEnd:number, hasDecimal:boolean, retryStr?:string, retryConfidence?:number}[]} candidates
 * @returns {object[]} new items array (merged candidates collapse to one item each)
 */
export function applyAmountRetryResults(items, candidates) {
  const replacements = new Map(); // itemIndexes[0] -> merged item
  const removedIndexes = new Set(); // itemIndexes[1..] of a merged candidate
  const finalHasDecimal = new Map(); // candidate -> boolean

  for (const candidate of candidates) {
    let hasDecimal = candidate.hasDecimal;
    if (!hasDecimal && candidate.retryStr && RETRY_AMOUNT_WITH_DECIMAL_RE.test(candidate.retryStr)) {
      const prefixText = candidate.matchedText.slice(0, candidate.prefixEnd);
      const first = items[candidate.itemIndexes[0]];
      const last = items[candidate.itemIndexes[candidate.itemIndexes.length - 1]];
      replacements.set(candidate.itemIndexes[0], {
        str: (prefixText + candidate.retryStr).trim(),
        x: first.x,
        y: first.y,
        width: (last.x + last.width) - first.x,
        height: Math.max(...candidate.itemIndexes.map((i) => items[i].height)),
        confidence: candidate.retryConfidence,
      });
      candidate.itemIndexes.slice(1).forEach((i) => removedIndexes.add(i));
      hasDecimal = true;
    }
    finalHasDecimal.set(candidate, hasDecimal);
  }

  const withDecimalCount = candidates.filter((c) => finalHasDecimal.get(c)).length;
  const zeroConfidenceIndexes = new Set();
  if (candidates.length && withDecimalCount / candidates.length > 0.5) {
    for (const candidate of candidates) {
      if (finalHasDecimal.get(candidate)) continue; // a merged replacement always has a decimal by construction above
      zeroConfidenceIndexes.add(candidate.itemIndexes[0]);
    }
  }

  return items
    .map((item, i) => {
      if (replacements.has(i)) return replacements.get(i);
      if (zeroConfidenceIndexes.has(i)) return { ...item, confidence: 0 };
      return item;
    })
    .filter((_, i) => !removedIndexes.has(i));
}

// Only worth a second (whitelist) look at a word Tesseract itself wasn't
// already confident about - a confident correct read gains nothing from a
// retry (mergeSecondPass only replaces on a STRICTLY higher confidence
// anyway) and costs one more recognize() call per page. Speed-only change:
// never changes what a low-confidence word resolves to.
const LOW_CONFIDENCE_RETRY_THRESHOLD = 85;

let sharedWorkerPromise = null;
let cacheCleanupDone = false;

// Coordinator follow-up (2026-09-17, items 9/10): the reported "14.9 MB"
// meter reading was never app session data - it was Tesseract.js's own
// default caching (cacheMethod undefined behaves as 'write') stashing the
// decompressed eng.traineddata into a SEPARATE IndexedDB database
// ("keyval-store", via idb-keyval - vendor/tesseract/worker.min.js's
// readCache/writeCache), confirmed empirically: navigator.storage.estimate()
// jumped from 1,693 bytes to 14,997,839 bytes after one OCR run, entirely
// attributable to a new "keyval-store" database holding one key,
// "./eng.traineddata" (measured via indexedDB.databases() + a per-store byte
// walk - see /tmp/idb-measure.json from that run). The traineddata is
// already embedded in the extension package (vendor/tesseract/tess-data.js);
// there is nothing this cache saves us from re-fetching, so it's pure waste
// against the user's quota. worker.min.js's own write/read gate
// (`["write","refresh",void 0].includes(cacheMethod)` to write,
// `["refresh","none"].includes(cacheMethod)` to skip reading) confirms
// 'none' is a real, supported value that disables both sides of the cache.
const TESSERACT_CACHE_DB = 'keyval-store';

/** Best-effort, once-per-session cleanup of a cache DB from before this fix. */
async function deleteStaleTesseractCache() {
  if (cacheCleanupDone) return;
  cacheCleanupDone = true;
  try {
    if (!globalThis.indexedDB) return;
    const dbs = (await globalThis.indexedDB.databases?.()) || [];
    if (!dbs.some((d) => d.name === TESSERACT_CACHE_DB)) return;
    await new Promise((resolve) => {
      const req = globalThis.indexedDB.deleteDatabase(TESSERACT_CACHE_DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
    log('ocr', 'deleted stale Tesseract traineddata cache database', { db: TESSERACT_CACHE_DB });
  } catch (err) {
    log('ocr', 'could not check/delete stale Tesseract cache database', { message: err.message });
  }
}

/** Create one real Tesseract worker with this module's standard settings (see getSharedWorker's doc comment for why each option is set). */
async function createConfiguredWorker() {
  await deleteStaleTesseractCache();
  const { default: Tesseract } = await import('../../vendor/tesseract/tesseract.esm.min.js');
  const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    workerBlobURL: false, // avoid an extra fetch()-into-Blob of the worker script itself
    gzip: true,
    cacheMethod: 'none', // see the doc comment above - the model is already embedded, caching it a second time just burns ~15MB of the user's quota for nothing
    logger: () => {}, // per-tile progress comes from onProgress below instead
  });
  // PSM 4 ("assume a single column of text of variable sizes") as the
  // default for full-page recognition, set once here rather than per
  // ocrPageCanvas call: per audit/REPORT-OCR-PSM.md's sweep, it's the
  // only psm that both ties Tesseract's own default on every tested
  // fixture (no regression) and improves recall on a real scanned statement (3
  // misses to 2), at ~2% average per-page time cost. Applied to every
  // worker up front, not via TESSERACT_DEFAULTS below, so a per-call
  // tesseractParams override (see ocrPageCanvas) still restores to THIS
  // default afterwards, not Tesseract's own '3'.
  await worker.setParameters({ tessedit_pageseg_mode: '4' });
  return worker;
}

/** Create (once) and reuse a single Tesseract worker across pages/files. */
async function getSharedWorker() {
  if (!sharedWorkerPromise) sharedWorkerPromise = createConfiguredWorker();
  return sharedWorkerPromise;
}

/** Terminate every worker (the shared one, plus the rest of the pool if it was ever created) - call when the OCR feature is no longer needed, e.g. tab close / "Clear sessions". */
export async function terminateOcrWorker() {
  // workerPool's first entry IS sharedWorkerPromise (see getWorkerPool) - use
  // whichever is set so the shared worker is only ever terminated once.
  const pool = workerPool || (sharedWorkerPromise ? [sharedWorkerPromise] : []);
  workerPool = null;
  sharedWorkerPromise = null;
  await Promise.all(pool.map(async (p) => (await p).terminate()));
}

let workerPool = null; // array of worker promises, one document's pages are split across it

/**
 * A small pool of Tesseract workers (2-3, never more than
 * navigator.hardwareConcurrency) so a multi-page document's pages recognise
 * in parallel instead of one at a time. Created once, reused across
 * documents/files for the rest of the session (same reuse rationale as
 * getSharedWorker). The first worker in the pool IS the shared worker (so a
 * single-page document, or the amount-retry pass which always runs on
 * whichever worker did the page's first pass, still only ever touches one
 * worker) - the rest are additional workers for parallel pages.
 */
async function getWorkerPool() {
  const size = Math.max(1, Math.min(3, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2));
  if (!workerPool) {
    workerPool = [getSharedWorker()];
    for (let i = 1; i < size; i++) workerPool.push(createConfiguredWorker());
  }
  return workerPool;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new DOMException('OCR cancelled', 'AbortError');
}

/**
 * Run OCR on one already-rendered page canvas and return pdf.js-shaped
 * positioned text items (see module doc comment for the exact shape).
 * @param {HTMLCanvasElement} canvas - from pdf-image.js's renderPageToCanvas
 * @param {object} [options]
 * @param {number} [options.scale] - the scale the canvas was rendered at (default 2.5, must match renderPageToCanvas)
 * @param {number} [options.pageHeightPt] - PDF page height in points; defaults to canvas.height/scale
 * @param {(done:number, total:number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.restrictNumbers=true] - run the digit/currency-whitelisted second pass on amount/date-like words
 * @param {object} [options.tesseractParams] - extra worker.setParameters() overrides for the first pass only
 *   (e.g. `{ tessedit_pageseg_mode: '6' }`), an accuracy-tuning knob for callers that measure OCR quality
 * @param {import('pdfjs-dist').PDFPageProxy} [options.page] - the source page, so the amount retry (see
 *   findAmountRetryCandidates) can re-render its crop at RETRY_SCALE instead of upscaling the first-pass canvas;
 *   omit in tests that only pass a bare canvas - the retry then falls back to cropping that canvas as-is
 * @param {Promise<object>} [options.workerPromise] - use this worker instead of the shared one (ocrDocument's
 *   worker pool hands each page a different worker so pages recognise in parallel); defaults to the shared worker
 * @returns {Promise<{str:string,x:number,y:number,width:number,height:number,confidence:number}[]>}
 */
export async function ocrPageCanvas(canvas, options = {}) {
  const { scale = 2.5, onProgress, signal, restrictNumbers = true, tesseractParams, page, workerPromise } = options;
  const pageHeightPt = options.pageHeightPt ?? canvas.height / scale;
  throwIfAborted(signal);

  const worker = await (workerPromise || getSharedWorker());
  throwIfAborted(signal);

  // This module's own default for a param not otherwise set (see
  // getSharedWorker's psm=4 setup above for tessedit_pageseg_mode); used to
  // restore state after a caller-supplied override so it doesn't leak into
  // later calls on the shared worker.
  const TESSERACT_DEFAULTS = { tessedit_pageseg_mode: '4', tessedit_char_whitelist: '' };
  if (tesseractParams) await worker.setParameters(tesseractParams);
  onProgress?.(0, restrictNumbers ? 2 : 1);
  const { data } = await worker.recognize(canvas);
  if (tesseractParams) {
    await worker.setParameters(Object.fromEntries(Object.keys(tesseractParams).map((k) => [k, TESSERACT_DEFAULTS[k] ?? ''])));
  }
  throwIfAborted(signal);
  onProgress?.(1, restrictNumbers ? 2 : 1);

  let items = tesseractLinesToItems(data.lines, scale, pageHeightPt);

  if (restrictNumbers) {
    // Speed item (b): only a LOW-confidence amount/date-shaped word is worth
    // a second, whitelist-restricted look - see LOW_CONFIDENCE_RETRY_THRESHOLD's
    // doc comment. The separate amount-line-driven retry below (missing
    // decimal point) is unaffected - that one exists for accuracy, not speed.
    const candidateIndexes = items
      .map((item, i) => (looksLikeAmountOrDate(item.str) && (item.confidence ?? 0) < LOW_CONFIDENCE_RETRY_THRESHOLD ? i : -1))
      .filter((i) => i >= 0);

    if (candidateIndexes.length) {
      await worker.setParameters({ tessedit_char_whitelist: AMOUNT_DATE_WHITELIST });
      const passes = [];
      for (const itemIndex of candidateIndexes) {
        throwIfAborted(signal);
        const item = items[itemIndex];
        const crop = cropCanvasForItem(canvas, item, scale, pageHeightPt);
        const { data: passData } = await worker.recognize(crop);
        passes.push({ str: passData.text, confidence: passData.confidence });
      }
      await worker.setParameters({ tessedit_char_whitelist: '' });
      items = mergeSecondPass(items, candidateIndexes, passes);
    }

    // Second, separate retry: amount-line-driven (see findAmountRetryCandidates's
    // doc comment for why this is a distinct pass from the shape-based one
    // above - it also catches a fused currency+sign+digits token the shape
    // check above never flags at all).
    const amountCandidates = findAmountRetryCandidates(items);
    const needRetry = amountCandidates.filter((c) => !c.hasDecimal);
    if (needRetry.length) {
      let retryCanvas = canvas;
      let retryScale = scale;
      if (page) {
        ({ canvas: retryCanvas } = await renderPageToCanvas(page, RETRY_SCALE));
        retryScale = RETRY_SCALE;
      }
      // ponytail: a PSM 7 ("treat as one text line") override was tried here
      // for the retry crop, on the theory that a tight digit/punctuation crop
      // needs line-mode segmentation instead of the default full-page auto
      // mode. Reverted (2026-09-17): switching tessedit_pageseg_mode on the
      // shared, cross-page worker measurably destabilised OTHER pages' plain
      // first-pass recognition later in the same document (a fixture with 2
      // baseline extras jumped to 41 once this was added) - the vendored
      // Tesseract build doesn't cleanly reset PSM-related internal state
      // between calls, matching the other worker-state fragility already
      // documented below (getSharedWorker's cache note, cropCanvasForItem's
      // "wider crop" ponytail note). Whitelist-only retry (no PSM override)
      // is the stable version. Upgrade path: a SEPARATE, disposable worker
      // instance for the retry pass, so a PSM override there can never leak
      // into the shared worker's later full-page recognitions.
      await worker.setParameters({ tessedit_char_whitelist: RETRY_WHITELIST });
      for (const candidate of needRetry) {
        throwIfAborted(signal);
        const crop = cropRetryRegion(retryCanvas, items, candidate, retryScale, pageHeightPt);
        const { data: passData } = await worker.recognize(crop);
        candidate.retryStr = passData.text.trim();
        candidate.retryConfidence = passData.confidence;

        // See PREPROCESS_RETRY's doc comment: one more attempt, same region,
        // grayscale + light unsharp mask + Otsu threshold, only when the
        // plain retry still shows no decimal.
        if (!candidate.retryStr.includes('.')) {
          const processedCrop = preprocessCropForRetry(cropRetryRegion(retryCanvas, items, candidate, retryScale, pageHeightPt));
          const { data: passData2 } = await worker.recognize(processedCrop);
          const text2 = passData2.text.trim();
          if (text2.includes('.')) {
            candidate.retryStr = text2;
            candidate.retryConfidence = passData2.confidence;
          }
        }
      }
      await worker.setParameters({ tessedit_char_whitelist: '' });
    }
    if (amountCandidates.length) items = applyAmountRetryResults(items, amountCandidates);
  }
  onProgress?.(restrictNumbers ? 2 : 1, restrictNumbers ? 2 : 1);

  log('ocr', 'page recognized', { items: items.length, avgConfidence: avgConfidence(items) });
  return items;
}

function avgConfidence(items) {
  if (!items.length) return 0;
  return items.reduce((sum, it) => sum + (it.confidence || 0), 0) / items.length;
}

// ponytail: rendering a PDF page to a canvas needs pdf.js's own document
// (Window) APIs, and driving that from inside our own dedicated Worker hit a
// real conflict during a feasibility check: pdf.js's fallback "fake worker"
// mode (used whenever it can't spin up a worker-of-a-worker for itself)
// clobbers the enclosing worker's own postMessage/onmessage, so a PDF can
// never be rendered from inside a second worker reliably in this vendored
// pdf.js build. OCR still runs off the main thread where it actually
// matters: `ocrPageCanvas` above hands the canvas to Tesseract's own
// dedicated worker (worker.min.js) and awaits the result, so the wasm
// recognition loop - the expensive part - never blocks the UI thread; only
// the page-render + orchestration loop below runs on the main thread, and it
// is cheap (a canvas paint plus awaits). Upgrade path: a real nested-worker
// PDF renderer (OffscreenCanvas is already what pdf-image.js would need), if
// per-page render time ever becomes the bottleneck instead of recognition.
const OCR_PATH = 'main-thread orchestration + Tesseract\'s own worker for recognition';

/**
 * Run OCR across every page of a PDF and return pdf.js-shaped items per page
 * plus the page text joined for profile matching (same shape home.js already
 * uses for a real-text PDF's page-1 matching). Orchestrates
 * renderPageToCanvas + ocrPageCanvas per page, spreading pages round-robin
 * across a small pool of Tesseract workers (see getWorkerPool) so a
 * multi-page document recognises pages in parallel instead of one at a time.
 * @param {ArrayBuffer} bytes
 * @param {{onProgress?:(page:number,total:number)=>void, onPage?:(page:{pageNum:number,items:object[],avgConfidence:number,ms:number}, pagesSoFar:object[], total:number)=>void, signal?:AbortSignal, scale?:number, fileName?:string}} [opts]
 *   `onPage` fires as soon as EACH page finishes (not necessarily in page-number order, since pages now run in
 *   parallel across workers) with every page done so far sorted by pageNum - the caller (home.js) uses it to show
 *   partial results while later pages are still recognising.
 * @returns {Promise<{pages:{pageNum:number,items:object[],avgConfidence:number,canvas:HTMLCanvasElement,ms:number}[], text:string}>}
 */
export async function ocrDocument(bytes, opts = {}) {
  // Speed item (b) tried scale 2 as the new default (halving pixels vs the
  // old 2.5) and it regressed a real fixture: Anchor Bank (columns, small
  // print) went from 0 misses at 2.5 to 3 at 2 (dev/ocr-recall-audit.mjs,
  // 2026-09-18) - a real accuracy loss, not noise (48/48 at 2.5, 45/48 at 2,
  // reproduced twice). Reverted to 2.5; the worker pool below (item a) is
  // where the real wall-clock win comes from instead (~2.5x on a real
  // 3-page scanned statement: 13.6s -> 5.5s, same 31/31 recall) - see
  // HARDENING.md Track 3's report for the full before/after numbers.
  const { onProgress, onPage, signal, scale = 2.5, fileName } = opts;
  // Item 7: every [ocr] log line names the file it's about - with the queue
  // serializing OCR jobs one at a time, a "page done" line with no file name
  // used to be ambiguous about which of two recently-dropped files it
  // belonged to.
  log('ocr', 'starting document OCR', { path: OCR_PATH, file: fileName });
  return withPdfjs(async (pdfjsLib, standardFontDataUrl) => {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), standardFontDataUrl }).promise;
    const pool = await getWorkerPool();
    const pages = [];
    let doneCount = 0;

    async function runPage(pageNum, workerPromise) {
      throwIfAborted(signal);
      const page = await doc.getPage(pageNum);
      const { canvas } = await renderPageToCanvas(page, scale);
      const startedAt = Date.now();
      const items = await ocrPageCanvas(canvas, { scale, signal, restrictNumbers: true, page, workerPromise });
      const ms = Date.now() - startedAt;
      const pageConfidence = avgConfidence(items);
      const result = { pageNum, items, avgConfidence: pageConfidence, canvas, ms };
      pages.push(result);
      doneCount += 1;
      onProgress?.(doneCount, doc.numPages);
      log('ocr', 'page done', { file: fileName, pageNum, items: items.length, avgConfidence: Math.round(pageConfidence), ms });
      if (onPage) {
        const sorted = [...pages].sort((a, b) => a.pageNum - b.pageNum);
        onPage(result, sorted, doc.numPages);
      }
    }

    // Round-robin: worker i gets pages i, i+size, i+2*size, ... run
    // sequentially within a worker, all workers running concurrently.
    await Promise.all(pool.map(async (workerPromise, workerIndex) => {
      for (let pageNum = workerIndex + 1; pageNum <= doc.numPages; pageNum += pool.length) {
        await runPage(pageNum, workerPromise);
      }
    }));

    pages.sort((a, b) => a.pageNum - b.pageNum);
    // Newline-joined, not space-joined: preserves the document's real line
    // structure (core/checks.js's countCheckGrouped, and any other line-based
    // text check, needs each source line on its own line to count against;
    // matchProfile's keyword/substring checks work identically either way).
    const text = pages.flatMap((p) => groupItemsIntoLines(p.items).map(lineText)).join('\n');
    return { pages, text };
  });
}

// ponytail: a wider left-side crop pad was tried here (2026-09-16) to
// recover a "+"/"-" sign glyph Tesseract's word segmentation sometimes drops
// entirely rather than misreads. It backfired: a wide-enough crop pulls in
// the NEIGHBOURING item too (e.g. an already-correctly-recognized separate
// "-" token right before the amount), so the crop's re-recognition returns
// a multi-word string ("- 20.83") that then overwrites one item's `.str`
// with embedded whitespace - breaking every consumer that assumes one item
// is one word (core/pdf.js's textRangeConfidence's char-offset walk, most
// visibly: it corrupted _amountConfidence on rows that were already correct).
// Reverted. The actual "dropped sign" fix that matters lives in
// core/pdf.js's matchAmountEnd - an amount with no sign at all is read as
// positive, same as the second-pass whitelist mechanism already fixes
// misread (not missing) characters. Upgrade path: recover an actually
// dropped sign glyph by cropping a small, SEPARATE strip immediately to the
// item's left (not widening the item's own crop) and treating a "+"/"-"
// result there as an addition to the item, never a replacement of it.
function cropCanvasForItem(sourceCanvas, item, scale, pageHeightPt) {
  const pad = 4;
  const x0 = Math.max(0, Math.round(item.x * scale) - pad);
  const y0 = Math.max(0, Math.round((pageHeightPt - item.y - item.height) * scale) - pad);
  const w = Math.min(sourceCanvas.width - x0, Math.round(item.width * scale) + pad * 2);
  const h = Math.min(sourceCanvas.height - y0, Math.round(item.height * scale) + pad * 2);
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, w);
  crop.height = Math.max(1, h);
  crop.getContext('2d').drawImage(sourceCanvas, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return crop;
}

/** Crop `sourceCanvas` (rendered at `scale`) to one amount-retry candidate's box (see retryCropBoxPdf), padded. */
function cropRetryRegion(sourceCanvas, items, candidate, scale, pageHeightPt) {
  const box = retryCropBoxPdf(items, candidate);
  const pad = 4;
  const x0 = Math.max(0, Math.round(box.x0 * scale) - pad);
  const y0 = Math.max(0, Math.round((pageHeightPt - box.yTop) * scale) - pad);
  const w = Math.min(sourceCanvas.width - x0, Math.round((box.xEnd - box.x0) * scale) + pad * 2);
  const h = Math.min(sourceCanvas.height - y0, Math.round((box.yTop - box.yBot) * scale) + pad * 2);
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, w);
  crop.height = Math.max(1, h);
  crop.getContext('2d').drawImage(sourceCanvas, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return crop;
}

// PREPROCESS_RETRY (2026-09-17 follow-up): when the plain whitelist retry
// still shows no decimal point, one more attempt on the SAME crop region -
// grayscale, a light unsharp mask (sharpens the small, often anti-aliased-
// soft decimal glyph against the digit strokes around it), then an Otsu
// threshold (picks the binarisation cutoff from the crop's own histogram
// instead of a fixed guess, so it adapts per-crop to scan contrast/lighting
// instead of a single hardcoded number). Verified via dev/_debug-recover.html
// against three real dropped-decimal transactions from a scanned statement: this
// recovered one of the three (a token whose decimal point IS faintly present
// in the source scan); the other two still read with no decimal even here -
// Tesseract's retry text for those came back CONFIDENT (73-84%) that there
// is no dot, which reads as a real image-quality/print-quality limit on
// those two specific marks, not a bug in this pass. A blob/connected-
// component scan for a tiny (1-3px) dot-shaped dark region between digit
// groups, with the found position injected back into the digit string as a
// ".", was also tried and DROPPED: at this resolution, adjacent digit
// strokes routinely merge into one connected component (no dot-sized gap to
// find at all), and mapping a found blob's pixel x back to a character
// offset by simple proportional position (no per-glyph geometry available
// from the crop) misplaced the point in testing (e.g. injecting it before
// the sign, ".-173" instead of "-1.73") - actively worse than leaving the
// safety net to flag the row. Upgrade path: Tesseract's own per-character
// `symbols` bounding boxes (the vendored build supports them, unused
// elsewhere in this codebase) would give real glyph positions to map a
// found blob against, instead of a proportional guess.
function preprocessCropForRetry(crop) {
  const ctx = crop.getContext('2d');
  const w = crop.width;
  const h = crop.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Grayscale.
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

  // Light unsharp mask: pixel + amount*(pixel - boxBlur(pixel)).
  const amount = 0.6;
  const radius = 1;
  const blurred = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) { sum += gray[yy * w + xx]; n++; }
        }
      }
      blurred[y * w + x] = sum / n;
    }
  }
  const sharpened = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) sharpened[p] = Math.max(0, Math.min(255, gray[p] + amount * (gray[p] - blurred[p])));

  // Otsu threshold, picked from the sharpened crop's own histogram.
  const hist = new Array(256).fill(0);
  for (let p = 0; p < sharpened.length; p++) hist[Math.round(sharpened[p])]++;
  const total = sharpened.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let varMax = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) { varMax = varBetween; threshold = t; }
  }

  for (let p = 0, i = 0; p < sharpened.length; p++, i += 4) {
    const v = sharpened[p] > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return crop;
}
