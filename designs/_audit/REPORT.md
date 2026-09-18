# Statement Bridge design audit

Method: served designs/ locally, screenshotted each option's 5 screens at 1440x1000 (Playwright + Chromium), plus Review at 1024x1000, then read every screenshot and grepped for em-dashes and banned words.

## Option 1, "The Ledger"
Cream ledger paper, serif headings, monospace tabular numbers, red/green ink only. Review screen is the strongest in the set: balance-check row points to the first failing row, edited/excluded/flagged rows all visible at once, selected row highlights on both source and table. Weak point: the About panel leaves a big empty right column on every screen (cosmetic, not fixed since it is a direction choice, not a defect). Defects fixed: none found.

## Option 2, "The Console"
Dense charcoal, keyboard-first, amber accent, visible key hints (J/K, X, E). All required Import health badges present (all pass, warnings, new statement, low-confidence "is that right", layout-changed), duplicate-merge notice with undo, 5-day delete marker. Mapping screen has live preview plus per-field confidence and confirm checkboxes. Defects fixed: at 1024px width the source PDF mock's Balance column was clipped past the visible edge with no way to tell it was cut off (fixed-size monospace text overflowing a fixed-width panel). Added a narrow-viewport font-size rule so the full statement mock fits at 1024px.

## Option 3, "The Guide"
Calm teal, one-question-at-a-time mapping wizard with a real live preview, conversational copy. Defects fixed: row flags ("Amount edited", "Balance does not follow from previous row", "Excluded from export") were set to run inline right after the description text with no line break, so they visually mashed into the merchant name and the longest one got clipped at the table's right edge. Changed the flag elements from inline-flex to flex so they drop to their own line under the description; confirmed the "Balance does not follow" warning now fully readable instead of truncated.

## Option 4, "The Grid"
Strict Swiss 12-column grid, one grotesk typeface, black on white, single red accent for the two things that matter (warnings, Download/Copy). Numbers are genuinely tabular and aligned column to column across every screen; nothing decorative competes with the data. Weak point: identical visual rhythm on every screen means less immediate "which screen am I on" cueing than the others, though the numbered headers (01-05) compensate. Defects fixed: none found.

## Option 5, "The Vault"
Deep ink-green sidebar/header against a warm paper canvas, brass accent, persistent offline lock and storage meter visible on every screen regardless of which tab is open. Most complete Export screen in the set: both conversion directions shown side by side (foreign-to-SGD and SGD-to-foreign), per-account coverage table, full final checklist. Defects fixed: sample data used the operator's own real company name as a fake employer line in GIRO salary rows (3 occurrences: PDF mock, extracted table, and the mapping-wizard live preview). Replaced with a generic "Horizon Tech Pte Ltd" / plain "GIRO SALARY CREDIT" to keep the sample data fully fictitious.

## Checks run
- `grep -rn "—" designs/option-*`: no hits after fixes.
- `grep -rniE "honest|genuine|truthful" designs/option-*`: no hits in any index.html (the only match anywhere was in option-3's own NOTES.md, recording that this same grep had been run, not body copy).

## Recommendation

**Top pick: Option 5, "The Vault."**

Judging as the end user in the brief, a spreadsheet budgeter with 4 accounts who maps a new format once and then does a fast monthly import: the job has two very different modes, a rare careful one-time mapping session and a frequent low-attention monthly repeat, and this option is the only one that visibly designs for both. The persistent sidebar keeps Import/Review/Map/Export/Settings, the offline lock, and the storage meter in view no matter which screen is open, so a monthly user never loses their place or wonders whether their bank data left the device. The Export screen is the most trustworthy of the five for a multi-currency household (SGD plus a USD card): it is the only option that prints the exchange rate in both directions side by side without abbreviation, which matters when eyeballing whether a rate looks right before trusting a converted total. The health badges and "layout seems to have changed" messaging on Import read like plain warnings rather than jargon, fitting someone comfortable with Sheets but not code. Its mapping wizard is exactly as guided as Option 3's (one field at a time, live preview, nothing auto-confirmed) so it does not trade away first-time friendliness to get the monthly-use polish.

Runner-up: Option 2, "The Console." The keyboard shortcuts (J/K, X, E, Cmd+Enter) are a genuinely good fit for a repeat monthly user who will eventually want to move through a review without touching the mouse, and the resizable split view is a nice touch for reviewing a real PDF. It loses to Option 5 mainly on the first-mapping experience: a dense dark keyboard-first console is a slightly colder welcome for someone doing this for the very first time, even though it rewards them once they are fluent.

Option 1 and Option 4 are both excellent at the one-time reconciliation task (ledger-style balance and tabular Swiss grid respectively) but neither does anything special for the recurring monthly case beyond what the others already do, so they rank below 5 and 2 for this user. Option 3 is the friendliest for a first-time user but is the least distinctive for the "2-minute monthly import" half of the job.
