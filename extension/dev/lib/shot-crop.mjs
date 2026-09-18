// Shared crop helpers for dev/store-shots.mjs and dev/store-shots-static.mjs.
// Owner requirement: every product shot must be tight on the product - no
// empty page background, no huge dark header band. So instead of screenshotting
// the whole viewport, we measure the actual content card's bounding box and
// clip to that plus a small margin.
const MARGIN = 24;

/**
 * Screenshots `selector`'s bounding box (plus MARGIN px on every side,
 * clamped to the viewport) instead of the full page.
 * @param {import('playwright-core').Page} page
 * @param {string} selector
 * @param {string} filePath
 */
export async function shotCardCrop(page, selector, filePath) {
  const box = await page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const vp = page.viewportSize();
  const x = Math.max(0, box.x - MARGIN);
  const y = Math.max(0, box.y - MARGIN);
  const width = Math.min(vp.width - x, box.width + MARGIN * 2);
  const height = Math.min(vp.height - y, box.height + MARGIN * 2);
  await page.screenshot({ path: filePath, clip: { x, y, width, height } });
}

/**
 * Like shotCardCrop, but clips to the union bounding box of every element
 * matching `selector` (plus MARGIN) instead of a single element - for a
 * region made of several pieces (e.g. a set of highlighted cells) rather
 * than one container.
 * @param {import('playwright-core').Page} page
 * @param {string} selector
 * @param {string} filePath
 */
export async function shotUnionCrop(page, selector, filePath) {
  const box = await page.$$eval(selector, (els) => {
    const rects = els.map((el) => el.getBoundingClientRect());
    return {
      x: Math.min(...rects.map((r) => r.x)),
      y: Math.min(...rects.map((r) => r.y)),
      width: Math.max(...rects.map((r) => r.x + r.width)) - Math.min(...rects.map((r) => r.x)),
      height: Math.max(...rects.map((r) => r.y + r.height)) - Math.min(...rects.map((r) => r.y)),
    };
  });
  const vp = page.viewportSize();
  const x = Math.max(0, box.x - MARGIN);
  const y = Math.max(0, box.y - MARGIN);
  const width = Math.min(vp.width - x, box.width + MARGIN * 2);
  const height = Math.min(vp.height - y, box.height + MARGIN * 2);
  await page.screenshot({ path: filePath, clip: { x, y, width, height } });
}

/**
 * Builds a 1280x800 Chrome-Web-Store-style image from a cropped product PNG:
 * the crop scaled to fill the 1280px width (object-fit: cover, so it reads
 * as "the product", not "the product floating in whitespace"), a caption
 * band across the bottom 84px. Renders via a tiny local HTML page so plain
 * Playwright screenshotting (no image library) can do the compositing.
 * @param {import('playwright-core').BrowserContext} context - any open context (persistent or normal); used only for a throwaway blank page, unrelated to what it was launched for
 * @param {Buffer} cropBuffer - PNG bytes of the tight product crop
 * @param {string} filePath
 * @param {string} caption
 */
export async function composeStoreShot(context, cropBuffer, filePath, caption) {
  const dataUri = 'data:image/png;base64,' + cropBuffer.toString('base64');
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(`<!doctype html><html><head><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:1280px;height:800px;overflow:hidden;background:#f3efe6;position:relative;
      font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;}
    /* Scale the crop up as large as it'll go without cropping any of it off
       (object-fit: cover would hard-crop the sides on a wide crop, or the
       top/bottom on a tall one). Letterbox in the product's own paper
       background so any margin reads as the card's own edge, not empty
       page chrome. */
    .product{width:1280px;height:716px;overflow:hidden;background:#faf8f2;display:flex;align-items:center;justify-content:center;}
    .product img{width:100%;height:100%;object-fit:contain;display:block;}
    .band{position:absolute;left:0;right:0;bottom:0;height:84px;background:#0d1a17;border-top:3px solid #c6a15b;
      display:flex;align-items:center;justify-content:center;padding:0 48px;
      font-size:22px;font-weight:600;color:#f3efe6;text-align:center;letter-spacing:0.1px;}
    </style></head><body>
      <div class="product"><img src="${dataUri}"></div>
      <div class="band">${caption}</div>
    </body></html>`);
  await page.waitForTimeout(60);
  await page.screenshot({ path: filePath });
  await page.close();
}
