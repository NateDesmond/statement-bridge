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

const CARD_W = 320, CARD_H = 96, CARD_DPR = 2; // decision-card snippet's fixed CSS box (workspace.css .decision-snippet), rendered at 2x for a crisp bitmap
const LINE_PAD_PX = 24; // padding either side of the flagged line's own text span, in page-render canvas px
const SUB_CROP_GAP = 14 * CARD_DPR; // 14 CSS px between the two sub-crops when a line is too wide for one - wide enough to read as a deliberate seam, not a hairline
const SUB_CROP_INSET = 6; // page-render px of whitespace trimmed off each sub-crop's cut edge, so the seam never slices a glyph
// A crop that's exactly 3 lines tall, contain-fit into the card, always
// displays at CARD_H/3 CSS px per line regardless of render scale (the fit
// is height-limited, so width cancels out of that math). That's comfortably
// above the 9px x-height floor. It only breaks when the crop is so WIDE that
// the fit becomes width-limited instead - past this width/height ratio, a
// single crop can no longer hit that floor, so two sub-crops are used
// instead (see below). 54 is the crop height (CSS px) that gives exactly a
// 9px x-height at a typical ~0.5 x-height/font-size ratio.
const MAX_SINGLE_ASPECT = CARD_W / 54;

/** Contain-fit an `sw x sh` region of `src` into the `boxW x boxH` box at (boxX, boxY) on `ctx` - centred, never stretched. */
function drawContain(ctx, src, sx, sy, sw, sh, boxX, boxY, boxW, boxH) {
  const scale = Math.min(boxW / sw, boxH / sh);
  const dw = sw * scale, dh = sh * scale;
  const dx = boxX + (boxW - dw) / 2, dy = boxY + (boxH - dh) / 2;
  ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  return { dx, dy, dw, dh, scale };
}

/**
 * Simple B's decision-card snippet: a small crop of the rendered page around
 * one row's own anchor (source_page/source_y/source_h, same fields
 * review.js's source-pane outline already reads), 3 text lines tall so the
 * card shows enough context to judge the row without opening full Review.
 * Renders the whole page first (renderPdfPage/opts.items for an OCR'd file,
 * same contract as review.js's source pane) then copies just the anchor's
 * neighbourhood out of that canvas into a small one - no separate "render
 * only this region" path in pdf.js to keep in sync with the real one.
 *
 * Fix item 3 part 2 (2026-09-18): part 1 cropped to a fixed page-left column,
 * which was still often the full flagged MERCHANT NAME running past it at a
 * ~180px display width - illegible. Crops to the flagged LINE's own text
 * span now (leftmost to rightmost item on that line, from core/pdf.js's own
 * line grouping - the same y-clustering the row parser itself uses), fit
 * into the card's fixed 320x96 CSS box at 2x so the bitmap itself is crisp
 * (workspace.css sizes .decision-snippet/its canvas to match). A span too
 * wide to stay legible at that size (a long merchant name) is shown as two
 * sub-crops side by side - description start, amount end - instead of
 * shrinking the whole line past reading size.
 * @param {ArrayBuffer} bytes
 * @param {{page:number, y:number, h?:number}} anchor - PDF-space anchor (row.original.source_page/source_y/source_h)
 * @param {{items?: object[], scale?: number, contextLines?: number, cropWidthPx?: number}} [opts] - `items` for an OCR'd file (see renderPdfPage); `cropWidthPx` is only the no-matching-line fallback width
 * @returns {Promise<HTMLCanvasElement|null>} null when the row has no page anchor to crop (e.g. a columns-rowModel PDF, or a CSV row - callers fall back to a text snippet there)
 */
