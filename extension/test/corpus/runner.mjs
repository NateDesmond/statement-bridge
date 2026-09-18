// Runs one generated corpus sample (test/corpus/generate.mjs) through the
// real "confirm-first" path: no saved profile, just detect + suggestMapping
// + the normalize/extraction pipeline - exactly what a brand-new statement
// hits before a user ever maps or saves anything. Returns a recall/extras
// result plus the sample's axes, for test/corpus.test.js and
// dev/corpus-audit.mjs to bucket and print.
import { detectEncoding, decodeText, detectDelimiter } from '../../src/core/detect.js';
import { parseGrid, applyProfileVersion } from '../../src/core/csv.js';
import {
  suggestMapping, suggestHeaderRow, suggestDateFormat, suggestNumberFormat,
  suggestSignConvention, detectCrDrInSamples,
} from '../../src/core/suggest.js';
import { normalizeRecords } from '../../src/core/normalize.js';
import {
  inferPdfColumns, extractRows, extractGroupedRows, detectGroupedSignConvention,
  groupItemsIntoLines,
} from '../../src/core/pdf.js';

/** Turn suggestMapping's flat suggestion list into a normalize.js fieldsCfg - the same shape the wizard builds from a mapping, done independently here (this file owns no UI code, and the wizard is under active edit elsewhere). */
function fieldsFromSuggestions(suggestions) {
  const byField = Object.fromEntries(suggestions.map((s) => [s.field, s]));
  const fields = {};
  if (byField.date) fields.date = { source: byField.date.source };
  if (byField.description_raw) fields.description_raw = { source: [byField.description_raw.source] };
  if (byField.debit || byField.credit) {
    fields.amount = {};
    if (byField.debit) fields.amount.debit = byField.debit.source;
    if (byField.credit) fields.amount.credit = byField.credit.source;
  } else if (byField.amount) {
    fields.amount = { source: byField.amount.source };
  }
  if (byField.balance) fields.balance = { source: byField.balance.source };
  return fields;
}

function matchRows(truth, extractedRows) {
  const remaining = extractedRows
    .filter((r) => !r.skipped)
    .map((r) => ({ date: r.date, minor: r.amount }));
  let matches = 0;
  for (const t of truth) {
    const idx = remaining.findIndex((r) => r.date === t.date && r.minor === t.minor);
    if (idx !== -1) { matches++; remaining.splice(idx, 1); }
  }
  return { matches, misses: truth.length - matches, extras: remaining.length };
}

function runGridSample(sample) {
  const { grid, truth, currency } = sample.gridInfo;
  const headerRowIdx = suggestHeaderRow(grid);
  const idx = headerRowIdx === -1 ? 0 : headerRowIdx;
  const header = (grid[idx] || []).map((h) => String(h ?? '').trim());
  const sampleRows = grid.slice(idx + 1, idx + 6);
  const suggestions = suggestMapping(header, sampleRows);
  const fields = fieldsFromSuggestions(suggestions);

  const dateCol = suggestions.find((s) => s.field === 'date');
  const dateValues = dateCol ? grid.slice(idx + 1).map((r) => r[header.indexOf(dateCol.source)]) : [];
  const dateFormat = suggestDateFormat(dateValues) || 'YYYY-MM-DD';
  const amountCol = suggestions.find((s) => s.field === 'amount' || s.field === 'debit' || s.field === 'credit');
  const amountValues = amountCol ? grid.slice(idx + 1).map((r) => r[header.indexOf(amountCol.source)]) : [];
  const numberFormat = suggestNumberFormat(amountValues);
  let signConvention = suggestSignConvention(suggestions);
  if (signConvention === 'signed' && detectCrDrInSamples(amountValues)) signConvention = 'crdr';

  const version = { fields, dateFormat, numberFormat, signConvention, csv: { headerRow: idx } };
  const { records } = applyProfileVersion(grid, version.csv);
  const rows = normalizeRecords(records, version, { sourceFile: sample.name, currency });
  return matchRows(truth, rows);
}

