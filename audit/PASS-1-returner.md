# Pass 1 — Persona 2: returning user, month two, three statements already set up

Driven against the real unpacked extension in bundled headless Chromium (never the
user's Chrome) via a throwaway Playwright script (deleted after the run, nothing
under `src/` touched). Fixtures used: `meridian_savings.csv` (CSV, matches the
built-in Meridian Bank savings profile), `northwind_transaction_history_3p.pdf`
(text PDF, matches the built-in Northwind Bank grouped-PDF profile),
`northwind_transaction_history_image.pdf` (image-only PDF, same bank, triggers
on-device OCR). A fourth fixture, a copy of the Meridian CSV with its first header
renamed `Transaction Date` → `Txn Date`, simulates the bank changing its export
layout.

Screenshots: `audit/pass1/returner-*.png`, full-page at 1440 and 1280, one pair per
state.

## Timeline (wall-clock, headless — see caveat below)

| t | event |
|---|---|
| +0.0s | Extension loaded, Home empty state |
| +1.4s | **Scenario A** — drop CSV + text PDF + image PDF in one action |
| +4.8s | All three file rows show a badge (OCR included) |
| +5.2s | Export panel already reads "ready" |
| +5.3s | Click #1: "Copy to Google Sheets" |
| +5.7s | Toast: "Copied 13 rows to the clipboard" |
| **+4.3s elapsed, 1 click, drop→copy (Scenario A)** |
| +6.1s | **Scenario B** — drop the renamed-header CSV |
| +7.4s | "Layout changed" attention card appears |
| +7.4s | Click #2: "Use anyway" |
| +8.2s | Card resolves |
| **+2.1s elapsed, 1 click (Scenario B)** |
| +8.2s | **Scenario C** — re-drop the exact same Meridian CSV already on Home |
| +9.1s | Caption: "Dropped again, already here." Row count unchanged (4→4) |
| **+1.2s elapsed, 0 clicks (Scenario C)** |

