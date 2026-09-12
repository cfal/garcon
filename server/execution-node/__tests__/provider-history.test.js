import { expect, mock, test } from 'bun:test';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { PROVIDER_HISTORY_IMPORT_MAX_BATCH_ROWS } from '../../execution-nodes/provider-history-import.js';
import { LocalProviderHistoryImportService } from '../local-provider-history-import.js';

const AT = '2026-09-10T00:00:00.000Z';

function fixture(load = mock(async function* () {})) {
  const defaults = { ownerId: 'synthetic', schemaVersion: 1, values: { profile: 'secondary' } };
  /** @satisfies {Pick<import('@garcon/server-agent-interface').AgentIntegration, 'descriptor' | 'settings'>} */
  const integration = {
    descriptor: {
      id: 'synthetic', label: 'Synthetic', icon: null, supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'], supportsImages: false, supportsProjectPathUpdate: false,
      requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [],
    },
    settings: {
      defaults: () => defaults, describe: () => [], migrate: async (input) => input,
      parse: mock((input) => ({ ...input, values: { ...input.values, parsedBy: 'secondary' } })),
      applyPatch: (input) => input,
    },
  };
  /** @satisfies {import('../../execution-nodes/provider-history-import.js').ProviderHistoryImportRequest} */
  const request = { chat: {
    chatId: '1000000000000001', agentId: 'synthetic', agentSessionId: 'colliding-session',
    projectPath: '/synthetic/project', model: 'synthetic-model',
    nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { id: 'colliding-session' } },
    carryOverRevision: 'synthetic-revision', nativeSeedReceipt: null, settings: null,
  } };
  /** @satisfies {import('@garcon/server-agent-interface').AgentHistoryImport} */
  const source = { load };
  const controller = new AbortController();
  return { integration, request, source, defaults, controller,
    service: new LocalProviderHistoryImportService(integration, source) };
}

async function collect(service, request, signal) {
  const batches = [];
  for await (const batch of service.read(request, signal)) batches.push(batch);
  return batches;
}

test('rebatches oversized imports in order, ignores empty batches and pulls only on demand', async () => {
  const rows = Array.from({ length: 513 }, (_, index) => ({
    message: new AssistantMessage(AT, `Synthetic row ${index}`), providerMeta: { index },
  }));
  let advanced = false;
  const f = fixture(async function* () {
    yield [];
    yield rows;
    advanced = true;
    yield [];
  });
  const iterator = f.service.read(f.request, f.controller.signal)[Symbol.asyncIterator]();
  const batches = [];
  for (const size of [256, 256, 1]) {
    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(result.value).toHaveLength(size);
    expect(result.value.length).toBeLessThanOrEqual(PROVIDER_HISTORY_IMPORT_MAX_BATCH_ROWS);
    expect(advanced).toBe(false);
    batches.push(result.value);
  }
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  expect(advanced).toBe(true);
  expect(batches.flat()).toEqual(rows);
});

test('snapshots messages, nested attachments and provider metadata before advancing the source', async () => {
  const message = new UserMessage(AT, 'Synthetic input', [{ data: 'c3ludGhldGlj', mimeType: 'image/png', name: 'original' }]);
  const providerMeta = { position: { item: 'original' } };
  const f = fixture(async function* () {
    yield [{ message, providerMeta }];
    message.content = 'Changed';
    message.images[0].name = 'changed';
    providerMeta.position.item = 'changed';
  });
  const [[row]] = await collect(f.service, f.request, f.controller.signal);
  expect(row.message).toBeInstanceOf(UserMessage);
  expect(row.message).not.toBe(message);
  expect(row).toMatchObject({ message: { content: 'Synthetic input', images: [{ name: 'original' }] },
    providerMeta: { position: { item: 'original' } } });
  row.providerMeta.position.item = 'consumer mutation';
  expect(providerMeta.position.item).toBe('changed');
});

