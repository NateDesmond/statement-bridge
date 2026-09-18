// File type / encoding / delimiter sniffing by content, not extension.

import { log } from './debuglog.js';

/**
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {'pdf'|'xlsx'|'text'}
 */
export function detectFileType(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let type = 'text';
  if (u8.length >= 5 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 && u8[4] === 0x2d) {
    type = 'pdf'; // %PDF-
  } else if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07)) {
    type = 'xlsx'; // PK.. zip container (xlsx/xlsm)
  }
  log('detect', 'file type sniffed', { type, byteLength: u8.length });
  return type;
}

/**
 * Detect text encoding from a byte buffer. Recognises UTF-16 and UTF-8 BOMs
 * explicitly (some banks export UTF-16 CSVs from legacy mainframe tooling),
 * else validates as UTF-8, else falls back to Windows-1252.
 * @returns {'utf-8-bom'|'utf-16le'|'utf-16be'|'utf-8'|'windows-1252'}
 */
export function detectEncoding(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let enc;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) enc = 'utf-8-bom';
  else if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) enc = 'utf-16le';
  else if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) enc = 'utf-16be';
  else if (isValidUtf8(u8)) enc = 'utf-8';
  else enc = 'windows-1252';
  log('detect', 'encoding sniffed', { encoding: enc, byteLength: u8.length });
  return enc;
}

function isValidUtf8(u8) {
  let i = 0;
  while (i < u8.length) {
    const b = u8[i];
    let extra;
    if (b <= 0x7f) { i += 1; continue; }
    else if ((b & 0xe0) === 0xc0) extra = 1;
    else if ((b & 0xf0) === 0xe0) extra = 2;
    else if ((b & 0xf8) === 0xf0) extra = 3;
    else return false;
    if (i + extra >= u8.length) return false;
    for (let k = 1; k <= extra; k++) {
      if ((u8[i + k] & 0xc0) !== 0x80) return false;
    }
    i += extra + 1;
  }
  return true;
}

/** Decode raw bytes to a string using a detected/given encoding. */
export function decodeText(bytes, encoding) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const enc = encoding || detectEncoding(u8);
  if (enc === 'utf-8-bom') return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (enc === 'utf-16le') return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (enc === 'utf-16be') return new TextDecoder('utf-16be').decode(u8.subarray(2));
  if (enc === 'windows-1252') return new TextDecoder('windows-1252').decode(u8);
  return new TextDecoder('utf-8').decode(u8);
}

const DELIMITER_CANDIDATES = [',', '\t', ';', '|'];

/** Strip leading/trailing tabs and spaces from one line (not interior whitespace). */
export function trimLinePadding(line) {
  return String(line ?? '').replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * Guess the field delimiter by counting occurrences per line, after
 * trimming leading/trailing tabs/spaces from every line first (a bank
 * export that pads every data row with leading tabs - e.g. three tabs
 * before each Standard Chartered CSV row - must never let those padding
 * tabs get counted as a tab delimiter). Picks the candidate whose per-line
 * field count is most consistent (its most common count's share of the
 * lines that contain it at all), not requiring every line to match exactly:
 * a preamble/header line can legitimately have a different count than the
 * data rows. A delimiter that only ever appears as trimmed-away padding
 * scores zero real hits and is never picked - so comma naturally wins over
 * a tab that was only ever leading/trailing padding.
 */
// A comma or dot flanked by a digit on both sides is a decimal/thousands
// separator inside a NUMBER, never a field delimiter, whatever the actual
// delimiter is - a European "1 234,56"/"1.234,56" amount, printed with no
// quoting at all (a real, unquoted TSV/semicolon-delimited export has no
// reason to quote a plain number), can otherwise land on EVERY data row with
// perfectly uniform count, scoring higher "consistency" than the real
// delimiter and winning outright (root cause: a tab-delimited file with
// decimal-comma amounts detected as comma-delimited, corrupting every
// column). Counted separately from the real delimiter-shaped occurrences so
// a comma/dot's OWN field-delimiter evidence still counts normally when it
// truly is one (e.g. "NETS,10.00" - not digit-flanked on the comma side).
function countDelimiterHits(line, cand) {
  if (cand !== ',' && cand !== '.') return line.split(cand).length - 1;
  const re = new RegExp(`\\${cand}`, 'g');
  let hits = 0;
  let m;
  while ((m = re.exec(line))) {
    const before = line[m.index - 1];
    const after = line[m.index + 1];
    if (!(before >= '0' && before <= '9' && after >= '0' && after <= '9')) hits++;
  }
  return hits;
}

export function detectDelimiter(text) {
  const lines = text.split(/\r\n|\r|\n/).map(trimLinePadding).filter((l) => l !== '').slice(0, 20);
  if (lines.length === 0) return ',';
  let best = ',';
  let bestScore = -1;
  for (const cand of DELIMITER_CANDIDATES) {
    const counts = lines.map((l) => countDelimiterHits(l, cand));
    const nonZero = counts.filter((c) => c > 0);
    if (nonZero.length === 0) continue;
    const freq = new Map();
    for (const c of nonZero) freq.set(c, (freq.get(c) || 0) + 1);
    const [modeCount, modeHits] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    const consistency = modeHits / nonZero.length;
    const score = consistency * 1000 + nonZero.length * 10 + modeCount;
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  log('detect', 'delimiter sniffed', { delimiter: best, sampledLines: lines.length });
  return best;
}

/**
 * Whether a single line "looks like" a transaction row: a date-shaped token
 * (DD/MM/YYYY-ish, YYYY-MM-DD, or "15 Sep 2026") plus a separate number
 * elsewhere on the line (an amount). Used to decide whether a dropped file
 * actually has no transactions (item f) rather than merely having failed
 * header/column detection.
 */
export function lineLooksLikeTransaction(line) {
  const trimmed = trimLinePadding(String(line ?? '')).trim();
  if (!trimmed) return false;
  const dateMatch = trimmed.match(/\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/);
  if (!dateMatch) return false;
  const rest = trimmed.slice(0, dateMatch.index) + trimmed.slice(dateMatch.index + dateMatch[0].length);
  return /\d/.test(rest);
}

/** Whether any row of a parsed grid (cells joined back into a line) looks like a transaction row. See lineLooksLikeTransaction. */
export function hasTransactionLikeRow(grid) {
  return (grid || []).some((row) => lineLooksLikeTransaction((row || []).join(' ')));
}

/**
 * Count of grid rows (or free-text lines) that look like a transaction line
 * (lineLooksLikeTransaction) - a mapping-independent ground truth for how
 * many real transactions a file actually has, used as the denominator for
 * home-state.js's extractionQuality (item 1): a profile whose own row count
 * is inflated or shrunk by a bad headerRow/skip config is still scored
 * against the file's real transaction-line count, not its own parse of it.
 * @param {string[][]|string[]} lines - a CSV/XLSX grid (rows of cells), or
 *   an array of plain text lines (PDF page text).
 */
export function countTransactionLikeRows(lines) {
  return (lines || []).filter((row) => lineLooksLikeTransaction(Array.isArray(row) ? row.join(' ') : row)).length;
}
