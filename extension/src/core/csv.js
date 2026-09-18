// Papa Parse wrapper: raw text -> grid -> profile-shaped records.

async function getPapa() {
  if (globalThis.Papa) return globalThis.Papa;
  if (typeof process !== 'undefined') {
    // Node test environment: vendor file is a UMD/CJS build with no ESM
    // exports, so load it via createRequire instead of a static import.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    return require('../../vendor/papaparse.min.js');
  }
  throw new Error('Papa Parse failed to load (globalThis.Papa is not set)');
}

/** Papa Parse's `delimiter` option wants a real character (or '' to
 * auto-detect); profile versions store the sentinel 'auto' instead, which
 * Papa would otherwise treat as a literal (and never find) delimiter. */
export function papaDelimiter(delimiter) {
  return delimiter && delimiter !== 'auto' ? delimiter : '';
}

/**
 * Strip leading/trailing tabs and spaces from every line, and drop lines
 * that are empty once trimmed (a padded export - e.g. Standard Chartered's
 * three-leading-tab rows and tab-only separator lines between them - must
 * never leave stray leading cells or phantom blank rows in the parsed
 * grid). Interior whitespace within a line is untouched.
 *
 * Corpus fix (2026-09-18): a real TAB-delimited file's last column can
 * legitimately be blank on a given row (a debit/credit pair leaves whichever
 * side didn't apply empty) - that blank field IS one real trailing tab
 * character, not padding, and stripping it silently dropped the last column
 * from every such row (Papa then saw one fewer field than the header).
 * `delimiter` (when it's a tab) exempts a trailing tab from the strip;
 * comma/semicolon-delimited files (the padding case this was built for -
 * stray tabs around an otherwise comma/semicolon row) are unaffected, and a
 * leading tab is always padding regardless of delimiter (a real field never
 * starts a line with an empty column before the very first one prints
 * nothing there instead of a delimiter).
 */
export function trimLines(text, delimiter) {
  // When tab IS the file's own delimiter, a trailing tab (or several) is
  // real column structure - one or more blank trailing fields (a
  // debit/credit/balance row where the last column(s) don't apply for this
  // row) - not padding, and there is no length-based way to tell it apart
  // from padding after the fact; only a trailing SPACE (never the delimiter
  // itself) is safe to strip in that case. Any other delimiter never
  // collides with what this function strips, so both leading AND trailing
  // tab/space padding are stripped as before.
  const stripTrailing = delimiter === '\t' ? (l) => l.replace(/ +$/, '') : (l) => l.replace(/[ \t]+$/, '');
  return String(text ?? '')
    .split(/\r\n|\r|\n/)
    .map((l) => stripTrailing(l.replace(/^[ \t]+/, '')))
    .filter((l) => l !== '')
    .join('\n');
}

/** Parse text into a raw grid (array of arrays of strings) with Papa Parse. */
export async function parseGrid(text, { delimiter } = {}) {
  const Papa = await getPapa();
  const result = Papa.parse(trimLines(text, delimiter), {
    delimiter: papaDelimiter(delimiter),
    skipEmptyLines: false,
    dynamicTyping: false,
  });
  return result.data;
}

function rowMatchesRule(row, rule) {
  const joined = row.join(' ');
  // Case-insensitive: real statements are inconsistent about "Total" vs "TOTAL"/
  // "total" in footer rows, and a footer that slips past this as a false negative
  // gets parsed as a phantom transaction row downstream.
  if (rule.type === 'startsWith') return (row[0] ?? '').trim().toLowerCase().startsWith(rule.value.toLowerCase());
  if (rule.type === 'regex') return new RegExp(rule.value, 'i').test(joined);
  if (rule.type === 'contains') return joined.toLowerCase().includes(rule.value.toLowerCase());
  return false;
}

/**
 * Apply a profile version's csv config to a raw grid, producing an array of
 * header-keyed records. Applies skipRowsBefore/headerRow to locate headers,
 * footerRules to cut off trailing summary rows, ignoreRowRules to drop
 * interspersed non-data rows (e.g. "Balance brought forward").
 *
 * Track 4 (manual range/sheet selection): `csvConfig.rangeRules`, when
 * present, is the wizard's own explicit grid picks - `headerRow` overrides
 * the plain `headerRow` above, `firstDataRow`/`lastDataRow` bound the data
 * block on both ends (a footer-only file used to have no way to say "stop
 * here" other than footerRules text matching), and `excludedColumns` (0-based
 * indices into the header row) drops a column from every record entirely, so
 * a column the user un-ticked in the grid never even reaches suggestMapping.
 * `sheetName` is xlsx-only plumbing - read by the caller before it builds
 * `grid`, not by this function - kept here only so the whole shape lives in
 * one place.
 */
export function applyProfileVersion(grid, csvConfig = {}) {
  const rr = csvConfig.rangeRules || {};
  const headerRow = rr.headerRow ?? csvConfig.headerRow ?? 0;
  const skipRowsBefore = Math.max(csvConfig.skipRowsBefore ?? 0, headerRow);
  const excludedColumns = new Set(rr.excludedColumns || []);
  const header = (grid[headerRow] || []).map((h, idx) => (excludedColumns.has(idx) ? null : String(h ?? '').trim()));
  const footerRules = csvConfig.footerRules || [];
  const ignoreRowRules = csvConfig.ignoreRowRules || [];

  const dataStart = rr.firstDataRow != null ? Math.max(rr.firstDataRow, headerRow + 1) : Math.max(headerRow + 1, skipRowsBefore);
  const dataEnd = rr.lastDataRow != null ? Math.min(rr.lastDataRow, grid.length - 1) : grid.length - 1;
  const records = [];
  for (let i = dataStart; i <= dataEnd; i++) {
    const row = grid[i] || [];
    if (row.length === 0 || row.every((c) => String(c ?? '').trim() === '')) continue;
    if (footerRules.some((r) => rowMatchesRule(row, r))) break;
    if (ignoreRowRules.some((r) => rowMatchesRule(row, r))) continue;
    const record = {};
    header.forEach((h, idx) => { if (h != null) record[h] = row[idx] ?? ''; });
    records.push(record);
  }
  return { header: header.filter((h) => h != null), records };
}
