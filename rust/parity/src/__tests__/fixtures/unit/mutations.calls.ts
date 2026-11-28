import { expect, test } from 'bun:test';
import { mutate, mutateLater, MutatingConstructor } from './mutations.js';

test('mutates synchronous, asynchronous and constructor inputs', async () => {
  const input = { count: 3 };
  expect(mutate(input)).toBe(3);
  expect(await mutateLater(input)).toBe(4);
  expect(new MutatingConstructor(input).before).toBe(5);
  expect(input.count).toBe(6);
});
