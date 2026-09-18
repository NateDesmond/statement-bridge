// Shared helper for dev/e2e-*.mjs: after driving a scenario against the real
// extension, checks (a) the page raised no uncaught error and (b)
// src/core/debuglog.js's ring buffer holds no entry with a `stack` field -
// only debuglog.js's own error() sets that (a real bug), never informational
// logging. Reads the live module through the already-loaded page (dynamic
// import, same module instance app.js's import graph already loaded)
// instead of re-implementing log parsing here, so this can never drift from
// what debuglog.js actually stores.
//
// Callers collect page errors themselves via `page.on('pageerror', ...)`
// (they already do, for console visibility) and pass the array here.
export async function assertCleanLog(page, label, pageErrors = []) {
  const problems = pageErrors.map((e) => `page error: ${e && e.message ? e.message : e}`);
  const entries = await page.evaluate(async () => {
    const mod = await import('./src/core/debuglog.js');
    return mod.all();
  });
  for (const e of entries) {
    if (e && e.data && e.data.stack) problems.push(`[${e.stage}] ${e.message}`);
  }
  if (problems.length) {
    console.log(`FAIL - ${label}: clean debug log (${problems.length} problem(s)): ${problems.join(' | ')}`);
  } else {
    console.log(`PASS - ${label}: clean debug log (no page errors, no stack entries)`);
  }
  return { ok: problems.length === 0, problems };
}
