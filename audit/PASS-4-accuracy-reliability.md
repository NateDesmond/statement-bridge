# PASS 4 - Accuracy and reliability (2026-09-29)

Report only. No product code was changed. Every scenario below was run against
the REAL unpacked extension in the bundled Playwright Chromium (never the
user's Chrome), or against the real core modules in Node, one script at a time.
Temporary harnesses were written under `dev/tmp-p4-*.mjs` and deleted after the
run; the two password fixtures that `dev/e2e-password.mjs` regenerates on every
run were restored with `git checkout`.

Baseline: `node --test test/*.test.js` - **601 pass, 0 fail** (1.3 s).

Every finding is marked OBSERVED (I saw it happen and quote the evidence) or
INFERRED (read from the source, not reproduced end to end).

---

## Lens 1 - ACCURACY (does the output equal the statement?)

### 1a. Text PDFs with truth files (Node, real auto-detect path via `dev/auto-version.mjs`)

Matching is exact on (ISO date, signed minor amount); descriptions compared verbatim.

| fixture | model | truth | extracted | date OK | amount OK | sign errors | desc exact | extras |
|---|---|---|---|---|---|---|---|---|
| summit_grouped_2line | grouped | 37 | 37 | 37 | 37 | 0 | 37 | 0 |
| riverside_columns | columns | 46 | 46 | 46 | 46 | 0 | **43** | 0 |
| anchor_columns | columns | 48 | 48 | 48 | 48 | 0 | 48 | 0 |
| palisade_columns | columns | 45 | 45 | 45 | 45 | 0 | 45 | 0 |
| worstcase_grouped_3line | grouped | 32 | 32 | 32 | 32 | 0 | **0** | 0 |
| northwind_transaction_history_3p | grouped | 7 | 7 | 7 | 7 | 0 | 7 | 0 |

Dates and amounts: **215 / 215 correct**. Descriptions: **32 rows destroyed, 3
rows split mid-word** (see D1 and D6 below).

### 1b. Image PDFs through OCR (`dev/ocr-recall-audit.mjs`, bundled Chromium)

| fixture | truth | extracted | matched (date+amount) | misses | extras | desc agree |
|---|---|---|---|---|---|---|
| summit_grouped_2line_image | 37 | 37 | 37 | 0 | 0 | 37/37 (100%) |
| riverside_columns_image | 46 | 46 | **38** | 8 | 8 | 38/38 |
| anchor_columns_image | 48 | 48 | 48 | 0 | 0 | 48/48 |
| palisade_columns_image | 45 | 45 | 45 | 0 | 0 | 45/45 |
| worstcase_grouped_3line_image | 32 | 32 | 32 | 0 | 0 | **16/32 (50%)** |

`riverside_columns_image.pdf` driven end to end through the real UI (Copy for
Sheets output diffed against `riverside_columns.truth.json`) gives the exact
breakdown:

```
{ dateBad: 0, signBad: 0, amtBad: 3, missing: 5, descBad: 4, curBad: 3 }
```

- 3 silently wrong amounts: `-788.81 -> -88.81`, `-540.18 -> -240.18`, `-686.44 -> -806.44`
- 5 rows exported with an empty Amount cell (these ARE flagged: "Amount missing")
- 3 rows exported with a wrong Currency: `LTD`, `CIT`, `LTD` (description words that fell into the currency column)
- Home badge: "Needs a quick look", `warnCount=5`. The 3 wrong amounts and the 3 wrong currencies are not among the 5.

### 1c. CSV / XLSX fixtures through the real confirm-first UI

Ground truth read by hand from each fixture file.

| fixture | truth rows | extracted | dates | signs | amounts | descriptions | currency | notes |
|---|---|---|---|---|---|---|---|---|
| meridian_savings.csv | 5 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | SGD | `Total,253.55,5200.00,` footer correctly suppressed |
| meridian_savings.xlsx | 2 | 2 | 2/2 | 2/2 | 2/2 | 2/2 | SGD | |
| meridian_savings_real_export.csv | 5 | **0** | - | - | - | - | - | **never reaches confirm-first** (D2) |
| harbour_card_crdr.csv | 4 | 4 | 4/4 | 4/4 (CR/DR) | 4/4 | 4/4 | SGD | 3 trailer lines suppressed |
| lattice_card_tabbed.csv | 6 | 6 | 6/6 | 6/6 | 6/6 | 6/6 | SGD | tabs + blank rows + `SGD 12.50 DR` cells all handled; FX row's Original amount sign is wrong (D7) |
| anchor_checking.csv | 4 | 4 | **1/4** | 4/4 | 4/4 | **0/4** | SGD | **D3 + D4** |
| generic_unknown_bank.csv | 5 | 5 | 5/5 | 5/5 | 5/5 | 5/5 | SGD | |
| waldkonto_unbekannt.csv | 6 | 6 | 6/6 | 6/6 | 6/6 | 6/6 | EUR | `;` delimiter, `15.09.2026`, `1.234,56`, `-1234.56` all correct |
| utf16_sample.csv | 2 | 2 | 2/2 | 2/2 | 2/2 | 2/2 (`Café` intact) | SGD | |
| win1252_sample.csv | 1 | 1 | 1/1 | 1/1 | 1/1 | 1/1 (`Café` intact) | SGD | |

Encodings, decimal/thousand separators and delimiter sniffing are solid.
Sign conventions (CR/DR suffix, debit/credit pairs, plain signed, EU signed) are
all correct on every fixture that reached the pipeline.

**Date ambiguity when day<=12 on every row** (synthetic `amb_days.csv`:
`03/04`, `05/06`, `07/08`, `09/10`, `11/12`): the tool silently picks day-first,
produces dates spanning **3 Apr 2026 to 11 Dec 2026** from a 5-row statement,
and prints "Every transaction on the page is accounted for." No warning, no
date-format screen. See D5.

### 1d. Private real files (counts only, no contents)

| file | rows | warnings | span | blank dates | blank amounts | currencies |
|---|---|---|---|---|---|---|
| sc_all.csv | 310 | 2 | 2026-06-18 to 2026-09-16 | 0 | 0 | 1 |
| dbs_3mo.csv | **0 (never mapped)** | - | - | - | - | - |
| aug_2026_dbs.pdf (image, OCR) | 31 | 0 | 2026-09-01 to 2026-09-15 | 0 | 0 | SGD |
| l6mo_dbs.pdf (image, 15 pages, OCR) | 205 | **28** | 2026-06-02 to 2026-09-15 | 0 | 0 | SGD |

Cross-check: `dbs_3mo.csv` has exactly **205 data rows** and `l6mo_dbs.pdf`
OCR extracted exactly **205 rows** over the same window. Row-count recall on a
real 15-page scanned statement is 205/205; 28 of those 205 (13.7%) carry a
warning the user must resolve by hand.

**Overlap dedupe on real files**: dropping `l6mo_dbs.pdf` then
`aug_2026_dbs.pdf` gives `"31 of 31 rows merged into l6mo_dbs.pdf"`, notice line
`"31 rows merged from overlapping files. Undo"`, export stays at **205 rows**,
summary reads `"205 transactions from 2 statements"`. Correct, and matched
across two independent OCR passes.

`dbs_3mo.csv` never produces rows at all - see D2, the worst defect in this pass.

### 1e. Synthetic corpus (`node dev/corpus-audit.mjs`, n=1000, seed 3)

`recall 94.80%, extras 5.06%, truth rows 10660` against a 99% floor / 0.5%
ceiling. Worst buckets:

| bucket | recall | extras | cause |
|---|---|---|---|
| `pdf-columns` | 76.4% | 23.55% | KNOWN-GAPS #3 (amount+balance vs debit+credit, no header) |
| `positiveIsOut` | 0.0% | 100.00% | KNOWN-GAPS #2 (excluded from the headline number) |
| `tsv` | 96.8% | 2.49% | |
| lang `it` / `ja` / `ms` | 90.8 / 92.3 / 92.4% | ~7.7% | |
| `MM/DD/YYYY` / `DD/MM/YYYY` | 92.8 / 93.7% | ~7% | KNOWN-GAPS #4 (day<=12) |
| `jpy` number format | 93.8% | 5.56% | |

Every bucket matches KNOWN-GAPS.md; no new regression appeared.

### 1f. Export correctness (`src/core/export.js`, Node + UI diff)

For every fixture above, Copy-for-Sheets TSV, the downloaded CSV and the
on-screen preview carry **the same rows, in the same order, with the same
column list**. Escaping verified directly:

```
TSV:  2026-01-02  A  "Tab<TAB>here"  0.00  SGD
      2026-01-02  A  "Quote ""Q"" inside"  1.00  SGD
      2026-01-02  A  "Line1\nLine2"  -1.00  SGD
CSV:  ...,Tab<TAB>here,...      (tab is not special in CSV - correct)
      ...,"Quote ""Q"" inside",...
      ...,"CR, comma",...
```

- Negative zero: `formatMinor(-0,'SGD') -> "0.00"`, `fieldValue({amount:-0},'amount') -> "0.00"`. No `-0.00`. OK.
- Zero-decimal currencies: `formatMinor(100,'JPY') -> "100"`, `-100 -> "-100"`. OK.
- No-decimal source amounts (palisade fixture): 45/45 correct.
- Large amounts: `1000000.00`, no thousands separators in the export. OK.
- `balance` column is dropped when no row carries one (`visibleColumns`). OK.

Two notes, neither a data defect:
- The on-screen preview deliberately reformats numbers (`+5,000.00` on screen vs `5000.00` in the TSV, `preset-editor.js` `NUMERIC_PREVIEW_FIELDS` / `groupPlainNumber`). Documented as display-only. The comment above `renderResultTable()` in `home.js` says "the exact rows/columns Copy for Sheets would produce" - true for rows and columns, not for the cell text.
- `CURRENCY_DECIMALS` (`src/core/amount.js:3`) has the 0-decimal currencies but no 3-decimal ones (BHD, KWD, OMR, JOD, TND): `formatMinor(123,'BHD') -> "1.23"` instead of `0.123`. INFERRED impact only; no fixture uses them.

### Accuracy table

| # | scenario | observed | expected | sev |
|---|---|---|---|---|
| A1 | `worstcase_grouped_3line.pdf` + `_image.pdf` descriptions | 16/32 descriptions are literally `Amount:`; the other 16 end in ` Amount:`; 11 rows carry another transaction's merchant in `Type`; 3 carry `Balance as of page 1: SGD 9500.00 Page 1 of 3`. Badge: `Done, 32 transactions`, `warnCount=0`, note: "Every transaction on the page is accounted for." | descriptions equal the statement, or a warning | **P0** |
| A2 | `riverside_columns_image.pdf` amounts | 3 of 46 amounts silently wrong (`-540.18`->`-240.18`, `-686.44`->`-806.44`, `-788.81`->`-88.81`); not among the 5 flagged rows | wrong OCR digits flagged, or right | **P0** |
| A3 | `riverside_columns_image.pdf` currency | 3 of 46 rows export Currency `LTD` / `CIT` / `LTD` | `SGD`, or flagged | **P0** |
| A4 | `anchor_checking.csv` dates | `06/02`, `06/05`, `06/12` read as 2 Jun/5 May/12 Dec -> `2026-02-06`, `2026-05-06`, `2026-12-06`; `06/20/2026` unreadable -> blank date, exported blank | `2026-06-02`, `2026-06-05`, `2026-06-12`, `2026-06-20` | **P0** |
| A5 | `anchor_checking.csv` descriptions | every row's Description is `DEBIT` or `CREDIT` (the `Details` column) instead of `WHOLEFDS RIV 12345 SEATTLE WA` etc. | the `Description` column | **P1** |
| A6 | `amb_days.csv` (day<=12 on every row) | silently day-first; 5-row statement spans 3 Apr - 11 Dec 2026; "Every transaction on the page is accounted for." | ask which format, or warn | **P1** |
| A7 | `dbs_3mo.csv` / `meridian_savings_real_export.csv` | 0 rows; "We could not read this file automatically." | 205 / 5 rows via confirm-first | **P1** |
| A8 | `riverside_columns.pdf` (text) descriptions | 3/46 read `GREAT WORLD CIT Y SINGAPORE` | `GREAT WORLD CITY SINGAPORE` | P2 |
| A9 | `lattice_card_tabbed.csv` FX row | Amount `-86.20`, Original amount `+65.00` for the same outgoing transaction | both negative | P2 |
| A10 | statement-type detection | `LATTICE PLATINUM CARD` -> "Lattice savings"; Northwind/Riverside current accounts -> "credit card" | matching type | P2 |
| A11 | `anchor_checking.csv` row 4 export | row with a blank Date copied into Sheets | block or mark it | P2 |
| A12 | `waldkonto_unbekannt.csv` all-clear note | neither the all-clear line nor any warning (balances do not reconcile) - silence | say something either way | P2 |
| A13 | preview vs export number text | `+5,000.00` on screen, `5000.00` in TSV/CSV | intentional, but the `home.js` comment overclaims | P2 |
| A14 | 3-decimal currencies | `formatMinor(123,'BHD') -> "1.23"` | `"0.123"` (INFERRED) | P2 |

---

## Lens 2 - RELIABILITY (does it never dead-end?)

| # | scenario | observed | expected | sev |
|---|---|---|---|---|
| R1 | empty (0-byte) CSV | badge "No transactions found"; card: `This file has no transactions` / `"empty.csv" has no rows to import.` / `Remove`. No console errors, no stack in the UI. | this | OK |
| R2 | header-only CSV | identical to R1 | this | OK |
| R3 | `.txt` renamed `.csv` (prose) | identical to R1 | a hint that it is not a statement would be kinder | P2 |
| R4 | 40 MB CSV (752,317 rows) | badge `File exceeds 25 MB limit` in **2.0 s**, no freeze, no console errors | this, plus what to do next | P2 |
| R5 | PDF with no text and no images | OCR ran (0 items, 0.9 s), then the file is offered as `New bank statement` / `"blank.pdf". Let's set it up, takes about a minute.` Clicking Set up opens the full 5-step wizard on Basics: `We could not read this file automatically. A few quick questions will get it set up.` The file can never yield a row. | say the PDF has no readable content and offer Remove | P2 |
| R6 | corrupt PDF (fixture truncated to 4 KB) | badge `This file could not be read.` + a per-row `Copy debug log` button. Log holds `[home.parse] Invalid PDF structure. {"file":"corrupt.pdf"}`. No stack in the UI, no console error. | this | OK |
| R7 | password PDF, wrong then right password | `dev/e2e-password.mjs`: wrong password keeps the prompt with a message; right password clears it and the file continues exactly like an unprotected PDF; image-only variant falls through to OCR; Cancel removes the row cleanly; **the password never appears in the debug log** (checked both strings). **2 FAILs**: "a 'remember a hint' offer appeared after a clean unlock" and "remembered hint shown on the next drop of the same statement type". | all PASS | P2 |
| R8 | 6 files at once incl. 2 image PDFs | rows appear progressively; OCR queues: `Reading page 1 of 3` on one, `Waiting for text recognition (2nd in queue)` on the other, then the second starts. Progress strip `1 Drop / 2 Read / 3 Copy` stays up. No console errors. All six settle. Copy is never wrongly enabled (export panel stays hidden with no mapped rows). | this | OK |
| R8b | 6 files at once, follow-up | six separate `Set up` cards, six separate wizard trips | some batching, or at least "set up 6 statements" | P2 |
| R9 | cancel mid-OCR | row becomes `Reading cancelled` / `Read again`; log `[home.ocr] Text recognition cancelled`; the queued file starts | this | OK |
| R9b | remove mid-OCR | row disappears; `Removed worstcase_grouped_3line_image.pdf. Undo`; the queued file immediately advances to `Reading page 1 of 2` and finishes normally 40 s later. No orphaned worker, no console error, no page error. | this | OK |
| R10 | reload mid-session | `Restore your last statements? / Restore / Start fresh`. Restore brings back file rows, row counts, profile names, the preview table and the export panel **identically**. `chrome.storage.local` keeps `profiles`. | this | OK |
| R10b | reload mid-session, detail | before reload the unmapped file's card offered `Set up` **and** `Use Meridian Bank savings`; after restore only `Set up` remains | keep the one-click suggestion | P2 |
| R11 | storage meter | with an empty session it read `Statements, files and extracted rows 0.5 MB`; after loading a 3-page image PDF + a CSV and mapping both (42 rows) it read **0.1 MB** - it went DOWN. After writing **60 MB** into `chrome.storage.local`, `Total` stayed at `0.2 MB`. | a number that tracks what is stored | P2 |
| R11b | Clear statements | works: Home returns to the empty state, toast `All statements removed. Statement types kept.`, meter sessions -> `0.0 MB`. Guarded by a native `window.confirm()` (`home.js:2894`, `settings.js:132`) - the only native dialogs in the app. | this, minus the native dialog | P2 |
| R12a | same file dropped twice | `Dropped again, already here.` on the existing row, no second row | this | OK |
| R12b | overlapping months, two files | `2 of 3 rows merged into overlap_a.csv`; notice `2 rows merged from overlapping files. Undo`; export = 4 unique rows | this | OK |
| R12c | same amount + description on three different dates | all 3 exported, nothing flagged | exactly this | OK |
| R13 | **date-format focus screen** | `riverside_columns_image.pdf` opens `We need one detail: which date format does this file use?` with `DD MMM` pre-selected (`Detected from your file`) reading **0 of 46 dates**. Clicking `Done` does nothing - three clicks in a row, `{focus:true, a:false, sel:"DD MMM"}` before and after each. No message, no toast, no disabled state. Changing the select to `DD MMM YYYY` makes `Done` work instantly. | say why Done is blocked | **P1** |
| R13b | the focus screen's own advice | `This format does not match your file: 46 of 46 dates could not be read. Try day.month.year` - the file is `27 Jul 2026`, i.e. `DD MMM YYYY`; `day.month.year` is the wrong suggestion | suggest a format that parses | P2 |
| R14 | debug log | Settings has `Copy debug log`, `Download log`, `Clear log`, `Report a problem`. Copy returns a real log (version, timestamp, user agent, per-stage entries). Failing rows get their own `Copy debug log` button. No stack trace is ever rendered in the UI in any scenario above. | this | OK |
| R15 | console / CSP | **zero** console errors and **zero** page errors across every scenario in this pass. CSP in `manifest.json` is `connect-src 'none'` and no violation fired. | this | OK |

---

## Ranked defects

### D1 (P0) - Grouped PDF: a field label is swallowed into the description, and the next transaction's merchant is eaten

**File**: `src/core/pdf.js`, `extractGroupedRows()`, the `const inline = text.slice(0, amt.index).trim();` line (~838) and the `claimTrailing = trailingTypeLine === null ? !!inline : trailingTypeLine;` line right after it.

OBSERVED on both `worstcase_grouped_3line.pdf` (Node, text layer) and
`worstcase_grouped_3line_image.pdf` (real UI, OCR). Source lines are:

```
"21 Aug 2026"
"MACRITCHIE RESERVOIR CAFE"
"Ref: SB700003"
"Amount: SGD -14.92"
"INTEREST CREDIT SAVINGS"
"Ref: SB700004"
"Amount: SGD -215.59"
```

`matchAmountLine` matches at `SGD -14.92`, so `inline` becomes the literal
label `"Amount:"`, which is appended to the description. Because `inline` is
truthy, `claimTrailing` flips to `true`, so the NEXT line
(`INTEREST CREDIT SAVINGS` - a different transaction's merchant) is consumed as
the previous row's `type` and never reaches its own row, whose description is
then just `"Amount:"`.

Exported TSV from the real extension (badge `Done, 32 transactions`, `warnCount=0`):

```
2026-08-21  MACRITCHIE RESERVOIR CAFE Amount:  -14.92  SGD  INTEREST CREDIT SAVINGS
2026-08-21  Amount:                            -215.59 SGD
2026-08-26  Amount:                            -186.73 SGD  Balance as of page 1: SGD 9500.00 Page 1 of 3
```

**Fix**: treat a leading fragment that is only a field label as noise.
In `extractGroupedRows`, after computing `inline`, drop it when it matches a
label shape (`/^[\p{L} ]{0,24}:$/u`) - and, critically, compute `claimTrailing`
from the *cleaned* fragment, not the raw one, so the block is not wrongly
considered complete. Two lines. `test/pdf.test.js` and
`test/ocr-generalisation.test.js` assert only date+amount, which is why this has
been invisible; add a description assertion to
`test/ocr-generalisation.test.js`'s `measure()` (it already reads
`truth.description`).

### D2 (P0/P1) - `suggestFooterRows` marks every data row as a footer on any wide-header statement

**File**: `src/core/suggest.js:398` `suggestFooterRows()`, consumed by
`src/ui/wizard.js` `recomputeCsvSuggestions()`
(`for (const idx of suggestFooterRows(entry.grid, hRow)) state.footerSkip.add(idx);`).

OBSERVED:

```
dbs_3mo.csv                      headerWidth 12  dataRows 205  footerRowsFlagged 205
meridian_savings_real_export.csv headerWidth 12  dataRows   5  footerRowsFlagged   5
```

`looksLikeFooter` returns true when `filled <= headerWidth - 2`. A 12-column
bank export where a real row fills 5-6 cells (Transaction Date, Description,
Status, Currency, one of Debit/Credit) trips this on **every** row, and the
bottom-up scan never finds a row to stop at, so it consumes the whole table.

Consequence in the real UI (OBSERVED, both files): `parseForPreview()` returns
0 rows, `enterConfirmOrWizard()` falls to its third branch, and the user lands
on the 5-step wizard reading `"We could not read this file automatically. A few
quick questions will get it set up."` - for a file whose mapping is in fact
perfect (`date`/`debit`/`credit`/`currency` all confidence 1.0,
`description_raw` 0.92, `dateFormat` `DD MMM YYYY`, 205 live rows with
`dateFill 1.00`, `amountFill 1.00` when the same suggestions are run directly
through `normalizeRecords`).

Worse than the friction: those 205 pre-ticked footer checkboxes carry into the
saved profile, so a user who walks the wizard without noticing them exports
**zero rows** from a 205-row statement. That is silent data loss, hence P0
potential.

**Fix**: a footer block is never the whole table. In `suggestFooterRows`, stop
the scan once it has collected more than a handful of rows - e.g. bail out and
return `[]` if `skip.length > 5 || skip.length > (grid.length - headerRowIdx - 1) * 0.2`.
One guard at the end of the function. Better still, compare `filled` against the
*median* filled count of the data rows rather than against `headerWidth`.

Add `meridian_savings_real_export.csv` to a `suggest.test.js` case asserting
`suggestFooterRows(...).length === 0` - it reproduces without the private file.

### D3 (P0) - `suggestDateFormat` is fed column 0 instead of the mapped date column

**File**: `src/ui/wizard.js:844`, `recomputeCsvSuggestions()`:

```js
state.dateFormat = suggestDateFormat(sampleRows.map((r) => r[0])) || state.dateFormat;
```

OBSERVED on `anchor_checking.csv`, whose header is
`Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #`. Column 0
holds `DEBIT`/`CREDIT`, so:

```
suggestDateFormat(col0) -> null          (falls back to the day-first default)
suggestDateFormat(col1) -> 'MM/DD/YYYY'  (correct)
```

Result in the real extension: `06/02/2026 -> 2026-02-06`, `06/05 -> 2026-05-06`,
`06/12 -> 2026-12-06` (three silently transposed dates) and `06/20/2026` fails
to parse, so row 4 is exported with an **empty Date cell**. The confirm screen
headline read `We found 4 transactions from 2026-02-06 to 2026-12-06.`

**Fix**: sample the column the mapping actually picked for `date`:

```js
const dateCol = state.mapping.findIndex((m) => m.field === 'date');
state.dateFormat = suggestDateFormat(sampleRows.map((r) => r[dateCol >= 0 ? dateCol : 0])) || state.dateFormat;
```

The mapping is already computed a few lines above, so this is a one-line change.
Additionally, `suggestDateFormat` should reject a candidate format that fails to
parse any sample (`06/20/2026` is unparseable as day-first, which alone
disambiguates this file).

### D4 (P1) - `suggestMapping` ties on `description_raw` and takes the leftmost column

**File**: `src/core/suggest.js`, `suggestMapping()`, the
`if (!best || confidence > best.confidence)` comparison.

OBSERVED: `Details` and `Description` both score `headerScore 1`, both get the
flat `shapeScore 0.8` for non-date/amount fields, so both land on
`confidence 0.92`. The strict `>` keeps the first one in header order, and
`Details` is column 0:

```
{ "field": "description_raw", "source": "Details", "confidence": 0.92 }
```

Every exported description on `anchor_checking.csv` is `DEBIT` or `CREDIT`.

**Fix**: break `description_raw` ties on data shape, the same way the
`SGD Amount` vs `Foreign Currency Amount` fix already documented in this
function does. The cheapest signal that works here: prefer the column with more
distinct sample values (`Details` has 2 across 4 rows, `Description` has 4);
average value length works too. Alternatively rank `HEADER_DICTIONARY` terms so
an exact `description` beats the synonym `details`.

### D5 (P1) - Date-format focus screen is a dead end: `Done` silently does nothing

**File**: `src/ui/wizard.js`, `closeConfirmFocus()` (ends with `renderConfirmA()`)
and `renderConfirmA()`'s branch at ~line 658:

```js
if (dateFill < 0.5 && amountFill >= 0.5 && rawDateFill >= 0.5) {
  openConfirmFocus('dates', 'We need one detail: which date format does this file use?');
  return;
}
```

OBSERVED on `riverside_columns_image.pdf`: `#w-dateformat` opens on `DD MMM`
(labelled `Detected from your file`) which reads 0 of 46 dates. Clicking
`#confirm-focus-done` runs `closeConfirmFocus()` -> `renderConfirmA()` ->
`dateFill` is still 0 -> `openConfirmFocus('dates', ...)` re-opens the identical
screen. Three consecutive clicks, identical state each time, no message:

```
DONE-CLICK 0 {"before":{"focus":true,"a":false,"sel":"DD MMM"},"after":{"focus":true,"a":false,"sel":"DD MMM"}}
DONE-CLICK 1 {...identical...}
DONE-CLICK 2 {...identical...}
```

Selecting `DD MMM YYYY` makes `Done` advance immediately (`46 transactions from
2026-07-27 to 2026-09-15`).

**Fix**: in `renderConfirmA`, when the dates branch fires and
`state._confirmFocusKind === 'dates'` already, do not silently re-open - show a
blocking line next to `Done` ("This format still reads none of your dates - pick
one whose example below shows a real date") or disable `#confirm-focus-done`
while the picker's own live example reads `not read`. The mismatch text is
already computed and rendered right above the button.

Related (P2): the mismatch line advises `Try day.month.year` for a
`27 Jul 2026` file. The suggestion should come from re-running
`suggestDateFormat` over the raw date samples and naming the winner, not from a
fixed fallback.

### D6 (P0) - OCR digit misreads reach the export with no flag

**Files**: `src/core/pdf.js` (`extractRows`, column assignment),
`src/core/ocr.js` (per-token confidence), `src/core/checks.js` (warnings).

OBSERVED on `riverside_columns_image.pdf` through the real UI. The tool already
tracks per-token OCR confidence (`ocrConfidence.min 22.3` for this fixture) and
already flags the 5 rows whose amount went missing, but three rows whose digits
were misread into a *plausible* number pass through clean:

```
truth -540.18  ->  exported -240.18   (2026-08-31 TELCO BILL PAYMENT STARHUB SINGAPORE)
truth -686.44  ->  exported -806.44   (2026-09-10 TELCO BILL PAYMENT STARHUB SINGAPORE)
truth -788.81  ->  exported  -88.81   (2026-08-13 SALARY GIRO CREDIT ...)
```

and three rows export a Currency token lifted out of the description
(`LTD`, `CIT`, `LTD`).

**Fix, two cheap guards**:
1. `normalizeRecords` already receives `_amountConfidence`; flag any row whose
   amount token confidence falls below the document's own p10 (here 91.8 vs a
   22.3 minimum) rather than only flagging a missing amount.
2. Currency: reject a currency-column token that is not a known ISO code
   (`src/core/currency.js` already has the code table) and fall back to the
   profile default instead of exporting `LTD`. That alone removes 3 of the 6
   silent errors on this one fixture.

The balance column is present on this fixture and does not reconcile against the
misread amounts; `balanceCheck()` in `home.js` already computes this and
suppresses the all-clear line, but says nothing. Surfacing "the balances do not
add up, N rows may be misread" would catch all three.

### D7 (P2) - `orig_amount` does not carry the row's direction

**File**: `src/core/export.js`, `fieldValue()` ->
`formatAmountOut(row.orig_amount, row.orig_currency, preset.signConvention)`.

OBSERVED on `lattice_card_tabbed.csv`: an outgoing FX purchase exports
`Amount -86.20 SGD` next to `Original amount 65.00 USD`. Summing the
`Original amount` column gives the wrong sign.

**Fix**: apply the sign of `row.amount` to `orig_amount` in `fieldValue`
(`Math.sign(row.amount) * Math.abs(row.orig_amount)`), or store it signed in
`normalize.js`.

### D8 (P2) - `suggestFooterRows` aside, several smaller edges

- **A11**: a row with no date is copied to Sheets with an empty Date cell (`anchor_checking.csv` row 4). `home.js` `preExportSummary`/`export-warn-note` should mention "N rows have no date" the way it mentions pending decisions, or those rows should default to excluded.
- **A6/D5 sibling**: when `suggestDateFormat` hits its documented day<=12 ambiguity (every sample day <= 12), route through the existing `openConfirmFocus('dates', ...)` screen instead of assuming day-first. The screen already exists and already renders both examples; this is a call-site change in `wizard.js`, not new UI. A statement whose rows span 253 days is itself a cheap second trigger.
- **R5**: `blank.pdf` (no text, no images) is offered as a setup candidate. `isImageOnlyPdf` already reports `totalChars: 0, pages: 1` and OCR already returned `items: 0`; when OCR yields zero items on every page, say so and offer Remove rather than opening the wizard.
- **R11**: the Settings storage split under-reports. `computeStorageSplit` builds `settingsBytes` from three known keys only, and `totalBytes` from `navigator.storage.estimate()`, which does not see `chrome.storage.local` at all (60 MB written, `Total` unchanged at `0.2 MB`). Either count `chrome.storage.local.getBytesInUse(null)` into the total, or relabel the line so it does not read as the app's whole footprint.
- **R7**: `dev/e2e-password.mjs` currently fails 2 of its own checks ("a 'remember a hint' offer appeared after a clean unlock", "remembered hint shown on the next drop of the same statement type"), so `node dev/gate.mjs` full mode is red today. The unlock itself is correct and the password never reaches the log.
- **R10b**: the `Use <profile>` quick-apply suggestion on an unmapped file's card is lost after a session restore; only `Set up` comes back.
- **A10**: statement-type detection mislabels `LATTICE PLATINUM CARD` as savings and two current accounts as credit cards. Harmless on these fixtures because the sign convention came from the data, but `positiveIsOut` keys off this signal (KNOWN-GAPS #2), so a wrong type on a card CSV with unmarked positive amounts would invert every sign.
- **R4**: `File exceeds 25 MB limit` is correct and fast, but says nothing about what to do; the limit is not mentioned before the drop either.
- **R11b**: destructive actions use native `window.confirm()` (`home.js:2894`, `settings.js:132`) - the only native dialogs in an otherwise hand-made interface.

---

## What held up well

- 215/215 dates and amounts on the six text PDFs, including the cross-page date-group carry in `northwind_transaction_history_3p.pdf` (7/7).
- Encoding, delimiter, decimal-separator and CR/DR handling: correct on every CSV that reached the pipeline, including UTF-16, Windows-1252, semicolon+`1.234,56`, tab-padded cells and `SGD 12.50 DR` compound cells.
- Dedupe: exact re-drop (`Dropped again, already here.`), overlapping files (`2 of 3 rows merged`, `31 of 31 rows merged` on two real OCR'd statements), and - importantly - **no false positive** on three identical amount+description rows on different dates.
- Export: TSV/CSV/preview agree on rows, order and columns; quoting, negative zero, and 0-decimal currencies are all right.
- Failure messages: every failure mode tested produced a plain-language line, a `Remove`/`Read again`/`Copy debug log` action, no stack trace in the UI, and **zero console errors and zero page errors across the whole pass**.
- OCR queueing, cancel and remove-mid-OCR are clean and recover without an orphaned worker.
- Session restore after a reload returns rows, counts, profiles and the preview intact.
