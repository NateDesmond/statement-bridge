// Thin pdf.js wiring for the UI layer: render a page to a canvas and return its
// text items (in the same {str,x,y} shape core/pdf.js's pure functions expect),
// so both the Review split view and the wizard's anchor picker can share it.
// ponytail: not node-tested (no headless PDF renderer here); core/pdf.js's pure
// line-grouping/column logic is what's unit tested, this is just the DOM glue.

import { withPdfjs, groupItemsIntoLines } from '../core/pdf.js';

/**
 * Render one page of a PDF (given its bytes) to a canvas element and return
 * its text items with PDF-space coordinates plus the viewport scale, so
 * callers can map between canvas pixels and PDF coordinates. Shares
 * core/pdf.js's withPdfjs so non-embedded Helvetica/Times/Courier text
 * extracts here too, not just in the worker's loadPdfPages path (this is
 * what feeds the wizard's anchor-picker suggestions).
 */
/**
 * @param {ArrayBuffer} bytes
 * @param {number} [pageNum]
 * @param {number} [scale]
 * @param {{items?: object[]}} [opts] - `items` overrides pdf.js's own
 *   getTextContent() with a pre-supplied positioned-item array (OCR items,
 *   same {str,x,y,...} shape) and skips the "no readable text" check below:
 *   an image-only PDF has nothing for pdf.js to extract by design, so the
 *   caller (a file already OCR'd) supplies OCR items instead of asking this
 *   function to find real embedded text that doesn't exist.
 */
export async function renderPdfPage(bytes, pageNum = 1, scale = 1.3, opts = {}) {
  return withPdfjs(async (pdfjsLib, standardFontDataUrl) => {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), standardFontDataUrl }).promise;
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    if (opts.items) return { canvas, viewport, items: opts.items, numPages: doc.numPages };

    const content = await page.getTextContent();
    const items = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], height: it.height }));
    // A page can render its content as vector paint (page.render draws it
    // faithfully) while its underlying font has no usable char-to-Unicode
    // mapping, so getTextContent comes back with almost nothing (often just
    // a page-number stamp using a different, working font). Same "no
    // readable text" signal loadPdfPages uses, so the anchor picker shows a
    // plain explanation instead of an empty column-boundary tool over a
    // page that looks fine but has no extractable data.
    const chars = items.reduce((sum, it) => sum + it.str.length, 0);
    if (chars < 40) throw new Error('no readable text');
    return { canvas, viewport, items, numPages: doc.numPages };
  });
}

/**
 * Page size (at scale 1, i.e. PDF points) plus its text items and the
 * document's page count, without rendering a canvas. Used by Review to
 * compute a "fit the pane width" render scale before calling renderPdfPage,
 * and to walk every page's text for row-to-page/y anchoring - a plain
 * getTextContent() call, same shape renderPdfPage's own items use.
 * @param {ArrayBuffer} bytes
 * @param {number} [pageNum]
 */
export async function getPdfPageInfo(bytes, pageNum = 1) {
  return withPdfjs(async (pdfjsLib, standardFontDataUrl) => {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), standardFontDataUrl }).promise;
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], height: it.height }));
    return { width: viewport.width, height: viewport.height, numPages: doc.numPages, items };
  });
}

/** Map a PDF-space y coordinate to a pixel offset from the top of the rendered canvas. */
export function pdfYToCanvasTop(y, viewport, fontHeight = 10) {
  const [, top] = viewport.convertToViewportPoint(0, y + fontHeight);
  return top;
}

/**
 * Map a PDF-space y coordinate to a pixel offset from the top of the
 * rendered canvas, with no ascender/font-height guess added - for callers
 * that already have a real edge (a line's own y, or y + its own real
 * source_h) rather than a bare baseline needing pdfYToCanvasTop's flat
 * fontHeight fudge.
 */
export function pdfYToCanvasPixel(y, viewport) {
  const [, top] = viewport.convertToViewportPoint(0, y);
  return top;
}

/** Map a PDF-space x coordinate to a pixel offset from the left of the rendered canvas. */
export function pdfXToCanvasLeft(x, viewport) {
  const [left] = viewport.convertToViewportPoint(x, 0);
  return left;
}

/** Inverse of pdfXToCanvasLeft: canvas pixel x back to PDF-space x. */
export function canvasLeftToPdfX(left, viewport) {
  const [x] = viewport.convertToPdfPoint(left, 0);
  return x;
}

const CARD_MAX_W = 360; // widest a snippet ever renders (CSS px) - a long line shrinks slightly rather than ever being cut into two pieces
const CARD_DPR = 2; // rendered at 2x for a crisp bitmap
const LINE_TARGET_PX = 16; // a legible line height (CSS px) the crop is scaled to hit, when width isn't the binding constraint
const LINE_PAD_PX = 24; // horizontal padding either side of the block's own text span, in page-render canvas px

