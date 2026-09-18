// Release gate: one command to run before every reload request. See
// README.md's "Release gate" section.
//
// node dev/gate.mjs           full gate (includes the OCR recall audit)
// node dev/gate.mjs --fast    skips the OCR recall audit (step 6, slow)
//
// Prints a PASS/FAIL/SKIP table with durations and exits non-zero on any
// FAIL. Real-extension e2e steps use the bundled Chromium only (never the
// user's Chrome, never channel:'chrome', never killed) - see each
// dev/e2e-*.mjs's own header comment. This script starts the dev server on
// :8934 itself only if nothing is listening there yet, and stops only the
// one it started.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const fast = process.argv.includes('--fast');
const PORT = 8934;

const results = []; // {name, status: 'PASS'|'FAIL'|'SKIP', ms, detail}

async function step(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - start, detail: detail || '' });
  } catch (err) {
    if (err && err.skip) {
      results.push({ name, status: 'SKIP', ms: Date.now() - start, detail: err.message });
    } else {
      results.push({ name, status: 'FAIL', ms: Date.now() - start, detail: err && err.message ? err.message : String(err) });
    }
  }
}

function skip(message) {
  const e = new Error(message);
  e.skip = true;
  return e;
}

function runNode(args, opts = {}) {
  const res = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`node ${args.join(' ')} exited ${res.status}`);
}

// --- 1. node --test -----------------------------------------------------
async function runUnitTests() {
  const testDir = path.join(root, 'test');
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f));
  runNode(['--test', ...files]);
}

// --- 2. banned words / em-dash sweep ------------------------------------
// Built from char codes / a split literal so this file's own source never
// contains the banned words or an em-dash itself (it would otherwise trip
// the repo-wide sweep in test/banned_words.test.js, which walks dev/ too).
const BANNED_WORDS_RE = new RegExp(['hon' + 'est', 'gen' + 'uine', 'truth' + 'ful'].join('|'), 'i');
const EM_DASH = String.fromCharCode(0x2014);

function listFilesRecursive(p, out = []) {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(p)) listFilesRecursive(path.join(p, entry), out);
  } else {
    out.push(p);
  }
  return out;
}

async function bannedWordsSweep() {
  const targets = [
    ...listFilesRecursive(path.join(root, 'src')),
    path.join(root, 'workspace.html'),
    path.join(root, 'workspace.css'),
    path.join(root, 'README.md'),
  ].filter((f) => fs.existsSync(f) && !/\.(png|jpg|jpeg|ico|gif)$/i.test(f));

  const offenders = [];
  for (const file of targets) {
    const content = fs.readFileSync(file, 'utf-8');
    const rel = path.relative(root, file);
    if (content.includes(EM_DASH)) offenders.push(`${rel}: em-dash`);
    if (BANNED_WORDS_RE.test(content)) offenders.push(`${rel}: banned word (see the banned-words feedback note)`);
  }
  if (offenders.length) throw new Error(offenders.join('; '));
  return `${targets.length} files clean`;
}

// --- 3. network sweep -----------------------------------------------------
// The only network-shaped code allowed in src/ is core/pdf.js's standard-font
// fetch shim - it intercepts an .invalid (never-resolvable) URL and is
// documented in README.md's module map / "vendor/" section. Everything else
// matching fetch(/XMLHttpRequest/WebSocket/http(s):// is a real bug.
const NETWORK_RE = /\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//;
const ALLOWED_SHIM_LINES = new Set([
  "const realFetch = globalThis.fetch?.bind(globalThis);",
  'globalThis.fetch = async (input, init) => {',
  'if (!realFetch) throw new Error(`fetch is unavailable and no shim matched: ${url}`);',
  'return realFetch(input, init);',
  "const STANDARD_FONT_PREFIX = 'https://sb-standard-font.invalid/';",
]);

async function networkSweep() {
  const offenders = [];
  for (const file of listFilesRecursive(path.join(root, 'src')).filter((f) => f.endsWith('.js'))) {
    const rel = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return; // comments/doc-prose
      const codeOnly = line.split(' // ')[0]; // drop a trailing " // comment" (this codebase's own style) before matching
      if (!NETWORK_RE.test(codeOnly)) return;
      if (rel === 'src/core/pdf.js' && ALLOWED_SHIM_LINES.has(trimmed)) return;
      offenders.push(`${rel}:${i + 1}: ${trimmed}`);
    });
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf-8'));
  const csp = manifest.content_security_policy?.extension_pages || '';
  if (!/connect-src\s+'none'/.test(csp)) offenders.push(`manifest.json: connect-src is not 'none' (${csp})`);
  if (manifest.host_permissions && manifest.host_permissions.length) offenders.push(`manifest.json: has host_permissions (${JSON.stringify(manifest.host_permissions)})`);

  if (offenders.length) throw new Error(offenders.join('; '));
  return 'no stray network code; CSP/permissions clean';
}

