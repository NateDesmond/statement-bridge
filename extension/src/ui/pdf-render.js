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

const CARD_DPR = 2; // rendered at 2x for a crisp bitmap
// All three in PDF units (not page-render px), so the card crop and the
// magnifier's higher-resolution re-render cover exactly the same region.
const PAD_PDF = 10; // breathing room either side of a run of text
const GUTTER_PDF = 24; // a horizontal gap wider than this is a layout gutter, not a word space
const ELIDED_GAP_PDF = 6; // what such a gutter is squeezed down to

// Item A (NO-TEMPLATES, 2026-09-20): the snippet is sized by the ROW, not by
// a fixed box - the crop is scaled so one line of the row's own text (its
// source_h, in PDF units) lands at SNIPPET_LINE_CSS CSS px, which puts a
// lowercase x-height around half that (>= 11px) and makes the merchant name
// and amount readable without zooming. Before this, the scale was whatever
// made the block fit a 360px box, which squeezed a full-width statement line
// into an unreadable strip.
export const SNIPPET_LINE_CSS = 22;
export const SNIPPET_MAX_H = 96; // CSS px: the tallest a card's crop ever gets
export const MAG_MAX_H = SNIPPET_MAX_H * 2; // the magnifier shows the same region at exactly 2x

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
 * @param {{padLines: number, maxWidthPx: number, maxHeightPx: number, lineCssPx?: number, cssScale?: number, dpr: number}} sizing - padLines: lines of context above/below the block; lineCssPx: the CSS height one line of the row's own text is scaled to (ignored when cssScale is given outright, which is how the magnifier pins itself to exactly 2x the card crop); maxWidthPx/maxHeightPx: CSS caps on the result; dpr: bitmap oversampling
 * @returns {Promise<HTMLCanvasElement|null>} null when the row has no page anchor to crop (e.g. a columns-rowModel PDF, or a CSV row - callers fall back to a text snippet there)
 */
