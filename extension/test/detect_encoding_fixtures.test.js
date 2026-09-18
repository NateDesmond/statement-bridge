import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectEncoding, decodeText } from '../src/core/detect.js';

const fx = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

test('detects a real Windows-1252 CSV fixture and decodes its accented char', () => {
  const bytes = fx('win1252_sample.csv');
  assert.equal(detectEncoding(bytes), 'windows-1252');
  const text = decodeText(bytes);
  assert.match(text, /Café Purchase/);
});

test('detects a UTF-16LE CSV fixture (BOM) and decodes it back to plain text', () => {
  const bytes = fx('utf16_sample.csv');
  assert.equal(detectEncoding(bytes), 'utf-16le');
  const text = decodeText(bytes);
  assert.match(text, /^Transaction Date,Description,Amount/);
  assert.match(text, /Café Purchase/);
});

test('detectEncoding recognises a UTF-16BE BOM', () => {
  const bytes = new Uint8Array([0xfe, 0xff, 0, 0x61, 0, 0x62]);
  assert.equal(detectEncoding(bytes), 'utf-16be');
  assert.equal(decodeText(bytes), 'ab');
});
