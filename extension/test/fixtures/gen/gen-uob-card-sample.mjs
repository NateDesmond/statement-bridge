// Generates test/fixtures/summit_card_sample.pdf: a synthetic Summit Bank credit card
// statement modelled on the real layout (header, period line, a Date /
// Description / Amount table with one wrapped description and one CR
// amount, footer lines). Run: node test/fixtures/gen/gen-uob-card-sample.mjs
import fs from 'node:fs';
import { buildTextStream, buildSinglePagePdf } from './pdflib.mjs';

const lines = [
  { y: 760, size: 12, text: 'Summit Bank Limited' },
  { y: 744, text: 'Summit Preferred Platinum Card' },
  { y: 730, text: 'Card Member: TAN WEI MING' },
  { y: 716, text: 'Statement Date: 30 Jun 2026    Payment Due Date: 20 Jul 2026' },
  { y: 702, text: 'Statement Period: 01 Jun 2026 to 30 Jun 2026' },
];

const header = { y: 670, cols: [['Date', 50], ['Description', 150], ['Amount (SGD)', 430]] };
// One row (AMAZON WEB SERVICES) wraps its description onto a second,
// date-less continuation line; one row (PAYMENT RECEIVED) has a CR amount.
const rows = [
  { date: '01 Jun', desc: 'NTUC FAIRPRICE TAMPINES SG', amount: '52.40' },
  { date: '04 Jun', desc: 'GRAB* A-1928374 SINGAPORE SG', amount: '18.60' },
  { date: '09 Jun', desc: 'AMAZON WEB SERVICES SINGAPORE', amount: '210.00', wrap: 'PROFESSIONAL SVCS REF 20-06-2026' },
  { date: '15 Jun', desc: 'PAYMENT RECEIVED - THANK YOU', amount: '500.00 CR' },
  { date: '21 Jun', desc: 'SHOPEE SINGAPORE PTE LTD', amount: '29.90' },
  { date: '27 Jun', desc: 'CIRCLES.LIFE MOBILE SG', amount: '38.00' },
];

const footer = [
  { y: 0, text: 'Total balance carried forward: S$-129.10' },
  { y: -16, text: 'Minimum payment due: S$50.00' },
  { y: -32, text: 'This is a computer generated statement.' },
];

const placements = [];
for (const l of lines) placements.push({ x: 50, y: l.y, text: l.text, size: l.size });
for (const [label, x] of header.cols) placements.push({ x, y: header.y, text: label, size: 9 });

let y = header.y - 20;
for (const row of rows) {
  placements.push({ x: 50, y, text: row.date });
  placements.push({ x: 150, y, text: row.desc });
  placements.push({ x: 430, y, text: row.amount });
  y -= 14;
  if (row.wrap) {
    placements.push({ x: 150, y, text: row.wrap });
    y -= 14;
  }
}

y -= 20;
for (const f of footer) placements.push({ x: 50, y: y + f.y, text: f.text });

const content = buildTextStream(placements);
const pdf = buildSinglePagePdf(content);
const out = new URL('../summit_card_sample.pdf', import.meta.url);
fs.writeFileSync(out, pdf, 'latin1');
console.log('wrote', out.pathname, pdf.length, 'bytes');
