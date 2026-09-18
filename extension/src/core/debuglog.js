// Shared debug log. Ring buffer of structured events, copyable as text for bug reports.
// Never logs full account numbers; callers pass masked values. Amounts and descriptions are kept
// because they are what makes a parse bug reproducible.
const MAX = 2000;
const events = [];
export const version = '0.1.0';

export function log(stage, message, data) {
  const e = { t: new Date().toISOString(), stage, message, data };
  events.push(e);
  if (events.length > MAX) events.shift();
  return e;
}

export function error(stage, err, data) {
  return log(stage, err && err.message ? err.message : String(err), { ...data, stack: err && err.stack });
}

export function clear() { events.length = 0; }
export function all() { return events.slice(); }

export function asText() {
  const head = [
    `Statement Bridge debug log v${version}`,
    `Generated ${new Date().toISOString()}`,
    `User agent ${typeof navigator !== 'undefined' ? navigator.userAgent : 'node'}`,
    '',
  ];
  const lines = events.map(e => {
    const d = e.data === undefined ? '' : ' ' + safeJson(e.data);
    return `${e.t} [${e.stage}] ${e.message}${d}`;
  });
  return head.concat(lines).join('\n');
}

function safeJson(v) {
  try {
    return JSON.stringify(v, (k, x) => {
      if (typeof x !== 'string') return x;
      const cap = k === 'stack' ? 2000 : 400;
      return x.length > cap ? x.slice(0, cap) + '…(truncated)' : x;
    });
  } catch { return '[unserialisable]'; }
}
