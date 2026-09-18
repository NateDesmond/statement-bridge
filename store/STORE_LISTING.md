# Chrome Web Store submission - Statement Bridge

Draft to paste into the Developer Console. Publisher: Urban Algorithm LLC
(display name "Urban Algorithm"). Non-trader. No email address on the
listing; support goes through the Urban Algorithm contact page.

Guardrails baked in: no em dashes, none of the banned AI-tell adjectives
in copy, no jargon ("statement type" not "profile", never "OCR" - "text
recognition"/"read with text recognition" instead), no personal name
anywhere.

---

## Product name (45 char max)
Statement Bridge

## Summary / short description (132 char max)
Turn bank statements (CSV or PDF) into a clean table you can paste into a spreadsheet. Runs on your device, no account.

## Category
Productivity

## Language (listing default)
English

---

## Detailed description

Statement Bridge reads the bank statement file you drop in - a CSV your
bank exported, or a PDF, even a scanned one - and turns it into one clean
table of transactions you can paste straight into a spreadsheet.

HOW IT WORKS
- Drop your statement. Statement Bridge reads it on your device: CSV and
  text PDFs directly, scanned PDFs with on-device text recognition.
- It shows you what it found before anything is final, so you can confirm
  the dates, amounts and rows look right.
- Copy the result into Google Sheets with one button, or download it as a
  CSV.

WORKS WITH
Any bank's CSV export, and PDF statements, text-based or scanned. Set a
bank's layout up once, about a minute, and every statement after that from
the same bank is recognized automatically.

PRIVATE BY DESIGN
- Everything runs on your device. Your statements never leave your
  computer, and nothing is uploaded anywhere.
- No account, no sign-in.
- No server involved at any point in reading your statement.

YOU ARE IN CONTROL
- A quick confirmation step before anything is copied, so you always see
  what was read before you trust it.
- Anything unclear gets a quick look, with the page it came from right
  next to it, and two plain choices: looks right, or fix it.
- Choose a date range and which statements to include before you copy.

WHAT IT WILL NOT DO
Reading a scanned PDF depends on how clear the scan is, and an unusual
statement layout may need a manual setup step the first time. Statement
Bridge does not connect to your bank or move money. It only reads files
you give it.

---
Statement Bridge is made by Urban Algorithm, an independent studio. It is
not affiliated with, endorsed by, sponsored by, or approved by any bank
or by Google LLC. Google Sheets is referenced only to describe how the
copied table is used.

---

## Single purpose (required field)
Read a bank statement file (CSV or PDF) the user provides and turn it
into a clean transaction table the user can copy or download, entirely
on the user's own device.

## Permission justifications (required, per permission)

- storage: Save the user's settings and the statement layouts ("statement
  types") they set up, so a statement from the same bank is recognized
  automatically next time. All storage is local to the user's browser.

- unlimitedStorage: The user's dropped statements and past exports are
  kept locally on their device (so recent statements and their history
  are available without re-uploading anything); this removes the default
  storage quota so larger statement files and a longer history fit.

- clipboardWrite: "Copy to Google Sheets" copies the finished transaction
  table to the clipboard so the user can paste it into a spreadsheet.

- No host permissions requested: Statement Bridge does not read or run on
  any website. It only reads the files the user drops into it.

## Data usage disclosures (Privacy tab)
- Does the item collect or use user data? NO data is collected,
  transmitted, or sold. All processing happens on the user's own device.
- Personally identifiable information: No
- Health / financial / authentication / personal communications /
  location / web history / user activity: No to all. (Statement contents
  never leave the device, so nothing in them is transmitted either.)
- Remote code: No. All code is packaged in the extension; nothing is
  fetched at runtime.
- Certify compliance with the Developer Program Policies: Yes.

---

## Assets
- [x] Screenshots (1280x800), 5, in store/ (shot-1..shot-5.png), same set
      plus @2x in site/img/. Order: drop area, result with Copy to Google
      Sheets, quick-look decision card with a page snippet, confirm-first
      "Does this look right?" screen, pasted result in a spreadsheet.
- [x] Small promo tile 440x280: store/promo-small.png (logo + name on the
      Vault palette).
- [x] Marquee promo tile 1400x560: store/promo-marquee.png (same treatment).
- [x] Store icon: 128x128 already in extension/icons/icon128.png.
- [ ] The packaged .zip: the built extension/ directory. Confirm it loads
      unpacked before zipping.

## Pre-submit checklist
- [ ] Publisher display name set to "Urban Algorithm"
- [ ] Non-trader declared
- [ ] Version in manifest matches the zip
- [ ] Contact link on the listing points at the Urban Algorithm contact
      page (no email address published)
