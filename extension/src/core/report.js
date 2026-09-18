// "Report a problem": assembles the JSON that goes on the clipboard and the
// mailto: draft that opens beside it. Pure - no chrome.*, no DOM, no clock
// (the caller passes `now`) - so every branch (consent honoured, the size
// guard, the mailto shape) is unit-testable without a browser.
//
// WHY CLIPBOARD + PASTE, NOT AN ATTACHMENT: mailto: cannot attach files, and
// its body travels in a URL that mail clients truncate, commonly around a
// couple of thousand characters. A debug log can be far larger than that. So
// the full report goes on the clipboard and the mail body carries only the
// user's own words, the file name and a short instruction to paste - see
// report/report.js for the UI side of this.

import { anonymizeEvents } from './anonymize.js';

export const REPORT_VERSION = 1;

// A single constant so it is easy to find and swap. A role address
// (support@, help@) is preferable to a personal mailbox before this ships
// on a public listing - it goes out in every report's mailto: forever.
export const SUPPORT_EMAIL = 'nate@natedesmond.com';

// Above this serialized size, the log is trimmed to its most recent entries
// (see truncateLog). The report is destined for the clipboard and then a
// mail body a human has to paste; beyond a few hundred KB some clipboard/
// mail paths fail in ways that look like "nothing happened".
export const MAX_LOG_BYTES = 200 * 1024;

// Hard ceiling for the whole mailto: URL. Mail clients and browsers
// truncate long mailto URLs silently and at inconsistent limits; staying
// well under the commonly cited ~2000 gives the draft a realistic chance of
// arriving intact everywhere.
export const MAX_MAILTO_CHARS = 1800;

export const PASTE_INSTRUCTION =
  'The full report, including the debug log if you included it, is on your ' +
  'clipboard. Paste it below this line if you can, but the file name and ' +
  'description above are usually enough to start with.';

function serializedSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Infinity;
  }
}

/**
 * Trim an already-anonymised log to fit maxBytes, keeping the newest
 * entries (the log is oldest-first, same as core/debuglog.js's events
 * array). Never throws, and drops entirely rather than producing something
 * unserializable.
 * @returns {{log: any[]|null, truncated: boolean, entriesIncluded: number, originalEntries: number, originalBytes: number}}
 */
export function truncateLog(anonEvents, maxBytes) {
  maxBytes = typeof maxBytes === 'number' ? maxBytes : MAX_LOG_BYTES;
  if (!Array.isArray(anonEvents)) {
    return { log: null, truncated: false, entriesIncluded: 0, originalEntries: 0, originalBytes: 0 };
  }
  const originalEntries = anonEvents.length;
  const originalBytes = serializedSize(anonEvents);
  if (originalBytes <= maxBytes) {
    return { log: anonEvents, truncated: false, entriesIncluded: originalEntries, originalEntries, originalBytes };
  }
  // Halve from the oldest end until it fits - O(log n) steps, plenty for a
  // ring buffer capped at 2000 entries.
  let kept = anonEvents;
  while (kept.length > 0 && serializedSize(kept) > maxBytes) {
    kept = kept.slice(Math.ceil(kept.length / 2));
  }
  return { log: kept, truncated: true, entriesIncluded: kept.length, originalEntries, originalBytes };
}

function logNote(includeLog, trim) {
  if (!includeLog) return 'The user chose not to include their debug log.';
  if (!trim.log) return 'No debug log was available yet.';
  if (trim.truncated) {
    return (
      'Debug log TRUNCATED to the ' + trim.entriesIncluded +
      ' most recent entries (of ' + trim.originalEntries +
      ') because the full log was ' + Math.round(trim.originalBytes / 1024) +
      'KB, over the ' + Math.round(MAX_LOG_BYTES / 1024) + 'KB report limit.'
    );
  }
  return 'Full debug log included (' + trim.entriesIncluded + ' entries).';
}

/**
 * Assemble the report object that goes on the clipboard.
 * input: {extensionVersion, userAgent, whatHappened, fileName, includeLog,
 *         events, now, maxLogBytes}
 */
export function buildReport(input) {
  input = input || {};
  const includeLog = input.includeLog !== false;
  const anon = includeLog && Array.isArray(input.events) ? anonymizeEvents(input.events) : null;
  const trim = truncateLog(anon, input.maxLogBytes);
  return {
    kind: 'statement-bridge-problem-report',
    reportVersion: REPORT_VERSION,
    extensionVersion: String(input.extensionVersion || 'unknown'),
    userAgent: String(input.userAgent || 'unknown'),
    createdAt: typeof input.now === 'number' ? input.now : Date.now(),
    fileName: typeof input.fileName === 'string' ? input.fileName : '',
    whatHappened: typeof input.whatHappened === 'string' ? input.whatHappened : '',
    logIncluded: includeLog && !!trim.log,
    logTruncated: trim.truncated,
    logNote: logNote(includeLog, trim),
    // null rather than omitted: an explicit "no log here" reads
    // unambiguously, an absent key reads like a bug in the reporter.
    log: includeLog ? trim.log : null,
  };
}

export function reportToJson(report) {
  return JSON.stringify(report, null, 2);
}

/** The mail draft. Never carries the log - only the user's words, the file name and the paste instruction - and shrinks whatHappened rather than blow the mailto budget. */
export function buildMailto(input) {
  input = input || {};
  const email = input.email || SUPPORT_EMAIL;
  const version = input.extensionVersion || 'unknown';
  const subject = 'Statement Bridge problem report v' + version;
  const maxChars = typeof input.maxChars === 'number' ? input.maxChars : MAX_MAILTO_CHARS;

  function assemble(what) {
    const lines = [what || '(describe what happened here)', ''];
    if (input.fileName) { lines.push('File: ' + input.fileName, ''); }
    lines.push(PASTE_INSTRUCTION);
    const body = lines.join('\n');
    return 'mailto:' + email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  let what = typeof input.whatHappened === 'string' ? input.whatHappened : '';
  let url = assemble(what);
  while (url.length > maxChars && what.length > 0) {
    what = what.slice(0, Math.max(0, what.length - 200)) + '…';
    url = assemble(what);
  }
  return url;
}
