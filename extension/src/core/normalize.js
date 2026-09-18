// Apply a profile version's fields/transforms/signConvention to raw records,
// producing standard transaction rows per PROFILE_SCHEMA.md.

import { parseAmount } from './amount.js';
import { parseDate } from './date.js';
import { log } from './debuglog.js';
import { FOOTER_PHRASE_RE } from './suggest.js';
import { detectCurrency } from './currency.js';

function getSourceValue(record, source) {
  if (source == null) return '';
  if (Array.isArray(source)) return source.map((s) => record[s] ?? '').filter((v) => v !== '');
  return record[source] ?? '';
}

function applyTransform(value, transform) {
  switch (transform.op) {
    case 'trim': return String(value).trim();
    case 'upper': return String(value).toUpperCase();
    case 'lower': return String(value).toLowerCase();
    case 'replace': {
      if (transform.regex) return String(value).replace(new RegExp(transform.find, 'g'), transform.replace ?? '');
      return String(value).split(transform.find).join(transform.replace ?? '');
    }
    case 'flipSign': return -Number(value);
    case 'fixed': return transform.value;
    default: return value;
  }
}

function applyFieldTransforms(field, value, transforms = []) {
  let v = value;
  for (const t of transforms) {
    if (t.field === field) v = applyTransform(v, t);
  }
  return v;
}

function resolveAmount(record, fieldsCfg, signConvention, numberFormat, currency) {
  const cfg = fieldsCfg.amount || {};
  const opts = { numberFormat, currency };

  if (cfg.debit !== undefined || cfg.credit !== undefined) {
    const debitRaw = cfg.debit ? record[cfg.debit] : '';
    const creditRaw = cfg.credit ? record[cfg.credit] : '';
    const debit = parseAmount(debitRaw, opts);
    const credit = parseAmount(creditRaw, opts);
    if (credit.minor != null && credit.minor !== 0) return { minor: Math.abs(credit.minor), currencyHint: credit.currencyHint, ok: true };
    if (debit.minor != null && debit.minor !== 0) return { minor: -Math.abs(debit.minor), currencyHint: debit.currencyHint, ok: true };
    if (debit.minor == null && credit.minor == null) return { minor: null, currencyHint: null, ok: false };
    return { minor: 0, currencyHint: debit.currencyHint || credit.currencyHint, ok: true };
  }

  const raw = record[cfg.source];
  const parsed = parseAmount(raw, opts);
  if (parsed.minor == null) return { minor: null, currencyHint: null, ok: false };

  let minor = parsed.minor;
  // A CR/DR marker (whether its own column via cfg.crdr, or a trailing suffix
  // amount.js already peeled off the amount string) always wins over the
  // profile's declared signConvention: a card statement can say positiveIsOut
  // by default and still print "500.00 CR" for a payment, which must come out
  // positive (money in) regardless.
  const crdrSource = cfg.crdr ? record[cfg.crdr] : null;
  const marker = (crdrSource || parsed.crdr || '').toString().toUpperCase();
  let crdrApplied = false;
  if (marker.startsWith('CR') || marker.startsWith('DR')) {
    minor = marker.startsWith('DR') ? -Math.abs(minor) : Math.abs(minor);
    crdrApplied = true;
  } else if (signConvention === 'negativeIsOut') {
    // raw sign already means "out" when negative; keep as-is (out = negative).
  } else if (signConvention === 'positiveIsOut') {
    minor = -minor;
  }
  // 'signed'/'crdr' without a marker present: trust the parsed sign as-is.
  return { minor, currencyHint: parsed.currencyHint, ok: true, crdrApplied, marker: crdrApplied ? marker : null };
}

// Below this OCR word confidence (0-100), a row derived from on-device text
// recognition gets a real, actionable warning (flag 'low_confidence_ocr'),
// not just the informational 'ocr' provenance flag every OCR row carries.
// Scoped to the amount and date tokens specifically (record._amountConfidence
// / record._dateConfidence, set by core/pdf.js's extractRows/
// extractGroupedRows), never the description or type text: a misread
// merchant-name word made this flag fire on rows whose actual transaction
// data read fine, which was flagged as "too eager" - stepping
// through low-confidence rows one by one felt untrustworthy for something
// that wasn't actually wrong. 70, not 80, per the same feedback.
export const OCR_LOW_CONFIDENCE_THRESHOLD = 70;

/**
 * Normalize raw records into standard transaction rows.
 * @param {object[]} records - row objects keyed by source header (from csv.js), or pdf row objects.
 * @param {object} version - a profile version per PROFILE_SCHEMA.md.
 * @param {object} meta - { bank, statementType, sourceFile, accountLabel, period: {startISO,endISO}, currency, ocr?:boolean }
 */
