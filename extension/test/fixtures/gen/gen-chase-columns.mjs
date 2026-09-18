// OCR-generalisation fixture #3: an Anchor Bank (US)-style checking statement -
// MM/DD/YYYY dates, no currency symbol, negative amounts with a leading
// "-", ALL CAPS descriptions with trailing reference numbers, and a page
// break landing in the MIDDLE of one date's run of transactions (two
// transactions share 09/02/2026, split across the page 1/2 boundary with no
// repeated date on page 2 - rowModel 'columns' has no date-group concept at
// all, so a continuation row with no date column filled in either needs
// joinWrappedLines to catch it, or is silently dropped).
// Writes test/fixtures/anchor_columns.pdf + .truth.json.
// Run: node test/fixtures/gen/gen-chase-columns.mjs
import fs from 'node:fs';
import { buildTextStream, buildMultiPagePdf } from './pdflib.mjs';
import { makeLayout, makeRng, isoToMMDDYYYY } from './layout.mjs';

const rng = makeRng(3003);
const MERCHANTS = [
  'AMAZON.COM*A1B2C3D4E SEATTLE WA REF0091823', 'WHOLE FOODS MKT 10234 CHICAGO IL REF0091824',
  'UBER TRIP 8X7Y6Z SAN FRANCISCO CA REF0091825', 'STARBUCKS STORE 04471 CHICAGO IL REF0091826',
  'SHELL OIL 57200019283 CHICAGO IL REF0091827', 'NETFLIX.COM LOS GATOS CA REF0091828',
  'TARGET T-1234 CHICAGO IL REF0091829', 'COMCAST CABLE COMM PHILADELPHIA PA REF0091830',
  'CVS/PHARMACY #04471 CHICAGO IL REF0091831', 'DIRECT DEPOSIT PAYROLL ACME CORP REF0091832',
  'ZELLE TRANSFER FROM J SMITH REF0091833', 'CHIPOTLE ONLINE 4471 CHICAGO IL REF0091834',
];

const COLS = { date: 50, desc: 130, amount: 460 };
const N_TXNS = 55;
const N_DATES = 32;

const ISO_DATES = [];
{
  let d = new Date('2026-09-30T00:00:00Z');
  while (ISO_DATES.length < N_DATES) {
    ISO_DATES.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - (1 + Math.floor(rng() * 2)));
  }
  ISO_DATES.reverse();
}

const truth = [];
const layout = makeLayout({ top: 760, bottom: 60 });

layout.pages[0].push(
  { x: 50, y: 760, text: 'Anchor Bank, N.A.', size: 12 },
  { x: 50, y: 744, text: 'Anchor Total Checking' },
  { x: 50, y: 730, text: 'Account Holder: MICHAEL J TAYLOR' },
  { x: 50, y: 716, text: 'Statement Period: 09/01/2026 through 09/30/2026' },
);
layout.y = 690;

function tableHeader() {
  layout.place(COLS.date, 'DATE');
  layout.place(COLS.desc, 'DESCRIPTION');
  layout.place(COLS.amount, 'AMOUNT');
  layout.advance(18);
}
tableHeader();

let txnCount = 0;
let forcedMidGroupBreak = false;
for (let di = 0; di < ISO_DATES.length && txnCount < N_TXNS; di++) {
  const iso = ISO_DATES[di];
  const perDate = 1 + Math.floor(rng() * 2);
  for (let k = 0; k < perDate && txnCount < N_TXNS; k++, txnCount++) {
    const isCredit = rng() < 0.1;
    const desc = MERCHANTS[Math.floor(rng() * MERCHANTS.length)].toUpperCase();
    const amount = Math.round((8 + rng() * 400) * 100) / 100;

    // Deliberately force ONE page break to land between two transactions
    // that share the same date (mid-group), around the middle of the
    // document, by breaking right after the FIRST transaction of a
    // multi-transaction date once we're past the halfway point.
    if (!forcedMidGroupBreak && txnCount >= Math.floor(N_TXNS / 2) && perDate > 1 && k === 1) {
      layout.newPage();
      forcedMidGroupBreak = true;
      tableHeader();
    } else {
      layout.ensureRoom(16);
    }
    layout.place(COLS.date, isoToMMDDYYYY(iso));
    layout.place(COLS.desc, desc);
    layout.place(COLS.amount, isCredit ? amount.toFixed(2) : `-${amount.toFixed(2)}`);
    layout.advance(14);
    truth.push({ date: iso, amount: isCredit ? amount : -amount, description: desc });
  }
}

layout.pages.forEach((p, i) => p.push({ x: 500, y: 20, text: `Page ${i + 1} of ${layout.pages.length}` }));

const pdf = buildMultiPagePdf(layout.pages.map((p) => buildTextStream(p)));
const outPdf = new URL('../anchor_columns.pdf', import.meta.url);
fs.writeFileSync(outPdf, pdf, 'latin1');
const outTruth = new URL('../anchor_columns.truth.json', import.meta.url);
fs.writeFileSync(outTruth, JSON.stringify(truth, null, 2));
console.log('wrote', outPdf.pathname, pdf.length, 'bytes,', truth.length, 'transactions,', layout.pages.length, 'pages');
