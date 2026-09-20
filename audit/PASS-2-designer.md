# Pass 2 — Picky product designer

Screens audited as they're captured. Scores 1-5 on Easy / Works / Depth / Made. Anything under 4 is a defect below with a concrete fix.

## Screens covered so far

### Home — empty (designer-01-home-empty-{1440,1280,1024})
Easy 5 / Works 5 / Depth 4 / Made 4

- Defect (Made, minor): huge dead space below the dropzone at all three widths — the page reads as a mostly-empty off-white field with content clinging to the top third. Fix: cap the content column's vertical position with a max-height wrapper that centers it in the viewport (or vertically center the whole `.home` column), so empty Home doesn't look unfinished on a normal laptop screen.
- Defect (Made, minor): "Report a problem" pill floats bottom-right, disconnected from the header/footer system — no other element anchors there. Fix: move it into the header (next to the gear) or a real footer bar, not a floating pill with its own corner.

### Home — processing (designer-02-home-processing-1440)
Easy 5 / Works 5 / Depth 4 / Made 4
Same dead-space note as empty state (transient, lower severity).

### Home — ready, healthy CSV (designer-03-home-ready-1440)
Easy 5 / Works 5 / Depth 4 / Made 5
Clean. Minor duplication: "5 transactions from 1 statement · 1 Jun 2026 to 20 Jun 2026" directly above the table, then "Preview of what will be copied" as a second label before headers — the second label is redundant given the panel is already titled "Your transactions are ready." with the count line right there. Fix: drop the "Preview of what will be copied" line, or fold it into the count line.

### Setup — OCR image PDF confirm-first, Screen A (designer-04-decisions-ocr-image-pdf-1440)
Easy 5 / Works 5 / Depth 4 / Made 4
- Defect (Made): "← Back to files" renders as a full-width bordered button, the same visual weight as the primary "Yes, looks right" CTA below. A back-navigation link should never compete with the primary action. Fix: make it a small top-left text/icon link, not a full-width button.
- Missing (Depth/Works, minor): no indication this is a setup step for a *new, unmatched* bank (no bank name, no "Setting up" label) — a first-timer landing here after "Set up" has no confirmation of what they're naming/configuring yet. Fix: add a small eyebrow like "Setting up a new statement type" above the question.

### Home — decisions, CSV flagged row (designer-05-decisions-csv-flagged-1440)
Easy 4 / Works 3 / Depth 4 / Made 4
- Defect (Works): state contradiction — the statement card reads "Needs a quick look" (implies action required, use amber attention styling) while the panel directly below is titled "Your transactions are ready." with working Copy/Download buttons already enabled. A first-timer can't tell if they're safe to copy yet or must resolve the flag first. Fix: either grey out/disable copy until the flagged row is resolved, or soften the ready-panel heading when a decision is pending ("Ready, but 1 row needs a check first").
- Defect (Easy/Made): the "quick look" card's left chip shows the raw CSV line verbatim in monospace (`03/06/2026 GIRO SP SERVICES 120.00 4834.80`) with no column labels — reads as a debug dump, not something a non-technical person parses at a glance. Fix: either drop the raw-row chip for CSV sources (the parsed line to the right already has the readable version) or label the raw chip "Original line" so its purpose is clear.
- Duplication (minor): the statement card's "Needs a quick look" link and the amber banner immediately below it both say the same thing — one is redundant. Fix: the statement card link is enough; drop the repeat, or make the banner the only place it's said and remove the per-card link.

### Export sheet — closed (designer-06-export-closed)
Same as Home ready above (identical state). No new issues.

### Export sheet — open, "Adjust what's exported" drawer (designer-07-export-open-1440)
Easy 4 / Works 5 / Depth 5 / Made 4
- Copy inconsistency (minor): summary line reads "Original currencies (SGD)" — "currencies" is plural but a single currency code follows in parens, and the mode selected is "Keep each account's currency" (singular per account). Reads like a contradiction on a multi-account file. Fix: "Original currency (SGD)" when there's one account, or drop the parenthetical entirely since the accounts table already shows currency per row.
- The Actions column ("Check · Set up again · Remove") packs three text links together with only a couple of px between — at a glance they read as one phrase. Fix: give them a visible separator (a middot or vertical rule) matching the pattern already used elsewhere in the app (e.g. the "5 transactions · 1 Jun–20 Jun" middot).

### Export sheet — Customise open (designer-08-export-customised-1440)
Easy 4 / Works 3 / Depth 5 / Made 4
- Possible dead control (Works, needs confirmation): clicking a column chip in the opened Customise row ("Balance") produced no visible change — the "Simple" preset card stayed selected and the "Columns: Simple" summary line above didn't update. Could not confirm whether the click missed the hit target or the control itself doesn't wire up column toggles to the summary/preset-selection state. Fix: verify the chip's click handler updates both the preset card selection and the "EXPORT SETTINGS" summary line; if it's a hit-target issue, enlarge the chip's clickable area.
- Otherwise a strong depth example: the whole drawer (date range chips, per-account table, currency mode, layout presets, then a collapsed Customise) is real progressive disclosure — advanced controls stay hidden until asked for.

