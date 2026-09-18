// SheetJS wrapper: xlsx bytes -> the same raw grid shape core/csv.js produces
// (array of arrays of strings), so applyProfileVersion works unchanged for
// xlsx profiles. First sheet by default; Track 4 (manual range/sheet
// selection) adds an explicit `sheetName` override for a multi-sheet
// workbook, plus listXlsxSheets for the wizard's sheet picker.

import { log } from './debuglog.js';

async function getXlsx() {
  if (globalThis.XLSX) return globalThis.XLSX;
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('../../vendor/xlsx.full.min.js');
}

/** @param {ArrayBuffer|Uint8Array} bytes @returns {Promise<string[]>} every sheet name, in workbook order */
export async function listXlsxSheets(bytes) {
  const XLSX = await getXlsx();
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const workbook = XLSX.read(u8, { type: 'array', bookSheets: true });
  return workbook.SheetNames;
}

/**
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {{sheetName?: string}} [opts] - which sheet to read; defaults to the first
 * @returns {Promise<string[][]>} raw grid, cells stringified
 */
export async function parseXlsxGrid(bytes, { sheetName } = {}) {
  const XLSX = await getXlsx();
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const workbook = XLSX.read(u8, { type: 'array' });
  const resolvedName = (sheetName && workbook.SheetNames.includes(sheetName)) ? sheetName : workbook.SheetNames[0];
  const sheet = workbook.Sheets[resolvedName];
  const grid = sheet
    ? XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }).map((row) => row.map((c) => String(c ?? '')))
    : [];
  log('xlsx', 'parsed sheet to grid', { sheetName: resolvedName, sheetCount: workbook.SheetNames.length, rows: grid.length, cols: grid[0]?.length ?? 0 });
  return grid;
}
