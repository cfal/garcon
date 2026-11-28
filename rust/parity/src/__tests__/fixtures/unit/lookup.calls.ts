import { expect, test } from 'bun:test';
import { lookup } from './lookup.js';

test('looks up an own value', () => {
  expect(lookup('fixture')).toBe('value');
});
