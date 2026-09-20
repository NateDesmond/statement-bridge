# Pass 3 — First-time, non-technical person

Persona 1 of audit/INDIE-STANDARD.md. Real unpacked extension, bundled headless
Chromium only, driven via extension/dev/pass3-firsttimer.mjs (new driver,
committed alongside this report). Two DIFFERENT unknown-bank files from any
earlier pass:

- `waldkonto_unbekannt.csv` — hand-built German-bank export: 6-row preamble
  (bank name, statement number, IBAN, account holder, period, opening
  balance), semicolon-delimited, German headers (`Buchungstag;
  Verwendungszweck; Betrag; Saldo`), EUR amounts in German number format
  (`-45,23`, `-1.234,56`).
- `brookline_ledger_unbekannt.pdf` — `test/fixtures/anchor_columns.pdf`
  rasterised to an image-only PDF via `extension/dev/rasterize-pdf.mjs`
  (served from `python3 -m http.server 8934 --directory extension`) and
  renamed to look like an unfamiliar bank.

Followed only the prompts the app itself offered, all the way to clicking
Copy, for both files. Screenshots: `audit/pass3/first-timer-NN-*-{1440,1280}.png`.

## What I expected vs. what happened

**Onboarding (3 screens).** Expected a quick "here's what this does" tour.
Got exactly that — plain language, no jargon, "Everything happens on this
device" reassurance up front. No hesitation here.

**Home, empty.** Expected a drop zone. Got one, clearly labeled, with "Works
with the CSV or PDF your bank gives you. Nothing leaves your computer."
directly under the button. Confident first impression.

**Dropped the German CSV.** A "New bank statement... Set up" card appeared
immediately — no surprise, expected exactly this.

**Clicked Set up.** Expected either the quick "does this look right?"
confirm screen (the happy path this tool clearly wants me on) or a short
step-by-step. Instead I landed straight on step 2, "Locate data," with a
banner reading "We could not find the dates with this header row." I hadn't
done anything wrong yet and I'm already being told something failed — my
first hesitation. The suggested header row (row 7, "high confidence") was
in fact correct, and the preview table under it looked right (my German
values lined up with my columns), so I clicked Continue.

**Map fields (step 3).** This is where it went wrong in a way I, as a
non-technical user, could not have fixed. "Date format in source" says
`DD/MM/YYYY`, "detected from your file," directly above a red line reading
"This format does not match your file: 6 of 6 dates could not be read." The
dates shown right there in the sample (`15.09.2026`, `14.09.2026`) look
completely normal to me — I don't understand what's wrong or what to change
it to. The dropdown never offered a format that matched (my dates use dots,
`15.09.2026`; the closest option, `DD/MM/YYYY`, implies slashes). Nothing on
this screen told me to pick anything different, and the "Continue: Test"
button was not disabled — so I did what any first-timer does when told to
continue: I continued.

**Test (step 4).** Every one of my 6 rows was red-flagged "Date could not be
read," and a banner said the balance doesn't reconcile. Concerning, but the
"Continue: Save" button still worked, so I kept going, trusting the wizard
to sort it out (it explicitly offers "Save and finish" here — it doesn't
read as a dead end).

**Save (step 5) → Home.** Saved with "no dates parsed" quietly printed above
the statement-name field — I nearly missed it, small gray text under a bold
"6 rows." Back on Home, the card now reads "Most rows have no usable date" /
"Could not read dates" in red, with a "Set up again" button and, below it,
all 6 of my rows individually listed under "6 rows need a quick look," each
with "Looks right" / "Fix." As a first-timer, "Looks right" reads as the
obvious action — the numbers next to it (amount, description) do look
right. I clicked "Looks right" on all 6. Nothing changed: the red "Could not
read dates" banner stayed, the rows-needing-a-look list simply vanished, and
there is still no Copy or Download button anywhere on the page. I am stuck.
There is no path forward for this file that I, following only what the app
showed me, could find. (I confirmed with a targeted script that this is a
real dead end, not a screenshot-timing artifact — see Defect 1 below.)

