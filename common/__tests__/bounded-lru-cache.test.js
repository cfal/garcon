import { expect, test } from 'bun:test';
import { BoundedLruCache } from '../bounded-lru-cache.js';

const cache = (maxEntries, maxBytes) => new BoundedLruCache({ maxEntries, maxBytes, sizeOf: value => value.length });

test('evicts the least recently used entry beyond the entry bound', () => {
  const values = cache(2, 100);
  values.set('a', 'x');
  values.set('b', 'x');
  expect(values.get('a')).toBe('x');
  values.set('c', 'x');
  expect(values.get('b')).toBeUndefined();
  expect(values.get('a')).toBe('x');
  expect(values.get('c')).toBe('x');
  expect(values.size).toBe(2);
});

test('evicts oldest entries until the byte bound holds and skips oversized values', () => {
  const values = cache(10, 10);
  values.set('a', 'xxxx');
  values.set('b', 'xxxx');
  values.set('c', 'xxxx');
  expect(values.get('a')).toBeUndefined();
  expect(values.bytes).toBe(8);
  values.set('huge', 'x'.repeat(11));
  expect(values.get('huge')).toBeUndefined();
  expect(values.size).toBe(2);
});

test('replacing, deleting, and clearing keep the byte total exact', () => {
  const values = cache(10, 100);
  values.set('a', 'xxx');
  values.set('a', 'x');
  expect(values.bytes).toBe(1);
  values.set('b', 'xx');
  values.delete('a');
  expect(values.bytes).toBe(2);
  values.clear();
  expect(values.size).toBe(0);
  expect(values.bytes).toBe(0);
});

test('deletes matching entries and releases their bytes', () => {
  const values = cache(10, 10);
  values.set('keep', 'xx');
  values.set('drop-1', 'xxx');
  values.set('drop-2', 'xxx');
  values.deleteWhere((key) => key.startsWith('drop'));
  expect(values.size).toBe(1);
  expect(values.bytes).toBe(2);
  expect(values.get('keep')).toBe('xx');
});
