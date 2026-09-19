// Pure logic for review-screen row actions: edit a cell (keep original), exclude/restore
// a row, add a manually-created row. Kept side-effect free so the DOM layer (review.js)
// stays thin: it just calls these and re-renders from the returned rows array.

/**
 * Edit one field on a row. The first edit to a given field stashes the pre-edit
 * value in `editedFields` so the UI can show "field edited from X".
 * @param {object} row
 * @param {string} field
 * @param {*} value
 */
export function editCell(row, field, value) {
  const editedFields = { ...(row.editedFields || {}) };
  if (!(field in editedFields)) editedFields[field] = row[field];
  return { ...row, [field]: value, editedFields, edited: true };
}

/**
 * Promote a skipped line (a summary/footer line whose date AND amount both
 * failed to parse, per normalize.js) back into a normal flagged transaction
 * row, the "treat as transaction" action in Review's skipped-lines group.
 */
export function treatAsTransaction(row) {
  const flags = [...(row.flags || [])];
  if (!row.date && !flags.includes('unparseable_date')) flags.push('unparseable_date');
  if (row.amount == null && !flags.includes('missing_amount')) flags.push('missing_amount');
  return { ...row, skipped: false, flags };
}

export function excludeRow(row) {
  return { ...row, excluded: true };
}

export function restoreRow(row) {
  return { ...row, excluded: false };
}

// Flags that describe provenance, not a problem to look at - never cleared
// by confirmRow (see review.js's INFO_ONLY_FLAGS, kept in sync by hand since
// this file has no DOM/UI concept of "warning" to import from there).
const CONFIRM_KEEP_FLAGS = new Set(['ocr', 'manually_added']);

// Pass 3 item 2: a row whose date or amount never actually parsed. "Looks
// right" is a false affordance here - the value is still unusable, not just
// unconfirmed - so confirmRow must never clear these, and the UI (home.js's
// decision row, review.js's action buttons, wizard.js's Test step) must
// never offer "Looks right" while one is set. "Fix" (correct the value) or
// "Exclude" (drop the row) are the only real ways out.
const HARD_FLAGS = new Set(['unparseable_date', 'missing_amount']);
export function hasUnresolvableFlag(row) { return (row.flags || []).some((f) => HARD_FLAGS.has(f)); }

/**
 * "Looks right": a human has checked this row against the source and it's
 * fine as extracted. Clears every warning flag (keeping provenance-only ones
 * like 'ocr', and HARD_FLAGS - a value that never parsed stays flagged no
 * matter what calls confirmRow) and marks the row user-confirmed, so it
 * drops out of the warnings count/Home badge without discarding what it
 * originally flagged.
 * @param {object} row
 */
export function confirmRow(row) {
  const flags = (row.flags || []).filter((f) => {
    if (CONFIRM_KEEP_FLAGS.has(f)) return true;
    // A hard flag only survives confirmRow while the value it complains
    // about is STILL missing - editRow (resolveEdit's own first step, run
    // before this) may already have filled row.date/row.amount, in which
    // case the flag is stale and clears like any other.
    if (f === 'unparseable_date') return row.date == null;
    if (f === 'missing_amount') return row.amount == null;
    return false;
  });
  return { ...row, flags, confirmed: !flags.some((f) => HARD_FLAGS.has(f)) };
}

/**
 * Bulk-confirm every row flagged 'low_confidence_ocr' (the "Confirm all N
 * low-confidence rows" action next to Review's Warnings chip, OCR files only).
 * @param {object[]} rows
 */
export function confirmAllLowConfidence(rows) {
  return rows.map((r) => ((r.flags || []).includes('low_confidence_ocr') ? confirmRow(r) : r));
}

/**
 * Item 1 (OCR alt-amount fix): apply the safety net's suggested amount_alt
 * over row.amount as a normal edit (editCell stashes the original amount so
 * "field edited from X" still reads right) and clears the low_confidence_ocr
 * flag/hint that suggested it - the "Use $X" one-click action next to
 * Fix/Edit, for a row where normalize.js found a likely dropped decimal.
 * @param {object} row
 */
export function applyAmountAlt(row) {
  if (row.amount_alt == null) return row;
  const next = editCell(row, 'amount', row.amount_alt);
  return {
    ...next,
    flags: (next.flags || []).filter((f) => f !== 'low_confidence_ocr'),
    low_confidence_hint: null,
  };
}

