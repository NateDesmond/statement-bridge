// item 10: turns the raw debug log (core/debuglog.js's events) into the
// structural, per-statement summary that goes in a problem report - never a
// file name, description, amount, date or account number, and never a raw
// row array. Built by hand-picking known-safe fields off known event shapes
// (a safelist by RECONSTRUCTION, not by walking arbitrary event data and
// hoping a key-name allowlist never misses one - core/anonymize.js's
// SAFE_KEYS walk is a second, generic line of defence, not the only one).
//
// A statement is identified across events by whatever real file name/id
// value the call sites already log (file/fileName/sourceFile/name/existing) -
// see FILE_KEYS below. That real name only ever exists inside this module;
// everything this module hands back is keyed by the anonymous "Statement N"
// label instead.

const FILE_KEYS = ['file', 'fileName', 'sourceFile', 'name', 'existing'];

function fileKeyOf(data) {
  for (const k of FILE_KEYS) {
    const v = data && data[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function fileTypeLabel(t) {
  if (t === 'pdf') return 'PDF';
  if (t === 'xlsx') return 'Excel';
  if (t === 'text' || t === 'csv') return 'CSV';
  return t ? String(t).toUpperCase() : null;
}

function lastMatching(events, pred) {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return events[i];
  return null;
}

function pagesFor(events) {
  let max = 0;
  for (const e of events) {
    for (const k of ['pageNum', 'pages', 'pageCount']) {
      const v = e.data && e.data[k];
      if (typeof v === 'number' && v > max) max = v;
    }
  }
  return max || null;
}

function readMethodFor(events) {
  return events.some((e) => e.stage === 'home.ocr' || e.stage === 'ocr' || /text recognition/i.test(e.message || ''))
    ? 'text recognition' : 'text';
}

function describeStatement(events, index) {
  const typeEvent = lastMatching(events, (e) => typeof e.data?.type === 'string');
  // A fresh wizard save (never matched against anything - it's the first
  // time this statement type exists) carries the same structured fields
  // under its own 'wizard.save' stage, not 'home.match' - a statement can
  // reach this summary either way, so both are checked, most recent wins.
  const matchEvent = lastMatching(events, (e) =>
    (e.stage === 'home.match' && /match applied/.test(e.message || '')) ||
    (e.stage === 'wizard.save' && e.message === 'statement type saved'));
  const summaryEvent = lastMatching(events, (e) => e.stage === 'review' && e.message === 'file summary + checks');
  const countEvent = lastMatching(events, (e) => e.stage === 'review' && /count check rendered/.test(e.message || ''));
  const match = matchEvent?.data || {};
  const summary = summaryEvent?.data || {};

  const type = fileTypeLabel(match.fileType || typeEvent?.data?.type);
  const pages = pagesFor(events);
  const readMethod = readMethodFor(events);
  const rows = typeof summary.rowCount === 'number' ? summary.rowCount : (typeof match.rows === 'number' ? match.rows : null);
  const quickLookRows = typeof summary.quickLookRows === 'number' ? summary.quickLookRows : (typeof match.quickLookRows === 'number' ? match.quickLookRows : null);
  const bank = typeof match.bank === 'string' ? match.bank : null;
  const statementType = typeof match.statementType === 'string' ? match.statementType : null;

  const parts = [type || 'file'];
  if (pages) parts.push(`${pages} page${pages === 1 ? '' : 's'}`);
  parts.push(`read with ${readMethod}`);
  if (rows != null) parts.push(`${rows} row${rows === 1 ? '' : 's'}`);
  if (quickLookRows != null) parts.push(`${quickLookRows} quick-look row${quickLookRows === 1 ? '' : 's'}`);
  if (bank) parts.push(`detected bank: ${bank}`);
  if (statementType) parts.push(`type: ${statementType}`);
  const label = `Statement ${index + 1}`;

  // Item 10: "the stages with timings" - each named stage this file passed
  // through, with elapsed ms since the first event for this file. Message
  // text here is always one of the fixed, code-authored strings the log()
  // call sites above use (never string-built from user data).
  const first = events[0] ? new Date(events[0].t).getTime() : 0;
  const stages = events.map((e) => ({
    stage: e.stage,
    message: e.message,
    msFromStart: e.t ? Math.max(0, new Date(e.t).getTime() - first) : 0,
  }));

  const errors = events
    .filter((e) => e.data && typeof e.data.stack === 'string')
    .map((e) => ({ stage: e.stage, message: e.message, stack: e.data.stack }));

  return {
    label,
    summary: `${label}: ${parts.join(', ')}`,
    layoutModel: typeof match.rowModel === 'string' ? match.rowModel : null,
    checks: {
      countCheck: countEvent?.data?.tone || null,
      balanceReconciles: typeof summary.balanceReconciles === 'boolean' ? summary.balanceReconciles : null,
    },
    flagCounts: summary.flagsHistogram || null,
    stages,
    errors,
  };
}

/**
 * @param {object[]} rawEvents - core/debuglog.js's all() shape
 * @returns {{statements: object[], nameToLabel: [string,string][], sessionErrors: object[]}}
 */
export function buildSessionSummary(rawEvents) {
  const events = Array.isArray(rawEvents) ? rawEvents : [];
  const order = [];
  const groups = new Map();
  const sessionEvents = [];
  for (const e of events) {
    const key = fileKeyOf(e.data);
    if (!key) { sessionEvents.push(e); continue; }
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(e);
  }
  const statements = order.map((key, i) => describeStatement(groups.get(key), i));
  const nameToLabel = order.map((key, i) => [key, statements[i].label]);
  const sessionErrors = sessionEvents
    .filter((e) => e.data && typeof e.data.stack === 'string')
    .map((e) => ({ stage: e.stage, message: e.message, stack: e.data.stack }));
  return { statements, nameToLabel, sessionErrors };
}
