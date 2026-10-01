import { expect, test } from 'bun:test';
import { mapWithConcurrency, mapWithConcurrencyResult } from '../concurrency.js';

test('observes a rejection alongside a simultaneous success in both variants', async () => {
  const failure = new Error('Synthetic failure');
  const work = async (item: number) => { if (item === 1) throw failure; return item; };
  await expect(mapWithConcurrency([0, 1], 2, async item => { await work(item); })).rejects.toBe(failure);
  await expect(mapWithConcurrencyResult([0, 1], 2, work)).rejects.toBe(failure);
});

test('stops admission after failure but waits for every already-started sibling', async () => {
  const held = Promise.withResolvers<void>();
  const started: number[] = [];
  const failure = new DOMException('Synthetic cancellation', 'AbortError');
  let settled = false;
  const result = mapWithConcurrency([0, 1, 2, 3], 2, async item => {
    started.push(item);
    if (item === 0) throw failure;
    await held.promise;
  }).then(() => { settled = true; }, error => { settled = true; return error; });
  await Bun.sleep(0);
  expect(started).toEqual([0, 1]);
  expect(settled).toBe(false);
  held.resolve();
  expect(await result).toBe(failure);
  expect(started).toEqual([0, 1]);
});

test('handles synchronous and undefined rejections without losing them', async () => {
  const result = await mapWithConcurrency([1, 2], 2, () => { throw undefined; })
    .then(() => 'resolved', error => ({ error }));
  expect(result).toEqual({ error: undefined });
});

test('bounds concurrency, keeps result order, and handles empty input', async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrencyResult([3, 2, 1, 0, 4], 2, async value => {
    maximum = Math.max(maximum, ++active);
    await Bun.sleep(value);
    active--;
    return value * 2;
  });
  expect(maximum).toBe(2);
  expect(active).toBe(0);
  expect(results).toEqual([6, 4, 2, 0, 8]);
  expect(await mapWithConcurrencyResult([], 2, async () => 1)).toEqual([]);
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    await expect(mapWithConcurrency([], invalid, async () => {})).rejects.toBeInstanceOf(RangeError);
  }
});