test.each(['mutate', 'truncate', 'append'])('owns the complete source batch before yielding its first partition (%s)', async (change) => {
  const rows = Array.from({ length: 257 }, (_, index) => ({
    message: new UserMessage(AT, `Synthetic row ${index}`), providerMeta: { position: { index } },
  }));
  const f = fixture(async function* () { yield rows; });
  const iterator = f.service.read(f.request, f.controller.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toHaveLength(256);
  if (change === 'mutate') {
    rows[256].message.content = 'Changed';
    rows[256].providerMeta.position.index = -1;
  } else if (change === 'truncate') rows.length = 256;
  else rows.push({ message: new UserMessage(AT, 'Appended') });
  const last = await iterator.next();
  expect(last.done).toBe(false);
  expect(last.value).toHaveLength(1);
  expect(last.value[0]).toMatchObject({ message: { content: 'Synthetic row 256' }, providerMeta: { position: { index: 256 } } });
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});

test.each([false, true])('captures requests before iteration and parses a private settings envelope (saved: %s)', async (saved) => {
  const f = fixture();
  if (saved) f.request.chat.settings = structuredClone(f.defaults);
  f.source.load = mock(async function* ({ chat, signal }) {
    expect(this).toBe(f.source);
    expect(signal).toBe(f.controller.signal);
    expect(chat).not.toHaveProperty('signal');
    expect(chat).toMatchObject({ projectPath: '/synthetic/project', nativeSession: { value: { id: 'colliding-session' } },
      settings: { values: { profile: 'secondary', parsedBy: 'secondary' } } });
    chat.nativeSession.value.id = 'provider mutation';
    chat.settings.values.profile = 'provider mutation';
  });
  const stream = f.service.read(f.request, f.controller.signal);
  f.request.chat.projectPath = '/changed';
  f.request.chat.nativeSession.value.id = 'caller mutation';
  if (saved) f.request.chat.settings.values.profile = 'caller mutation';
  for await (const _batch of stream) throw new Error('Unexpected rows');
  expect(f.source.load).toHaveBeenCalledOnce();
  expect(f.defaults.values.profile).toBe('secondary');
  expect(f.request.chat.nativeSession.value.id).toBe('caller mutation');
  if (saved) expect(f.request.chat.settings.values.profile).toBe('caller mutation');
});

test.each(['agentId', 'nativeSession'])('rejects a foreign %s before settings parsing or provider invocation', async (field) => {
  const f = fixture();
  if (field === 'agentId') f.request.chat.agentId = 'foreign';
  else f.request.chat.nativeSession.ownerId = 'foreign';
  await expect(collect(f.service, f.request, f.controller.signal)).rejects.toThrow('Native session owner mismatch');
  expect(f.source.load).not.toHaveBeenCalled();
  expect(f.integration.settings.parse).not.toHaveBeenCalled();
});

test('captures effective defaults when read is requested before iteration begins', async () => {
  const f = fixture();
  const stream = f.service.read(f.request, f.controller.signal);
  f.defaults.values.profile = 'changed before iteration';
  for await (const _batch of stream) throw new Error('Unexpected rows');
  expect(f.source.load.mock.calls[0][0].chat.settings.values.profile).toBe('secondary');
});

test.each([
  ['date', new Date(0)], ['map', new Map()], ['bigint', 1n], ['nonfinite number', NaN],
  ['undefined', undefined], ['sparse array', new Array(1)],
])('rejects %s metadata values and closes the import', async (_label, invalid) => {
  let closed = false;
  const f = fixture(async function* () {
    try { yield [{ message: new UserMessage(AT, 'Synthetic input'), providerMeta: { invalid } }]; }
    finally { closed = true; }
  });
  await expect(collect(f.service, f.request, f.controller.signal)).rejects.toThrow('Invalid history provider metadata');
  expect(closed).toBe(true);
});

test.each(['before-read', 'before-iteration'])('cancellation %s never enters the provider', async (phase) => {
  const f = fixture();
  const cancellation = new Error('Synthetic cancellation');
  if (phase === 'before-read') {
    f.controller.abort(cancellation);
    expect(() => f.service.read(f.request, f.controller.signal)).toThrow(cancellation);
  } else {
    const stream = f.service.read(f.request, f.controller.signal);
    f.controller.abort(cancellation);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(cancellation);
  }
  expect(f.source.load).not.toHaveBeenCalled();
  expect(f.integration.settings.parse).not.toHaveBeenCalled();
});

test('checks cancellation after obtaining the provider iterator, before its first advancement', async () => {
  const f = fixture();
  const cancellation = new Error('Synthetic iterator creation cancellation');
  const iterator = {
    next: mock(async () => ({ done: true })),
    return: mock(async () => ({ done: true })),
  };
  f.source.load = () => ({ [Symbol.asyncIterator]() { f.controller.abort(cancellation); return iterator; } });
  await expect(collect(f.service, f.request, f.controller.signal)).rejects.toBe(cancellation);
  expect(iterator.next).not.toHaveBeenCalled();
  expect(iterator.return).toHaveBeenCalledOnce();
});

test.each([false, true])('cancellation at normal EOF is not successful completion (has rows: %s)', async (hasRows) => {
  const f = fixture();
  const cancellation = new Error('Synthetic EOF cancellation');
  f.source.load = async function* () {
    if (hasRows) yield [{ message: new UserMessage(AT, 'Synthetic input') }];
    f.controller.abort(cancellation);
  };
  await expect(collect(f.service, f.request, f.controller.signal)).rejects.toBe(cancellation);
});

test.each(['consumer-exit', 'cancel-between-slices'])('%s closes the provider before another slice or advancement', async (mode) => {
  let closed = false;
  let advanced = false;
  const f = fixture(async function* () {
    try {
      yield Array.from({ length: 257 }, () => ({ message: new UserMessage(AT, 'Synthetic input') }));
      advanced = true;
    } finally { closed = true; }
  });
  const iterator = f.service.read(f.request, f.controller.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toHaveLength(256);
  if (mode === 'consumer-exit') await iterator.return();
  else {
    const cancellation = new Error('Synthetic mid-batch cancellation');
    f.controller.abort(cancellation);
    await expect(iterator.next()).rejects.toBe(cancellation);
  }
  expect(closed).toBe(true);
  expect(advanced).toBe(false);
});

test.each([{}, [{ message: { type: 'user-message', timestamp: AT, content: 42 } }]])('invalid import data closes the source', async (batch) => {
  let closed = false;
  const f = fixture(async function* () {
    try { yield batch; } finally { closed = true; }
  });
  await expect(collect(f.service, f.request, f.controller.signal)).rejects.toBeInstanceOf(TypeError);
  expect(closed).toBe(true);
});

test('closes a provider iterator after a rejected advancement', async () => {
  const failure = new Error('Synthetic read failure');
  const iterator = {
    next: mock(async () => { throw failure; }),
    return: mock(async () => ({ done: true })),
  };
  const f = fixture(() => ({ [Symbol.asyncIterator]: () => iterator }));
  await expect(collect(f.service, f.request, f.controller.signal)).rejects.toBe(failure);
  expect(iterator.return).toHaveBeenCalledOnce();
});

test.each([new Error('Synthetic original import failure'), undefined])('retains import and cleanup failures (%s)', async (failure) => {
  const cleanupFailure = new Error('Synthetic cleanup failure');
  const iterator = {
    next: mock(async () => { throw failure; }),
    return: mock(async () => { throw cleanupFailure; }),
  };
  const f = fixture(() => ({ [Symbol.asyncIterator]: () => iterator }));
  let rejected;
  try { await collect(f.service, f.request, f.controller.signal); } catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(AggregateError);
  expect(rejected.message).toBe(failure instanceof Error ? failure.message : 'History import and cleanup failed');
  expect(rejected.errors).toEqual([failure, cleanupFailure]);
  expect(rejected.errors[0]).toBe(failure);
  expect(rejected.errors[1]).toBe(cleanupFailure);
  expect(iterator.return).toHaveBeenCalledOnce();
});

test.each([false, true])('preserves cancellation during consumer-exit cleanup (cleanup fails: %s)', async (fails) => {
  const cancellation = new Error('Synthetic cleanup cancellation');
  const cleanupFailure = new Error('Synthetic cleanup failure');
  const f = fixture();
  const iterator = {
    next: mock(async () => ({ done: false, value: [{ message: new UserMessage(AT, 'Synthetic input') }] })),
    return: mock(async () => {
      f.controller.abort(cancellation);
      if (fails) throw cleanupFailure;
      return { done: true };
    }),
  };
  f.source.load = () => ({ [Symbol.asyncIterator]: () => iterator });
  const stream = f.service.read(f.request, f.controller.signal)[Symbol.asyncIterator]();
  await stream.next();
  await expect(stream.return()).rejects.toBe(cancellation);
  expect(iterator.next).toHaveBeenCalledOnce();
  expect(iterator.return).toHaveBeenCalledOnce();
});

test('preserves cancellation over simultaneous import and cleanup failures', async () => {
  const failure = new Error('Synthetic import failure');
  const cleanupFailure = new Error('Synthetic cleanup failure');
  const cancellation = new Error('Synthetic cleanup cancellation');
  const f = fixture();
  const iterator = {
    next: mock(async () => { throw failure; }),
    return: mock(async () => {
      f.controller.abort(cancellation);
      throw cleanupFailure;
    }),
  };
  f.source.load = () => ({ [Symbol.asyncIterator]: () => iterator });
  await expect(collect(f.service, f.request, f.controller.signal)).rejects.toBe(cancellation);
  expect(iterator.next).toHaveBeenCalledOnce();
  expect(iterator.return).toHaveBeenCalledOnce();
});

test('permits consumer exit when the provider iterator has no return method', async () => {
  const iterator = {
    next: mock(async () => ({ done: false, value: [{ message: new UserMessage(AT, 'Synthetic input') }] })),
  };
  const f = fixture(() => ({ [Symbol.asyncIterator]: () => iterator }));
  const stream = f.service.read(f.request, f.controller.signal)[Symbol.asyncIterator]();
  await stream.next();
  await expect(stream.return()).resolves.toEqual({ done: true, value: undefined });
  expect(iterator.next).toHaveBeenCalledOnce();
});

test('reports a cleanup-only failure when the consumer exits early', async () => {
  const failure = new Error('Synthetic cleanup-only failure');
  const iterator = {
    next: mock(async () => ({ done: false, value: [{ message: new UserMessage(AT, 'Synthetic input') }] })),
    return: mock(async () => { throw failure; }),
  };
  const f = fixture(() => ({ [Symbol.asyncIterator]: () => iterator }));
  const stream = f.service.read(f.request, f.controller.signal)[Symbol.asyncIterator]();
  await stream.next();
  await expect(stream.return()).rejects.toBe(failure);
  expect(iterator.return).toHaveBeenCalledOnce();
});

test('waits for cooperative provider cancellation and cleanup without abandoning a pending next', async () => {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  let closed = false;
  const f = fixture(async function* ({ signal }) {
    try {
      entered.resolve(signal);
      await released.promise;
      yield [{ message: new UserMessage(AT, 'Synthetic late input') }];
    } finally { closed = true; }
  });
  let settled = false;
  const pending = collect(f.service, f.request, f.controller.signal).finally(() => { settled = true; });
  expect(await entered.promise).toBe(f.controller.signal);
  const cancellation = new Error('Synthetic held read cancellation');
  f.controller.abort(cancellation);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(closed).toBe(false);
  released.resolve();
  await expect(pending).rejects.toBe(cancellation);
  expect(closed).toBe(true);
});
