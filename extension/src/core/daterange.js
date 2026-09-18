// Date range presets, filtering, and per-account coverage warnings.

function ymd(d) { return d.toISOString().slice(0, 10); }
function firstOfMonth(y, m) { return new Date(Date.UTC(y, m, 1)); }
function lastOfMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)); }

// Fixed 3-letter month table: toLocaleDateString('en-GB', {month:'short'})
// returns "Sept" (4 letters) for September in Chrome's en-GB data, not "Sep".
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format an ISO date ("2026-09-15") as "15 Sep 2026", always a 3-letter month. */
export function formatShortDate(iso, { year = true } = {}) {
  const d = new Date(iso + 'T00:00:00Z');
  const label = `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]}`;
  return year ? `${label} ${d.getUTCFullYear()}` : label;
}

/**
 * Resolve a preset name to a { startISO, endISO } range, relative to `now`.
 * @param {'lastFullMonth'|'thisMonth'|'last3Months'|'ytd'|'all'} preset
 */
export function resolvePreset(preset, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (preset) {
    case 'thisMonth':
      return { startISO: ymd(firstOfMonth(y, m)), endISO: ymd(lastOfMonth(y, m)) };
    case 'lastFullMonth':
      return { startISO: ymd(firstOfMonth(y, m - 1)), endISO: ymd(lastOfMonth(y, m - 1)) };
    case 'last3Months':
      return { startISO: ymd(firstOfMonth(y, m - 2)), endISO: ymd(lastOfMonth(y, m)) };
    case 'ytd':
      return { startISO: ymd(firstOfMonth(y, 0)), endISO: ymd(now) };
    case 'all':
      return { startISO: null, endISO: null };
    default:
      throw new Error(`Unknown preset: ${preset}`);
  }
}

/**
 * Filter rows by a date range, matching either `date` or `post_date` per `dateField`.
 * @param {object[]} rows
 * @param {{startISO?: string, endISO?: string}} range
 * @param {'date'|'post_date'} [dateField]
 */
export function filterByRange(rows, range, dateField = 'date') {
  const included = [];
  const excluded = [];
  for (const row of rows) {
    const value = row[dateField];
    const inRange = (!range.startISO || (value && value >= range.startISO))
      && (!range.endISO || (value && value <= range.endISO));
    (inRange ? included : excluded).push(row);
  }
  return { included, excluded, includedCount: included.length, excludedCount: excluded.length };
}

/**
 * Warn when an account's data doesn't reach the end of the requested range,
 * e.g. "No UOB data after 25 Aug".
 * @param {{accountLabel:string, rows:object[]}[]} accountsWithRows
 * @param {{startISO?:string, endISO?:string}} range
 */
export function coverageWarnings(accountsWithRows, range) {
  const warnings = [];
  for (const { accountLabel, rows } of accountsWithRows) {
    const dates = rows.map((r) => r.date).filter(Boolean).sort();
    if (!dates.length) { warnings.push(`No data for ${accountLabel}`); continue; }
    const lastDate = dates[dates.length - 1];
    if (range.endISO && lastDate < range.endISO) {
      warnings.push(`No ${accountLabel} data after ${formatShortDate(lastDate, { year: false })}`);
    }
  }
  return warnings;
}
