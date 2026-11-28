import { expect, test } from 'bun:test';
import { classArgument, echo, reply, throwWithInstance } from './recorded-values.js';

test('checks strings and returned classes', () => {
  const separators = 'first\u2028second\u2029third\nfourth';
  const malformed = 'a\ud800b\udc00';
  expect(echo(separators)).toBe(separators);
  expect(echo(malformed)).toBe(malformed);
  expect(echo({ [malformed]: malformed })).toEqual({ [malformed]: malformed });
  const result = reply(malformed);
  expect(result.nested[0]?.label).toBe(malformed);
  expect(classArgument(result)).toBe('reply');
});

test('checks thrown classes and classes in an Error', () => {
  expect(() => throwWithInstance('label', true)).toThrow('invalid reply');
  expect(() => throwWithInstance('label', false)).toThrow();
});