/**
 * Apply an inline multi-field edit (date/description/amount) in one shot,
 * reusing editCell's stash-original-on-first-edit behavior per field.
 * @param {object} row
 * @param {Record<string, *>} fields - field -> new value, undefined values skipped
 */
export function editRow(row, fields) {
  let next = row;
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined) next = editCell(next, field, value);
  }
  return next;
}

/**
 * Wrap a resolve action (confirm/exclude/use-alt/edit-and-confirm) with a
 * per-row undo stack: snapshots the row exactly as it was right before the
 * action, pushed onto row._undo, so undoRow can restore it later - flags,
 * edited values, excluded status, everything - even after further edits to
 * OTHER fields. Kept as a real stack (not a single slot) since a row can be
 * resolved, undone, and resolved again within the same session.
 * @param {object} row
 * @param {(row: object) => object} action
 */
export function resolveRow(row, action) {
  const snapshot = { ...row };
  delete snapshot._undo;
  const next = action(row);
  return { ...next, _undo: [...(row._undo || []), snapshot] };
}

/** "Looks right" as a resolve action: confirmRow + undo stack. */
export function resolveConfirm(row) { return resolveRow(row, confirmRow); }
/** "Exclude" as a resolve action: excludeRow + undo stack. */
export function resolveExclude(row) { return resolveRow(row, excludeRow); }
/** "Use <alt>" as a resolve action: applyAmountAlt + undo stack. */
export function resolveUseAlt(row) { return resolveRow(row, applyAmountAlt); }
/**
 * "Edit saved" on a currently-flagged row is treated as a resolution too - a
 * human just corrected the row by hand, which is at least as strong a signal
 * as clicking "Looks right", so it also clears warning flags (confirmRow)
 * after applying the edit.
 */
export function resolveEdit(row, fields) { return resolveRow(row, (r) => confirmRow(editRow(r, fields))); }

/** Undo the most recent resolve action on this row, restoring its exact prior state. No-op if nothing to undo. */
export function undoRow(row) {
  const stack = row._undo || [];
  if (!stack.length) return row;
  const prev = stack[stack.length - 1];
  return { ...prev, _undo: stack.slice(0, -1) };
}

// ponytail: plain array-and-modulo math, not a real circular-buffer type -
// upgrade only if a caller ever needs more than "next/prev index, wrapping".
function mod(n, m) { return ((n % m) + m) % m; }

/**
 * Index of the next item in `list` after `index`, wrapping to 0 past the
 * end. `index` of -1 (nothing selected yet) lands on 0, same as "as if we
 * were just before the start". Used for both the Next-warning button/key and
 * (passing `index - 1` for the just-resolved row's old position) auto-advance
 * after resolving a warning - the row that takes its place is exactly
 * `list[nextUnresolvedAfter(list, resolvedIndex - 1)]` once the resolved row
 * itself has been filtered out of `list`.
 * @param {object[]} list
 * @param {number} index
 * @returns {number} -1 when list is empty
 */
export function nextUnresolvedAfter(list, index) {
  if (!list.length) return -1;
  return mod(index + 1, list.length);
}

/** Index of the previous item in `list` before `index`, wrapping to the end. For the Previous-warning button/key. */
export function prevUnresolvedBefore(list, index) {
  if (!list.length) return -1;
  return mod(index - 1, list.length);
}

/**
 * Insert a manually-added row into a rows array, positioned right after
 * `afterRowId` (or at the end when null/not found).
 * @param {object[]} rows
 * @param {string|null} afterRowId
 * @param {object} fields - partial normalized-row fields (date, description_raw, amount, ...)
 */
export function addMissingRow(rows, afterRowId, fields) {
  const row = {
    row_id: `manual-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    date: null, date_raw: null, post_date: null, description_raw: '', merchant: null, amount: null,
    currency: null, orig_amount: null, orig_currency: null, balance: null,
    account_label: null, bank: null, statement_type: null, reference: null,
    source_file: null, source_page: null, source_line: null, profile_version: null,
    flags: ['manually_added'], excluded: false, edited: false, editedFields: {}, original: {},
    ...fields,
  };
  const idx = afterRowId ? rows.findIndex((r) => r.row_id === afterRowId) : -1;
  const next = [...rows];
  next.splice(idx === -1 ? next.length : idx + 1, 0, row);
  return next;
}
