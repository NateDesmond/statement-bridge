// Date parsing per an explicit dateFormat, plus day/month order inference and
// year inference (including statement periods that cross a year boundary).

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad2(n) { return String(n).padStart(2, '0'); }

function toISO(y, m, d) {
  if (m < 1 || m > 12) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d < 1 || d > dim) return null;
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Parse a date string per an explicit format. Returns ISO 'YYYY-MM-DD' or null.
 * Supported formats: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, DD MMM YYYY, DD MMM (no year, needs opts.year), DD/MM (no year, needs opts.year).
 * Separators / and - are interchangeable in numeric formats.
 */
export function parseDate(raw, dateFormat, opts = {}) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  if (dateFormat === 'YYYY-MM-DD') {
    const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (!m) return null;
    return toISO(+m[1], +m[2], +m[3]);
  }

  if (dateFormat === 'DD MMM YYYY') {
    // \s* (not \s+) between day and month: OCR (core/ocr.js, via
    // core/pdf.js's grouped rowModel) sometimes merges a short day number
    // tight against the month abbreviation into one word ("1 Sep" -> "1Sep");
    // this is the same tolerance core/pdf.js's DEFAULT_DATE_GROUP_RE needs to
    // even recognize the line as a date-group in the first place.
    const m = s.match(/^(\d{1,2})\s*([A-Za-z]{3,})\s+(\d{4})$/);
    if (!m) return null;
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mon) return null;
    return toISO(+m[3], mon, +m[1]);
  }

  if (dateFormat === 'DD/MM/YYYY') {
    const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (!m) return null;
    const year = m[3].length === 2 ? 2000 + (+m[3]) : +m[3];
    return toISO(year, +m[2], +m[1]);
  }

  if (dateFormat === 'MM/DD/YYYY') {
    const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (!m) return null;
    const year = m[3].length === 2 ? 2000 + (+m[3]) : +m[3];
    return toISO(year, +m[1], +m[2]);
  }

  if (dateFormat === 'DD MMM') {
    const m = s.match(/^(\d{1,2})\s*([A-Za-z]{3,})$/);
    if (!m) return null;
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mon || !opts.year) return null;
    return toISO(opts.year, mon, +m[1]);
  }

  if (dateFormat === 'DD/MM') {
    const m = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (!m) return null;
    const year = opts.year;
    if (!year) return null;
    return toISO(year, +m[2], +m[1]);
  }

  if (dateFormat === 'MM/DD') {
    const m = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (!m) return null;
    const year = opts.year;
    if (!year) return null;
    return toISO(year, +m[1], +m[2]);
  }

  return null;
}

/**
 * Given a set of raw "N/N" date strings, decide whether the file is day-first
 * or month-first. Any value where the first or second part exceeds 12 settles
 * it unambiguously; otherwise the order is "ambiguous".
 * @returns {'dayFirst'|'monthFirst'|'ambiguous'}
 */
export function inferDayMonthOrder(values) {
  let sawFirstOver12 = false;
  let sawSecondOver12 = false;
  for (const raw of values) {
    if (raw == null) continue;
    const m = String(raw).trim().match(/^(\d{1,2})[-/](\d{1,2})(?:[-/]\d{2,4})?$/);
    if (!m) continue;
    const a = +m[1], b = +m[2];
    if (a > 12) sawFirstOver12 = true;
    if (b > 12) sawSecondOver12 = true;
  }
  if (sawFirstOver12 && !sawSecondOver12) return 'dayFirst';
  if (sawSecondOver12 && !sawFirstOver12) return 'monthFirst';
  return 'ambiguous';
}

/**
 * Infer the year for a dateless "DD/MM" value from a statement period,
 * handling the case where the period crosses a year boundary
 * (e.g. period Dec 2025 to Jan 2026, and the value's month is Jan -> use the later year).
 * @param {number} month 1-12
 * @param {number} day
 * @param {{startISO:string, endISO:string}} period
 */
export function inferYearFromPeriod(month, day, period) {
  const start = period.startISO ? new Date(period.startISO + 'T00:00:00Z') : null;
  const end = period.endISO ? new Date(period.endISO + 'T00:00:00Z') : null;
  if (!start || !end) return null;
  const startY = start.getUTCFullYear();
  const endY = end.getUTCFullYear();
  if (startY === endY) return startY;
  // Period crosses a year boundary. Pick whichever candidate year falls within [start, end].
  for (const y of [startY, endY]) {
    const candidate = toISO(y, month, day);
    if (!candidate) continue;
    const c = new Date(candidate + 'T00:00:00Z');
    if (c >= start && c <= end) return y;
  }
  // Fall back: months near the start's month use startY, else endY.
  return month >= start.getUTCMonth() + 1 ? startY : endY;
}
