// OCR-generalisation fixture #5 ("worst case"): three-line transactions
// (description, a reference line, then "Amount: SGD 12.30" on its own
// line), credits printed in LIGHT GREY text (gray 0.6 - still legible to a
// human, but a much weaker OCR signal than black text), and a footer
// printed on EVERY page ("Page 1 of 3" + a running balance line) that must
// not be mistaken for a transaction. The amount is neither at the end of
// the description line (like a same-line layout) nor alone on the next line (like a two-line layout) -
// it's prefixed with the literal word "Amount:", which matchAmountLine's
// regex does not special-case at all (it looks at what's at the END of a
// line, and "Amount: SGD 12.30" only differs from a plain "SGD 12.30" line
// by that leading word, which the anchored end-of-line regex tolerates -
// this is really testing the light-grey-text + 3-line-shape combination).
// Writes test/fixtures/worstcase_grouped_3line.pdf + .truth.json.
// Run: node test/fixtures/gen/gen-worstcase-grouped-3line.mjs
import fs from 'node:fs';
import { buildTextStream, buildMultiPagePdf } from './pdflib.mjs';
import { makeLayout, makeRng, isoToDMonYYYY } from './layout.mjs';

const rng = makeRng(5005);
const MERCHANTS = [
  'FAIRPRICE FINEST HOLLAND VILLAGE', 'SINGTEL MOBILE BILL PAYMENT', 'GRAB RIDE - CHANGI AIRPORT',
  'KOI THE CAFE ORCHARD CENTRAL', 'POPULAR BOOKSTORE BUGIS JUNCTION', 'GIANT HYPERMARKET TAMPINES',
  'WATSONS PERSONAL CARE PLAZA SINGAPURA', 'SBS TRANSIT EZ-LINK TOPUP', 'MACRITCHIE RESERVOIR CAFE',
  'REFUND - LAZADA SINGAPORE', 'CASHBACK PROMOTION CREDIT', 'INTEREST CREDIT SAVINGS',
];
const CREDIT_DESCS = ['REFUND - LAZADA SINGAPORE', 'CASHBACK PROMOTION CREDIT', 'INTEREST CREDIT SAVINGS'];

const N_TXNS = 34;
const N_DATES = 16;

const ISO_DATES = [];
{
  let d = new Date('2026-09-13T00:00:00Z');
  while (ISO_DATES.length < N_DATES) {
    ISO_DATES.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - (1 + Math.floor(rng() * 2)));
  }
  ISO_DATES.reverse();
}

const truth = [];
const layout = makeLayout({ top: 760, bottom: 70 }); // extra bottom margin for the per-page footer

layout.pages[0].push(
  { x: 50, y: 760, text: 'Everyday Bank', size: 12 },
  { x: 50, y: 744, text: 'Everyday Current Account' },
  { x: 50, y: 730, text: 'Account Holder: RAJESH KUMAR S/O MURUGAN' },
  { x: 50, y: 716, text: 'Statement Period: 14 Aug 2026 to 13 Sep 2026' },
);
layout.y = 690;

let refCounter = 700001;
let txnCount = 0;
for (const iso of ISO_DATES) {
  if (txnCount >= N_TXNS) break;
  const perDate = 1 + Math.floor(rng() * 3);
  layout.ensureRoom(20);
  layout.place(50, isoToDMonYYYY(iso), { size: 10 });
  layout.advance(18);
  for (let k = 0; k < perDate && txnCount < N_TXNS; k++, txnCount++) {
    const isCredit = rng() < 0.15;
    const desc = isCredit ? CREDIT_DESCS[Math.floor(rng() * CREDIT_DESCS.length)] : MERCHANTS[Math.floor(rng() * MERCHANTS.length)];
    const amount = Math.round((5 + rng() * 250) * 100) / 100;
    const gray = isCredit ? 0.6 : 0; // light-grey text for credits only

    layout.ensureRoom(48);
    layout.place(50, desc, { gray });
    layout.advance(14);
    layout.place(50, `Ref: SB${refCounter++}`, { gray });
    layout.advance(14);
    const sign = isCredit ? '+' : '-';
    layout.place(50, `Amount: SGD ${sign}${amount.toFixed(2)}`, { gray });
    layout.advance(20);
    truth.push({ date: iso, amount: isCredit ? amount : -amount, description: desc });
  }
}

// Footer on EVERY page: page indicator + a running balance line, printed
// after layout so pages.length is final.
let footerBalance = 9500.00;
layout.pages.forEach((p, i) => {
  p.push({ x: 50, y: 40, text: `Balance as of page ${i + 1}: SGD ${footerBalance.toFixed(2)}` });
  p.push({ x: 450, y: 40, text: `Page ${i + 1} of ${layout.pages.length}` });
  footerBalance += 50; // arbitrary drift, just needs to be present/plausible per page
});

const pdf = buildMultiPagePdf(layout.pages.map((p) => buildTextStream(p)));
const outPdf = new URL('../worstcase_grouped_3line.pdf', import.meta.url);
fs.writeFileSync(outPdf, pdf, 'latin1');
const outTruth = new URL('../worstcase_grouped_3line.truth.json', import.meta.url);
fs.writeFileSync(outTruth, JSON.stringify(truth, null, 2));
console.log('wrote', outPdf.pathname, pdf.length, 'bytes,', truth.length, 'transactions,', layout.pages.length, 'pages');
