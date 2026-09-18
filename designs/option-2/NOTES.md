# Option 2: The Console

Direction: dense keyboard-first tool in the Linear / Bloomberg terminal / Raycast family, tuned warm instead of blue-black so long review sessions don't feel clinical.

## Palette
- `#141416` base charcoal, `#1a1a1d` / `#1e1e21` raised panels, `#101012` inset wells
- `#2b2b2f` / `#232326` borders (1px only, no shadows)
- `#e9e6df` primary text, `#98958d` dim, `#5f5d58` faint
- `#f2a824` single accent (amber): active tab, primary buttons, selected row, focus ring
- Status dots only, semantic and small: `#3ecf8e` good, `#f2a824` warn, `#e5594f` bad, `#7d93a8` new/neutral
- `#e9e6de` "paper" surface for the rendered PDF source, kept light on purpose so it reads as a physical page inside the dark chrome

## Type
- UI: system-ui stack at 13px body / 11-12px labels, uppercase tracked labels for section headers
- Numbers, dates, account numbers, code-like values: `ui-monospace` everywhere, so columns of amounts actually align
- No external fonts, no webfonts

## Key layout decisions
1. **Command bar, not a hero header.** One 46px strip: logo, brand, the five numbered tabs (1-5 also work as keyboard shortcuts), and a persistent keyboard-hint strip on the right (J/K, X, E, ⌘⏎). Sets the "operable tool" tone before the user touches anything.
2. **Real split pane on Review.** Left pane renders the source as a light "paper" rectangle inside the dark chrome (PDF look) with the matching row highlighted; right pane is the extracted table. The 9px resizer between them has a visible grip and actually drags (a few lines of JS), not just a decorative cursor.
3. **One screen, chrome never scrolls.** `body` is a fixed-height flex column; each of the 5 screens is absolutely positioned inside `main` and fills it. Only `.body` wrappers and table bodies get `overflow-y:auto`, so the header, toolbars, stepper, and summary/footer bars stay pinned exactly where the brief asks.

Logo slot degrades to a plain "SB" monogram in the same box size if `../logos/logo-2.png` is missing, so layout never breaks.

