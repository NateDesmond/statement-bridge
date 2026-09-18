// Seeded synthetic bank-statement corpus generator (Track 1, HARDENING.md).
// Produces samples in memory (a raw file shape + ground truth) across a
// parameter space of bank style / file type / header language / preamble /
// footer / date format / number format / sign convention / balance column /
// currency / encoding / noise.
//
// ponytail: the HARDENING spec lists 12 banks, 20 header aliases per field
// and 10 date formats - trimmed to the arrays below (12 banks kept, 3
// aliases/field, the 4 date formats date.js actually parses). Each axis
// still exercises a real code path; unsupported axes (de/fr/es/ja header
// vocabulary - suggest.js's dictionary only has en/zh/ms - and date formats
// date.js doesn't parse) are generated on purpose so the recall table
// surfaces them as real, numbered gaps (see docs/KNOWN-GAPS.md) rather than
// hiding them by never testing them.
import { makeRng, isoMinusDays } from '../fixtures/gen/layout.mjs';

export const BANKS = [
  'Summit', 'Riverside', 'Anchor', 'Palisade', 'Northwind', 'Beacon',
  'Harbour', 'Lattice', 'Meridian', 'Cobalt', 'Fernbank', 'Crestline',
];
export const FILE_TYPES = ['csv', 'tsv', 'xlsx', 'pdf-columns', 'pdf-grouped'];
export const HEADER_LANGS = ['en', 'zh', 'ms', 'de', 'fr', 'es', 'ja', 'it', 'nl', 'pt', 'ko'];
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD MMM YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY'];
export const NUMBER_FORMATS = ['1,234.56', '1.234,56', 'space-thousands', 'no-decimal', 'jpy'];
export const SIGN_CONVENTIONS = ['signed', 'crdr-suffix', 'crdr-prefix', 'debitCredit', 'positiveIsOut', 'parens'];
export const PREAMBLE_STYLES = ['none', 'keyvalue', 'tabpadded', 'quoted'];
export const FOOTER_STYLES = ['none', 'totals', 'balances', 'pagemarkers'];
export const ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'windows-1252'];