export async function renderRowSnippet(bytes, anchor, opts = {}) {
  if (!anchor || anchor.page == null || anchor.y == null) return null;
  const scale = opts.scale ?? 2; // page-render resolution; the card's own display size is fixed below, independent of this
  const { canvas, viewport, items } = await renderPdfPage(bytes, anchor.page, scale, opts.items ? { items: opts.items } : {});
  const pageCtx = canvas.getContext('2d');

  const lineH = Math.max(1, (anchor.h || 10) * scale);
  const textTop = pdfYToCanvasPixel(anchor.y + (anchor.h || 10), viewport);
  const textBottom = pdfYToCanvasPixel(anchor.y, viewport);
  const contextLines = opts.contextLines ?? 1; // one line above/below the flagged one = 3 lines total
  const cropTop = Math.max(0, textTop - lineH * contextLines);
  const cropBottom = Math.min(canvas.height, textBottom + lineH * contextLines);
  const cropHeight = Math.max(1, cropBottom - cropTop);

  // The flagged line's own text span, not the full page width.
  const line = groupItemsIntoLines(items || []).find((l) => Math.abs(l.y - anchor.y) <= (anchor.h || 10));
  let left = 0, right = Math.min(canvas.width, opts.cropWidthPx ?? 480);
  if (line?.items.length) {
    pageCtx.font = `${lineH}px sans-serif`;
    const lastItem = line.items[line.items.length - 1];
    const lastRight = pdfXToCanvasLeft(lastItem.x, viewport) + pageCtx.measureText(lastItem.str).width;
    left = Math.max(0, pdfXToCanvasLeft(line.items[0].x, viewport) - LINE_PAD_PX);
    right = Math.min(canvas.width, lastRight + LINE_PAD_PX);
  }
  const cropWidth = Math.max(1, right - left);

  const snippet = document.createElement('canvas');
  snippet.width = CARD_W * CARD_DPR;
  snippet.height = CARD_H * CARD_DPR;
  const ctx = snippet.getContext('2d');
  ctx.fillStyle = '#e8e4d8'; // matches .decision-snippet's own background so any letterboxing is invisible
  ctx.fillRect(0, 0, snippet.width, snippet.height);

  const boxes = [{ sx: left, sw: cropWidth, boxX: 0, boxW: snippet.width }];
  if (line?.items.length > 1 && cropWidth / cropHeight > MAX_SINGLE_ASPECT) {
    // Too wide to stay legible as one crop: split into two sub-crops side by
    // side - the START of the description and the amount in full (never
    // clipped - trimming a description's tail is fine, trimming a digit off
    // an amount is not) - each in its own half-box instead of one half
    // spanning the whole (still-too-wide) description.
    const lastItem = line.items[line.items.length - 1];
    const splitX = Math.max(left, pdfXToCanvasLeft(lastItem.x, viewport) - LINE_PAD_PX);
    const halfW = (snippet.width - SUB_CROP_GAP) / 2;
    const capW = halfW * (cropHeight / snippet.height); // widest the description sub-crop can be and still land height-limited (full line-height)
    // Trim SUB_CROP_INSET of page whitespace off each side of the cut, so the
    // seam sits inside the gap between words rather than against a glyph.
    const leftW = Math.min(splitX - SUB_CROP_INSET - left, capW);
    const rightSx = splitX + SUB_CROP_INSET;
    boxes[0] = { sx: left, sw: leftW, boxX: 0, boxW: halfW };
    boxes.push({ sx: rightSx, sw: right - rightSx, boxX: halfW + SUB_CROP_GAP, boxW: halfW });
  }

  // A wide-enough, unmistakably-deliberate seam between the two sub-crops
  // (a faint "..." centred on the paper-coloured gap) - not just a thin line
  // that reads as one clipped word running across it.
  if (boxes.length === 2) {
    const gapX = boxes[0].boxX + boxes[0].boxW;
    ctx.fillStyle = '#a89a7d';
    ctx.font = `${9 * CARD_DPR}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('· · ·', gapX + SUB_CROP_GAP / 2, snippet.height / 2);
  }

  // Highlight the flagged line itself within each crop (a soft brass wash,
  // not a hard box, so the text underneath stays readable).
  for (const b of boxes) {
    if (b.sw <= 0) continue;
    const { dx, dy, dw, dh, scale: fit } = drawContain(ctx, canvas, b.sx, cropTop, b.sw, cropHeight, b.boxX, 0, b.boxW, snippet.height);
    const tintTop = dy + (textTop - cropTop) * fit;
    ctx.fillStyle = 'rgba(198, 161, 91, 0.28)';
    ctx.fillRect(dx, Math.max(dy, tintTop), dw, Math.min((textBottom - textTop) * fit, dy + dh - tintTop));
  }

  return snippet;
}
