import { expect, test } from 'bun:test';
import { GitResultTransfers } from '../git-results.js';
import { decodeGitChunk } from '../git-protocol.js';
import { GIT_MAX_CONCURRENT_QUERIES, GIT_MAX_RETAINED_RESULTS, GIT_MAX_RESULT_BYTES, GIT_RESULT_CHUNK_BYTES } from '../../../common/git-execution.js';

const scope = { nodeId: 'node', instanceId: 'instance', sessionId: 'session' };
const options = { signal: new AbortController().signal, budgetMs: 30_000 };

test('query results are immutable, scoped, bounded and released on close or deadline', async () => {
  let now = 0;
  const transfers = new GitResultTransfers(scope, () => now);
  const value = { text: 'x'.repeat(GIT_RESULT_CHUNK_BYTES) };
  try {
    const first = await transfers.produce(async () => value, options);
    const second = await transfers.produce(async () => value, options);
    expect(first.kind).toBe('transfer');
    if (first.kind !== 'transfer' || second.kind !== 'transfer') throw new Error('Expected result handles');
    value.text = 'changed';
    expect(decodeGitChunk(transfers.readChunk({ transfer: first.transfer, offset: 0 }, options.signal).data).toString())
      .toStartWith('{"text":"xxx');
    expect((await transfers.produce(async () => ({ ok: true }), options)).kind).toBe('inline');
    for (const field of ['nodeId', 'instanceId', 'sessionId', 'kind'] as const) {
      expect(() => transfers.readChunk({ transfer: { ...first.transfer, [field]: 'wrong' }, offset: 0 }, options.signal)).toThrow('Invalid Git');
    }
    expect(() => transfers.readChunk({ transfer: first.transfer, offset: -1 }, options.signal)).toThrow('Invalid Git');
    expect(() => transfers.readChunk({ transfer: first.transfer, offset: first.size + 1 }, options.signal)).toThrow('Invalid Git');
    transfers.close(first.transfer);
    expect((await transfers.produce(async () => ({ ok: true }), options)).kind).toBe('inline');
    now = options.budgetMs;
    expect(() => transfers.readChunk({ transfer: second.transfer, offset: 0 }, options.signal)).toThrow('expired');
  } finally { transfers.dispose(); }
  await expect(transfers.produce(async () => ({}), options)).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' });
});

test('reserves producer capacity before work and releases it only after settlement', async () => {
  const transfers = new GitResultTransfers(scope);
  const barriers = Array.from({ length: GIT_MAX_CONCURRENT_QUERIES }, () => Promise.withResolvers<void>());
  let started = 0;
  const pending = barriers.map(barrier => transfers.produce(async () => {
    started++;
    await barrier.promise;
    return { ok: true };
  }, options));
  try {
    expect(started).toBe(8);
    await expect(transfers.produce(async () => { started++; return {}; }, options))
      .rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
    expect(started).toBe(8);
    expect((await transfers.produce(async () => ({ success: true }), { ...options, mutation: true })).kind).toBe('inline');
    barriers[0].resolve();
    await pending[0];
    expect((await transfers.produce(async () => ({}), options)).kind).toBe('inline');
  } finally {
    for (const barrier of barriers) barrier.resolve();
    await Promise.allSettled(pending);
    transfers.dispose();
  }
});

test('retained byte limits charge actual serialized bytes without blocking inline metadata', async () => {
  const transfers = new GitResultTransfers(scope);
  const value = 'x'.repeat(GIT_MAX_RESULT_BYTES - 2);
  try {
    const first = await transfers.produce(async () => value, options);
    const second = await transfers.produce(async () => value, options);
    if (first.kind !== 'transfer' || second.kind !== 'transfer') throw new Error('Expected transfers');
    expect(first.size + second.size).toBe(64 * 1024 * 1024);
    await expect(transfers.produce(async () => 'x'.repeat(GIT_RESULT_CHUNK_BYTES), options))
      .rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
    expect((await transfers.produce(async () => ({}), options)).kind).toBe('inline');
    transfers.close(first.transfer);
    transfers.close(first.transfer);
    expect((await transfers.produce(async () => value, options)).kind).toBe('transfer');
    await expect(transfers.produce(async () => 'x'.repeat(GIT_RESULT_CHUNK_BYTES), options))
      .rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
  } finally { transfers.dispose(); }
});

test('bounds retained handle count independently of producers and bytes', async () => {
  const transfers = new GitResultTransfers(scope);
  try {
    const handles = [];
    for (let index = 0; index < GIT_MAX_RETAINED_RESULTS; index++) {
      handles.push(await transfers.produce(async () => 'x'.repeat(GIT_RESULT_CHUNK_BYTES), options));
    }
    await expect(transfers.produce(async () => 'x'.repeat(GIT_RESULT_CHUNK_BYTES), options))
      .rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
    expect((await transfers.produce(async () => 'metadata', options)).kind).toBe('inline');
    const first = handles[0];
    if (first.kind !== 'transfer') throw new Error('Expected transfer');
    transfers.close(first.transfer);
    expect((await transfers.produce(async () => 'x'.repeat(GIT_RESULT_CHUNK_BYTES), options)).kind).toBe('transfer');
  } finally { transfers.dispose(); }
});

test('serialized limits include JSON escaping and failed production releases reservations', async () => {
  const transfers = new GitResultTransfers(scope);
  try {
    await expect(transfers.produce(async () => '\0'.repeat(Math.ceil(GIT_MAX_RESULT_BYTES / 6)), options))
      .rejects.toMatchObject({ code: 'GIT_RESULT_TOO_LARGE' });
    await expect(transfers.produce(async () => { throw new Error('failed'); }, options)).rejects.toThrow('failed');
    expect((await transfers.produce(async () => 'ok', options)).kind).toBe('inline');
    await expect(transfers.produce(async () => 'x'.repeat(GIT_RESULT_CHUNK_BYTES), { ...options, mutation: true }))
      .rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
    expect(() => decodeGitChunk('not base64')).toThrow('Invalid Git');
    expect(() => decodeGitChunk(Buffer.alloc(GIT_RESULT_CHUNK_BYTES + 1).toString('base64'))).toThrow('Invalid Git');
  } finally { transfers.dispose(); }
});

test('retirement during production cannot retain a result', async () => {
  const transfers = new GitResultTransfers(scope);
  const operation = Promise.withResolvers<string>();
  const pending = transfers.produce(() => operation.promise, options).catch(error => error);
  transfers.dispose();
  operation.resolve('x'.repeat(GIT_RESULT_CHUNK_BYTES));
  expect(await pending).toMatchObject({ code: 'GIT_UNAVAILABLE' });
});

test('cancellation retains producer capacity until the work settles', async () => {
  const transfers = new GitResultTransfers(scope);
  const abort = new AbortController();
  const gate = Promise.withResolvers<string>();
  const pending = Array.from({ length: GIT_MAX_CONCURRENT_QUERIES }, () =>
    transfers.produce(() => gate.promise, { ...options, signal: abort.signal }).catch(error => error));
  try {
    abort.abort(new Error('cancelled'));
    await expect(transfers.produce(async () => ({}), options)).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
    gate.resolve('x'.repeat(GIT_RESULT_CHUNK_BYTES));
    expect((await Promise.all(pending)).every(error => error.message === 'cancelled')).toBe(true);
    expect((await transfers.produce(async () => ({}), options)).kind).toBe('inline');
  } finally {
    gate.resolve('');
    await Promise.all(pending);
    transfers.dispose();
  }
});
