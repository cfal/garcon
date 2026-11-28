// Calls the exports of functions.ts for the recorder test to capture.
import { expect, test } from 'bun:test';
import { LABEL, echo, join, kinds, later, make, reject, refuse, shout, wrap } from './functions.js';

test('calls function exports', async () => {
  expect(LABEL).toBe('functions');
  expect(join(['a', 'b'])).toBe('a,b');
  expect(join(['a', 'b'], '.')).toBe('a.b');
  expect(shout('hi')).toBe('HI!');
  expect(echo(undefined)).toBeUndefined();
  expect(echo({ when: new Date(0), tags: new Set(['x']) })).toEqual({ when: new Date(0), tags: new Set(['x']) });
  expect(kinds()).toHaveLength(11);
  expect(() => reject('E_X')).toThrow('rejected E_X');
  expect(() => refuse('plain')).toThrow('plain');
  expect(await later('z')).toBe('later z');
  expect(wrap('a').name).toBe('a');
  expect(make()(1)).toBe(2);
});
