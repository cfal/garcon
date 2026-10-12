import { expect, test } from 'bun:test';
import { parseBasePath, stripBasePath } from '../base-path.js';

test.each([['', ''], ['/', ''], ['/garcon', '/garcon'], ['/tools/garcon/', '/tools/garcon'], ['/a_B-1.2~', '/a_B-1.2~']])(
  'normalizes mount %s', (input, expected) => expect(parseBasePath(input)).toBe(expected),
);

test.each(['relative', '//host', '/a//b', '/a//', '/.', '/a/../b', '/a/./b', '/a%2fb', '/a%20b', '/a?b', '/a#b', '/a\\b', '/a b', '/a\nb', '/a\n', '/a\r\n', '/a\t', '/<script>', '/:id', '/*', '/' + 'a'.repeat(1024)])(
  'rejects ambiguous or unsafe mount %s', input => expect(() => parseBasePath(input)).toThrow('Invalid base path'),
);

test('checks the length limit after normalizing the trailing slash', () => {
  const longestBasePath = '/' + 'a'.repeat(1023);
  expect(parseBasePath(longestBasePath)).toBe(longestBasePath);
  expect(parseBasePath(`${longestBasePath}/`)).toBe(longestBasePath);
  expect(() => parseBasePath(`${longestBasePath}a/`)).toThrow('Invalid base path');
});

test('strips only complete mount segments, preserving query-independent encoded route data', () => {
  expect(stripBasePath('/tools/garcon/api/v1/files', '/tools/garcon')).toBe('/api/v1/files');
  expect(stripBasePath('/tools/garcon', '/tools/garcon')).toBe('/');
  expect(stripBasePath('/tools/garcon/', '/tools/garcon')).toBe('/');
  expect(stripBasePath('/tools/garcon-other/api', '/tools/garcon')).toBeNull();
  expect(stripBasePath('/api', '/tools/garcon')).toBeNull();
  expect(stripBasePath('/tools/garcon/a%20b', '/tools/garcon')).toBe('/a%20b');
});