// Item 7 (NO-TEMPLATES, 2026-09-20): the magnifier's own sizing - about 560
// CSS px wide (vs the on-card crop's 360) and a doubled line-target height
// ("2x magnified"), rendered from a higher-resolution page re-render (scale 3
// vs the on-card crop's default 2) so it's an actually sharper crop, not a
// CSS-scaled blowup of the small canvas.
const MAG_MAX_W = 560;
const MAG_LINE_TARGET_PX = LINE_TARGET_PX * 2;
const MAG_SCALE = 3;

/**
 * Item 5a/5b (REBUILD-HOME, 2026-09-18): the block of lines a row's snippet
 * should cover - every line whose y falls between the block's top (the
 * anchor's own first line, anchor.y + anchor.h) and its bottom (anchor.y2,
 * the LAST line of the block - e.g. the amount line, when the description
 * spans lines above it - or anchor.y itself for a single-line block).
 * Exported so it's testable without a canvas/DOM: the root cause of "a card
 * shows a snippet from a different transaction" was that the snippet only
 * ever looked at ONE line (matched loosely by `Math.abs(l.y - anchor.y) <=
 * anchor.h`), never anchor.y2 - a multi-line block's amount line (often
 * several lines below the block's own anchor) fell outside that single-line
 * window entirely, and the wide loose match could pick up a neighbouring
 * transaction's line instead.
 * @param {{y:number, items:object[]}[]} lines - one page's groupItemsIntoLines() output
 * @param {{y:number, h?:number, y2?:number|null}} anchor
 */
export function blockLines(lines, anchor) {
  const top = anchor.y + (anchor.h || 10);
  const bottom = anchor.y2 ?? anchor.y;
  return (lines || []).filter((l) => l.y <= top + 0.5 && l.y >= bottom - 0.5);
}

/**
 * Shared crop-region math + block-finding + highlight drawing behind both
 * renderRowSnippet (the small on-card crop) and renderRowMagnifier (item 7's
 * bigger hover/focus crop) - same pipeline (render the page, find the row's
 * block via blockLines, crop it plus context, scale to fit a target width/
 * line-height, wash the block's own lines), differing only in how much
 * context padding and how big the result is scaled to. Renders the whole
 * page first (renderPdfPage/opts.items for an OCR'd file, same contract as
 * review.js's source pane) then copies just the block's neighbourhood out of
 * that canvas into a small one - no separate "render only this region" path
 * in pdf.js to keep in sync with the real one.
 * @param {ArrayBuffer} bytes
 * @param {{page:number, y:number, h?:number, y2?:number|null}} anchor - PDF-space anchor (row.original.source_page/source_y/source_h/source_y2)
 * @param {{items?: object[], scale?: number, cropWidthPx: number}} opts - `items` for an OCR'd file (see renderPdfPage); `cropWidthPx` is the no-matching-line fallback width (page-render px), required (callers default it)
 * @param {{padLines: number, maxWidthPx: number, lineTargetPx: number, dpr: number, defaultScale: number}} sizing - padLines: lines of context above/below the block; maxWidthPx/dpr: the result's CSS/bitmap sizing cap; lineTargetPx: legible line height (CSS px) to scale toward; defaultScale: page-render resolution when opts.scale isn't given
 * @returns {Promise<HTMLCanvasElement|null>} null when the row has no page anchor to crop (e.g. a columns-rowModel PDF, or a CSV row - callers fall back to a text snippet there)
 */
