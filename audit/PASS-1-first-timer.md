# Pass 1: first-time, non-technical person

Method: real unpacked extension, bundled headless Chromium (never the user's own
Chrome), driven with Playwright via `extension/dev/p1-stage-*.mjs` (one script per
stage, run synchronously with a hard alarm timeout, screenshots read before writing
any of this). Files used: `test/fixtures/generic_unknown_bank.csv` (a CSV from a
bank with no built-in profile) and `test/fixtures/palisade_columns_image.pdf` (an
image-only PDF, also from a bank with no built-in profile - Palisade isn't one of
the built-ins in `core/builtin-profiles.js`). Full-page screenshots at 1440 and
1280 for every screen, in `audit/pass1/first-timer-NN-*.png`.

I am playing someone who has never used this tool, doesn't know what a "CSV" or
"mapping" is beyond a vague idea, and just wants their bank transactions in a
spreadsheet.

## Walkthrough

### 0. Onboarding (`first-timer-01..06`)
Three short screens: "Your bank statements, in your spreadsheet," a pin-the-icon
instruction, "Three steps, every month" (Drop/Read/Copy), then "Get your first
statement" with a big "Open Statement Bridge" button. Expected: a vague "here's
what this does" screen. Got: exactly that, plus the reassurance "Everything
happens on this device" right up front, which is exactly the thing I'd worry
about handing my bank statement to a browser extension. No hesitation here -
three screens, skimmable in ten seconds, real button to move on.

