// Web worker: runs csv/xlsx/pdf parse jobs off the main thread, reporting
// per-chunk progress and honoring cancellation. Loaded with
// `new Worker(url, {type:'module'})`.
//
// Message in:  { type:'parse', jobId, kind:'csv'|'pdf'|'xlsx', text?, bytes?, version, meta }
//              { type:'cancel', jobId }
// Message out: { type:'progress', jobId, done, total }
//              { type:'result', jobId, rows }
//              { type:'error', jobId, message }
//              { type:'cancelled', jobId }
//
// The message shapes above are unchanged from before per-chunk progress was
// added (only 'xlsx' is new as a `kind`); `runParseJob` below is the pure
// logic behind `self.onmessage`, factored out so it is node-testable with a
// mock `postMessage`/`isCancelled` instead of real Worker globals.

import { applyProfileVersion, papaDelimiter, trimLines } from './core/csv.js';
import { parseXlsxGrid } from './core/xlsx.js';
import { normalizeRecords } from './core/normalize.js';
import { loadPdfPages, groupItemsIntoLines, extractPdfPagesRows } from './core/pdf.js';
import { tagUnmatchedGroupedRows } from './core/checks.js';
import { log, error as logError } from './core/debuglog.js';
// Side-effect import: in a browser module worker this runs the vendored UMD
// bundle as a real ES module, which (per the patched `this` fallback at the
// top of the file) sets `globalThis.Papa`. Under Node's CJS interop for a
// package-json-less repo, the same file executes as CommonJS instead
// (`module.exports=` branch) and this import touches nothing, which is why
// getPapa() below still needs the require() fallback for tests.
import '../vendor/papaparse.min.js';

const CSV_PROGRESS_EVERY_ROWS = 500;

async function getPapa() {
  if (globalThis.Papa) return globalThis.Papa;
  if (typeof process !== 'undefined') {
    // Node test environment: not a real ES module load, so the side-effect
    // import above didn't reach globalThis. require() it directly instead.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    return require('../vendor/papaparse.min.js');
  }
  throw new Error('Papa Parse failed to load in the worker');
}

/**
 * Parse CSV text into a raw grid row-by-row via Papa's `step`, so progress
 * can be reported as rows land and cancellation can stop the parse mid-file
 * (`parser.abort()`), instead of csv.js's `parseGrid` which returns only
 * once the whole file is parsed.
 * @returns {Promise<{grid:string[][], aborted:boolean}>}
 */
export async function parseCsvChunked(text, { delimiter, onProgress, isCancelled } = {}) {
  const Papa = await getPapa();
  // Root-cause fix (2026-09-17): this used to parse `text` raw, a second,
  // independent CSV grid path that missed csv.js's own line-trimming fix -
  // a real Standard Chartered file's leading-tab-padded rows and blank
  // separator lines reached applyProfileVersion untouched here even after
  // parseGrid (used for the initial drop/match) was fixed, so the header
  // row a saved profile expects (a plain small index, post-trim) landed on
  // the wrong raw line once the actual parse ran through the worker,
  // reading as "no transactions found" despite Home showing a clean match.
  // Same trimLines() csv.js's parseGrid uses, so both paths always agree.
  const cleaned = trimLines(text, delimiter);
  const totalLines = cleaned.split(/\r\n|\r|\n/).length;
  const grid = [];
  let aborted = false;
  await new Promise((resolve, reject) => {
    Papa.parse(cleaned, {
      delimiter: papaDelimiter(delimiter),
      skipEmptyLines: false,
      dynamicTyping: false,
      step: (results, parser) => {
        grid.push(results.data);
        if (isCancelled && isCancelled()) { aborted = true; parser.abort(); return; }
        if (onProgress && grid.length % CSV_PROGRESS_EVERY_ROWS === 0) onProgress(grid.length, totalLines);
      },
      complete: () => resolve(),
      error: (err) => reject(err),
    });
  });
  return { grid, aborted };
}

