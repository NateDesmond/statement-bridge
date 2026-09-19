# Fix Pass 3 log

Started 2026-09-19. Baseline: node --test test/*.test.js -> 578 pass.

## Item 2 (Must fix) - DONE
"Looks right" on unparsed-date/unparsed-amount rows no longer clears the flag.
- src/ui/rowedit.js: confirmRow now keeps 'unparseable_date'/'missing_amount'
  in the output flags as long as row.date/row.amount is still null - only
  clears them once the underlying value was actually fixed (e.g. via
  resolveEdit's editRow-then-confirmRow). Added hasUnresolvableFlag(row).
- src/ui/review.js, src/ui/wizard.js (Test step resolveCellHtml): "Looks
  right" button hidden when hasUnresolvableFlag(row); Fix/Exclude remain.
  wizard.js Test step already prefilled Fix's date input with date_raw.
- src/ui/home.js decision row: replaced unconditional Looks-right/Fix pair
  with Fix/Exclude when hasUnresolvableFlag(row) (added Exclude action,
  wasn't there before); Fix form's date input now falls back to a text
  input prefilled with date_raw when row.date is null (native type="date"
  can't hold a non-ISO raw string); amount input prefills with the new
  amount_raw field when the amount never parsed.
- src/core/normalize.js: added `amount_raw` to the normalized row (mirrors
  date_raw), null once the amount parsed.
- Tests: test/rowedit.test.js x3 new cases. Suite: 578 -> 584 pass.

## Item 1 (Must fix) - DONE
Map fields: Continue is now disabled, with the reason shown, when the
selected date OR number format fails on more than 10% of sampled values.
- src/ui/wizard.js renderFormatDiagnostic() now returns {failed,total,ok}
  (was previously fire-and-forget DOM only); renderPickerSamples() stores
  both results as state.mapFieldsGate.
- stepValidCtx() exposes dateFormatOk/numberFormatOk/*Count/*Total from
  mapFieldsGate; computeStepValid/computeStepReason (pure, exported,
  unit-tested) step 2 now gate on formatOk in addition to the existing
  field-mapping check, incl. the grouped-PDF branch.
- The red mismatch line already had "Use detected: X"; added a second link,
  for dates only, "Try day.month.year" -> sets the date-format select to
  DD/MM/YYYY (whose separator class already accepts dots, per date.js) -
  distinct from "Use detected" for when nothing was confidently detected.
- Tests: test/wizard.test.js x2 new cases (computeStepValid/computeStepReason
  step-2 format gate). Suite: 578 -> 583 pass (some earlier item-2 tests also
  landed in this count).

## Item 3 (Must fix) - DONE
CSV first-impression parity when confirm-first can't be shown due to a date
FORMAT problem (as opposed to a real header/date-column-not-found case).
- src/ui/wizard.js renderConfirmA(): when dateFill<0.5, now distinguishes
  "no date column found at all" (existing behavior: full wizard, Locate
  data, unchanged) from "a date column WAS mapped with real raw text but
  the chosen format doesn't parse it" (new: rawDateFill = fieldFill(rows,
  r => r.date_raw) >= 0.5) - the latter opens ONLY the date-format picker
  via openConfirmFocus('dates', heading), never the full 5-step wizard.
- openConfirmFocus() takes an optional `heading` param, rendered as an h2
  at the top of #confirm-focus-host; used here with "We need one detail:
  which date format does this file use?" - the picker it moves in already
  carries its own samples + red mismatch line (renderMappingTable/item 1).
- Verified live against test/fixtures/waldkonto_unbekannt.csv (German,
  dotted dates): confirm-a now paints directly ("We found 6 transactions
  from 2026-09-01 to 2026-09-15. Does this look right?", correct ISO dates,
  correct EUR amounts) - dotted-date parsing was already fixed, so this
  fixture no longer exercises the new focus-gate at all; it's defense in
  depth for a real unrecognized date format (kept the check anyway,
  since #2 of FIX-PASS-3.md item 3 is about the code path, not just this
  one fixture). Screenshot read: confirm-a renders exactly right, no
  wizard-steps/stepper visible.

## Gated scenario `firsttimerde` (task requirement) - DONE
dev/e2e-extension.mjs: new scenario runFirstTimerGermanCsvScenario, prefix
firsttimerde, using test/fixtures/waldkonto_unbekannt.csv - drops the file,
follows ONLY primary prompts (Set up -> confirm-a -> Yes -> Save and finish
-> Copy to Google Sheets), with real assertions:
- lands on confirm-first (not the full wizard on an error banner)
- every previewed date is real ISO (2026-09-15 etc, not blank)
- Yes is enabled
- Home shows "Done, 6 transactions"
- no "Could not read dates" banner anywhere in the body text
- Copy to Google Sheets is enabled and produces "Copied 6 rows to the
  clipboard"
Run standalone: `node dev/e2e-extension.mjs firsttimerde` -> 8/8 PASS, clean
debug log. Screenshots: dev/shots/firsttimerde-01-after-setup-click.png,
-02-confirm-c.png, -03-home-after-save.png, -04-after-copy.png (all read;
04 shows the full "Your transactions are ready" state with the correct 6
rows and the copy toast).

## Item 4 (Must fix) - DONE
"Report a problem" FAB overlapping the accounts table's action links at 1280.
- workspace.css: main{} bottom padding 64px -> 84px (fab footprint is
  20px offset + 35px button height = 55px; 84px gives ~29px clearance vs
  the previous ~9px, which was visibly tight/overlapping once the export
  panel made the page tall).
- workspace.css: `#screen-report.open ~ .report-fab{display:none;}` hides
  the fab while its own side sheet (the only side-sheet in the app) is
  open.
- Verified live at 1280x800 (meridian_savings.csv, Change drawer open,
  scrolled to the true bottom of the page): "Check / Set up again / Remove"
  sits at y~91, the fab at y~742 - no overlap. Screenshot read: clean.
  Also confirmed getComputedStyle(#report-fab).display === 'none' once
  the report sheet is opened.

## Item 5 (Must fix) - DONE
"Almost ready" decision card duplicated the flagged row (snippet + full
restatement, then the same row again in the preview table below).
- src/ui/preset-editor.js renderPreviewOnly/renderPresetEditor: new
  `flaggedRowIds` param (a Set of row_id); the preview table's first cell
  on a matching row gets a small dot (reuses the existing `.flag-dot` CSS
  class from review.js) plus a title tooltip, instead of the decision card
  restating the row a second time.
- src/ui/home.js renderResultTable(): passes
  `new Set(flaggedDecisionRows(state.files).map(({row}) => row.row_id))`.
- Verified live with the exact duplicate-transaction CSV fixture the
  designer report used (dbs_savings_dup.csv, GIRO SP SERVICES repeated):
  exactly one .flag-dot rendered, on the second (duplicate) 2026-06-03 row
  in the preview table. Screenshot read: dot renders correctly, decision
  card unchanged/untouched.

## Item 6 (Must fix) - DONE
Settings and How it works had no page heading.
- workspace.html: added `<h1 class="page-title">Settings</h1>` /
  `<h1 class="page-title">How it works</h1>` as the first element of each
  screen, before the existing intro sentence.
- workspace.css: new `.page-title` rule (19px/700/var(--ink)) - same
  weight/size as the wizard's confirm-heading, so both screens now lead
  with a real bold title like Statement types/Home/Check a statement do.
- Verified live (gear menu -> Settings, gear menu -> How it works),
  screenshots read: both screens now open on a clear bold "Settings" /
  "How it works" title above the existing intro text.

## Item 7 (Must fix) - DONE
Same row's date shown as 01/06/2026 (raw source pane) vs 2026-06-01
(extracted table) on Check a statement, with nothing explaining the
difference.
- workspace.html: added `<p id="extracted-date-caption">Dates shown as
  year-month-day; the page shows them as printed.</p>` directly under the
  "Extracted transactions" pane header, above the table.
- Verified live (Home -> Change -> Check on meridian_savings.csv):
  screenshot read, caption renders exactly where specified, source pane
  still shows 01/06/2026 etc, table still shows 2026-06-01 etc.

## Item 8 (Must fix) - DONE
Near-empty screens (Home empty, onboarding, Setup C) left 60-70% dead space
below a top-anchored card.
- workspace.css: `#empty-state{min-height:calc(100vh - 261px);display:flex;
  flex-direction:column;justify-content:center;}` (261 = header 67 +
  progress strip 86 + main's own top/bottom padding 24+84). align-items
  left at flex default (stretch) so the hero/explainer keep their existing
  width; only the vertical position moves.
- workspace.css: root cause for the wizard screens was that
  `#screen-wizard.active{height:100%}` was only ever 100% of `main`'s own
  auto (shrink-to-fit) height, so there was never any spare space for
  `#confirm-c`'s margin:auto to use - `#wizard-confirm` now gets
  `min-height:calc(100vh - 153px)` directly, which cascades the real
  height UP through the auto-height #screen-wizard/main; `#confirm-c` gets
  `margin-top/bottom:auto` (not justify-content:center, which would clip
  the top of anything taller than the box under overflow:auto) so only the
  short Setup C step centres - confirm-a/b/focus keep default flex-start.
- onboarding/onboarding.css: `body.ob-body{display:flex;flex-direction:
  column;justify-content:center;min-height:100vh;}` (all 3 onboarding
  screens share one page/body, so one rule covers all of them).
- Verified live: Home empty, Setup C ("Name this statement"), onboarding
  step 1 ("Your bank statements...") and step 3 ("Get your first
  statement") - all screenshots read, card now sits roughly centred in the
  viewport instead of pinned to the top with dead space below.

## Item 9 (Must fix) - DONE
OCR status showed a bare "Reading your scan..." until the first page
finished, even though the page count is known as soon as the PDF opens.
- src/core/ocr.js: ocrDocument() takes a new optional `onStart(total)`,
  fired right after pdf.js opens the document (`doc.numPages`) and before
  any page actually starts recognising - between opening the file and the
  first page finishing, which could be seconds on a slow machine/large scan.
- src/ui/home.js runOcrOnFile(): passes onStart to set
  entry.progressLabel = "Reading page 1 of N" and re-render immediately,
  instead of waiting for onProgress's first per-page tick.
- Verified live (summit_grouped_2line_image.pdf, 3 pages): observed label
  sequence "Reading statement..." -> "Reading your scan..." (brief, while
  the file itself is still being read off disk) -> "Reading page 1 of 3"
  (as soon as pdf.js opens the doc, well before page 1's OCR completes) ->
  the existing per-page updates. The zero-information window is now just
  the time to open the PDF header, not the time for a full page's OCR.
- No unit test added: ocrDocument's document-level flow (pdf.js + worker
  pool + tesseract) has no existing unit-test harness in test/*.test.js
  (only lower-level OCR pieces are unit tested) - verified live instead,
  per the note above.

## Item 10 (Must fix) - DONE
Confirm screen dates/alignment, and confirm B tile examples.
- src/ui/wizard.js: confirm-a-preview's date cell now uses
  formatShortDate(r.date) ("1 Jun 2026", same formatter Home's own
  headline uses) instead of the raw ISO string; falls back to date_raw
  when a row's date never parsed.
- workspace.css: root cause of the "centered-looking" table was
  `.confirm-step{text-align:center}` (for the heading/totals/buttons)
  cascading into the preview table's Date/Description cells (only
  Amount had `.num{text-align:right}` overriding it) - added
  `#confirm-a-preview table{text-align:left;}` to match every other
  table in the app.
- workspace.html/workspace.css: confirm-B's four tiles each get a
  `.cct-example` one-line example under the label (Dates/Amounts/Rows/
  Something else), quieter/smaller than the label so it stays secondary.
- Verified live via `node dev/e2e-extension.mjs setup` (confirm-first
  screens gallery, clean debug log): screenshots read - confirm-a shows
  "1 Jun 2026" etc, left-aligned Date/Description; confirm-b's four tiles
  each show their example line.

## Item 15 (returner) - DONE
Since-last-export overlap warning could name an account with zero rows in
the computed range.
- src/core/home-state.js sinceLastExportRange(): new optional third param
  `rowsByAccount` (account label -> ISO dates of its currently loaded,
  non-excluded/non-skipped rows). An account only lands in
  `overlapAccounts` when it ALSO has a live row inside [startISO, its own
  marker] - not just because its marker is recent. Omitting the param
  keeps the old marker-only behavior (backward compatible - the existing
  test at test/home-state.test.js:234 is untouched and still passes).
- src/ui/home.js "Since last export" chip handler: builds rowsByAccount
  from accountGroupsForTable() (each account's currently loaded rows'
  dates) and passes it through.
- Tests: test/home-state.test.js x3 new cases (flags correctly, doesn't
  flag a zero-overlap account, backward-compat with no rowsByAccount arg).
  Suite: 583 -> 586 pass.

## Item 1 follow-up: block threshold tuned (regression fix)
Real e2e run (map3, an existing test for the Test step's own flag-
resolution feature) exposed a false positive: a fixture with one
one actually-corrupt OCR date among 5 total transactions (20% of a tiny
sample) tripped the same >10% threshold the advisory red line uses,
disabling Map fields' Continue entirely and blocking the ALREADY-shipped,
intentional path where a single bad row is meant to reach Test and be
resolved there ("Looks right"/"Fix"/"Exclude"), not block setup outright.
- src/ui/wizard.js renderFormatDiagnostic(): the advisory warning line
  (visible red text + "Use detected"/"Try day.month.year" links) keeps
  its original >10% threshold, unchanged. The returned `ok` used for the
  HARD Continue-disable gate now uses a stricter >50% (a majority of
  sampled values failing) - unambiguous for a wrong format (the German-
  dates case was 6/6, 100%), but no longer blocks a file with a small
  number of individually-corrupt rows.
- Verified: `node dev/e2e-extension.mjs map3` (previously hung/failed
  with Continue stuck disabled) now passes end to end, including its own
  Looks-right/Fix/resolution-persistence checks; map4, map5, range, and
  the full 586-test suite all stayed green.

## Item 16 (returner) - DONE
Confirm-first Screen A could flash the full wizard's Basics step before
painting, for a PDF whose OCR/anchor detection is still loading.
- workspace.html: new `#wizard-loading` block ("Getting this ready...")
  inside #screen-wizard, alongside the existing wizard-confirm/stepper.
- src/ui/wizard.js open(): shows #wizard-loading and hides every other
  wizard sub-block the instant the screen is made active - before the
  async PDF/OCR loading below even starts - so the default un-hidden
  state (the full stepper on Basics) never gets a chance to paint first.
- setConfirmMode(on) (called by every branch of enterConfirmOrWizard, the
  single decision point at the end of open()) now also hides
  #wizard-loading, whichever real screen it's about to reveal.
- Tests: 586 pass unaffected. Verified live via
  `node dev/e2e-extension.mjs confirmocr` and `firsttimerpdf` (OCR image
  PDFs, the exact case the bug describes) - both clean end to end,
  screenshots show the expected confirm-a directly, no stray Basics frame
  captured.

## Item 17 (returner) - DONE
Two unlabeled date ranges (headline vs "Export settings" drawer line) could
diverge and read as a contradiction.
- src/ui/home.js renderExportPanel(): headline now reads "Covers X to Y"
  (the full data span across every included, non-excluded/non-skipped row,
  ignoring the date filter) when the active filter isn't narrowing anything
  (preset 'all', or the filtered span happens to equal the full span), or
  "Copying X to Y" (the actual span of the currently-filtered rows) when it
  is - i.e. "when they differ, the headline shows the copying range."
- rangeSummaryLabel() (feeds the drawer's "EXPORT SETTINGS" summary line)
  now reads "Copying: <preset name> (<dates>)" instead of a bare date
  range, via new rangePresetLabel() (looks up RANGE_OPTIONS' own display
  names - "Last full month", "Custom", etc).
- Verified live (meridian_savings.csv, Custom range 1-10 Jun with only 3
  of 5 rows actually falling 1-5 Jun): headline read "3 transactions from
  1 statement - Copying 1 Jun 2026 to 5 Jun 2026" (the real span of what's
  being copied) while the drawer read "Copying: Custom (1 Jun 2026 to 10
  Jun 2026)" (the filter's own nominal window) - two clearly different,
  labeled facts, matching the fix spec exactly. Also verified the "All"
  preset (no divergence) reads "Covers 1 Jun 2026 to 20 Jun 2026".
- Tests: full suite 586 pass, unaffected (no existing test asserted the
  old bare headline/summary text).

## Item 18 (returner) - DONE
No acknowledgement that "Since last export" actually changed the row count.
- workspace.html: new `<p id="since-export-note" hidden>` under the
  existing overlap-warning line.
- src/ui/home.js range-chip click handler: captures rowsInRange().length
  BEFORE switching to 'sinceLastExport', compares to the count AFTER: if
  different, shows "N of M rows are newer than your last copy" for 4s
  (setTimeout, cleared/reset on repeat clicks), else keeps the note
  hidden. The chip's own "active" styling already persists across
  re-renders (state.rangePreset drives it), so no separate "keep it
  highlighted" work was needed there.
- Verified live (meridian_savings.csv, a synthetic lastExported marker at
  2026-06-10 so 2 of 5 rows are newer): clicking "Since last export"
  showed "2 of 5 rows are newer than your last copy" immediately, chip
  highlighted, note gone after 4.2s. Screenshot read: note renders exactly
  under the chip row, matches the spec's wording pattern.
- Tests: full suite 586 pass, unaffected.

## Item 19 (returner) - DONE
"Set up again"/layout-changed buttons not reliably reachable by a single
selector during automation.
- Root cause confirmed (not a duplicate-template bug): renderAttentionCards()
  already clears and rebuilds #attention-cards on every render (no stray
  duplicate node) - the real ambiguity is that "Set up again" legitimately
  appears TWICE in the DOM at once when the Change drawer is open: once on
  the layout-changed card (top) and once in the accounts table row for the
  very same file. A text-based selector can't tell them apart.
- src/ui/home.js: mkBtn()/appendSecondaryLink() take an optional 4th
  `dataTest` param (sets data-test only when given - every other caller
  unaffected); the layout-changed card's three actions now get
  data-test="layout-changed-setup-again" / "-use-anyway" /
  "-pick-different".
- Verified live: a real layout-changed file with the Change drawer open at
  the same time - `button/a:has-text("Set up again")` matched 2 elements
  (confirmed the reported ambiguity is real), `[data-test="layout-changed-
  setup-again"]` matched exactly 1, visible. Screenshot read: both the
  card's own button and the table's link are correctly, separately
  rendered - not a duplicate/hidden-template bug.
- Tests: full suite 586 pass, unaffected.

## Item 13 (Should fix) - DONE
Export settings drawer used six flat all-caps labels (Date range, Filter
using, Your accounts, Currency, Columns, Export date format/Money
direction) with only whitespace separating them.
- workspace.html: wrapped the existing sections (same IDs, untouched) into
  three `.panel.drawer-card` cards with a real bold title each: "When"
  (date range + filter), "What to copy" (accounts table + columns), and
  "Currency" (currency mode + rate table).
- workspace.css: new `.drawer-card`/`.drawer-card-title` rules (reuses the
  existing `.panel` bordered-box look); the old
  `.drawer-body > h2.section-title` 24px-rhythm rule got a matching nested
  version (`.drawer-card > h2.section-title`) since the labels now live
  one level deeper.
- No JS changes needed - every element the JS targets by ID
  (#range-chip-row, #accounts-table-body, #home-preset-editor,
  #currency-mode-a/b, #rate-table-wrap, etc.) kept its id, only the
  wrapping DOM around it changed.
- Verified live (Change drawer open, both "Keep each account's currency"
  and "Convert everything to" + rate-per-month modes): three clearly
  bounded cards render correctly, every control still works (currency
  toggle, rate table appears nested inside the Currency card correctly).
- Tests: full suite 586 pass, unaffected.

## Item 11 (Should fix) - VERIFIED ALREADY CORRECT, no change needed
"CSV" pill misaligned beside the name input on Setup C.
- Checked live: .name-input-row{align-items:center} already vertically
  centers .fmt-tag against .confirm-name-input. Measured boxes on Setup C:
  input center y=414.8, tag center y=414.8 - exact match. Screenshot read:
  visually centered, no misalignment observed in the current build (this
  designer-pass3.mjs alignment fix must already be in place from an
  earlier pass, ahead of when the audit screenshot was taken - same
  situation as item 1's "dotted-date parsing already fixed" note).

## Item 12 (Should fix) - VERIFIED ALREADY CORRECT, no change needed
Snippet box and text block heights mismatched on the quick-look row.
- Checked live (dbs_savings_dup.csv, the exact fixture the designer report
  used): .decision-row{align-items:stretch} already makes .decision-snippet
  and .decision-body equal height. Measured: both exactly 53.875px tall on
  the flagged row. No mismatch found in the current build.

## Item 14 (Should fix) - VERIFIED LIVE, not a dead control (script bug)
Export "Customise" column chips: designer report flagged possible dead
control since clicking "Balance" produced no visible change.
- Root cause: dev/designer-pass3.mjs's own probe used
  `button:has-text("Balance")`, but the column pill is a
  `<span role="button" class="column-pill">` (draggable, double-click to
  rename), never a real `<button>` - the selector matched nothing, so
  `if (chip) await chip.click()` silently never fired. Fixed the selector
  to `.column-pill:has-text("Balance")`.
- Verified live with the correct selector: className goes
  "column-pill" -> "column-pill enabled", the live preview table gains a
  BALANCE column, and the drawer's own summary line updates to
  "Columns: Customised" - the control works correctly. Screenshot read:
  chip renders dark/enabled, preview table shows the new column.
- No product code changed - only dev/designer-pass3.mjs's probe selector.

## Item 2 follow-up: regression found and fixed via full e2e sweep
Running dev/e2e-review.mjs (not previously part of my per-item verification)
surfaced a real regression from item 2's confirmRow change: once "Exclude"
became the only way to resolve a hard-flagged row (unparseable_date/
missing_amount), review.js's warning-count/all-done logic never noticed the
row was resolved, because `hasWarningFlag(row)` didn't check `row.excluded`
- so an excluded row's still-present hard flag kept it counted as "needs a
look" forever, and the "all done" completion screen never appeared.
- src/ui/review.js: `hasWarningFlag` now returns false for an excluded row,
  regardless of what flags remain (matches home-state.js's
  warningRowCount/flaggedDecisionRows, which already excluded excluded rows
  - review.js was the one place that hadn't). Root-cause, one place, every
  caller (the warnings chip, the "Quick look" filter, next/prev-warning nav,
  the flag-dot, resolveWarning's own remaining-count, all-done) benefits.
- dev/e2e-review.mjs's resolveAllVisibleWarnings() and
  dev/e2e-review-source-anchors.mjs's inline equivalent: fall back to
  "Exclude" when "Looks right" isn't offered for the selected row (item 2's
  new correct behavior for a hard-flagged row) - both scripts previously
  only tried "Looks right" and silently stopped early.
- Verified: `node dev/e2e-review.mjs` went from 5-6 failures (2 real: the
  all-done/resolve-all checks; the rest were pre-existing OCR/canvas timing
  flakes that varied between runs, see below) to exactly 1 remaining
  failure across 3 consecutive runs - the SAME one every time
  ("zoom-in makes the rendered page wider (942 -> 942)"), confirmed
  unrelated to this pass (pure PDF-canvas zoom rendering, no file this task
  touched is anywhere near it) and pre-existing.
- Also ran (previously untouched by my per-item checks): e2e-presets.mjs,
  e2e-remove-statements.mjs, e2e-stale-profile.mjs - all clean, no
  regressions. e2e-review-source-anchors.mjs's `run3PageFixture` scenario
  fails to even start (`gotoScreen(page, 'review')` times out) because it
  still targets the gear-menu's old "review" tile, removed in an earlier
  pass (REBUILD-HOME 2026-09-18, see home.js's own comment) - pre-existing,
  unrelated to Pass 3, left alone (out of scope; the file's own resolve-
  loop fix above is still correct for whenever that navigation gets
  repaired).
- Full suite re-run after these fixes: 586 pass, 0 fail.
