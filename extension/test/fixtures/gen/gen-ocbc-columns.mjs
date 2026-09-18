// OCR-generalisation fixture #2: a Riverside Bank 360-style classic table layout -
// Date | Description | Withdrawal | Deposit | Balance columns, wrapped
// descriptions spilling onto a second (date-less) line, a "Balance B/F"
// opening row and a "Total" footer row. Unlike DBS's rowModel 'grouped'
// (no fixed columns), this is rowModel 'columns' shaped, and unlike the
// existing uob_card_sample.pdf fixture (Date/Description/Amount, 3 columns)
// this has FIVE columns with separate debit/credit/balance, which the
// auto-detect columns default (a single fixed date/description/amount
// 3-band split, see src/ui/wizard.js's renderLocatePage) is not built to
// separate - that collision is exactly what this fixture is for.
// Writes test/fixtures/riverside_columns.pdf + .truth.json.
// Run: node test/fixtures/gen/gen-ocbc-columns.mjs
import fs from 'node:fs';
import { buildTextStream, buildMultiPagePdf } from './pdflib.mjs';
import { makeLayout, makeRng, isoToDMonYYYY } from './layout.mjs';

const rng = makeRng(2002);
const MERCHANTS = [
  'GIRO PAYMENT - SP SERVICES', 'NTUC INCOME INSURANCE PREMIUM', 'PAYNOW TRANSFER TO TAN WEI LING',
  'COLD STORAGE SUPERMARKET GREAT WORLD CITY SINGAPORE', 'FAIRPRICE XTRA JURONG POINT SINGAPORE',
  'INTEREST CREDIT', 'SALARY GIRO CREDIT FROM EMPLOYER PTE LTD SINGAPORE', 'ATM WITHDRAWAL ORCHARD ROAD',
  'CREDIT CARD PAYMENT VIA GIRO', 'TELCO BILL PAYMENT STARHUB SINGAPORE', 'PROPERTY TAX PAYMENT IRAS',
  'CHEQUE DEPOSIT', 'FUNDS TRANSFER FROM SAVINGS ACCOUNT', 'INSURANCE PREMIUM AIA SINGAPORE PRIVATE LIMITED',
];

const COLS = { date: 50, desc: 140, withdrawal: 350, deposit: 420, balance: 490 };
const N_TXNS = 48;
const N_DATES = 34;

const ISO_DATES = [];
{
  let d = new Date('2026-09-15T00:00:00Z');
  while (ISO_DATES.length < N_DATES) {
    ISO_DATES.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - (1 + Math.floor(rng() * 2)));
  }
  ISO_DATES.reverse();
}

const truth = [];
const layout = makeLayout({ top: 760, bottom: 60 });

function pageHeader(isFirst) {
  if (!isFirst) return;
  layout.pages[0].push(
    { x: 50, y: 760, text: 'Riverside Bank', size: 12 },
    { x: 50, y: 744, text: 'Riverside 360 Account' },
    { x: 50, y: 730, text: 'Account Holder: CHEN MEI LING' },
    { x: 50, y: 716, text: 'Account No: 501-234567-8' },
    { x: 50, y: 702, text: 'Statement Period: 16 Aug 2026 to 15 Sep 2026' },
  );
  layout.y = 676;
}
pageHeader(true);

function tableHeader() {
  layout.place(COLS.date, 'Date');
  layout.place(COLS.desc, 'Description');
  layout.place(COLS.withdrawal, 'Withdrawal');
  layout.place(COLS.deposit, 'Deposit');
  layout.place(COLS.balance, 'Balance');
  layout.advance(18);
}
tableHeader();

let balance = 18420.55;
layout.place(COLS.date, isoToDMonYYYY(ISO_DATES[0]));
layout.place(COLS.desc, 'Balance B/F');
layout.place(COLS.balance, balance.toFixed(2));
layout.advance(16);

let txnCount = 0;
for (const iso of ISO_DATES) {
  if (txnCount >= N_TXNS) break;
  const perDate = 1 + Math.floor(rng() * 2);
  for (let k = 0; k < perDate && txnCount < N_TXNS; k++, txnCount++) {
    const isDeposit = rng() < 0.2;
    const desc = MERCHANTS[Math.floor(rng() * MERCHANTS.length)];
    const amount = Math.round((10 + rng() * 900) * 100) / 100;
    balance = Math.round((balance + (isDeposit ? amount : -amount)) * 100) / 100;
    // Wrap the description onto a second line for long merchant names (>40 chars).
    const wrap = desc.length > 40;
    const firstLine = wrap ? desc.slice(0, 40).trim() : desc;
    const secondLine = wrap ? desc.slice(40).trim() : null;

    layout.ensureRoom(wrap ? 32 : 16);
    if (layout.pages.length > 1 && layout.y === 760) tableHeader(); // repeat header on a fresh page
    layout.place(COLS.date, isoToDMonYYYY(iso));
    layout.place(COLS.desc, firstLine);
    if (isDeposit) layout.place(COLS.deposit, amount.toFixed(2));
    else layout.place(COLS.withdrawal, amount.toFixed(2));
    layout.place(COLS.balance, balance.toFixed(2));
    layout.advance(14);
    if (secondLine) { layout.place(COLS.desc, secondLine); layout.advance(14); }
    truth.push({ date: iso, amount: isDeposit ? amount : -amount, description: desc });
  }
}

layout.ensureRoom(20);
layout.place(COLS.desc, 'Total');
layout.place(COLS.balance, balance.toFixed(2));

layout.pages.forEach((p, i) => p.push({ x: 500, y: 20, text: `Page ${i + 1} of ${layout.pages.length}` }));

const pdf = buildMultiPagePdf(layout.pages.map((p) => buildTextStream(p)));
const outPdf = new URL('../riverside_columns.pdf', import.meta.url);
fs.writeFileSync(outPdf, pdf, 'latin1');
const outTruth = new URL('../riverside_columns.truth.json', import.meta.url);
fs.writeFileSync(outTruth, JSON.stringify(truth, null, 2));
console.log('wrote', outPdf.pathname, pdf.length, 'bytes,', truth.length, 'transactions,', layout.pages.length, 'pages');
