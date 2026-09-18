// Tiny hand-rolled single-page PDF writer: enough to build synthetic bank
// statement fixtures with real, non-embedded Helvetica text (the same font
// class that needs vendor/standard-fonts-data.js to extract in the browser).
// Not a general PDF library; just object/xref/trailer plumbing plus a text
// stream built from (x, y, text) placements.

function esc(s) {
  return String(s).replace(/([()\\])/g, '\\$1');
}

/**
 * @param {{x:number, y:number, text:string, size?:number, gray?:number}[]} placements
 *   - `gray` (0=black, 1=white) sets nonstroking gray fill for that
 *   placement only (used by the "worst case" light-grey-credits fixture).
 * @returns {string} PDF content stream body
 */
export function buildTextStream(placements, defaultSize = 9) {
  let content = '';
  let currentSize = null;
  let currentGray = 0;
  for (const { x, y, text, size = defaultSize, gray = 0 } of placements) {
    if (size !== currentSize) { content += `/F1 ${size} Tf\n`; currentSize = size; }
    if (gray !== currentGray) { content += `${gray} g\n`; currentGray = gray; }
    content += `BT 1 0 0 1 ${x} ${y} Tm (${esc(text)}) Tj ET\n`;
  }
  return content;
}

/** Build a single-page PDF (Letter-ish 612x792) from a text stream body. */
export function buildSinglePagePdf(content, { width = 612, height = 792 } = {}) {
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`);
  objs.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, idx) => {
    offsets.push(pdf.length);
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}

/** Build a multi-page PDF from an array of content stream bodies. */
export function buildMultiPagePdf(contents, { width = 612, height = 792 } = {}) {
  const n = contents.length;
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  const pageIds = contents.map((_, i) => 3 + i * 2);
  objs.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${n} >>`);
  const fontId = 3 + n * 2;
  for (let i = 0; i < n; i++) {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(contents[i])} >>\nstream\n${contents[i]}endstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, idx) => {
    offsets.push(pdf.length);
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}
