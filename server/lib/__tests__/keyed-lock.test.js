import { describe, expect, it } from 'bun:test';
import { KeyedPromiseLock } from '../keyed-lock.ts';

describe('KeyedPromiseLock ordered pairs', () => {
  it('deduplicates and sorts keys before acquisition', async () => {
    const lock = new KeyedPromiseLock();
    const acquired = [];
    const runExclusive = lock.runExclusive.bind(lock);
    lock.runExclusive = (key, fn) => runExclusive(key, async () => {
      acquired.push(key);
      return fn();
    });
    await Promise.all([
      lock.runExclusiveMany(['b', 'a', 'a'], async () => acquired.push('first')),
      lock.runExclusiveMany(['a', 'b'], async () => acquired.push('second')),
    ]);
    expect(acquired).toEqual(['a', 'b', 'first', 'a', 'b', 'second']);
  });

  it('releases every key after rejection without blocking independent keys', async () => {
    const lock = new KeyedPromiseLock();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const failed = lock.runExclusiveMany(['b', 'a'], async () => {
      entered.resolve();
      await release.promise;
      throw new Error('synthetic failure');
    });
    const rejection = failed.catch((error) => error);
    await entered.promise;
    expect(await lock.runExclusiveMany(['c'], async () => 'independent')).toBe('independent');
    release.resolve();
    expect((await rejection).message).toBe('synthetic failure');
    expect(await lock.runExclusiveMany(['a', 'b'], async () => 'released')).toBe('released');
    expect(await lock.runExclusiveMany([], async () => 'empty')).toBe('empty');
  });
});
