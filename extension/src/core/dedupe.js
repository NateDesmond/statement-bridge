// Duplicate detection: within-file duplicates are kept (real repeats happen,
// e.g. two identical coffee purchases); an exact cross-file twin merges silently,
// a near twin (same date and amount, different description) is asked about once,
// keeping the max occurrence count seen across the files being compared. Any
// other cross-file overlap is returned as a `pairs` decision for the user to
// answer once, showing both rows (EXPORT-AND-DUPES rule 3/4).

// The first 12 alphanumeric characters of the normalised description,
// uppercase, no spaces or punctuation. A CSV export of a statement is often
// truncated ("BAT 2C2*LAZADA Singapore SGP") while a PDF/OCR export of the
// SAME transaction is often longer or noisier ("...SGP 12SEP 4628-XXXX", or
// an OCR misread like "SG *8823" -> "SG "8823") - comparing full description
// text misses these as duplicates (Finding 3/D3). A short, punctuation-free
// prefix is stable across both.
function descriptionKey(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

/**
 * SHA-256 hex digest of a file's raw bytes - item B's drop-time identity
 * check ("this exact file is already in the session"), computed BEFORE any
 * parsing or OCR ever runs, so a re-dropped duplicate never re-enters either.
 * A real bug: a re-dropped image PDF got re-queued and fully re-OCR'd a
 * second time after a re-drop - the old bytesEqual/
 * isExactDuplicateFile check only runs after BOTH copies have already been
 * parsed, too late to skip that work.
 * @param {ArrayBuffer} bytes
 */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The already-in-session file (if any) sharing a drop-time content hash with a fresh drop. Pure - just the lookup half of item B's dedupe-before-parsing check. */
export function findDuplicateByHash(files, hash) {
  return (hash && files.find((f) => f.contentHash === hash)) || null;
}

/**
 * Whether two files' raw bytes are byte-for-byte identical (the same file
 * dropped twice). Used to caption a whole-file re-drop as "Dropped twice"
 * rather than a generic partial-overlap merge (QA Finding 1).
 */
export function bytesEqual(a, b) {
  if (!a || !b) return false;
  const ua = a instanceof Uint8Array ? a : new Uint8Array(a);
  const ub = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (ua.length !== ub.length) return false;
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

/**
 * Whether a file whose every row merged away (`count === total`) is a whole-
 * file exact duplicate of the file its rows merged into: either identical
 * bytes, or - when bytes aren't available/comparable (e.g. a re-saved export
 * with different encoding but the same transactions) - an identical row
 * count on both sides, since `count === total` already proves every one of
 * this file's rows fingerprints against a row in the other file.
 */
export function isExactDuplicateFile({ count, total, bytesA, bytesB, otherFileTotal }) {
  if (count !== total) return false;
  if (bytesEqual(bytesA, bytesB)) return true;
  return otherFileTotal === total;
}

/**
 * Compute a fingerprint string for a normalized row.
 * `accountLabel`, when given, is the FILE's own account identity (bank +
 * masked account number, or the user's saved account label) and always wins
 * over the row's own `account_label`: two files matched to different profile
 * ids/names for the same physical account (e.g. a user-saved profile vs a
 * another saved one) must fingerprint identically, and a profile-agnostic label
 * computed once per file is the only value guaranteed consistent across
 * callers - the row's own `account_label` can be missing (e.g. a freshly
 * wizard-mapped file's normalizeRecords call never received one) even though
 * the file it belongs to knows its account fine.
 *
 * Returns null for a row with no parsed date (an unparseable-date row has
 * nothing real to compare dates against) - same root cause as normalize.js's
 * own within-file possible_duplicate fingerprint, fixed the same way: two
 * rows that both failed to parse a date must never merge with each other
 * just because they share that same null.
 */
export function fingerprint(row, accountLabel) {
  if (!row.date) return null;
  const acct = accountLabel ?? row.account_label ?? '';
  return [acct, row.date, row.amount ?? '', row.currency ?? '', descriptionKey(row.description_raw)].join('|');
}

/** Same account, date, amount and currency: everything but the description. */
function nearKey(row, accountLabel) {
  if (!row.date) return null;
  const acct = accountLabel ?? row.account_label ?? '';
  return [acct, row.date, row.amount ?? '', row.currency ?? ''].join('|');
}

/**
 * Merge rows from multiple files.
 * Within a single file's own row list, duplicates are left as-is (each kept:
 * two coffees on the same day are two coffees).
 * Across files, rows sharing a full fingerprint (account, date, amount,
 * currency, description) are the same transaction seen twice (a re-download,
 * an overlapping export) and merge silently, keeping the row from the file
 * with the highest per-file occurrence count for that fingerprint (ties keep
 * the CSV/text file over an OCR one, then the first file encountered).
 * A NEAR match - same account, date, amount and currency but a different
 * description, which is what an OCR'd PDF next to the bank's own CSV looks
 * like - is a real question: both rows are kept and the caller gets ONE
 * `pairs` entry per near key per file pair to ask about, never a per-row
 * flag the user cannot act on.
 * @param {{sourceFile:string, rows:object[], accountLabel?:string, ocr?:boolean}[]} files
 * @returns {{merged: object[], removed: object[], pairs: object[]}} removed rows kept for undo;
 *   each pair is { key, fingerprint, keep:{fileIdx,sourceFile,row,ocr}, drop:{...} }
 */
export function mergeAcrossFiles(files) {
  const perFileCounts = files.map(({ rows, accountLabel }) => {
    const counts = new Map();
    for (const row of rows) {
      const fp = fingerprint(row, accountLabel);
      if (fp == null) continue; // no valid date - never participates in matching
      counts.set(fp, (counts.get(fp) || 0) + 1);
    }
    return counts;
  });
  const perFileNear = files.map(({ rows, accountLabel }) => {
    const m = new Map();
    for (const row of rows) {
      const k = nearKey(row, accountLabel);
      if (k == null) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(row);
    }
    return m;
  });

  const bestFileIndexByFp = new Map(); // fp -> { fileIdx, count, ocr }
  files.forEach(({ rows, accountLabel, ocr }, fileIdx) => {
    const counts = perFileCounts[fileIdx];
    for (const row of rows) {
      const fp = fingerprint(row, accountLabel);
      if (fp == null) continue;
      const count = counts.get(fp);
      const best = bestFileIndexByFp.get(fp);
      if (!best || count > best.count || (count === best.count && best.ocr && !ocr)) {
        bestFileIndexByFp.set(fp, { fileIdx, count, ocr: !!ocr });
      }
    }
  });

  const merged = [];
  const removed = [];
  const pairs = [];
  const pairKeys = new Set(); // one decision per near key per file pair
  files.forEach((file, fileIdx) => {
    const { rows, accountLabel } = file;
    for (const row of rows) {
      const fp = fingerprint(row, accountLabel);
      if (fp == null) { merged.push(row); continue; }
      const best = bestFileIndexByFp.get(fp);
      if (best.fileIdx !== fileIdx) { removed.push(row); continue; }
      merged.push(row);
      const nk = nearKey(row, accountLabel);
      files.forEach((other, otherIdx) => {
        if (otherIdx === fileIdx) return;
        if (perFileCounts[otherIdx].has(fp)) return; // exact twin there: merged silently
        const twin = (perFileNear[otherIdx].get(nk) || []).find((r) => fingerprint(r, other.accountLabel) !== fp
          && !perFileCounts[fileIdx].has(fingerprint(r, other.accountLabel)));
        if (!twin) return;
        const key = `${nk}|${Math.min(fileIdx, otherIdx)}|${Math.max(fileIdx, otherIdx)}`;
        if (pairKeys.has(key)) return;
        pairKeys.add(key);
        // Keep the CSV/text row over the OCR one; on a tie keep the earlier file.
        const thisWins = (!file.ocr && other.ocr) || (!!file.ocr === !!other.ocr && fileIdx < otherIdx);
        const mine = { fileIdx, sourceFile: file.sourceFile, row, ocr: !!file.ocr };
        const theirs = { fileIdx: otherIdx, sourceFile: other.sourceFile, row: twin, ocr: !!other.ocr };
        pairs.push({ key, fingerprint: fp, keep: thisWins ? mine : theirs, drop: thisWins ? theirs : mine });
      });
    }
  });
  return { merged, removed, pairs };
}
