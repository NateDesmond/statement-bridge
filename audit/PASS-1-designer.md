# Pass 1 — Picky product designer (persona 3)

Walking the real unpacked extension in bundled headless Chromium via
`extension/dev/designer-*.mjs` stage scripts. Screenshots in
`audit/pass1/designer-*.png` (also `first-timer-*`/`returner-*` from the other
two personas' passes, untouched). Full-page at 1440/1280, once at 1024.

Scoring axes 1-5: Easy / Works / Depth / Made. Anything under 4 is a defect.

## Score table (running)

| Screen | Easy | Works | Depth | Made | Screenshot |
|---|---|---|---|---|---|
| Home — empty | 4 | 5 | 4 | 3 | designer-01-home-empty-1440.png |
| Gear dropdown | 4 | 4 | 4 | 3 | designer-02-gear-dropdown-1440.png |
| Home — processing | 5 | 5 | 4 | 4 | designer-03-home-processing-1440.png |
| Home — ready | 4 | 5 | 4 | 3 | designer-04-home-ready-1440.png |
| Export sheet — closed | 5 | 5 | 4 | 4 | designer-05-sheet-closed-1440.png |
| Export sheet — open | 3 | 4 | 5 | 3 | designer-06-sheet-open-1440.png |
| Export sheet — layout chosen | 4 | 5 | 5 | 4 | designer-07-sheet-layout-chosen-1440.png |
| Export sheet — customised | 3 | 4 | 5 | 3 | designer-08-sheet-customised-1440.png |
| Check a statement (Review) | 4 | 5 | 4 | 4 | designer-09-check-a-statement-1440.png |

(table continues as remaining screens are captured)

## Defects

### Home — empty (designer-01-home-empty-1440.png)
- **Made 3/5 — dead whitespace below the fold.** At 1440x1000 the drop zone
  and its two caption lines end around y=600; the remaining ~400px is bare
  cream background with only a floating "Report a problem" pill bottom-right.
  Reads as an unfinished template rather than a composed screen. Fix: either
  vertically center the whole card block in the viewport, or add a
  lightweight "recent activity / how it works" teaser below the fold so the
  page doesn't visually stop halfway down.
- Progress stepper (Drop/Read/Copy) circles are rendered as solid colored
  circles that read exactly like clickable step buttons (same shape/weight as
  the gear icon), but they're inert progress indicators. Minor icon-reads-as
  affordance issue — consider a flatter/smaller "progress dots" treatment so
  they don't visually compete with real buttons.

### Gear dropdown (designer-02-gear-dropdown-1440.png)
- **Made 3/5 — destructive action not visually distinguished.** "Clear
  statements" sits in the same black-text, same-weight list as
  Settings/How it works/Show welcome tour, separated only by a blank gap (no
  divider rule). A user can't tell at a glance that this one item is
  destructive. Fix: add a hairline divider above it and color it (e.g. a
  muted red) the way most apps flag a destructive menu item.

### Home — ready, two-file state (designer-04-home-ready-1440.png)
- **Works/Made — duplicate row titles.** Two different files
  (`northwind_transaction_history_3p.pdf` and the OCR'd
  `northwind_transaction_history_image.pdf`) both render as the identical
  primary line "Northwind Bank savings ****7890" in the file list, with only
  a small secondary line ("Read with text recognition") distinguishing them.
  In a real multi-month workflow this duplication of the primary label makes
  it hard to tell which row is which file at a glance. Fix: show the source
  filename (or a truncated version) as a fixed secondary line on every row,
  not only on the OCR'd one.

### Export sheet — open (designer-06-sheet-open-1440.png)
- **Easy 3/5 — seven co-equal ALL-CAPS section labels in one flow.** EXPORT
  SETTINGS / DATE RANGE / FILTER USING / YOUR ACCOUNTS / CURRENCY / COLUMNS /
  EXPORT DATE FORMAT + MONEY DIRECTION IN EXPORT all render at the same
  weight with no grouping (no cards, no dividers beyond a hairline above the
  first). Reads as a form generated field-by-field, not a designed hierarchy
  of primary vs advanced settings. Fix: group into 2-3 visually distinct
  blocks (e.g. "What to include" vs "How it's formatted"), or put the rarer
  settings (custom columns, date/direction format) behind the existing
  "Customise" disclosure instead of always-open.
- **Made 3/5 — three different selection widgets for the same concept.**
  Selected date-range/columns pills go solid black; the per-account "Include"
  toggle is a gold switch; the currency mode picker is a black pill with a
  separate blue radio dot inside it. Three accent treatments (black, gold,
  blue) for "this option is chosen" on one screen reads as bolted-together
  components rather than one system. Fix: pick one selected-state treatment
  (the existing gold matches the CTA and is already used for switches) and
  apply it everywhere on this screen.
- **Alignment — orphan card.** The Columns grid wraps 5 cards then drops
  "Everything" alone on its own row, left-aligned with a large empty gap to
  its right. Fix: either let the grid reflow evenly (auto-fit with
  min/max width) or cap the row at a count that divides evenly (e.g. 3+3).
- Live example row ("2026-06-01 → 2026-06-01") sits directly under both the
  "Export date format" and "Money direction" dropdowns with no clear owner —
  ambiguous which control it's demonstrating. Fix: put the format example
  directly under its own dropdown only.

### Export sheet — customised (designer-08-sheet-customised-1440.png)
- **Depth/Works — literal duplicated data.** Turning on the "Money out"
  column pill adds a MONEY OUT column showing the unsigned magnitude
  (45.20) right next to the existing signed AMOUNT column (-45.20) for the
  same row — the same number shown twice, once signed once not, with no
  visual link between them. This is exactly the "duplicated information"
  defect the standard calls out. Fix: when "Money out"/"Money in" split
  columns are enabled, the plain signed Amount column should either be
  removed from the preview or clearly marked as the "source" column, not
  shown at parity with the split columns.

### Check a statement (designer-09-check-a-statement-1440.png)
- **Made — inconsistent amount coloring for the same data.** The header
  summary shows "+5,200.00 SGD money in" / "-253.55 SGD money out" in plain
  black, while the "Extracted transactions" table two panels below colors
  the identical kind of value green (money in) / red (money out). Same
  data, two different color conventions on one screen. Fix: color the
  header totals the same way as the table.
- **Easy — undefined jargon control.** "Quick look (0)" with keyboard-shortcut
  badges (P/N) is shown disabled with no visible explanation of what "quick
  look" means or when it would light up. A first-time user has no way to
  learn this is a flagged-row triage tool without already knowing the
  feature. Fix: a one-line caption ("rows worth a second look") or disable
  state that explains itself, e.g. "No rows need a second look."
