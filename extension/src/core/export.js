// Export presets: build CSV/TSV text from normalized rows per a column preset.

import { formatMinor } from './amount.js';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Sheets/Excel serial date epoch: day 0 is 1899-12-30 (the classic Lotus
// leap-year-bug epoch both Google Sheets and Excel inherited).
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

// Item 4: every date format the preset editor's "Export date format" picker
// offers, keyed exactly as its <option value>. Centralised here (not
// scattered across preset-editor.js) so the wizard/preview and the actual
// export can never disagree on what a given format string produces.
export const DATE_FORMATS = [
  'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'D/M/YYYY',
  'DD MMM YYYY', 'MMM D, YYYY', 'YYYY/MM/DD', 'DD.MM.YYYY', 'YYYYMMDD',
  'sheetsSerial', 'isoWithTime',
];

export function formatDateOut(iso, format) {
  if (!iso) return '';
  const [yStr, mStr, dStr] = iso.slice(0, 10).split('-');
  const y = Number(yStr), m = Number(mStr), d = Number(dStr);
  const pad2 = (n) => String(n).padStart(2, '0');
  switch (format) {
    case undefined:
    case 'YYYY-MM-DD': return `${yStr}-${mStr}-${dStr}`;
    case 'DD/MM/YYYY': return `${dStr}/${mStr}/${yStr}`;
    case 'MM/DD/YYYY': return `${mStr}/${dStr}/${yStr}`;
    case 'DD-MM-YYYY': return `${dStr}-${mStr}-${yStr}`;
    case 'D/M/YYYY': return `${d}/${m}/${y}`;
    case 'DD MMM YYYY': return `${pad2(d)} ${MONTH_ABBR[m - 1]} ${y}`;
    case 'MMM D, YYYY': return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
    case 'YYYY/MM/DD': return `${yStr}/${mStr}/${dStr}`;
    case 'DD.MM.YYYY': return `${dStr}.${mStr}.${yStr}`;
    case 'YYYYMMDD': return `${yStr}${mStr}${dStr}`;
    case 'sheetsSerial': return String(Math.round((Date.UTC(y, m - 1, d) - SHEETS_EPOCH_MS) / 86400000));
    // "if available": rows in this app never actually carry a time-of-day
    // component (core/normalize.js's date field is date-only), so this is
    // always the same plain ISO date today - the format exists for a future
    // source that does carry one, and passes an ISO string with a "T" straight through.
    case 'isoWithTime': return iso.includes('T') ? iso : `${yStr}-${mStr}-${dStr}`;
    default: return `${yStr}-${mStr}-${dStr}`;
  }
}

function formatAmountOut(minor, currency, signConvention) {
  if (minor == null) return '';
  const value = signConvention === 'positiveIsOut' ? -minor : minor;
  return formatMinor(value, currency);
}

// Item 5: "Two columns" money direction - money is always stored internally
// as negative-out/positive-in (see normalize.js), so splitting into two
// columns is just which sign goes to which column; a zero-amount row (a
// balance-only line, rare) is shown in Money in as 0.00 rather than blank in
// both, so it's still visible somewhere.
function formatMoneyOut(minor, currency) {
  return minor != null && minor < 0 ? formatMinor(-minor, currency) : '';
}
function formatMoneyIn(minor, currency) {
  return minor != null && minor >= 0 ? formatMinor(minor, currency) : '';
}

/**
 * A single column's display value for one row, per the preset's date format/
 * sign convention. Exported so any UI rendering a preview renders straight
 * from row objects through this same function, rather than re-parsing
 * buildCsv's escaped/quoted text output (which breaks on a value containing
 * the delimiter).
 */
export function fieldValue(row, field, preset) {
  if (field === 'date') return formatDateOut(row.date, preset.dateFormat);
  if (field === 'post_date') return formatDateOut(row.post_date, preset.dateFormat);
  if (field === 'amount') return formatAmountOut(row.amount, row.currency, preset.signConvention);
  if (field === 'money_out') return formatMoneyOut(row.amount, row.currency);
  if (field === 'money_in') return formatMoneyIn(row.amount, row.currency);
  if (field === 'orig_amount') return formatAmountOut(row.orig_amount, row.orig_currency, preset.signConvention);
  if (field === 'balance') return row.balance == null ? '' : formatAmountOut(row.balance, row.currency, null);
  // converted_amount is minor units of converted_currency (core/currency.js's
  // convertToTarget), a different currency from row.amount/row.currency, so it
  // needs its own currency for decimal-place-aware formatting (item 2).
  if (field === 'converted_amount') return row.converted_amount == null ? '' : formatAmountOut(row.converted_amount, row.converted_currency, null);
  if (field === 'flags') return (row.flags || []).join(';');
  return row[field] ?? '';
}

function escapeCsvCell(value, delimiter) {
  const s = String(value ?? '');
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildDelimited(rows, preset, delimiter, { includeSourceColumns = false } = {}) {
  // Skipped lines (non-transaction summary/footer text) never reach an export;
  // same rule as checks.fileSummary's rowCount.
  rows = rows.filter((r) => !r.skipped);
  // Item 1: export must carry the exact same columns, in the exact same
  // order, that the preset editor's enabled list and live preview show -
  // a column unchecked there (enabled === false) never reaches the file.
  const columns = preset.columns.filter((c) => c.enabled !== false);
  if (includeSourceColumns && rows.length) {
    for (const key of Object.keys(rows[0].original || {})) {
      columns.push({ field: `original.${key}`, name: key });
    }
  }
  const lines = [];
  if (preset.headerRow !== false) {
    lines.push(columns.map((c) => escapeCsvCell(c.name, delimiter)).join(delimiter));
  }
  for (const row of rows) {
    const cells = columns.map((c) => {
      if (c.field.startsWith('original.')) return escapeCsvCell(row.original?.[c.field.slice(9)], delimiter);
      return escapeCsvCell(fieldValue(row, c.field, preset), delimiter);
    });
    lines.push(cells.join(delimiter));
  }
  return lines.join('\r\n');
}

/** Build CSV text (UTF-8, CRLF line endings) for download. */
export function buildCsv(rows, preset, opts) {
  return buildDelimited(rows, preset, ',', opts);
}

/** Build TSV text for clipboard (pastes cleanly into Sheets). */
export function buildTsv(rows, preset, opts) {
  return buildDelimited(rows, preset, '\t', opts);
}

/** Suggest a filename embedding the export's date range. */
export function suggestFilename(dateRange, ext = 'csv') {
  if (!dateRange || !dateRange.start) return `statement-export.${ext}`;
  const range = dateRange.start === dateRange.end ? dateRange.start : `${dateRange.start}_to_${dateRange.end}`;
  return `statement-export_${range}.${ext}`;
}

/** Build a pre-export summary: row count, date range, per-currency totals. */
export function preExportSummary(rows) {
  const active = rows.filter((r) => !r.excluded && !r.skipped);
  const dates = active.map((r) => r.date).filter(Boolean).sort();
  const totals = {};
  for (const r of active) {
    if (r.amount == null) continue;
    totals[r.currency || 'UNKNOWN'] = (totals[r.currency || 'UNKNOWN'] || 0) + r.amount;
  }
  return {
    rowCount: active.length,
    dateRange: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
    totals,
  };
}

// Item 14b: Account (the user's own account_label - defaultAccountLabel's
// "<bank> <statement type> ****<last4>", or a custom label set in Settings/
// Profiles) sits right after Date - with two or more files in a session it's
// often the only column that says which statement a row came from at all.
export const DEFAULT_PRESET = {
  columns: [
    { field: 'date', name: 'Date' },
    { field: 'account_label', name: 'Account' },
    { field: 'description_raw', name: 'Description' },
    { field: 'amount', name: 'Amount' },
    { field: 'currency', name: 'Currency' },
    { field: 'balance', name: 'Balance' },
  ],
  dateFormat: 'YYYY-MM-DD',
  signConvention: 'signed',
  headerRow: true,
};

// Mode B (convert to a target currency): the default preset's Amount/Currency
// columns are made to carry the CONVERTED value (home.js's rowsForExport
// swaps row.amount/currency for the converted ones before building the
// export), so the default preset also adds the original amount/currency and
// the rate used, right after them - otherwise a converted export has nothing
// in it to show a conversion ever happened (Finding 2).
export const DEFAULT_PRESET_MODE_B = {
  ...DEFAULT_PRESET,
  columns: [
    { field: 'date', name: 'Date' },
    { field: 'account_label', name: 'Account' },
    { field: 'description_raw', name: 'Description' },
    { field: 'amount', name: 'Amount' },
    { field: 'currency', name: 'Currency' },
    { field: 'orig_amount', name: 'Original amount' },
    { field: 'orig_currency', name: 'Original currency' },
    { field: 'fx_rate', name: 'FX rate' },
    { field: 'balance', name: 'Balance' },
  ],
};

/** Whether a preset's columns are still exactly the untouched default field list (mode A shape), used to decide whether Mode B should widen it with conversion columns. */
export function isDefaultPresetColumns(preset) {
  const fields = (preset?.columns || []).map((c) => c.field).join(',');
  return fields === DEFAULT_PRESET.columns.map((c) => c.field).join(',');
}

// Item 7 (REBUILD-HOME): the six built-in column layouts, offered as radio
// cards instead of a dropdown + checkbox list. Each `columns` entry is a
// fresh, independent array (never DEFAULT_PRESET's own) so picking a layout
// can freely become the working preset's `.columns` without aliasing.
export const LAYOUT_PRESETS = [
  {
    key: 'simple',
    name: 'Simple',
    description: 'Just the date, description and amount.',
    columns: [
      { field: 'date', name: 'Date' },
      { field: 'description_raw', name: 'Description' },
      { field: 'amount', name: 'Amount' },
    ],
  },
  {
    key: 'withAccount',
    name: 'With account',
    description: 'Adds which account each row came from, and its currency.',
    columns: [
      { field: 'date', name: 'Date' },
      { field: 'account_label', name: 'Account' },
      { field: 'description_raw', name: 'Description' },
      { field: 'amount', name: 'Amount' },
      { field: 'currency', name: 'Currency' },
    ],
  },
  {
    key: 'withBalance',
    name: 'With balance',
    description: 'With account, plus the running balance after each row.',
    columns: [
      { field: 'date', name: 'Date' },
      { field: 'account_label', name: 'Account' },
      { field: 'description_raw', name: 'Description' },
      { field: 'amount', name: 'Amount' },
      { field: 'currency', name: 'Currency' },
      { field: 'balance', name: 'Balance' },
    ],
  },
  {
    key: 'budgetApp',
    name: 'Budget app',
    description: 'Payee and amount, with an empty category column to fill in yourself.',
    columns: [
      { field: 'date', name: 'Date' },
      { field: 'description_raw', name: 'Payee' },
      { field: 'amount', name: 'Amount' },
      { field: 'category', name: 'Category' },
    ],
  },
  {
    key: 'accounting',
    name: 'Accounting',
    description: 'Money in and out as separate debit and credit columns.',
    columns: [
      { field: 'date', name: 'Date' },
      { field: 'description_raw', name: 'Description' },
      { field: 'money_out', name: 'Debit' },
      { field: 'money_in', name: 'Credit' },
      { field: 'balance', name: 'Balance' },
    ],
  },
  {
    key: 'everything',
    name: 'Everything',
    description: 'Every column this app can produce.',
    columns: [
      { field: 'date', name: 'Date' },
      { field: 'post_date', name: 'Posting date' },
      { field: 'account_label', name: 'Account' },
      { field: 'description_raw', name: 'Description' },
      { field: 'amount', name: 'Amount' },
      { field: 'currency', name: 'Currency' },
      { field: 'balance', name: 'Balance' },
      { field: 'bank', name: 'Bank' },
      { field: 'statement_type', name: 'Statement type' },
      { field: 'reference', name: 'Reference' },
      { field: 'flags', name: 'Flags' },
    ],
  },
];