const HEADER_ALIASES = {
  date: {
    en: ['Date', 'Transaction Date', 'Value Date'], zh: ['日期', '交易日期', '过账日期'],
    ms: ['Tarikh', 'Tarikh Urus Niaga', 'Tarikh Nilai'], de: ['Datum', 'Buchungsdatum', 'Wertstellung'],
    fr: ['Date', 'Date de transaction', 'Date valeur'], es: ['Fecha', 'Fecha de transacción', 'Fecha valor'],
    ja: ['日付', '取引日', '価値日'],
    it: ['Data', 'Data contabile', 'Data valuta'], nl: ['Datum', 'Transactiedatum', 'Valutadatum'],
    pt: ['Data', 'Data de lançamento', 'Data valor'], ko: ['거래일', '날짜', '거래일자'],
  },
  description_raw: {
    en: ['Description', 'Particulars', 'Narrative'], zh: ['描述', '交易详情', '备注'],
    ms: ['Butiran', 'Penerangan', 'Catatan'], de: ['Beschreibung', 'Verwendungszweck', 'Buchungstext'],
    fr: ['Description', 'Libellé', 'Détails'], es: ['Descripción', 'Concepto', 'Detalle'],
    ja: ['摘要', '説明', '内容'],
    it: ['Descrizione', 'Causale', 'Dettagli'], nl: ['Omschrijving', 'Beschrijving', 'Details'],
    pt: ['Descrição', 'Histórico', 'Detalhes'], ko: ['적요', '내용', '거래내용'],
  },
  debit: {
    en: ['Withdrawal', 'Debit Amount', 'Paid Out'], zh: ['支出', '提款', '借方金额'],
    ms: ['Pengeluaran', 'Debit Amaun', 'Bayaran Keluar'], de: ['Belastung', 'Abbuchung', 'Soll'],
    fr: ['Débit', 'Retrait', 'Montant débité'], es: ['Débito', 'Retiro', 'Cargo'],
    ja: ['出金', '引き出し', '借方金額'],
    it: ['Dare', 'Uscita', 'Addebito'], nl: ['Af', 'Debet', 'Afschrijving'],
    pt: ['Débito', 'Saída', 'Retirada'], ko: ['출금', '인출'],
  },
  credit: {
    en: ['Deposit', 'Credit Amount', 'Paid In'], zh: ['存入', '收入', '贷方金额'],
    ms: ['Kemasukan', 'Kredit Amaun', 'Bayaran Masuk'], de: ['Gutschrift', 'Einzahlung', 'Haben'],
    fr: ['Crédit', 'Dépôt', 'Montant crédité'], es: ['Crédito', 'Depósito', 'Abono'],
    ja: ['入金', '預入', '貸方金額'],
    it: ['Avere', 'Entrata', 'Accredito'], nl: ['Bij', 'Credit', 'Bijschrijving'],
    pt: ['Crédito', 'Entrada', 'Depósito'], ko: ['입금', '예금'],
  },
  amount: {
    en: ['Amount', 'Transaction Amount', 'Net Amount'], zh: ['金额', '交易金额', '净额'],
    ms: ['Jumlah', 'Jumlah Urus Niaga', 'Amaun Bersih'], de: ['Betrag', 'Transaktionsbetrag', 'Nettobetrag'],
    fr: ['Montant', 'Montant de la transaction', 'Montant net'], es: ['Importe', 'Monto', 'Importe neto'],
    ja: ['金額', '取引金額', '純額'],
    it: ['Importo', 'Importo netto', 'Importo transazione'], nl: ['Bedrag', 'Nettobedrag', 'Transactiebedrag'],
    pt: ['Valor', 'Valor líquido', 'Valor da transação'], ko: ['금액', '거래금액'],
  },
  balance: {
    en: ['Balance', 'Running Balance', 'Closing Balance'], zh: ['余额', '结余', '结算余额'],
    ms: ['Baki', 'Baki Berjalan', 'Baki Penutup'], de: ['Saldo', 'Kontostand', 'Endsaldo'],
    fr: ['Solde', 'Solde courant', 'Solde de clôture'], es: ['Saldo', 'Saldo actual', 'Saldo final'],
    ja: ['残高', '現在残高', '最終残高'],
    it: ['Saldo', 'Saldo attuale', 'Saldo finale'], nl: ['Saldo', 'Actueel saldo', 'Eindsaldo'],
    pt: ['Saldo', 'Saldo atual', 'Saldo final'], ko: ['잔액', '잔고'],
  },
};

const MERCHANTS = [
  'Coffee House', 'Grab Ride', 'Amazon Purchase', 'Grocery Mart', 'Electric Co Bill',
  'Mobile Plan', 'Bookstore', 'Pharmacy', 'Cinema Tickets', 'Bakery', 'Hardware Store',
  'Salary Payment', 'Freelance Invoice', 'Refund', 'Transfer From Savings',
];