function runPdfColumnsSample(sample) {
  const lines = groupItemsIntoLines(sample.items);
  const columns = inferPdfColumns(lines, sample.pageWidthPt);
  const pdfConfig = { columns };
  const records = extractRows(lines, pdfConfig);
  const fields = { date: { source: 'date' }, description_raw: { source: ['description_raw'] } };
  const hasDebitCredit = columns.some((c) => c.field === 'debit') && columns.some((c) => c.field === 'credit');
  if (hasDebitCredit) fields.amount = { debit: 'debit', credit: 'credit' };
  else fields.amount = { source: 'amount' };
  if (columns.some((c) => c.field === 'balance')) fields.balance = { source: 'balance' };
  const dateFormat = 'DD/MM/YYYY';
  const numberFormat = suggestNumberFormat(records.map((r) => r.amount || r.debit || r.credit));
  const version = { fields, dateFormat, numberFormat, signConvention: 'signed' };
  const rows = normalizeRecords(records, version, { sourceFile: sample.name, currency: sample.axes.currency });
  return matchRows(sample.truth, rows);
}

function runPdfGroupedSample(sample) {
  const lines = groupItemsIntoLines(sample.items);
  const { signConvention, columnBands } = detectGroupedSignConvention(lines);
  const pdfConfig = { rowModel: 'grouped', grouped: { signConvention: signConvention || 'signed', columnBands } };
  const records = extractGroupedRows(lines, pdfConfig);
  const version = {
    pdf: pdfConfig,
    fields: { date: { source: 'date' }, description_raw: { source: ['description_raw'] }, amount: { source: 'amount' } },
    dateFormat: 'DD MMM YYYY',
    numberFormat: '1,234.56',
    signConvention: 'signed',
  };
  const rows = normalizeRecords(records, version, { sourceFile: sample.name, currency: sample.axes.currency });
  return matchRows(sample.truth, rows);
}

/**
 * Run one generated sample through the confirm-first (no profile) path.
 * Always async: csv/tsv parse through Papa Parse (parseGrid); xlsx/pdf
 * resolve synchronously but share this one entry point.
 * @returns {Promise<{matches:number, misses:number, extras:number, truthCount:number}>}
 */
export async function runSample(sample) {
  let result;
  if (sample.fileType === 'csv' || sample.fileType === 'tsv') {
    const encoding = detectEncoding(sample.bytes);
    const text = decodeText(sample.bytes, encoding);
    const delimiter = detectDelimiter(text);
    const grid = await parseGrid(text, { delimiter });
    result = runGridSample({ name: sample.name, gridInfo: { grid, truth: sample.truth, currency: sample.axes.currency } });
  } else if (sample.fileType === 'xlsx') {
    result = runGridSample({ name: sample.name, gridInfo: { grid: sample.grid, truth: sample.truth, currency: sample.axes.currency } });
  } else if (sample.fileType === 'pdf-columns') {
    result = runPdfColumnsSample(sample);
  } else {
    result = runPdfGroupedSample(sample);
  }
  return { ...result, truthCount: sample.truth.length };
}

/** Bucket a set of {sample, result} pairs by one axis key, aggregating recall/extras. */
export function bucketBy(results, axisKey) {
  const buckets = new Map();
  for (const { sample, result } of results) {
    const key = axisKey === 'fileType' ? sample.fileType : sample.axes[axisKey];
    if (!buckets.has(key)) buckets.set(key, { truth: 0, matches: 0, extras: 0, misses: 0, n: 0 });
    const b = buckets.get(key);
    b.truth += result.truthCount;
    b.matches += result.matches;
    b.extras += result.extras;
    b.misses += result.misses;
    b.n += 1;
  }
  return [...buckets.entries()].map(([key, b]) => ({
    key,
    n: b.n,
    recall: b.truth ? b.matches / b.truth : 1,
    extrasRate: b.truth ? b.extras / b.truth : 0,
    misses: b.misses,
    extras: b.extras,
    truth: b.truth,
  })).sort((a, b) => a.recall - b.recall);
}

export function printBucketTable(title, buckets) {
  console.log(`\n${title}`);
  console.log('key'.padEnd(18), 'n'.padStart(4), 'truth'.padStart(7), 'recall'.padStart(8), 'extras%'.padStart(9));
  for (const b of buckets) {
    console.log(
      String(b.key).padEnd(18),
      String(b.n).padStart(4),
      String(b.truth).padStart(7),
      `${(b.recall * 100).toFixed(1)}%`.padStart(8),
      `${(b.extrasRate * 100).toFixed(2)}%`.padStart(9),
    );
  }
}
