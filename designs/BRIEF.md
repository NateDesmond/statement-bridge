# Statement Bridge design competition - shared brief

Product: a Chrome extension (Manifest V3, opens in a FULL browser tab, desktop only) that turns bank statements (CSV / text PDF) into clean transaction exports for CSV download or Copy for Sheets. Fully offline, zero network. No AI, no categorisation, no sign-in. Core of the product: mapping a NEW statement format quickly, once, then it is recognised forever. Users: spreadsheet budgeters with 2 to 6 bank accounts, often Singapore + one other country (SGD/USD), comfortable with Sheets, not code. Read ~/Desktop/StatementBridge/PROFILE_SCHEMA.md for data shapes.

## What each design option must contain
One folder `designs/option-N/` with a single `index.html` (inline CSS + tiny inline JS for tab switching; NO external fonts, scripts or images except `../logos/logo-N.png` for the logo slot, and system font stacks or embedded @font-face is fine). Must render fully offline. Desktop-first at 1280 to 1600px wide, still usable at 1024.

Screens to show, switchable by an in-page top nav (each a full-height "screen" inside the page):
1. **Import / workspace home**: drop zone + file picker, the "CSV is more reliable than PDF" recommendation, file cards (matched profile name, account label, date range, row count, health badge: all checks pass / warnings / new statement / low-confidence "Looks like Meridian Bank savings, is that right?" / "layout seems to have changed, Update mapping"), a "Clear sessions" control always visible, "Deletes in 5 days" marker on an old session, a duplicate-merge notice ("3 rows merged from overlapping files, undo").
2. **Review (split view)**: source on the LEFT (rendered PDF page with zoom/page nav OR raw CSV grid), extracted table on the RIGHT, a selected row highlighted on both sides, rows with warning flags, an edited row, an excluded row still visible, summary bar (rows, date range, money in/out per currency, balance check pass/fail pointing to first failing row, count check).
3. **Mapping wizard, step 3 of 5 (Map fields)**: stepper (Basics, Locate data, Map fields, Test, Save); each source column with sample values matched to a standard field (date, post_date, description_raw, amount as debit+credit combo, balance, currency, reference, extra pass-through, unmapped), rule-based suggestion badges with confidence, a live preview table, date-format and sign-convention pickers, "every suggestion needs your confirmation" framing.
4. **Export**: date-range presets (Last full month, This month, Last 3 months, Year to date, All, Custom), included/excluded row counts per account, coverage warning ("No Summit Bank data after 25 Aug"), currency mode A (keep original, totals per currency never summed) vs mode B (convert to SGD: per-pair rate inputs shown in both directions "1 USD = 1.28 SGD / 1 SGD = 0.78 USD", export blocked until every pair has a rate), export preset picker matching the user's sheet columns, final check list, two primary actions: Download CSV, Copy for Sheets (with "skip header row" toggle).
5. **Settings**: profiles grouped by bank with versions (created date, which files used it), rename/duplicate/delete, backup/restore, saved rates, storage used by sessions vs settings, Delete everything (stronger confirm).

Sample data: invent realistic SG-flavoured fake rows (Meridian Bank savings, Summit Bank One, Riverside Bank 360, an Anchor Bank card in USD; merchants like NTUC FairPrice, Grab, Shopee, GIRO salary, Amazon.com USD). Use fake account numbers masked like "****4821". Amounts as plain numbers with 2 dp, negative = money out.

## Copy rules (strict, machine checked)
- No em-dashes anywhere in HTML or comments. Use commas, colons, or "to".
- Never use the words honest, honestly, genuine, genuinely, truthful, truthfully.
- No email addresses. Brand name is "Statement Bridge".
- Product voice: plain, confident, short. Say what the user can do next.

## Design quality bar
Nate has a sharp designer eye (he made Slow Hello and Wordbrush). Avoid generic SaaS template look, avoid cookie-cutter Bootstrap/Tailwind vibes, avoid purple gradients. Each option must be a distinct DIRECTION, not a recolour. Commit fully to the assigned direction. Respect a11y basics: real contrast, focus styles, semantic HTML, labels on inputs. Light and dark not required, pick the one that serves the direction. The logo slot: `<img src="../logos/logo-N.png">` at 28 to 40px in the header plus a larger showcase of it on an "About this design" panel at the top of the page (2 to 4 sentences: the direction, why it fits spreadsheet budgeters, one thing you'd want Nate to notice). If the logo file is missing, the layout must not break (set width/height, alt text).

Also write `designs/option-N/NOTES.md`: direction name, palette (hex), type choices, 3 key layout decisions.

Do all work yourself, foreground only, do not spawn agents, do not wait on anything. When done, run: `grep -rn "em-dash-placeholder" designs/option-N; grep -rniE "honest|genuine|truthful" designs/option-N` and fix any hits. Finish with a 5-line summary.
