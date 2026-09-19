# Pass 2 fix list (merged from PASS-2-designer, PASS-2-first-timer, PASS-2-returner)

## Must fix
1. Map fields step shows three navigation systems at once (stepper, confirm-focus header, footer) and the label "MAP FIELDS" three times: one stepper, one step title, footer shows only Back / Next.
2. Internal field ids leak on Map fields (date, description_raw, amount captions under the dropdowns): remove the id captions; the human label is enough.
3. Decisions contradiction: a "Needs a quick look" file row/cards above a "Your transactions are ready" panel with live buttons. Rule: while quick-look rows are unresolved the result card headline becomes "Almost ready" with the subtitle "Resolve N rows below, or copy now and check later", Copy stays available but is a secondary button until the rows are resolved; the moment all are resolved it flips to the ready state.
4. "Restore your last statements?" banner: dismisses automatically once any new file is dropped or after Restore/Start fresh; never shown next to fresh data; the Restore card is visually subordinate to the drop zone (quiet card, not equal weight).
5. Success toast overlaps a data row: anchor toasts bottom-centre above the report button, never over the table, with an 8 px shadow and the same width rule as the Undo bar.
6. Copy readiness must be one atomic render: compute readiness once, then set the button state and the note from the same object in the same frame (no transient disagreement).
7. File row relabels silently from the file name to "****2618" after Save on the PDF path: the row label becomes "<Bank> <type> ****2618" (bank from the statement type), with the original file name as the quiet caption, and the change animates (300 ms fade) so it reads as a rename not a swap.
8. Auto-name "Generic savings, CSV" reads like taxonomy: name = "<Bank> savings" (no file type, no comma); file type shown as a small tag beside it where needed.
9. Screen A shows only 5 rows with no cue: add "Showing 5 of 37. Scroll to see all" and make the preview scroll to all rows (5 visible).
10. No visible "Reading your scan…" while OCR runs from the setup path: the row must show "Reading page 2 of 3" and the strip must be on Read.
11. "Use a statement type I already set up" shown when the user has zero saved statement types: hide it unless at least one exists.
12. Confirm-mismatch shows "(85% match)": drop the number; say "This looks like Meridian Bank savings, with a small difference. Use it?".

## Should fix
13. "Report a problem" duplicated on Settings (floating pill + in-page button): keep the pill only.
14. "Back" duplicated on How it works (header link + button): keep the header control only.
15. Report side sheet shows raw JSON by default: plain summary (what happened, file, log included yes/no, size) with "Show the exact report" disclosure.
16. Wizard "Back to files" is a full-width button with primary weight: make it the header Back control like every other screen.
17. Raw CSV line on a CSV decision card is unlabeled: label "From your file:" in the quiet tier.
18. Export sheet Customise chips: verify toggling updates the preview immediately; fix if dead.

## Rules
Verify each item in the real extension with full-page screenshots read as a designer; every command under 4 minutes; run e2e scenarios one at a time; `node --test test/*.test.js` green; then run gate steps individually. No em-dashes, never honest/genuine/truthful, no jargon.
