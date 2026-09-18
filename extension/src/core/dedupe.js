// Duplicate detection: within-file duplicates are kept (real repeats happen,
// e.g. two identical coffee purchases); cross-file overlaps are merged,
// keeping the max occurrence count seen across the files being compared.

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
 * builtin one) must fingerprint identically, and a profile-agnostic label
 * computed once per file is the only value guaranteed consistent across
 * callers - the row's own `account_label` can be missing (e.g. a freshly
 * wizard-mapped file's normalizeRecords call never received one) even though
 * the file it belongs to knows its account fine.
 */
export function fingerprint(row, accountLabel) {
  const acct = accountLabel ?? row.account_label ?? '';
  return [acct, row.date ?? '', row.amount ?? '', row.currency ?? '', descriptionKey(row.description_raw)].join('|');
}

/**
 * Merge rows from multiple files, collapsing cross-file duplicates.
 * Within a single file's own row list, duplicates are left as-is (each kept).
 * Across files, rows sharing a fingerprint are merged into one, keeping the
 * row from the file with the highest per-file occurrence count for that
 * fingerprint (ties keep the first file encountered).
 * @param {{sourceFile:string, rows:object[], accountLabel?:string, ocr?:boolean}[]} files
 * @returns {{merged: object[], removed: object[]}} removed rows kept for undo
 */
export function mergeAcrossFiles(files) {
  // occurrence count of each fingerprint, per file
  const perFileCounts = files.map(({ rows, accountLabel }) => {
    const counts = new Map();
    for (const row of rows) {
      const fp = fingerprint(row, accountLabel);
      counts.set(fp, (counts.get(fp) || 0) + 1);
    }
    return counts;
  });

  // Winner per fingerprint: highest per-file occurrence count; on a tie,
  // prefer the CSV/text file over a PDF/OCR one (D3 - a CSV export's
  // description is normally more reliable/complete than an OCR read of the
  // same statement), else the first file encountered.
  const bestFileIndexByFp = new Map(); // fp -> { fileIdx, count, ocr }
  files.forEach(({ rows, accountLabel, ocr }, fileIdx) => {
    const counts = perFileCounts[fileIdx];
    for (const row of rows) {
      const fp = fingerprint(row, accountLabel);
      const count = counts.get(fp);
      const best = bestFileIndexByFp.get(fp);
      if (!best || count > best.count || (count === best.count && best.ocr && !ocr)) {
        bestFileIndexByFp.set(fp, { fileIdx, count, ocr: !!ocr });
      }
    }
  });

  const merged = [];
  const removed = [];
  files.forEach(({ rows, accountLabel }, fileIdx) => {
    for (const row of rows) {
      const fp = fingerprint(row, accountLabel);
      const seenElsewhere = files.some((f, i) => i !== fileIdx && perFileCounts[i].has(fp));
      if (!seenElsewhere) { merged.push(row); continue; }
      const best = bestFileIndexByFp.get(fp);
      if (best.fileIdx === fileIdx) {
        // Emit this file's occurrences up to its own count once per fingerprint pass;
        // simplest correct rule: keep all rows from the winning file, drop the rest.
        merged.push(row);
      } else {
        removed.push(row);
      }
    }
  });
  return { merged, removed };
}
