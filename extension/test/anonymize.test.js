import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymizeEvents } from '../src/core/anonymize.js';

function ev(stage, message, data) {
  return { t: '2026-09-18T00:00:00.000Z', stage, message, data };
}

test('PRIVACY: a known amount, merchant and account number never survive', () => {
  const events = [
    ev('review.decision', 'row fixed', {
      description: 'STARBUCKS COFFEE SG PTE LTD',
      amount: '1,234.56',
      account: '1234567890',
      reference: 'INV-98765432',
    }),
  ];
  const out = anonymizeEvents(events);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('STARBUCKS'), json);
  assert.ok(!json.includes('1,234.56'), json);
  assert.ok(!json.includes('1234567890'), json);
  assert.ok(!json.includes('98765432'), json);
});

test('a non-safe field becomes a length marker (its raw text never survives, masked or not)', () => {
  const raw = 'total was -1,234.56 today';
  const out = anonymizeEvents([ev('x', 'm', { note: raw })]);
  assert.equal(out[0].data.note, `<text ${raw.length} chars>`);
});

test('a safe-keyed string still gets amount/digit masking, not dropped', () => {
  const out = anonymizeEvents([ev('x', 'm', { message: 'account 123456789 over 1,234.56' })]);
  assert.equal(out[0].data.message, 'account ######### over #,###.##');
});

test('free-text fields become a length marker regardless of field name', () => {
  const out = anonymizeEvents([ev('x', 'm', { description: 'abcde', merchant: 'ab', payee: 'abc' })]);
  assert.equal(out[0].data.description, '<text 5 chars>');
  assert.equal(out[0].data.merchant, '<text 2 chars>');
  assert.equal(out[0].data.payee, '<text 3 chars>');
});

test('safe keys (counts, positions, confidences, flags, file names, bank names) pass through', () => {
  const out = anonymizeEvents([ev('home.match', 'match applied', {
    file: 'statement.csv', bank: 'DBS', profileName: 'DBS savings', confidence: 0.92,
    rows: 40, position: 3, ok: true, flagCounts: { lowConfidence: 2 },
  })]);
  assert.deepEqual(out[0].data, {
    file: 'statement.csv', bank: 'DBS', profileName: 'DBS savings', confidence: 0.92,
    rows: 40, position: 3, ok: true, flagCounts: { lowConfidence: 2 },
  });
});

test('stacks survive (with digit-run masking as a defensive net)', () => {
  const out = anonymizeEvents([ev('x', 'boom', { stack: 'Error: boom\n  at parse (amount.js:12345678)' })]);
  assert.ok(out[0].data.stack.startsWith('Error: boom'));
  assert.ok(!out[0].data.stack.includes('12345678'));
});

test('OCR/CSV cell text and raw item text are dropped, not just truncated', () => {
  const textRaw = 'raw ocr line with a name and amount';
  const cellRaw = 'raw csv cell';
  const out = anonymizeEvents([ev('ocr', 'page recognized', { text: textRaw, cell: cellRaw })]);
  assert.equal(out[0].data.text, `<text ${textRaw.length} chars>`);
  assert.equal(out[0].data.cell, `<text ${cellRaw.length} chars>`);
});

test('nested objects and arrays are walked, not skipped', () => {
  const raw = 'nested merchant name';
  const out = anonymizeEvents([ev('x', 'm', { rows: [{ description: raw }] })]);
  assert.equal(out[0].data.rows[0].description, `<text ${raw.length} chars>`);
});

test('never throws on odd input', () => {
  assert.deepEqual(anonymizeEvents(null), []);
  assert.deepEqual(anonymizeEvents(undefined), []);
  assert.deepEqual(anonymizeEvents([{ t: 'x', stage: 'x' }])[0].data, undefined);
});
