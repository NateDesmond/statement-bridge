// OCR-generalisation fixture #1: a Summit Bank
// credit-card-style statement that is NOT the a grouped-layout bank's "Transaction History"
// layout this app was built/tuned against. Distinguishing features:
//   - date-group lines are bare "D Mon YYYY" (no weekday, unlike DBS's
//     "Wednesday, 16 Sep 2026")
//   - each transaction is TWO lines: description on its own line, THEN the
//     amount on the line below it ("20.83 SGD") - a same-line layout puts description+
//     amount on the SAME line
//   - currency comes AFTER the number ("20.83 SGD"), not before it
//   - credits are marked with a trailing "CR" ("150.00 SGD CR")
// Writes test/fixtures/summit_grouped_2line.pdf (real text) and
// test/fixtures/summit_grouped_2line.truth.json (ground truth: date/amount/
// description for every transaction, signed amount in dollars).
// Run: node test/fixtures/gen/gen-uob-grouped-2line.mjs
import fs from 'node:fs';
import { buildTextStream, buildMultiPagePdf } from './pdflib.mjs';
import { makeLayout, makeRng, isoToDMonYYYY } from './layout.mjs';

const rng = makeRng(1001);
const MERCHANTS = [
  'STARBUCKS COFFEE #4471 SGP', 'NTUC FAIRPRICE FINEST SGP', 'GRAB* A-1928374 SINGAPORE SG',
  'AMAZON WEB SERVICES SINGAPORE', 'SHOPEE SINGAPORE PTE LTD', 'CIRCLES.LIFE MOBILE SG',
  'MCDONALD S TAMPINES SGP', 'DECATHLON SINGAPORE PTE LTD', 'GOOGLE *CLOUD SINGAPORE',
  'CATHAY CINEMAS SGP', 'KOPITIAM CHANGI SGP', 'COURTS MEGASTORE TAMPINES',
  'GUARDIAN HEALTH PHARMACY SGP', 'BREADTALK ORCHARD SGP', 'SPOTIFY SINGAPORE',
];
const CREDIT_DESCS = ['PAYMENT RECEIVED - THANK YOU', 'REFUND - SHOPEE SINGAPORE', 'CASHBACK REBATE CREDIT'];

const N_TXNS = 42;
const N_DATES = 18;

// Build 16 distinct dates walking backward from 2026-09-14 (business-day-ish spacing).
const ISO_DATES = [];
{
  let d = new Date('2026-09-14T00:00:00Z');
  while (ISO_DATES.length < N_DATES) {
    ISO_DATES.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - (1 + Math.floor(rng() * 2)));
  }
  ISO_DATES.reverse();
}

const truth = [];
const layout = makeLayout({ top: 760, bottom: 60 });

const header = [
  { x: 50, y: 760, text: 'United Overseas Bank Limited', size: 12 },
  { x: 50, y: 744, text: 'Summit Preferred Platinum Card' },
  { x: 50, y: 730, text: 'Card Member: LIM WEI JIE' },
  { x: 50, y: 716, text: 'Statement Date: 14 Sep 2026    Payment Due Date: 04 Oct 2026' },
  { x: 50, y: 702, text: 'Statement Period: 15 Aug 2026 to 14 Sep 2026' },
];
layout.pages[0].push(...header);
layout.y = 680; // below the header, page 1 only - continuation pages keep the default top (760)

let txnCount = 0;
for (const iso of ISO_DATES) {
  if (txnCount >= N_TXNS) break;
  const perDate = 1 + Math.floor(rng() * 3); // 1-3 txns per date
  layout.ensureRoom(24);
  layout.place(50, isoToDMonYYYY(iso), { size: 10 });
  layout.advance(20);
  for (let k = 0; k < perDate && txnCount < N_TXNS; k++, txnCount++) {
    const isCredit = rng() < 0.12;
    const desc = isCredit ? CREDIT_DESCS[Math.floor(rng() * CREDIT_DESCS.length)] : MERCHANTS[Math.floor(rng() * MERCHANTS.length)];
    const amount = Math.round((5 + rng() * 300) * 100) / 100;
    layout.ensureRoom(36);
    layout.place(50, desc);
    layout.advance(14);
    const amountText = isCredit ? `${amount.toFixed(2)} SGD CR` : `${amount.toFixed(2)} SGD`;
    layout.place(430, amountText);
    layout.advance(20);
    truth.push({ date: iso, amount: isCredit ? amount : -amount, description: desc });
  }
}

// Page footers.
layout.pages.forEach((p, i) => p.push({ x: 500, y: 20, text: `Page ${i + 1} of ${layout.pages.length}` }));

const pdf = buildMultiPagePdf(layout.pages.map((p) => buildTextStream(p)));
const outPdf = new URL('../summit_grouped_2line.pdf', import.meta.url);
fs.writeFileSync(outPdf, pdf, 'latin1');
const outTruth = new URL('../summit_grouped_2line.truth.json', import.meta.url);
fs.writeFileSync(outTruth, JSON.stringify(truth, null, 2));
console.log('wrote', outPdf.pathname, pdf.length, 'bytes,', truth.length, 'transactions,', layout.pages.length, 'pages');
