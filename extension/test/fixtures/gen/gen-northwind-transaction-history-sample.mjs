// Generates test/fixtures/northwind_transaction_history_sample.pdf: an anonymised
// synthetic reproduction of the Northwind online banking "Transaction History" export
// layout (date-group lines, two-line transactions with a trailing amount and
// a joined type line). Fake name/address/account/merchants throughout.
// Run: node test/fixtures/gen/gen-northwind-transaction-history-sample.mjs
import fs from 'node:fs';
import { buildTextStream, buildSinglePagePdf } from './pdflib.mjs';

const header = [
  { y: 760, size: 12, text: 'Northwind Bank' },
  { y: 744, text: 'JANE SAMPLE TAN' },
  { y: 730, text: '123 Example Avenue, #01-01, Singapore 123456' },
  { y: 712, size: 11, text: 'Northwind Current Account' },
  { y: 696, text: 'Account No: 123-4-567890' },
  { y: 680, text: 'Available Balance: SGD 8,214.12    Ledger Balance: SGD 8,214.12' },
  { y: 656, size: 11, text: 'Transaction History' },
  { y: 640, text: 'September 2026' },
];

// Each group: a date-group line, then transactions of {desc, amount, type}.
const groups = [
  {
    date: 'Yesterday, 15 Sep 2026',
    txns: [
      { desc: 'BAT 2C2*LAZADA Singapore SGP 12SEP 4628-XXXX', amount: 'SGD - 20.83', type: 'Point-of-Sale Transaction · POS' },
      { desc: 'GIRO SALARY CREDIT ACME PTE LTD', amount: 'SGD + 4,200.00', type: 'Advice · ADV' },
    ],
  },
  {
    date: 'Monday, 14 Sep 2026',
    txns: [
      { desc: 'NTUC FAIRPRICE FINEST SGP', amount: 'SGD - 48.20', type: 'Point-of-Sale Transaction · POS' },
    ],
  },
  {
    date: '12 Sep 2026',
    txns: [
      { desc: 'GRAB* A-1928374 SINGAPORE SG', amount: 'SGD - 14.60', type: 'Point-of-Sale Transaction · POS' },
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
const out = new URL('../northwind_transaction_history_sample.pdf', import.meta.url);
fs.writeFileSync(out, pdf, 'latin1');
console.log('wrote', out.pathname, pdf.length, 'bytes');
