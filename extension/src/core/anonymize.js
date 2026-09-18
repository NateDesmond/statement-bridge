// Strips anything privacy-sensitive out of a debug log before it can leave
// the device in a bug report. Pure (no chrome.*, no DOM), so every branch is
// unit-testable without a browser.
//
// The debug log (core/debuglog.js) is a flat list of events built by many
// call sites across the parsing pipeline: { t, stage, message, data }. Rather
// than trust every future log() call to only ever pass safe fields, this
// walks each event's `data` object and keeps a field ONLY when its key is on
// an explicit allowlist - closed by default, not open by default. Anything
// else is free text (a description, merchant, payee, reference, an OCR/CSV
// cell) and survives only as its length, e.g. "<text 23 chars>".
//
// On top of that, amounts and long digit runs (account numbers, already
// masked by convention upstream, but this is the last line of defence) are
// masked wherever they appear - safe key or not, since an interpolated
// "message"/"stack" could still be quoting one.

// Counts, positions, confidences, flags, timings, ids and labels the report
// needs to be useful - never free text describing a specific transaction.
const SAFE_KEYS = new Set([
  'file', 'fileName', 'name', 'existing', 'bank', 'profile', 'profileId',
  'profileName', 'versionId', 'db', 'kind', 'type', 'path', 'source', 'zone',
  'sourceFile', 'field', 'next', 'message', 'stack',
  'rows', 'rowCount', 'items', 'count', 'extracted', 'extractedCount',
  'sourceLines', 'matches', 'amountLines', 'skippedCount',
  'flaggedRemainder', 'confidence', 'avgConfidence', 'byteLength', 'size',
  'position', 'headerRow', 'row', 'tableStart', 'tableEnd', 'pages',
  'pageCount', 'pageNum', 'totalChars', 'reconciles', 'flagCounts',
  'tone', 'skip', 'ok', 'imageOnly', 'chars', 'sampledLines', 'delimiter',
  'encoding', 'updateProfile', 'reason', 'windows', 'enabled', 'basics',
  'statementType', 'currency', 'country',
]);

const AMOUNT_RE = /-?\d[\d,]*\.\d{2}\b/g;
const LONG_DIGIT_RUN_RE = /\d{6,}/g;

function maskAmountShape(s) {
  return s.replace(AMOUNT_RE, (m) => m.replace(/\d/g, '#'));
}

function maskDigitRuns(s) {
  return s.replace(LONG_DIGIT_RUN_RE, (m) => '#'.repeat(m.length));
}

function redactString(key, value) {
  const masked = maskDigitRuns(maskAmountShape(value));
  if (SAFE_KEYS.has(key)) return masked;
  return `<text ${value.length} chars>`;
}

function walk(key, value) {
  if (typeof value === 'string') return redactString(key, value);
  if (Array.isArray(value)) return value.map((v) => walk(key, v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(k, v);
    return out;
  }
  return value; // numbers, booleans, null, undefined pass through untouched
}

/** Anonymise a debug log's events (the shape core/debuglog.js's all() returns). Pure - never throws on odd input. */
export function anonymizeEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map((e) => ({
    ...e,
    message: typeof e?.message === 'string' ? maskDigitRuns(maskAmountShape(e.message)) : e?.message,
    data: e?.data === undefined ? e?.data : walk('data', e.data),
  }));
}