### 1. Home, empty (`first-timer-07/08`)
"Drop your bank statements here," a gold "Choose files" button, one reassuring
line ("Works with the CSV or PDF your bank gives you. Nothing leaves your
computer.") and "Set it up once for each bank, about a minute. Every month after
that: drop, wait, copy." Expected: an empty state that tells me what to do next.
Got exactly that. No hesitation.

### 2. Drop the CSV -> "New bank statement" card (`first-timer-09/10`)
Dropped `generic_unknown_bank.csv`. It appeared in a file row almost instantly
labelled "New bank statement," and directly below it a card: "New bank statement
- 'generic_unknown_bank.csv'. Let's set it up, takes about a minute," with a gold
"Set up" button and a quieter "Use a statement type I already set up" link.
Expected: some kind of "we don't recognize this" message. Got a friendlier
version of that with a clear next action. No hesitation - "Set up" is obviously
the button for a first-ever file.

### 3. Click "Set up" -> confirm screen (`first-timer-13/14`)
This is a "confirm-first" screen, not the 5-step wizard: "We found 5
transactions. Does this look right?" with Money in / Money out totals
(3,015.00 / -145.00) and a DATE / DESCRIPTION / AMOUNT table.

**This is where I stalled as a first-timer.** The DATE and DESCRIPTION columns
are completely blank - only AMOUNT has numbers in it (-4.50, -52.30, 3,000.00,
-88.20, 15.00). As someone who doesn't know what a column mapping is, I read
"Does this look right?" as "is the data right," not "check that the layout
guess is right" - and a table that's 2/3 empty doesn't obviously look "right,"
but there's no explanation of what's missing or why, and the big gold button
says "Yes, looks right" while a small "Something's off" sits right below it as
the only other option. Nothing on this screen tells me the blank columns ARE
the "something off." I'd genuinely hover here uncertain whether blank
date/description is normal for a first read, or an error I should flag - and
picking wrong has no visible cost signalled on this screen.

I clicked "Yes, looks right" (my honest best guess as someone who doesn't know
better and trusts the tool's own confidence).

### 4. Name it (`first-timer-15/16`) -> Save
"Name this statement," pre-filled "Statement savings, CSV," one gold "Save and
finish" button. No hesitation - this screen is unambiguous.

### 5. After save (`first-timer-17/18`) - the payoff of step 3's ambiguity
The file row now reads "Most rows have no usable date" in red, and a card below
it: **"Could not read dates" - "'generic_unknown_bank.csv' has no usable date
(or amount) for most rows. Its saved mapping likely no longer matches this
file's columns."** Below that, "5 rows need a quick look," each row showing the
correct data it actually extracted (e.g. "15/09/2026 Coffee Shop Purchase
-4.50") next to "Date could not be read" and a "Fix" button.

This is the actual defect: the source CSV's dates ARE clean, unambiguous
DD/MM/YYYY values (`test/fixtures/generic_unknown_bank.csv`: "15/09/2026,Coffee
Shop Purchase,-4.50"), and the row list at the bottom clearly displays the date
correctly parsed and readable to a human. The tool extracted the date fine
internally (it's shown in the row label) but flags every single row as having
"no usable date," and blames it with confusing, technical wording ("saved
mapping likely no longer matches this file's columns" - I never saved a mapping
myself, I did what the confirm screen told me to). As a first-time user, I
would now believe the tool is broken, or that I did something wrong at step 3
- when actually step 3 already showed me the blank columns that predicted
this exact failure, just without ever telling me so.

## Second file: unknown-bank image PDF (needs on-device reading)

### 6. Drop the PDF -> "Reading with text recognition..." (`first-timer-19`)
Dropped `palisade_columns_image.pdf` (alongside the still-broken CSV row from
before). It started reading immediately with no extra click needed ("Reading
with text recognition...") and a thin progress bar. Expected: some kind of
"this will take a moment" state for a scanned document. Got that, no
hesitation up front - though there is no percentage or time estimate, and OCR
on this two-page fixture took roughly two minutes end to end. Watching an
unlabelled progress bar crawl for two minutes with only "Reading with text
recognition..." (no page count until partway through) is exactly the kind of
wait a non-technical person starts to distrust - is it stuck, or working?

### 7. OCR finishes -> "New bank statement" card (`first-timer-20`)
Once done, the row calmly changes to "New bank statement" (matching the CSV's
earlier wording) with the same "Set up" / "Use a statement type I already set
up" card underneath. Consistent with step 2 above - good, this reuses a
pattern I already learned.

### 8. Click "Set up" -> wizard "Basics" step (`first-timer-21`, `-22`)
**This is where a first-timer's journey ends.** Unlike the CSV, which went
straight into the friendly "Does this look right?" confirm screen, the PDF
drops me into the full 5-step numbered wizard (Basics / Locate data / Map
fields / Test / Save) - a much more technical-feeling screen right out of the
gate, with no explanation of why this file gets a different, longer process
than the last one. Worse: **Bank and Country are both blank, with no
"Suggested from your file" caption at all**, even though the file was just
read end to end by on-device OCR. The CSV path did the same auto-suggest
dance; here it's just empty inputs and a currency defaulted to "SGD" that may
not even be right for this bank. As a first-timer, this already reads as "the
computer read my document, then forgot everything it read."

I typed nothing (mirroring someone who doesn't know their own bank's
system-internal name, or that they need to type it there) and clicked "Next."

**Nothing happened.** I clicked it four more times (`first-timer-23` through
`-26`, `-27` final) - screen, stepper, and fields are pixel-identical every
time. No error text, no red outline on the Bank field, no shake, no toast, no
change to the "1 Basics" stepper dot. Reading the source confirms this isn't
a rendering glitch: `src/ui/wizard.js`'s `goNext()` is
`if (!stepValid(state.step)) return;` - step 0 requires a non-empty Bank AND
currency (`stepValid`, line 296), and when it isn't valid the button click is
simply swallowed. There's a `stepValidationMessage`-shaped helper earlier in
the file that builds a "Bank is required" sentence, but nothing in `goNext()`
ever displays it here. A real first-timer, staring at a screen that doesn't
tell them anything is wrong, would very reasonably conclude the extension is
broken and give up on this file entirely.

There's also a stray empty white bar with a small unstyled gold square in its
bottom-right corner sitting below the Basics card on every one of these
screenshots (visible in all of `first-timer-21` through `-27`) - looks like an
incompletely-rendered component, not a deliberate design element.

### 9. End state: back to Home (`first-timer-28`)
Backed out of the stuck wizard and looked at where a first-timer is left,
having spent maybe ten real minutes on their first two statements: the CSV row
still reads "Most rows have no usable date" in red with 5 rows sitting in a
"need a quick look" tray, and the PDF row still reads "New bank statement,"
never actually set up. **There is no Copy/export panel anywhere on this
screen** - the top stepper still proudly shows "3 Copy" as a stage, but
nothing on the page gets me there, because neither file ever reached a usable
state. The tool's entire promise - "drop, wait, copy" - was not delivered for
either file I brought it, on the two most basic categories of statement
(unknown-bank CSV, unknown-bank PDF) the onboarding screen explicitly said it
supports.

## Score table (1-5 per axis; below 4 = defect)

| # | Screen | Easy | Works | Depth | Made |
|---|---|---|---|---|---|
| 0 | Onboarding (3 screens) | 5 | 5 | 4 | 5 |
| 1 | Home, empty | 5 | 5 | 4 | 5 |
| 2 | CSV dropped -> "New bank statement" card | 5 | 5 | 4 | 5 |
| 3 | CSV confirm-A ("Does this look right?") | **2** | **2** | 3 | 4 |
| 4 | CSV "Name this statement" | 5 | 5 | 4 | 5 |
| 5 | CSV after save ("Could not read dates") | **2** | **1** | 3 | **3** |
| 6 | PDF dropped, OCR reading | 4 | 4 | **3** | 4 |
| 7 | PDF OCR done -> "New bank statement" card | 5 | 5 | 4 | 5 |
| 8 | PDF wizard "Basics" (stuck) | **1** | **1** | 2 | **3** |
| 9 | Home end state (no copy reachable) | **2** | **1** | 3 | 3 |

## Ranked defects

1. **Wizard "Next" silently no-ops with an empty required field, no error shown at all** (`src/ui/wizard.js` `goNext()`/`stepValid`, screens `first-timer-21` to `-27`). Fix: when `stepValid(0)` fails, show the existing `stepValidationMessage` text near the Bank field (and focus/outline it) instead of swallowing the click - this is the single defect that fully blocks a first-time PDF user.
2. **Confirm-first screen ("Does this look right?") shows a table with Date/Description blank and no warning, then commits on "Yes, looks right"** (screens `first-timer-13/14`, CSV). Fix: don't offer "Yes, looks right" as the primary/only-obvious action when required columns are empty or unmapped - route straight to "Something's off" or surface the gap inline before the user can confirm.
3. **Post-save "Could not read dates" contradicts the row list directly below it, which shows the dates correctly** (screens `first-timer-17/18`). Fix: word the message from what the tool can see ("we mapped this file to a description-only layout - want to fix the date column?") not "no usable date," and drop "saved mapping likely no longer matches this file's columns" (user never saved anything themselves).
4. **PDF setup silently skips the friendly confirm-first flow the CSV path uses, dropping straight into the technical 5-step wizard with zero explanation of why, and none of Bank/Country auto-suggested despite OCR having just read the whole document** (screens `first-timer-21/22`). Fix: run the same auto-suggest that the CSV path runs against the OCR'd text, and either extend confirm-first to PDFs or tell the user up front why this file needs "the long way."
5. **A first-time user who follows every prompt on both their files never reaches the tool's one promised outcome (copy to spreadsheet)** (screen `first-timer-28`). Not a single-screen bug but the sum of 1-4: the "3 Copy" step stays visibly unreachable the entire session. Fix: this resolves once 1-4 are fixed, but is worth tracking as the actual product-level acceptance bar (did a first-timer get their data copied?).

Minor: a stray unstyled white bar with a gold square renders below the wizard's Basics card on every wizard screenshot (`first-timer-21` to `-27`) - looks like a broken/incomplete component, not intentional layout.

## Screenshot index
`audit/pass1/first-timer-01` through `-06`: onboarding. `-07/08`: Home empty.
`-09` through `-18`: unknown-bank CSV (drop through broken post-save state), at
1440+1280. `-19` through `-28`: unknown-bank image PDF through the stuck
wizard and the final Home state, 1440 only (per instruction, to keep each
stage script short-running).
