import { expect, it } from 'bun:test';
import { GhSharedReads, sharedReadKey } from '../gh-shared-reads.js';

it('shares one read between concurrent callers of a key and starts afresh after it settles', async () => {
  const reads = new GhSharedReads();
  let started = 0;
  const gate = Promise.withResolvers();
  const read = async () => { started++; await gate.promise; return { started }; };
  const first = reads.run('key', undefined, read);
  const second = reads.run('key', undefined, read);
  const other = reads.run('other', undefined, read);
  await Promise.resolve();
  gate.resolve();
  expect(await second).toBe(await first);
  await other;
  expect(started).toBe(2);
  expect(reads.size).toBe(0);
  await reads.run('key', undefined, read);
  expect(started).toBe(3);
});

it('shares a failure with every waiting caller', async () => {
  const reads = new GhSharedReads();
  const failing = () => Promise.reject(new Error('GitHub refused'));
  const results = await Promise.allSettled([reads.run('key', undefined, failing), reads.run('key', undefined, failing)]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
});

it('aborts the read only after every caller has left, and does not let new callers join it', async () => {
  const reads = new GhSharedReads();
  const signals = [];
  const read = (signal) => {
    signals.push(signal);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      setTimeout(() => resolve('done'), 50);
    });
  };
  const one = new AbortController();
  const two = new AbortController();
  const first = reads.run('key', one.signal, read);
  const second = reads.run('key', two.signal, read);
  await Promise.resolve();
  one.abort(new Error('first left'));
  await expect(first).rejects.toThrow('first left');
  expect(signals[0].aborted).toBe(false);
  two.abort(new Error('second left'));
  await expect(second).rejects.toThrow('second left');
  expect(signals[0].aborted).toBe(true);
  expect(await reads.run('key', undefined, read)).toBe('done');
  expect(signals).toHaveLength(2);
});

it('rejects a caller that is already aborted without starting a read', () => {
  const reads = new GhSharedReads();
  const controller = new AbortController();
  controller.abort(new Error('gone'));
  let started = false;
  expect(() => reads.run('key', controller.signal, async () => { started = true; })).toThrow('gone');
  expect(started).toBe(false);
});

it('keys reads by every part', () => {
  expect(sharedReadKey('status', '/work/a', 1)).not.toBe(sharedReadKey('status', '/work/a', 2));
  expect(sharedReadKey('status', '/work/a,1')).not.toBe(sharedReadKey('status', '/work/a', 1));
});