// --- 6. dev server for the OCR recall audit -------------------------------
function isServerUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: '/', timeout: 800 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startDevServerIfNeeded(port) {
  if (await isServerUp(port)) return null; // already running - not ours to stop
  const child = spawn('python3', ['-m', 'http.server', String(port), '--directory', root], { stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await isServerUp(port)) return child;
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`dev server did not come up on port ${port} within 10s`);
}

const OCR_LAYOUT_THRESHOLDS = [
  { prefix: 'Summit', max: 0 },
  { prefix: 'Riverside', max: 8 },
  { prefix: 'Anchor', max: 0 },
  { prefix: 'Palisade', max: 0 },
  { prefix: 'Worst case', max: 0 },
];

async function ocrRecallAudit() {
  let startedServer = null;
  try {
    startedServer = await startDevServerIfNeeded(PORT);
    const res = spawnSync(process.execPath, [path.join('dev', 'ocr-recall-audit.mjs')], { cwd: root, encoding: 'utf-8' });
    process.stderr.write(res.stderr || '');
    if (res.status !== 0) throw new Error(`ocr-recall-audit.mjs exited ${res.status}: ${(res.stderr || '').slice(-500)}`);
    const data = JSON.parse(res.stdout);

    const offenders = [];
    for (const { prefix, max } of OCR_LAYOUT_THRESHOLDS) {
      const layout = data.layouts.find((l) => l.name && l.name.startsWith(prefix));
      if (!layout) { offenders.push(`${prefix}: no result`); continue; }
      if (layout.error) { offenders.push(`${prefix}: error: ${layout.error}`); continue; }
      const misses = layout.misses.length;
      if (misses > max) offenders.push(`${prefix}: ${misses} misses (baseline <= ${max})`);
    }
    if (offenders.length) throw new Error(offenders.join('; '));
    return 'all layouts within threshold';
  } finally {
    if (startedServer) startedServer.kill();
  }
}

async function main() {
  await step('1. node --test', runUnitTests);
  await step('2. banned words / em-dash sweep', bannedWordsSweep);
  await step('3. network sweep + manifest CSP/permissions', networkSweep);
  await step('4a. e2e-extension.mjs', async () => runNode([path.join('dev', 'e2e-extension.mjs')]));
  await step('4b. e2e-review.mjs', async () => runNode([path.join('dev', 'e2e-review.mjs')]));
  await step('4c. e2e-presets.mjs', async () => runNode([path.join('dev', 'e2e-presets.mjs')]));
  await step('4d. e2e-remove-statements.mjs', async () => runNode([path.join('dev', 'e2e-remove-statements.mjs')]));
  await step('4e. e2e-stale-profile.mjs', async () => runNode([path.join('dev', 'e2e-stale-profile.mjs')]));
  await step('5. e2e-real-files.mjs', async () => {
    if (!fs.existsSync(path.join(root, 'test', 'private'))) throw skip('test/private/ not present');
    runNode([path.join('dev', 'e2e-real-files.mjs')]);
  });
  if (fast) {
    results.push({ name: '6. ocr-recall-audit.mjs', status: 'SKIP', ms: 0, detail: '--fast' });
    results.push({ name: '7. corpus-audit.mjs', status: 'SKIP', ms: 0, detail: '--fast' });
  } else {
    await step('6. ocr-recall-audit.mjs', ocrRecallAudit);
    // Track 1's full synthetic-corpus audit (docs/KNOWN-GAPS.md has the
    // numbers): informational only by default (CORPUS_STRICT=1 to make it a
    // hard gate, once the causes there are fixed) - see corpus-audit.mjs's
    // own doc comment.
    await step('7. corpus-audit.mjs', async () => {
      runNode([path.join('dev', 'corpus-audit.mjs')]);
      return 'see output above / docs/KNOWN-GAPS.md';
    });
  }

  console.log('\nRelease gate results:');
  const nameWidth = Math.max(...results.map((r) => r.name.length), 4);
  for (const r of results) {
    const name = r.name.padEnd(nameWidth);
    const dur = `${(r.ms / 1000).toFixed(1)}s`.padStart(7);
    console.log(`${r.status.padEnd(4)} ${name} ${dur}  ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(failed.length ? `\n${failed.length} step(s) FAILED` : '\nAll steps passed');
  process.exit(failed.length ? 1 : 0);
}

main();
