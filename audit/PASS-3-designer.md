# Pass 3 — Picky product designer

Real unpacked extension, bundled headless Chromium, `dev/designer-pass3.mjs`. Full-page screenshots at 1440 and 1280 in `audit/pass3/designer-*.png`.

Note on the "almost ready" fixture: `summit_grouped_2line_image.pdf` was probed directly (confirm-a -> "Yes, looks right" -> save) and comes back clean in this build — badge-ok, warn-count 0, no decision rows (`designer-04a-home-summit-image-saved-*.png`). It is not the flagged/quick-look case the task names. To still audit the "N rows need a quick look" state and its table, I used a synthetic CSV (auto-matches the built-in Meridian Bank profile, one duplicated transaction row) which reliably produces it — this is also where the app's own copy says "Almost ready" verbatim (`designer-04b-home-almost-ready-quicklook-*.png`), confirming the fixture note above is a real gap between the task's expectation and current behavior, not a script bug.

## Screens covered
Home: empty, processing, ready, almost-ready/quick-look (`01`–`04b`). Export sheet: closed, open, customise panel (`05`–`07`). Setup: confirm A, confirm B ("What's wrong?"), full wizard Map fields (`08`–`10`). Setup C (name/save) (`11`). Check a statement / review table (`12`). Gear dropdown, Statement types (`13`–`14`). Settings, How it works (`15`–`16`). Report a problem sheet (`17`). Onboarding 1–3 (`19`–`21`).

## Score table (1–5, all screens; only screens with a defect are itemized below)

| Screen | Easy | Works | Depth | Made |
|---|---|---|---|---|
| Home empty | 5 | 5 | 4 | 3 |
| Home processing | 5 | 5 | 4 | 4 |
| Home ready | 5 | 5 | 4 | 4 |
| Home almost-ready / quick-look | 4 | 5 | 4 | 3 |
| Export sheet closed | 5 | 5 | 4 | 4 |
| Export sheet open | 4 | 5 | 5 | 3 |
| Export customise | 4 | 4 | 5 | 3 |
| Setup confirm A | 5 | 5 | 4 | 4 |
| Setup confirm B | 5 | 5 | 3 | 4 |
| Setup Map fields (detailed) | 4 | 5 | 5 | 4 |
| Setup C (name/save) | 5 | 5 | 3 | 3 |
| Check a statement | 4 | 5 | 5 | 4 |
| Gear dropdown | 5 | 5 | 4 | 4 |
| Statement types | 5 | 5 | 4 | 4 |
| Settings | 5 | 5 | 5 | 4 |
| How it works | 5 | 5 | 4 | 3 |
| Report a problem | 5 | 5 | 5 | 4 |
| Onboarding 1–3 | 5 | 5 | 4 | 4 |

## Top 10 defects, ranked

1. **"Report a problem" FAB is `position:fixed` and overlaps content once a screen scrolls past one viewport** — on Export open/customise (`designer-06-export-open-1280.png`) it sits directly over the accounts table's Check/Set up again/Remove row at 1280w. Fix: dock it inside the page flow (footer) on tall screens, or give it a scroll-aware offset instead of a fixed viewport corner.
2. **"Almost ready" decision card duplicates the flagged row's data** — the "FROM YOUR FILE" snippet already states amount/date/description, and the identical row repeats one line below inside "Preview of what will be copied" (`designer-04b`). Fix: dim or badge the row in the preview table instead of restating it verbatim in the card above.
3. **No page title on Settings and How it works** — both open straight into an intro sentence with no `<h1>`-weight heading, while Statement types, Check-a-statement's header strip, and Home all lead with a bold title (`designer-15-settings-1440.png`, `designer-16-how-it-works-1440.png`). Fix: add a matching bold heading to both screens.
4. **Export "Customise" column chips didn't visually confirm a click during this run** — clicking the "Balance" chip in `export_sheet_states` produced no visible toggle in `designer-07-export-customised` (looks identical to `06`). Worth a manual click-through to confirm chip state actually flips; if it's a real no-op, that's a dead control.
5. **Huge dead space below the card on every near-empty screen** — Home empty, onboarding screens 1–3, and Setup C ("Name this statement") all leave 60–70% of the viewport as flat background below a top-anchored card (`designer-01-home-empty-1440.png`, `designer-11-setup-c-1440.png`, `designer-19` through `21`). Fix: vertically center these single-card screens instead of pinning to the top.
6. **Raw-file preview dates vs. extracted-table dates disagree in format on the same screen** — Check a statement shows `01/06/2026` in the source-table pane and `2026-06-01` in "Extracted transactions" directly below it (`designer-12-check-a-statement-1440.png`). Intentional (source vs. normalized) but nothing on-screen tells a first-time user why the two dates for the same row look different — a one-word caption ("as read" / "normalized") would remove the doubt.
7. **CSV/file-type badge floats oddly beside the name field on Setup C** — the small bordered "CSV" pill sits mid-height next to the input with no baseline alignment to the label or button below it (`designer-11-setup-c-1440.png`). Fix: align it to the input's baseline or move it inside the input as a suffix.
8. **"From your file" snippet box height doesn't match its two-line neighbor** — in the quick-look decision row, the monospace snippet box and the "date · description · amount / reason" text block are visibly different heights, leaving uneven whitespace at the bottom of the shorter one (`designer-04b-home-almost-ready-quicklook-1440.png`). Fix: vertically center both, or force equal min-height.
9. **Export Settings section uses six unstyled all-caps labels with no card/rule grouping** (DATE RANGE, FILTER USING, YOUR ACCOUNTS, CURRENCY, COLUMNS, EXPORT DATE FORMAT/MONEY DIRECTION) stacked in one long flow with only whitespace as a separator (`designer-06-export-open-1440.png`). Works, but reads as a settings dump rather than a designed panel — group into 2–3 visually bounded cards.
10. **Confirm B ("What's wrong?") is four big empty-feeling option cards on an otherwise blank screen** — functionally fine (Depth is appropriately hidden), but the tiles carry no icon or example text, making the screen feel like a placeholder rather than a finished step (`designer-09-setup-b-1440.png`). A short one-line example under each label would raise it from "works" to "made."

Everything else checked clean: date format is consistently ISO `YYYY-MM-DD` between Home ready, Almost-ready, Map-fields preview, and Check-a-statement's extracted table; number formatting (2 decimals, signed) is consistent across Home, Setup confirm A, Map fields preview, and Check-a-statement; table columns are consistently left-aligned for Date/Description and right-aligned for Amount everywhere, with no centered text found in any table.
