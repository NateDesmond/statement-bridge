// Rule-based (no AI) mapping suggestions: header dictionary + value-shape scoring.

import { parseAmount } from './amount.js';

// Corpus fix (2026-09-18): en/zh/ms are the three languages this dictionary
// claims to support, but several common real-world terms were missing their
// zh/ms entry even though the parallel en/other-language term was already
// there (debit had the formal zh term "借方金额" missing while credit's own
// "存入"/"收入" existed with no formal-term counterpart at all, etc) - added
// below, one term at a time, each a plain, common banking word/phrase, never
// a speculative or machine-translated guess.
// 2026-09-18: extended past en/zh/ms with de/fr/es/ja/it/nl/pt/ko - common
// bank-statement header words per field, including the bank-specific
// phrasings named in the task spec (de: Buchungstag/Wertstellung/
// Verwendungszweck/Betrag/Soll/Haben/Saldo; fr: Date opération/Date valeur/
// Libellé/Débit/Crédit/Solde/Montant; es: Fecha valor/Concepto/Cargo/Abono/
// Importe/Saldo; ja: 日付/取引日/摘要/出金/入金/残高/金額; it: Data contabile/
// Data valuta/Descrizione/Dare/Avere/Importo/Saldo; nl: Datum/Omschrijving/
// Af/Bij/Bedrag/Saldo; pt: Data/Descrição/Débito/Crédito/Valor/Saldo; ko:
// 거래일/적요/출금/입금/잔액). Every accented Latin term is stored plain
// (accents stripped) since normHeader strips accents from the header text
// before comparing - see normHeader.
const HEADER_DICTIONARY = {
  date: [
    'date', 'transaction date', 'trans date', 'txn date', 'value date', 'posting date', 'post date',
    '日期', '交易日期', 'tarikh', 'tarikh urus niaga',
    'datum', 'buchungsdatum', 'buchungstag', 'wertstellung', 'wertstellungsdatum',
    'date operation', "date d'operation", 'date valeur',
    'fecha', 'fecha valor', 'fecha de valor', 'fecha de operacion', 'fecha de transaccion',
    '日付', '取引日', '価値日', '約定日',
    'data', 'data contabile', 'data valuta', 'data operazione',
    '거래일', '날짜', '거래일자',
  ],
  description_raw: [
    'description', 'particulars', 'details', 'transaction details', 'narrative', 'remarks',
    '描述', '交易详情', '备注', 'butiran', 'penerangan', 'catatan',
    'beschreibung', 'verwendungszweck', 'buchungstext',
    'libelle', 'details de la transaction',
    'concepto', 'descripcion', 'detalle',
    '摘要', '説明', '内容',
    'descrizione', 'causale',
    'omschrijving', 'beschrijving',
    'descricao', 'historico', 'detalhes',
    '적요', '내용', '거래내용',
    'dettagli',
  ],
  reference: [
    'reference', 'ref', 'reference no', 'cheque no',
    '参考', '参考编号', 'rujukan',
    'referenz',
    'reference operation',
    'referencia',
    '参照', '参考番号',
    'riferimento',
    'referentie', 'kenmerk',
    '참조', '참조번호',
  ],
  debit: [
    'withdrawal', 'debit', 'debit amount', 'withdrawal amount', 'paid out',
    '支出', '提款', '借方金额', 'pengeluaran', 'debit amaun', 'bayaran keluar',
    'soll', 'belastung', 'abbuchung',
    'debit', 'retrait', 'montant debite',
    'cargo', 'debito', 'retiro',
    '出金', '引き出し', '借方金額',
    'dare', 'uscita',
    'af', 'debet',
    'debito', 'saida', 'retirada',
    '출금', '인출',
  ],
  credit: [
    'deposit', 'credit', 'credit amount', 'deposit amount', 'paid in',
    '存入', '收入', '贷方金额', 'kemasukan', 'kredit amaun', 'bayaran masuk',
    'haben', 'gutschrift', 'einzahlung',
    'credit', 'depot', 'montant credite',
    'abono', 'credito', 'deposito',
    '入金', '預入', '貸方金額',
    'avere', 'entrata',
    'bij',
    'credito', 'entrada',
    '입금', '예금',
  ],
  amount: [
    'amount', 'transaction amount',
    '金额', '交易金额', '净额', 'jumlah', 'amaun bersih',
    'betrag', 'transaktionsbetrag', 'nettobetrag',
    'montant', 'montant de la transaction', 'montant net',
    'importe', 'monto', 'importe neto',
    '金額', '取引金額', '純額',
    'importo',
    'bedrag',
    'valor',
    '금액', '거래금액',
  ],
  balance: [
    'balance', 'running balance', 'closing balance',
    '余额', '结余', 'baki',
    'saldo', 'kontostand', 'endsaldo',
    'solde', 'solde courant', 'solde de cloture',
    '残高', '現在残高', '最終残高',
    '잔액', '잔고',
  ],
  currency: [
    'currency', 'ccy',
    '货币', 'mata wang',
    'wahrung',
    'devise',
    'moneda',
    '通貨',
    'valuta',
    'moeda',
    '통화',
  ],
};

