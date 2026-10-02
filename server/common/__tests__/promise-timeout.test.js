import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PromiseTimeoutError, withPromiseTimeout } from '../promise-timeout.ts';

const spies = [];
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
});

function timerFixture() {
  const timer = {};
  let expire;
  const set = spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
    expire = callback;
    return timer;
  });
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  spies.push(set, clear);
  return { timer, set, clear, expire: () => expire() };
}

describe('withPromiseTimeout', () => {
  test.each(['resolve', 'reject'])('clears its timer when work %ss first', async (settle) => {
    const fixture = timerFixture();
    const work = Promise.withResolvers();
    const waiting = withPromiseTimeout(work.promise, 123, 'synthetic work');
    const result = waiting.then((value) => value, (error) => error);
    const value = settle === 'resolve' ? 'done' : new Error('synthetic failure');
    work[settle](value);
    expect(await result).toBe(value);
    expect(fixture.set).toHaveBeenCalledWith(expect.any(Function), 123);
    expect(fixture.clear).toHaveBeenCalledWith(fixture.timer);
  });

  test.each(['resolve', 'reject'])('times out without cancelling work that later %ss', async (settle) => {
    const fixture = timerFixture();
    const work = Promise.withResolvers();
    const waiting = withPromiseTimeout(work.promise, 123, 'synthetic work');
    const result = waiting.catch((error) => error);
    fixture.expire();
    const failure = await result;
    expect(failure).toBeInstanceOf(PromiseTimeoutError);
    expect(failure.message).toBe('synthetic work timed out after 123ms');
    expect(fixture.clear).toHaveBeenCalledWith(fixture.timer);
    const settled = work.promise.then((value) => value, (error) => error);
    const value = settle === 'resolve' ? 'late result' : new Error('late failure');
    work[settle](value);
    expect(await settled).toBe(value);
    await expect(waiting).rejects.toBe(failure);
  });
});
