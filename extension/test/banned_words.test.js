import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git', 'scratch']);
const BANNED_WORDS_RE = /honest|genuine|truthful/i;
const EM_DASH = '—';

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

test('no em-dashes or banned words anywhere outside vendor/', () => {
  const offenders = [];
  for (const file of walk(root)) {
    // this test file legitimately contains the banned patterns as string/regex literals; skip it.
    if (path.resolve(file) === path.resolve(__filename)) continue;
    if (/\.(png|jpg|jpeg|ico|gif)$/i.test(file)) continue;
    const content = fs.readFileSync(file, 'utf-8');
    if (content.includes(EM_DASH)) offenders.push(`${file}: contains an em-dash`);
    if (BANNED_WORDS_RE.test(content)) offenders.push(`${file}: contains a banned word (honest/genuine/truthful)`);
  }
  assert.deepEqual(offenders, []);
});

// Simple-mode rename (SIMPLE-BUILD.md Section 3): internal ids like "profile",
// "preset" and "OCR" must read as plain words ("statement type", "column
// layout"/"columns", "text recognition"/"reading") wherever a user actually
// sees them. This can't tell visible text from code with certainty without a
// real parser, so it uses two lazy but effective heuristics instead of one:
//   - HTML: strip <script>/<style>/comments/tags, then check what's left
//     (plus common visible attributes: placeholder/aria-label/title/alt/value).
//   - JS: strip comments, pull out string/template literals, drop any ${...}
//     interpolation (that's code, not text), and only check the literal's
//     STATIC text if it contains a space - a lone word like 'profiles' is
//     almost always an id/storage-key/class, never a sentence a user reads.
// ponytail: heuristic, not an AST - a false positive just means someone reads
// this list and shrugs; upgrade to a real parser if that gets noisy.
const BANNED_ID_RE = /\bprofile(s)?\b|\bpreset(s)?\b|\bocr\b/i;
const UI_DIRS = ['src/ui'];

function stripJsComments(js) {
  return js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// A literal where every space-separated token contains a hyphen (or a dot,
// for a CSS selector like ".settings-grid") reads as a class-name/selector
// list, not a sentence a user reads - e.g. "pdf-anchor-hint preset-preview-
// caption" or "#screen-profiles .settings-grid". Real UI copy essentially
// never hyphenates every single word, so this is a cheap way to tell the two
// apart without a real CSS-vs-string parser.
function looksLikeClassOrSelectorList(text) {
  const tokens = text.trim().split(/\s+/);
  return tokens.length > 0 && tokens.every((t) => /[-.]/.test(t) && /^[#.a-z0-9_-]+$/i.test(t));
}

// Template literals routinely nest (`${cond ? \`...\` : ''}`), which a single
// non-greedy regex can't track - it just stops at the first inner backtick
// and resyncs garbage from there. A tiny hand-rolled scanner instead walks
// the source once, matching quotes/backticks/braces by depth, so a nested
// template's static text is read correctly instead of producing noise.
function skipString(code, i, quote) {
  i++;
  while (i < code.length && code[i] !== quote) { if (code[i] === '\\') i++; i++; }
  return i + 1;
}

/** Returns { text, end } - `text` is the template's static parts only (each ${...} collapsed to a space), `end` is the index just past the closing backtick. `code[start]` must be '`'. */
function readTemplate(code, start) {
  let i = start + 1;
  let text = '';
  while (i < code.length) {
    const c = code[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { i++; break; }
    if (c === '$' && code[i + 1] === '{') { i = skipBraceExpr(code, i + 2); text += ' '; continue; }
    text += c;
    i++;
  }
  return { text, end: i };
}

/** `code[start]` is just past a '${' - skips to just past its matching '}', descending into any nested strings/templates/braces along the way. */
function skipBraceExpr(code, start) {
  let depth = 1;
  let i = start;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (c === '{') { depth++; i++; }
    else if (c === '}') { depth--; i++; }
    else if (c === '`') { i = readTemplate(code, i).end; }
    else if (c === '"' || c === "'") { i = skipString(code, i, c); }
    else i++;
  }
  return i;
}

function jsVisibleStrings(js) {
  const code = stripJsComments(js);
  const out = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '`') {
      const { text, end } = readTemplate(code, i);
      i = end;
      const staticText = text.replace(/<[^>]+>/g, ' '); // drop markup (and its class/id attributes) built inline
      if (staticText.includes(' ') && !looksLikeClassOrSelectorList(staticText)) out.push(staticText);
    } else if (c === '"' || c === "'") {
      const end = skipString(code, i, c);
      const staticText = code.slice(i + 1, end - 1).replace(/<[^>]+>/g, ' ');
      i = end;
      if (staticText.includes(' ') && !looksLikeClassOrSelectorList(staticText)) out.push(staticText);
    } else {
      i++;
    }
  }
  return out;
}

function htmlVisibleText(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const attrs = [];
  const attrRe = /\b(?:placeholder|aria-label|title|alt|value)="([^"]*)"/gi;
  let m;
  while ((m = attrRe.exec(stripped))) attrs.push(m[1]);
  // One entry per line (not the whole document as one blob) so an offender
  // shows up as a short, readable snippet instead of a giant dump.
  const lines = stripped.replace(/<[^>]+>/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean);
  return [...lines, ...attrs];
}

test('no internal ids (profile/preset/OCR) in user-visible text', () => {
  const offenders = [];

  const html = fs.readFileSync(path.join(root, 'workspace.html'), 'utf-8');
  for (const text of htmlVisibleText(html)) {
    if (BANNED_ID_RE.test(text)) offenders.push(`workspace.html: "${text.trim().slice(0, 120)}"`);
  }

  for (const dir of UI_DIRS) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of walk(full)) {
      if (!file.endsWith('.js')) continue;
      const rel = path.relative(root, file);
      const content = fs.readFileSync(file, 'utf-8');
      for (const text of jsVisibleStrings(content)) {
        if (BANNED_ID_RE.test(text)) offenders.push(`${rel}: "${text.trim().slice(0, 120)}"`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});
