// Generates test/fixtures/northwind_transaction_history_flags_source.pdf: same
// synthetic Northwind Bank "Transaction History" layout as
// gen-northwind-transaction-history-sample.mjs, but deliberately carrying three
// flaggable rows for the wizard Test step's "Looks right"/"Fix"/"Exclude"
// verification (Fix 5):
//   - a malformed date-group ("32 Sep 2026", no such day) -> unparseable_date
//   - an amount with no sign glyph at all ("SGD 1,200.00", no leading "-")
//     -> matchAmountLine finds no marker to resolve -> sign_unclear. (A
//     letter-for-digit trick, "SGD-1,2O0.00" with a capital O for 0, was
//     tried first but Tesseract's LSTM model reads that O as a clean "0" on
//     this rendering - no real ambiguity survives to the extractor, so the
//     flag never fired end to end. A missing sign is unclear on ANY read,
//     OCR or real text layer, so this fires deterministically.)
//   - an exact repeat of one transaction (same date/description/amount)
//     -> possible_duplicate
// Rasterized separately (see gen-northwind-transaction-history-flags-image.mjs,
// mirroring gen-northwind-transaction-history-image.mjs) into an image-only PDF so
// the auto-OCR path is what actually produces these flags end to end.
// Run: node test/fixtures/gen/gen-northwind-transaction-history-flags.mjs
import fs from 'node:fs';
import { buildTextStream, buildSinglePagePdf } from './pdflib.mjs';

const header = [
  { y: 760, size: 12, text: 'Northwind Bank' },
  { y: 744, text: 'JOHN SAMPLE LEE' },
  { y: 730, text: '456 Example Street, #02-02, Singapore 654321' },
  { y: 712, size: 11, text: 'Northwind Current Account' },
  { y: 696, text: 'Account No: 987-6-543210' },
  { y: 680, text: 'Available Balance: SGD 5,000.00    Ledger Balance: SGD 5,000.00' },
  { y: 656, size: 11, text: 'Transaction History' },
  { y: 640, text: 'September 2026' },
];

const groups = [
  {
    date: 'Yesterday, 15 Sep 2026',
    txns: [
      { desc: 'BAT 2C2*LAZADA Singapore SGP 12SEP 4628-XXXX', amount: 'SGD - 20.83', type: 'Point-of-Sale Transaction · POS' },
      // No sign glyph at all: matchAmountLine finds an amount but no marker -> sign_unclear.
      { desc: 'GRAB* A-9988776 SINGAPORE SG', amount: 'SGD 1,200.00', type: 'Point-of-Sale Transaction · POS' },
    ],
  },
  {
    // Malformed day (32nd of September doesn't exist) -> unparseable_date.
    date: '32 Sep 2026',
    txns: [
      { desc: 'NTUC FAIRPRICE FINEST SGP', amount: 'SGD - 48.20', type: 'Point-of-Sale Transaction · POS' },
    ],
  },
  {
    date: '12 Sep 2026',
    txns: [
      { desc: 'SHOPEE SG *8823', amount: 'SGD - 216.30', type: 'Point-of-Sale Transaction · POS' },
      // Exact repeat of the row above (same date/description/amount) -> possible_duplicate.
      { desc: 'SHOPEE SG *8823', amount: 'SGD - 216.30', type: 'Point-of-Sale Transaction · POS' },
    ],
  },
];

const placements = [];
for (const l of header) placements.push({ x: 50, y: l.y, text: l.text, size: l.size });

let y = 610;
for (const group of groups) {
  placements.push({ x: 50, y, text: group.date });
  y -= 18;
  for (const txn of group.txns) {
    placements.push({ x: 50, y, text: txn.desc });
    placements.push({ x: 430, y, text: txn.amount });
    y -= 14;
    placements.push({ x: 50, y, text: txn.type });
    y -= 18;
  }
  y -= 6;
}

placements.push({ x: 50, y: y - 10, text: 'End of Transaction History' });
placements.push({ x: 500, y: 15, text: 'Page 1 of 1' });

const content = buildTextStream(placements);
const pdf = buildSinglePagePdf(content);
const out = new URL('../northwind_transaction_history_flags_source.pdf', import.meta.url);
fs.writeFileSync(out, pdf, 'latin1');
console.log('wrote', out.pathname, pdf.length, 'bytes');
