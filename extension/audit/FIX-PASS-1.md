# Fix Pass 1 - progress log

NOTE: audit/PASS-1-first-timer.md and audit/PASS-1-returner.md do not exist in this
checkout (no audit/pass1 screenshots dir either). Proceeding from the task's own
description of the 6 required outcomes plus direct code reading, since the source
docs are missing. Working item by item, testing each before moving on.

Plan:
1. Unknown IMAGE PDF -> confirm-first flow (Screen A), not bare empty wizard.
2. Screen A blocks Yes when Date/Amount column empty for most rows; routes to fix step.
3. Wizard Next never silently no-ops; Bank name prefilled.
4. Home after Save uses same pipeline as wizard Test step; correct "could not read dates" message.
5. Returner: Copy disabled while processing w/ progress text; "Use anyway" pre-checked; toast dismiss on new card; caption/card wording match.
6. New dev/e2e-first-timer.mjs gated scenario + fixtures + gate.mjs step 4f + screenshots.

## Item 1: unknown IMAGE PDF -> confirm-first flow
Status: investigating
