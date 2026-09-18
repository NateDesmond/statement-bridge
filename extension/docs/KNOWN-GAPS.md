# Known gaps (Track 1 synthetic corpus, 2026-09-18)

Measured with `node dev/corpus-audit.mjs` (n=1000, seeded, text formats
only: csv/tsv/xlsx/pdf-columns/pdf-grouped, confirm-first path - no saved
profile). These are the gaps left after fixing every extraction/suggestion
cause the corpus could attribute to a single, fixable root cause (see
HARDENING.md's Track 1 report for the fixed list). None of these are
regressions; they are held out of `test/corpus.test.js`'s in-scope recall
number (`KNOWN_GAP_LANGS`/`KNOWN_GAP_SIGN_CONVENTIONS`) so the gate stays a
useful regression check instead of permanently red over a scoped-out gap.

## 1. Header languages (RESOLVED 2026-09-18)

`suggest.js`'s `HEADER_DICTIONARY` originally only had entries for en/zh/ms.
Extended to add de/fr/es/ja/it/nl/pt/ko: common date/description/reference/
debit/credit/amount/balance/currency terms per language, including the
bank-specific phrasings (de: Buchungstag, Wertstellung, Verwendungszweck,
Betrag, Soll, Haben, Saldo; fr: Date opération, Date valeur, Libellé, Débit,
Crédit, Solde, Montant; es: Fecha valor, Concepto, Cargo, Abono, Importe,
Saldo; ja: 日付, 取引日, 摘要, 出金, 入金, 残高, 金額; it: Data contabile, Data
valuta, Descrizione, Dare, Avere, Importo, Saldo; nl: Datum, Omschrijving,
Af, Bij, Bedrag, Saldo; pt: Data, Descrição, Débito, Crédito, Valor, Saldo;
ko: 거래일, 적요, 출금, 입금, 잔액). `normHeader` now also strips Latin
combining diacritics (NFD, drop U+0300-U+036F, recompose NFC) so an accented
header (e.g. "Descrição") matches its unaccented dictionary term the same
way case-folding already did; the NFC recompose step also keeps this safe
for Hangul, whose syllables NFD decomposes into jamo that would otherwise
never match the dictionary's plain (NFC) Korean terms.

Two generator bugs surfaced and were fixed alongside the dictionary
(`test/corpus/generate.mjs`, in scope for this pass since it emits the
language/alias axes the recall numbers below measure): a missing plain "日付"
alias in the ja date list scored 0 against the dictionary (fixed by adding
it), and `windows-1252` was left un-substituted for `ko` samples the same
way it already was for `zh`/`ja` (windows-1252 cannot represent Hangul at
all - it silently mangled every Korean header into noise before the
dictionary ever saw it).

Measured recall (n=1000, `signed`/`debitCredit` sign conventions only - see
gap 2 below for why `crdr-*`/`parens`/`positiveIsOut` are excluded from a
per-language table):

| lang | before | after |
|---|---|---|
| de | 34.8% | 95.0% |
| ja | 35.9% | 96.4% |
| es | 38.3% | 98.2% |
| fr | 78.5% | 95.6% |
| it | (new) | 97.8% |
| nl | (new) | 96.1% |
| pt | (new) | 96.8% |
| ko | (new) | 98.9% |
| zh | 92.0% | 100.0% |
| en | 94.9% | 96.1% |
| ms | 95.4% | 93.3% |

Every language now clears the header-mapping step. The full-corpus bucket
table (`node dev/corpus-audit.mjs`, all sign conventions) sits lower per
language (90-99%) - that residual traces to `crdr-prefix`/`crdr-suffix`/
`parens` sign-convention cases plus `positiveIsOut` (gap 2 below), which hit
every language roughly equally (`ms`, unchanged by this pass, measures 93.3%
under the very same `signed`/`debitCredit`-only filter, so the residual on
de/fr/es/ja/it/nl/pt/ko is that pre-existing, cross-language behavior, not a
new or remaining vocabulary gap). Out of scope here - `suggest.js`'s
dictionary and `scoreHeader` own header-text matching, not amount-sign
parsing (`amount.js`/`normalize.js`). `KNOWN_GAP_LANGS` in
`test/corpus.test.js` and `dev/corpus-audit.mjs` is now an empty set (kept,
not deleted, as the scoping structure for any future truly-unsupported
language).

## 2. `positiveIsOut` sign convention has no shape-based signal

In the confirm-first path (no saved profile, no wizard "this is a credit
card" hint) `suggestSignConvention` can only ever return `'signed'` or
`'debitCredit'` from column shape - a single amount column with plain signed
numbers is *indistinguishable* from a `positiveIsOut` column (a card
statement's own convention: an unmarked positive number means money OUT)
without knowing the statement is a credit card. That determination lives in
the wizard's Basics step (`detectStatementType` + the user's own selection),
not in any file this track owns.

Measured: 831 truth rows, 0% recall, 100% extras (every row's sign comes out
inverted, since the file is read as plain `'signed'` by default).

**Why not fixed this pass:** this is a real, inherent ambiguity in the
no-context confirm-first path, not a bug in `suggestSignConvention` (it
already returns the only two shapes it can prove from data alone). No
code fix in `csv.js`/`suggest.js`/`normalize.js`/`amount.js` closes this
without also carrying a statement-type signal through, which is wizard/UI
scope (`src/ui/wizard.js`, out of this track). Once a real file goes through
the wizard, Map fields' sign-convention picker (and its credit-card default)
resolves this correctly - this gap is specific to the *unmapped, no-context*
confirm-first read the corpus measures.

## 3. `pdf-columns`: no-header amount+balance vs debit+credit ambiguity

`inferPdfColumns`' no-header fallback (`clusterNumericColumns` +
`assignNumericClusterRolesByPosition`) assigns roles to right-hand numeric
column clusters by position/count alone when no header row is present to
read real column names from: 1 cluster -> `amount`, 2 clusters ->
`debit`/`credit`, 3 -> `debit`/`credit`/`balance`. A truly 2-column,
no-header PDF table that is actually "one amount column + a running
balance" is indistinguishable, by position alone, from "debit column +
credit column" - both are two right-hand numeric clusters with no other
signal. Every mismatch traced in this pass (72.0% recall / 28.0% extras on
the `pdf-columns` bucket, 881 truth rows) was this exact case: the balance
column gets read as `credit`, which corrupts every row's amount.

**Why not fixed this pass:** disambiguating this needs a heuristic beyond
position/count (e.g. "one of the two columns is roughly monotonic across
the page - that's the balance" or a header text always being present in
practice), which is new extraction logic, not a fix to an existing cause -
`inferPdfColumns`' doc comment already documents this as its known
trade-off ("two clusters with no balance context read as a debit/credit
pair"). A real-world PDF table almost always DOES print column headers
(the OCR-verified real fixtures in `README.md`'s "OCR for image-only PDFs"
section all have them), so this specific no-header-AND-has-balance
combination is a corpus-only stress case more than an observed real-world
failure - flagged here with numbers rather than guessed at.

## 4. `suggestDateFormat`'s inherent day<=12 ambiguity (mitigated, not eliminated)

A `MM/DD/YYYY` (or `DD/MM/YYYY`) statement whose every transaction happens to
fall on a day-of-month <=12 gives `suggestDateFormat` no evidence at all to
tell the two formats apart (its own documented "ambiguous default: day-first"
case). The corpus generator was widened (transactions now walk forward 1-3
days each, not 1-2) specifically so most 8+ transaction samples clear day 12
somewhere and this ambiguity resolves correctly - this closed most of the
gap the corpus first measured, but a short statement (few transactions, all
early in the month) hits the identical ambiguity in production too, unchanged.
Residual measured impact: `dateFormat` buckets sit at 90-97% recall (n=1000,
in-scope) even after every other date-shape/locale cause in this pass was
fixed - the remainder is this ambiguity, not a new bug.

## Deferred: image-PDF samples through OCR

HARDENING.md's Track 1 spec also asks `dev/corpus-audit.mjs` to run
image-only PDF samples through OCR. Rendering a PDF page to a canvas and
running Tesseract needs a real browser (no headless-canvas/wasm-worker path
exists in plain Node - the same reason `dev/ocr-recall-audit.mjs` drives a
Playwright page instead of calling OCR functions directly), and
`src/core/ocr.js` is under active edit by Track 3 this pass. Wiring a second,
competing OCR harness here for one pass risked colliding with that work for
no corpus-specific payoff: image-PDF recall already has its own dedicated,
passing audit (`dev/ocr-recall-audit.mjs`, wired into `dev/gate.mjs`'s full
mode already). `dev/corpus-audit.mjs` instead runs every TEXT format (csv,
tsv, xlsx, pdf-columns, pdf-grouped) at a higher sample count than the fast
subset for a steadier read on the per-bucket numbers above.
