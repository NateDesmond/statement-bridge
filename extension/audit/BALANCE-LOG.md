# Balance-is-a-silent-cross-check rule (2026-09-19)

Product rule: a balance is not a goal, it's a silent cross-check used only
when a statement carries one. This log records every user-visible mention of
"balance" found across the codebase, the decision for each, and what
changed.

## 1. Grep of every user-visible "balance" mention

### extension/src/ui/preset-editor.js
- `NUMERIC_PREVIEW_FIELDS` includes `'balance'` (display formatting only) - **kept**, harmless (grouping only applies if the column is shown at all).
- `PLACEHOLDER_ROWS` (Settings' no-session sample) carry a `balance` field - **kept**, these are Settings' own static sample rows, never a live file; the shared `visibleColumns` rule still applies to them like any other rows.
- `STANDARD_FIELDS` lists `{ field: 'balance', name: 'Balance' }` as a mappable/customisable field - **kept**, Balance stays a valid column choice, just never forced.

### extension/src/core/export.js
- `DEFAULT_PRESET` / `DEFAULT_PRESET_MODE_B` include a `balance` column - **kept as-is**; new `visibleColumns()` helper drops it from every actual export/preview when no row in the export carries a balance, so listing it in the preset is harmless.
- `LAYOUT_PRESETS`: "Simple", "With account", "Budget app" already have **no** `balance` field (verified by reading the array) - **no change needed**, the rule was already true for these three. "With balance", "Accounting" and "Everything" list it, as intended (Accounting wasn't named in the brief; left as-is since it's the "money in/out as debit/credit" layout that reads naturally with a running balance next to it).

### extension/src/ui/review.js (Review screen)
- Extracted-transactions table's Balance column (`visibleColumns()` inside review.js) was already conditioned on "at least one row has a balance" - **no change needed**.
- Summary bar's balance-check line (`Passes` / `Fails` / `No balance column`, always rendered) - **changed**: now renders nothing when there's no balance data or when it reconciles; renders one calm neutral line "Balances stop adding up at row N" (linked, selects the row) only on a real mismatch.
- Count-check line (`N rows read, N ... found`, always rendered) - **changed**: now silent when it matches, one line (unchanged wording) when it doesn't, per item 4's "same rule."

### extension/src/ui/wizard.js (Basics/Map fields/Test/Save)
- `TRANSFORM_FIELDS` / mapping plumbing (`byField.balance`, `fields.balance`) - **kept**, this is what makes Balance a *mappable target*; nothing here suggests or requires it.
- `mappedPreviewColumns()` (Map-fields live preview) only shows Balance if the user actually mapped a source column to it - **no change needed**, already matches item 5.
- Test step summary's balance line (`No balance column...` / `Balance reconciles` / `Balance does not reconcile`, always rendered) - **changed**: same silent/calm-line rule as Review.
- Test step count-check line - **changed**: silent when it matches, one line when it doesn't.
- Test step table's Balance column - was already conditioned on `nonSkippedRows.some(r => r.balance != null)` - **no change needed**.

### extension/src/ui/rowedit.js
- `addMissingRow`'s default row shape carries `balance: null` - **kept**, plain object shape, not UI copy.

### extension/src/ui/home.js (Home / result card)
- No pre-existing balance line or column anywhere on Home - **added**: a quiet reassurance line under the headline ("Every transaction on the page is accounted for[, and the balances add up].") shown once every check that could run has passed; mentions balances only when a balance existed and reconciled.

### site/mock-sheets.html
- A static mockup of a pasted-into-Sheets table with header `... Debit, Credit, Balance` - **kept**, this is one illustrative marketing screenshot of a possible Sheets result (the "Accounting"/"With balance" shape), not app copy asserting balance is a goal.

### store/STORE_LISTING.md, onboarding/onboarding.html, site/index.html, site/support.html, site/privacy.html, site/accessibility.html
- No mentions of "balance" found.

## 2. Default layouts

Verified in `extension/src/core/export.js`'s `LAYOUT_PRESETS`: "Simple", "With account" and "Budget app" already have no `balance` field - nothing to remove. "With balance" and "Everything" keep it.

Added `visibleColumns(columns, rows)` (export.js) - the one place that decides whether the `balance` column actually appears: enabled columns, minus `balance` when none of the exported rows carry one. Used by:
- `buildDelimited` (so `buildCsv`/`buildTsv`, i.e. Download and Copy, both silently drop it)
- `preset-editor.js`'s live preview renderer (Home's result table and the Settings/Change-drawer preview), so the on-screen preview and Copy can never disagree