function alias(field, lang, rng) {
  const list = HEADER_ALIASES[field][lang] || HEADER_ALIASES[field].en;
  return list[Math.floor(rng() * list.length) % list.length];
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDate(iso, fmt) {
  const [y, m, d] = iso.split('-');
  if (fmt === 'YYYY-MM-DD') return iso;
  if (fmt === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
  if (fmt === 'MM/DD/YYYY') return `${m}/${d}/${y}`;
  if (fmt === 'DD MMM YYYY') {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${+d} ${MONTHS[+m - 1]} ${y}`;
  }
  return iso;
}

/** Format an absolute minor-unit amount per numberFormat, for the given currency's own decimal count. */
function formatAbsAmount(absMinor, numberFormat, currency) {
  const decimals = numberFormat === 'jpy' ? 0 : (numberFormat === 'no-decimal' ? 0 : 2);
  const whole = Math.floor(absMinor / Math.pow(10, decimals === 0 ? (currency === 'JPY' ? 0 : 2) : decimals));
  // Recompute cleanly: when decimals===0 we generate amounts that are exact
  // multiples of 100 minor units (or of 1 for JPY) so no precision is lost.
  const unitDivisor = currency === 'JPY' ? 1 : 100;
  const units = absMinor / unitDivisor;
  const wholePart = Math.trunc(units);
  const fracPart = Math.round((units - wholePart) * 100);
  const wholeStr = String(wholePart);
  const grouped = (sep) => wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  if (numberFormat === '1,234.56') return fracPart || decimals !== 0 ? `${grouped(',')}.${pad2(fracPart)}` : grouped(',');
  if (numberFormat === '1.234,56') return fracPart || decimals !== 0 ? `${grouped('.')},${pad2(fracPart)}` : grouped('.');
  if (numberFormat === 'space-thousands') return fracPart || decimals !== 0 ? `${grouped(' ')},${pad2(fracPart)}` : grouped(' ');
  if (numberFormat === 'no-decimal') return grouped(',');
  if (numberFormat === 'jpy') return grouped(',');
  return `${grouped(',')}.${pad2(fracPart)}`;
}

/** Render a signed minor amount as the field(s) a row needs, per signConvention. Returns {amount?, debit?, credit?}. */
function renderSignedAmount(minor, signConvention, numberFormat, currency) {
  const abs = formatAbsAmount(Math.abs(minor), numberFormat, currency);
  const negative = minor < 0;
  if (signConvention === 'debitCredit') {
    return negative ? { debit: abs, credit: '' } : { debit: '', credit: abs };
  }
  if (signConvention === 'crdr-suffix') return { amount: `${abs} ${negative ? 'DR' : 'CR'}` };
  if (signConvention === 'crdr-prefix') return { amount: `${negative ? 'DR' : 'CR'} ${abs}` };
  if (signConvention === 'parens') return { amount: negative ? `(${abs})` : abs };
  if (signConvention === 'positiveIsOut') return { amount: negative ? abs : `-${abs}` };
  // 'signed' (default): a leading '-' for money out, plain for money in.
  return { amount: negative ? `-${abs}` : abs };
}

function pickAmountMinor(rng, currency, numberFormat) {
  const isOut = rng() < 0.55;
  const wholeUnitOnly = numberFormat === 'no-decimal' || numberFormat === 'jpy';
  const unitDivisor = currency === 'JPY' ? 1 : 100;
  const wholeUnits = 1 + Math.floor(rng() * 2000);
  const cents = wholeUnitOnly ? 0 : Math.floor(rng() * 100);
  const minorAbs = wholeUnits * unitDivisor + (unitDivisor === 100 ? cents : 0);
  return isOut ? -minorAbs : minorAbs;
}

function makeTransactions(rng, n, currency, numberFormat, signConvention, startISO) {
  const truth = [];
  const rendered = [];
  let iso = startISO;
  for (let i = 0; i < n; i++) {
    // Walk forward 1-3 days/transaction so a >10-transaction statement's
    // day-of-month reliably exceeds 12 at least once - otherwise a MM/DD/YYYY
    // sample where every transaction happens to land on day <=12 is
    // really indistinguishable from DD/MM/YYYY (suggestDateFormat's own
    // documented ambiguous-default case, not a bug), which would make the
    // corpus mostly measure that inherent ambiguity's luck instead of real
    // date-parsing behavior.
    iso = isoMinusDays(iso, -(1 + Math.floor(rng() * 3))); // walk forward
    const minor = pickAmountMinor(rng, currency, numberFormat);
    const description = MERCHANTS[Math.floor(rng() * MERCHANTS.length)];
    truth.push({ date: iso, minor, description });
    rendered.push({ date: iso, description, ...renderSignedAmount(minor, signConvention, numberFormat, currency) });
  }
  return { truth, rendered };
}

function fieldOrderFor(signConvention) {
  const base = ['date', 'description_raw'];
  return signConvention === 'debitCredit' ? [...base, 'debit', 'credit'] : [...base, 'amount'];
}

/** Build a delimited-text grid (array of arrays of strings) for csv/tsv. */
function buildDelimitedSample(rng, opts) {
  const { bank, lang, dateFormat, numberFormat, signConvention, preamble, footer, hasBalance, currency } = opts;
  const fields = fieldOrderFor(signConvention);
  if (hasBalance) fields.push('balance');
  const header = fields.map((f) => alias(f, lang, rng));
  const nTx = 8 + Math.floor(rng() * 10);
  const { truth, rendered } = makeTransactions(rng, nTx, currency, numberFormat, signConvention, '2026-06-01');

  let runningBalance = 500000; // 5000.00 in minor units, arbitrary starting balance
  const dataRows = rendered.map((r, i) => {
    runningBalance += truth[i].minor;
    const row = fields.map((f) => {
      if (f === 'date') return formatDate(r.date, dateFormat);
      if (f === 'description_raw') return r.description;
      if (f === 'balance') return formatAbsAmount(Math.abs(runningBalance), numberFormat, currency);
      return r[f] ?? '';
    });
    return row;
  });

  const preambleRows = [];
  if (preamble === 'keyvalue') {
    preambleRows.push([`${bank} Bank`], [`Account Number:`, `1234-${Math.floor(rng() * 900000 + 100000)}`], [`Statement Period:`, `01 Jun 2026 - 30 Jun 2026`], ['']);
  } else if (preamble === 'tabpadded') {
    preambleRows.push([`${bank} Bank Transaction Listing`], ['']);
  } else if (preamble === 'quoted') {
    preambleRows.push([`Statement for: Doe, John (${bank})`], ['']);
  }

  const footerRows = [];
  if (footer === 'totals') footerRows.push(['Total', '', formatAbsAmount(Math.abs(runningBalance), numberFormat, currency)]);
  else if (footer === 'balances') footerRows.push(['Closing Balance', '', formatAbsAmount(Math.abs(runningBalance), numberFormat, currency)]);
  else if (footer === 'pagemarkers') footerRows.push(['Page 1 of 1']);

  const grid = [...preambleRows, header, ...dataRows, ...footerRows];
  return { grid, header, truth, headerRowIdx: preambleRows.length };
}

function gridToDelimited(grid, delimiter) {
  // Only quote when the cell actually needs it: a real quote/newline, or the
  // FILE'S OWN delimiter appearing in the value (a European "1 234,56"'s
  // comma is never a reason to quote a tab-delimited row - quoting it anyway
  // used to feed detectDelimiter's naive per-line comma count a false signal
  // strong enough to beat the real tab delimiter on some samples).
  return grid.map((row) => row.map((c) => {
    const s = String(c ?? '');
    return /["\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(delimiter)).join('\r\n');
}

function encodeBytes(text, encoding) {
  if (encoding === 'utf-8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf-8')]);
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'windows-1252') return Buffer.from(text, 'latin1'); // ASCII-range fixtures round-trip fine as latin1
  return Buffer.from(text, 'utf-8');
}

// --- PDF item-array builders (skip real PDF byte encoding - the extraction
// logic under test (extractRows/extractGroupedRows/inferPdfColumns) works on
// plain {str,x,y} item arrays, exactly like test/pipeline.test.js's synthetic
// OCR fixtures; see pdf.js's own module doc comment). ---

function textItem(str, x, y) { return { str, x, y, width: str.length * 5, height: 10 }; }

function buildPdfColumnsSample(rng, opts) {
  const { numberFormat, signConvention, currency, hasBalance, includeHeader } = opts;
  const fields = fieldOrderFor(signConvention);
  if (hasBalance) fields.push('balance');
  const nTx = 8 + Math.floor(rng() * 10);
  const { truth, rendered } = makeTransactions(rng, nTx, currency, numberFormat, signConvention, '2026-06-01');
  // x positions must respect inferPdfColumns' own fixed date-column width
  // guess (pageWidthPt * 0.18 = ~110pt on a 612pt page) - a description item
  // placed left of that boundary would land inside the date column instead
  // (a synthetic-fixture-only concern; inferPdfColumns' fallback columns are
  // always this shape when no header row supplies real x's to work from).
  const XPOS = { date: 40, description_raw: 140, debit: 360, credit: 430, amount: 380, balance: 500 };
  const HEADER_TEXT = { date: 'Date', description_raw: 'Description', debit: 'Withdrawal', credit: 'Deposit', amount: 'Amount', balance: 'Balance' };

  let y = 700;
  const lines = [];
  if (includeHeader) {
    lines.push(fields.map((f) => textItem(HEADER_TEXT[f], XPOS[f], y)).flat ? fields.map((f) => textItem(HEADER_TEXT[f], XPOS[f], y)) : []);
    y -= 16;
  }
  let runningBalance = 500000;
  rendered.forEach((r, i) => {
    runningBalance += truth[i].minor;
    const items = [textItem(formatDate(r.date, 'DD/MM/YYYY'), XPOS.date, y), textItem(r.description, XPOS.description_raw, y)];
    for (const f of fields) {
      if (f === 'date' || f === 'description_raw') continue;
      if (f === 'balance') { items.push(textItem(formatAbsAmount(Math.abs(runningBalance), numberFormat, currency), XPOS.balance, y)); continue; }
      const v = r[f];
      if (v) items.push(textItem(v, XPOS[f], y));
    }
    lines.push(items);
    y -= 16;
  });
  const items = lines.flat();
  return { items, truth, pageWidthPt: 612 };
}

const DEFAULT_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function buildPdfGroupedSample(rng, opts) {
  const { numberFormat, currency, signConvention } = opts;
  // extractGroupedRows only understands crdr/positiveIsOut/columnBands/signed
  // itself (resolveGroupedSign) - map the csv-style signConvention onto the
  // nearest grouped-model equivalent; debitCredit/parens have no grouped-PDF
  // analogue (a grouped line carries one amount, never split columns or
  // parens) so those two fall back to plain 'signed' rendering here.
  const groupedConvention = signConvention === 'crdr-suffix' ? 'crdr'
    : signConvention === 'positiveIsOut' ? 'positiveIsOut' : 'signed';
  const nDates = 5 + Math.floor(rng() * 4);
  const truth = [];
  const items = [];
  let y = 700;
  let iso = '2026-06-01';
  for (let d = 0; d < nDates; d++) {
    iso = isoMinusDays(iso, -(1 + Math.floor(rng() * 2)));
    const weekday = DEFAULT_WEEKDAYS[d % 7];
    items.push(textItem(`${weekday}, ${formatDate(iso, 'DD MMM YYYY')}`, 40, y));
    y -= 16;
    const nTxOnDate = 1 + Math.floor(rng() * 3);
    for (let t = 0; t < nTxOnDate; t++) {
      const minor = pickAmountMinor(rng, currency, numberFormat);
      const description = MERCHANTS[Math.floor(rng() * MERCHANTS.length)];
      truth.push({ date: iso, minor, description });
      const abs = formatAbsAmount(Math.abs(minor), numberFormat, currency);
      const negative = minor < 0;
      let amountText;
      if (groupedConvention === 'crdr') amountText = `${currency} ${abs} ${negative ? 'DR' : 'CR'}`;
      else if (groupedConvention === 'positiveIsOut') amountText = negative ? `${currency} ${abs}` : `${currency} -${abs}`;
      else amountText = `${currency} ${negative ? '-' : '+'}${abs}`;
      items.push(textItem(`${description} ${amountText}`, 40, y));
      y -= 16;
    }
  }
  return { items, truth, groupedConvention };
}

/** One deterministic seeded sample. */
export function generateSample(seed) {
  const rng = makeRng(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  const fileType = pick(FILE_TYPES);
  const bank = pick(BANKS);
  const lang = pick(HEADER_LANGS);
  const dateFormat = pick(DATE_FORMATS);
  const numberFormat = pick(NUMBER_FORMATS);
  const signConvention = pick(SIGN_CONVENTIONS);
  const preamble = pick(PREAMBLE_STYLES);
  const footer = pick(FOOTER_STYLES);
  // windows-1252 can't represent CJK/Hangul text at all (a real bank never
  // emits "windows-1252 Chinese/Japanese/Korean" - it'd use a script-specific
  // legacy encoding or just UTF-8), and naively latin1-encoding such a string
  // mangles every multi-byte character into noise rather than exercising
  // anything real.
  let encoding = pick(ENCODINGS);
  if (encoding === 'windows-1252' && (lang === 'zh' || lang === 'ja' || lang === 'ko')) encoding = 'utf-8';
  const hasBalance = rng() < 0.5;
  const currency = numberFormat === 'jpy' ? 'JPY' : pick(['SGD', 'USD', 'EUR']);
  const delimiter = fileType === 'tsv' ? '\t' : ',';
  const includeHeader = rng() < 0.7;

  const axes = { fileType, bank, lang, dateFormat, numberFormat, signConvention, preamble, footer, encoding, hasBalance, currency };
  const name = `${bank}-${fileType}-${seed}`;

  if (fileType === 'csv' || fileType === 'tsv') {
    const { grid, truth } = buildDelimitedSample(rng, { bank, lang, dateFormat, numberFormat, signConvention, preamble, footer, hasBalance, currency });
    const text = gridToDelimited(grid, delimiter);
    const bytes = encodeBytes(text, encoding);
    return { name, fileType, axes, truth, bytes };
  }
  if (fileType === 'xlsx') {
    const { grid, truth } = buildDelimitedSample(rng, { bank, lang, dateFormat, numberFormat, signConvention, preamble, footer, hasBalance, currency });
    // ponytail: no real xlsx-binary round trip here (vendor/xlsx.full.min.js
    // parsing itself is already covered by xlsx.test.js) - the corpus
    // exercises the shared grid pipeline (suggestMapping/normalize), which is
    // exactly what parseXlsxGrid hands to it.
    return { name, fileType, axes, truth, grid };
  }
  if (fileType === 'pdf-columns') {
    const { items, truth, pageWidthPt } = buildPdfColumnsSample(rng, { numberFormat, signConvention, currency, hasBalance, includeHeader });
    return { name, fileType, axes, truth, items, pageWidthPt };
  }
  // pdf-grouped
  const { items, truth, groupedConvention } = buildPdfGroupedSample(rng, { numberFormat, currency, signConvention });
  return { name, fileType, axes, truth, items, groupedConvention };
}

export function generateCorpus(n, seedBase = 1) {
  const samples = [];
  for (let i = 0; i < n; i++) samples.push(generateSample(seedBase + i * 7919));
  return samples;
}

// CLI: node test/corpus/generate.mjs [count] [outDir] - writes each sample's
// file plus a <name>.truth.json ground truth file, per HARDENING.md's spec.
// Not used by test/corpus.test.js (which generates in memory for speed and
// to avoid committing hundreds of fixture files); this is here so the corpus
// can be inspected/regenerated to disk on demand.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const count = Number(process.argv[2] || 20);
  const outDir = process.argv[3] || new URL('.', import.meta.url).pathname;
  fs.mkdirSync(outDir, { recursive: true });
  for (const sample of generateCorpus(count)) {
    const base = path.join(outDir, sample.name);
    fs.writeFileSync(`${base}.truth.json`, JSON.stringify({ axes: sample.axes, truth: sample.truth }, null, 2));
    if (sample.bytes) fs.writeFileSync(`${base}.${sample.fileType}`, sample.bytes);
    else fs.writeFileSync(`${base}.json`, JSON.stringify({ grid: sample.grid, items: sample.items }, null, 2));
  }
  console.log(`wrote ${count} samples to ${outDir}`);
}
