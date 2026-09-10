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

describe('KeyedPromiseLock cancellation', () => {
  it('rejects an already-aborted acquisition without calling its operation', async () => {
    const lock = new KeyedPromiseLock();
    const controller = new AbortController();
    controller.abort(new Error('synthetic cancellation'));
    let calls = 0;
    await expect(lock.runExclusive('file', async () => { calls += 1; }, controller.signal))
      .rejects.toBe(controller.signal.reason);
    expect(calls).toBe(0);
    expect(await lock.runExclusive('file', async () => 'next')).toBe('next');
  });

  it.each(['before', 'after'])('cancels a waiter without an overtaking successor queued %s cancellation', async (queuedWhen) => {
    const lock = new KeyedPromiseLock();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const calls = [];
    const held = lock.runExclusive('file', async () => {
      entered.resolve();
      await release.promise;
      calls.push('owner released');
    });
    await entered.promise;
    const controller = new AbortController();
    const cancelled = lock.runExclusive('file', async () => calls.push('cancelled'), controller.signal);
    const result = cancelled.catch((error) => error);
    const next = () => lock.runExclusive('file', async () => calls.push('successor'));
    let successor = queuedWhen === 'before' ? next() : undefined;
    let timer;
    try {
      controller.abort(new Error('synthetic cancellation'));
      const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), 1000); });
      expect(await Promise.race([result, deadline])).toBe(controller.signal.reason);
      expect(calls).toEqual([]);
      successor ??= next();
    } finally {
      clearTimeout(timer);
      release.resolve();
      await Promise.all([held, result, successor]);
    }
    expect(calls).toEqual(['owner released', 'successor']);
    expect(await lock.runExclusive('file', async () => 'released')).toBe('released');
  });

  it('does not claim cancellation once its mutation has started', async () => {
    const lock = new KeyedPromiseLock();
    const controller = new AbortController();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const result = lock.runExclusive('file', async () => {
      entered.resolve();
      await release.promise;
      return 'committed';
    }, controller.signal);
    await entered.promise;
    controller.abort(new Error('synthetic cancellation'));
    release.resolve();
    expect(await result).toBe('committed');
  });
});