Mode B's default preset goes through the same `visibleColumns()` call - no separate rule needed.

## 3. Review / wizard Test / confirm screens

Both Review's file summary and the wizard's Test-step summary: the balance line is gone entirely when there's no balance column or when it reconciles; a real mismatch gets one neutral line, "Balances stop adding up at row N", N a button that scrolls to and highlights that row. No "confirm screen" (the confirm-first Screens A/B/C) ever showed balance content - verified by grep, nothing to change there.

## 4. Count check

Same treatment as balance: silent on match, one line (same wording as before) on a real gap, in both Review and the wizard Test step.

## 5. Wizard mapping

Already correct on inspection: Balance is listed in `TRANSFORM_FIELDS`/`STANDARD_FIELDS` as an ordinary mappable target, never in any required-field or step-validity list, and the Map-fields live preview only shows it once the user has actually mapped a source column to it.

## 6. Reassurance line

Added to Home's result card, under the headline, quiet tier (`.pdf-anchor-hint`): "Every transaction on the page is accounted for." when every check that could run passed (no pending quick-look rows, no grouped-PDF count mismatch, and the balance check isn't a fail); appends ", and the balances add up." only when a balance existed for the loaded rows and reconciled.

## 7. Tests

- `test/export.test.js`'s D2 test updated: Mode B's Balance column now correctly drops from `buildTsv` output when no row carries a balance (the test's own fixture rows never had one - the old assertion was actually asserting the pre-rule behavior).
- `node --test test/*.test.js`: 586 passed, 0 failed.
- `dev/e2e-review.mjs`: updated two assertions that expected visible "N rows read..." / "No balance column" text on a clean/no-balance fixture to instead assert those lines are silent (the new, correct behavior); full run green (one unrelated pre-existing flake on a "3-page PDF" OCR-page-distribution check, confirmed by rerunning it alone twice).
- `dev/e2e-presets.mjs`, `dev/e2e-stale-profile.mjs`: run unchanged, all green.
- `dev/e2e-extension.mjs`: all 12 named scenarios (map2-5, confirmyes/update/rows/ocr, firsttimerpdf/de, setup, range) run individually, all green. Running several back-to-back in one process hit a pre-existing OCR-worker resource-contention flake (`#wizard-next` briefly not visible) reproducible on `main` too (unrelated to this change - no balance/export code touched by those scenarios); each scenario is clean run alone, which is how this suite is meant to be run per its own file comment ("a long run can be split into several sub-400s invocations").
- New `dev/e2e-balance-rule-check.mjs`: drives the real unpacked extension (bundled Chromium) through `lattice_card_tabbed.csv` (no balance column) and `anchor_checking.csv` (balance column, reconciles) end to end - Home ready, Review, and the wizard Test step for both - screenshotting each and asserting the column/line rules above. All green; screenshots read and confirmed visually correct (see `dev/shots/balance-*.png`).

## Verification screenshots (read, confirmed correct)

- `dev/shots/balance-home-no-balance.png` / `balance-home-with-balance.png`
- `dev/shots/balance-review-no-balance.png` / `balance-review-with-balance.png`
- `dev/shots/balance-wizardtest-no-balance.png` / `balance-wizardtest-with-balance.png`