**Dropped the PDF (image-only, needs OCR).** Expected some kind of "reading
your scan" wait. Got "Reading your scan…" with an indeterminate progress
bar and a Cancel link — reasonable, though there is no page count or time
estimate at the very start (the product's own code shows this is
deliberate: the label is meant to be replaced by "Reading page X of Y ·
~Ns" as soon as the first page finishes — see note under Defect 3). OCR
finished in about 30 seconds for this 2-page scan; the card then read "New
bank statement… Let's set it up, takes about a minute," with a "Set up"
button and a "Use a statement type I already set up" link.

**Clicked Set up (PDF).** This time I got the confirm-first screen I
originally expected for the CSV: "We found 48 transactions from 2026-08-15
to 2026-09-30. Does this look right?" with money-in/money-out totals and a
5-row preview. This is a noticeably better experience than the CSV path —
one screen, one yes/no decision, no jargon. I clicked "Yes, looks right."

**Name this statement.** Pre-filled with "Anchor Bank savings" — a real,
specific-sounding bank name, even though I'd renamed the file to
"brookline_ledger_unbekannt.pdf" to look unfamiliar. That's the tool reading
the statement's own content rather than trusting my filename, which is the
right call and pleasantly surprising, not a defect. I clicked "Save and
finish."

**Home, final.** "Your transactions are ready." 48 transactions, date range
summarized, a live preview table, and two clearly-labeled actions:
"Copy to Google Sheets" (primary, gold) and "Download CSV" (secondary). I
clicked Copy to Google Sheets and got "Copied 48 rows to the clipboard" —
exactly what I expected, no surprises, done.

## Score table (1–5; anything under 4 is a defect)

| Screen | Easy | Works | Depth | Made | Notes |
|---|---|---|---|---|---|
| Onboarding (3 screens) | 5 | 5 | 4 | 5 | Clear, short, reassuring |
| Home, empty | 5 | 5 | 4 | 5 | |
| CSV: Set up → Locate data | 3 | 4 | 4 | 4 | Opens on an error banner before I've done anything |
| CSV: Map fields (date format) | **2** | **1** | 3 | 3 | Wrong format offered, no fix available, error doesn't block Continue |
| CSV: Test | 3 | **2** | 4 | 4 | All-red flags, but still lets me "Save and finish" into a dead end |
| CSV: Save → Home (broken statement) | **2** | **1** | 3 | 3 | Dead end: no Copy/Download ever appears; "Looks right" is a false affordance |
| PDF: dropped, OCR running | 4 | 4 | 3 | 4 | No page count/estimate visible in the first couple seconds |
| PDF: Set up → confirm screen | 5 | 5 | 5 | 5 | Best screen in the flow |
| PDF: Name statement → Save | 5 | 5 | 4 | 5 | Smart bank-name detection despite misleading filename |
| Home, final (Copy) | 5 | 5 | 5 | 5 | Exactly what "just works" should feel like |

## Top 5 defects, ranked, with concrete fixes

1. **German (dot-separated) dates can never be read, and the wizard gives no
   way out.** `extension/src/core/date.js` line 48 (`DD/MM/YYYY`) and line 55
   (`MM/DD/YYYY`) match `[-/]` as the day/month/year separator but not `.`.
   `suggestDateFormat` (src/core/suggest.js) correctly guesses day-first
   (`DD/MM/YYYY`) for `15.09.2026`-style dates, but the regex then rejects
   every single row, and the "Date format in source" dropdown
   (src/ui/wizard.js `DATE_FORMATS`) has no dot-separated option to switch
   to. Result: confirmed by direct test — after Save, the file lands in a
   "Could not read dates" state, and clicking "Looks right" on all 6 flagged
   rows (the only visible affordance) clears the warnings without adding
   real dates, so no Copy/Download control ever appears. **Fix:** add `.` to
   the separator character class in `parseDate`'s `DD/MM/YYYY` and
   `MM/DD/YYYY` branches (and `YYYY-MM-DD`'s, for symmetry) — this one regex
   change unblocks every European bank export that uses dots, which is most
   of them. Root cause, one place, all callers benefit.

2. **A red "this format does not match your file" error doesn't stop
   Continue, and it can't be self-serviced.** On Map fields, the error is
   directly under a dropdown labeled "detected from your file" — visually
   it looks like a passive readout, not an actionable control I should
   change. Continue: Test stays enabled through it. **Fix:** when the
   detected format's own error is showing, disable Continue (or route to a
   dedicated "we can't read your dates, tell us the format" step) instead
   of letting the user click three more times into an unrecoverable save.

3. **"Looks right" on a decision row is a false affordance when the
   underlying value never parsed.** It clears the flag (`resolveConfirm`)
   without fixing `row.date`, so the whole-file "Could not read dates"
   banner and missing Copy button persist with no explanation of why
   clicking the only two visible buttons ("Looks right" on every row) did
   nothing. **Fix:** when a row's date genuinely failed to parse, "Looks
   right" should not be offered (or should be replaced with "Fix" only) —
   a first-timer should never be able to click the "correct" button on
   every row and land in exactly the same broken state.

4. **CSV path starts a first-timer on a failure banner, not the same
   confirm-first screen the PDF path gets.** The PDF flow's "Does this look
   right? Yes / Something's off" is the best screen in this whole audit —
   one decision, plain language, numbers up front. The CSV flow for this
   file skipped straight to the 5-step wizard's "Locate data," opening on
   an error ("We could not find the dates with this header row") before I
   had done anything. Two file types landing on such different first
   impressions (one calm, one alarming) reads as inconsistent care between
   screens. **Fix:** whenever the header-row/date-format guess is workable
   (as it was here — row 7 was right), route CSVs through the same
   confirm-first "does this look right" screen the PDF path uses, saving
   the full stepper for cases that genuinely need it.

5. **OCR gives no page count or time signal for the first couple of
   seconds.** "Reading your scan…" with an indeterminate bar is fine
   briefly, but a first-timer dropping a multi-page scan has no idea if
   it'll take 5 seconds or 5 minutes until the first "Reading page X of Y ·
   ~Ns" update lands. In this run it was under 2 seconds, so mostly
   cosmetic, but on a slower machine or bigger scan this gap is exactly
   where "did this stall?" doubt lives. **Fix:** show total page count (known
   the instant the PDF is opened, before OCR starts) alongside "Reading your
   scan…" so there's never a moment with zero information.

## Screenshot index (selected; full set in audit/pass3/)

- `first-timer-07/08-home-empty-*` — clean empty state
- `first-timer-11/12-csv-wizard-opened-*` — Locate data opens on an error
- `first-timer-15/16-csv-wizard-step-1-*` — Map fields, the date-format bug
- `first-timer-17/18-csv-wizard-step-2-*` — Test, all rows flagged
- `first-timer-25/26-csv-after-copy-no-copy-*` — dead end: no Copy/Download
- `first-timer-27/28-pdf-image-only-card-*` — OCR starts
- `first-timer-33/34-pdf-confirm-a-*` — the confirm-first screen, best in flow
- `first-timer-39/40-pdf-after-copy-*` — "Copied 48 rows to the clipboard"

## Note on method

`extension/dev/pass3-firsttimer.mjs` automates this pass end to end
(onboarding → CSV → PDF → Copy for both, full-page 1440/1280 screenshots at
every step). The dead end in Defect 1 was double-checked with a second,
throwaway script that clicked "Looks right" on every flagged row and polled
`#copy-tsv-btn` for visibility — it never became visible or enabled, ruling
out a screenshot-timing false positive.
