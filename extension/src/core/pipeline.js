// The one function every screen calls to turn a file + profile version into
// normalized rows - so OCR confidence flags (ocr/low_confidence_ocr/
// sign_unclear) and every other normalize.js flag compute identically
// wherever a file's rows are built (wizard Test, wizard Save, Home's
// initial/OCR parse), instead of each call site hand-building its own
// normalizeRecords `meta` object and silently drifting.
//
// Item 5 root cause (2026-09-17): the wizard's own Test step built its
// `meta` by hand and dropped `ocr: true` - normalize.js only computes
// low_confidence_ocr/sign_unclear when meta.ocr is set, so an OCR'd file's
// Test step showed a clean run (sign_unclear only, no low_confidence_ocr)
// while Home/Review's own separate, correct call produced a real
// low_confidence_ocr histogram - a real user saw "6 rows need a look" on Home right
// after a Save that looked clean in Test. buildFileRows reads `entry.ocr`
// itself, once, so no caller can forget it again.

import { extractPdfPagesRows } from './pdf.js';
import { applyProfileVersion } from './csv.js';
import { normalizeRecords } from './normalize.js';
import { tagUnmatchedGroupedRows } from './checks.js';

/**
 * @param {{type:'csv'|'xlsx'|'pdf', name:string, ocr?:boolean, grid?:string[][]}} entry
 *   - a Home/wizard file entry. Only `type`, `name`, `ocr` and (for CSV/XLSX)
 *   `grid` are read - buildFileRows never loads or decodes a file itself.
 * @param {{pagesLines?: {y:number, items:object[]}[][]}} source
 *   - for a PDF: `pagesLines`, one groupItemsIntoLines()-shaped lines array
 *   per page, already loaded by the caller (a real pdf.js pass, or cached
 *   OCR pages via core/ocr.js's ocrDocument - the OCR items' own
 *   `confidence` field is what feeds low_confidence_ocr/sign_unclear, so it
 *   must already be attached to these items). Ignored for CSV/XLSX.
 * @param {object} version - a profile version (fields/csv/pdf/dateFormat/numberFormat/signConvention)
 * @param {{bank?, statementType?, currency?, accountLabel?, year?, period?}} metaOverrides
 * @returns {object[]} normalized rows, per core/normalize.js's normalizeRecords
 */
export function buildFileRows(entry, source, version, metaOverrides = {}) {
  const meta = { sourceFile: entry.name, ocr: !!entry.ocr, ...metaOverrides };
  const records = entry.type === 'pdf'
    ? extractPdfPagesRows((source && source.pagesLines) || [], version.pdf)
    : applyProfileVersion(entry.grid, version.csv).records;
  const rows = normalizeRecords(records, version, meta);
  // Item 6: for a grouped-rowModel PDF, tag rows the loose amount-line
  // counter never saw a line for ('unmatched_line'), and stash the reverse
  // case (a counted line with no row) as rows.missedLines - see
  // checks.js's tagUnmatchedGroupedRows doc comment.
  if (entry.type === 'pdf' && version.pdf?.rowModel === 'grouped' && source?.pagesLines) {
    tagUnmatchedGroupedRows(rows, source.pagesLines, version.pdf);
  }
  return rows;
}