async function renderBlockCrop(bytes, anchor, opts, sizing) {
  if (!anchor || anchor.page == null || anchor.y == null) return null;
  const lineHpdf = anchor.h || 10;
  // CSS px per PDF unit: the row's own line height drives it (see
  // SNIPPET_LINE_CSS), so a small-print statement renders bigger and a
  // large-print one smaller, both landing at the same readable line height.
  let cssScale = sizing.cssScale ?? sizing.lineCssPx / lineHpdf;
  // Render the page at least as finely as the crop will be displayed, so the
  // crop is real resolution rather than an upscaled blur.
  const scale = opts.scale ?? Math.min(4, Math.max(1, cssScale * sizing.dpr));
  const { canvas, viewport, items } = await renderPdfPage(bytes, anchor.page, scale, opts.items ? { items: opts.items } : {});
  const pageCtx = canvas.getContext('2d');

  const lineH = Math.max(1, lineHpdf * scale);
  const allLines = groupItemsIntoLines(items || []);
  const block = blockLines(allLines, anchor);
  const blockTopY = anchor.y + (anchor.h || 10);
  const blockBottomY = anchor.y2 ?? anchor.y;
  const textTop = pdfYToCanvasPixel(blockTopY, viewport);
  const textBottom = pdfYToCanvasPixel(blockBottomY, viewport);
  const pad = lineH * sizing.padLines;
  const cropTop = Math.max(0, textTop - pad);
  const cropBottom = Math.min(canvas.height, textBottom + pad);

  // Horizontal extent of EVERY line in the block, not just one - the amount
  // is often on a different line than the block's own anchor line - as a set
  // of text runs, so the empty gutter between a description and the amount
  // at the page's right margin can be squeezed out (below) instead of eating
  // most of the card's width.
  pageCtx.font = `${lineH}px sans-serif`;
  const runs = [];
  for (const line of block) {
    for (const item of line.items || []) {
      if (!String(item.str || '').trim()) continue; // a blank OCR/text item would pad the crop with empty page
      const x0 = pdfXToCanvasLeft(item.x, viewport);
      runs.push([x0, x0 + pageCtx.measureText(item.str).width]);
    }
  }
  runs.sort((a, b) => a[0] - b[0]);
  // Merge runs that are closer than a gutter apart, pad each group, and clamp
  // to the page: the result is the set of x-bands the crop actually shows.
  const padPx = PAD_PDF * scale;
  const gutterPx = GUTTER_PDF * scale;
  let segments = [];
  for (const [x0, x1] of runs) {
    const last = segments[segments.length - 1];
    if (last && x0 - last[1] <= gutterPx + 2 * padPx) last[1] = Math.max(last[1], x1);
    else segments.push([x0, x1]);
  }
  segments = segments.map(([x0, x1]) => [Math.max(0, x0 - padPx), Math.min(canvas.width, x1 + padPx)]);
  if (!segments.length) segments = [[0, Math.min(canvas.width, opts.cropWidthPx)]];
  const joinPx = ELIDED_GAP_PDF * scale; // what an elided gutter is squeezed down to
  const cropWidth = Math.max(1, segments.reduce((w, [x0, x1]) => w + (x1 - x0), 0) + joinPx * (segments.length - 1));

  // Item 5b: ONE crop, sized to the block itself - no fixed box.
  // Item A: the scale comes from the row's line height (above), not from a
  // box; only if even the gutter-squeezed crop is wider than the space it has
  // does it shrink to fit, so the amount at the line's right edge never falls
  // off.
  if ((cropWidth * cssScale) / scale > sizing.maxWidthPx) cssScale = (sizing.maxWidthPx * scale) / cropWidth;
  // Height cap (after the width fit, so the magnifier's doubled cap covers
  // exactly the same region the card's crop showed): an unusually tall block
  // keeps its top (the merchant line) and loses its tail rather than being
  // scaled down into an unreadable strip again.
  const cropHeight = Math.max(1, Math.min(cropBottom - cropTop, (sizing.maxHeightPx * scale) / cssScale));
  const fit = (cssScale * sizing.dpr) / scale; // page-render px -> output bitmap px
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cropWidth * fit));
  out.height = Math.max(1, Math.round(cropHeight * fit));
  // The result grows to fit (item 5b): CSS display size is the bitmap's own
  // pixel size divided back down by dpr, so a taller multi-line block
  // renders taller on screen instead of being squeezed into a fixed box.
  out.style.width = `${out.width / sizing.dpr}px`;
  out.style.height = `${out.height / sizing.dpr}px`;
  // Item A: the realized numbers, so the magnifier can pin itself to exactly
  // 2x this crop's scale and the e2e can measure (not eyeball) the rendered
  // line height instead of guessing it from pixels.
  out.dataset.cssScale = String(cssScale);
  out.dataset.sourceH = String(lineHpdf);
  out.dataset.lineCssPx = String(lineHpdf * cssScale);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#e8e4d8'; // matches .decision-snippet's own background so any letterboxing is invisible
  ctx.fillRect(0, 0, out.width, out.height);
  let dx = 0;
  for (const [x0, x1] of segments) {
    const w = x1 - x0;
    ctx.drawImage(canvas, x0, cropTop, w, cropHeight, Math.round(dx * fit), 0, Math.round(w * fit), out.height);
    dx += w + joinPx;
  }

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
 * the same fields review.js's source-pane outline reads), plus a line of
 * context above and below, in ONE crop - never split into pieces, the card
 * grows to fit instead (item 5b). See renderBlockCrop for the shared pipeline.
 * @param {ArrayBuffer} bytes
 * @param {{page:number, y:number, h?:number, y2?:number|null}} anchor - PDF-space anchor (row.original.source_page/source_y/source_h/source_y2)
 * @param {{items?: object[], scale?: number, cropWidthPx?: number, maxWidthPx?: number}} [opts] - `items` for an OCR'd file (see renderPdfPage); `cropWidthPx` is only the no-matching-line fallback width; `maxWidthPx` is the CSS width the crop has to live in (the card's own snippet box - the caller measures it)
 * @returns {Promise<HTMLCanvasElement|null>} null when the row has no page anchor to crop (e.g. a columns-rowModel PDF, or a CSV row - callers fall back to a text snippet there)
 */
export async function renderRowSnippet(bytes, anchor, opts = {}) {
  return renderBlockCrop(bytes, { ...anchor }, { ...opts, cropWidthPx: opts.cropWidthPx ?? 480 }, {
    padLines: 1, // item A: a line of context above and below
    maxWidthPx: opts.maxWidthPx ?? 640,
    maxHeightPx: SNIPPET_MAX_H,
    lineCssPx: SNIPPET_LINE_CSS,
    dpr: CARD_DPR,
  });
}

/**
 * Item 7/A (NO-TEMPLATES): the decision-card magnifier's crop - exactly the
 * region renderRowSnippet showed, at exactly 2x its realized CSS scale (the
 * caller passes `cssScale` straight off the on-card canvas's own
 * dataset.cssScale), re-rendered from the page at that higher resolution
 * rather than being a CSS-scaled blowup of the small canvas. Same padLines
 * and the doubled height cap, so the region matches line for line.
 * @param {ArrayBuffer} bytes
 * @param {{page:number, y:number, h?:number, y2?:number|null}} anchor
 * @param {{items?: object[], scale?: number, cropWidthPx?: number, cssScale: number}} [opts] - `cssScale`: the CSS px per PDF unit to render at (2x the snippet's)
 * @returns {Promise<HTMLCanvasElement|null>} null when the row has no page anchor to crop
 */
export async function renderRowMagnifier(bytes, anchor, opts = {}) {
  return renderBlockCrop(bytes, { ...anchor }, { ...opts, cropWidthPx: opts.cropWidthPx ?? 720 }, {
    padLines: 1,
    maxWidthPx: Infinity, // the panel scrolls; the scale is pinned to 2x, never shrunk to fit
    maxHeightPx: MAG_MAX_H,
    cssScale: opts.cssScale ?? SNIPPET_LINE_CSS * 2 / (anchor.h || 10),
    dpr: CARD_DPR,
  });
}
