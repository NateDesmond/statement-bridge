// Export preset model (pure, tested) plus a reusable DOM editing component:
// every possible column listed up front as toggle rows (enabled ones on top,
// reorderable; disabled ones below, greyed), date format / sign convention /
// header row pickers, and a live 2-sample-row preview. Used by the Settings
// screen and the Home "Change" drawer.

import { fieldValue, formatDateOut, DATE_FORMATS, LAYOUT_PRESETS } from '../core/export.js';
import { groupPlainNumber } from '../core/amount.js';

// Fields whose export value is a plain number and reads better grouped
// on-screen (item E2/E3) - never applied to the export string itself
// (fieldValue's return value stays untouched; this only reformats what the
// preview table shows).
const NUMERIC_PREVIEW_FIELDS = new Set(['amount', 'money_out', 'money_in', 'orig_amount', 'converted_amount', 'balance', 'fx_rate']);

// Fix item 7: colour money columns the way the mockup does - money in green,
// money out red - in the live preview (Home's result table included, via
// tableOnly). 'money_out'/'money_in' already carry their direction in which
// column they're in (formatMoneyOut/In leave the other blank); the combined
// fields still hold a real signed row value to read the direction from.
const MONEY_DIRECTION_FIELDS = new Set(['amount', 'orig_amount', 'converted_amount']);
function directionValue(row, field) {
  if (field === 'converted_amount') return row.converted_amount;
  if (field === 'orig_amount') return row.orig_amount;
  return row.amount;
}
function directionClass(row, field) {
  if (field === 'money_out') return 'amount-out';
  if (field === 'money_in') return 'amount-in';
  if (!MONEY_DIRECTION_FIELDS.has(field)) return '';
  const v = directionValue(row, field);
  return v == null ? '' : v < 0 ? 'amount-out' : 'amount-in';
}

// Item 1: the preview box is exactly 5 data rows tall (plus its sticky
// header) and shows at most this many rows total - a session with hundreds
// of rows still previews instantly and scrolls smoothly.
const PREVIEW_VISIBLE_ROWS = 5;
const PREVIEW_ROW_LIMIT = 200;
// Item 2: debounce the (potentially 200-row) preview rebuild, not the rest of
// the editor - a column rename's every keystroke shouldn't rebuild the table.
const PREVIEW_DEBOUNCE_MS = 100;
// container -> latest render token, so a stale debounced write (from a
// render that's since been superseded) never clobbers a newer one.
const previewRenderTokens = new WeakMap();

// Item 4: Settings has no live session to preview against - with no rows at
// all left over from a previous one either, two clearly-fake rows still let
// the column list/date-format pickers show SOMETHING.
const PLACEHOLDER_ROWS = [
  { date: '2026-09-01', post_date: '2026-09-01', description_raw: 'Sample transaction', amount: -1250, currency: 'SGD', balance: 100000, account_label: 'Sample account ****1234', bank: 'Sample Bank', statement_type: 'Statement', reference: 'REF001' },
  { date: '2026-09-03', post_date: '2026-09-03', description_raw: 'Another sample transaction', amount: 500000, currency: 'SGD', balance: 105000, account_label: 'Sample account ****1234', bank: 'Sample Bank', statement_type: 'Statement', reference: 'REF002' },
];

function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

// Standard fields every row can carry, regardless of source file type or
// currency mode. Mode B's three (fx_rate/converted_amount/converted_currency)
// are listed unconditionally too - a column with nothing to show just
// previews empty, same as any other field on a file that doesn't set it.
export const STANDARD_FIELDS = [
  { field: 'date', name: 'Date' },
  { field: 'post_date', name: 'Posting date' },
  { field: 'description_raw', name: 'Description' },
  { field: 'amount', name: 'Amount' },
  { field: 'money_out', name: 'Money out' },
  { field: 'money_in', name: 'Money in' },
  { field: 'currency', name: 'Currency' },
  { field: 'balance', name: 'Balance' },
  { field: 'account_label', name: 'Account' },
  { field: 'bank', name: 'Bank' },
  { field: 'statement_type', name: 'Statement type' },
  { field: 'reference', name: 'Reference' },
  { field: 'orig_amount', name: 'Original amount' },
  { field: 'orig_currency', name: 'Original currency' },
  { field: 'fx_rate', name: 'FX rate' },
  { field: 'converted_amount', name: 'Converted amount' },
  { field: 'converted_currency', name: 'Target currency' },
  { field: 'flags', name: 'Flags' },
];

