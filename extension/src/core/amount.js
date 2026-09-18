// Amount parsing: turn heterogeneous bank amount strings into integer minor units.
// ponytail: currency decimal table covers common 0-decimal currencies only, extend if a bank surfaces another.
export const CURRENCY_DECIMALS = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 0 };

export function decimalsFor(currency) {
  return CURRENCY_DECIMALS[currency] ?? 2;
}

const SYMBOL_CURRENCY = [
  [/^S\$/i, 'SGD'],
  [/^US\$/i, 'USD'],
  [/^HK\$/i, 'HKD'],
  [/^A\$/i, 'AUD'],
  [/^€/, 'EUR'],
  [/^£/, 'GBP'],
  [/^¥/, 'JPY'],
  // bare "$" is ambiguous: never guessed (CU-1)
];

// Detect which of , or . is the decimal separator when both appear, or fall back to `numberFormat` hint.
function splitSeparators(digitsPart, numberFormat) {
  const hasComma = digitsPart.includes(',');
  const hasDot = digitsPart.includes('.');
  if (hasComma && hasDot) {
    const lastComma = digitsPart.lastIndexOf(',');
    const lastDot = digitsPart.lastIndexOf('.');
    return lastComma > lastDot ? { decimal: ',', thousands: '.' } : { decimal: '.', thousands: ',' };
  }
  if (hasComma && !hasDot) {
    // ambiguous: "1,234" (thousands) vs "1,23" (decimal). Use numberFormat hint, else guess by digit count after comma.
    if (numberFormat === '1.234,56') return { decimal: ',', thousands: '.' };
    if (numberFormat === '1,234.56') return { decimal: '.', thousands: ',' }; // comma is thousands here, no decimal comma
    const after = digitsPart.length - digitsPart.lastIndexOf(',') - 1;
    return after === 2 ? { decimal: ',', thousands: '.' } : { decimal: '.', thousands: ',' };
  }
  if (hasDot && !hasComma) {
    if (numberFormat === '1.234,56') {
      const after = digitsPart.length - digitsPart.lastIndexOf('.') - 1;
      return after === 3 || after === 0 ? { decimal: ',', thousands: '.' } : { decimal: '.', thousands: ',' };
    }
    return { decimal: '.', thousands: ',' };
  }
  return { decimal: '.', thousands: ',' };
}

/**
 * Parse a raw amount string into { minor, currencyHint, crdr, negative }.
 * minor is signed integer minor units (cents), or null if unparseable.
 * currencyHint is an ISO code guessed from a symbol prefix, or null (never guesses bare "$").
 * crdr is 'CR' | 'DR' | null if a trailing CR/DR marker was present.
 * @param {string} raw
 * @param {{numberFormat?: string, currency?: string}} [opts]
 */
