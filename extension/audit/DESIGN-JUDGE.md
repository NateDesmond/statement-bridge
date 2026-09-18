# DESIGN-JUDGE: REBUILD-HOME verification pass (2026-09-18, items 7/8/9 rebuild)

Scored 1-5 on "would a non-technical person feel calm here", against
`dev/shots/verify-*.png` and `dev/shots/sheet-*.png` (full-page, 1440 and
1280), taken by `dev/verify-rebuild-home.mjs` walking the real unpacked
extension in bundled headless Chromium.

## Home, empty state (verify-01/02)
**5/5.** Unchanged from the prior pass - one dashed drop box, one centred
pill button, one line of plain copy, a quiet "How does this work?" link.

## Home, processing (verify-03/04)
**4/5.** Unchanged from the prior pass. Rows show name + status + progress
bar only, no options. Same small dock as before: the OCR row's caption
stacks a couple of lines once a file finishes, still not a decision anyone
has to make.

## Home, ready to copy (verify-05/06)
**5/5.** Unchanged from the prior pass - one card, one centred primary
action, sticky-header/sticky-column table, one quiet "Adjust what's
exported" link.

## Home, "Adjust what's exported" sheet closed / open / layout chosen / customised (sheet-closed, sheet-open, sheet-layout-chosen, sheet-customised; verify-07/08/09/10)
**5/5.** The two items that dragged this screen down last time are both
done:
- **Columns (item 7)** is now six plain-language radio cards (Simple, With
  account, With balance, Budget app, Accounting, Everything), each with a
  one-line description and a tiny column strip, arranged in a wrapping
  grid - picking one updates the live preview table above instantly.
  "Customise" sits collapsed underneath and, opened, shows one row of
  toggle pills for exactly the columns this session actually has data for
  (post_date never appears on a CSV that never carried it; Northwind's
  extra_type "Type" column does, only once that file is in the session) -
  click to include/exclude, double-click to rename in place, drag to
  reorder. No more dropdown, no more two-list checkbox chore.
- **Accounts (item 8)** is one "Your accounts" table - Account, Statements
  (file names), Rows in range, an Include switch, and Check/Set up
  again/Remove actions - replacing the old Coverage-by-account and Sources
  tables. Nothing about accounts appears anywhere else in the sheet.
- **Date range / currency (item 9)** read as two compact single-line
  controls: one chip row (six presets plus "Custom", which reveals two date
  inputs only when picked) and one currency row (two plain choices, the
  convert option carrying its own inline target-currency box, with the rate
  table appearing only once Convert is chosen).
A careful, then a casual, look both land calm: one decision at a time, every
control legible without hunting, no second preview, no duplicated account
information. This is the screen the prior pass explicitly could not pass -
it now does, at both 1440 and 1280 (screens reflow with no horizontal
scroll on the page itself; only the "Preview of what will be copied" table
and the "Your accounts"/rate tables scroll in their own boxes as designed).

## Home, new-statement card (verify-13/14)
**5/5.** Unchanged from the prior pass - one quiet bordered card sitting
above the result card, never blocking it.

## Wizard, confirm screen A (verify-15/16)
**4/5.** Unchanged, out of this pass's scope - the pre-existing
`generic_unknown_bank.csv` Description-blank rendering quirk is still there,
still someone else's screen to fix.

## Gear dropdown (verify-17/18)
**5/5.** Unchanged - a compact anchored dropdown, five short items, one
divider, closes on outside click/Escape/selection.

## Settings (verify-19/20)
**5/5.** Simpler than before, not just unchanged: the "Editing column
layout" block (a second dropdown plus a full checkbox-list column editor)
is gone entirely. "Start from" is now a plain seven-option picker - the same
six layouts Home's sheet offers, plus "Last used" as the default - sitting
in one small "Export" panel alongside the date-range and home-currency
prefs. Settings no longer repeats the export layout anywhere; customising
columns happens on Home, against a real preview, which is where a person
actually needs it.

## Report sheet, opened over Settings and over Home (verify-21/22, report-*.png)
**5/5.** Unchanged - a right-side sheet with a dimmed backdrop, opens over
whatever screen was showing, closes cleanly, anonymised-preview text intact.

## Fixed before reporting
One nit caught reading these screenshots: "Include original source columns"
sat inside the same centred `.export-actions` row the Copy/Download buttons
use, which pulled its checkbox+label to the middle of the sheet - out of
place next to every other left-aligned control on the screen (item 4/13's
"one control per row" rule). Moved it to its own plain `.toggle-line` row;
screenshots confirm it now sits flush left like everything else.

Nothing else scored under 4 in the screens this pass touched (items 7, 8,
9). The wizard confirm screen's blank-Description quirk (4/5) remains
explicitly out of scope, as noted in the prior pass.