// Combining diacritical marks block (U+0300-U+036F) - what NFD decomposition
// splits a Latin accented letter into (e.g. e + combining acute = e).
const COMBINING_MARKS_RE = new RegExp('[̀-ͯ]', 'g');

/**
 * Strip Latin combining diacritics (é->e, ü->u, ...) so accented and plain
 * headers compare equal. Renormalizes back to NFC afterwards: NFD also
 * decomposes a composed Hangul syllable into its jamo, which the dictionary's
 * plain (NFC) Korean terms would then never match - recomposing after the
 * diacritic strip leaves Hangul (and everything else NFD/NFC round-trips
 * unchanged) untouched while still normalizing Latin accents away.
 */
function stripAccents(s) {
  return s.normalize('NFD').replace(COMBINING_MARKS_RE, '').normalize('NFC');
}

function normHeader(h) {
  return stripAccents(String(h ?? '').trim().toLowerCase()).replace(/\s+/g, ' ');
}

/** Score how well a single header string matches a standard field, 0..1. */
export function scoreHeader(header, field) {
  const h = normHeader(header);
  const dict = HEADER_DICTIONARY[field] || [];
  if (dict.includes(h)) return 1;
  for (const term of dict) {
    if (h.includes(term)) return 0.7;
  }
  return 0;
}

function isDateLike(value) {
  return /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(String(value ?? '').trim())
    || /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(String(value ?? '').trim());
}

function isAmountLike(value) {
  const v = String(value ?? '').trim();
  if (v === '') return false;
  return parseAmount(v).minor != null;
}

function isCurrencyCodeLike(value) {
  return /^[A-Z]{3}$/.test(String(value ?? '').trim());
}

/** A leading 3-letter ISO-looking currency code on a value ("USD 65.00" -> "USD"), or null. */
function currencyCodeOf(value) {
  const m = String(value ?? '').trim().match(/^([A-Za-z]{3})\b/);
  return m ? m[1].toUpperCase() : null;
}

/** Fraction of a column's non-blank values, and how many of them carry a leading currency code. */
function columnFillAndCoding(values) {
  const nonBlank = values.filter((v) => v != null && String(v).trim() !== '');
  const fillRate = values.length ? nonBlank.length / values.length : 0;
  const codeCounts = {};
  for (const v of nonBlank) { const c = currencyCodeOf(v); if (c) codeCounts[c] = (codeCounts[c] || 0) + 1; }
  const codedFrac = nonBlank.length ? Object.values(codeCounts).reduce((a, b) => a + b, 0) / nonBlank.length : 0;
  const dominantCode = Object.keys(codeCounts).sort((a, b) => codeCounts[b] - codeCounts[a])[0] || null;
  return { nonBlank, fillRate, codedFrac, dominantCode };
}

/**
 * Item 9 (2026-09-17): a mostly-blank numeric column whose filled rows carry
 * a currency code different from the fully-filled ("billed") column's own is
 * an original/foreign-currency amount, not a debit/credit pair and never a
 * competitor for the primary 'amount' field - general fill-rate + currency-
 * code rule (replaces the old isForeignAmountHeader-only gate, which only
 * caught a column literally named "Foreign Currency Amount"; a real file's
 * header can read anything - "Txn Amt (Orig)", "Original Value", etc).
 * A recognized header word (isForeignAmountHeader) only ever adds a small
 * confidence bonus, never gates the detection.
 * @returns {{field:'orig_amount', source:string, confidence:number}|null}
 */
