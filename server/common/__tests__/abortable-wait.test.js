import { describe, expect, spyOn, test } from 'bun:test';
import { waitAbortably } from '../abortable-wait.ts';

describe('waitAbortably', () => {
  test('throws the reason synchronously for an already-aborted signal', () => {
    const reason = new Error('already cancelled');
    expect(() => waitAbortably(Promise.resolve('unused'), AbortSignal.abort(reason))).toThrow(reason);
  });

  test.each(['resolve', 'reject'])('removes the abort listener when work %ss', async (settle) => {
    const controller = new AbortController();
    const work = Promise.withResolvers();
    const add = spyOn(controller.signal, 'addEventListener');
    const remove = spyOn(controller.signal, 'removeEventListener');
    try {
      const result = waitAbortably(work.promise, controller.signal).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const value = settle === 'resolve' ? 'done' : new Error('synthetic failure');
      work[settle](value);
      expect(await result).toEqual(settle === 'resolve' ? { value } : { error: value });
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
      controller.abort();
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  test.each(['resolve', 'reject'])('ends only the wait when aborted before work %ss', async (settle) => {
    const controller = new AbortController();
    const work = Promise.withResolvers();
    const reason = new Error('cancelled wait');
    const waiting = waitAbortably(work.promise, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    const settled = work.promise.then((value) => value, (error) => error);
    const value = settle === 'resolve' ? 'late result' : new Error('late failure');
    work[settle](value);
    expect(await settled).toBe(value);
    await expect(waiting).rejects.toBe(reason);
  });
});
