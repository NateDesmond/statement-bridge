# Statement Bridge

Turn bank statements into clean spreadsheet rows, entirely on your device.

Drop a CSV your bank exported, or a PDF (text-based or scanned), and
Statement Bridge turns it into one clean table of transactions you can copy
into Google Sheets or download as a CSV. It is a Chrome extension (Manifest
V3) that works completely offline.

Live site: https://statementbridge.urbanalgorithm.com

## The privacy promise

- Everything runs on your device. No network requests, no host permissions,
  and `connect-src 'none'` in the extension's Content Security Policy.
- Your statements never leave your computer. Nothing is uploaded, nothing
  is logged to a server, there is no account and nothing to sign in to.
- Scanned PDFs are read with on-device text recognition (Tesseract.js,
  vendored - not a network OCR service).
- If you ever report a problem, the debug log you can attach is anonymised
  first: amounts are masked to their shape, descriptions/merchants/account
  numbers are stripped before anything is copied for you to send.

You can verify all of this yourself: it's the same code you're reading.

## Install unpacked

1. `chrome://extensions`
2. Enable Developer mode
3. "Load unpacked", point at this repo's `extension/` folder
4. Click the extension icon - it opens `workspace.html` in a new tab

## Run tests and the gate

```
cd extension
node --test test/*.test.js     # unit tests
node dev/gate.mjs --fast       # unit tests + banned-word sweep + network sweep + real-extension e2e
node dev/gate.mjs              # the above, plus the slower OCR/corpus recall audits
```

The gate needs the bundled Chromium that ships with `playwright` (installed
via `extension/dev`'s own `package.json`) - it never touches your regular
Chrome.

## How statement types work

A "statement type" (a profile, internally) describes one bank export
shape: how to recognize it again (header text, preamble keywords, a PDF
anchor phrase, or a filename pattern), how to parse it (header row,
delimiter, PDF column positions), a column-to-field mapping, the date
format, number format, and sign convention. You set one up once per bank
export, through a short wizard; every later statement from the same source
is then recognized automatically.

A handful of starter statement types ship in
`extension/src/core/builtin-profiles.js`, built against fictional example
banks (Meridian Bank, Harbour Card, Riverside Bank, Summit Bank, Anchor
Bank, Lattice Bank, Northwind Bank). They exist to demonstrate real parsing
capabilities - grouped PDF layouts, tabbed CSV parsing, CR/DR markers,
debit/credit column pairs - without shipping a real bank's name or export
layout as a "default". See `docs/PRD-SUMMARY.md` for the product overview
and `docs/PROFILE-SCHEMA.md` for the exact JSON shape.

## Adding a new bank

You don't need to touch the code to add support for your own bank: drop a
statement and walk the wizard once. If you're contributing a new *parsing
capability* the app doesn't have yet (a layout shape none of the built-ins
cover), see `CONTRIBUTING.md`.

## Repository layout

```
extension/   the Chrome extension itself: src/, test/, dev/ (harness + release gate)
site/        the static marketing site (statementbridge.urbanalgorithm.com)
designs/     visual design mockups and logo source files
store/       Chrome Web Store listing copy and screenshots
docs/        product summary and the statement-type JSON schema
```

## Contributing

See `CONTRIBUTING.md`.

## Security

See `SECURITY.md` to report a vulnerability privately.

## License

GPLv3 - see `LICENSE`.
