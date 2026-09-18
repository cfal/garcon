import { expect, test } from 'bun:test';
import { isCanonicalNodePath, parentNodePath } from '../portable-path.js';

test.each([
  ['/', '/'], ['/worker/project', '/worker'], ['C:/', 'C:/'],
  ['C:/worker/project', 'C:/worker'], ['//host/share/', '//host/share/'],
  ['//host/share/project', '//host/share/'], ['/worker/caf\u00e9', '/worker'],
  ['/worker/literal\\name/file', '/worker/literal\\name'],
])('validates and finds the portable parent of %s', (value, parent) => {
  expect(isCanonicalNodePath(value)).toBe(true);
  expect(parentNodePath(value)).toBe(parent);
});

test.each([
  'relative', '/worker/../project', '/worker/./project', '/worker//project',
  '/worker/project/', 'C:/worker\\project', 'C:/worker/', '//host',
  '//host/../project', '/worker/\0', '/worker/\ud800',
])('rejects noncanonical portable path %s', (value) => {
  expect(isCanonicalNodePath(value)).toBe(false);
});
