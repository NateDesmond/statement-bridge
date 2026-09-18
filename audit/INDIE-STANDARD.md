# The standard (Nate, 2026-09-18)
"A careful, handmade indie tool that's shockingly easy to use, just works (does what it says on the tin), and has just the right amount of depth when and where needed, while still being intuitive from start to finish."

## How to audit against it
Walk the REAL unpacked extension (bundled Chromium, never the user's Chrome) as three people, with FULL-PAGE screenshots at 1440 and 1280 of every state you pass through, read every one before writing a line:
1. A first-time, non-technical person with one CSV and one scanned PDF from an unknown bank. Narrate expectation vs what appeared at each screen. Where did you hesitate, feel overwhelmed, or wonder what to do?
2. A returning person on month two with three files already set up. Count clicks and seconds to copied data. Anything that interrupted for no reason is a defect.
3. A picky product designer. For every screen: hierarchy (three tiers, is the primary action unmistakable), alignment and spacing rhythm, duplicated information, controls with nothing to act on, icons that read as something else, copy that is jargon or too long, states that dead-end, inconsistencies between screens (buttons, cards, table styles, link styles), and anything that looks generated rather than made.

Score each screen 1 to 5 on four axes: Easy (no thinking required), Works (did what it says with no surprise), Depth (detail available exactly when needed and hidden otherwise), Made (feels deliberate and cared for). Anything under 4 on any axis is a defect with a concrete fix. Write audit/PASS-<n>.md with the table, the defects ranked, and the screenshot paths. Fixes go in a separate step; then the next pass starts from zero, without reading the previous pass first.
