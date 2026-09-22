import { expect, test } from 'bun:test';
import { GitResultTransfers } from '../git-results.js';
import { decodeGitChunk } from '../git-protocol.js';
import { GIT_MAX_RESULT_BYTES, GIT_RESULT_CHUNK_BYTES } from '../../../common/git-execution.js';

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
    let ran = false;
    await expect(transfers.produce(async () => { ran = true; }, options)).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
    expect(ran).toBe(false);
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

test('retirement or cancellation during production cannot retain a result', async () => {
  const transfers = new GitResultTransfers(scope);
  const operation = Promise.withResolvers<string>();
  const pending = transfers.produce(() => operation.promise, options).catch(error => error);
  transfers.dispose();
  operation.resolve('x'.repeat(GIT_RESULT_CHUNK_BYTES));
  expect(await pending).toMatchObject({ code: 'GIT_UNAVAILABLE' });
});
