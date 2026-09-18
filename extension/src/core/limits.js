// File-size / batch-size limits and a guard against pathological user-supplied regex.

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
export const WARN_FILE_COUNT = 50;
export const WARN_ROW_COUNT = 100_000;
export const MAX_REGEX_LENGTH = 200;
export const REGEX_TIME_BUDGET_MS = 50;

/** Reject a file before processing if it exceeds the per-file size cap. */
export function checkFileSize(bytesLength) {
  if (bytesLength > MAX_FILE_BYTES) {
    return { ok: false, reason: `File exceeds ${MAX_FILE_BYTES / (1024 * 1024)} MB limit` };
  }
  return { ok: true };
}

/** Warn (don't block) above 50 files or 100k rows. */
export function checkBatchSize(fileCount, rowCount) {
  const warnings = [];
  if (fileCount > WARN_FILE_COUNT) warnings.push(`${fileCount} files selected, more than ${WARN_FILE_COUNT} may be slow`);
  if (rowCount > WARN_ROW_COUNT) warnings.push(`${rowCount} rows, more than ${WARN_ROW_COUNT} may be slow`);
  return warnings;
}

/**
 * Compile a user-supplied regex pattern under a length guard, and run it
 * against a sample, rejecting it if that sample run blew the time budget.
 * ponytail: this measures the sample run after the fact, it can't preempt a
 * truly exponential pattern already mid-backtrack (JS can't interrupt sync
 * code). A hard ceiling needs the regex test run in a Worker that gets
 * terminate()'d on timeout, add that if a pattern is ever reported hanging
 * the page for real. This catches the common case: any pattern that is
 * already slow on a small sample gets rejected before it reaches full data.
 * Returns { ok, regex? , reason? }.
 */
export function safeCompileRegex(pattern, sample = '') {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return { ok: false, reason: `Pattern too long (max ${MAX_REGEX_LENGTH} chars)` };
  }
  let regex;
  try { regex = new RegExp(pattern); } catch { return { ok: false, reason: 'Invalid regular expression' }; }

  const start = Date.now();
  try { regex.test(sample); } catch { return { ok: false, reason: 'Regex failed to execute' }; }
  const elapsed = Date.now() - start;
  if (elapsed > REGEX_TIME_BUDGET_MS) {
    return { ok: false, reason: `Pattern too slow (${elapsed}ms on sample)` };
  }
  return { ok: true, regex };
}
