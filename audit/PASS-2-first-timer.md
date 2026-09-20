# Pass 2 — First-time, non-technical user

Persona: someone who has never used this extension, dropping one CSV from a
bank the tool has no saved profile for, then one scanned (image-only) PDF
from a bank it also doesn't recognize. I only clicked what the screen itself
put in front of me — the obvious/highlighted button — and never opened the
gear menu or "Adjust what's exported" unless the main path pushed me there.

Files used: `extension/test/fixtures/generic_unknown_bank.csv`,
`extension/test/fixtures/summit_grouped_2line_image.pdf`.

Driver: `extension/dev/pass2-firsttimer.mjs` (new, modeled on
`extension/dev/e2e-extension.mjs`'s `launchExtensionContext`), run against
the real unpacked extension in bundled headless Chromium.

## Walkthrough narration

### CSV (generic_unknown_bank.csv)

1. **Home, empty.** Expectation: "some box to drop my bank file into."
   Got exactly that — a big dashed drop zone, "Drop your bank statements
   here," a gold "Choose files" button, and a one-line privacy reassurance
   ("Nothing leaves your computer"). No hesitation. `first-timer-00-home-empty-1440.png` / `-1280.png`.

2. **After dropping the CSV.** Expectation: "did it work? what do I do now?"
   A card appeared immediately: "New bank statement — 'generic_unknown_bank.csv'.
   Let's set it up, takes about a minute," with one gold "Set up" button and
   a plain-text alternate link. No ambiguity about what to click.
   `first-timer-01-home-after-csv-drop-1440.png`.

3. **Wizard, "Does this look right?"** Expectation: some kind of technical
   mapping screen with column headers and dropdowns (I was bracing for this,
   because the CSV headers are "When/What/Value," not "Date/Description/Amount").
   Instead I got a plain-English summary — "We found 5 transactions from
   2026-09-01 to 2026-09-15" — money-in/money-out totals, and a normal-looking
   table with real dates, descriptions and amounts already lined up correctly.
   This is a pleasant surprise: the odd column names were handled invisibly.
   Two buttons, "Yes, looks right" (gold, obviously primary) and "Something's
   off" (quiet secondary). I clicked Yes. `first-timer-02-wizard-screen-a-1440.png` / `-1280.png`.

4. **"Name this statement."** Expectation: skippable or auto-filled. It was
   pre-filled with "Generic savings, CSV" — a guess at the account type, not
   just the filename. Slightly odd wording ("Generic savings" reads like a
   category label, not a name I'd have picked) but not blocking; I could see
   myself renaming it or just hitting Save. One button, "Save and finish."
   `first-timer-03-wizard-screen-c-1440.png` / `-1280.png`.

5. **Home, done.** Expectation: "now what — do I have to go find my data
   somewhere?" No — the page itself turned into "Your transactions are
   ready," with a big gold "Copy to Google Sheets" button, a secondary
   "Download CSV," and a live preview table of exactly what will be copied.
   `first-timer-05-home-ready-to-copy-1440.png` / `-1280.png`.

6. **After clicking Copy.** A dark toast appeared at the bottom: "Copied 5
   rows to the clipboard." Confirms the action happened without me having to
   guess. `first-timer-06-after-copy-click-1440.png` / `-1280.png`.

Total: 3 clicks (Set up → Yes, looks right → Save and finish) + 1 click to
copy. No dead ends, no jargon, no moment I had to stop and think.

### PDF (summit_grouped_2line_image.pdf — scanned/image-only)

1. **After dropping the PDF.** Same "New bank statement, let's set it up"
   card as the CSV. I expected a scanned PDF to be visibly harder ("this
   might not work at all" was my mental bar), so I braced for an error or a
   long wait. `first-timer-10-home-after-pdf-drop-1440.png`.

2. **Wizard, "Does this look right?"** It correctly read 37 transactions
   out of a scanned image with no visible struggle — dates, merchant names,
   and amounts all in place. Same two-button pattern as the CSV. I clicked
   Yes. `first-timer-11-wizard-screen-a-pdf-1440.png` / `-1280.png`.

3. **"Name this statement."** Here it surprised me differently: it pre-filled
   "Summit Bank credit card, PDF" — meaning it correctly figured out which
   bank this was just from reading the scan. Reassuring, since I'd assumed
   this was an "unknown" bank going in. `first-timer-12-wizard-screen-c-pdf-1440.png` / `-1280.png`.

4. **Home, done.** Here's the one place I actually paused: the file row no
   longer showed my filename — it now read "\*\*\*\*2618" as the row's title,
   with "Done, 37 transactions" and "Read with text recognition" underneath.
   I had a "wait, where did my file go, what is 2618?" moment before
   realizing it must be the last 4 digits of my card number, replacing the
   filename. Nothing on screen said *why* the label changed. The main "Copy
   to Google Sheets" flow itself was identical to the CSV's and worked the
   same way — toast confirmed "Copied 37 rows to the clipboard."
   `first-timer-13-home-after-save-pdf-1440.png`, `first-timer-14-home-ready-to-copy-pdf-1440.png` / `-1280.png`,
   `first-timer-15-after-copy-click-pdf-1440.png` / `-1280.png`.

Total: same click count as the CSV path (Set up → Yes, looks right → Save
and finish → Copy). No manual mapping was ever required for either file —
the tool's "figure it out for me" promise held up for two genuinely unknown
banks in a row.

## Score table

| Screen | Easy | Works | Depth | Made | Notes |
|---|---|---|---|---|---|
| Home, empty | 5 | 5 | 5 | 5 | Nothing to fix. |
| Home, file dropped / "Let's set it up" card | 5 | 5 | 5 | 5 | |
| Wizard "Does this look right?" (CSV) | 5 | 5 | 5 | 5 | Handled mismatched headers invisibly — best screen in the flow. |
| "Name this statement" (CSV) | 4 | 5 | 4 | 4 | Pre-filled name reads like a category, not a name ("Generic savings, CSV"). |
| Home, "Your transactions are ready" (CSV) | 5 | 5 | 5 | 5 | |
| Copy toast (CSV) | 5 | 5 | 5 | 5 | |
| Wizard "Does this look right?" (PDF, scanned) | 5 | 5 | 5 | 5 | 37 rows from an image with zero visible friction. |
| "Name this statement" (PDF) | 5 | 5 | 5 | 5 | Correctly identified the bank from the scan — feels like real depth, offered exactly when useful. |
| Home, done / ready-to-copy (PDF) | 4 | 4 | 3 | 4 | File label silently swapped from filename to "\*\*\*\*2618" with no explanation — see Defect 1. |
| Copy toast (PDF) | 5 | 5 | 5 | 5 | |

## Top 5 defects (ranked)

1. **Unexplained identity swap on the file row (PDF path).** After saving, the
   row that was "summit_grouped_2line_image.pdf" all the way through the
   wizard suddenly becomes "\*\*\*\*2618" on Home, with nothing nearby saying
   this is the account number replacing the filename for privacy. A
   first-timer reasonably wonders if their file disappeared or got mixed up
   with another account. *Fix:* keep the filename (or the bank/name from the
   wizard, e.g. "Summit Bank credit card") as the primary line, and put the
   masked account number as a secondary caption if it's needed for
   disambiguation — never let a first-run label change be the only signal
   after Save.

2. **Auto-filled statement name reads as a category, not a name (CSV path).**
   "Generic savings, CSV" is technically informative but sounds like internal
   naming (mirrors profile-matching vocabulary: bank + account-type + file
   format) rather than something a person would type. *Fix:* prefer a name
   built from what the user already told the tool (the account nickname if
   set, otherwise something like "My statement — Sep 2026") over a
   bank/type/format concatenation.

3. **Screen A's preview caps at 5 rows with no count-remaining cue on the
   preview itself (37-row PDF).** The headline text says "We found 37
   transactions," but the table under it only ever shows 5, and nothing in
   the table area itself (e.g. "+32 more") reminds you the rest weren't
   inspected before you click Yes. A first-timer confirming "does this look
   right" for the visible 5 is implicitly also vouching for 32 they never
   saw. *Fix:* add a one-line "+32 more rows not shown" under the table so
   the confirm feels honestly scoped.

4. **No progress indication while OCR reads a scanned PDF.** I went straight
   from "file dropped" to "New bank statement, ready to set up" with no
   visible "Reading your scan…" state in between, even though the row later
   reveals "Read with text recognition" happened. For a first-timer who
   doesn't know OCR is running, a multi-second gap with only the generic
   drop-zone showing could read as "did this stall?" *Fix:* surface a short
   "Reading your PDF…" status on the file row while OCR is in flight, even
   if it resolves in a couple of seconds.

5. **"Set up" vs. "Use a statement type I already set up" sit at equal visual
   weight next to each other** (`first-timer-01-home-after-csv-drop-1440.png`).
   For a genuine first-timer with zero saved profiles, the second link is
   dead weight — it always would have led nowhere useful on a first run
   — but it competes for attention with the one action that matters. *Fix:*
   suppress "Use a statement type I already set up" entirely when the user
   has zero saved profiles.

## Overall

Both the unrecognized-header CSV and the scanned, unmatched-bank PDF made it
from drop to copied-in-3-clicks with no manual mapping, no jargon, and no
screen that required thinking. This clears the bar the standard sets
("shockingly easy," "just works") for the exact worst-case inputs a
first-timer would plausibly hit. The one real hiccup is defect 1 — a silent
label swap right after the moment of "did it work?" is the kind of thing
that erodes trust even though the underlying data is correct.
