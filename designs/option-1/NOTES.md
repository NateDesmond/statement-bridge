# Option 1: The Ledger

Paper-accounting editorial. The extension reads like a well-kept cashbook, not software: cream stock, hairline rules, stamped status marks, and every number column set in a tabular monospace, right-aligned.

## Palette
- Paper: `#f6f1e3` (ground), `#efe7d2` (panel alt), `#e9dfc4` (deep panel)
- Ink: `#2b2620` (text), `#6b6152` (soft text), `#948a74` (faint/meta)
- Rules: `#cdbf9c` (hairline), `#a3936c` (stronger border)
- Money out (red ink): `#8a2e2e` on `#f3e4e0`
- Money in (green ink): `#2c5a3a` on `#e3ecdf`
- Accent / gold (stamps, highlights): `#93712f`
- Focus / links: `#1c5a8c`

## Type
- Headings and body: system serif stack, `Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif`.
- Every number column (amounts, balances, row counts, rates, dates in tables): `ui-monospace, SFMono-Regular, Menlo, 'SF Mono', Consolas, monospace` with `font-variant-numeric: tabular-nums`.
- Labels, stamps, and column headers: same monospace stack at small size with wide letter-spacing, for a stamped/typewritten feel.

## Key layout decisions
1. **Stamped badges, not pills.** Status states (CHECKED, NEW, WARNINGS, LOW CONFIDENCE / REVIEW) are bordered monospace tags with a small ink dot, colored per state, rather than soft SaaS chips. They read as marks a clerk would stamp on a folder.
2. **Ruled table everywhere numbers appear.** The review table and mapping preview use full cell borders (ruled-paper grid), sticky headers, right-aligned amount and balance columns, and a struck-through, dimmed style for excluded rows so they stay visible but clearly out.
3. **The PDF source sits inside a physical page.** In Review, the left pane frames the rendered statement as a bordered page with an inset rule and drop shadow (`box-shadow` stack) rather than a flat screenshot, reinforcing "this came from paper." The right pane is the ledger-style extracted table, with the same row highlighted in both panes.

## Grep checks
- Em-dash search over designs/option-1: no hits.
- Banned-word search per the brief's copy rules, over designs/option-1: no hits.
