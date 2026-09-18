// Fix item 6 (2026-09-18): a built-in CSV profile whose fields map a
// statement's only narrative column into the wrong field leaves every row
// with a blank Description - the wizard's Screen A preview showed exactly
// this for meridian_savings.csv. One regression test per built-in CSV profile,
// against the real fixture it ships with, so a future edit to any of these
// field maps can't reintroduce a blank description silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGrid, applyProfileVersion } from '../src/core/csv.js';
import { normalizeRecords } from '../src/core/normalize.js';
import { builtinProfiles } from '../src/core/builtin-profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One fixture per shipped version worth checking - every built-in CSV
// profile version that has a real-world fixture to run against.
const CASES = [
  { profileId: 'builtin-meridian-savings', versionId: 'builtin-meridian-savings-v1', fixture: 'meridian_savings.csv' },
  { profileId: 'builtin-meridian-savings', versionId: 'builtin-meridian-savings-v2', fixture: 'meridian_savings_real_export.csv' },
  { profileId: 'builtin-harbour-card', versionId: 'builtin-harbour-card-v1', fixture: 'harbour_card.csv' },
  { profileId: 'builtin-harbour-card', versionId: 'builtin-harbour-card-v2-crdr', fixture: 'harbour_card_crdr.csv' },
  { profileId: 'builtin-riverside-savings', versionId: 'builtin-riverside-savings-v1', fixture: 'riverside_savings.csv' },
  { profileId: 'builtin-summit-savings', versionId: 'builtin-summit-savings-v1', fixture: 'summit_savings.csv' },
  { profileId: 'builtin-anchor-checking', versionId: 'builtin-anchor-checking-v1', fixture: 'anchor_checking.csv' },
  { profileId: 'builtin-lattice-card', versionId: 'builtin-lattice-card-v1', fixture: 'lattice_card_tabbed.csv' },
];

for (const { profileId, versionId, fixture } of CASES) {
  test(`${profileId} (${versionId}) yields a non-empty description for every real row on its fixture`, async () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf-8');
    const profile = builtinProfiles().find((p) => p.id === profileId);
    assert.ok(profile, `profile ${profileId} exists`);
    const version = profile.versions.find((v) => v.id === versionId);
    assert.ok(version, `version ${versionId} exists on ${profileId}`);

    const grid = await parseGrid(text);
    const { records } = applyProfileVersion(grid, version.csv);
    assert.ok(records.length > 0, 'the fixture yields at least one record');

    const rows = normalizeRecords(records, version, { bank: profile.bank, statementType: profile.statementType, currency: profile.defaultCurrency, sourceFile: fixture });
    const real = rows.filter((r) => !r.skipped);
    assert.ok(real.length > 0, 'at least one real (non-skipped) row');
    for (const r of real) {
      assert.ok(String(r.description_raw ?? '').trim() !== '', `row ${r.row_id} (${r.date}) has a non-empty description_raw`);
    }
  });
}
