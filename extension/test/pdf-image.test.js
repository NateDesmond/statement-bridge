import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImageOnly, opNamesFromOperatorList } from '../src/core/pdf-image.js';

test('isImageOnly is true for a page with an image op and near-zero text', () => {
  assert.equal(isImageOnly([], ['paintImageXObject']), true);
  assert.equal(isImageOnly([{ str: 'Pg 1' }], ['paintImageXObject']), true); // 4 chars, well under threshold
});

test('isImageOnly is false when there is a real text layer, even alongside an image (e.g. a logo)', () => {
  const items = [{ str: 'Statement of Account '.repeat(5) }]; // >40 chars
  assert.equal(isImageOnly(items, ['paintImageXObject']), false);
});

test('isImageOnly is false with no image ops, regardless of text amount', () => {
  assert.equal(isImageOnly([], []), false);
  assert.equal(isImageOnly([{ str: 'hi' }], ['constructPath', 'showText']), false);
});

test('isImageOnly respects a custom minChars threshold', () => {
  const items = [{ str: 'twelve chars' }]; // 12 chars
  assert.equal(isImageOnly(items, ['paintImageXObject'], { minChars: 5 }), false);
  assert.equal(isImageOnly(items, ['paintImageXObject'], { minChars: 40 }), true);
});

test('opNamesFromOperatorList maps numeric fnArray codes back to OPS names', () => {
  const OPS = { showText: 1, paintImageXObject: 2, constructPath: 3 };
  const names = opNamesFromOperatorList([1, 2, 2, 3], OPS);
  assert.deepEqual(new Set(names), new Set(['showText', 'paintImageXObject', 'constructPath']));
});

test('opNamesFromOperatorList ignores unknown codes', () => {
  const OPS = { showText: 1 };
  assert.deepEqual(opNamesFromOperatorList([1, 999], OPS), ['showText']);
});
