// "Report a problem": assembles the JSON that goes on the clipboard and the
// mailto: draft that opens beside it. Pure - no chrome.*, no DOM, no clock
// (the caller passes `now`) - so every branch is unit-testable without a
// browser.
//
// Item 10: the report used to embed the whole
// (merely field-masked) debug log, which read as "your entire transaction
// list" - a session with real statements in it produced a report shaped
// like one. The report now carries NO per-transaction entries, anonymised or
// not, and no file names at all: only a structural summary per statement
// (see core/session-report.js) - counts, stage timings, the layout model,
// checks, and errors with their stacks' file locations stripped. The
// separate, NEVER-sent "copy full log" action (report/report.js) still
// hands back the raw debug log verbatim for the owner's own troubleshooting.
//
// WHY CLIPBOARD + MAILTO, NOT AN ATTACHMENT: mailto: cannot attach files, and
// its body travels in a URL that mail clients truncate, commonly around a
// couple of thousand characters. So the report goes on the clipboard and the
// mail body carries only the user's own words and a short instruction to
// paste - see ui/report.js for the UI side of this.

import { buildSessionSummary } from './session-report.js';
import { stripKnownFilenames, redactStack } from './anonymize.js';

export const REPORT_VERSION = 2;

// A single constant so it is easy to find and swap. A role address
// (support@, help@) is preferable to a personal mailbox before this ships
// on a public listing - it goes out in every report's mailto: forever.
export const SUPPORT_EMAIL = 'nate@natedesmond.com';

// Hard ceiling for the whole mailto: URL. Mail clients and browsers
// truncate long mailto URLs silently and at inconsistent limits; staying
// well under the commonly cited ~2000 gives the draft a realistic chance of
// arriving intact everywhere.
export const MAX_MAILTO_CHARS = 1800;

// ponytail: a flat per-statement cap, not a byte-size budget like the old
// log truncation - a real session realistically has a handful of statements
// and a few dozen stage events each; upgrade to a byte-aware trim if a
// pathological session ever actually produces a report too big to paste.
export const MAX_STAGES_PER_STATEMENT = 300;

export const PASTE_INSTRUCTION =
  'The report above is on your clipboard. Paste it below this line if you can, ' +
  'but your message and the statement above are usually enough to start with.';

function detectBrowserOS(ua) {
  const s = String(ua || '');
  let browser = 'unknown';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\//.test(s)) browser = 'Opera';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Safari\//.test(s)) browser = 'Safari';
  let os = 'unknown';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Linux/.test(s)) os = 'Linux';
  return { browser, os };
}

function cleanStatement(s, nameToLabel) {
  const scrub = (t) => stripKnownFilenames(t, nameToLabel);
  return {
    label: s.label,
    summary: scrub(s.summary),
    layoutModel: s.layoutModel,
    checks: s.checks,
    flagCounts: s.flagCounts,
    stages: s.stages.slice(-MAX_STAGES_PER_STATEMENT).map((e) => ({ ...e, message: scrub(e.message) })),
    errors: s.errors.map((e) => ({ stage: e.stage, message: scrub(e.message), stack: redactStack(scrub(e.stack)) })),
  };
}

function cleanError(e, nameToLabel) {
  const scrub = (t) => stripKnownFilenames(t, nameToLabel);
  return { stage: e.stage, message: scrub(e.message), stack: redactStack(scrub(e.stack)) };
}

/**
 * Assemble the report object that goes on the clipboard. No per-transaction
 * data, anonymised or not, and no file name ever appears anywhere in this -
 * only the structural summary session-report.js builds.
 * input: {extensionVersion, userAgent, whatHappened, statementLabel, events, now}
 */
export function buildReport(input) {
  input = input || {};
  const events = Array.isArray(input.events) ? input.events : [];
  const { statements, nameToLabel, sessionErrors } = buildSessionSummary(events);
  const { browser, os } = detectBrowserOS(input.userAgent);
  return {
    kind: 'statement-bridge-problem-report',
    reportVersion: REPORT_VERSION,
    extensionVersion: String(input.extensionVersion || 'unknown'),
    browser,
    os,
    createdAt: typeof input.now === 'number' ? input.now : Date.now(),
    whatHappened: typeof input.whatHappened === 'string' ? input.whatHappened : '',
    // The statement the user picked as "the one this is about" - an
    // anonymous label from the list below, never a real file name.
    statement: typeof input.statementLabel === 'string' ? input.statementLabel : '',
    statements: statements.map((s) => cleanStatement(s, nameToLabel)),
    sessionErrors: sessionErrors.map((e) => cleanError(e, nameToLabel)),
  };
}

export function reportToJson(report) {
  return JSON.stringify(report, null, 2);
}

/** The mail draft. Never carries the report - only the user's words, the chosen statement label and the paste instruction - and shrinks whatHappened rather than blow the mailto budget. */
export function buildMailto(input) {
  input = input || {};
  const email = input.email || SUPPORT_EMAIL;
  const version = input.extensionVersion || 'unknown';
  const subject = 'Statement Bridge problem report v' + version;
  const maxChars = typeof input.maxChars === 'number' ? input.maxChars : MAX_MAILTO_CHARS;

  function assemble(what) {
    const lines = [what || '(describe what happened here)', ''];
    if (input.statementLabel) { lines.push('Statement: ' + input.statementLabel, ''); }
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
