# Option 5: The Vault

Privacy-first calm. Dark ink-green chrome (sidebar + header) framing a light warm-grey
workspace, so the app itself reads "secure" and the data reads "clean". A private bank's
back office: quiet, orderly, one brass accent for the action that matters.

## Palette
- `#0d1a17` ink-900, base sidebar/header background
- `#132420` ink-800, header surface
- `#1a302a` ink-700, hover/active nav row
- `#2c463e` ink-line, borders inside dark chrome
- `#e7efe9` ink-text, `#9db3ab` ink-text-dim, text on dark chrome
- `#c6a15b` brass, `#d6b06a` brass-hover, the one primary-action color
- `#f3efe6` paper, light content background
- `#ffffff` paper-raised, cards and panels
- `#e3ddcd` paper-line, borders in the light area
- `#20241f` ink, `#666a5f` ink-dim, text on light area
- `#3f7856` / `#e7f1e9` ok, `#9a6a1f` / `#f7ecd6` warn, `#a1402f` / `#f8e6e1` danger

## Type
System sans stack (`-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial`)
throughout the UI. All monetary and count figures get `font-variant-numeric: tabular-nums`
via a shared `.num` class, so columns of amounts line up without a monospace font. The PDF
mock in Review uses `Georgia` to read as a printed statement, distinct from the app's own UI.

## Key layout decisions
1. **Sidebar owns navigation, the header owns context.** Import/Review/Map/Export/Settings
   live in a fixed dark sidebar with an always-visible offline lock indicator and a storage
   meter pinned to its footer, so the security posture is never scrolled out of view. The
   header above the light content area just names the current screen and holds the two
   session-level actions (Clear sessions, Add statements).
2. **Chrome is dark, data is never dark.** Every screen's working surface (file cards, the
   split review, the mapping table, export panels, settings) sits on the light paper
   background with white cards, so the eye reads "the vault door is shut, but the ledger on
   the desk is easy to read." Only the frame commits to ink-green.
3. **Ceremony for destructive actions.** "Clear sessions" is a plain ghost button in the
   header, always present but low-key. "Delete everything" gets its own bordered danger
   zone in Settings with a type-to-confirm input, so the two actions read at different
   weights on purpose: one is routine, one is a ceremony.

Deliberately skipped: no animation library, no icon font, tab switching is ~20 lines of
vanilla JS. `<details>` handles the About panel's disclosure natively.
