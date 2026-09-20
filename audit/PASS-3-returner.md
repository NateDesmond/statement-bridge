# Pass 3 — Persona 2 (returning user, month two)

Real unpacked extension, bundled Chromium (playwright-core), fixed persistent
profile dir so storage survives across separate node invocations (used to
simulate "close and reopen the tab").

## Batch 1: initial setup — generic_unknown_bank.csv

Confirm-first Screen A auto-detected the CSV correctly (positional fallback:
When->date, What->description, Value->amount) with "We found 5 transactions
... Does this look right?" — no manual mapping needed at all.

Clicks: "Yes, looks right" -> "Save and finish" = **2 clicks**.
Time: ~10s (includes wizard render waits).

Screenshots: audit/pass3/returner-01-csv-confirm-a.png,
returner-02b-csv-confirm-c.png, returner-06-csv-home-after-save.png — all
clean, on-brand, no dead ends.

Named profile "Generic savings" from the CSV filename base — sensible
default, no jargon.

## Batch 2: initial setup — summit_grouped_2line_image.pdf (scanned, OCR)

Same confirm-first fast path — "Yes, looks right" was NOT disabled even for
a scanned grouped-2-line image PDF requiring OCR; it correctly extracted 37
transactions ("Summit Bank credit_card ****2618", 18 Aug-14 Sep 2026, card
last-4 detected from the scan).

Clicks: "Yes, looks right" -> "Save and finish" = **2 clicks**.
Time: ~18s from confirm screen to saved (OCR read time included).

Screenshots: returner-10-pdf-confirm-a.png (caught the wizard mid-render on
Basics before the confirm screen painted — a fast dev-tooling timing quirk,
not something a real user with visible loading state would see the same
way), returner-11b-pdf-confirm-c.png, returner-14-pdf-home-after-save.png.

## Batch 3: close and reopen the tab

Fresh browser context/tab against the same extension profile (the strongest
form of "closed and reopened" — a real session restart, not just a DOM
reset). Home showed "Restore your last statements? Restore / Start fresh"
— a genuinely useful returning-user touch, distinct from the two saved bank
profiles (which persist regardless, since they live in a different storage
key). Screenshot: returner-20-reopened-home.png.

## Batch 4: monthly path — 3 files, 1 drop, dedicated fixtures

New copies, renamed, one calendar month later where editable:
- generic_unknown_bank_october.csv — same fixture with every `dd/mm/2026`
  date's month number pushed +1 (Sept -> Oct); values/text untouched.
- summit_grouped_2line_image_october.pdf — plain renamed copy of the scanned
  PDF (dates are baked into the scanned image; can't edit an image PDF's
  transaction dates without re-rastering the page, so only the filename
  changed, as the task brief allowed for).
- meridian_savings.csv — one builtin fixture, unmodified.

Dropped all three at once. **0 wizard clicks** — every file auto-matched an
existing profile (2 custom + 1 builtin) with no interruption at all.
- Ready to copy: **20.8s**, 0 clicks.
- Copy to Google Sheets: **1 click**, instant toast "Copied 47 rows to the
  clipboard".
- **Total clicks to copied data: 1. Total time: ~21s.**

Screenshot: returner-30-monthly-all-ready.png — all three rows "Done", combined
preview correct, export settings panel below (Simple columns default,
per-account toggle table, currency mode) all present but collapsed/quiet
until scrolled to — depth exactly where it should be.

### "Since last export"

