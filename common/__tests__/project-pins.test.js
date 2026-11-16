import { expect, test } from 'bun:test';
import { orderedProjectPaths, reconcileProjectPins } from '../project-pins.js';

test('deduplicates Windows slash aliases while retaining exact POSIX paths', () => {
  expect(orderedProjectPaths(['D:\\projects\\one', 'D:/projects/one', '/one\\two', '/one/two', ' /one ', '', 42]))
    .toEqual(['D:\\projects\\one', '/one\\two', '/one/two', ' /one ']);
});

test('replaces the oldest pin without refreshing surviving pins when the request is reordered', () => {
  const before = ['/z', '/b', '/c', '/d', '/a'];
  expect(reconcileProjectPins(before, ['/a', '/b', '/c', '/d', '/z', '/new'], ['/recent']))
    .toEqual({ pinnedPaths: ['/b', '/c', '/d', '/a', '/new'], recentPaths: ['/z', '/recent'] });
});

test('normalizes legacy overflow without losing displaced saved projects', () => {
  const paths = Array.from({ length: 18 }, (_, index) => `/project-${index}`);
  const normalized = reconcileProjectPins([], paths, ['/recent']);
  expect(normalized.pinnedPaths).toEqual(paths.slice(-5));
  expect(normalized.recentPaths).toEqual([...paths.slice(0, -5), '/recent']);
  expect(reconcileProjectPins([], normalized.pinnedPaths, normalized.recentPaths)).toEqual(normalized);
});

test('keeps explicit unpins saved and treats aliases as the same surviving pin', () => {
  expect(reconcileProjectPins(['D:\\one', '/two'], ['D:/one'], ['/recent', '/two']))
    .toEqual({ pinnedPaths: ['D:\\one'], recentPaths: ['/two', '/recent'] });
});