// Source-trace columns: where a row actually came from.
export const SOURCE_FIELDS = [
  { field: 'source_file', name: 'File' },
  { field: 'source_page', name: 'Page' },
  { field: 'source_line', name: 'Line' },
  { field: 'profile_version', name: 'Setup version' },
];

/** Back-compat flat list (addColumn's default-name lookup, older callers). */
export const AVAILABLE_FIELDS = [...STANDARD_FIELDS, ...SOURCE_FIELDS];

/** "extra_statement_code" -> "Statement Code". */
export function humanizeExtraField(field) {
  const base = field.startsWith('extra_') ? field.slice(6) : field;
  return base.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Every extra_* column seen either in this session's rows or in any saved
 * profile version's `fields.extra`, deduped by field name, labeled by its
 * human name (e.g. extra_type -> "Type").
 */
export function collectExtraFields(sampleRows = [], profiles = []) {
  const fields = new Map();
  for (const row of sampleRows) {
    for (const key of Object.keys(row)) {
      if (key.startsWith('extra_') && !fields.has(key)) fields.set(key, humanizeExtraField(key));
    }
  }
  for (const profile of profiles) {
    for (const version of profile.versions || []) {
      for (const e of version.fields?.extra || []) {
        if (!fields.has(e.name)) fields.set(e.name, humanizeExtraField(e.name));
      }
    }
  }
  return [...fields.entries()].map(([field, name]) => ({ field, name }));
}

// --- Pure model -----------------------------------------------------------

export function newPreset(name = 'New column layout') {
  return { name, columns: [], dateFormat: 'YYYY-MM-DD', signConvention: 'signed', headerRow: true };
}

export function addColumn(preset, field, name) {
  if (preset.columns.some((c) => c.field === field)) return preset; // already present, no-op
  const meta = AVAILABLE_FIELDS.find((f) => f.field === field);
  const columns = [...preset.columns, { field, name: name || meta?.name || field, enabled: true }];
  return { ...preset, columns };
}

/** Drop later duplicates of a field, keeping the first occurrence's position. */
export function dedupeColumns(columns) {
  const seen = new Set();
  return columns.filter((c) => {
    if (seen.has(c.field)) return false;
    seen.add(c.field);
    return true;
  });
}

export function removeColumn(preset, index) {
  const columns = preset.columns.filter((_, i) => i !== index);
  return { ...preset, columns };
}

export function moveColumn(preset, fromIndex, toIndex) {
  const columns = [...preset.columns];
  if (fromIndex < 0 || fromIndex >= columns.length || toIndex < 0 || toIndex >= columns.length) return preset;
  const [moved] = columns.splice(fromIndex, 1);
  columns.splice(toIndex, 0, moved);
  return { ...preset, columns };
}

export function renameColumn(preset, index, name) {
  const columns = preset.columns.map((c, i) => (i === index ? { ...c, name } : c));
  return { ...preset, columns };
}

/** Toggle a column on/off without losing its position or name (unlike removeColumn). */
export function toggleColumn(preset, index) {
  const columns = preset.columns.map((c, i) => (i === index ? { ...c, enabled: c.enabled === false } : c));
  return { ...preset, columns };
}

/** Columns actually written on export: enabled defaults to true for columns predating the flag. */
export function activeColumns(preset) {
  return preset.columns.filter((c) => c.enabled !== false);
}

export function setOption(preset, key, value) {
  return { ...preset, [key]: value };
}

// --- Item 7 (REBUILD-HOME): layout radio cards --------------------------
// Six built-in layouts (export.js's LAYOUT_PRESETS) replace the old dropdown
// of saved presets; picking one resets `columns` to that layout's default
// shape (any prior customisation is deliberately dropped - a fresh base to
// customise from again). `layout` is stamped onto the preset so the right
// card stays highlighted even after the columns are edited.

/** Apply a layout by key: fresh columns (all enabled), same date/money/header options. */
export function applyLayoutPreset(preset, layoutKey) {
  const layout = LAYOUT_PRESETS.find((l) => l.key === layoutKey);
  if (!layout) return preset;
  return { ...preset, columns: layout.columns.map((c) => ({ ...c, enabled: true })) };
}

/** Which layout card should read as selected: whichever layout's field list the preset's own columns still exactly match, in order - never the (possibly stale) `.layout` stamp alone, since any later customisation (toggle/rename/reorder) can move a preset's columns away from the layout it started as without clearing that stamp. Null once customisation has moved it away from every layout's own field set - no card reads as active then, which is correct: it really is "Last used" now, not "Simple" or any other named shape. */
export function matchLayoutKey(preset) {
  const fields = (preset?.columns || []).map((c) => c.field).join(',');
  return LAYOUT_PRESETS.find((l) => l.columns.map((c) => c.field).join(',') === fields)?.key || null;
}

/**
 * Item 5: "Two columns: Money out and Money in" needs two actual export
 * columns instead of one Amount column - switching the money-direction
 * option swaps a preset's 'amount' column for 'money_out'+'money_in' (same
 * position, same enabled state), or swaps back to a single 'amount' column
 * when leaving twoColumn mode. A no-op when the preset has neither column
 * shape yet (nothing to swap).
 * @param {object} preset
 * @param {string} signConvention - the new value being set
 */
export function applyMoneyDirection(preset, signConvention) {
  const next = setOption(preset, 'signConvention', signConvention);
  const amountIdx = next.columns.findIndex((c) => c.field === 'amount');
  const outIdx = next.columns.findIndex((c) => c.field === 'money_out');
  if (signConvention === 'twoColumn' && amountIdx !== -1) {
    const { enabled, name } = next.columns[amountIdx];
    void name; // the split columns get their own default names, not Amount's
    const columns = [...next.columns];
    columns.splice(amountIdx, 1,
      { field: 'money_out', name: 'Money out', enabled },
      { field: 'money_in', name: 'Money in', enabled });
    return { ...next, columns };
  }
  if (signConvention !== 'twoColumn' && outIdx !== -1) {
    const { enabled } = next.columns[outIdx];
    const columns = next.columns.filter((c) => c.field !== 'money_out' && c.field !== 'money_in');
    columns.splice(outIdx, 0, { field: 'amount', name: 'Amount', enabled });
    return { ...next, columns };
  }
  return next;
}

/**
 * Item 3: a preset column's coverage across this session's files - "All"
 * when every file's rows carry a value for the field, the list of file/
 * profile labels that do when only some do, or 'none' when nothing in the
 * session provides it at all.
 * @param {string} field
 * @param {{label:string, rows:object[]}[]} fileGroups - one entry per file in
 *   the session (home.js groups by matched profile); a caller with no
 *   per-file breakdown (Settings, which only ever sees a flat row list) can
 *   pass a single synthetic group - the result then degrades to all-or-none,
 *   never a partial list, which is the correct answer with that little info.
 * @returns {{kind: 'all'|'some'|'none', labels: string[]}}
 */
export function fieldCoverage(field, fileGroups) {
  const groupsWithRows = (fileGroups || []).filter((g) => g.rows?.length);
  if (!groupsWithRows.length) return { kind: 'none', labels: [] };
  const has = (rows) => rows.some((r) => !r.excluded && !r.skipped && fieldValue(r, field, { dateFormat: 'YYYY-MM-DD', signConvention: 'signed' }) !== '');
  const withField = groupsWithRows.filter((g) => has(g.rows));
  if (withField.length === groupsWithRows.length) return { kind: 'all', labels: [] };
  if (!withField.length) return { kind: 'none', labels: [] };
  return { kind: 'some', labels: withField.map((g) => g.label) };
}

const DATE_FORMAT_LABELS = {
  sheetsSerial: 'Google Sheets serial number',
  isoWithTime: 'ISO with time if available',
};
function dateFormatLabel(format) { return DATE_FORMAT_LABELS[format] || format; }

/** @returns {{ok: boolean, reason?: string}} */
export function validatePreset(preset) {
  if (!preset.name || !preset.name.trim()) return { ok: false, reason: 'Column layout needs a name' };
  if (!activeColumns(preset).length) return { ok: false, reason: 'Needs at least one enabled column' };
  return { ok: true };
}

// --- Working-set model (item 6) -------------------------------------------
// Editing the drawer's column layout should never require "Save as
// preset" first - whatever is live IS what exports, and it persists as-is
// across sessions ("Last used"). Saved presets are just named shortcuts back
// into that same working set.

/** True when two presets would produce the same export shape: same columns
 * (field/name/enabled) in the same order, same date format, sign convention
 * and header-row choice. A preset's own `name` is never compared - the
 * working set has no name of its own. */
export function presetSettingsEqual(a, b) {
  if (!a || !b) return false;
  if (a.dateFormat !== b.dateFormat) return false;
  if (a.signConvention !== b.signConvention) return false;
  if ((a.headerRow !== false) !== (b.headerRow !== false)) return false;
  if (a.columns.length !== b.columns.length) return false;
  return a.columns.every((c, i) => {
    const d = b.columns[i];
    return !!d && c.field === d.field && c.name === d.name && (c.enabled !== false) === (d.enabled !== false);
  });
}

/** What the preset picker should show for the current working set: the name
 * of the saved preset it exactly matches, or 'Last used' once it has drifted
 * from every saved preset (edited live, never saved as anything). */
export function presetPickerLabel(workingPreset, presets) {
  const match = (presets || []).find((p) => presetSettingsEqual(workingPreset, p));
  return match ? match.name : 'Last used';
}

/**
 * The working set to open a session with. Migration: with nothing persisted
 * yet (first run, or storage cleared), starts from the "Start from"
 * preference's preset - `presets[0]` with neither a stored working set nor a
 * valid preference index.
 */
export function resolveWorkingPreset(storedWorking, presets, startFromIdx) {
  if (storedWorking && storedWorking.columns) return storedWorking;
  const idx = startFromIdx != null && presets[startFromIdx] ? startFromIdx : 0;
  return presets[idx] || presets[0];
}

// --- DOM component ----------------------------------------------------

/**
 * Render the preset editor into `container`. Controlled component: never
 * mutates `preset`, calls `onChange(nextPreset)` on every edit and expects
 * to be re-rendered with the updated preset (same pattern as review.js).
 * Every possible column is shown up front: enabled columns on top (in their
 * export order, reorderable, renameable), disabled ones below (greyed, a
 * single toggle turns each on). There is no separate "add column" control -
 * every column, including every extra_* one this session or a saved profile
 * has ever produced, already exists in the list.
 * @param {{container: HTMLElement, preset: object, sampleRows?: object[], profiles?: object[], fileGroups?: {label:string, rows:object[]}[], previewRows?: object[], previewPreset?: object, onChange: (next:object) => void}} opts
 * `sampleRows` still drives column discovery/coverage (item 3) - the actual
 * on-screen preview table now prefers `previewRows`: the FULL set of rows
 * Copy for Sheets would produce right now, already filtered/date-ranged/
 * currency-converted and in export order (item 1), rendered 5 at a time in a
 * scrolling box. `previewPreset` is the columns/date-format/money-direction
 * that preview reads (defaults to `preset`) - only home.js's Mode B default-
 * preset widening ever needs it to differ from the editable `preset`. With no
 * `previewRows` (Settings, no live session), the preview falls back to a
 * small static "Sample" from `sampleRows` (or two placeholders).
 */
// Two instances of this component can exist in the DOM at once (Settings'
// own editor, plus Home's "Change" drawer copy of it), so the date
// format/sign convention/header row selects need an id unique per container
// instance, not a fixed string, or their <label for> would bind to whichever
// instance happens to be first in the DOM.
let instanceCounter = 0;

/**
 * @param {boolean} [tableOnly] - Simple B's Home result table: just the live
 * preview (caption + scrolling table + row-count footer), none of the
 * column-editing controls. Used read-only against `previewRows`/
 * `previewPreset` - `onChange` is never called in this mode, so callers may
 * omit it. Added for the Home redesign rather than a second, parallel table
 * renderer - the export preview is already exactly "every active column,
 * formatted the way export.js would write it, 5 rows visible and scrolling".
 */
export function renderPresetEditor({ container, preset, sampleRows = [], profiles = [], fileGroups, previewRows, previewPreset, onChange, tableOnly = false, showPreview = true }) {
  // The container is fully re-rendered on every edit (a controlled
  // component, like review.js) - remember whether Customise was left open so
  // toggling a pill or reordering columns doesn't collapse it back closed
  // out from under the person doing it.
  const wasCustomiseOpen = container.querySelector('.columns-customise')?.open ?? false;
  container.innerHTML = '';
  if (!container.dataset.presetEditorId) container.dataset.presetEditorId = `pe${instanceCounter++}`;
  const uid = container.dataset.presetEditorId;

  // Item 3: with no per-file breakdown supplied (Settings has no file
  // boundaries to group by - see fieldCoverage's doc comment), fall back to
  // one synthetic group over all the sample rows it does have.
  const groups = fileGroups || (sampleRows.length ? [{ label: 'This session', rows: sampleRows }] : []);

  const extraFields = collectExtraFields(sampleRows, profiles);
  const allFields = [...STANDARD_FIELDS, ...SOURCE_FIELDS, ...extraFields];
  const byPresetIndex = new Map(preset.columns.map((c, i) => [c.field, i]));

  // tableOnly (Simple B's Home result table): skip every column-editing
  // control below (the layout cards, Customise, the date/money-direction
  // pickers, the header-row toggle) - straight to the live preview table at
  // the end of this function.
  if (tableOnly) {
    renderPreviewOnly({ container, previewRows, previewPreset: previewPreset || preset, sampleRows, tableOnly: true });
    return;
  }

  // Item 7: six layout radio cards replace the old saved-preset dropdown.
  // Picking one resets `columns` to that layout's own shape (see
  // applyLayoutPreset) - Customise below is what re-personalises it.
  const activeLayoutKey = matchLayoutKey(preset);
  const cardGrid = document.createElement('div');
  cardGrid.className = 'layout-cards';
  cardGrid.setAttribute('role', 'radiogroup');
  cardGrid.setAttribute('aria-label', 'Column layout');
  for (const layout of LAYOUT_PRESETS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `layout-card${layout.key === activeLayoutKey ? ' active' : ''}`;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(layout.key === activeLayoutKey));
    card.innerHTML = `
      <span class="layout-card-name">${escapeHtml(layout.name)}</span>
      <span class="layout-card-desc">${escapeHtml(layout.description)}</span>
      <span class="layout-card-strip">${escapeHtml(layout.columns.map((c) => c.name).join(', '))}</span>`;
    card.onclick = () => onChange(applyLayoutPreset(preset, layout.key));
    cardGrid.appendChild(card);
  }
  container.appendChild(cardGrid);

  // Item 7: "Customise" is collapsed by default and lists ONLY columns that
  // actually have data this session (or, with no live session, whatever
  // fieldCoverage's sample-row fallback finds) - never a field with nothing
  // to show. One row of toggle pills: click toggles the column on/off,
  // double-click renames it in place, drag reorders it - replaces both the
  // old reorderable enabled list and the disabled checklist with one control.
  const availableFields = allFields.filter((f) => fieldCoverage(f.field, groups).kind !== 'none');
  // Columns already on the preset keep their place even if (edge case) their
  // field lost its only source of data since being enabled - a customisation
  // never silently disappears out from under the person who made it.
  const pillFields = [...preset.columns, ...availableFields.filter((f) => !byPresetIndex.has(f.field))];

  const details = document.createElement('details');
  details.className = 'columns-customise';
  details.open = wasCustomiseOpen;
  const summary = document.createElement('summary');
  summary.textContent = 'Customise';
  details.appendChild(summary);

  const pillRow = document.createElement('div');
  pillRow.className = 'column-pill-row';
  let dragFromField = null;
  pillFields.forEach((f) => {
    const idx = byPresetIndex.get(f.field);
    const enabled = idx != null && preset.columns[idx].enabled !== false;
    const name = idx != null ? preset.columns[idx].name : f.name;

    const pill = document.createElement('span');
    pill.className = `column-pill${enabled ? ' enabled' : ''}`;
    pill.draggable = true;
    pill.tabIndex = 0;
    pill.setAttribute('role', 'button');
    pill.setAttribute('aria-pressed', String(enabled));
    pill.title = 'Click to include or exclude; double-click to rename; drag to reorder';

    const label = document.createElement('span');
    label.className = 'column-pill-label';
    label.textContent = name;
    pill.appendChild(label);

    const toggle = () => onChange(idx != null ? toggleColumn(preset, idx) : addColumn(preset, f.field, f.name));
    pill.addEventListener('click', (e) => { if (e.target !== label || !label.isContentEditable) toggle(); });
    pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      label.contentEditable = 'true';
      label.focus();
      document.execCommand('selectAll', false, undefined);
      const commit = () => {
        label.contentEditable = 'false';
        const value = label.textContent.trim();
        if (value && idx != null) onChange(renameColumn(preset, idx, value));
        else label.textContent = name;
      };
      label.addEventListener('blur', commit, { once: true });
      label.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); label.blur(); } }, { once: true });
    });

    pill.addEventListener('dragstart', (e) => { dragFromField = f.field; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.field); });
    pill.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    pill.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromField = dragFromField ?? e.dataTransfer.getData('text/plain');
      const fromIdx = byPresetIndex.get(fromField);
      const toIdx = byPresetIndex.get(f.field);
      if (fromIdx == null || toIdx == null || fromIdx === toIdx) return;
      onChange(moveColumn(preset, fromIdx, toIdx));
    });

    pillRow.appendChild(pill);
  });
  if (!pillFields.length) {
    const empty = document.createElement('p');
    empty.className = 'pdf-anchor-hint';
    empty.textContent = 'No columns with data yet.';
    pillRow.appendChild(empty);
  }
  details.appendChild(pillRow);
  container.appendChild(details);

  // Item 4: a live example next to the date format picker, computed from the
  // first real sample value on hand - "15 Sep 2026 → 2026-09-15" - not an
  // arbitrary made-up date.
  const exampleSourceDate = sampleRows.find((r) => r.date)?.date || '2026-09-15';
  const dateExampleFor = (format) => `${exampleSourceDate} → ${formatDateOut(exampleSourceDate, format)}`;

  const pickerRow = document.createElement('div');
  pickerRow.className = 'picker-row';
  pickerRow.style.marginTop = '16px';
  pickerRow.innerHTML = `
    <div class="picker-group"><label class="pg-label" for="${uid}-dateformat">Export date format</label>
      <select id="${uid}-dateformat" data-opt="dateFormat">
        ${DATE_FORMATS.map((f) => `<option value="${f}">${escapeHtml(dateFormatLabel(f))}</option>`).join('')}
      </select>
      <span class="pg-example" id="${uid}-dateformat-example"></span></div>
    <div class="picker-group"><label class="pg-label" for="${uid}-signconvention">Money direction in export</label>
      <select id="${uid}-signconvention" data-opt="signConvention">
        <option value="signed">Money out negative, money in positive (default)</option>
        <option value="positiveIsOut">Money out positive, money in negative</option>
        <option value="twoColumn">Two columns: Money out and Money in</option>
      </select></div>
  `;
  pickerRow.querySelector('[data-opt="dateFormat"]').value = preset.dateFormat;
  pickerRow.querySelector(`#${uid}-dateformat-example`).textContent = dateExampleFor(preset.dateFormat);
  pickerRow.querySelector('[data-opt="signConvention"]').value = preset.signConvention;
  pickerRow.querySelector('[data-opt="dateFormat"]').addEventListener('change', (e) => {
    onChange(setOption(preset, 'dateFormat', e.target.value));
  });
  pickerRow.querySelector('[data-opt="signConvention"]').addEventListener('change', (e) => {
    onChange(applyMoneyDirection(preset, e.target.value));
  });
  container.appendChild(pickerRow);

  // Item 3: "Include header row" gets its own line under the date/money-
  // direction pickers, not sharing a flex row with the normalisation note
  // (which used to leave it sitting oddly to the note's right).
  const headerRowLine = document.createElement('div');
  headerRowLine.className = 'toggle-line';
  headerRowLine.style.marginTop = '12px';
  const headerCheckbox = document.createElement('input');
  headerCheckbox.type = 'checkbox';
  headerCheckbox.id = `${uid}-headerrow`;
  headerCheckbox.checked = preset.headerRow !== false;
  headerCheckbox.onchange = () => onChange(setOption(preset, 'headerRow', headerCheckbox.checked));
  const headerLabel = document.createElement('label');
  headerLabel.setAttribute('for', `${uid}-headerrow`);
  headerLabel.textContent = 'Include header row';
  headerRowLine.append(headerCheckbox, headerLabel);
  container.appendChild(headerRowLine);

  // Item 2 (REBUILD-HOME, 2026-09-18): Home's "Adjust what's exported" sheet
  // passes showPreview:false - the ONE result table above it already shows
  // exactly what a change here produces (renderExportPanel re-renders it live
  // on every onChange), so the drawer's own column editor never draws a
  // second copy of the same preview.
  if (showPreview) renderPreviewOnly({ container, previewRows, previewPreset: previewPreset || preset, sampleRows });

  // Item 3: the normalisation note gets its own line beneath the preview.
  const moneyNote = document.createElement('p');
  moneyNote.className = 'pdf-anchor-hint money-direction-note';
  moneyNote.textContent = 'All statements are normalised before export: money out is always negative internally, for bank and card accounts alike, so mixing accounts is safe.';
  container.appendChild(moneyNote);
}