Clicked "Adjust what's exported" (1 click) to open the Change drawer, then
the "Since last export" chip (1 click) — **3 clicks total** including the
earlier copy. It appeared in the date-range chip row exactly as spec'd, and:
- Computed range Jun 21 - Sep 19 2026 (day after the earliest of the three
  accounts' last-exported markers, to today).
- Showed a plain-English reason per zero-row account: "No Summit Bank
  credit_card ****2618 data after 14 Sep; No Meridian Bank savings ****7890
  data after 20 Jun" — good, this is exactly the kind of depth-on-demand
  the standard asks for.
- Showed an overlap warning: "Re-exporting rows already exported for:
  Generic savings, Summit Bank credit_card ****2618".

**Defect found here (see #1 below):** the overlap warning names "Generic
savings" as an account being re-exported, but the accounts table right below
it shows Generic savings at **0 of 5 rows in range** for this exact
selection — i.e. the warning claims an overlap for an account that
contributes zero rows to the export. The warning is computed purely from
whether an account's last-export marker falls on/after the range start,
independent of whether any of that account's currently-loaded rows are
actually inside [start, end] — so it can fire for an account that isn't
present in the export at all. (Caveat: the CSV's dates were pushed into
October while the audit session's clock reads 2026-09-19, so Generic
savings' Oct rows land in the *future* relative to "today" and get clipped
off the end of the range — a testing-rig quirk, but the mismatched warning
text itself is a real, reproducible logic gap independent of that.)

Screenshots: returner-32-change-drawer-range-chips.png,
returner-33-since-last-export-applied.png.

## Batch 5: layout-changed

Dropped a copy of the CSV with `When` renamed to `Whn` in the header row
(amount/description columns untouched). Home immediately showed a distinct
"Layout changed" card: *""generic_unknown_bank_layoutchanged.csv" no longer
matches Generic savings's saved layout"* with **Set up again** / **Use
anyway** — exact, named, non-scary language, and an escape hatch for a user
who just wants the file included as-is. Clicking Set up again reopened
confirm-first with an honest heading ("This looks different from last time.
Does this look right?") and correctly-parsed data — one click away from
being fixed. Screenshots: returner-40-layout-changed-home.png,
returner-41-layout-changed-wizard-open.png.

## Batch 6: re-drop (the exact same already-exported files again)

Dropped the same October CSV + PDF a second time. Both silently re-matched
their existing profiles and re-processed with **zero clicks and zero
prompts** — no "already exported this" nag, no re-confirm, nothing. Ready
in 5.5s. This is the right behavior for "I dropped the wrong file, let me
try again" and for "let me re-copy without re-picking Since-last-export" —
no needless interruption. Screenshot: returner-51-re-drop-final.png.

## Clicks / seconds summary

| Step | Clicks | Seconds |
|---|---|---|
| Set up CSV (first time) | 2 | ~10 |
| Set up PDF/OCR (first time) | 2 | ~18 |
| Close+reopen tab, verify persisted | 0 | - |
| Monthly drop of 3 files -> ready | 0 | 20.8 |
| Copy to Sheets | 1 | instant |
| Open Since-last-export | 1 | instant |
| **Monthly total (drop to filtered copy)** | **3** | **~29** |
| Layout-changed: detect + reopen wizard | 1 | instant |
| Re-drop same files again | 0 | 5.5 |

For an established month-two user with 3 statement types, the steady-state
monthly loop is **1 click, ~21 seconds** (drop -> wait -> copy), matching
the app's own promise on Home: "Every month after that: drop, wait, copy."
That promise is true and delivered.

## Score table (1-5, this persona's lens: Easy / Works / Depth / Made)

| Screen/flow | Easy | Works | Depth | Made |
|---|---|---|---|---|
| Confirm-first (CSV, auto-detected) | 5 | 5 | 4 | 5 |
| Confirm-first (PDF/OCR, auto-detected) | 5 | 5 | 4 | 5 |
| Reopened Home / Restore prompt | 5 | 5 | 4 | 5 |
| Monthly 3-file drop -> ready -> copy | 5 | 5 | 5 | 5 |
| Since-last-export chip + overlap note | 4 | **3** | 5 | 4 |
| Layout-changed card | 5 | 5 | 5 | 5 |
| Re-drop (idempotent) | 5 | 5 | 4 | 5 |

## Top 5 defects, ranked

1. **Since-last-export overlap warning can name an account with 0 rows in
   the export.** `sinceLastExportRange` (src/core/home-state.js) flags an
   account as "already exported" purely by comparing its stored marker date
   to the computed range start, never checking whether that account has any
   rows actually inside [start, end] for the *current* file set. Fix: only
   include an account in `overlapAccounts` if it also has at least one row
   in the currently computed range (or word the message as "your export
   history overlaps this range" rather than naming specific statements,
   since the true overlap check needs the live row set the pure function
   doesn't have).
2. **Confirm-first Screen A can render before the extraction data is ready
   on an OCR PDF**, briefly showing the full-wizard Basics step (with a
   half-populated single skeleton row) instead of a loading state, before
   Screen A itself paints once OCR finishes. A user watching closely would
   see a flash of "wrong" UI. Fix: keep the existing processing/reading
   indicator visible until the confirm screen's data is fully computed,
   rather than letting the wizard mount on Basics as an intermediate frame.
3. **Two different date ranges are shown side by side with no distinguishing
   label** on the ready screen when a range filter narrows the export: the
   headline ("47 transactions from 3 statements - 1 Jun 2026 to 15 Oct
   2026") and the "Export settings" line ("21 Jun 2026 to 19 Sep 2026") can
   diverge, one describing the actual data span and the other the selected
   filter window, with nothing calling out which is which. Fix: label them
   explicitly ("data spans ... / exporting rows from ...") so they read as
   two different facts, not a contradiction.
4. **"Set up again" / layout-changed and drop-more-statement buttons are not
   consistently reachable by a single unambiguous selector** during
   automation (a `button:has-text("Set up again")` intermittently needed a
   second attempt to resolve) — likely harmless for a mouse user but worth a
   quick look for whether the DOM briefly contains two matching buttons
   (e.g. a hidden template plus the live one), which is the same category of
   issue the codebase's own comments elsewhere flag as a real flake source.
5. **No visible acknowledgement that "Since last export" is itself a live,
   recomputed value** — clicking it silently swaps the range with no
   transition/highlight beyond the chip turning active; on a fast repeat
   check (as here) it's easy to miss that new numbers appeared at all next
   to the unchanged headline "Your transactions are ready." A brief inline
   confirmation (e.g. flash the changed row count) would remove any doubt
   the click did something, especially since the result here was
   legitimately surprising (rows dropped from 47 to 37).

## Screenshot index

audit/pass3/returner-01-csv-confirm-a.png, returner-02b-csv-confirm-c.png,
returner-06-csv-home-after-save.png, returner-10-pdf-confirm-a.png,
returner-11b-pdf-confirm-c.png, returner-14-pdf-home-after-save.png,
returner-20-reopened-home.png, returner-30-monthly-all-ready.png,
returner-32-change-drawer-range-chips.png,
returner-33-since-last-export-applied.png,
returner-40-layout-changed-home.png,
returner-41-layout-changed-wizard-open.png,
returner-50-re-drop-same-files.png, returner-51-re-drop-final.png.