**Caveat on seconds:** this ran in headless Chromium against small synthetic
fixtures, so absolute wall-clock time (OCR finished in ~3s) is not representative of
a real machine/real statement. What's load-bearing and persona-relevant is **click
count** and **the shape of the timeline** (what interrupts, what doesn't), not the
literal seconds.

**Total for the monthly path (Scenario A, the actual "second month" experience this
persona cares about): 1 click, 1 physical drop.** That is the standard this
persona should get every month — drop, wait, copy — and it held with all three
files already matched to profiles.

## Findings so far (batch 1/3 — Scenario A screenshots)

Reviewed: `returner-01/02` (Home empty), `returner-03/04` (mid-processing),
`returner-05/06` (all three done), `returner-07/08` (after copy).

- Home empty state at both widths: clean, three-tier hierarchy (drop zone →
  helper text → "How does this work?"), "Every month after that: drop, wait,
  copy" primes the exact promise this persona is testing. No defect.
- **Mid-processing, the export panel already says "Your transactions are ready"
  with 12 of the eventual 13 rows and 2 of 3 statements**, while the third file's
  row still reads "Reading with text recognition…" with a progress bar. The count
  in the panel ("12 transactions from 2 statements") is accurate for what's done
  so far — it isn't lying — but a returning user primed to "drop, wait, copy" who
  clicks Copy the instant they see "ready" (which is the first thing that visually
  settles) will copy an incomplete export with no warning that a file is still in
  flight. The panel and the still-processing file row are two different visual
  zones; there's no single "not yet — 1 file still reading" gate on the primary
  action itself. **Defect (Works, and Easy indirectly): the ready panel doesn't
  wait for all in-flight files before presenting itself as ready.**
- Once OCR finished, the count correctly updated to 13/3, and a duplicate-merge
  notice ("4 rows merged from overlapping files") appeared — expected here since
  two of my three fixtures are the same underlying Northwind statement (text vs.
  image), not a bug in the app.
- Copy click produced a plain, correctly-worded toast ("Copied 13 rows to the
  clipboard") at both widths, panel state otherwise unchanged underneath the
  toast. No defect in isolation (see batch 2 for what happens when the next
  event fires while it's still up).

## Findings — batch 2/3 (Scenario B: renamed header / "layout changed")

Reviewed: `returner-09/10` (right after dropping the renamed-header CSV),
`returner-11/12` (after clicking "Use anyway").

- Dropping `meridian_layout_changed.csv` (only its date column renamed
  `Transaction Date` → `Txn Date`) correctly triggers a "Layout changed" card:
  ""meridian_layout_changed.csv" no longer matches Meridian Bank savings, CSV's
  saved layout." with primary "Set up again" and secondary "Use anyway". This
  interruption is **justified** — the file genuinely doesn't match the saved
  profile anymore, and a returning user needs to know before their export goes
  stale.
- **Real defect (Depth/Easy): "Use anyway" is a false affordance.** Clicking it
  doesn't accept-and-move-on the way it visually promises to — it re-validates
  against the profile and, because the renamed header means the mapping can't
  find a date column at all, immediately fails with a *second*, different card:
  "Could not read this statement with Meridian Bank savings, CSV" / "None of
  your statement types could read this file." The user's one click bought
  nothing but a worse-sounding dead end. A returning user who trusts "Use
  anyway" (a reasonable read of that label) gets punished for trusting the UI's
  own offered option instead of going straight to "Set up again".
- **Related, smaller inconsistency (Made):** the file row's own caption says
  "Layout seems to have changed" while the attention card a moment later (after
  "Use anyway") says "Could not read this statement" — two different
  vocabularies for what is, once "Use anyway" fails, ultimately the same
  "this file can't be read with what we know" situation. Reads as two
  half-finished copy passes rather than one deliberate state machine.
- **Real defect (Made/Works), spans both screenshots in this batch:** the
  "Copied 13 rows to the clipboard" toast from Scenario A's copy is still on
  screen, sitting on top of the preview table's first row ("NETS PAY 8817
  SHENG SIONG" / "GIRO SP SERVICES" partially obscured) in *both* the
  right-after-drop and the after-"Use anyway" screenshots — i.e. it persisted
  through two separate state changes (a new attention card mounting, then that
  card being replaced by a failure card) without being dismissed. A toast
  should not still be reporting on a stale, already-consumed action while the
  user is being asked to make a new decision two cards later.
- The underlying data integrity is right, for what it's worth: the export
  panel correctly stayed at "13 transactions from 3 statements" throughout —
  the unreadable 4th file was never silently folded into the export.

## Findings — batch 3/3 (Scenario C: exact duplicate re-drop)

Reviewed: `returner-13/14` (after re-dropping the untouched `meridian_savings.csv`
a second time).

- **Exemplary, no defect.** Re-dropping the byte-identical file already on Home
  produces exactly one line of feedback — a small caption under the existing
  Meridian row, "Dropped again, already here." — no new row, no attention card,
  no toast, no modal. Row count stayed at 4 statement rows, the export panel
  was untouched (still 13/3 statements). This is the single best moment in the
  whole session for this persona: a redundant action that a returning user
  will absolutely do sometime (re-dragging the wrong file, or the same
  month's file twice by habit) is handled with the least possible
  interruption while still being visible if you look. Also notable: the
  earlier stray toast had cleared by this point, so no overlap here.

## Scores (1-5 per axis; anything under 4 is a defect)

| Screen / state | Easy | Works | Depth | Made | Notes |
|---|---|---|---|---|---|
| Home, empty | 5 | 5 | 4 | 5 | Clean, sets the "drop, wait, copy" promise correctly |
| Home, mid-processing (2 of 3 "done", panel already says "ready") | 3 | 3 | 4 | 4 | Ready panel not gated on all in-flight files — see defect #2 |
| Home, all 3 done + dedupe notice | 5 | 5 | 5 | 5 | Accurate counts, honest merge caption |
| Home, after Copy (toast shown, no overlap yet) | 5 | 5 | 4 | 4 | Fine in isolation |
| Home, layout-changed card just appeared (toast overlapping table) | 4 | 4 | 4 | 3 | Toast overlap looks unpolished — defect #3 |
| Home, after "Use anyway" → match-failed card | 3 | 4 | 4 | 4 | "Use anyway" is a false affordance — defect #1 |
| Home, exact duplicate re-drop | 5 | 5 | 5 | 5 | Best moment of the session — silent, correct, visible if you look |

## Ranked defects (highest impact first)

1. **"Use anyway" on a Layout-changed card is a false affordance.** It reads as
   "accept this and move on" but actually re-validates and, when the profile
   genuinely can't map the file (as with a renamed key column), immediately
   dead-ends into a second, different-sounding failure card. Fix: pre-check
   whether "Use anyway" would actually produce any rows before showing it as an
   option — if it can't, don't offer it; go straight from "Layout changed" to
   "Could not read this statement" with one consistent message and one set of
   next steps ("Set up again" / "Use a statement type I already set up").
   *(Home, layout-changed → resolved; `returner-09` through `returner-12`)*

2. **The "ready" export panel isn't gated on every in-flight file finishing.**
   With one file still "Reading with text recognition…", the panel below
   already declared "Your transactions are ready" with an accurate but partial
   count (12 rows / 2 statements). A returning user primed by "drop, wait,
   copy" to act the instant something looks settled can Copy an incomplete
   month with no warning attached to the Copy button itself. Fix: disable or
   caption the Copy button while any file is still processing ("1 file still
   reading — copy will include 12 of 13 rows so far"), rather than relying on
   the user to cross-reference the file list above.
   *(`returner-03`/`returner-04`)*

3. **A stale toast overlaps live content across multiple state changes.** The
   "Copied 13 rows to the clipboard" toast from the first Copy stayed on screen
   through a new attention card appearing and then that card being replaced by
   a failure card — two unrelated screens later — sitting directly on top of
   the preview table's first two rows both times. Fix: dismiss any active
   toast the moment a new attention card mounts; a toast reporting a finished,
   already-acted-on event should never persist into decisions about a new one.
   *(`returner-09` through `returner-12`)*

4. **Inconsistent vocabulary between the file-row caption and its own
   attention card for the same failure.** The row says "Layout seems to have
   changed"; two clicks later, once it's clear the file truly can't be read,
   the card says "Could not read this statement" / "None of your statement
   types could read this file." Fix: once the failure is confirmed (not just
   suspected), update the row caption to match the card's own wording so the
   two never say different things about the same state.
   *(`returner-09` vs `returner-11`)*

5. **No visual link between "N of M statements ready" and the file list's own
   in-progress row.** The two pieces of true information (the panel's honest
   partial count, the file row's "Reading…" progress bar) sit in separate
   cards with no shared color/tone cue that they're describing the same
   incomplete moment — the panel looks fully calm and "done" white/brass while
   the row above it is visibly still working. Fix: a shared amber/processing
   tone or a one-line cross-reference ("1 more on the way") ties them together
   until everything lands.
   *(`returner-03`/`returner-04`, same root cause as defect #2, listed
   separately because the fix is a design/hierarchy fix rather than a Copy-
   button gate)*

## Screenshot index

All in `audit/pass1/`, full-page at 1440 and 1280:
`returner-01/02` empty · `returner-03/04` mid-processing (premature "ready") ·
`returner-05/06` all three done + dedupe notice · `returner-07/08` after Copy ·
`returner-09/10` layout-changed card (toast overlap) · `returner-11/12` after
"Use anyway" → match-failed card · `returner-13/14` exact duplicate re-drop
(silent, correct).

