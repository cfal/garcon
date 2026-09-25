import { expect, test } from 'bun:test';
import { isCanonicalExecutorPath, parentExecutorPath } from '../portable-path.js';

test.each([
  ['/', '/'], ['/worker/project', '/worker'], ['C:/', 'C:/'],
  ['C:/worker/project', 'C:/worker'], ['//host/share/', '//host/share/'],
  ['//host/share/project', '//host/share/'], ['/worker/caf\u00e9', '/worker'],
  ['/worker/literal\\name/file', '/worker/literal\\name'],
])('validates and finds the portable parent of %s', (value, parent) => {
  expect(isCanonicalExecutorPath(value)).toBe(true);
  expect(parentExecutorPath(value)).toBe(parent);
});

test.each([
  'relative', '/worker/../project', '/worker/./project', '/worker//project',
  '/worker/project/', 'C:/worker\\project', 'C:/worker/', '//host',
  '//host/../project', '/worker/\0', '/worker/\ud800',
])('rejects noncanonical portable path %s', (value) => {
  expect(isCanonicalExecutorPath(value)).toBe(false);
});
