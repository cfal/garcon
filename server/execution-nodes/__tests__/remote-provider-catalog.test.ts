import { expect, mock, test } from 'bun:test';
import { NodeProviderCapacity } from '../../execution-node/provider-capacity.js';
import type { AgentCatalogSnapshot } from '@garcon/server-agent-interface';
import { NodeProviderCatalogHost } from '../../execution-node/provider-catalog-host.js';
import { NodeWorkerServiceClient, NodeWorkerServiceServer } from '../../execution-node/worker/service-channel.js';
import { parseNodeWorkerServiceText, type NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import { NodeWorkerWriter } from '../../execution-node/worker/writer.js';
import { NODE_WORKER_WRITER_LIMITS } from '../../execution-node/worker/limits.js';
import { RemoteProviderCatalogService } from '../remote-provider-catalog.js';

const snapshot = (label: string): AgentCatalogSnapshot => ({ models: [{ value: 'same-model', label }], defaultModel: 'same-model',
  requiresStrictModelDiscovery: true, generation: { priority: 10, model: 'same-model' } });

function fixture() {
  const first = Promise.withResolvers<AgentCatalogSnapshot>();
  const readFirst = mock(() => first.promise);
  const readSecond = mock(async () => snapshot('Second profile'));
  const hosts = new Map([['first', new NodeProviderCatalogHost(new NodeProviderCapacity(), 'first', { snapshot: readFirst })],
    ['second', new NodeProviderCatalogHost(new NodeProviderCapacity(), 'second', { snapshot: readSecond })]]);
  const physical = new AbortController();
  const failed = mock((error: unknown) => { physical.abort(error); });
  const options = { session: { controllerBootId: 'controller-boot', nodeBootId: 'node-boot', logicalSessionId: 'session' },
    connectionId: 1, signal: physical.signal, validate() {}, failed };
  const writerOptions = { ...NODE_WORKER_WRITER_LIMITS, signal: physical.signal,
    failed(error: unknown) { if (!physical.signal.aborted) failed(error); } };
  let alter: (result: NodeWorkerServiceResult) => NodeWorkerServiceResult = (result) => result;
  const requestWriter = new NodeWorkerWriter({ async write(bytes) {
    const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
    if (!frame) throw new Error('Invalid synthetic request');
    server.receive(frame);
  }, close() {} }, writerOptions);
  const replyWriter = new NodeWorkerWriter({ async write(bytes) {
    const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
    if (!frame || frame.type !== 'node-worker-service-result') throw new Error('Invalid synthetic reply');
    client.receive({ ...frame, result: alter(frame.result) });
  }, close() {} }, writerOptions);
  const client = new NodeWorkerServiceClient(requestWriter, options);
  const server = new NodeWorkerServiceServer(replyWriter, async (command, signal) => {
    if (command.method !== 'provider-catalog') return { kind: 'rejected', code: 'VALIDATION_FAILED' };
    const owner = hosts.get(command.instanceId);
    return owner ? owner.snapshot({ strict: command.strict }, signal) : { kind: 'rejected', code: 'VALIDATION_FAILED' };
  }, options);
  return { first, readFirst, readSecond, client, failed, physical,
    catalog: (id: string) => new RemoteProviderCatalogService(client, id),
    alterReply(fn: typeof alter) { alter = fn; },
    close() { first.resolve(snapshot('First profile')); physical.abort(); client.close(); server.close(); requestWriter.close(); replyWriter.close(); },
  };
}

test('interleaved catalog discovery retains exact instance selection and captured strictness', async () => {
  const f = fixture();
  try {
    const request = { strict: true };
    const first = f.catalog('first').snapshot(request, new AbortController().signal);
    request.strict = false;
    expect(await f.catalog('second').snapshot({ strict: false }, new AbortController().signal)).toEqual(snapshot('Second profile'));
    f.first.resolve(snapshot('First profile'));
    expect(await first).toEqual(snapshot('First profile'));
    expect(f.readFirst).toHaveBeenCalledWith({ strict: true }, expect.any(AbortSignal));
    expect(f.readSecond).toHaveBeenCalledWith({ strict: false }, expect.any(AbortSignal));
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('a foreign catalog reply fails its captured physical channel', async () => {
  const f = fixture();
  try {
    f.alterReply((result) => result.kind === 'provider-catalog' ? { ...result, instanceId: 'first' } : result);
    await expect(f.catalog('second').snapshot({ strict: true }, new AbortController().signal))
      .rejects.toMatchObject({ name: 'NodeWorkerServiceReplyError', code: 'NODE_WORKER_PROTOCOL' });
    expect(f.physical.signal.aborted).toBe(true);
    expect(f.failed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('catalog cancellation cannot deliver late results or borrow a sibling profile', async () => {
  const f = fixture();
  try {
    const caller = new AbortController();
    const pending = f.catalog('first').snapshot({ strict: true }, caller.signal);
    const reason = new Error('Synthetic catalog cancellation');
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    f.first.resolve(snapshot('First profile'));
    expect(await f.catalog('second').snapshot({ strict: true }, new AbortController().signal)).toEqual(snapshot('Second profile'));
    expect(f.readFirst).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('a missing instance returns unavailable without querying a default profile', async () => {
  const f = fixture();
  try {
    await expect(f.catalog('missing').snapshot({ strict: true }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'NODE_INCOMPATIBLE', nodeCode: 'VALIDATION_FAILED', retryable: false });
    expect(f.readFirst).not.toHaveBeenCalled(); expect(f.readSecond).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test.each(['VALIDATION_FAILED', 'NODE_CAPACITY', 'NODE_UNAVAILABLE'] as const)('catalog refusal preserves %s and its retry policy', async (code) => {
  const f = fixture();
  try {
    f.alterReply(() => ({ kind: 'rejected', code }));
    await expect(f.catalog('second').snapshot({ strict: true }, new AbortController().signal))
      .rejects.toMatchObject({ code: code === 'VALIDATION_FAILED' ? 'NODE_INCOMPATIBLE' : code,
        nodeCode: code, retryable: code !== 'VALIDATION_FAILED', staleModels: [] });
    expect(f.readSecond).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('native discovery failure returns bounded stale evidence without private error details', async () => {
  const f = fixture();
  const stale = snapshot('Previously discovered profile').models;
  f.readSecond.mockImplementationOnce(async () => { throw Object.assign(new Error('Synthetic private provider diagnostic'), { staleModels: stale }); });
  try {
    const error = await f.catalog('second').snapshot({ strict: true }, new AbortController().signal).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'NODE_UNAVAILABLE', retryable: true, staleModels: stale });
    expect(String(error)).not.toContain('Synthetic private provider diagnostic');
    expect(f.readSecond).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});
