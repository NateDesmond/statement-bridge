// Generates test/fixtures/northwind_transaction_history_3p.pdf: a 3-page version of
// the Northwind online banking "Transaction History" export layout (see
// gen-northwind-transaction-history-sample.mjs for the single-page original), with
// one date group's transactions split across the page 1/page 2 boundary (no
// repeated date-group header on page 2) so extractPdfPagesRows's multi-page
// concatenation is exercised by a real fixture, not just synthetic item
// arrays in test/pdf.test.js. Fake name/address/account/merchants throughout.
// Run: node test/fixtures/gen/gen-northwind-transaction-history-3p.mjs
import fs from 'node:fs';
import { buildTextStream, buildMultiPagePdf } from './pdflib.mjs';

const header = [
  { y: 760, size: 12, text: 'Northwind Bank' },
  { y: 744, text: 'JANE SAMPLE TAN' },
  { y: 730, text: '123 Example Avenue, #01-01, Singapore 123456' },
  { y: 712, size: 11, text: 'Northwind Current Account' },
  { y: 696, text: 'Account No: 123-4-567890' },
  // Deliberately does NOT end the line in a bare "CUR amount" (no sign): now
  // that core/pdf.js's matchAmountEnd treats a missing sign as positive (an
  // OCR-dropped "+" glyph fix, root-caused 2026-09-16), a header/balance
  // summary line ending that way would misparse as its own transaction row -
  // real bank statements avoid this collision by wording it differently
  // ("as of" or trailing the currency), which this fixture does too.
  { y: 680, text: 'Available Balance SGD 8,214.12 as of statement date' },
  { y: 656, size: 11, text: 'Transaction History' },
  { y: 640, text: 'September 2026' },
];

function place(placements, y0, lines) {
  let y = y0;
  for (const l of lines) {
    if (Array.isArray(l)) { for (const p of l) placements.push({ x: p.x, y, text: p.text }); }
    else placements.push({ x: 50, y, text: l });
    y -= l.dy ?? 18;
  }
  return y;
}

const page1 = header.map((l) => ({ x: 50, y: l.y, text: l.text, size: l.size }));
let y = 610;
// Date group 1: fully on page 1.
y = place(page1, y, ['Wednesday, 16 Sep 2026']);
page1.push({ x: 50, y, text: 'STARBUCKS COFFEE #4471 SGP' });
page1.push({ x: 430, y, text: 'SGD - 7.80' });
y -= 14;
page1.push({ x: 50, y, text: 'Point-of-Sale Transaction · POS' });
y -= 24;

// Date group 2: STRADDLES the page 1/2 break - the header and its first
// transaction land on page 1, its second transaction has no date-group
// header at all on page 2 (extractPdfPagesRows must still attribute it to
// this date, since the header never repeats).
y = place(page1, y, ['Tuesday, 15 Sep 2026']);
page1.push({ x: 50, y, text: 'BAT 2C2*LAZADA Singapore SGP 12SEP 4628-XXXX' });
page1.push({ x: 430, y, text: 'SGD - 20.83' });
y -= 14;
page1.push({ x: 50, y, text: 'Point-of-Sale Transaction · POS' });
page1.push({ x: 500, y: 15, text: 'Page 1 of 3' });

const page2 = [];
y = 760;
// Second transaction of the "15 Sep 2026" group, continued straight onto
// page 2 with no repeated date-group line above it.
page2.push({ x: 50, y, text: 'GIRO SALARY CREDIT ACME PTE LTD' });
page2.push({ x: 430, y, text: 'SGD + 4,200.00' });
y -= 14;
page2.push({ x: 50, y, text: 'Advice · ADV' });
y -= 24;

y = place(page2, y, ['Monday, 14 Sep 2026']);
page2.push({ x: 50, y, text: 'NTUC FAIRPRICE FINEST SGP' });
page2.push({ x: 430, y, text: 'SGD - 48.20' });
y -= 14;
page2.push({ x: 50, y, text: 'Point-of-Sale Transaction · POS' });
y -= 24;

y = place(page2, y, ['12 Sep 2026']);
page2.push({ x: 50, y, text: 'GRAB* A-1928374 SINGAPORE SG' });
page2.push({ x: 430, y, text: 'SGD - 14.60' });
y -= 14;
page2.push({ x: 50, y, text: 'Point-of-Sale Transaction · POS' });
page2.push({ x: 500, y: 15, text: 'Page 2 of 3' });

const page3 = [];
y = 760;
y = place(page3, y, ['10 Sep 2026']);
page3.push({ x: 50, y, text: 'SHOPEE SG *8823' });
page3.push({ x: 430, y, text: 'SGD - 216.30' });
y -= 14;
page3.push({ x: 50, y, text: 'Point-of-Sale Transaction · POS' });
y -= 18;
page3.push({ x: 50, y, text: 'CIRCLES.LIFE SGP' });
page3.push({ x: 430, y, text: 'SGD - 28.00' });
y -= 14;
page3.push({ x: 50, y, text: 'GIRO · RCP' });
page3.push({ x: 50, y: y - 20, text: 'End of Transaction History' });
page3.push({ x: 500, y: 15, text: 'Page 3 of 3' });

const pdf = buildMultiPagePdf([page1, page2, page3].map((p) => buildTextStream(p)));
const out = new URL('../northwind_transaction_history_3p.pdf', import.meta.url);
fs.writeFileSync(out, pdf, 'latin1');
console.log('wrote', out.pathname, pdf.length, 'bytes');
