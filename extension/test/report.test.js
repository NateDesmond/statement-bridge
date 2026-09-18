import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport, reportToJson, buildMailto, truncateLog,
  REPORT_VERSION, SUPPORT_EMAIL, MAX_LOG_BYTES, MAX_MAILTO_CHARS, PASTE_INSTRUCTION,
} from '../src/core/report.js';

const NOW = 1_800_000_000_000;

function events(count, padBytes) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      t: new Date(NOW - (count - i) * 1000).toISOString(),
      stage: 'stage' + i,
      message: 'entry ' + i,
      // 'stack' is a safe key (survives anonymisation as-is, digits aside),
      // so padding with it actually stresses the size guard post-anonymisation.
      data: padBytes ? { stack: 'x'.repeat(padBytes) } : { rows: i },
    });
  }
  return out;
}

function build(over) {
  return buildReport(Object.assign({
    extensionVersion: '0.1.0',
    userAgent: 'Mozilla/5.0 (Test)',
    whatHappened: 'the amount was wrong on row 3',
    fileName: 'meridian_savings.csv',
    includeLog: true,
    events: events(3),
    now: NOW,
  }, over || {}));
}

// ---- report shape ---------------------------------------------------------

test('buildReport produces the documented envelope', () => {
  const r = build();
  assert.equal(r.kind, 'statement-bridge-problem-report');
  assert.equal(r.reportVersion, REPORT_VERSION);
  assert.equal(r.extensionVersion, '0.1.0');
  assert.equal(r.userAgent, 'Mozilla/5.0 (Test)');
  assert.equal(r.createdAt, NOW);
  assert.equal(r.fileName, 'meridian_savings.csv');
  assert.equal(r.whatHappened, 'the amount was wrong on row 3');
  assert.equal(r.logIncluded, true);
  assert.equal(r.logTruncated, false);
  assert.ok(Array.isArray(r.log) && r.log.length === 3);
  assert.ok(typeof r.logNote === 'string' && r.logNote.length > 0);
});

test('buildReport tolerates missing everything', () => {
  const r = buildReport();
  assert.equal(r.extensionVersion, 'unknown');
  assert.equal(r.userAgent, 'unknown');
  assert.equal(r.whatHappened, '');
  assert.equal(r.fileName, '');
  assert.equal(r.logIncluded, false);
  assert.equal(r.log, null);
  assert.equal(typeof r.createdAt, 'number');
});

test('report serializes to readable JSON', () => {
  const json = reportToJson(build());
  const parsed = JSON.parse(json);
  assert.equal(parsed.kind, 'statement-bridge-problem-report');
  assert.ok(json.includes('\n'));
});

// ---- consent + anonymisation flow through buildReport ---------------------

test('declining the debug log ACTUALLY leaves it out', () => {
  const r = build({ includeLog: false });
  assert.equal(r.log, null);
  assert.equal(r.logIncluded, false);
  assert.equal(reportToJson(r).indexOf('stage0'), -1);
});

test('consent defaults to included when the flag is omitted', () => {
  const r = build({ includeLog: undefined });
  assert.equal(r.logIncluded, true);
  assert.ok(r.log);
});

test('a known amount, merchant and account number never survive into the assembled report', () => {
  const r = build({
    events: [{
      t: new Date(NOW).toISOString(),
      stage: 'wizard.test',
      message: 'row fixed',
      data: { description: 'NTUC FAIRPRICE PTE LTD', amount: '1,234.56', account: '9876543210' },
    }],
  });
  const json = reportToJson(r);
  assert.ok(!json.includes('NTUC FAIRPRICE'), json);
  assert.ok(!json.includes('1,234.56'), json);
  assert.ok(!json.includes('9876543210'), json);
});

// ---- size guard -------------------------------------------------------------

test('a log under the limit is included whole', () => {
  const t = truncateLog(events(10, 100));
  assert.equal(t.truncated, false);
  assert.equal(t.entriesIncluded, 10);
});

test('an oversized log is trimmed to the most recent entries, with truncation disclosed', () => {
  const big = events(20, 40 * 1024); // well over MAX_LOG_BYTES
  const t = truncateLog(big);
  assert.equal(t.truncated, true);
  assert.ok(t.entriesIncluded < 20);
  // survivors are the newest (tail), since events are oldest-first
  assert.equal(t.log[t.log.length - 1].stage, big[big.length - 1].stage);

  const r = build({ events: big });
  assert.equal(r.logTruncated, true);
  assert.match(r.logNote, /TRUNCATED/);
  assert.match(r.logNote, /KB/);
});

test('truncateLog never throws on junk', () => {
  for (const v of [null, undefined, {}, 'nope', 7]) {
    const t = truncateLog(v);
    assert.equal(t.log, null);
    assert.equal(t.truncated, false);
  }
});

test('a custom maxLogBytes is respected', () => {
  const t = truncateLog(events(8, 100), 10);
  assert.equal(t.truncated, true);
  assert.ok(t.entriesIncluded < 8);
});

// ---- mailto -----------------------------------------------------------------

function mailto(over) {
  return buildMailto(Object.assign({
    email: SUPPORT_EMAIL,
    extensionVersion: '0.1.0',
    whatHappened: 'the amount was wrong on row 3',
    fileName: 'meridian_savings.csv',
  }, over || {}));
}

function bodyOf(url) { return decodeURIComponent(url.split('&body=')[1] || ''); }
function subjectOf(url) { return decodeURIComponent((url.split('?subject=')[1] || '').split('&body=')[0]); }

test('buildMailto addresses SUPPORT_EMAIL and versions the subject', () => {
  const url = mailto();
  assert.equal(url.indexOf('mailto:' + SUPPORT_EMAIL + '?'), 0);
  assert.equal(subjectOf(url), 'Statement Bridge problem report v0.1.0');
});

test('the mail body carries the user\'s words, the file name and the paste instruction', () => {
  const body = bodyOf(mailto());
  assert.ok(body.includes('the amount was wrong on row 3'));
  assert.ok(body.includes('File: meridian_savings.csv'));
  assert.ok(body.includes(PASTE_INSTRUCTION));
});

test('an empty description gets a placeholder rather than a blank email', () => {
  assert.ok(bodyOf(mailto({ whatHappened: '' })).includes('(describe what happened here)'));
});

test('no file line when there is no file', () => {
  assert.equal(bodyOf(mailto({ fileName: '' })).indexOf('File:'), -1);
});

test('the mail body NEVER carries the debug log, and stays under the mailto budget', () => {
  const url = mailto({ whatHappened: 'x'.repeat(3000) });
  assert.ok(url.length <= MAX_MAILTO_CHARS, 'draft length ' + url.length);
  assert.ok(!bodyOf(url).includes('"log"'));
});

test('mailto is properly encoded (newlines and specials survive, no raw newline in the URL)', () => {
  const url = mailto({ whatHappened: 'line one\nline two & more?' });
  assert.equal(url.indexOf('\n'), -1);
  assert.ok(bodyOf(url).includes('line one\nline two & more?'));
});
