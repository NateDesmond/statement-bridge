// Generates the two password-protected PDF fixtures Track 2 (password-
// protected PDFs, see HARDENING.md) tests and e2e-drives against:
//   test/fixtures/northwind_transaction_history_protected.pdf        (real text layer)
//   test/fixtures/northwind_transaction_history_protected_image.pdf  (near-zero text)
//
// Uses pdfkit (a real Node PDF-writing library, unlike test/fixtures/gen/
// pdflib.mjs's hand-rolled unencrypted-only writer) for its userPassword/
// ownerPassword support. pdfkit is installed under extension/dev/node_modules
// only (never a real dependency of the shipped extension - see dev/package.json)
// and imported here by its exact file path rather than a bare specifier, since
// this script lives outside dev/'s own node_modules resolution scope.
//
// Run: node test/fixtures/gen/gen-encrypted.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from '../../../dev/node_modules/pdfkit/js/pdfkit.node.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..');

// A fictional bank (HARDENING.md's shared rule: no real bank names anywhere),
// matching the naming convention builtin-profiles.js's own "Northwind Bank"
// Transaction History PDF profile already uses, so a real person's remembered
// password formula for this statement type reads naturally in the fixture.
export const PASSWORD = 'sb-test-nric-1990';
export const WRONG_PASSWORD = 'wrong-guess';

function buildDoc(outPath) {
  const doc = new PDFDocument({
    size: [612, 792],
    userPassword: PASSWORD,
    ownerPassword: `${PASSWORD}-owner`,
    permissions: { printing: 'highResolution', modifying: false, copying: true },
  });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);
  return { doc, finished: new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); }) };
}

async function genTextPdf() {
  const outPath = path.join(fixturesDir, 'northwind_transaction_history_protected.pdf');
  const { doc, finished } = buildDoc(outPath);
  doc.fontSize(14).text('Northwind Bank', 50, 50);
  doc.fontSize(10).text('Transaction History', 50, 70);
  doc.text('Northwind Current Account', 50, 84);
  doc.text('Statement Period: 01 Jun 2026 to 30 Jun 2026', 50, 98);
  doc.text('Available Balance SGD 4,210.55', 50, 112);

  let y = 140;
  const rows = [
    { date: '1 Jun 2026', desc: 'NTUC FAIRPRICE TAMPINES', amount: '-52.40' },
    { date: '4 Jun 2026', desc: 'GRAB RIDE SINGAPORE', amount: '-18.60' },
    { date: '9 Jun 2026', desc: 'SALARY CREDIT', amount: '+3,200.00' },
    { date: '15 Jun 2026', desc: 'SHOPEE SINGAPORE', amount: '-29.90' },
  ];
  for (const r of rows) {
    doc.text(r.date, 50, y);
    doc.text(`SGD ${r.amount}`, 50, y + 12);
    y += 32;
  }
  doc.end();
  await finished;
  console.log('wrote', outPath);
}

// ponytail: an "image-only" fixture only needs to trip core/pdf.js's own
// isImageOnlyPdf threshold (near-zero extracted TEXT characters per page) -
// that check has no idea whether a real image XObject is present, only how
// much text pdf.js's own text layer extracted. A true rasterized scan needs
// dev/rasterize-pdf.mjs's headless-browser pipeline (real pdf.js render to
// canvas to JPEG), which is Track 3's OCR-accuracy territory (real recall
// numbers against a real scanned page); Track 2's job is proving the
// password prompt correctly hands off into the existing image-only/OCR flow,
// not re-proving OCR accuracy. Upgrade path: point this at
// dev/rasterize-pdf.mjs's output if an encrypted *scanned* fixture is ever
// needed for a Track 3 concern specifically.
async function genImagePdf() {
  const outPath = path.join(fixturesDir, 'northwind_transaction_history_protected_image.pdf');
  const { doc, finished } = buildDoc(outPath);
  // Well under core/pdf.js's MIN_CHARS_PER_PAGE (40) - reads as "no readable
  // text" the same way a real scanned/rasterized page does.
  doc.fontSize(8).text('STMT', 50, 50);
  doc.end();
  await finished;
  console.log('wrote', outPath);
}

await genTextPdf();
await genImagePdf();
