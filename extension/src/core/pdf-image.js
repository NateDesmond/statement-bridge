// Detect image-only PDF pages (DBS digibank-style scanned statements) and
// render a page to a canvas for OCR. The pure detection logic
// (isImageOnly) works on plain arrays so it is node-testable without a real
// PDF or pdf.js loaded; the rendering half needs a real pdf.js `page`
// object and a DOM canvas, so it is exercised only via the dev harness (see
// FASTPATH.md's "OCR for image-only PDFs" section).

import { log } from './debuglog.js';

// pdf.js OPS names that paint bitmap image content (as opposed to vector
// paths/text). Any of these on a page with near-zero extracted text means
// the page is a picture of a statement, not a digital one.
const IMAGE_OP_NAMES = new Set([
  'paintImageXObject',
  'paintInlineImageXObject',
  'paintInlineImageXObjectGroup',
  'paintImageXObjectRepeat',
  'paintImageMaskXObject',
  'paintImageMaskXObjectGroup',
  'paintImageMaskXObjectRepeat',
  'paintSolidColorImageMask',
]);

/**
 * @param {{str:string}[]} pageTextItems - a page's getTextContent().items (or [])
 * @param {string[]} pageOpNames - operator names present on the page (see opNamesFromOperatorList)
 * @param {{minChars?:number}} [opts]
 * @returns {boolean}
 */
export function isImageOnly(pageTextItems, pageOpNames, { minChars = 40 } = {}) {
  const chars = pageTextItems.reduce((sum, it) => sum + (it.str || '').length, 0);
  const hasImage = pageOpNames.some((name) => IMAGE_OP_NAMES.has(name));
  return hasImage && chars < minChars;
}

/**
 * Map pdf.js's numeric getOperatorList() fnArray codes to their OPS name,
 * e.g. for isImageOnly. Built once per pdfjsLib since OPS is a plain object
 * of name -> number.
 */
const opNameCache = new WeakMap();
export function opNamesFromOperatorList(fnArray, OPS) {
  let byCode = opNameCache.get(OPS);
  if (!byCode) {
    byCode = new Map(Object.entries(OPS).map(([name, code]) => [code, name]));
    opNameCache.set(OPS, byCode);
  }
  const names = new Set();
  for (const code of fnArray) {
    const name = byCode.get(code);
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * Full detection for a real pdf.js page: pulls text content + operator list
 * and applies isImageOnly.
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {{OPS:object}} pdfjsLib
 */
export async function detectImageOnlyPage(page, pdfjsLib) {
  const [content, opList] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  const opNames = opNamesFromOperatorList(opList.fnArray, pdfjsLib.OPS);
  const result = isImageOnly(content.items, opNames);
  log('pdf-image', 'image-only detection', { imageOnly: result, chars: content.items.reduce((s, i) => s + i.str.length, 0), opNames });
  return result;
}

/**
 * Render a pdf.js page to a canvas at the given scale (points -> pixels),
 * for OCR. Higher scale than the on-screen preview (pdf-render.js uses
 * ~1.3-1.6) because OCR accuracy depends on pixel density.
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {number} [scale=2.5]
 * @returns {Promise<{canvas:HTMLCanvasElement, scale:number}>}
 */
export async function renderPageToCanvas(page, scale = 2.5) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, scale };
}
