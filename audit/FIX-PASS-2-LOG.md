# FIX-PASS-2 progress log

Started 2026-09-19.

## Items 1, 2, 14, 16 (nav/footer/back-button dedup)
- workspace.html: removed full-width `#wizard-back-btn` and `#how-back-btn` in-page buttons.
- workspace.html: removed `#wizard-footer-stepname` span from wizard footer (footer now shows only Back / Next).
- nav.js: `NO_SHELL_BACK` no longer includes 'wizard' - the shared header Back control now shows on the wizard screen too, same as every other screen.
- app.js: registered a back handler that routes the header Back button to `wizardReturnScreen` while the wizard screen is active; `how-back-btn` listener removed (How it works now relies solely on the header Back control, resolving the duplicate).
- wizard.js: added `onBack` param to `createWizard`, used by the in-wizard error screen's own "Back to files" button (that one stays in-page since it's an error state, not part of the stepper chrome); `renderFooter()` no longer touches the removed stepname span.
- `node --test test/*.test.js`: 577/577 green after this change.

## Item 3 (internal field ids leaking on Map fields)
- wizard.js `appendMapRow`: removed the `.field-id-cap` span that printed the raw field id (`date`, `description_raw`, `amount`) under each Maps-to dropdown. The dropdown's own human label is the only caption now.
- `node --test`: 577/577 green.

## Item 4 (Decisions contradiction)
- workspace.html: added `id="export-heading"` to the result card's h2, and a new `#export-pending-note` line under the summary.
- home.js `renderExportPanel`: computes `flaggedDecisionRows(state.files).length`; while > 0, heading reads "Almost ready" with subtitle "Resolve N rows below, or copy now and check later.", and Copy button swaps `btn-brass` -> `btn-ghost` (secondary weight) without disabling it. Flips back to "Your transactions are ready." + primary Copy the moment all rows are resolved.
- `node --test`: 577/577 green.

## Item 5 (Restore banner)
- home.js `handleFiles`: clears `restorePending` and hides `#restore-banner` the instant any file is dropped, regardless of whether Restore/Start fresh was ever clicked.
- workspace.html/workspace.css: `#restore-banner` is no longer a `.panel` card - it's a quiet single line (`.restore-quiet-line`) with `.btn-quiet` text links for Restore/Start fresh, visually subordinate to the drop zone below it.
- `node --test`: 577/577 green.

## Item 6 (toast overlap)
- workspace.css `.home-toast`: bottom offset 24px -> 76px (clears the fixed "Report a problem" pill, which sits at bottom:20px and is ~38px tall), box-shadow tightened to an 8px blur, and width capped to `max-width:984px` (same content-width bound as main/.undo-bar) instead of stretching to fit its text unbounded.
- `node --test`: 577/577 green.

## Item 7 (atomic copy readiness) - verified, no change needed
- Checked home.js `renderExportPanel`: `exportReadiness()` is called exactly once per render into a single `readiness` const; `copyBtn.disabled`, `downloadBtn.disabled` and `#export-blocked-note`'s text are all set synchronously from that same object, back to back, with no other code path touching `#copy-tsv-btn.disabled` or `#export-blocked-note` (grepped `src/ui/*.js`). The transient disagreement the returner pass observed was a polling-timing artifact of their own automation, not a second, independently-updated code path - already atomic by construction. `test/home-state.test.js` already covers `exportReadiness()` directly.

## Item 8 (silent file-row relabel after Save)
- Root cause: `wizard.js save()` set `entry.profile` but never re-derived `entry.accountLabel`, so the row kept whatever `maskAccountNumber(text) || file.name` produced during pre-save detection (a bare "****2618", no bank name) instead of `defaultAccountLabel(profile, masked)` ("<Bank> <type> ****2618").
- wizard.js: imported `defaultAccountLabel` from `core/home-state.js`; `save()` now recomputes `entry.accountLabel = defaultAccountLabel(profile, maskedOnly)` right after the profile is created/updated, reusing the already-masked number if that's all `entry.accountLabel` held.
- home.js file-row render: added a quiet `.fr-caption` showing the original file name whenever the display label differs from it, and a one-time 300ms fade (`.fr-name-renamed` / `@keyframes fr-name-fade`) when the label text actually changes between renders (tracked via `entry._prevDisplayName`) - so Save reads as a rename, not a swap.
- `node --test`: 577/577 green.

