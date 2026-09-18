// OCR-generalisation fixture #4: a Palisade Bank-style savings statement -
// DD/MM/YY dates, amounts with trailing "DR"/"CR" markers, thousands
// separators, some round amounts printed with NO decimals ("500"), and a
// right-hand running BALANCE column that must not be mistaken for the
// transaction amount (rowModel 'columns' with 4 columns: Date, Description,
// Amount, Balance - the auto-detect default only carves out 3 bands, so
// Amount and Balance land in the same band together, same collision as the
// OCBC fixture but with DR/CR markers instead of separate debit/credit
// columns).
// Writes test/fixtures/palisade_columns.pdf + .truth.json.
// Run: node test/fixtures/gen/gen-maybank-columns.mjs
import fs from 'node:fs';
import { buildTextStream, buildMultiPagePdf } from './pdflib.mjs';
import { makeLayout, makeRng, isoToDDMMYY } from './layout.mjs';

const rng = makeRng(4004);
const MERCHANTS = [
  'PAYMENT VIA DUITNOW QR - KEDAI RUNCIT AMIN', 'SALARY CREDIT - SYARIKAT MAJU SDN BHD',
  'AUTOPAY INSURANS TAKAFUL', 'ATM WITHDRAWAL - PALISADE KLCC', 'TRANSFER TO SAVINGS - AHMAD BIN ALI',
  'JOM PAY - TENAGA NASIONAL BERHAD', 'ONLINE PURCHASE - SHOPEE MALAYSIA', 'CHEQUE DEPOSIT',
  'STANDING INSTRUCTION - RENTAL PAYMENT', 'INTEREST PAID', 'DUITNOW TRANSFER - SITI NURHALIZA',
  'BILL PAYMENT - ASTRO MALAYSIA', 'CASH DEPOSIT MACHINE KL SENTRAL',
];

function fmtAmount(amount, opts = {}) {
  // Thousands separator, optional decimals (round amounts sometimes printed with none).
  const noDecimals = opts.roundNoDecimals && Number.isInteger(amount);
  const fixed = noDecimals ? String(amount) : amount.toFixed(2);
  const parts = fixed.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

const COLS = { date: 50, desc: 140, amount: 400, balance: 490 };
const N_TXNS = 45;
const N_DATES = 30;

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

layout.pages[0].push(
  { x: 50, y: 760, text: 'Palisade Banking Berhad', size: 12 },
  { x: 50, y: 744, text: 'Palisade Savings Account-i' },
  { x: 50, y: 730, text: 'Account Holder: NUR AISYAH BINTI HASSAN' },
  { x: 50, y: 716, text: 'Statement Period: 15/08/26 to 14/09/26' },
);
layout.y = 690;

function tableHeader() {
  layout.place(COLS.date, 'Date');
  layout.place(COLS.desc, 'Description');
  layout.place(COLS.amount, 'Amount');
  layout.place(COLS.balance, 'Balance');
  layout.advance(18);
}
tableHeader();

let balance = 22190;
let txnCount = 0;
for (const iso of ISO_DATES) {
  if (txnCount >= N_TXNS) break;
  const perDate = 1 + Math.floor(rng() * 2);
  for (let k = 0; k < perDate && txnCount < N_TXNS; k++, txnCount++) {
    const isCredit = rng() < 0.18;
    const desc = MERCHANTS[Math.floor(rng() * MERCHANTS.length)];
    const roundNoDecimals = rng() < 0.3;
    let amount = roundNoDecimals ? Math.round((10 + rng() * 900) / 10) * 10 : Math.round((10 + rng() * 900) * 100) / 100;
    balance = Math.round((balance + (isCredit ? amount : -amount)) * 100) / 100;

    layout.ensureRoom(16);
    if (layout.pages.length > 1 && layout.y === 760) tableHeader();
    layout.place(COLS.date, isoToDDMMYY(iso));
    layout.place(COLS.desc, desc);
    layout.place(COLS.amount, `${fmtAmount(amount, { roundNoDecimals })} ${isCredit ? 'CR' : 'DR'}`);
    layout.place(COLS.balance, fmtAmount(balance));
    layout.advance(14);
    truth.push({ date: iso, amount: isCredit ? amount : -amount, description: desc });
  }
}

layout.pages.forEach((p, i) => p.push({ x: 500, y: 20, text: `Page ${i + 1} of ${layout.pages.length}` }));

const pdf = buildMultiPagePdf(layout.pages.map((p) => buildTextStream(p)));
const outPdf = new URL('../palisade_columns.pdf', import.meta.url);
fs.writeFileSync(outPdf, pdf, 'latin1');
const outTruth = new URL('../palisade_columns.truth.json', import.meta.url);
fs.writeFileSync(outTruth, JSON.stringify(truth, null, 2));
console.log('wrote', outPdf.pathname, pdf.length, 'bytes,', truth.length, 'transactions,', layout.pages.length, 'pages');
