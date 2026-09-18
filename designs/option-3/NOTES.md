# Option 3: The Guide

## Palette
- Brand teal: `#0E8577` (primary buttons, active states, links)
- Brand teal dark (hover): `#0A6558`
- Brand ink (tinted-panel text): `#063E35`
- Soft tinted panel: `#EAF5F2`, stronger tint: `#DCEFEA`
- White ground: `#FFFFFF`
- Ink (body text): `#152420`
- Muted text: `#5C6B67`
- Border: `#DCE6E2`, stronger border: `#C4D3CE`
- Warning: bg `#FFF3E1`, text `#8A5300`, border `#F3D8A9`
- Bad/fail: bg `#FDECE9`, text `#A23A25`, border `#F3C7BC`
- Coral (reserved, unused as a UI color here since teal was picked): `#E0603F`

## Type
System font stack (`-apple-system, "Segoe UI", Roboto, ...`) at a 15px body base, no external fonts. Headings use the same stack at 650 weight with slight negative tracking for a tighter, app-like feel rather than a marketing-page feel. Numeric columns (dates, amounts, balances) use `font-variant-numeric: tabular-nums` so tables read cleanly at density. The source PDF preview uses a monospace stack to read as a document, not UI chrome.

## Key layout decisions
1. **Conversation-plus-preview split on the mapping wizard.** The wizard is not a form with eight rows, it is one question at a time on the left (with sample values, a confidence badge and a "yes / choose another" confirmation), while the real preview table stays visible on the right the whole time. This matches the brief's requirement that a first-time user never maps a format in the abstract.
2. **Soft tinted panels instead of dividing lines to group meaning.** The dropzone, summary bar, samples box, and confirm notes all sit on the `#EAF5F2` tint rather than boxed borders, so the page reads as calm sections rather than a grid of cards. White cards on white ground are reserved for content that needs a hard edge (file cards, tables, the split review panes).
3. **Progress that explains itself everywhere, not just the wizard.** "2 of 4 files are ready to export" on Import, "3 of 4 files ready to export" on Export, and "3 of 8 fields mapped" plus a fill bar on the wizard all state the concrete count rather than a bare percentage or spinner, per the brief's framing requirement.

## Copy and grep
Ran `grep -rn "-" designs/option-3` and `grep -rniE "honest|genuine|truthful" designs/option-3` after building. One em-dash was found in the `<title>` tag and fixed (replaced with a comma). No banned words found.
