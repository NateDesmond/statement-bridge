# Statement Bridge (engine)

Bank statements (CSV/TSV/PDF text/XLSX) to clean transaction exports. Manifest V3
Chrome extension. Fully offline: no network requests, no host permissions,
`connect-src 'none'` in the CSP.

## Load it

1. `chrome://extensions`
2. Enable Developer mode
3. Load unpacked, point at this `extension/` folder
4. Click the extension icon, it opens `workspace.html` in a new tab

## Module map

```
manifest.json          MV3 manifest, no host permissions, connect-src 'none'
src/background.js      action.onClicked -> opens workspace.html in a tab
workspace.html          app shell markup: sidebar, Home fast path, review, wizard, profiles, settings
src/ui/app.js           DOM wiring layer: shared state + nav-driven render calls
src/ui/home.js          Home fast path: drop zone -> file rows -> attention cards -> "Ready to
                        copy" panel + inline Change drawer. DOM glue only; decision logic is in
                        core/home-state.js. Reuses preset-editor.js inside the drawer. Keeps
                        entry.matchedVersion + (for a grouped-rowModel PDF) entry.pdfSourceText
                        once a match is applied, so its health badge can run countCheckGrouped
                        the same way the wizard's Test step does (item 1).
src/ui/nav.js           sidebar screen switching + the always-visible footer (offline lock,
                        storage meter, retention note). Exports announce(text), which writes to
                        the shell's shared #sr-status (role="status", aria-live="polite",
                        workspace.html) - every screen module calls this instead of touching
                        that element directly, so there is exactly one live region in the app
                        (fix wave item A2). Also exports fitTwoColumnGrid(el), which toggles a
                        `.single-col` class on a `.settings-grid` when one column measures more
                        than 2x the other's height (item E4; used by profiles.js and
                        settings.js). The header title/subtitle track whichever `.screen` is
                        `.active` via a MutationObserver, so wizard.js/home.js flipping a
                        screen's class directly (rather than through nav's own showScreen)
                        still updates the header (item E6).
src/ui/preset-editor.js export preset model (pure, tested) + a reusable column-list/preview
                        DOM component, used by both Settings and the Home Change drawer
src/ui/wizard.js        5-step mapping wizard; "Update mapping" (layout changed) reopens it
                        against the file's matched profile and appends a new version on save
                        instead of creating a duplicate profile. For a grouped-rowModel PDF,
                        Locate data now runs detectGroupedSignConvention and pre-selects the
                        sign-convention picker from it (with a columnBands overlay + draggable
                        divider when that's what it proposes) - see item 1 below.
src/ui/review.js        split source/extracted view; showFile(entry) jumps straight to one
                        file from Home's quiet "Review" link or an attention card. A grouped-
                        rowModel PDF's summary runs countCheckGrouped instead of countCheck
                        (item 1).
src/ui/profiles.js, src/ui/settings.js  Profiles and Settings screens (bank groups/versions,
                        preferences, saved rates, storage, export presets)

src/core/home-state.js  pure Home state machine: file status, attention-card list, export
                        blockers vs warnings, and the "since last export" range suggestion.
                        No DOM; unit tested in test/home-state.test.js.
src/core/detect.js      file type sniffing (CSV/PDF/xlsx by content), encoding, delimiter
src/core/csv.js         Papa Parse wrapper: raw grid -> profile-shaped records
src/core/amount.js      amount string parsing -> {minor, currencyHint, crdr}; CURRENCY_DECIMALS
                        (zero-decimal currencies: JPY/KRW/VND/CLP/ISK/HUF) and the shared
                        formatMinor(minor, currency) every UI amount display now goes through,
                        so a zero-decimal currency never gets divided by 100 or forced to ".00".
                        formatMinorDisplay(minor, currency) is THE on-screen display formatter
                        (formatMinor with grouped:true) - every table cell/preview/summary a
                        human reads uses it. Plain formatMinor (ungrouped) is what a CSV/TSV
                        export cell must use instead (export.js's fieldValue) - never show a
                        comma-grouped number in an exported file, never show an ungrouped one on
                        screen (fix wave item E2/E3). groupPlainNumber(str) covers the one case
                        that has only the export string on hand, not the raw minor units
                        (preset-editor.js's live preview, built from export.js's fieldValue).
                        The shared CSS utility for this is workspace.css's `.num` class
                        (tabular-nums) plus `td.num`/`th.num` (right-aligned) - apply both
                        classes to any new amount/balance cell.
src/core/date.js        date parsing per dateFormat, day/month order + year inference
src/core/normalize.js   fields/transforms/signConvention -> standard transaction rows
src/core/suggest.js     rule-based (no AI) mapping suggestions
src/core/profiles.js    profile CRUD, matching, backup/restore JSON
src/core/builtin-profiles.js  starter profiles for fictional example banks (Meridian Bank
                        savings, Harbour Card credit card, Riverside/Summit/Anchor Bank savings
                        or checking, Lattice Bank tab-padded credit card, Northwind Bank grouped
                        Transaction History PDF). Meridian Bank savings has two CSV versions: v1
                        for a short-preamble layout, v2 for a longer-preamble layout with no
                        running Balance column and dates as "15 Sep 2026"
src/core/storage.js     storage adapter (chrome.storage.local, or in-memory for tests)
src/core/checks.js      balance check, count check, per-file summary; countCheckGrouped +
                        groupedCountLabel are the grouped-rowModel PDF equivalent, shared by the
                        wizard's Test step, Home's health badge, and Review's summary (item 1)
src/core/dedupe.js      fingerprinting, cross-file duplicate merge (Home's "N rows merged / Undo")
src/core/daterange.js   date range presets, filtering, coverage warnings
src/core/currency.js    currency detection order, per-currency totals, rate conversion (mode B's
                        convertToTarget now scales by each currency's own decimal count via
                        amount.js's decimalsFor, not a flat /100 - item 2)
src/core/export.js      CSV/TSV builders, filename suggestion, pre-export summary; amount
                        formatting goes through amount.js's formatMinor (item 2)
src/core/pdf.js         pdf.js text extraction (columns and grouped rowModels), line grouping,
                        column assignment, extractPdfPagesRows (concatenates every page's lines
                        before extracting, see "OCR for image-only PDFs" below), the standard-font
                        fetch shim (see vendor/ below)
src/core/sessions.js    session persistence (IndexedDB adapter + in-memory for tests), cleanup,
                        "restore your last session?" + "deletes in N days" helpers
src/core/limits.js      file size cap, batch-size warnings, regex safety guard
src/core/pdf-image.js   image-only-page detection (isImageOnly: near-zero text + an image
                        XObject op) and renderPageToCanvas (pdf.js page -> canvas at OCR
                        resolution, default scale 2.5)
src/core/ocr.js         on-device OCR (Tesseract.js/WASM) for image-only PDFs: ocrPageCanvas
                        runs a page canvas through a shared Tesseract worker and returns
                        pdf.js-shaped positioned text items (str/x/y/width/height/confidence,
                        PDF-space points) so groupItemsIntoLines/extractRows/extractGroupedRows
                        in core/pdf.js consume OCR output exactly like real pdf.js text content;
                        a digit/currency-whitelisted second pass re-recognizes amount/date-
                        looking words and keeps whichever pass is more confident
src/worker.js           web worker running parse jobs with progress/cancel messages (not yet
                        wired into src/ui/home.js, see gaps below)

vendor/                 Papa Parse, pdf.js (+ worker), SheetJS, copied in, no CDN references.
                        standard-fonts-data.js inlines pdf.js's base-14 font substitutes as
                        base64 (see dev/gen-standard-fonts-data.mjs); core/pdf.js serves them to
                        pdf.js via a fetch() shim instead of a real network request, since the
                        manifest's connect-src 'none' blocks fetching even same-origin extension
                        resources, and pdf.js needs this data to read non-embedded Helvetica/
                        Times/Courier text at all (common in bank statement PDFs)
vendor/tesseract/       Tesseract.js 5.1.1 + tesseract.js-core 5.1.1 (LSTM-only, non-SIMD wasm)
                        + English standard-accuracy traineddata, vendored fully offline. See
                        "Vendoring Tesseract.js offline" below.
test/fixtures/          anonymised sample CSVs used by profiles.test.js and the dev-harness e2e check
```