function detectOrigAmountColumn(header, columns) {
  const numericCols = [];
  header.forEach((h, colIdx) => {
    const values = columns[colIdx] || [];
    if (!values.length) return;
    const { nonBlank, fillRate, codedFrac, dominantCode } = columnFillAndCoding(values);
    if (!nonBlank.length) return;
    const amountLikeFrac = nonBlank.filter(isAmountLike).length / nonBlank.length;
    if (amountLikeFrac < 0.8) return; // not numeric-shaped at all
    numericCols.push({ header: h, fillRate, codedFrac, dominantCode });
  });
  if (numericCols.length < 2) return null;
  const sorted = [...numericCols].sort((a, b) => b.fillRate - a.fillRate);
  const billed = sorted[0];
  const candidate = sorted[1];
  if (billed.fillRate < 0.5 || candidate.fillRate >= 0.5) return null; // no clear billed column, or both dense - don't guess
  // A real messy export's sparse foreign-amount column isn't always coded on
  // every one of its handful of filled rows (some real rows print a bare
  // number there too) - what matters is that at least one filled row shows a
  // currency code at all (a column with none is never treated as "original",
  // whatever else it might be) and that code differs from the billed column's.
  if (candidate.codedFrac <= 0) return null;
  if (candidate.dominantCode && candidate.dominantCode === billed.dominantCode) return null; // same currency, not "original"
  const bonus = isForeignAmountHeader(candidate.header) ? 0.15 : 0;
  return { field: 'orig_amount', source: candidate.header, confidence: Math.min(0.9, 0.5 + bonus) };
}

/** A mostly-blank column whose filled rows mostly carry a currency code (Item 9's orig-amount shape) - never a debit/credit guess, even with no header hint at all. */
function looksLikeSparseCodedAmount(values) {
  const { fillRate, codedFrac } = columnFillAndCoding(values);
  return fillRate > 0 && fillRate < 0.5 && codedFrac >= 0.5;
}

/**
 * Suggest a header-to-field mapping for a grid of raw rows.
 * @param {string[]} header
 * @param {string[][]} sampleRows - a handful of data rows (arrays aligned to header)
 * @returns {{field: string, source: string, confidence: number}[]}
 */
