# Simple B: Big Friendly Steps

Full-width, no sidebar, no persistent chrome except a dark brand bar and a gear.
Keeps the Vault palette and logo from option-5 but drops the app-shell furniture
entirely for the simple surface.

## Key layout decisions

1. **One progress strip carries the whole flow.** The brief describes both a
   top 3-step strip and a row of tiny step icons under the empty-state
   dropzone. Those are the same three steps twice, so the icon row was
   dropped and the top strip (Drop / Read / Copy) is the single, always-visible
   answer to "where am I", filling left to right as the user's files move
   through the app.

2. **The result card and table are full width, not boxed into a sidebar-free
   column.** Because Direction B has no persistent navigation eating
   horizontal space, the result card, decision cards, and table all use the
   entire content width, which is what makes the primary button and table
   readable as "big" rather than just centered in leftover space.

3. **Decisions and setup interrupt in place, they do not detour to a new
   section.** "Needs a look" renders as a calm banner above the same result
   card it is holding back, and the confirm-first setup wizard reuses the
   result screen's table styling so a person never feels moved to a
   different app. The gear is the only door to anything that is not part of
   the drop-to-copy path, opened as a full-screen overlay of six tiles so it
   reads as a distinct, deliberate visit rather than another panel bolted
   onto the main screen.

Deliberately skipped: no animation library, tab and step switching is plain
JS event listeners, `<details>` handles the decision banner's own
expand/collapse.