## OCR for image-only PDFs

Wired end to end. Flow: an
image-only PDF's attention card offers "Read it with on-device text
recognition (slower, check the results)"; `src/ui/home.js`'s `runOcrOnFile`
calls `core/ocr.js`'s `ocrDocument`, which renders each page to a canvas
(`core/pdf-image.js`'s `renderPageToCanvas`, scale 2.5) and runs it through
Tesseract, with progress reported per page ("Reading page 2 of 3") and a
Cancel that aborts cleanly back to the image-only card. The result then joins
the exact same path a real-text PDF uses: `matchProfile()` against the OCR'd
page text (`fileType: 'pdf'`; `core/profiles.js`'s `matchProfile` now filters
out any profile whose `fileType` differs from the file's before scoring, so a
PDF - OCR'd or not - can never match a CSV profile, formatChanged or not),
then
`extractPdfPagesRows()`/`normalizeRecords()` against the OCR items, so the
built-in "Northwind Bank savings, Transaction History PDF" profile (`rowModel:
'grouped'`) matches and extracts an OCR'd statement exactly like a real one.
If nothing matches, the file falls through to the ordinary "new statement"
card and "Map this statement" opens the wizard against the cached OCR items
(`src/ui/wizard.js`'s `renderAnchorPicker` uses `entry.ocrPages[0].items`
instead of asking pdf.js for text that doesn't exist) - the anchor picker,
rowModel auto-detection, and live preview all work unchanged.

Every row from an OCR'd file carries flag `ocr` (informational only -
`core/home-state.js`'s `warningRowCount`/`healthBadge` and `review.js`'s
warning filter both explicitly exclude it, so a clean OCR read still shows a
plain "All checks pass" badge). `low_confidence_ocr`, a real warning, fires
only on the amount or date-group TOKEN itself falling below 70 confidence -
narrowed from an earlier whole-line version (Nate, 2026-09-16: stepping
through low-confidence rows one by one made OCR feel untrustworthy when the
actual transaction data was fine, just a misread merchant word). `core/pdf.js`'s
`extractRows`/`extractGroupedRows` track `_amountConfidence`/`_dateConfidence`
per row (confidence of only the items inside the amount's own regex match or
column x-range, and the date-group line, respectively - never the
description or type text), and `core/normalize.js` turns the worse of the two
into the flag when meta.ocr is set. Review's summary bar adds "Read by text
recognition, check amounts against the page" whenever any row in the file
carries `ocr`, and its source pane renders the page from the cached OCR items
instead of calling pdf.js's own (empty) `getTextContent()`.

**Sign-independent amount detection** (2026-09-16, after two real credit
transactions were found silently missing entirely - see "Accuracy" below):
`core/pdf.js`'s `matchAmountLine` decides "does this line carry an amount" as
a question separate from "what does the sign mean". A line matches if its
right side holds a number (thousands separators optional, decimal part
optional and 1-3 digits when present - some banks print round amounts with
none, and JPY/KRW/IDR/VND never have one), with an optional currency
code/symbol (OCR digit/letter confusions like "S6D" corrected via a small
map) and an optional sign, CR/DR/C/D marker, or surrounding parens on either
side. A line is only ever excluded by its SHAPE, checked first and never by
a missing/misread sign: a page footer, an "as of"/"balance"/"total" phrase
(`NON_TRANSACTION_PHRASES_RE`, plus a matched profile's own
`ignoreLinePatterns`), a statement-period range (two 4-digit years), or a
bare reference/account number over 8 digits with no currency, decimal, or
marker at all. Structurally, `extractGroupedRows` also never treats ANY line
as a transaction before the first date-group line has opened - a grouped
statement's preamble (address, account/postal numbers, the balance summary)
sits above the whole transaction list regardless of its exact wording, so
this state check catches page-1 preamble lines the phrase list can't fully
enumerate; the phrase list still matters for a line reprinted per-page (a
restated header on page 2) after the state gate has already opened.

Once a line is confirmed to carry an amount, `resolveGroupedSign` turns its
marker into an actual `+`/`-` using the profile's `signConvention` - the same
values CSV already uses (`signed`, `crdr`, `positiveIsOut`, `positiveIsIn`),
plus a new `columnBands` (two x-ranges, `{debit, credit}`, for statements that
print debit/credit in separate right-hand columns instead of a marker at
all - the amount's own x-position decides). A marker that's actually present
(explicit sign, CR/DR, or parens) always resolves cleanly; a truly
marker-less line is a guess (default positive, or per convention) flagged
`sign_unclear` - a real warning, but the row is never dropped for it.
`detectGroupedSignConvention` proposes a convention from a whole document's
amount lines (majority signed -> `signed`, majority CR/DR -> `crdr`, two
clear x-clusters with neither -> `columnBands` via `learnAmountXBands`,
otherwise null for the caller to default by statement type and ask) -
**wired into the wizard (2026-09-16 final pass)**: `src/ui/wizard.js`'s
`renderAnchorPicker` runs it against the whole file the moment a grouped-rowModel
PDF's Locate-data step loads, pre-selects `#w-signconvention` from the result
(a `columnBands` option was added to that picker), and captions both Locate
data and Map fields with "Detected from your file (NN% of amount lines carry
a sign/CR-DR marker)" or, for `columnBands`, "separate debit/credit columns by
position". When it proposes `columnBands`, the rendered page in Locate data
gets two translucent bands (debit/credit) plus one draggable divider between
them (`renderColumnBandsOverlay`, reusing the existing `.col-boundary` drag
pattern) - dragging it re-runs the live preview. The detected/selected
convention now actually reaches extraction too: `buildVersionFromWizard`
writes `version.pdf.grouped = { signConvention, columnBands }` (previously
this was never set at all, so a grouped PDF's saved version always silently
extracted with the `signed` default regardless of what the UI showed - a real
bug this pass fixed, not just a missing caption). The count and balance
checks run unchanged; `core/checks.js`'s `countCheckGrouped(sourceText, rows)`
is the grouped-rowModel equivalent of `countCheck` (loose amount-line regex
vs rows extracted, `{extracted, amountLines, diff, matches, explanation}`),
and a shared `groupedCountLabel(amountLines, diff, matches)` helper now
guarantees the wizard's Test step, Home's health badge, and Review's summary
all word a count mismatch identically for a grouped-rowModel PDF file (`entry.matchedVersion`
and `entry.pdfSourceText`, set once a match is applied, are what let Home/Review
run the same check outside the wizard).

**Multi-page fix (found while verifying against a real 3-page statement):**
`extractRows`/`extractGroupedRows` were being called once per page, so a
rowModel 'grouped' date-group header on page 1 never carried over to a
transaction that happened to fall on page 2 (it landed with an empty date),
and a rowModel 'columns' tableStart/tableEnd anchor that only appears once
(typically page 1's header row / the last page's footer) meant continuation
pages produced nothing at all. Fixed by concatenating every page's lines into
one sequence before extracting (`core/pdf.js`'s new `extractPdfPagesRows()`),
used by `src/ui/home.js` (both the real-text and the OCR path),
`src/worker.js`'s `'pdf'` job kind, and `dev/ocr-vs-csv.mjs`'s comparison.

**Where OCR actually runs:** rendering a PDF page to a canvas needs `document`
(a Window API), and driving that from inside a second dedicated Worker hit a
real, verified conflict: pdf.js's own "fake worker" fallback (used whenever it
can't spin up a worker-of-a-worker for itself) clobbers the enclosing worker's
`postMessage`/`onmessage`, so `ocrDocument`'s page-render + orchestration loop
runs on the main thread. The actually expensive part - Tesseract's wasm
recognition - still runs off the main thread regardless, inside Tesseract's
own dedicated worker (`vendor/tesseract/worker.min.js`, created once by
`core/ocr.js`'s `getSharedWorker` and reused across pages/files); the main
thread only awaits it. `core/ocr.js` logs which path is active
(`OCR_PATH`/`home.ocr` log lines).

**Accuracy** is tracked against the synthetic OCR fixtures by
`dev/ocr-recall-audit.mjs` (see "Release gate" below) and, if you add your
own real statements under `test/private/` (see "Bring your own real
statements"), against those too via `dev/e2e-real-files.mjs` - numbers only,
never transaction text. On the synthetic grouped-PDF fixture
(`test/fixtures/northwind_transaction_history_image.pdf`): 5/5 rows and
amounts exact, one row flagged `low_confidence_ocr`.

The road to 100%, in order (each a real bug found by chasing the residual
mismatch rather than accepting a "good enough" number):
1. **Multi-page concatenation** (`extractPdfPagesRows`, see above): 23/29 (79.3%) -> 27/29 (93.1%).
2. **A merged day+month OCR token**: Tesseract read a bare "1 Sep 2026"
   date-group line as one word, `"1Sep 2026"` (confirmed via each word's own
   bounding box), which silently failed the old `\s+`-only
   `DEFAULT_DATE_GROUP_RE`/`date.js` parsing (no error, just no match), so
   every later transaction on that page stayed on the previous date. Fixed to
   `\s*` between day and month. -> 29/29 exact matches, but only 29 of 31 real
   rows were even being extracted.
3. **Two rows with a dropped `+` sign**: Tesseract's word segmentation
   sometimes drops a thin "+" glyph entirely (not misread as another
   character) - two real credit transactions were reading as e.g. "SGD
   11.63" with no sign at all, and the amount regex required one, so they
   silently produced zero rows. Fixed by decoupling "is this an amount line"
   from "what does the sign mean" (`matchAmountLine`/`resolveGroupedSign`,
   see above) - a missing sign is now a resolved guess (`sign_unclear`
   flag), never a dropped row. -> 31/31 rows extracted.
4. **That fix's own false positives**: once the amount regex no longer
   required a sign OR a decimal point (a follow-up request to also recognize
   round, no-decimal amounts), the account-summary preamble ("Available
   Balance SGD 33,889.56"), the address/postal/account numbers, and a
   per-page-repeated statement-period line ("16 Sep 2026 - 15 Oct 2026")
   all started reading as bogus transactions - 40 rows instead of 31 at the
   worst point. Fixed with the shape-based exclusions and the "nothing before
   the first date-group" state check described above. -> 31/31 real rows, 0 extras.
   Scale 3x and grayscale+threshold preprocessing were tried per an earlier
   request at step 2's stage; neither changed which rows mismatched (a
   text-matching bug, not an image-quality one).

Confirmed relative date-group words ("Yesterday"/"Today") never touch the
wall clock: `DEFAULT_DATE_GROUP_RE`'s `Yesterday,`/`Today,` branches only
ever capture the explicit calendar date digibank prints right after the
word on the same line (e.g. "Yesterday, 15 Sep 2026" - group 1 = "15 Sep
2026"); there is no `new Date()`/`Date.now()` anywhere in `core/pdf.js`.

**Known gap:** on a tight-leading, multi-column table (e.g. a 5-column
statement with a wrapped description), Tesseract's page segmentation can
fuse a wrapped description line with the amount row printed just above it
into one OCR line - a real recall miss, not a
regex bug. A page-segmentation-mode sweep alone does not fix this failure
mode. Planned fix is row-band segmentation (crop and recognize each row's
band separately before merging), gated on `test/fixtures`' Riverside Bank image
fixture reaching 0 misses.

## Vendoring Tesseract.js offline

`vendor/tesseract/` holds Tesseract.js 5.1.1, tesseract.js-core 5.1.1 (the LSTM-only,
non-SIMD wasm build) and the English standard-accuracy `eng.traineddata` (not the
lower-accuracy "fast" variant), obtained with `npm pack tesseract.js@5.1.1
tesseract.js-core@5.1.1` and `eng.traineddata` from tesseract-ocr/tessdata, copied out of
the tarballs, no CDN references:

```
vendor/tesseract/tesseract.esm.min.js       main-thread API (createWorker, OEM, ...), imported by core/ocr.js
vendor/tesseract/worker.min.js              the dedicated Worker Tesseract.js spawns internally (patched, see below)
vendor/tesseract/tesseract-core-lstm.wasm.js  emscripten glue for the LSTM-only wasm core, loaded via importScripts(corePath)
vendor/tesseract/tess-data.js               generated (dev/gen-tesseract-data.mjs): base64 of the core .wasm + eng.traineddata.gz
```

`core/ocr.js` passes `workerPath`/`corePath`/`langPath` as real `chrome-extension://.../vendor/tesseract/...`
URLs (resolved via `import.meta.url`, the same pattern `core/pdf.js` already uses for
`vendor/pdf.worker.min.mjs`) on every `createWorker()` call, and `workerBlobURL: false` so
Tesseract.js does a plain `new Worker(workerPath)` instead of fetching the worker script into
a Blob first. `grep -o 'https://[a-zA-Z0-9._/-]*' vendor/tesseract/*.js` finds exactly one
reachable-looking string, a `cdn.jsdelivr.net` default baked into `tesseract.esm.min.js` for
`workerPath` when the caller doesn't supply one. `core/ocr.js` always supplies all three
paths explicitly, so that default is dead code, never evaluated.

**The `connect-src 'none'` catch (why worker.min.js is patched):** passing local paths is not
enough on its own. Tesseract.js's own worker script and the emscripten wasm loader inside
`tesseract-core-lstm.wasm.js` both fetch their binary payload (the `.wasm` file, the
`.traineddata.gz` file) with a real `fetch()` call, and the manifest's `connect-src 'none'`
blocks *any* fetch from an extension page or its workers, including to the extension's own
`chrome-extension://` resources, confirmed empirically (a `fetch()` to a `blob:`, `data:`, or
same-origin URL under `connect-src 'none'` all fail identically to a real network fetch; this
is the same root cause `core/pdf.js`'s `installStandardFontFetchShim` already works around for
pdf.js's standard-font data). `worker.min.js` here carries a small hand-patch (marked `PATCH`
at the top of the file, the same kind of manual vendor patch `src/worker.js` already applies to
`vendor/papaparse.min.js`) that `importScripts('./tess-data.js')` (a script load, not a
"connection", so `connect-src` doesn't apply to it) and then overrides `self.fetch` so any
request ending in `.wasm`, `.traineddata.gz`, or `.traineddata` is served from that embedded
base64 data instead of ever reaching the network stack. Regenerate `tess-data.js` after
bumping the vendored version with `node dev/gen-tesseract-data.mjs <core.wasm> <eng.traineddata.gz>`;
re-apply the `PATCH` block at the top of the new `worker.min.js` by hand (small, ~40 lines, see
the existing block) since it does not survive a fresh `npm pack`.

## Run tests

```
node --test
```

298 tests, all green (292 baseline + 6 added in the 2026-09-16 final integration
pass: a JPY row through normalize -> export, mode B conversion across
different-decimal currencies, groupedCountLabel's wording, and healthBadge's
groupedMismatchLabel option).

## Dev harness (visual + end-to-end verification)

`dev/index.html` fetches the real `workspace.html`, rewrites its relative paths, and
`document.write()`s it into the tab after `dev/chrome-shim.js` has installed a
`window.chrome.storage.local` shim backed by `localStorage` (`sb-dev:` prefixed keys). This
runs the real UI code with no extension context, so it can be served over plain HTTP and
driven with a normal browser automation tool:

```
python3 -m http.server 8934 --directory extension   # from the repo root
```

Then drive `http://localhost:8934/dev/index.html` with Playwright/CDP: set `#file-input`'s
`files` via a `DataTransfer` (drag-drop isn't scriptable, this is the standard workaround),
screenshot at 1440x1000+, and read `dev/shots/*.png` back to check for visual defects.
`localStorage.clear()` + `indexedDB.deleteDatabase('statement-bridge')` before a reload
resets both settings and sessions between scenarios.

The Home fast path was verified this way: empty state, a processing row, the two-file
"second month" healthy state with the export panel, each attention card (new statement,
layout changed, low confidence, warnings, duplicates merged), the Change drawer expanded
with the preset editor and currency modes, and the post-copy toast. One end-to-end check
loads the Meridian Bank + Summit Bank fixtures, confirms both profiles auto-match, selects "Last full month",
clicks Copy for Sheets, and asserts the clipboard TSV's header and row count (this needs the
browser's clock inside June-July 2026 since the fixtures are dated June 2026; the dev-harness
script freezes `Date` via `page.addInitScript` for that one check only).

`dev/ocr-e2e-check.mjs` drives the full OCR flow through this same harness against the
synthetic `test/fixtures/northwind_transaction_history_image.pdf` fixture (an
image-only PDF, needs `playwright` and
the dev server running): drop, the image-only card, click "Read it with on-device text
recognition", the resulting healthy row, Review, and Copy for Sheets, screenshotting each
step into `dev/shots/ocr-*.png`. `dev/ocr-vs-csv.mjs` compares OCR accuracy against real
ground truth (see "OCR for image-only PDFs" above); it reads only from `test/private/`
and prints aggregate numbers only, never transaction text. `dev/final-verify.mjs` walks
the wizard against the two synthetic fixtures that exercise the paths the real files
above don't (`summit_card_sample.pdf`, a PDF columns-rowModel credit card; `harbour_card_crdr.csv`,
a CSV with CR/DR markers), screenshotting each step into `dev/shots/final-*.png`.

Every `dev/*.mjs` Playwright driver launches the browser with a plain `chromium.launch()`
(no `channel: 'chrome'`) - bundled headless Chromium only, always in a `try`/`finally` so
it closes even on failure, and none of them ever `pkill`/`killall`/inspect `ps` for a real
Chrome process. `dev/gen-dbs-transaction-history-image.mjs`, `dev/ocr-vs-csv.mjs`,
`dev/ocr-e2e-check.mjs` and `dev/wiz2-check.mjs` used to launch the user's own installed
Chrome (`channel: 'chrome'`) - fixed 2026-09-16; `dev/home3-check.mjs` was already correct
and is the pattern the others now follow. Running any of them needs the `playwright` npm
package on the module path (it is intentionally not a project dependency - see
`dev/gen-dbs-transaction-history-image.mjs`'s header comment - so point `NODE_PATH` at an
existing Playwright install, or symlink one in as `extension/node_modules` for the
session, rather than adding it as a real dependency or downloading a new browser when a
cached one already exists under `~/Library/Caches/ms-playwright`).

### Release gate: run before every reload request

```
node dev/gate.mjs           # full gate, including the OCR recall audit
node dev/gate.mjs --fast    # skips the OCR recall audit (step 6, slow)
```

One command, runs in order, prints a PASS/FAIL/SKIP table with durations,
exits non-zero on any FAIL:

1. `node --test test/*.test.js`.
2. Banned words / em-dash sweep over `src/`, `workspace.html`,
   `workspace.css`, `README.md`.
3. Network sweep: no `fetch()`/`XMLHttpRequest`/`WebSocket`/`http(s)` URL in
   `src/` outside `core/pdf.js`'s documented standard-font fetch shim (an
   `.invalid`, never-resolvable URL - see "Module map" above); manifest CSP
   still has `connect-src 'none'` and no `host_permissions`.
4. Real-extension e2e against the bundled Chromium (never the user's
   Chrome): `dev/e2e-extension.mjs`, `dev/e2e-review.mjs`,
   `dev/e2e-presets.mjs`, `dev/e2e-remove-statements.mjs`,
   `dev/e2e-stale-profile.mjs`. Each scenario ends with
   `dev/lib/assert-clean-log.mjs` - fails on any page error or any
   `core/debuglog.js` entry carrying a `stack` (a real bug, never
   informational logging). `dev/e2e-stale-profile.mjs` seeds
   `chrome.storage.local` with a broken user profile (same signatures as a
   built-in, a mapping that silently loses amounts) BEFORE dropping the
   matching fixture, and asserts the working built-in wins on extraction
   quality, the row count is right, the losing-profile caption shows, and
   Copy for Sheets has an amount on every row - see home-state.js's
   `selectMatchCandidate` doc comment for the real bug this exists for.
5. `dev/e2e-real-files.mjs` - only runs when both `test/private/` and
   `test/private/manifest.json` exist (gitignored, never committed - see
   "Bring your own real statements" below). Drops each listed file, checks
   its match/row counts (numbers only, never printed text), re-drops all of
   them and checks the counts/export composition/OCR job count are
   unchanged.
6. Full mode only: `dev/ocr-recall-audit.mjs` against the synthetic OCR
   layout fixtures (misses must be at or below the documented per-layout
   baseline). Starts the dev server on `:8934` itself if nothing is
   listening there, and stops only the one it started.

### Bring your own real statements (optional, local only)

`dev/e2e-real-files.mjs` can smoke-test the pipeline against your own
statements without ever committing them: drop your files into
`test/private/` (gitignored) and add a `test/private/manifest.json` next to
them:

```json
{
  "files": [
    { "name": "my_savings.csv", "expectRowCount": 205, "expectProfileContains": "savings" },
    { "name": "my_statement.pdf", "expectRowCount": 31, "expectProfileContains": "PDF", "timeoutMs": 180000 }
  ]
}
```

Every field but `name` is optional. Nothing under `test/private/` is ever
read by the unit tests, only by this one opt-in dev script, and it skips
cleanly when the folder or manifest is missing.

## What is NOT done yet

- ~~PDF matching at drop time~~: done. `src/ui/home.js`'s drop handler loads
  the PDF (`core/pdf.js`'s `loadPdfPages`), builds page-1 text, and runs it
  through the same `matchProfile()` path CSV/XLSX use (`pdfText`/`preambleText`
  signals plus filename), so a saved or built-in PDF profile (e.g. "Northwind
  Bank savings, Transaction History PDF") auto-applies and shows its health badge
  like a CSV match. This needed a `matchProfile()` fix too: a PDF profile's
  `signatures.headerText` is always `[]` (no header row to compare), which
  used to cap every PDF match's confidence at 0.4 (weighting a header score
  that could never be anything but 0) and always flag it `formatChanged`; PDF
  signatures now score on pdf/preamble/filename anchors alone. The wizard
  itself (`src/ui/wizard.js`) drives the full interactive PDF flow: it renders
  the real page, auto-detects rowModel ("columns" for a fixed-width table vs
  "grouped" for app-export style date-group + amount-ended-line layouts, see
  `core/pdf.js`'s `detectPdfRowModel`/`extractGroupedRows`), and shows the
  detected structure over the page before Map fields/Test/Save.
- ~~A PDF whose text draws correctly but doesn't extract~~: done, and
  extended to Home. Some real statement PDFs render perfectly
  (`page.render()` paints the vector content fine) while `getTextContent()`
  returns almost nothing, either because the page is a full-page raster (a
  scanned/exported-as-image statement) or because the font's char-to-Unicode
  mapping is missing or broken. `core/pdf.js`'s `isImageOnlyPdf()` (near-zero
  extracted characters across pages) is now checked at drop time on Home, not
  only inside the wizard: such a file never opens the wizard directly, shows a
  "No readable text" badge on its file row, and gets an attention card ("This
  PDF is a picture of a statement") with a primary "Read it with on-device
  text recognition" action (see "OCR for image-only PDFs" below), a "Use CSV
  instead" secondary with a bank-specific export hint when the filename or the
  little text present mentions a recognised bank name, plus Remove / Copy
  debug log.
- **XLSX profile signatures**: xlsx files are read into a grid via SheetJS in
  the UI layer and reuse `core/csv.js`'s `applyProfileVersion`, but no
  built-in xlsx starter profile or xlsx-specific signature matching exists yet.
- **Mapping wizard step 2/3 editing UI**: the wizard shows suggested mappings
  read-only (step 2 table) and a rough test/save flow (steps 3-4); there is no
  UI yet to override an individual field's source column, add a transform, or
  hand-edit footer/ignore rules. The underlying `core/profiles.js` and
  `core/normalize.js` support all of that, the UI just doesn't expose it.
  "Update mapping" now appends a new version to the existing profile instead
  of creating a duplicate, but it prefills from the wizard's own grid-based
  auto-suggest (same engine as a brand-new mapping), not literally from the
  old version's field list; a real layout-diff view is future work.
- **Row-level edit UI**: `original`/`edited`/`excluded` fields exist on every
  normalized row and the review table renders flags and strikes through
  excluded rows, but there are no click handlers yet to edit a cell or
  exclude/restore a row from Review. Home's own dedupe-merge Undo is wired
  (`core/dedupe.js`'s `removed` list feeds a one-line notice + Undo card).
- **`src/worker.js`** is wired into Home's fast path for CSV/XLSX (a dropped
  file parses off the main thread, with real per-chunk progress from Papa's
  `step` callback and cancel support), confirmed live in the dev harness
  (`home.parse` logs "parsed in worker", not "parsed on main thread"). PDF
  parsing still runs on the main thread from the wizard (`extractRows`/
  `extractGroupedRows` called directly for the interactive anchor picker and
  live preview); `runParseJob`'s 'pdf' kind exists in the worker for a future
  Home-driven PDF flow but nothing calls it yet, since Home doesn't drive PDF
  parsing at all (see the drop-time gap above).
- **`src/worker.js`** has no dedicated node test (it is a thin message-passing
  shim over already-tested pure functions in `core/csv.js`, `core/pdf.js`,
  `core/normalize.js`; it also touches `self`/Worker globals not present in Node).
- **Currency-unknown and missing-rate cards are unit-tested, not screenshot-verified
  end to end**: `core/home-state.js`'s `attentionCards` covers `currencyUnknown`
  and `exportReadiness` covers missing rate pairs, and `home.js` renders both
  card kinds, but no built-in profile in the fixtures produces a null-currency
  row or a real foreign currency, so those two specific renders were
  reviewed by code inspection rather than a live screenshot. Low confidence,
  layout changed, warnings, new statement, and duplicates-merged were all
  captured live in `dev/shots/`.
- **Regex safety guard ceiling** (`core/limits.js`): the guard measures how long
  a user regex took on a sample and rejects it after the fact; it cannot
  preempt a truly catastrophic pattern already mid-backtrack, since synchronous
  JS can't be interrupted. A hard ceiling needs the regex run inside a Worker
  that gets `terminate()`'d on timeout. Marked with a `ponytail:` comment in
  the source.
- ~~Grouped-PDF sign convention detection/columnBands not wired into the
  wizard, countCheckGrouped not wired into Home/Review~~: done in the
  2026-09-16 final integration pass - see "OCR for image-only PDFs" above
  for the detail (item 1).
- ~~Zero-decimal currencies (JPY etc.) not consistently handled end to end~~:
  done - `formatMinor`/`decimalsFor` now back every UI amount display
  (Review, the wizard's live preview/Test/Save totals, export) and mode B's
  `convertToTarget`; verified with a JPY row through normalize -> export
  (item 2, see `test/normalize.test.js`/`test/export.test.js`/`test/currency.test.js`).
- **The wizard's Test step count check doesn't fold in the skipped-line
  explanation Review's does** (found verifying `harbour_card_crdr.csv`,
  task 3d): Review's summary subtracts the skipped-summary-line count from a
  count-check diff before deciding pass/fail styling and captions the
  remainder ("count check (3 skipped summary lines)"); the wizard's Test step
  still shows the raw, unexplained `7 vs 4 date-led lines (diff 3)` in red
  even though its own "3 lines skipped, not transactions" group right below
  it fully accounts for the gap. Cosmetic (the actual row data and skipped
  group are both correct), not touched by this pass since it predates items
  1/2 and neither task named it - flagged here for whoever owns the wizard's
  Test step next.
- **A grouped-rowModel PDF's columnBands overlay only appears when
  `detectGroupedSignConvention` itself proposes `columnBands`**: picking
  `columnBands` manually from the sign-convention dropdown (with no bands
  detected) is accepted by `buildVersionFromWizard`/`extractGroupedRows` but
  draws no overlay and, with no bands to test x against, resolves every
  amount as an unclear guess. Matches the task as scoped ("if it proposes
  columnBands, show the two bands") - a fully manual band-drawing tool would
  be new scope, not a gap in what was asked.
