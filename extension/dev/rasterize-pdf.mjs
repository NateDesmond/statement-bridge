// Generic multi-page text-PDF -> image-only-PDF rasterizer, for the
// OCR-generalisation fixtures (test/fixtures/gen/gen-*.mjs). Generalizes
// dev/gen-dbs-transaction-history-image.mjs (which only handles page 1) to
// N pages: renders every page through dev/render-pdf-to-jpegs.html (real
// pdf.js + canvas, same as the single-page version) then reassembles the
// JPEGs as a single multi-page PDF, one image XObject per page, no text
// operators at all - matching what a scanned/app-exported statement PDF
// looks like to core/pdf-image.js's isImageOnly check.
//
// Needs a running static server for extension/ and the `playwright` package
// (see dev/gen-dbs-transaction-history-image.mjs's comment for why this
// lives in dev/, not test/fixtures/gen/):
//   python3 -m http.server 8934 --directory extension   # from the repo root
//   node dev/rasterize-pdf.mjs test/fixtures/summit_grouped_2line.pdf test/fixtures/summit_grouped_2line_image.pdf
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = process.env.SB_DEV_PORT || 8934;
const [, , inRel, outRel, scaleArg] = process.argv;
if (!inRel || !outRel) {
  console.error('usage: node dev/rasterize-pdf.mjs <input.pdf relative to extension/> <output.pdf relative to extension/> [scale]');
  process.exit(1);
}
const scale = Number(scaleArg || '2');
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

const url = `http://localhost:${PORT}/dev/render-pdf-to-jpegs.html?src=../${inRel}&scale=${scale}`;

// Bundled, headless Chromium: never the user's own installed Chrome (no
// "channel: 'chrome'"), so this never touches a real browser session.
const browser = await chromium.launch();
let pages;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('out').textContent !== 'running', { timeout: 120000 });
  const result = JSON.parse(await page.textContent('#out'));
  if (result.error) throw new Error(result.error);
  pages = result.pages;
} finally {
  await browser.close();
}

/** Build a multi-page, image-only PDF: one page object + one content stream + one JPEG XObject per page. */
function buildMultiPageImagePdf(jpegPages) {
  const n = jpegPages.length;
  const objs = []; // each entry: { text } or { text, binaryTail }
  objs.push({ text: '<< /Type /Catalog /Pages 2 0 R >>' });
  const pageIds = jpegPages.map((_, i) => 3 + i * 3);
  objs.push({ text: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${n} >>` });
  for (let i = 0; i < n; i++) {
    const { width, height, jpegBytes } = jpegPages[i];
    const contentStr = `q ${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm /Im1 Do Q`;
    objs.push({ text: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /XObject << /Im1 ${pageIds[i] + 2} 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>` });
    objs.push({ text: `<< /Length ${Buffer.byteLength(contentStr)} >>\nstream\n${contentStr}\nendstream` });
    objs.push({
      text: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
      binaryTail: jpegBytes,
    });
  }

  let pdf = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [];
  objs.forEach((obj, i) => {
    offsets.push(pdf.length);
    const head = Buffer.from(`${i + 1} 0 obj\n${obj.text}`, 'latin1');
    pdf = Buffer.concat([pdf, head]);
    if (obj.binaryTail) pdf = Buffer.concat([pdf, obj.binaryTail, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    else pdf = Buffer.concat([pdf, Buffer.from('\nendobj\n', 'latin1')]);
  });
  const xrefStart = pdf.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.concat([pdf, Buffer.from(xref, 'latin1')]);
}

const jpegPages = pages.map((p) => ({ width: p.width, height: p.height, jpegBytes: Buffer.from(p.dataUrl.split(',')[1], 'base64') }));
const pdfBytes = buildMultiPageImagePdf(jpegPages);
fs.writeFileSync(new URL(`../${outRel}`, import.meta.url), pdfBytes);
console.log('wrote', outRel, pdfBytes.length, 'bytes,', jpegPages.length, 'pages');