## Item 9 (auto-name reads like taxonomy)
- wizard.js `suggestedProfileName()`: now returns "<Bank> <type>" (e.g. "Generic savings") with no file-format suffix or comma.
- workspace.html/css: added a small uppercase `.fmt-tag` (PDF/CSV) beside the name input on both the confirm-flow "Name this statement" screen and the full wizard's Save step, wired via a new `fmtLabel()` helper in wizard.js.
- `node --test`: 577/577 green.

## Item 10 (Screen A caps at 5 rows with no cue)
- wizard.js `renderConfirmA`: preview table now renders every row (not `.slice(0,5)`) inside the same scroll-box pattern Home's result table uses (`preset-preview-scroll preset-preview-scroll-live`, 5 rows visible, scrolls for the rest), plus a caption: "Showing 5 of N. Scroll to see all." (or "All N rows." when N <= 5).
- `node --test`: 577/577 green.

## Item 11 (no visible OCR progress on setup path)
- Confirmed the file row already flips to 'processing' and renders synchronously the instant `runOcrOnFile` starts (before the first onProgress tick), so the state was never truly invisible - but the wording didn't match. home.js: initial label "Reading with text recognition..." -> "Reading your scan...", per-page label "Read N of M pages with text recognition" -> "Reading page N of M" (strip already flips to "Read" via the existing `anyProcessing` check, which includes `ocrRunning`).
- `node --test`: 577/577 green.

## Item 12 (dead "already set up" link)
- home.js: added `savedProfileCount` (refreshed via `refreshSavedProfileCount()` at `wire()` startup and after `onMappingSaved()`), and gated both `appendSecondaryLink(..., 'Use a statement type I already set up', ...)` call sites (kind 'new' and kind 'matchFailed') behind `savedProfileCount > 0`.
- Caught a banned-word regression from my own comment ("genuine") via the existing `node --test` banned-word gate - reworded, tests green again.
- `node --test`: 577/577 green.

## Item 13 (last must-fix: raw "(85% match)" confidence number)
- home.js `lowConfidence` attention card: body copy "\"X\" looks like Y (85% match)." -> "This looks like Y, with a small difference. Use it?" - no raw percentage shown to the user (the underlying `card.confidence` is still computed/available for the debug log, just not rendered).
- `node --test`: 577/577 green.

Items 1-13 (all "Must fix") done. Moving to Should-fix items 14-18 next (14 and 16 already landed as part of the item 1/2 nav cleanup above).

## Item 15 (raw JSON shown by default on the Report sheet)
- workspace.html: "What will be sent" now shows a plain-language `<ul id="report-summary-list">` by default; the raw JSON `<pre id="report-preview">` moved inside a `<details id="report-raw-details">` disclosure ("Show the exact report").
- report.js (ui): added `renderSummaryList(r)` building bullets from the already-anonymised `buildReport()` output ("Your message"/"No message written yet", "File: X"/"No file selected", "Debug log included, N entries"/"No debug log included", "Extension version X"); called from `renderPreview()`.
- `node --test`: 577/577 green.

## Item 17 (unlabeled raw CSV line on a decision card)
- home.js `loadDecisionSnippet`: the CSV/text fallback chip now renders a quiet uppercase "From your file:" label above the monospace raw line (`.decision-snippet-label` / `.decision-snippet-line`), instead of a bare unlabeled monospace dump.
- `node --test`: 577/577 green.

## Item 18 (verify Export Customise chip is wired) - verified, no change needed
- Wrote a throwaway Playwright script (bundled Chromium, headless=new) against the real unpacked extension: dropped `meridian_savings.csv`, opened the drawer, opened Customise, clicked the "Balance" pill.
- Result: "Columns: Simple ..." -> "Columns: Customised ..." and the "Simple" layout card deselects, both immediately. The control is correctly wired (`onChange` -> `activePreset = next; renderExportPanel()` -> re-render); the designer pass's "possible dead control" was a hit-target/timing artifact of that manual session, not a real bug. Script deleted after verification (not part of the repo).