export function suggestMapping(header, sampleRows = []) {
  const suggestions = [];
  const columns = header.map((_, colIdx) => sampleRows.map((r) => r[colIdx]));

  // Numeric fields (amount/debit/credit/balance): a header the dictionary
  // has never heard of ("Value (SGD)", "Net Amt", ...) still carries a
  // strong shape signal - every sample value parses as a plain number. Gating
  // entirely on the header dictionary left such a column suggested as
  // nothing at all ("Ignore this column"), even with an otherwise-unclaimed,
  // all-numeric column sitting right there.
  const SHAPE_ONLY_FIELDS = new Set(['amount', 'debit', 'credit', 'balance', 'date']);

  for (const field of Object.keys(HEADER_DICTIONARY)) {
    let best = null;
    header.forEach((h, colIdx) => {
      const headerScore = scoreHeader(h, field);
      const values = columns[colIdx] || [];
      if (headerScore === 0) {
        if (!SHAPE_ONLY_FIELDS.has(field) || !values.length) return;
        // A bank-specific header word the dictionary has never heard of
        // ("When", "Txn Date") still carries the same strong shape signal a
        // headerless amount column does - every sample value reads as a
        // date. Root cause of a real first-timer defect: a generic-header
        // CSV ("When,What,Value") matched Amount by shape but left Date
        // (and therefore Description, via the fallback below) completely
        // unmapped, so Screen A showed a table 2/3 blank with no warning.
        if (field === 'date') {
          const shapeScore = values.filter(isDateLike).length / values.length;
          if (shapeScore < 0.8) return;
          const confidence = shapeScore * 0.34; // stays below any real header match
          if (!best || confidence > best.confidence) best = { field, source: h, confidence };
          return;
        }
        // Item 9: a mostly-blank, currency-coded column (an original/foreign
        // amount, see detectOrigAmountColumn) never wins 'debit'/'credit' via
        // this header-less fallback - a real bug used to let it silently
        // steal the whole amount field in wizard.js's buildFieldsFromMapping,
        // which prefers any debit/credit mapping over a plain 'amount' one
        // regardless of which column it came from.
        const blankOk = field === 'debit' || field === 'credit';
        if (blankOk && looksLikeSparseCodedAmount(values)) return;
        // A single amount/balance column is expected filled on every real
        // row - unlike a paired debit/credit column, blank is not a valid
        // shape here (Item 9: this is what already keeps a mostly-blank
        // original/foreign-amount column, with no header word the
        // dictionary recognizes at all, from ever tying with the real,
        // fully-filled column for 'amount'/'balance').
        const shapeScore = values.filter((v) => (blankOk && (v === '' || v == null)) || isAmountLike(v)).length / values.length;
        // A strong majority (not literally every sample) must parse: the
        // handful of sample rows shown to the wizard often includes one
        // footer/summary line straight after the last transaction (this
        // fixture's "Current balance: ..."), whose short row leaves this
        // column undefined rather than blank.
        if (shapeScore < 0.8) return;
        // A single unclaimed numeric column is far more often one combined
        // amount column than a lone debit/credit/balance column (those
        // normally come paired, or alongside an already-claimed date/desc
        // column), so nudge ties toward 'amount' as the safer guess.
        const confidence = shapeScore * (field === 'amount' ? 0.36 : 0.35); // stays below any real header match
        if (!best || confidence > best.confidence) best = { field, source: h, confidence };
        return;
      }
      let shapeScore = 0.5; // neutral if no sample rows
      if (values.length) {
        if (field === 'date') shapeScore = values.filter(isDateLike).length / values.length;
        else if (field === 'debit' || field === 'credit') {
          // A paired debit/credit column is legitimately blank on roughly
          // half its rows by design, so blank is a normal, valid shape here.
          shapeScore = values.filter((v) => v === '' || isAmountLike(v)).length / values.length;
        } else if (field === 'amount' || field === 'balance') {
          // A single amount/balance column is expected to carry a value on
          // every real transaction row - unlike debit/credit, blank is NOT
          // a valid shape for it. Root cause of a real Standard Chartered
          // credit card mis-map: its "SGD Amount" (always filled) and
          // "Foreign Currency Amount" (filled only on FX rows, blank
          // otherwise) both scored 1.0 under the old blank-tolerant rule
          // and the sparser column won by being first in header order -
          // every local-currency row then had no amount at all. Blank no
          // longer counts as a match here, so the fully-filled column wins
          // outright instead of tying.
          shapeScore = values.filter(isAmountLike).length / values.length;
        } else if (field === 'currency') shapeScore = values.filter(isCurrencyCodeLike).length / values.length;
        else shapeScore = 0.8;
      }
      const confidence = Math.min(1, headerScore * 0.6 + shapeScore * 0.4);
      if (!best || confidence > best.confidence) best = { field, source: h, confidence };
    });
    if (best) suggestions.push(best);
  }
  // Fix (2026-09-18): a bank whose only narrative column is literally named
  // "Reference" (DBS savings CSV: header "Reference", no separate
  // "Description" column at all) matched HEADER_DICTIONARY.reference and
  // nothing ever matched description_raw, so a brand-new (never-mapped)
  // file's Screen A preview showed a blank Description for every row - every
  // real statement needs a narrative field, "reference" is optional. When no
  // column claimed description_raw, the best 'reference' guess becomes the
  // description_raw guess instead (not a second copy) - a file with a real,
  // separate Description column never reaches this fallback.
  if (!suggestions.some((s) => s.field === 'description_raw')) {
    const refIdx = suggestions.findIndex((s) => s.field === 'reference');
    if (refIdx !== -1) suggestions[refIdx] = { ...suggestions[refIdx], field: 'description_raw' };
  }
  // Same root cause as the date shape-fallback above: a generic header
  // ("What") the dictionary has never heard of, with no reference column to
  // borrow either, left description_raw completely unmapped. There is no
  // reliable shape test for "is this a narrative" the way there is for a
  // date or a number, so this only fires as a last resort (still nothing
  // mapped to description_raw) and picks the least numeric/date-like,
  // longest-average-text unclaimed column - a real narrative column is
  // reliably both, and a real bank statement always has one.
  if (!suggestions.some((s) => s.field === 'description_raw')) {
    const usedSources = new Set(suggestions.map((s) => s.source));
    let best = null;
    header.forEach((h, colIdx) => {
      if (usedSources.has(h)) return;
      const values = (columns[colIdx] || []).filter((v) => v != null && String(v).trim() !== '');
      if (!values.length) return;
      const textLikeFrac = values.filter((v) => !isAmountLike(v) && !isDateLike(v)).length / values.length;
      if (textLikeFrac < 0.8) return;
      const avgLen = values.reduce((sum, v) => sum + String(v).trim().length, 0) / values.length;
      if (avgLen < 2) return;
      if (!best || avgLen > best.avgLen) best = { field: 'description_raw', source: h, confidence: 0.3, avgLen };
    });
    if (best) suggestions.push({ field: best.field, source: best.source, confidence: best.confidence });
  }
  // Corpus fix (2026-09-18): with only ONE numeric column and no header word
  // for either, the shape-only fallback above scores 'debit' AND 'credit'
  // against that SAME column independently (each just checks "mostly
  // amount-shaped or blank" - a single, fully-filled column trivially passes
  // both) - a same-source debit+credit pair is never real (they're supposed
  // to be two mutually-exclusive columns), and downstream a caller that
  // (rightly) prefers any debit/credit mapping over a plain 'amount' one
  // then reads the SAME cell as both a debit and a credit. A plain 'amount'
  // suggestion for that column (already produced by the loop above whenever
  // any header/shape score fired for it) is what a single numeric column
  // really is.
  const debitS = suggestions.find((s) => s.field === 'debit');
  const creditS = suggestions.find((s) => s.field === 'credit');
  if (debitS && creditS && debitS.source === creditS.source) {
    const rest = suggestions.filter((s) => s.field !== 'debit' && s.field !== 'credit');
    const existingAmount = rest.find((s) => s.field === 'amount' && s.source === debitS.source);
    if (!existingAmount) rest.push({ field: 'amount', source: debitS.source, confidence: Math.max(debitS.confidence, creditS.confidence) });
    suggestions.length = 0;
    suggestions.push(...rest);
  }
  // Item 9: a second numeric column that's mostly blank and, where filled,
  // carries a different currency than the billed column - route it to
  // 'orig_amount' instead of leaving it a silent "Ignore this column".
  const origAmount = detectOrigAmountColumn(header, columns);
  if (origAmount) suggestions.push(origAmount);
  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

// A trailing footer/total/summary line's first cell almost always starts
// with one of these words, whatever bank printed it (shared with
// normalize.js's own import-time safety net for profiles saved before this
// existed - keep both lists in sync if either changes).
export const FOOTER_PHRASE_RE = /^(total|sub-total|subtotal|balance|closing|opening|grand|summary)\b/i;

/**
 * Trailing non-transaction rows (footer/total/summary lines) below the
 * header row, worth pre-marking as skipped in the wizard's Locate-data
 * footer checkboxes (Finding D1): scans from the bottom of the grid upward,
 * stopping at the first row that looks like a real transaction line, so only
 * only a real trailing block is ever auto-skipped.
 * @param {string[][]} grid
 * @param {number} headerRowIdx
 * @returns {number[]} row indices (below the header), ascending
 */
export function suggestFooterRows(grid, headerRowIdx) {
  const headerWidth = (grid[headerRowIdx] || []).filter((c) => String(c ?? '').trim() !== '').length;
  const looksLikeFooter = (row) => {
    if (!row || !row.length) return false;
    const filled = row.filter((c) => String(c ?? '').trim() !== '').length;
    if (filled === 0) return false;
    // Missing just one cell is normal for a real transaction row (a paired
    // debit/credit column always leaves the other one blank) - only a row
    // missing at least two cells against the header is short enough to be a
    // footer/summary line rather than a real transaction.
    if (filled <= headerWidth - 2) return true;
    return FOOTER_PHRASE_RE.test(String(row[0] ?? '').trim());
  };
  const skip = [];
  for (let i = grid.length - 1; i > headerRowIdx; i--) {
    if (looksLikeFooter(grid[i])) skip.push(i);
    else break;
  }
  return skip.reverse();
}

/**
 * Find the header row: the first row with >=3 non-empty cells that is
 * followed by at least one row of the same width (a real data table).
 * Returns the 0-based row index, or -1 if none found.
 */
export function suggestHeaderRow(grid) {
  for (let i = 0; i < grid.length - 1; i++) {
    const row = grid[i] || [];
    const nonEmpty = row.filter((c) => String(c ?? '').trim() !== '').length;
    if (nonEmpty < 3) continue;
    const next = grid[i + 1] || [];
    if (next.length === row.length) return i;
  }
  return -1;
}

/** Guess dateFormat from a sample of date-like strings. */
export function suggestDateFormat(values) {
  const samples = values.filter((v) => v != null && String(v).trim() !== '');
  if (samples.some((v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()))) return 'YYYY-MM-DD';
  if (samples.some((v) => /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(String(v).trim()))) return 'DD MMM YYYY';
  if (samples.some((v) => /^\d{1,2}\s+[A-Za-z]{3,}$/.test(String(v).trim()))) return 'DD MMM';
  const slashSamples = samples.filter((v) => /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(String(v).trim()));
  if (slashSamples.length === 0) return null;
  let overFirst = false, overSecond = false;
  for (const v of slashSamples) {
    const m = String(v).trim().match(/^(\d{1,2})[-/](\d{1,2})[-/]\d{2,4}$/);
    if (+m[1] > 12) overFirst = true;
    if (+m[2] > 12) overSecond = true;
  }
  if (overFirst && !overSecond) return 'DD/MM/YYYY';
  if (overSecond && !overFirst) return 'MM/DD/YYYY';
  return 'DD/MM/YYYY'; // ambiguous default: day-first (more common outside the US)
}

/** Guess signConvention from a mapping: separate debit/credit columns imply debitCredit. */
export function suggestSignConvention(mapping) {
  const fields = new Set(mapping.map((m) => m.field));
  if (fields.has('debit') && fields.has('credit')) return 'debitCredit';
  return 'signed';
}

/** Guess numberFormat from a sample of amount-like strings. */
export function suggestNumberFormat(values) {
  const samples = values.filter((v) => v != null && String(v).trim() !== '');
  for (const v of samples) {
    const s = String(v).trim();
    if (/,\d{3}(?:[.,]\d+)?$|,\d{3}$/.test(s) && s.includes('.')) return '1,234.56';
    if (/\.\d{3},\d{2}$/.test(s)) return '1.234,56';
  }
  // Corpus fix (2026-09-18): no sample happened to show a 3-digit thousands
  // group (a short statement, or amounts all under 1,000), but a bare
  // "740,27"-shape (comma, exactly 2 digits after, no dot anywhere) is still
  // real evidence of a comma DECIMAL separator, not thousands - without this,
  // the function fell through to the '1,234.56' default regardless, which
  // then wrongly forces every "1 234,56"/"740,27" value's comma to be read as
  // a thousands separator instead of letting amount.js's own per-value
  // digit-count fallback (used whenever no numberFormat hint locks it in)
  // read it correctly.
  for (const v of samples) {
    // Strip a trailing/leading CR/DR marker or wrapping parens first - the
    // shape check below only cares about the number itself.
    const s = String(v).trim().replace(/^(CR|DR)\s+/i, '').replace(/\s*(CR|DR)$/i, '').replace(/^\(|\)$/g, '');
    if (/,\d{2}$/.test(s) && !s.includes('.')) return '1.234,56';
    if (/\.\d{2}$/.test(s) && !s.includes(',')) return '1,234.56';
  }
  return '1,234.56';
}

// --- Wizard step 1 "Basics" pre-fill -------------------------------------

export const BANK_NAMES = [
  'DBS', 'POSB', 'OCBC', 'UOB', 'Citi', 'HSBC', 'Standard Chartered', 'Maybank',
  'Chase', 'Amex', 'Bank of America', 'Wells Fargo', 'Revolut', 'Wise', 'Trust',
  'GXS', 'MariBank',
];

const BANK_COUNTRY = {
  DBS: 'Singapore', POSB: 'Singapore', OCBC: 'Singapore', UOB: 'Singapore',
  Trust: 'Singapore', GXS: 'Singapore', MariBank: 'Singapore',
  Maybank: 'Malaysia', Citi: 'United States', Chase: 'United States', Amex: 'United States',
  'Bank of America': 'United States', 'Wells Fargo': 'United States',
  HSBC: 'United Kingdom', 'Standard Chartered': 'United Kingdom', Revolut: 'United Kingdom', Wise: 'United Kingdom',
};

const CURRENCY_COUNTRY = {
  SGD: 'Singapore', USD: 'United States', GBP: 'United Kingdom', EUR: 'Euro area',
  MYR: 'Malaysia', HKD: 'Hong Kong', AUD: 'Australia', CAD: 'Canada',
};

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Detect a known bank name from statement preamble/header text and/or filename. */
export function detectBankName(text = '', filename = '') {
  // Normalise filename separators (_ - .) to spaces so \b boundaries work
  // against "uob_statement.csv" the same as they do against prose text.
  const hay = `${text} ${filename.replace(/[_.-]/g, ' ')}`;
  for (const name of BANK_NAMES) {
    if (new RegExp(`\\b${escapeRe(name)}\\b`, 'i').test(hay)) return name;
  }
  const m = text.match(/\b([A-Z][A-Za-z&. ]{0,30}Bank\b)/);
  return m ? m[1].trim() : '';
}

/**
 * Statement type from body text: credit-card markers vs a plain deposit
 * account. Empty string when the text carries no such signal at all (Finding
 * B2: the wizard's own 'savings' default is a fallback, not a detection, and
 * must never be captioned "Suggested from your file").
 */
export function detectStatementType(text = '') {
  const t = text.toLowerCase();
  if (/credit card|credit limit|minimum payment|statement date/.test(t)) return 'credit_card';
  if (/current account/.test(t)) return 'current';
  return '';
}

const CURRENCY_SYMBOLS = [[/S\$/, 'SGD'], [/US\$/, 'USD'], [/€/, 'EUR'], [/£/, 'GBP']];
const KNOWN_CURRENCY_CODES = ['SGD', 'USD', 'EUR', 'GBP', 'MYR', 'HKD', 'AUD', 'CAD', 'JPY', 'CNY', 'INR', 'NZD', 'CHF'];

/** Default currency from ISO codes or common symbols found in the text. */
export function detectCurrency(text = '') {
  for (const [re, code] of CURRENCY_SYMBOLS) if (re.test(text)) return code;
  for (const code of KNOWN_CURRENCY_CODES) if (new RegExp(`\\b${code}\\b`).test(text)) return code;
  return '';
}

/** Best-effort country from bank name, falling back to currency. Neither guess is authoritative. */
export function detectCountry(bank = '', currency = '') {
  return BANK_COUNTRY[bank] || CURRENCY_COUNTRY[currency] || '';
}

/** Whether any sample value carries a trailing CR/DR marker (see amount.js's crdr). */
export function detectCrDrInSamples(values = []) {
  return values.some((v) => parseAmount(v).crdr != null);
}

// A "Foreign Currency Amount" style column (Standard Chartered and others):
// filled only on cross-currency rows, blank otherwise - never the primary
// transaction amount, but worth keeping as a reference column rather than
// silently dropping. Checked against the header text alone, not the
// dictionary, so it never competes with 'amount'/'orig_amount' scoring.
const FOREIGN_AMOUNT_HEADER_RE = /foreign\s*(currency\s*)?amount|fcy\s*amount/i;

/** Whether a header name looks like a "foreign currency amount" style column, worth keeping as an extra column instead of ignoring. */
export function isForeignAmountHeader(header) {
  return FOREIGN_AMOUNT_HEADER_RE.test(normHeader(header));
}

/** Whether any sample description carries a leading "[UNPOSTED]"-style pending marker, worth offering the wizard's "Treat [UNPOSTED] rows as pending" suggestion for. */
export function detectPendingPrefix(values = []) {
  return values.some((v) => /^\s*\[UNPOSTED\]/i.test(String(v ?? '')));
}

/**
 * Confidence (0..1) that `index` really is the header row: width match with
 * the next row, weighted by how "header-like" (non-numeric) its cells look.
 */
export function suggestHeaderRowConfidence(grid, index) {
  if (index == null || index < 0) return 0;
  const row = grid[index] || [];
  const nonEmpty = row.filter((c) => String(c ?? '').trim() !== '');
  if (!nonEmpty.length) return 0;
  const next = grid[index + 1] || [];
  const widthMatch = next.length === row.length;
  const textLike = nonEmpty.filter((c) => !/^-?\d+([.,]\d+)?$/.test(String(c).trim())).length / nonEmpty.length;
  return widthMatch ? Math.min(1, 0.55 + textLike * 0.45) : 0.5 * textLike;
}
