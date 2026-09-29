# Pass 4: consistency and ease (2026-09-30)

Shots: audit/pass4-shots (ft-* first-timer, rt-* returner, dz-* designer sweep, kb-* keyboard). Read at 1440.

## Scores (Easy / Works / Depth / Made)
| Screen | E | W | D | M | Note |
|---|---|---|---|---|---|
| Onboarding | 5 | 5 | 5 | 5 | Pin illustration reads instantly |
| Home empty | 5 | 5 | 5 | 5 | One action, one sentence |
| New bank statement card | 4 | 5 | 5 | 4 | File row status and card repeat the same words |
| Confirm A | 5 | 5 | 5 | 4 | Heading dates were ISO while the table used 15 Sep 2026 |
| Confirm B | 5 | 5 | 5 | 5 | |
| Focus: dates / amounts / rows | 4 | 4 | 5 | 3 | No heading on the branch screens; Locate grid capped at 640px so only 2 of 5 columns showed |
| Name screen | 5 | 5 | 5 | 5 | |
| Result card | 5 | 5 | 5 | 4 | "on the page" for a CSV; toast lands on top of the table |
| Adjust what's exported | 4 | 5 | 5 | 4 | "normalised ... internally" jargon |
| Report a problem | 5 | 5 | 5 | 5 | |
| Statement types | 4 | 5 | 5 | 4 | "Map a new statement"; version date in 9/29/2026 |
| Settings | 5 | 5 | 5 | 5 | |
| How it works | 5 | 5 | 5 | 4 | Password note styled like a text input |
| Full wizard Test step | 4 | 5 | 5 | 4 | "rows parsed", "Flags: none" |
| Review | 4 | 5 | 5 | 4 | Account column wraps on every row |

## Ease
First-timer: drop, Set up, Yes, Save and finish, Copy = 4 clicks after the drop; nothing to hesitate on. Image PDF shows page progress and Cancel. Returner: 3 files, one new bank interrupts with confirm-first (expected), otherwise drop then Copy. Keyboard: preview region and buttons reachable, no trap seen.

## Defects, ranked (all OBSERVED unless noted)
1. P2 Confirm A heading date format (ft-04, ft-10). Fixed: formatShortDate in the heading.
2. P2 Focus branch screens had no heading (dz-07-branch-*). Fixed: each branch passes a question heading.
3. P2 Locate grid showed only columns A and B (dz-07-branch-rows). Fixed: #confirm-focus max-width 960px.
4. P2 Copy toast covers table rows (rt-06, kb-02). Fixed: toast sits 24px from the viewport bottom.
5. P2 "Every transaction on the page" for CSV (ft-06, dz-03). Fixed: "in your statement".
6. P3 "Copied 82 rows" vs "transactions" everywhere else (rt-06). Fixed.
7. P3 "Map a new statement" (dz-02-profiles). Fixed: "Set up a new statement".
8. P3 Version date "9/29/2026" (dz-02-profiles). Fixed: formatShortDate.
9. P3 Password note looked like an input (dz-02-how). Fixed: plain note.
10. P3 Test step "rows parsed" / "Flags: none" (dz-08-wizard-1-step-3). Fixed: "transactions read" / "Nothing needs a second look."
11. P3 "normalised before export ... internally" (ft-14). Fixed: plain sentence.
12. P3 "Preview: first 8 mapped rows" (dz-08). Fixed: "first 8 rows".
Open: file row status repeats the card title (P3); Review account column wraps (P3); amounts branch stacks two pickers unevenly (P3).
