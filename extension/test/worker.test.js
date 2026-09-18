import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsvChunked, runParseJob } from '../src/worker.js';
import { builtinProfiles } from '../src/core/builtin-profiles.js';

const dbsSavingsVersion = builtinProfiles().find((p) => p.id === 'builtin-meridian-savings').versions[0];
const csvFixture = () => readFileSync(fileURLToPath(new URL('./fixtures/meridian_savings.csv', import.meta.url)), 'utf-8');

function collector() {
  const messages = [];
  return { messages, postMessage: (m) => messages.push(m) };
}

test('parseCsvChunked reports progress and returns the full grid', async () => {
  const text = csvFixture();
  const progress = [];
  const { grid, aborted } = await parseCsvChunked(text, {
    onProgress: (done, total) => progress.push([done, total]),
    isCancelled: () => false,
  });
  assert.equal(aborted, false);
  assert.ok(grid.length > 4);
  assert.equal(grid[4][0], 'Transaction Date');
});

test('parseCsvChunked aborts mid-parse when isCancelled flips true', async () => {
  const text = csvFixture();
  let rowsSeen = 0;
  const { grid, aborted } = await parseCsvChunked(text, {
    isCancelled: () => { rowsSeen++; return rowsSeen > 3; },
  });
  assert.equal(aborted, true);
  assert.ok(grid.length <= 4);
});

test('runParseJob (csv) posts progress then a result message, same protocol as before', async () => {
  const { messages, postMessage } = collector();
  await runParseJob(
    { jobId: 'j1', kind: 'csv', text: csvFixture(), version: dbsSavingsVersion, meta: { source_file: 'dbs.csv' } },
    { postMessage, isCancelled: () => false },
  );
  const result = messages.find((m) => m.type === 'result');
  assert.ok(result, 'expected a result message');
  assert.equal(result.jobId, 'j1');
  assert.ok(Array.isArray(result.rows) && result.rows.length > 0);
  const finalProgress = messages.filter((m) => m.type === 'progress').at(-1);
  assert.ok(finalProgress);
  assert.equal(finalProgress.done, finalProgress.total);
});

test('runParseJob (csv) posts cancelled instead of result when cancelled mid-parse', async () => {
  const { messages, postMessage } = collector();
  let calls = 0;
  await runParseJob(
    { jobId: 'j2', kind: 'csv', text: csvFixture(), version: dbsSavingsVersion, meta: {} },
    { postMessage, isCancelled: () => { calls++; return calls > 2; } },
  );
  assert.ok(messages.some((m) => m.type === 'cancelled' && m.jobId === 'j2'));
  assert.ok(!messages.some((m) => m.type === 'result'));
});

test('runParseJob (xlsx) parses via SheetJS and posts a result', async () => {
  const bytes = readFileSync(fileURLToPath(new URL('./fixtures/meridian_savings.xlsx', import.meta.url)));
  const { messages, postMessage } = collector();
  await runParseJob(
    { jobId: 'j3', kind: 'xlsx', bytes, version: { csv: { headerRow: 4, skipRowsBefore: 4, footerRules: [{ type: 'startsWith', value: 'Total' }] }, fields: dbsSavingsVersion.fields, dateFormat: dbsSavingsVersion.dateFormat, numberFormat: dbsSavingsVersion.numberFormat, signConvention: dbsSavingsVersion.signConvention }, meta: {} },
    { postMessage, isCancelled: () => false },
  );
  const result = messages.find((m) => m.type === 'result');
  assert.ok(result, 'expected a result message');
  assert.ok(result.rows.length > 0);
});

test('runParseJob (xlsx) honours cancel before the parse starts', async () => {
  const bytes = readFileSync(fileURLToPath(new URL('./fixtures/meridian_savings.xlsx', import.meta.url)));
  const { messages, postMessage } = collector();
  await runParseJob(
    { jobId: 'j4', kind: 'xlsx', bytes, version: { csv: {} }, meta: {} },
    { postMessage, isCancelled: () => true },
  );
  assert.ok(messages.some((m) => m.type === 'cancelled'));
  assert.ok(!messages.some((m) => m.type === 'result'));
});

test('runParseJob posts an error message for an unknown kind, unchanged protocol', async () => {
  const { messages, postMessage } = collector();
  await runParseJob({ jobId: 'j5', kind: 'nope', version: {}, meta: {} }, { postMessage, isCancelled: () => false });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'error');
  assert.equal(messages[0].jobId, 'j5');
});