export function parseAmount(raw, opts = {}) {
  if (raw == null) return { minor: null, currencyHint: null, crdr: null, negative: false };
  let s = String(raw).trim();
  if (s === '') return { minor: null, currencyHint: null, crdr: null, negative: false };

  let currencyHint = null;
  for (const [re, code] of SYMBOL_CURRENCY) {
    if (re.test(s)) { currencyHint = code; s = s.replace(re, '').trim(); break; }
  }
  if (currencyHint === null && /^\$/.test(s)) s = s.replace(/^\$/, '').trim();

  let crdr = null;
  // A leading CR/DR marker ("CR 1,234.56", a card statement's own prefix
  // style) - checked before the trailing form, and only when followed by
  // whitespace then a sign/digit/paren, so it never fires on an unrelated
  // 2-letter word. Distinct from the trailing form because a card statement
  // picks one placement consistently, never both on the same line.
  const leadingCrdrMatch = s.match(/^(CR|DR)\s+(?=[\d(+-])/i);
  if (leadingCrdrMatch) { crdr = leadingCrdrMatch[1].toUpperCase(); s = s.slice(leadingCrdrMatch[0].length).trim(); }
  const crdrMatch = !crdr && s.match(/\s*(CR|DR)\s*$/i);
  if (crdrMatch) { crdr = crdrMatch[1].toUpperCase(); s = s.slice(0, crdrMatch.index).trim(); }

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, '').trim(); }
  if (/^-/.test(s)) { negative = true; s = s.replace(/^-/, '').trim(); }
  if (/^\+/.test(s)) { s = s.replace(/^\+/, '').trim(); }

  // strip currency letters if present, e.g. "SGD 1,234.56"
  s = s.replace(/^[A-Z]{3}\s*/i, '');
  s = s.trim();
  // A space (or non-breaking space) used as a thousands separator ("1 234,56",
  // common in French/German-style statements) - collapsed between digit
  // groups only, so it's never mistaken for the decimal/thousands separator
  // splitSeparators looks for next.
  s = s.replace(/(\d)[  ](?=\d)/g, '$1');
  if (!/[\d]/.test(s)) return { minor: null, currencyHint, crdr, negative };

  const { decimal, thousands } = splitSeparators(s, opts.numberFormat);
  const decimalsCount = decimalsFor(opts.currency || currencyHint);
  let cleaned = s.split(thousands).join('');
  cleaned = cleaned.split(decimal).join('.');
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return { minor: null, currencyHint, crdr, negative };

  let minor = Math.round(num * Math.pow(10, decimalsCount));
  if (negative) minor = -Math.abs(minor);
  return { minor, currencyHint, crdr, negative };
}

/**
 * Format signed minor units back to a plain decimal string for a currency,
 * e.g. formatMinor(1234, 'SGD') -> "12.34", formatMinor(1500, 'JPY') -> "1500"
 * (no ".00" - JPY's minor unit already is one yen, see CURRENCY_DECIMALS).
 * Shared by every UI amount display so a zero-decimal currency never gets
 * divided by 100 or forced to 2 decimals.
 * `{ grouped: true }` inserts thousands separators ("8,641.83"). Use it for
 * anything shown to a human (a summary caption, a table cell, a wizard
 * preview) - never for a CSV/TSV export cell, which needs the plain,
 * comma-free round-trippable string (EX-3).
 * @param {number|null} minor
 * @param {string|null} [currency]
 * @param {{grouped?: boolean}} [opts]
 */
export function formatMinor(minor, currency, opts = {}) {
  if (minor == null) return '';
  const decimals = decimalsFor(currency);
  const fixed = (minor / Math.pow(10, decimals)).toFixed(decimals);
  if (!opts.grouped) return fixed;
  const neg = fixed.startsWith('-');
  const [whole, frac] = (neg ? fixed.slice(1) : fixed).split('.');
  const withSep = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (frac !== undefined ? `${withSep}.${frac}` : withSep);
}

/**
 * formatMinor with thousands separators on by default - the on-screen
 * display formatter (table cells, previews, summaries). A plain, shorter
 * name for the common case, so call sites don't have to spell out
 * `{ grouped: true }` themselves; formatMinor(..., { grouped: false }) (or
 * plain formatMinor) is still what CSV/TSV export must use (EX-3).
 * @param {number|null} minor
 * @param {string|null} [currency]
 */
export function formatMinorDisplay(minor, currency) {
  return formatMinor(minor, currency, { grouped: true });
}

/**
 * Group an already-formatted plain decimal string (e.g. export.js's
 * fieldValue output, "1234.56" or "-20.83") the same way formatMinorDisplay
 * groups raw minor units - for an on-screen preview that only has the export
 * string on hand, not the row's raw minor-unit integer (preset-editor.js's
 * live preview: the value comes from fieldValue, which must stay ungrouped
 * for the real export, EX-3). Anything that isn't a plain signed decimal
 * (dates, ids, free text) is returned unchanged.
 * @param {string} str
 */
export function groupPlainNumber(str) {
  if (typeof str !== 'string' || !/^-?\d+(\.\d+)?$/.test(str)) return str;
  const neg = str.startsWith('-');
  const [whole, frac] = (neg ? str.slice(1) : str).split('.');
  const withSep = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (frac !== undefined ? `${withSep}.${frac}` : withSep);
}
