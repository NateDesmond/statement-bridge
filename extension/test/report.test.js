import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport, reportToJson, buildMailto,
  REPORT_VERSION, SUPPORT_EMAIL, MAX_MAILTO_CHARS, PASTE_INSTRUCTION,
} from '../src/core/report.js';

const NOW = 1_800_000_000_000;

function t(offsetMs) { return new Date(NOW - 100000 + offsetMs).toISOString(); }

function realisticEvents() {
  return [
    { t: t(0), stage: 'home.drop', message: 'file dropped', data: { name: 'card_all.csv', size: 12345 } },
    { t: t(10), stage: 'home.drop', message: 'file type detected', data: { name: 'card_all.csv', type: 'text' } },
    { t: t(50), stage: 'home.match', message: 'match applied', data: {
      file: 'card_all.csv', profile: 'Standard Chartered credit card', confidence: 0.95, rows: 310,
      bank: 'Standard Chartered', statementType: 'credit_card', fileType: 'csv', quickLookRows: 2,
    } },
    { t: t(80), stage: 'review', message: 'count check rendered', data: { sourceFile: 'card_all.csv', extractedCount: 310, sourceLines: 310, matches: true, tone: 'ok' } },
    { t: t(90), stage: 'review', message: 'file summary + checks', data: {
      sourceFile: 'card_all.csv', rowCount: 310, byCurrency: { SGD: 310 }, balanceReconciles: true,
      flagsHistogram: { possible_duplicate: 1 }, quickLookRows: 2,
    } },
    { t: t(200), stage: 'home.drop', message: 'file dropped', data: { name: 'aug_2026_savings.pdf', size: 55555 } },
    { t: t(210), stage: 'home.pdf', message: 'image-only PDF detected at drop, starting on-device text recognition automatically', data: { file: 'aug_2026_savings.pdf', totalChars: 0, pages: 3 } },
    { t: t(220), stage: 'home.ocr', message: 'Text recognition completed', data: { file: 'aug_2026_savings.pdf', pages: 3 } },
    { t: t(230), stage: 'home.match', message: 'text recognition match applied', data: {
      file: 'aug_2026_savings.pdf', profile: 'DBS savings', confidence: 0.91, rows: 31,
      bank: 'DBS', statementType: 'savings', fileType: 'pdf', quickLookRows: 0,
    } },
    { t: t(240), stage: 'home.parse', message: 'a parse error happened, oh no', data: {
      file: 'aug_2026_savings.pdf', message: 'boom', stack: 'Error: boom\n  at parsePdf (pdf.js:123:45)\n  at readAll (worker.js:9:1)',
    } },
  ];
}

function build(over) {
  return buildReport(Object.assign({
    extensionVersion: '0.1.0',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    whatHappened: 'the amount was wrong on row 3',
    statementLabel: 'Statement 2',
    events: realisticEvents(),
    now: NOW,
  }, over || {}));
}

// ---- report shape ---------------------------------------------------------

test('buildReport produces the documented envelope', () => {
  const r = build();
  assert.equal(r.kind, 'statement-bridge-problem-report');
  assert.equal(r.reportVersion, REPORT_VERSION);
  assert.equal(r.extensionVersion, '0.1.0');
  assert.equal(r.browser, 'Chrome');
  assert.equal(r.os, 'macOS');
  assert.equal(r.createdAt, NOW);
  assert.equal(r.statement, 'Statement 2');
  assert.equal(r.whatHappened, 'the amount was wrong on row 3');
  assert.equal(r.statements.length, 2);
});

test('buildReport tolerates missing everything', () => {
  const r = buildReport();
  assert.equal(r.extensionVersion, 'unknown');
  assert.equal(r.browser, 'unknown');
  assert.equal(r.os, 'unknown');
  assert.equal(r.whatHappened, '');
  assert.equal(r.statement, '');
  assert.deepEqual(r.statements, []);
  assert.equal(typeof r.createdAt, 'number');
});

test('report serializes to readable JSON', () => {
  const json = reportToJson(build());
  const parsed = JSON.parse(json);
  assert.equal(parsed.kind, 'statement-bridge-problem-report');
  assert.ok(json.includes('\n'));
});

// ---- item 10: no per-transaction data, no file names -----------------------

test('the report never contains a real file name', () => {
  const json = reportToJson(build());
  assert.ok(!json.includes('card_all.csv'), json);
  assert.ok(!json.includes('aug_2026_savings.pdf'), json);
});

