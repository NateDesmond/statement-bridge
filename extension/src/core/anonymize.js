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
// item 10: a real file name, and a profile's display name (every profile is
// user-created since NO-TEMPLATES, so its name can be anything someone
// typed - "Mom's joint account"), are exactly the kind of free text this
// allowlist exists to keep out. 'bank'/'statementType' stay safe: they come
// from the fixed detection vocabulary (suggest.js's BANK_NAMES) and a closed
// enum, never free typing.
const SAFE_KEYS = new Set([
  'bank', 'profileId', 'versionId', 'db', 'kind', 'type', 'path', 'source', 'zone',
  'field', 'message', 'stack',
  'rows', 'rowCount', 'items', 'count', 'extracted', 'extractedCount',
  'sourceLines', 'matches', 'amountLines', 'skippedCount',
  'flaggedRemainder', 'confidence', 'avgConfidence', 'byteLength', 'size',
  'position', 'headerRow', 'row', 'tableStart', 'tableEnd', 'pages',
  'pageCount', 'pageNum', 'totalChars', 'reconciles', 'flagCounts',
  'tone', 'skip', 'ok', 'imageOnly', 'chars', 'sampledLines', 'delimiter',
  'encoding', 'updateProfile', 'reason', 'windows', 'enabled', 'basics',
  'statementType', 'currency', 'country', 'rowModel', 'quickLookRows',
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

// item 10: any bare "something.ext" token still standing in a message/stack
// string is a file name that slipped through structured fields - a last-line
// safety net, not the primary defence (session-report.js never copies a real
// file name into the report in the first place).
const FILENAME_TOKEN_RE = /[^\s"'()]+\.(csv|pdf|xlsx?|txt|png|jpe?g)\b/gi;

/** Replace every occurrence of a known real file name with its anonymous statement label, then scrub any other filename-shaped token. Never throws on odd input. */
export function stripKnownFilenames(text, nameToLabel) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [name, label] of nameToLabel || []) {
    if (name) out = out.split(name).join(label);
  }
  return out.replace(FILENAME_TOKEN_RE, '<file>');
}

/**
 * Strip source-file locations out of a stack trace, keeping only function
 * names - "at parseRow (pdf.js:123:45)" -> "at parseRow". A stack with no
 * recognisable frame form is degraded to a fixed marker rather than left
 * untouched, since it may just be one long unparsed string with a path in it.
 */
export function redactStack(stack) {
  if (typeof stack !== 'string') return stack;
  return stack
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*at\s+)([^(]*)\s*(?:\(.*\))?\s*$/);
      if (m) {
        const fn = m[2].trim().replace(/\s*\d+:\d+$/, '');
        return fn && !/\.(m?js|ts):\d+:\d+$/i.test(fn) ? `${m[1]}${fn}` : `${m[1]}<location>`;
      }
      return line.replace(/\S+\.(m?js|ts):\d+(:\d+)?/gi, '<location>');
    })
    .join('\n');
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
