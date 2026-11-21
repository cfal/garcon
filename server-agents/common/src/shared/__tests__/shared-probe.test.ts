import { describe, expect, it } from 'bun:test';
import { sharedProbe, waitUnlessAborted } from '../shared-probe.ts';

describe('sharedProbe', () => {
  it('shares one operation between concurrent callers and clears it once settled', async () => {
    const inFlight = new Map<string, Promise<number>>();
    let starts = 0;
    const gate = Promise.withResolvers<number>();
    const start = () => {
      starts += 1;
      return gate.promise;
    };

    const first = sharedProbe(inFlight, 'key', start);
    const second = sharedProbe(inFlight, 'key', start);
    gate.resolve(7);

    expect(await Promise.all([first, second])).toEqual([7, 7]);
    expect(starts).toBe(1);
    expect(inFlight.size).toBe(0);
  });
});

describe('waitUnlessAborted', () => {
  it('rejects with the abort reason while the shared operation keeps running', async () => {
    const controller = new AbortController();
    const operation = Promise.withResolvers<string>();
    const waiting = waitUnlessAborted(operation.promise, controller.signal);

    controller.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    operation.resolve('done');
    expect(await operation.promise).toBe('done');
  });
});