/**
 * Item 1's live preview table (caption + scrolling table + row-count
 * footer), factored out so tableOnly mode (Simple B's Home result table) and
 * the full editor's own preview share one implementation - see
 * renderPresetEditor's tableOnly doc comment.
 */
function renderPreviewOnly({ container, previewRows, previewPreset, sampleRows = [], tableOnly = false }) {
  // Preview: item 1 - what Copy for Sheets would produce right now, in
  // export order, through the exact per-field value function export.js uses
  // (fieldValue), rendered straight from the row objects - never by
  // re-splitting buildCsv's escaped/quoted text, which breaks the moment a
  // value contains the delimiter (e.g. a description with a comma).
  const live = Array.isArray(previewRows);
  const pPreset = previewPreset;
  const columns = activeColumns(pPreset);
  const allPreviewRows = live ? previewRows : (sampleRows.length ? sampleRows.slice(0, 2) : PLACEHOLDER_ROWS);
  const shownRows = live ? allPreviewRows.slice(0, PREVIEW_ROW_LIMIT) : allPreviewRows;

  const previewCaption = document.createElement('p');
  previewCaption.className = 'pdf-anchor-hint preset-preview-caption';
  previewCaption.textContent = live ? 'Preview of what will be copied' : 'Sample';
  container.appendChild(previewCaption);

  const previewHost = document.createElement('div');
  if (columns.length && allPreviewRows.length) {
    // Item 15: with many columns enabled the table is WIDER than the card -
    // that's fine, it scrolls inside this wrapper (overflow-x auto) instead
    // of stretching #export-panel/the page itself. The table drops its
    // normal width:100% (which would just squeeze every column instead of
    // ever overflowing) via .preset-preview-table below.
    const scrollWrap = document.createElement('div');
    scrollWrap.className = live ? 'preset-preview-scroll preset-preview-scroll-live' : 'preset-preview-scroll';
    // Item 3: a live preview taller than its box scrolls - make the scroll
    // region itself reachable and announced from the keyboard.
    if (live) {
      scrollWrap.tabIndex = 0;
      scrollWrap.setAttribute('role', 'region');
      scrollWrap.setAttribute('aria-label', 'Export preview, scroll for more rows');
      // The box's fixed height (workspace.css) is header + PREVIEW_VISIBLE_ROWS
      // rows - exposed as a custom property so the two never drift apart.
      scrollWrap.style.setProperty('--preview-rows', String(PREVIEW_VISIBLE_ROWS));
    }
    const table = document.createElement('table');
    table.className = 'txn-table preset-preview-table';
    const cellFor = (row, col) => {
      const raw = col.field.startsWith('original.') ? row.original?.[col.field.slice(9)] : fieldValue(row, col.field, pPreset);
      if (!NUMERIC_PREVIEW_FIELDS.has(col.field)) return raw;
      const grouped = groupPlainNumber(String(raw ?? ''));
      // Home's result table only (tableOnly) - the export string (fieldValue/
      // CSV/Sheets) is untouched; this is display-only, a leading "+" makes
      // money-in readable at a glance next to money-out's own "-".
      return tableOnly && grouped && directionClass(row, col.field) === 'amount-in' && !grouped.startsWith('-') && !grouped.startsWith('+')
        ? `+${grouped}` : grouped;
    };
    const cellClass = (col, row) => {
      const classes = [NUMERIC_PREVIEW_FIELDS.has(col.field) ? 'num' : null, directionClass(row, col.field) || null].filter(Boolean);
      return classes.length ? ` class="${classes.join(' ')}"` : '';
    };
    const theadHtml = `<thead><tr>${columns.map((c) => `<th scope="col" data-field="${escapeHtml(c.field)}">${escapeHtml(c.name)}</th>`).join('')}</tr></thead>`;
    const tbodyHtml = (rowsToRender) => `<tbody>${rowsToRender.map((row) => `<tr>${columns.map((c) => `<td data-field="${escapeHtml(c.field)}"${cellClass(c, row)}>${escapeHtml(cellFor(row, c))}</td>`).join('')}</tr>`).join('')}</tbody>`;
    // Item 2: the header (and, for the small static Sample preview, the body
    // too) renders immediately - only a live preview's (up to 200-row) body
    // is debounced, since that's the part whose cost scales with row count.
    table.innerHTML = theadHtml + tbodyHtml(live ? [] : shownRows);
    scrollWrap.appendChild(table);
    previewHost.appendChild(scrollWrap);

    if (live) {
      const token = (previewRenderTokens.get(container) || 0) + 1;
      previewRenderTokens.set(container, token);
      const html = tbodyHtml(shownRows);
      setTimeout(() => {
        if (previewRenderTokens.get(container) !== token) return; // superseded by a later render
        const tbody = table.querySelector('tbody');
        if (tbody) tbody.outerHTML = html;
      }, PREVIEW_DEBOUNCE_MS);
    }
  } else {
    previewHost.innerHTML = '<p class="pdf-anchor-hint">No columns enabled, or no rows, to preview.</p>';
  }
  container.appendChild(previewHost);

  // Item 1: row-count caption under the table - only meaningful for the live
  // preview (the static Sample is always 1-2 rows, already labeled above it).
  if (live && columns.length && allPreviewRows.length) {
    const footCaption = document.createElement('p');
    footCaption.className = 'pdf-anchor-hint preset-preview-footcaption';
    const total = allPreviewRows.length;
    footCaption.textContent = total > PREVIEW_ROW_LIMIT
      ? `Showing the first ${PREVIEW_ROW_LIMIT} of ${total} rows`
      : `All ${total} row${total === 1 ? '' : 's'}`;
    container.appendChild(footCaption);
  }
}
