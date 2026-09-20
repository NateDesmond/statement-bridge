# Pass 2 — Returning person, month two, three statements already set up

Real unpacked extension, bundled Chromium (playwright-core), headless=new, 1440x900,
full-page screenshots. Driver: `extension/dev/pass2-returner.mjs`. Raw run log:
`audit/pass2/run-log.txt`. Screenshots: `audit/pass2/returner-*.png`.

## Setup notes (read before the numbers)

Fixtures used: `meridian_savings.csv` (CSV, builtin-meridian-savings),
`northwind_transaction_history_sample.pdf` (text PDF, builtin-northwind…-pdf),
`northwind_transaction_history_image.pdf` (image/OCR PDF, same builtin). All three
auto-match a built-in profile with **zero wizard clicks** — this is what "already set
up" means for a built-in bank: nothing to configure, ever.

One fixture-set quirk found and worked around: `northwind_transaction_history_sample.pdf`
and `northwind_transaction_history_image.pdf` are the same underlying statement (text
export + scanned copy of it), so dropping both together correctly triggers the app's own
duplicate-content detection ("Same transactions as …, not added again") and folds to 2
account rows instead of 3. That is real, working dedupe — not a bug in the app — but it
means the "three files" baseline below is 1 CSV account + 1 PDF account + 1
auto-absorbed duplicate, not three independent accounts. Treated as-is rather than
faked, per the no-fabrication rule.

## Monthly path: clicks and seconds

Drop all three (CSV + text PDF + image PDF) → wait → Copy.

- **Actions: 2 total** — one drag-drop (all three files in one gesture) + one click
  (Copy to Google Sheets). No confirmation screens, no per-file setup, nothing to name.
- **Timing (headless Chromium, indicative only — real hardware will differ)**:
  files appear in the list at 0.1s; Copy becomes genuinely ready (both statements
  "Done", OCR finished, no blocking note) at **3.9s**; clicking Copy and seeing
  "Copied 10 rows to the clipboard" lands at **4.0s**.
- Nothing interrupted this path. No dialog to dismiss, no redundant confirmation.

## Edge cases

**A — layout changed (renamed CSV header).** Copied `meridian_savings.csv`, renamed
its first header from the original to "Txn Date". Confidence drops to an 85% match;
the app shows one card ("Confirm statement type… looks like Meridian Bank savings,
CSV (85% match)") with **Confirm** / **Pick another**. One click (Confirm) and it's
done — no trip through the full wizard. Good, low-friction recovery.

**B — exact re-drop.** Dropped `meridian_savings.csv` twice. Second drop adds no new
row and no duplicate data; the original row gets a quiet caption, "Dropped again,
already here." Zero extra clicks, no confusion possible.

**C — drop while another file is still being read.** Dropped the image PDF (slow OCR
path), then while it was still "Reading with text recognition…", dropped the CSV.
Copy stayed correctly disabled the whole time the OCR file was in flight, with an
explicit, honest reason: *"Reading 1 of 2 statements, 5 rows so far."* The moment OCR
finished, Copy re-enabled with the full 10-row combined total. This is exactly the
"hold Copy until every file is done" behavior called for in the code's own comments,
and it visibly worked — no defect here.

## Score table (1–5; <4 on any axis = defect)

| Screen | Easy | Works | Depth | Made | Notes |
|---|---|---|---|---|---|
| 01 Home, empty, month 2 (`returner-01`) | 4 | 5 | 4 | 4 | Restore-vs-Start-fresh card and the drop zone are both full-weight white cards competing for top billing |
| 02 Monthly: files dropped (`returner-02`) | 5 | 5 | 4 | 4 | Restore banner still shown above active work |
| 03 Monthly: ready to copy (`returner-00`/`03`) | 5 | 5 | 5 | **3** | Restore banner is now stale (new data already on screen) yet still live and unguarded — see Defect 1 |
| 04 Monthly: copied (`returner-04`) | 5 | **4** | 5 | 4 | Success toast overlaps a data row underneath it — see Defect 2 |
| 05 Layout-changed confirm (`returner-05`) | **3** | 5 | 5 | 4 | "(85% match)" is a raw confidence number, jargon for a non-technical user — see Defect 4 |
| 06/07 Exact re-drop (`returner-06`, `07`) | 5 | 5 | 4 | 4 | Restore banner persists, same issue as row 03/07 |
| 08–10 Concurrent read (`returner-08/09/10`) | 5 | 5 | 5 | 4 | Handled correctly; Restore banner persists throughout |

## Top 5 defects, ranked, with fixes

1. **"Restore your last statements?" never dismisses itself, and stays a live
   destructive control after new data exists.** It's still on screen, unchanged,
   after the user has dropped three new files, copied 10 rows, re-dropped a
   duplicate, and run the concurrent-read case — every single screenshot in this
   pass still shows it. Once the user acts (drops any file), the question is
   already answered and the banner is dead weight; worse, it stays clickable next to
   a fully-populated new session with no visible confirm-before-overwrite step.
   **Fix:** hide the banner the moment any file is dropped in the session; if
   "Restore" must stay reachable, move it to a quiet secondary link and add a
   confirmation before it replaces a non-empty current session.
2. **Success toast overlaps the results table.** "Copied 10 rows to the clipboard"
   renders on top of a live data row (obscuring "Salary Giro Credit Acme…" in this
   run), right at the moment a user is most likely to want to double-check what
   was copied. **Fix:** anchor the toast above the table or as a page-level banner
   that never occludes data.
3. **Copy button's `disabled` state and its blocking note can transiently
   disagree** (observed directly while building this pass's automation: a single
   frame with `copy-tsv-btn.disabled === false` while the blocking note still read
   "Reading 1 of 3 statements"). Even though the final settled state is always
   correct, the two are evidently set by separate steps rather than one atomic
   readiness render, which is a fragile pattern a future change could turn into a
   real click-while-reading bug. **Fix:** compute `disabled` and the blocking note
   text from the same `exportReadiness()` call inside a single render pass, never
   set the attribute ahead of or behind the note.
4. **"(85% match)" is a raw confidence score shown to a non-technical user** on the
   layout-changed confirm card. The standard explicitly wants copy that isn't
   jargon. **Fix:** replace with plain language ("looks like the same statement,
   just a renamed column") and keep the percentage only in the debug log / an
   "advanced details" disclosure.
5. **Two full-weight cards compete for primary attention on the returning user's
   first screen** (Restore-your-last-statements vs. Drop-your-bank-statements-here),
   both styled as equal white bordered cards. For someone who already has three
   accounts set up and just wants to drop this month's files, the drop zone should
   unambiguously read as the one thing to do. **Fix:** demote the restore prompt to
   inline text/small link weight, well below the drop zone in visual priority.

## Screenshot index

All at 1440×900, full page, under `audit/pass2/`:
`returner-00-seed-all-three-healthy.png`, `returner-01-home-empty-month2.png`,
`returner-02-monthly-dropped.png`, `returner-03-monthly-ready.png`,
`returner-04-monthly-copied.png`, `returner-05-case-a-layout-changed.png`,
`returner-06-case-b-first-drop.png`, `returner-07-case-b-redrop.png`,
`returner-08-case-c-first-still-reading.png`,
`returner-09-case-c-second-dropped-mid-read.png`,
`returner-10-case-c-both-done.png`.