export function normalizeRecords(records, version, meta = {}) {
  const fieldsCfg = version.fields || {};
  const transforms = version.transforms || [];
  const dateFormat = version.dateFormat;
  const numberFormat = version.numberFormat;
  const signConvention = version.signConvention || 'signed';
  const seen = new Map(); // fingerprint -> count, for possible-duplicate flag

  const rows = records.map((record, idx) => {
    const flags = [];
    const original = { ...record };

    // date
    const dateRaw = getSourceValue(record, fieldsCfg.date?.source);
    const yearHint = meta.period?.startISO ? new Date(meta.period.startISO).getUTCFullYear() : meta.year;
    let date = dateRaw ? parseDate(dateRaw, dateFormat, { year: yearHint }) : null;

    const postDateRaw = getSourceValue(record, fieldsCfg.post_date?.source);
    const post_date = postDateRaw ? parseDate(postDateRaw, dateFormat) : null;

    // description
    let descParts = getSourceValue(record, fieldsCfg.description_raw?.source);
    if (!Array.isArray(descParts)) descParts = [descParts];
    let description_raw = descParts.join(fieldsCfg.description_raw?.join ?? ' ').trim();
    description_raw = applyFieldTransforms('description_raw', description_raw, transforms);

    // currency - resolved BEFORE the amount is parsed (core/currency.js's
    // detectCurrency, CU-1 order: column -> header -> symbol -> profile
    // default), since which currency's decimal count applies depends on it:
    // a profile whose default is SGD (2 decimals) applied to a JPY
    // (0 decimals) column must not parse "15000" as 150.00 SGD's minor units.
    const curCfg = fieldsCfg.currency || { mode: 'profileDefault' };
    const amountCfg = fieldsCfg.amount || {};
    const amountRawText = (amountCfg.debit !== undefined || amountCfg.credit !== undefined)
      ? [amountCfg.credit ? record[amountCfg.credit] : '', amountCfg.debit ? record[amountCfg.debit] : ''].join(' ')
      : String(record[amountCfg.source] ?? '');
    const { currency } = detectCurrency({
      columnValue: curCfg.mode === 'column' && curCfg.source ? record[curCfg.source] : undefined,
      headerHint: curCfg.mode === 'header' ? curCfg.value : undefined,
      rowText: amountRawText,
      profileDefault: meta.currency,
    });

    // amount - parsed with the row's own resolved currency, not the profile
    // default, so the right decimal count is used.
    const amountResult = resolveAmount(record, fieldsCfg, signConvention, numberFormat, currency);
    if (amountResult.crdrApplied) {
      log('normalize', 'CR/DR marker overrides sign convention', {
        sourceFile: meta.sourceFile, sourceLine: idx, marker: amountResult.marker, signConvention, minor: amountResult.minor,
      });
    }

    // Finding D1: a trailing Total/Balance/... row can still parse a real
    // number (a footer's own subtotal, e.g. "Total ... 3000.00") even though
    // it isn't a transaction - relying on !amountResult.ok alone missed
    // exactly that case. A CSV/XLSX-sourced record (version.csv set; a PDF
    // row's fixed keys never look like this) with no readable date whose
    // first non-empty cell starts with a footer word is a non-transaction
    // line regardless of whether some other cell happened to parse as a
    // number - this is the safety net for a profile saved before footerRules
    // covered this file's exact footer text (wizard.js's own footerRules is
    // still the first line of defense, cutting the row before it ever
    // reaches here).
    const looksLikeFooterRow = !date && !!version.csv && (() => {
      const firstCell = Object.values(original).map((v) => String(v ?? '').trim()).find(Boolean) || '';
      return FOOTER_PHRASE_RE.test(firstCell);
    })();

    // A row whose date AND amount both fail to parse is a non-transaction line
    // (statement summary text, totals, footers) that slipped through csv.js's
    // row filter, not a flagged transaction. Rows where only one of the two
    // fails remain flagged transactions, same as before.
    const skipped = (!date && !amountResult.ok) || looksLikeFooterRow;
    if (!skipped) {
      if (!date) flags.push('unparseable_date');
      if (!amountResult.ok) flags.push('missing_amount');
    }

    // balance
    const balanceRaw = getSourceValue(record, fieldsCfg.balance?.source);
    const balance = balanceRaw ? parseAmount(balanceRaw, { numberFormat, currency }).minor : null;

    // orig_amount/orig_currency: default to mirroring the resolved amount
    // (a later FX-conversion pass, home.js, overwrites these) - Item 9
    // (2026-09-17): a mapped orig_amount source column (suggest.js's
    // detectOrigAmountColumn) overrides that default ONLY on a row whose
    // own cell actually carries a currency code different from the
    // resolved `currency` above; a same-currency or code-less value in that
    // column (real messy exports print both) is never treated as "original"
    // - see suggest.js's own doc comment for why a bare number there isn't
    // proof of anything.
    let orig_amount = amountResult.minor;
    let orig_currency = currency;
    if (fieldsCfg.orig_amount?.source) {
      const origRaw = record[fieldsCfg.orig_amount.source];
      const codeMatch = String(origRaw ?? '').trim().match(/^([A-Za-z]{3})\b/);
      const code = codeMatch ? codeMatch[1].toUpperCase() : null;
      if (code && code !== currency) {
        const parsedOrig = parseAmount(origRaw, { numberFormat, currency: code });
        if (parsedOrig.minor != null) { orig_amount = parsedOrig.minor; orig_currency = code; }
      }
    }

    // reference
    const reference = getSourceValue(record, fieldsCfg.reference?.source);

    // extras
    const extra = {};
    for (const e of fieldsCfg.extra || []) {
      extra[e.name] = record[e.source] ?? '';
    }

    if (!skipped && meta.period && date) {
      if ((meta.period.startISO && date < meta.period.startISO) || (meta.period.endISO && date > meta.period.endISO)) {
        flags.push('date_outside_period');
      }
    }

    if (!skipped) {
      const fingerprint = [meta.accountLabel, date, amountResult.minor, currency, description_raw.toLowerCase()].join('|');
      const count = (seen.get(fingerprint) || 0) + 1;
      seen.set(fingerprint, count);
      if (count > 1) flags.push('possible_duplicate');
    }

    // OCR provenance: 'ocr' is informational only (home-state.js's warning
    // count excludes it), so a clean OCR read still shows a plain health
    // badge; 'low_confidence_ocr' is the real, actionable warning, and only
    // looks at the amount/date tokens themselves (record._amountConfidence /
    // _dateConfidence, see core/pdf.js) - never the description or type text.
    let amount_alt = null;
    let low_confidence_hint = null;
    if (meta.ocr) {
      flags.push('ocr');
      const worstConfidence = [record._amountConfidence, record._dateConfidence]
        .filter((v) => v != null)
        .reduce((min, v) => (min == null ? v : Math.min(min, v)), null);
      if (!skipped && worstConfidence != null && worstConfidence < OCR_LOW_CONFIDENCE_THRESHOLD) {
        flags.push('low_confidence_ocr');
        // Follow-up (2026-09-17): core/ocr.js's safety net (see
        // findAmountRetryCandidates/applyAmountRetryResults) stamps
        // confidence exactly 0 on ONE specific situation - an amount token
        // that still has no decimal point in a file where most amounts do -
        // never on a merely-uncertain read. That's almost always a decimal
        // point dropped in OCR (e.g. "173" for "1.73"), a single, reversible
        // shift, so surface the likely correct value directly instead of
        // leaving the user to guess: record._amountConfidence === 0 is the
        // exact signal ocr.js reserves for this case, and a whole-number
        // amount (no cents) is the corroborating shape.
        if (record._amountConfidence === 0 && amountResult.ok && amountResult.minor % 100 === 0) {
          const readAsDollars = Math.abs(amountResult.minor) / 100;
          const altMinor = Math.round(amountResult.minor / 100);
          const likelyDollars = (Math.abs(altMinor) / 100).toFixed(2);
          amount_alt = altMinor;
          low_confidence_hint = `Amount read as ${readAsDollars} with no decimal point. Likely ${likelyDollars}. Check against the page.`;
        }
      }
    }

    // A grouped-rowModel PDF row (OCR'd or not) whose sign core/pdf.js's
    // resolveGroupedSign had to guess at (no +/-, CR/DR, or columnBands
    // resolved it) - the amount value is still a real number, just flagged
    // so the row is never silently wrong: "at worst it lands as a row with a
    // sign unclear flag", never a missing one.
    if (!skipped && record._signUnclear) flags.push('sign_unclear');

    // Item e: a "[UNPOSTED]"-style prefix (Standard Chartered credit card
    // exports print this on transactions not yet posted to the account)
    // is informational, not a warning - description_raw stays byte-for-byte
    // as printed (never stripped), this just tags the row. Opt-in via the
    // wizard's "Treat [UNPOSTED] rows as pending" suggestion
    // (version.pendingPrefix), so a bank that happens to print the same
    // literal text for something else never gets it applied silently.
    if (!skipped && version.pendingPrefix && description_raw.trim().toUpperCase().startsWith(version.pendingPrefix.toUpperCase())) {
      flags.push('pending');
    }

    return {
      row_id: `${meta.sourceFile || 'file'}:${idx}`,
      date,
      date_raw: dateRaw || null,
      post_date,
      description_raw,
      merchant: null,
      amount: amountResult.minor,
      amount_alt,
      currency,
      orig_amount,
      orig_currency,
      balance,
      account_label: meta.accountLabel ?? null,
      bank: meta.bank ?? null,
      statement_type: meta.statementType ?? null,
      reference: Array.isArray(reference) ? reference.join(' ') : reference,
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v])),
      source_file: meta.sourceFile ?? null,
      source_page: null,
      source_line: idx,
      profile_version: version.id ?? null,
      flags,
      low_confidence_hint,
      skipped,
      excluded: false,
      edited: false,
      original,
    };
  });

  return rows;
}