### Setup — Screen A repeat, second fixture (designer-09-setup-a-1440)
Same defects as the first Screen A capture (full-width Back button). No new issues.

### Setup — Screen B, "What's wrong?" (designer-10-setup-b-1440)
Easy 5 / Works 5 / Depth 5 / Made 5
Clean 2x2 card grid, no issues found.

### Setup — detailed step, Map fields (designer-11-setup-detailed-map-fields-1440)
Easy 3 / Works 4 / Depth 5 / Made 3
- Defect (Made/hierarchy): three navigation/progress bars stacked at once — the outer Drop/Read/Copy tracker, a full-width "← Back to files" bar, and the inner Basics/Locate data/Map fields/Test/Save stepper — before any content appears. Fix: collapse to one system; the outer 3-step tracker could hide while the wizard's own 5-step stepper is active, and "Back to files" folded into a small icon-link inside that stepper's row.
- Defect (Made, duplication): the words "MAP FIELDS" appear three times on one screen — the stepper's own label, a bold section heading right below it, and again centered in the sticky footer. Fix: keep the section heading, drop the repeat in the footer (the footer's center slot can be empty or show a one-line status instead).
- Defect (copy/jargon): each mapped field shows a small gray technical key under the dropdown ("date", "description_raw", "amount") — these are internal field identifiers, not something a first-time or even returning non-technical user needs to see. Fix: remove the raw key captions, or replace with a plain-language hint ("this becomes the Date column").
- "SIGN CONVENTION IN SOURCE" is dense financial/technical jargon for a first-timer, though it is appropriately tucked into the detailed step rather than the fast path — acceptable given this is the explicitly "detailed" step, not a hierarchy defect on its own, but the label itself could be plainer ("How amounts show + and -").

### Setup — Screen C, "Name this statement" (designer-12-setup-c-1440)
Easy 5 / Works 5 / Depth 4 / Made 5
Clean, single input + single CTA, no issues.

### Check a statement (designer-13-check-a-statement-1440)
Easy 4 / Works 5 / Depth 5 / Made 4
- Inconsistency (Made): back navigation here is a small "← Back" text link in the header — a third distinct back-navigation style in the app (vs. the wizard's full-width "Back to files" bar, vs. Statement types' identical small header link, which at least matches this one). Fix: standardize on the small header-link style everywhere; drop the full-width wizard bar (see Map fields defect above).
- Strong depth screen otherwise: raw source table next to parsed/extracted table, per-row Edit/Exclude, inline "Add missing row" — exactly the right amount of power tucked into a screen a first-timer never needs to open.
- Minor: "Side by side" toggle is greyed out/disabled at 1440px width where there'd be room for it; unclear why side-by-side is unavailable this wide. Worth a functional check — if it's not actually implemented yet, the control shouldn't be visible.

### Gear dropdown (designer-14-gear-dropdown-1440)
Easy 5 / Works 5 / Depth 5 / Made 5
Clean menu, destructive "Clear statements" isolated below a divider. No issues.

### Statement types (designer-15-statement-types-1440)
Easy 5 / Works 5 / Depth 5 / Made 5
Well-organized grouped list (bank > versions > entries), consistent card styling. No issues found.

### Settings (designer-16-settings-1440)
Easy 4 / Works 4 / Depth 5 / Made 3
- Duplication (Made): "Report a problem" exists twice on this single screen — once as the persistent floating pill (bottom-right, present on every screen) and again as a button inside the Debugging row. Fix: drop the in-page button here and let the floating pill be the one entry point, or remove the floating pill in favor of the Settings + gear-menu entries and keep the report affordance persistent-but-single some other way (e.g. only the floating pill, everywhere).
- Good hierarchy otherwise: destructive "Erase everything" is visually isolated in a red-tinted card with a type-to-confirm gate — exactly the right amount of friction for the most dangerous action in the app.

### How it works (designer-17-how-it-works-1440)
Easy 5 / Works 5 / Depth 5 / Made 3
- Duplication (Made): "← Back" appears twice — the header's small link and an identical full standalone "← Back" button directly below it, both doing the same thing, stacked with no other content between them. Fix: remove one; the in-page button is redundant with the header link.
- Copy is a genuine standout: honest, specific, plain-language explanation of local-only processing, no AI, and data retention — matches the "handmade indie" voice better than any other screen.
- Minor redundancy: "Show the welcome tour again" is now offered in three places (gear menu, Settings, and here) — acceptable as contextual convenience, not flagged as a defect on its own.

