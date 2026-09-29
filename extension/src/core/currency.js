// Currency detection order (CU-1) and multi-currency modes A (keep, per-currency
// totals) / B (convert to a target with saved rates).

import { decimalsFor } from './amount.js';

const SYMBOL_TO_CODE = { 'S$': 'SGD', 'US$': 'USD', 'HK$': 'HKD', 'A$': 'AUD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };

// P0-4 (PASS 4): any three capital letters used to be accepted as a
// currency, so a description word that drifted into the currency column on
// an OCR'd statement exported as Currency "LTD" or "CIT". Active ISO 4217
// codes, the whole list - a three-letter shape is not proof of a currency.
export const ISO_CURRENCY_CODES = new Set(`
AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD
CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL
GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD
KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO
NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD
SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYI UYU UYW UZS VED VES VND VUV WST
XAF XCD XCG XDR XOF XPF YER ZAR ZMW ZWG
`.trim().split(/\s+/));

/** Is this text an active ISO 4217 currency code? "SGD" yes, "LTD" no. */
export function isKnownCurrencyCode(code) {
  return ISO_CURRENCY_CODES.has(String(code ?? '').trim().toUpperCase());
}

/**
 * Detect a row's currency per CU-1 order: column value -> header hint ->
 * row code/symbol -> profile default. A bare "$" is never guessed.
 * @param {{columnValue?:string, headerHint?:string, rowText?:string, profileDefault?:string}} sources
 */
export function detectCurrency(sources = {}) {
  // P0-4: a three-letter token that is not a real ISO code (an OCR'd
  // description word landing in the currency column) never becomes the row's
  // currency - it is reported back as `unknownCode` so the caller can flag
  // the row, and detection falls through to the statement's own currency.
  let unknownCode = null;
  const take = (raw, source) => {
    const v = String(raw).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(v)) return null;
    if (!isKnownCurrencyCode(v)) { unknownCode ??= v; return null; }
    return { currency: v, source, unknownCode: null };
  };
  if (sources.columnValue) {
    const hit = take(sources.columnValue, 'column');
    if (hit) return hit;
  }
  if (sources.headerHint) {
    const hit = take(sources.headerHint, 'header');
    if (hit) return hit;
  }
  if (sources.rowText) {
    const bySymbolLengthDesc = Object.entries(SYMBOL_TO_CODE).sort((a, b) => b[0].length - a[0].length);
    for (const [sym, code] of bySymbolLengthDesc) {
      if (sources.rowText.includes(sym)) return { currency: code, source: 'symbol', unknownCode: null };
    }
    const codeMatch = sources.rowText.match(/\b([A-Z]{3})\b/);
    if (codeMatch) {
      const hit = take(codeMatch[1], 'symbol');
      if (hit) return hit;
    }
  }
  if (sources.profileDefault) return { currency: sources.profileDefault, source: 'profileDefault', unknownCode };
  return { currency: null, source: null, unknownCode };
}

/** Mode A: keep each row's own currency, report totals grouped per currency. */
export function totalsPerCurrency(rows) {
  const totals = {};
  for (const r of rows) {
    if (r.amount == null) continue;
    const cur = r.currency || 'UNKNOWN';
    totals[cur] = (totals[cur] || 0) + r.amount;
  }
  return totals;
}

// A pair's stored rate is either a single flat number, or (D4, per-month
// rates) an object keyed by "YYYY-MM" -> number, one entry per calendar
// month present in the export. Resolves against the ROW'S OWN transaction
// month, so a statement spanning a month boundary can use a different rate
// per month instead of one flat rate applied everywhere.
function resolveRate(rateEntry, dateISO) {
  if (rateEntry == null) return null;
  if (typeof rateEntry === 'number') return rateEntry;
  if (typeof rateEntry === 'object') return rateEntry[String(dateISO || '').slice(0, 7)] ?? null;
  return null;
}

/**
 * Mode B: convert rows to a target currency using saved pair rates.
 * @param {object[]} rows
 * @param {string} target
 * @param {Record<string, number|Record<string,number>>} rates - map "FROM_TO" -> a flat rate, or a per-month {"YYYY-MM": rate} map
 * @param {Record<string, number|Record<string,number>>} [savedRates] - previously saved rates, for deviation checking
 */
export function convertToTarget(rows, target, rates, savedRates = {}) {
  const missingPairs = new Set();
  const deviationWarnings = [];
  const converted = rows.map((row) => {
    if (row.amount == null) return { ...row, converted_amount: null, converted_currency: target, fx_rate: null };
    if (row.currency === target) return { ...row, converted_amount: row.amount, converted_currency: target, fx_rate: 1 };
    const pairKey = `${row.currency}_${target}`;
    const rate = resolveRate(rates[pairKey], row.date);
    if (rate == null) { missingPairs.add(pairKey); return { ...row, converted_amount: null, converted_currency: target, fx_rate: null }; }
    const saved = resolveRate(savedRates[pairKey], row.date);
    if (typeof saved === 'number' && saved !== 0) {
      const deviation = Math.abs(rate - saved) / saved;
      if (deviation > 0.2) deviationWarnings.push({ pair: pairKey, rate, savedRate: saved, deviation });
    }
    // A pair rate is a plain currency-unit rate (1 SGD = 0.74 USD), not a
    // minor-unit one: JPY's minor unit is a whole yen (0 decimals) while
    // USD's is a cent (2 decimals), so converting minor units directly would
    // be off by a factor of 100 whenever the two currencies' decimal places
    // differ (item 2, zero-decimal currencies end to end).
    const scale = Math.pow(10, decimalsFor(target) - decimalsFor(row.currency));
    return { ...row, converted_amount: Math.round(row.amount * rate * scale), converted_currency: target, fx_rate: rate };
  });
  return { rows: converted, missingPairs: [...missingPairs], deviationWarnings, blocked: missingPairs.size > 0 };
}

/** Render both-direction display text for a pair rate, e.g. "1 SGD = 0.74 USD (1 USD = 1.35 SGD)". */
export function formatBothDirections(from, to, rate) {
  const inverse = rate !== 0 ? 1 / rate : 0;
  return `1 ${from} = ${rate} ${to} (1 ${to} = ${round4(inverse)} ${from})`;
}

function round4(n) { return Math.round(n * 10000) / 10000; }
