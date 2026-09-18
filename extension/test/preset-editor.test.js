import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newPreset, addColumn, removeColumn, moveColumn, renameColumn, setOption, validatePreset,
  toggleColumn, activeColumns, dedupeColumns, collectExtraFields, humanizeExtraField,
  STANDARD_FIELDS, SOURCE_FIELDS,
  presetSettingsEqual, presetPickerLabel, resolveWorkingPreset,
} from '../src/ui/preset-editor.js';
import { DEFAULT_PRESET } from '../src/core/export.js';

test('newPreset starts empty and invalid (no columns)', () => {
  const p = newPreset('My sheet');
  assert.equal(p.name, 'My sheet');
  assert.equal(validatePreset(p).ok, false);
});

test('addColumn appends with a default name from the field dictionary', () => {
  let p = newPreset();
  p = addColumn(p, 'date');
  p = addColumn(p, 'amount', 'Amt');
  assert.deepEqual(p.columns, [
    { field: 'date', name: 'Date', enabled: true },
    { field: 'amount', name: 'Amt', enabled: true },
  ]);
  assert.equal(validatePreset(p).ok, true);
});

test('addColumn is a no-op when the field is already present (no duplicate columns)', () => {
  let p = newPreset();
  p = addColumn(p, 'balance');
  p = addColumn(p, 'balance');
  assert.deepEqual(p.columns.map((c) => c.field), ['balance']);
});

test('dedupeColumns drops later duplicates, keeping the first occurrence', () => {
  const columns = [
    { field: 'date', name: 'Date' },
    { field: 'balance', name: 'Balance' },
    { field: 'account_label', name: 'Account' },
    { field: 'balance', name: 'Balance' },
  ];
  assert.deepEqual(dedupeColumns(columns).map((c) => c.field), ['date', 'balance', 'account_label']);
});

test('DEFAULT_PRESET has no duplicate fields', () => {
  const fields = DEFAULT_PRESET.columns.map((c) => c.field);
  assert.deepEqual(fields, [...new Set(fields)]);
});

test('toggleColumn disables a column without removing it, and activeColumns excludes it', () => {
  let p = newPreset();
  p = addColumn(p, 'date');
  p = addColumn(p, 'amount');
  p = toggleColumn(p, 0);
  assert.equal(p.columns[0].enabled, false);
  assert.equal(p.columns.length, 2, 'column stays in the list, just disabled');
  assert.deepEqual(activeColumns(p).map((c) => c.field), ['amount']);
  const reenabled = toggleColumn(p, 0);
  assert.equal(reenabled.columns[0].enabled, true);
});

test('removeColumn and moveColumn manipulate order without mutating the input preset', () => {
  let p = newPreset();
  p = addColumn(p, 'date');
  p = addColumn(p, 'description_raw');
  p = addColumn(p, 'amount');
  const moved = moveColumn(p, 2, 0);
  assert.deepEqual(moved.columns.map((c) => c.field), ['amount', 'date', 'description_raw']);
  assert.deepEqual(p.columns.map((c) => c.field), ['date', 'description_raw', 'amount'], 'original untouched');

  const removed = removeColumn(p, 1);
  assert.deepEqual(removed.columns.map((c) => c.field), ['date', 'amount']);
});

test('renameColumn and setOption update targeted fields only', () => {
  let p = newPreset();
  p = addColumn(p, 'date');
  p = renameColumn(p, 0, 'Transaction date');
  assert.equal(p.columns[0].name, 'Transaction date');
  p = setOption(p, 'signConvention', 'positiveIsOut');
  assert.equal(p.signConvention, 'positiveIsOut');
  assert.equal(p.dateFormat, 'YYYY-MM-DD');
});

test('validatePreset requires a name and at least one column', () => {
  assert.equal(validatePreset(newPreset('')).ok, false);
  const withCol = addColumn(newPreset('x'), 'date');
  assert.equal(validatePreset(withCol).ok, true);
});

test('humanizeExtraField turns an extra_ key into its human label', () => {
  assert.equal(humanizeExtraField('extra_type'), 'Type');
  assert.equal(humanizeExtraField('extra_statement_code'), 'Statement Code');
});

test('collectExtraFields finds extra_* keys on session rows, deduped', () => {
  const rows = [
    { date: '2026-01-01', extra_type: 'Deposit' },
    { date: '2026-01-02', extra_type: 'Withdrawal' },
  ];
  assert.deepEqual(collectExtraFields(rows), [{ field: 'extra_type', name: 'Type' }]);
});

test('collectExtraFields also finds extra_* fields declared on saved profile versions, not just session rows', () => {
  const profiles = [
    { versions: [{ fields: { extra: [{ name: 'extra_status', source: 'Status' }] } }] },
  ];
  assert.deepEqual(collectExtraFields([], profiles), [{ field: 'extra_status', name: 'Status' }]);
});

test('every possible column - standard, source-trace, mode B - is listed', () => {
  const fields = STANDARD_FIELDS.map((f) => f.field);
  for (const f of ['date', 'post_date', 'amount', 'currency', 'balance', 'account_label', 'bank', 'statement_type', 'reference', 'orig_amount', 'orig_currency', 'fx_rate', 'converted_amount', 'converted_currency']) {
    assert.ok(fields.includes(f), `missing standard field ${f}`);
  }
  assert.deepEqual(SOURCE_FIELDS.map((f) => f.field), ['source_file', 'source_page', 'source_line', 'profile_version']);
});