async function renderBlockCrop(bytes, anchor, opts, sizing) {
  if (!anchor || anchor.page == null || anchor.y == null) return null;
  const scale = opts.scale ?? sizing.defaultScale;
  const { canvas, viewport, items } = await renderPdfPage(bytes, anchor.page, scale, opts.items ? { items: opts.items } : {});
  const pageCtx = canvas.getContext('2d');

  const lineH = Math.max(1, (anchor.h || 10) * scale);
  const allLines = groupItemsIntoLines(items || []);
  const block = blockLines(allLines, anchor);
  const blockTopY = anchor.y + (anchor.h || 10);
  const blockBottomY = anchor.y2 ?? anchor.y;
  const textTop = pdfYToCanvasPixel(blockTopY, viewport);
  const textBottom = pdfYToCanvasPixel(blockBottomY, viewport);
  const pad = lineH * sizing.padLines;
  const cropTop = Math.max(0, textTop - pad);
  const cropBottom = Math.min(canvas.height, textBottom + pad);
  const cropHeight = Math.max(1, cropBottom - cropTop);

  // Horizontal span across EVERY line in the block, not just one - the
  // amount is often on a different line than the block's own anchor line.
  let left = 0, right = Math.min(canvas.width, opts.cropWidthPx);
  if (block.length) {
    pageCtx.font = `${lineH}px sans-serif`;
    let minLeft = Infinity, maxRight = -Infinity;
    for (const line of block) {
      if (!line.items.length) continue;
      const lastItem = line.items[line.items.length - 1];
      minLeft = Math.min(minLeft, pdfXToCanvasLeft(line.items[0].x, viewport));
      maxRight = Math.max(maxRight, pdfXToCanvasLeft(lastItem.x, viewport) + pageCtx.measureText(lastItem.str).width);
    }
    if (minLeft !== Infinity) {
      left = Math.max(0, minLeft - LINE_PAD_PX);
      right = Math.min(canvas.width, maxRight + LINE_PAD_PX);
    }
  }
  const cropWidth = Math.max(1, right - left);

  // Item 5b: ONE crop, sized to the block itself - no fixed box, no split.
  // Scaled so a line of text renders at a legible target CSS height, capped
  // to a max CSS width (a very long line shrinks slightly instead of ever
  // being cut into two pieces); the result grows to fit whatever height that
  // produces for a multi-line block.
  const lineCount = Math.max(1, Math.round(cropHeight / lineH));
  const targetHeightPx = lineCount * sizing.lineTargetPx * sizing.dpr;
  const fit = Math.min((sizing.maxWidthPx * sizing.dpr) / cropWidth, targetHeightPx / cropHeight);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cropWidth * fit));
  out.height = Math.max(1, Math.round(cropHeight * fit));
  // The result grows to fit (item 5b): CSS display size is the bitmap's own
  // pixel size divided back down by dpr, so a taller multi-line block
  // renders taller on screen instead of being squeezed into a fixed box.
  out.style.width = `${out.width / sizing.dpr}px`;
  out.style.height = `${out.height / sizing.dpr}px`;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#e8e4d8'; // matches .decision-snippet's own background so any letterboxing is invisible
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, left, cropTop, cropWidth, cropHeight, 0, 0, out.width, out.height);

  // Highlight every line of the block (a soft brass wash, not a hard box, so
  // the text underneath stays readable).
  for (const line of block) {
    const lTop = pdfYToCanvasPixel(line.y + (anchor.h || 10), viewport);
    const lBottom = pdfYToCanvasPixel(line.y, viewport);
    const y0 = (lTop - cropTop) * fit;
    const y1 = (lBottom - cropTop) * fit;
    ctx.fillStyle = 'rgba(198, 161, 91, 0.28)';
    ctx.fillRect(0, Math.max(0, y0), out.width, Math.max(1, y1 - Math.max(0, y0)));
  }

  return out;
}

/**
 * Simple B's decision-card snippet: a crop of the rendered page covering the
 * row's own FULL transaction block (source_page/source_y/source_h/source_y2 -
 * the same fields review.js's source-pane outline reads), plus half a line of
 * context above and below, in ONE crop - never split into pieces, the card
 * grows to fit instead (item 5b). See renderBlockCrop for the shared pipeline.
 * @param {ArrayBuffer} bytes
 * @param {{page:number, y:number, h?:number, y2?:number|null}} anchor - PDF-space anchor (row.original.source_page/source_y/source_h/source_y2)
 * @param {{items?: object[], scale?: number, cropWidthPx?: number}} [opts] - `items` for an OCR'd file (see renderPdfPage); `cropWidthPx` is only the no-matching-line fallback width
 * @returns {Promise<HTMLCanvasElement|null>} null when the row has no page anchor to crop (e.g. a columns-rowModel PDF, or a CSV row - callers fall back to a text snippet there)
 */
export async function renderRowSnippet(bytes, anchor, opts = {}) {
  return renderBlockCrop(bytes, { ...anchor }, { ...opts, cropWidthPx: opts.cropWidthPx ?? 480 }, {
    padLines: 0.5, // item 5b: half a line of context above/below
    maxWidthPx: CARD_MAX_W,
    lineTargetPx: LINE_TARGET_PX,
    dpr: CARD_DPR,
    defaultScale: 2,
  });
}

/**
 * Item 7 (NO-TEMPLATES): the decision-card magnifier's bigger crop - the same
 * block renderRowSnippet finds, but with a WHOLE line of context above and
 * below (not half a line - that's the small on-card crop's own choice) and
 * scaled to about MAG_MAX_W CSS px wide at a doubled line-target height, from
 * a higher-resolution page re-render (MAG_SCALE) so it reads as "the same
 * crop, but bigger and with more surrounding context" rather than a
 * CSS-scaled blowup of renderRowSnippet's own small canvas.
 * @param {ArrayBuffer} bytes
 * @param {{page:number, y:number, h?:number, y2?:number|null}} anchor
 * @param {{items?: object[], scale?: number, cropWidthPx?: number}} [opts]
 * @returns {Promise<HTMLCanvasElement|null>} null when the row has no page anchor to crop
 */
export async function renderRowMagnifier(bytes, anchor, opts = {}) {
  return renderBlockCrop(bytes, { ...anchor }, { ...opts, cropWidthPx: opts.cropWidthPx ?? 720 }, {
    padLines: 1, // item 7: a whole line of context above/below, not half
    maxWidthPx: MAG_MAX_W,
    lineTargetPx: MAG_LINE_TARGET_PX,
    dpr: CARD_DPR,
    defaultScale: MAG_SCALE,
  });
}