test('the report never contains a per-row array (transactions, descriptions, amounts, dates)', () => {
  const r = build();
  // Every statement is a flat structural object; nowhere is there an array
  // of row-shaped objects (something with date/amount/description keys).
  for (const s of r.statements) {
    for (const [key, value] of Object.entries(s)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') {
            assert.ok(!('date' in item), `${key} carries a row-shaped entry`);
            assert.ok(!('amount' in item), `${key} carries a row-shaped entry`);
            assert.ok(!('description' in item), `${key} carries a row-shaped entry`);
          }
        }
      }
    }
  }
  const json = reportToJson(r);
  assert.ok(!/"amount"\s*:/.test(json));
  assert.ok(!/"description"\s*:/.test(json));
});

test('a statement summary reads as counts and structure, not a transaction', () => {
  const r = build();
  const dbs = r.statements.find((s) => /DBS/.test(s.summary));
  assert.ok(dbs, JSON.stringify(r.statements));
  assert.match(dbs.summary, /^Statement \d+: PDF, 3 pages, read with text recognition, 31 rows, 0 quick-look rows, detected bank: DBS, type: savings$/);
  const sc = r.statements.find((s) => /Standard Chartered/.test(s.summary));
  assert.match(sc.summary, /310 rows/);
  assert.equal(sc.checks.balanceReconciles, true);
  assert.equal(sc.checks.countCheck, 'ok');
});

test('an error keeps its message and stack, with source file locations stripped', () => {
  const r = build();
  const withError = r.statements.find((s) => s.errors.length);
  assert.ok(withError);
  const err = withError.errors[0];
  assert.equal(err.message, 'a parse error happened, oh no');
  assert.ok(!err.stack.includes('pdf.js'), err.stack);
  assert.ok(!err.stack.includes('worker.js'), err.stack);
  assert.ok(err.stack.includes('Error: boom'));
});

test('a fresh wizard save (never auto-matched) still reports its bank/type/rows, same as an auto-match', () => {
  const r = build({
    events: [
      { t: t(0), stage: 'home.drop', message: 'file dropped', data: { name: 'my_new_statement.csv', size: 1 } },
      { t: t(10), stage: 'wizard.save', message: 'statement type saved', data: {
        file: 'my_new_statement.csv', profileId: 'p1', versionId: 'v1', rowCount: 12, rows: 12,
        bank: 'UOB', statementType: 'savings', fileType: 'csv', quickLookRows: 1,
      } },
    ],
  });
  assert.equal(r.statements.length, 1);
  assert.match(r.statements[0].summary, /12 rows/);
  assert.match(r.statements[0].summary, /detected bank: UOB/);
  assert.match(r.statements[0].summary, /type: savings/);
  assert.ok(!JSON.stringify(r).includes('my_new_statement.csv'));
});

test('stage timings are present per statement, oldest first, non-negative', () => {
  const r = build();
  for (const s of r.statements) {
    assert.ok(s.stages.length > 0);
    for (const stg of s.stages) assert.ok(stg.msFromStart >= 0);
  }
});

// ---- mailto -----------------------------------------------------------------

function mailto(over) {
  return buildMailto(Object.assign({
    email: SUPPORT_EMAIL,
    extensionVersion: '0.1.0',
    whatHappened: 'the amount was wrong on row 3',
    statementLabel: 'Statement 2',
  }, over || {}));
}

function bodyOf(url) { return decodeURIComponent(url.split('&body=')[1] || ''); }
function subjectOf(url) { return decodeURIComponent((url.split('?subject=')[1] || '').split('&body=')[0]); }

test('buildMailto addresses SUPPORT_EMAIL and versions the subject', () => {
  const url = mailto();
  assert.equal(url.indexOf('mailto:' + SUPPORT_EMAIL + '?'), 0);
  assert.equal(subjectOf(url), 'Statement Bridge problem report v0.1.0');
});

test('the mail body carries the user\'s words, the statement label and the paste instruction', () => {
  const body = bodyOf(mailto());
  assert.ok(body.includes('the amount was wrong on row 3'));
  assert.ok(body.includes('Statement: Statement 2'));
  assert.ok(body.includes(PASTE_INSTRUCTION));
});

test('an empty description gets a placeholder rather than a blank email', () => {
  assert.ok(bodyOf(mailto({ whatHappened: '' })).includes('(describe what happened here)'));
});

test('no statement line when none was picked', () => {
  assert.equal(bodyOf(mailto({ statementLabel: '' })).indexOf('Statement:'), -1);
});

test('the mail body NEVER carries per-statement detail, and stays under the mailto budget', () => {
  const url = mailto({ whatHappened: 'x'.repeat(3000) });
  assert.ok(url.length <= MAX_MAILTO_CHARS, 'draft length ' + url.length);
  assert.ok(!bodyOf(url).includes('"statements"'));
});

test('mailto is properly encoded (newlines and specials survive, no raw newline in the URL)', () => {
  const url = mailto({ whatHappened: 'line one\nline two & more?' });
  assert.equal(url.indexOf('\n'), -1);
  assert.ok(bodyOf(url).includes('line one\nline two & more?'));
});