// Item 5: switching to/from "Two columns" swaps the Amount column for
// Money out/Money in (same position, same enabled state) and back.
test('applyMoneyDirection swaps amount for money_out/money_in when set to twoColumn, and back', async () => {
  const { applyMoneyDirection } = await import('../src/ui/preset-editor.js');
  let p = newPreset();
  p = addColumn(p, 'date');
  p = addColumn(p, 'amount');
  p = addColumn(p, 'currency');
  const two = applyMoneyDirection(p, 'twoColumn');
  assert.deepEqual(two.columns.map((c) => c.field), ['date', 'money_out', 'money_in', 'currency']);
  assert.equal(two.signConvention, 'twoColumn');
  const back = applyMoneyDirection(two, 'signed');
  assert.deepEqual(back.columns.map((c) => c.field), ['date', 'amount', 'currency']);
});

test('applyMoneyDirection is a no-op on column shape when there is no amount/money column to swap', async () => {
  const { applyMoneyDirection } = await import('../src/ui/preset-editor.js');
  let p = newPreset();
  p = addColumn(p, 'date');
  const two = applyMoneyDirection(p, 'twoColumn');
  assert.deepEqual(two.columns.map((c) => c.field), ['date']);
});

// Item 3: coverage across a session's files.
test('fieldCoverage: All when every file group has the field', async () => {
  const { fieldCoverage } = await import('../src/ui/preset-editor.js');
  const groups = [
    { label: 'Meridian Bank savings, CSV', rows: [{ date: '2026-09-01' }] },
    { label: 'UOB card, PDF', rows: [{ date: '2026-09-02' }] },
  ];
  assert.deepEqual(fieldCoverage('date', groups), { kind: 'all', labels: [] });
});

test('fieldCoverage: lists just the files that have it when only some do', async () => {
  const { fieldCoverage } = await import('../src/ui/preset-editor.js');
  const groups = [
    { label: 'DBS savings, PDF', rows: [{ extra_type: 'Deposit' }] },
    { label: 'UOB card, PDF', rows: [{ extra_type: '' }] },
  ];
  assert.deepEqual(fieldCoverage('extra_type', groups), { kind: 'some', labels: ['DBS savings, PDF'] });
});

test('fieldCoverage: None in this session when no file provides it, and when there are no rows at all', async () => {
  const { fieldCoverage } = await import('../src/ui/preset-editor.js');
  const groups = [{ label: 'Meridian Bank savings, CSV', rows: [{ date: '2026-09-01' }] }];
  assert.equal(fieldCoverage('extra_status', groups).kind, 'none');
  assert.equal(fieldCoverage('extra_status', []).kind, 'none');
});

// Item 6: the "Last used" working-set model - editing the drawer live never
// needs a "Save as preset" first, and the picker's label always reflects
// whether the working set still matches a saved preset.
test('presetSettingsEqual: true for identical column/format shape, ignoring the name field', async () => {
  let a = newPreset('A');
  a = addColumn(a, 'date');
  a = addColumn(a, 'amount');
  let b = newPreset('B'); // different name
  b = addColumn(b, 'date');
  b = addColumn(b, 'amount');
  assert.equal(presetSettingsEqual(a, b), true);
});

test('presetSettingsEqual: false when column order, enabled state, a rename, or an option differs', async () => {
  let base = newPreset();
  base = addColumn(base, 'date');
  base = addColumn(base, 'amount');

  let reordered = newPreset();
  reordered = addColumn(reordered, 'amount');
  reordered = addColumn(reordered, 'date');
  assert.equal(presetSettingsEqual(base, reordered), false);

  const renamed = renameColumn(base, 1, 'Value');
  assert.equal(presetSettingsEqual(base, renamed), false);

  const toggledOff = toggleColumn(base, 1);
  assert.equal(presetSettingsEqual(base, toggledOff), false);

  const otherFormat = setOption(base, 'dateFormat', 'DD/MM/YYYY');
  assert.equal(presetSettingsEqual(base, otherFormat), false);
});

test('presetPickerLabel: the matching saved preset name, or "Last used" once edited away from every one', async () => {
  let saved = newPreset('My layout');
  saved = addColumn(saved, 'date');
  const presets = [saved];

  assert.equal(presetPickerLabel(saved, presets), 'My layout');

  const edited = addColumn(saved, 'amount');
  assert.equal(presetPickerLabel(edited, presets), 'Last used');
});

test('resolveWorkingPreset: a persisted working set wins over the "Start from" preference', async () => {
  let working = newPreset('irrelevant name');
  working = addColumn(working, 'balance');
  const presets = [newPreset('Default'), newPreset('Other')];
  assert.equal(resolveWorkingPreset(working, presets, 1), working);
});

test('resolveWorkingPreset: migration - nothing persisted yet starts from the "Start from" preference, or presets[0]', async () => {
  const presets = [newPreset('Default'), newPreset('Other')];
  assert.equal(resolveWorkingPreset(null, presets, 1), presets[1]);
  assert.equal(resolveWorkingPreset(undefined, presets, null), presets[0]);
  assert.equal(resolveWorkingPreset(undefined, presets, 99), presets[0]); // out-of-range index falls back
});
