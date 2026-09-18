# Option 4: The Grid

Direction: Swiss / International Typographic Style. Strict 12-column grid, flush-left ragged-right, one grotesk, black on white, a single signal red reserved for warnings and the two real primary actions (Download CSV, Copy for Sheets). No rounded corners, no shadows, no icons beyond thin geometric arrows. Reads like a Braun instrument manual.

## Palette
- `--ink #000000` — text, rules, primary buttons
- `--paper #ffffff` — background
- `--signal #D9231D` — warnings, blocked states, Delete everything, the two export CTAs
- `--muted #6b6b6b` — secondary labels, captions
- `--hair #d8d8d8` — table row dividers, gridline ghosts (header rows and outer table edges stay full-strength `--ink`)

## Type
- System grotesk stack: `-apple-system, "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif`
- Screen titles 40px/700, uppercase, tight tracking, paired with a 40px number in signal red ("01 IMPORT")
- Section labels 11px uppercase, 0.06-0.08em tracking
- Table body 13px with `font-variant-numeric: tabular-nums` throughout, so every amount column lines up on the decimal
- Monospace (`ui-monospace`) only inside the fake rendered statement, to sell "this is a real document," never in the app chrome

## Three key layout decisions
1. **The extracted table is the hero everywhere, not just on Review.** Import's file list, Map's column list, Export's per-account rows, and Settings' profile list are all the same `table.hero` component: strong 2px header rule, hairline row rule, zebra-free. No card shadows or rounded tiles competing with it.
2. **Literal visible gutters.** `.grid` and its `.gridlines` ghost layer share the identical `repeat(12,1fr)` + 24px gap definition, so the column structure is drawn as real 1px verticals behind the content rather than implied by whitespace.
3. **Selection and failure are shown by inversion and colour, never by chrome.** A selected row on Review goes full black-on-white (matches the left/right pairing without adding a highlight colour); a failing balance check or missing rate is signal red text with a plain arrow pointing at the first offending row, no modal, no icon set.

Logo slot uses `../logos/logo-4.png` at 32px in the header and 96px in the About panel, with explicit width/height and alt text so a missing file does not shift layout.
