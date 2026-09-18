import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFileType, detectEncoding, decodeText, detectDelimiter } from '../src/core/detect.js';

test('detects PDF by magic bytes', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 rest of file');
  assert.equal(detectFileType(bytes), 'pdf');
});

test('detects xlsx by PK zip header', () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]);
  assert.equal(detectFileType(bytes), 'xlsx');
});

test('detects text otherwise', () => {
  const bytes = new TextEncoder().encode('date,amount\n1/1/2026,10.00');
  assert.equal(detectFileType(bytes), 'text');
});

test('detects UTF-8 BOM', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]);
  assert.equal(detectEncoding(bytes), 'utf-8-bom');
});

test('detects plain UTF-8', () => {
  const bytes = new TextEncoder().encode('hello world');
  assert.equal(detectEncoding(bytes), 'utf-8');
});

test('falls back to windows-1252 for invalid UTF-8 byte sequences', () => {
  const bytes = new Uint8Array([0x93, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x94]); // curly quotes in cp1252
  assert.equal(detectEncoding(bytes), 'windows-1252');
});

test('decodeText strips BOM', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('hi')]);
  assert.equal(decodeText(bytes), 'hi');
});

test('detects comma delimiter', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n4,5,6'), ',');
});

test('detects tab delimiter', () => {
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

test('detects semicolon delimiter', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3\n4;5;6'), ';');
});
