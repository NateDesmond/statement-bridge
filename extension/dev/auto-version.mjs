// Builds a profile "version" for an UNMAPPED PDF the same way the wizard's
// own Locate-data auto-detect does, with no fixture-specific tuning: this is
// what a real, never-before-seen statement gets before a human drags
// anything. Shared by the OCR-generalisation regression fixtures (item 7,
// text-version node test AND the OCR/image dev harness) so both measure the
// exact same auto-detection path, not two hand-tuned copies that could
// silently drift apart.
import {
  lineText, extractPdfPagesRows, detectPdfRowModel, detectGroupedSignConvention, inferPdfColumns, withPdfjs,
} from '../src/core/pdf.js';
import { suggestDateFormat } from '../src/core/suggest.js';

// Verbatim from src/ui/wizard.js's PDF_DATE_LINE_RE (item 1's fix: the
// day+month alternative captures an optional trailing year, so
// suggestDateFormat is never fed a truncated "27 Jul" sample when the
// source line actually reads "27 Jul 2026").
const PDF_DATE_LINE_RE = /^\s*\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|^\s*\d{4}-\d{2}-\d{2}\b|^\s*\d{1,2}\s+[A-Za-z]{3,9}\b(?:\s+\d{4}\b)?/;

/** Page 1's width in PDF points (scale-1 viewport width), for inferPdfColumns' band math. */
export async function pdfPageWidthPt(bytes) {
  return withPdfjs(async (pdfjsLib, standardFontDataUrl) => {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), standardFontDataUrl }).promise;
    const page = await doc.getPage(1);
    return page.getViewport({ scale: 1 }).width;
  });
}

function buildColumnsVersion(flatLines, pageWidthPt) {
  const dateLineIdxs = flatLines.map((l, i) => (PDF_DATE_LINE_RE.test(lineText(l)) ? i : -1)).filter((i) => i >= 0);
  const tableStart = dateLineIdxs.length ? { anchor: lineText(flatLines[Math.max(0, dateLineIdxs[0] - 1)]) } : null;
  const tableEnd = dateLineIdxs.length ? { anchor: lineText(flatLines[Math.min(flatLines.length - 1, dateLineIdxs[dateLineIdxs.length - 1] + 1)]) } : null;
  const dateSamples = dateLineIdxs.map((i) => (lineText(flatLines[i]).match(PDF_DATE_LINE_RE) || [])[0]?.trim()).filter(Boolean);
  const dateFormat = suggestDateFormat(dateSamples) || 'DD MMM YYYY';
  // Item 2: real column bands inferred from the data (header words, else
  // clustered numeric x-positions) instead of a fixed 3-band split.
  const columns = inferPdfColumns(flatLines, pageWidthPt);
  const fields = { date: { source: 'date' }, description_raw: { source: ['description_raw'] }, currency: { mode: 'profileDefault' } };
  const debitCredit = {};
  for (const c of columns) {
    if (c.field === 'amount') fields.amount = { source: 'amount' };
    else if (c.field === 'debit' || c.field === 'credit') debitCredit[c.field] = c.field;
    else if (c.field === 'balance') fields.balance = { source: 'balance' };
  }
  if (Object.keys(debitCredit).length) fields.amount = debitCredit;
  else if (!fields.amount) fields.amount = { source: 'amount' };
  return {
    pdf: { rowModel: 'columns', tableStart, tableEnd, columns, rowStartPattern: PDF_DATE_LINE_RE.source, joinWrappedLines: true },
    fields,
    dateFormat, numberFormat: '1,234.56', signConvention: 'signed',
  };
}

function buildGroupedVersion(flatLines) {
  const signDetection = detectGroupedSignConvention(flatLines);
  const signConvention = signDetection.signConvention || 'signed';
  return {
    pdf: { rowModel: 'grouped', grouped: { signConvention, columnBands: signDetection.columnBands || undefined } },
    fields: { date: { source: 'date' }, description_raw: { source: ['description_raw'] }, amount: { source: 'amount' }, currency: { mode: 'column', source: 'currency' } },
    dateFormat: 'DD MMM YYYY', // extractGroupedRows always emits "D MMM YYYY" text, per builtin-profiles.js
    // The outer signConvention is always 'signed': extractGroupedRows already
    // resolved the real sign (pdf.grouped.signConvention above) into the
    // amount string itself - see wizard.js's buildVersionFromWizard for the
    // double-flip bug this avoids (positiveIsOut applied a second time here
    // would flip an already-correct sign back to wrong).
    signConvention: 'signed',
  };
}

/**
 * @param {{y:number, items:object[]}[][]} pagesLines
 * @param {number} pageWidthPt
 * @returns {{detected: object, version: object, records: object[]}}
 */
export function buildAutoVersion(pagesLines, pageWidthPt) {
  const flatLines = pagesLines.flat();
  const detected = detectPdfRowModel(flatLines);
  const version = detected.rowModel === 'grouped' ? buildGroupedVersion(flatLines) : buildColumnsVersion(flatLines, pageWidthPt);
  const records = extractPdfPagesRows(pagesLines, version.pdf);
  return { detected, version, records };
}
