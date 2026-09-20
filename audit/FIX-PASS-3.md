# Pass 3 fix list (designer + first-timer; returner to be appended)

## Must fix
1. Map fields: when the chosen date or number format fails on more than 10% of sampled values, Continue is DISABLED with the reason, and the red mismatch line offers "Use detected: X" and, for dates, a "Try day.month.year" option; a first-timer must never be able to walk into a broken save. (Dotted-date parsing itself is already fixed.)
2. "Looks right" on a row whose date could not be read must not clear the flag: for unparsed-date/unparsed-amount rows the actions are "Fix" (prefilled with the raw text) and "Exclude"; "Looks right" only for confidence/direction/duplicate flags. Rows with no readable date never count as ready.
3. CSV first impression parity: when confirm-first cannot be shown because dates are unreadable, open the ONE relevant step (Map fields with the date format picker focused and the mismatch explained), not the full 5-step wizard on an error banner; header text "We need one detail: which date format does this file use?" with the samples shown.
4. The floating "Report a problem" button overlaps the accounts table's action links at 1280 when the export sheet is long: add bottom padding to the page equal to the button height, and hide the button while a side sheet is open.
5. Almost-ready decision card repeats the flagged row (snippet card + preview table row): the preview table marks the row with a small dot instead of repeating it in full, or the decision card is the only place it appears with "shown above" in the table.
6. Settings and How it works have no page heading: add the same title block Statement types uses.
7. Same row's date shown as 01/06/2026 in the raw preview and 2026-06-01 in the table on Check a statement: caption under the table header "Dates shown as year-month-day; the page shows them as printed".
8. Near-empty screens (Home empty, onboarding, Setup C) leave dead space: vertically centre the card in the viewport when content is shorter than the viewport.
9. OCR status shows page count immediately ("Reading page 1 of 3") since the count is known at start.
10. Confirm screen: dates in the same display format Home uses ("1 Jun 2026") and left-aligned table text; confirm B tiles get a one-line example under each choice.

## Should fix
11. "CSV" pill misaligned beside the name input on Setup C.
12. Snippet box and text block heights mismatched on the quick-look row.
13. Export settings: group into three cards (What to copy / When / Currency) instead of six all-caps labels in a flat flow.
14. Customise chip toggle: verify live and fix if dead.

Rules: verify each in the real extension with full-page screenshots read as a designer; commands under 4 minutes; e2e one at a time; suite green; gate steps individually.

## From the returner pass (append)
15. Since-last-export overlap warning names an account with zero rows in the range: compute the overlap from the live row set (rows whose date <= the stored last-exported date for that account), not from the marker alone (src/core/home-state.js sinceLastExportRange). Test.
16. Confirm-first Screen A flashes the full wizard Basics step before painting for an OCR PDF: hold a neutral "Getting this ready…" state until the confirm decision is made; never show the stepper first.
17. Two date ranges on the ready screen (headline span vs filter window) read as a contradiction: label the headline "Covers 1 Jun to 16 Sep" and the filter "Copying: Last full month (1 to 31 Aug)"; when they differ, the headline shows the copying range.
18. When "Since last export" changes the count (47 → 37), show a quiet line "37 of 47 rows are newer than your last copy" for 4 seconds and keep the chip highlighted.
19. Layout-changed card buttons: ensure a single rendered instance (no hidden duplicate template) with stable data-test attributes.