## Release gate - run individually per operating rules (never the whole gate.mjs in one command)
- Step 1 `node --test test/*.test.js`: PASS, 577/577 (run repeatedly throughout, after every item above).
- Step 2 banned words/em-dash sweep: already covered by `test/banned_words.test.js` (a superset - walks the whole repo, not just src/workspace.*/README), included in every step-1 run above; it's what caught my own "genuine" typo mid-fix (item 12).
- Step 3 network sweep + manifest CSP/host_permissions: checked directly (`grep -rnE 'fetch\(|XMLHttpRequest|WebSocket|https?://' src/`) - only hit is inside a comment in core/pdf.js (excluded by the real sweep's own comment-skip logic); manifest.json still has `connect-src 'none'` and no `host_permissions`. Untouched by this pass's edits anyway.
- Step 4a `dev/e2e-extension.mjs`: PASS (3 scenarios, clean debug logs).
- Step 4b `dev/e2e-review.mjs`: PASS (all completion/outline-alignment scenarios).
- Step 4c `dev/e2e-presets.mjs`: PASS - also re-confirms item 18 (Customise pill toggling correctly updates preview/summary/"Customised" state end to end).
- Step 4d `dev/e2e-remove-statements.mjs`: PASS.
- Step 4e `dev/e2e-stale-profile.mjs`: PASS.
- Step 5 `dev/e2e-real-files.mjs`: SKIP - `test/private/manifest.json` doesn't exist (same skip condition gate.mjs itself uses).
- Steps 6/7 (OCR recall audit, corpus audit): not run - slow, and this pass touched no OCR/extraction/matching logic (only UI/copy/wiring), so out of scope for what changed; `--fast` mode skips these in gate.mjs too.

All 18 FIX-PASS-2.md items addressed (13 must-fix items 1-13 changed code; should-fix 14 and 16 landed together with items 1-2's nav cleanup; 15 and 17 changed code; 18 verified as already correctly wired, no change needed). Final test count: 577/577 green throughout.

## Item 12 correction (found during final visual verification)
- Bug in my first pass: `loadProfiles(storage)` always includes the app's own seeded built-in bank profiles (Meridian, Northwind, Harbour Card, ...), so `savedProfileCount` was never actually 0, even for a true first-time user - the link would never have hidden. Fixed: `refreshSavedProfileCount()` now filters to `!p.id?.startsWith('builtin-')`, since "I already set up" means a profile the user made, not one the app shipped with.
- Re-verified with a throwaway script (bundled Chromium headless): dropping an unmatched CSV with zero saved profiles hides the link; after saving one real profile via the wizard, dropping a second still-unmatched CSV shows the link. Both PASS. Script deleted after use.
- Full suite re-run after the fix: `node --test` 577/577; `dev/e2e-extension.mjs` 25/25 PASS (0 FAIL - the earlier single TimeoutError was a flaky click during a first attempt, not a real regression: a clean rerun passed end to end); `dev/e2e-review.mjs`, `dev/e2e-presets.mjs`, `dev/e2e-remove-statements.mjs`, `dev/e2e-stale-profile.mjs` all PASS.

All 18 FIX-PASS-2.md items are done and verified: 1-13 (must-fix) and 15/17 changed code; 14/16 landed with the item 1-2 nav cleanup; 18 verified already correctly wired (no change); 12 corrected after catching a built-in-profile edge case in final verification. Gate run individually throughout (never as one `dev/gate.mjs` invocation): unit tests + banned-word/em-dash sweep (superset test), network/manifest sweep (direct grep), and all five real-browser e2e scripts, each PASS. `dev/e2e-real-files.mjs` SKIP (no test/private/manifest.json). OCR recall audit / corpus audit not run - out of scope (no OCR/extraction/matching logic touched this pass).
