// Shared multi-page text-placement layout helper for the OCR-generalisation
// fixture generators (gen-*-style.mjs): tracks a running y cursor across
// pages, starting a new page whenever the next chunk would run past the
// bottom margin. Not a general layout engine - just enough bookkeeping so
// each generator can write "place this line, advance" without hand-tracking
// page breaks (a bug all the existing single/known generators had to do
// manually - see gen-northwind-transaction-history-3p.mjs).
export function makeLayout({ top = 760, bottom = 60 } = {}) {
  const pages = [[]];
  const state = { y: top };
  function ensureRoom(height) {
    if (state.y - height < bottom) { pages.push([]); state.y = top; return true; }
    return false;
  }
  function place(x, text, opts = {}) {
    pages[pages.length - 1].push({ x, y: state.y, text, size: opts.size });
  }
  function placeAt(x, y, text, opts = {}) {
    pages[pages.length - 1].push({ x, y, text, size: opts.size });
  }
  function advance(dy = 18) { state.y -= dy; }
  function newPage() { pages.push([]); state.y = top; }
  return {
    pages, ensureRoom, place, placeAt, advance, newPage,
    get y() { return state.y; },
    set y(v) { state.y = v; },
    get pageIndex() { return pages.length - 1; },
  };
}

/** Deterministic pseudo-random generator (mulberry32) so fixtures are stable across runs. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ISO date string N days before a base ISO date. */
export function isoMinusDays(baseISO, days) {
  const d = new Date(`${baseISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO ('YYYY-MM-DD') -> "D Mon YYYY" (e.g. "14 Sep 2026"), the DEFAULT_DATE_GROUP_RE / DD MMM YYYY shape. */
export function isoToDMonYYYY(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** ISO -> "MM/DD/YYYY" (Anchor Bank). */
export function isoToMMDDYYYY(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

/** ISO -> "DD/MM/YY" (Palisade Bank). */
export function isoToDDMMYY(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}