### Report side sheet (designer-18-report-sheet-1440)
Easy 4 / Works 5 / Depth 3 / Made 4
- Defect (Depth): "WHAT WILL BE SENT" shows a raw JSON payload by default (`{"kind": "statement-bridge-problem-report", ... "userAgent": "Mozilla/5.0 ..."}`) to every user who opens this sheet — this is implementation detail a non-technical person can't evaluate and doesn't need to see up front. Fix: show a plain-language bullet summary by default ("Your message · No file selected · Debug log included, 0 entries · Browser and extension version") and put the raw JSON behind a collapsed "View raw data" disclosure for anyone who wants to verify it.
- Otherwise well-scoped: single textarea, one "which file" dropdown, one checkbox, two clearly-weighted buttons (primary "Copy report and open email" vs. secondary "Copy debug log") with a plain-language caption explaining the difference.

### Onboarding (designer-19/20/21-onboarding-{1,2,3})
Easy 5 / Works 5 / Depth 4 / Made 5
The best-made surface in the app: a real annotated screenshot of the actual Chrome toolbar/puzzle-piece menu (slide 1), three clean icon cards for Drop/Read/Copy (slide 2), plain task-oriented copy (slide 3). Progress dots track position correctly.
- Minor inconsistency: slide 2 puts Back (left) and Next (right) side-by-side; slide 3 stacks a full-width primary "Open Statement Bridge" above a separate left-aligned Back button. Not a real defect (final-slide CTA deserves emphasis) but worth a deliberate note rather than incidental drift.

---

## Score table

| Screen | Easy | Works | Depth | Made |
|---|---|---|---|---|
| Home — empty | 5 | 5 | 4 | 4 |
| Home — processing | 5 | 5 | 4 | 4 |
| Home — ready (healthy CSV) | 5 | 5 | 4 | 5 |
| Setup — Screen A (OCR image PDF) | 5 | 5 | 4 | 4 |
| Home — decisions (CSV flagged row) | 4 | 3 | 4 | 4 |
| Export sheet — closed | 5 | 5 | 4 | 5 |
| Export sheet — open | 4 | 5 | 5 | 4 |
| Export sheet — customised | 4 | 3 | 5 | 4 |
| Setup — Screen A (repeat) | 5 | 5 | 4 | 4 |
| Setup — Screen B | 5 | 5 | 5 | 5 |
| Setup — detailed (Map fields) | 3 | 4 | 5 | 3 |
| Setup — Screen C | 5 | 5 | 4 | 5 |
| Check a statement | 4 | 5 | 5 | 4 |
| Gear dropdown | 5 | 5 | 5 | 5 |
| Statement types | 5 | 5 | 5 | 5 |
| Settings | 4 | 4 | 5 | 3 |
| How it works | 5 | 5 | 5 | 3 |
| Report side sheet | 4 | 5 | 3 | 4 |
| Onboarding (1-3) | 5 | 5 | 4 | 5 |

## Top 10 defects, ranked

1. Map fields step stacks three navigation systems at once (outer Drop/Read/Copy tracker, full-width "Back to files" bar, inner 5-step stepper) — collapse to one system. `designer-11-setup-detailed-map-fields-1440.png`
2. "MAP FIELDS" label repeated three times on one screen (stepper, heading, sticky footer) — drop the footer repeat. `designer-11-setup-detailed-map-fields-1440.png`
3. Technical field keys (`date`, `description_raw`, `amount`) leak into the Map fields UI under each dropdown — remove or replace with plain language. `designer-11-setup-detailed-map-fields-1440.png`
4. Decisions state contradiction: statement card says "Needs a quick look" while the panel below is already titled "Your transactions are ready." with working Copy/Download — disable copy until resolved, or soften the heading. `designer-05-decisions-csv-flagged-1440.png`
5. "Report a problem" duplicated on the Settings screen (floating pill + in-page button) — keep one. `designer-16-settings-1440.png`
6. "← Back" duplicated on How it works (header link + identical full button directly below) — remove one. `designer-17-how-it-works-1440.png`
7. Report side sheet shows a raw JSON payload by default under "What will be sent" — replace with a plain-language summary, raw JSON behind a disclosure. `designer-18-report-sheet-1440.png`
8. Wizard confirm screens' "← Back to files" renders as a full-width button with the same weight as the primary CTA — shrink to a small header link, matching Check-a-statement/Statement types. `designer-04/09/10-*.png`
9. Raw CSV line shown verbatim in monospace on the CSV decision card, unlabeled — label it "Original line" or drop it for CSV sources. `designer-05-decisions-csv-flagged-1440.png`
10. Clicking a column chip in the Export sheet's Customise row didn't visibly update the "Columns: Simple" summary or preset selection — verify the control is wired up (possible dead control). `designer-08-export-customised-1440.png`

Screenshots: `/Users/nathanaeldesmond2026/Desktop/StatementBridge/audit/pass2/designer-*.png` (1440/1280, plus 1024 for Home empty).
