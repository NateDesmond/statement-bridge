# Simple A: one calm column

Direction A from SIMPLE-MODE.md: a centred 760px column, generous whitespace, the result
card is the only strong element, everything else greys back. Reuses the Vault palette and
type from option-5 (`designs/option-5/NOTES.md`), drops option-5's dark sidebar chrome
entirely since the brief calls for no sidebar in simple mode.

## Layout decisions

1. **No app chrome, one column.** The dark sidebar and header from the Vault are gone. What
   is left is a plain top bar (logo, name, gear) and a single 760px column centred in the
   page. Every surface, empty, processing, result, decision, setup, lives in that same
   column so nothing ever competes with it sideways.
2. **The result card is the only card with weight.** It gets a raised white surface, a
   shadow, generous internal padding and the brass action at full size. Every other surface
   (the dropzone, the processing rows, the decision card) sits flatter and quieter: thinner
   borders, no shadow, smaller type, so a person's eye lands on the result the moment it
   exists. When a decision is pending, the result card is shown greyed out and its button
   disabled, so it stays visible without competing with the thing that needs attention.
3. **The gear is a right-side sheet, not a mode change.** Opening it does not replace the
   page, it slides a panel over whatever surface was already showing, so "Adjust what's
   exported" from the result screen and the gear icon in the top bar land on the identical
   panel. Closing it (backdrop click, X, or Escape) returns to exactly where the person was.

Deliberately skipped: no animation library (one CSS keyframe for the sheet slide), no
routing, the confirm-first setup's three screens (A/B/C) are three `<div>`s toggled by one
`switchSetup()` function reused from the same pattern as the main surface switcher. A
dev-only pill nav at the top lets a reviewer jump between the six surfaces; it is visually
separated (dark strip) from the product UI so it reads as a mockup aid, not a feature.
