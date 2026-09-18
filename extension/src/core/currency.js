// Currency detection order (CU-1) and multi-currency modes A (keep, per-currency
// totals) / B (convert to a target with saved rates).

import { decimalsFor } from './amount.js';

const SYMBOL_TO_CODE = { 'S$': 'SGD', 'US$': 'USD', 'HK$': 'HKD', 'A$': 'AUD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };

/**
 * Detect a row's currency per CU-1 order: column value -> header hint ->
 * row code/symbol -> profile default. A bare "$" is never guessed.
 * @param {{columnValue?:string, headerHint?:string, rowText?:string, profileDefault?:string}} sources
 */
export function detectCurrency(sources = {}) {
  if (sources.columnValue) {
    const v = sources.columnValue.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(v)) return { currency: v, source: 'column' };
  }
  if (sources.headerHint) {
    const v = sources.headerHint.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(v)) return { currency: v, source: 'header' };
  }
  if (sources.rowText) {
    const bySymbolLengthDesc = Object.entries(SYMBOL_TO_CODE).sort((a, b) => b[0].length - a[0].length);
    for (const [sym, code] of bySymbolLengthDesc) {
      if (sources.rowText.includes(sym)) return { currency: code, source: 'symbol' };
    }
    const codeMatch = sources.rowText.match(/\b([A-Z]{3})\b/);
    if (codeMatch) return { currency: codeMatch[1], source: 'symbol' };
  }
  if (sources.profileDefault) return { currency: sources.profileDefault, source: 'profileDefault' };
  return { currency: null, source: null };
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