/**
 * Run one parse job and report outcome via `postMessage`. Pulled out of
 * `self.onmessage` so it can be unit tested with a fake postMessage/isCancelled
 * instead of real Worker globals.
 * @param {object} msg - the 'parse' message payload
 * @param {{postMessage:Function, isCancelled:()=>boolean}} io
 */
export async function runParseJob(msg, { postMessage, isCancelled }) {
  const { jobId } = msg;
  try {
    let records;
    let pdfPagesLines = null;
    if (msg.kind === 'csv') {
      const { grid, aborted } = await parseCsvChunked(msg.text, {
        delimiter: msg.version.csv?.delimiter,
        onProgress: (done, total) => postMessage({ type: 'progress', jobId, done, total }),
        isCancelled,
      });
      if (aborted) { postMessage({ type: 'cancelled', jobId }); return; }
      postMessage({ type: 'progress', jobId, done: grid.length, total: grid.length });
      ({ records } = applyProfileVersion(grid, msg.version.csv));
    } else if (msg.kind === 'xlsx') {
      // ponytail: SheetJS parses the whole buffer synchronously, so there is
      // no mid-parse progress or abort point here; cancel is honoured only
      // up to the point the parse starts. Chunk it if a real xlsx file ever
      // proves large enough for this to matter.
      if (isCancelled()) { postMessage({ type: 'cancelled', jobId }); return; }
      postMessage({ type: 'progress', jobId, done: 0, total: 1 });
      const grid = await parseXlsxGrid(msg.bytes);
      if (isCancelled()) { postMessage({ type: 'cancelled', jobId }); return; }
      postMessage({ type: 'progress', jobId, done: 1, total: 1 });
      ({ records } = applyProfileVersion(grid, msg.version.csv));
    } else if (msg.kind === 'pdf') {
      const pages = await loadPdfPages(msg.bytes);
      pdfPagesLines = [];
      for (let idx = 0; idx < pages.length; idx++) {
        if (isCancelled()) { postMessage({ type: 'cancelled', jobId }); return; }
        pdfPagesLines.push(groupItemsIntoLines(pages[idx].items));
        postMessage({ type: 'progress', jobId, done: idx + 1, total: pages.length });
      }
      records = extractPdfPagesRows(pdfPagesLines, msg.version.pdf);
    } else {
      throw new Error(`Unknown parse kind: ${msg.kind}`);
    }

    if (isCancelled()) { postMessage({ type: 'cancelled', jobId }); return; }

    const rows = normalizeRecords(records, msg.version, msg.meta);
    // Item 6: for a grouped-rowModel PDF, tag every extracted row whose
    // source line the loose amount-line counter (checks.js's own count
    // check) never counted with flag 'unmatched_line', and stash the
    // reverse case (a counted line with no row) as rows.missedLines for the
    // count-check details Review/wizard show - the same worker path a real
    // drop takes, not just pipeline.js's buildFileRows (root-cause lesson
    // from the SC delimiter fix: two independent code paths must never
    // diverge on the same check).
    if (msg.kind === 'pdf' && msg.version.pdf?.rowModel === 'grouped' && pdfPagesLines) {
      tagUnmatchedGroupedRows(rows, pdfPagesLines, msg.version.pdf);
    }
    log('worker', 'parse job completed', { jobId, kind: msg.kind, rowCount: rows.length });
    postMessage({ type: 'result', jobId, rows });
  } catch (err) {
    logError('worker', err, { jobId, kind: msg.kind });
    postMessage({ type: 'error', jobId, message: err.message });
  }
}

/* c8 ignore start -- glue over real Worker globals, exercised via runParseJob's tests instead */
if (typeof self !== 'undefined' && typeof self.onmessage !== 'undefined') {
  const cancelled = new Set();
  self.onmessage = async (event) => {
    const msg = event.data;
    if (msg.type === 'cancel') { cancelled.add(msg.jobId); return; }
    if (msg.type !== 'parse') return;
    try {
      await runParseJob(msg, {
        postMessage: (m) => self.postMessage(m),
        isCancelled: () => cancelled.has(msg.jobId),
      });
    } finally {
      cancelled.delete(msg.jobId);
    }
  };
}
/* c8 ignore stop */
