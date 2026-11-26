import { afterEach, expect, mock, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentIntegrationError, type AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { codexChildRef, loadCodexChildHistory, parseCodexChildRef, type CodexChildHistoryClient } from '../native-child-history.js';
import { parseThreadMetadata, type CodexThreadMetadata, type ThreadItemEntry } from '../protocol.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

async function fixture(mode: 'legacy' | 'paginated' = 'legacy') {
  const base = path.join(os.homedir(), 'tmp');
  await fs.mkdir(base, { recursive: true });
  const home = await fs.mkdtemp(path.join(base, 'codex-child-history-'));
  directories.push(home);
  const source = path.join(home, 'child.jsonl');
  const metadata = { type: 'session_meta', timestamp, payload: { id: 'child-a', timestamp, history_mode: mode } };
  const rows = mode === 'legacy' ? [{ type: 'response_item', timestamp,
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic answer' }] } }] : [];
  await fs.writeFile(source, [metadata, ...rows].map(value => JSON.stringify(value) + '\n').join(''));
  const threads = new Map<string, CodexThreadMetadata>([
    ['child-a', { id: 'child-a', sessionId: 'child-a', parentThreadId: 'parent-a', historyMode: mode,
      ephemeral: false, path: source, updatedAt: 1, status: 'notLoaded' }],
    ['parent-a', { id: 'parent-a', sessionId: 'parent-a', parentThreadId: 'root-a', historyMode: mode,
      ephemeral: false, path: null, updatedAt: 1, status: 'notLoaded' }],
    ['root-a', { id: 'root-a', sessionId: 'root-a', parentThreadId: null, historyMode: mode,
      ephemeral: false, path: null, updatedAt: 1, status: 'notLoaded' }],
  ]);
  const items: ThreadItemEntry[] = [{ turnId: 'turn-a', item: {
    id: 'item-a', type: 'userMessage', content: [{ type: 'text', text: 'Actual exposed child input' }],
  } }];
  const client = {
    connect: mock(async () => ({ userAgent: 'codex/0.171.0', codexHome: home, platformFamily: 'unix', platformOs: 'linux' })),
    readThreadMetadata: mock(async (id: string) => { const thread = threads.get(id); if (!thread) throw new Error('Missing'); return { ...thread }; }),
    listThreadItems: mock<CodexChildHistoryClient['listThreadItems']>(async () => ({ data: items, nextCursor: null, backwardsCursor: null })),
    listThreadTurns: mock<CodexChildHistoryClient['listThreadTurns']>(async () => ({ data: [{
      id: 'turn-a', itemsView: 'notLoaded', status: 'completed', items: [], error: null,
      startedAt: 1_767_225_600, completedAt: 1_767_225_601, durationMs: 1000,
    }], nextCursor: null, backwardsCursor: null })),
    shutdown: mock(async () => {}),
  } satisfies CodexChildHistoryClient;
  const child = codexChildRef({ codexHome: home, rootThreadId: 'root-a', childThreadId: 'child-a', parentThreadId: 'parent-a' });
  const createClient = mock((namespace: string) => { expect(namespace).toBe(home); return client; });
  return { child, client, createClient, source, threads, items };
}

async function collect(f: Awaited<ReturnType<typeof fixture>>) {
  const rows: AgentImportedTranscriptRow[] = [];
  for await (const batch of loadCodexChildHistory({ child: f.child, signal: new AbortController().signal }, () => {}, f.createClient)) rows.push(...batch);
  return rows;
}

test('validates cold persisted ancestry instead of mistaking a child sessionId for a root', async () => {
  const f = await fixture();
  expect(await collect(f)).toMatchObject([{ message: { type: 'assistant-message', content: 'Synthetic answer' } }]);
  expect(f.client.readThreadMetadata.mock.calls.map(([id]) => id)).toEqual(['child-a', 'parent-a', 'root-a', 'child-a', 'parent-a', 'root-a']);
  expect(f.client.shutdown).toHaveBeenCalledTimes(1);
  expect(f.client.listThreadItems).not.toHaveBeenCalled();
});

test('reads paginated child content in ascending order through the validated namespace client', async () => {
  const f = await fixture('paginated');
  expect(await collect(f)).toMatchObject([{ message: { type: 'user-message', content: 'Actual exposed child input' } }]);
  expect(f.client.listThreadItems).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'child-a', sortDirection: 'asc' }));
  expect(f.client.listThreadTurns).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'child-a', sortDirection: 'asc', itemsView: 'notLoaded' }));
  expect(f.client.shutdown).toHaveBeenCalledTimes(1);
});

test.each(['namespace', 'parent', 'root', 'ephemeral', 'busy', 'missing', 'cycle'])(
  'refuses %s source evidence without importing a false empty history', async kind => {
    const f = await fixture();
    const child = f.threads.get('child-a')!;
    if (kind === 'namespace') f.client.connect.mockImplementation(async () => ({ userAgent: 'codex/0.171.0', codexHome: '/wrong', platformFamily: 'unix', platformOs: 'linux' }));
    if (kind === 'parent') f.threads.set('child-a', { ...child, parentThreadId: 'root-a' });
    if (kind === 'root') f.threads.set('child-a', { ...child, sessionId: 'wrong-root' });
    if (kind === 'ephemeral') f.threads.set('child-a', { ...child, ephemeral: true });
    if (kind === 'busy') f.threads.set('child-a', { ...child, status: 'active' });
    if (kind === 'missing') await fs.rm(f.source);
    if (kind === 'cycle') f.threads.set('parent-a', { ...f.threads.get('parent-a')!, parentThreadId: 'child-a' });
    await expect(collect(f)).rejects.toMatchObject({ code: kind === 'busy' ? 'SESSION_BUSY' : 'TRANSCRIPT_UNAVAILABLE' });
    expect(f.client.shutdown).toHaveBeenCalledTimes(1);
  },
);

test('checks source metadata again after yielding the final import page', async () => {
  const f = await fixture();
  const reader = loadCodexChildHistory({ child: f.child, signal: new AbortController().signal }, () => {}, f.createClient);
  expect((await reader.next()).value).toHaveLength(1);
  f.threads.set('child-a', { ...f.threads.get('child-a')!, updatedAt: 2 });
  await expect(reader.next()).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  expect(f.client.shutdown).toHaveBeenCalledTimes(1);
});

test('checks source admission again after history-client shutdown settles', async () => {
  const f = await fixture();
  const shuttingDown = Promise.withResolvers<void>();
  const shutdown = Promise.withResolvers<void>();
  f.client.shutdown.mockImplementation(() => { shuttingDown.resolve(); return shutdown.promise; });
  let changed = false;
  const reader = loadCodexChildHistory({ child: f.child, signal: new AbortController().signal }, () => {
    if (changed) throw new AgentIntegrationError('SESSION_BUSY', 'Synthetic admission', true);
  }, f.createClient);
  await reader.next();
  const completion = reader.next();
  await shuttingDown.promise;
  changed = true;
  shutdown.resolve();
  await expect(completion).rejects.toMatchObject({ code: 'SESSION_BUSY' });
});

test.each(['connect', 'readThreadMetadata', 'listThreadItems', 'listThreadTurns'] as const)(
  'cancels a blocked %s RPC and waits for dedicated client cleanup', async method => {
    const f = await fixture('paginated');
    const entered = Promise.withResolvers<void>();
    const shuttingDown = Promise.withResolvers<void>();
    const shutdown = Promise.withResolvers<void>();
    f.client[method].mockImplementation(() => { entered.resolve(); return new Promise<never>(() => {}); });
    f.client.shutdown.mockImplementation(() => { shuttingDown.resolve(); return shutdown.promise; });
    const cancellation = new AbortController();
    let settled = false;
    const next = loadCodexChildHistory({ child: f.child, signal: cancellation.signal }, () => {}, f.createClient).next();
    const outcome = next.then(() => { settled = true; }, error => { settled = true; return error; });
    await entered.promise;
    cancellation.abort(new Error('Synthetic cancellation'));
    await shuttingDown.promise;
    expect(settled).toBe(false);
    shutdown.resolve();
    expect(await outcome).toBe(cancellation.signal.reason);
    expect(f.client.shutdown).toHaveBeenCalledTimes(1);
  },
);

test('times out a blocked native RPC even without caller cancellation', async () => {
  const f = await fixture();
  f.client.readThreadMetadata.mockImplementation(() => new Promise<never>(() => {}));
  const reader = loadCodexChildHistory({ child: f.child, signal: new AbortController().signal }, () => {}, f.createClient, 5);
  await expect(reader.next()).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  expect(f.client.shutdown).toHaveBeenCalledTimes(1);
});

test.each(['{"type":"event_msg","payload":{"type":"item_completed"', '{} garbage', 'null'])(
  'rejects corrupt paginated rollout evidence instead of returning an empty import: %s', async record => {
    const f = await fixture('paginated');
    f.items.splice(0);
    await fs.appendFile(f.source, record + '\n');
    await expect(collect(f)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
    expect(f.client.shutdown).toHaveBeenCalledTimes(1);
  },
);

test('validates the locator before creating a history client', async () => {
  const f = await fixture();
  expect(() => parseCodexChildRef({ ...f.child, key: 'wrong' })).toThrow();
  expect(() => parseCodexChildRef({ ...f.child, value: { ...f.child.value, codexHome: 'relative' } })).toThrow();
  expect(f.createClient).not.toHaveBeenCalled();
});

test.each([
  { content: false }, { content: [null] }, { content: [{ type: 'text', text: false }] },
  { content: [{ type: 'text', text: 'Input', text_elements: false }] }, { id: '' }, { client_id: false },
])('rejects malformed retained user-message evidence: %j', async malformed => {
  const f = await fixture('paginated');
  f.items.splice(0);
  await fs.appendFile(f.source, JSON.stringify({ type: 'event_msg', timestamp,
    payload: { type: 'item_completed', turn_id: 'turn-a', item: {
      type: 'UserMessage', id: 'input-a', client_id: 'client-a', content: [{ type: 'text', text: 'Kickoff' }], ...malformed,
    } },
  }) + '\n');
  await expect(collect(f)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  expect(f.client.shutdown).toHaveBeenCalledTimes(1);
});

test.each(['client-a', null, undefined])('retains user-message evidence with optional client ID %j when the item page omits it', async clientId => {
  const f = await fixture('paginated');
  f.items.splice(0);
  await fs.appendFile(f.source, JSON.stringify({ type: 'event_msg', timestamp,
    payload: { type: 'item_completed', turn_id: 'turn-a', item: {
      type: 'UserMessage', id: 'input-a', client_id: clientId, content: [{ type: 'text', text: 'Retained kickoff' }],
    } },
  }) + '\n');
  expect(await collect(f)).toMatchObject([{ message: { type: 'user-message', content: 'Retained kickoff' } }]);
});

test.each([
  { content: false }, { content: [null] }, { content: [{ type: 'Text', text: false }] },
  { content: [{ type: 'Unknown', text: 'Answer' }] },
])('rejects malformed retained assistant evidence even if the projector skips it: %j', async malformed => {
  const f = await fixture('paginated');
  f.items.splice(0);
  await fs.appendFile(f.source, JSON.stringify({ type: 'event_msg', timestamp,
    payload: { type: 'item_completed', turn_id: 'turn-a', item: {
      type: 'AgentMessage', id: 'answer-a', ...malformed,
    } },
  }) + '\n');
  const failure = await collect(f).then(() => null, error => error);
  expect(failure).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test('requires the item projection to retain a surviving non-user item', async () => {
  const f = await fixture('paginated');
  f.items.splice(0);
  await fs.appendFile(f.source, JSON.stringify({ type: 'event_msg', timestamp,
    payload: { type: 'item_completed', turn_id: 'turn-a', item: {
      type: 'AgentMessage', id: 'answer-a', content: [{ type: 'Text', text: 'Retained answer' }],
    } },
  }) + '\n');
  const failure = await collect(f).then(() => null, error => error);
  expect(failure).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  f.items.push({ turnId: 'turn-a', item: { type: 'agentMessage', id: 'answer-a', text: 'Retained answer', memoryCitation: null } });
  expect(await collect(f)).toMatchObject([{ message: { type: 'assistant-message', content: 'Retained answer' } }]);
});

test('accepts valid empty assistant and plan items omitted by the native projection', async () => {
  const f = await fixture('paginated');
  f.items.splice(0);
  for (const item of [
    { type: 'AgentMessage', id: 'answer-a', content: [{ type: 'Text', text: '' }] },
    { type: 'Plan', id: 'plan-a', text: '' },
  ]) await fs.appendFile(f.source, JSON.stringify({ type: 'event_msg', timestamp,
    payload: { type: 'item_completed', turn_id: 'turn-a', item },
  }) + '\n');
  expect(await collect(f)).toEqual([]);
});

test('accepts raw V2 inter-agent content without inventing a typed kickoff item', async () => {
  const f = await fixture('paginated');
  f.items.splice(0);
  await fs.appendFile(f.source, JSON.stringify({ type: 'response_item', timestamp, payload: {
    type: 'agent_message', author: '/root', recipient: '/root/child', content: [
      { type: 'input_text', text: 'Synthetic kickoff' }, { type: 'encrypted_content', encrypted_content: 'synthetic-encrypted' },
    ],
  } }) + '\n');
  expect(await collect(f)).toEqual([]);
});

test.each(['UserMessage', 'AgentMessage'])('refuses an unprojected retained %s turn', async type => {
  const f = await fixture('paginated');
  f.items.splice(0);
  f.client.listThreadTurns.mockResolvedValue({ data: [], nextCursor: null, backwardsCursor: null });
  await fs.appendFile(f.source, JSON.stringify({ type: 'event_msg', ordinal: 1, timestamp,
    payload: { type: 'item_completed', turn_id: 'unprojected-turn', item: {
      type, id: 'retained-item', content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text: 'Retained conversation' }],
    } },
  }) + '\n');
  const failure = await collect(f).then(() => null, error => error);
  expect(failure).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test.each([1, 2])('honors the explicit inherited prefix ending at ordinal %s', async boundary => {
  const f = await fixture('paginated');
  f.items.splice(0);
  await fs.writeFile(f.source, [
    { type: 'session_meta', ordinal: 0, timestamp, payload: { id: 'child-a', timestamp,
      history_mode: 'paginated', subagent_history_start_ordinal: boundary } },
    { type: 'event_msg', ordinal: 1, timestamp, payload: { type: 'item_completed', turn_id: 'parent-turn',
      item: { type: 'UserMessage', id: 'inherited-input', content: [{ type: 'text', text: 'Inherited input' }] } } },
    { type: 'event_msg', ordinal: 2, timestamp, payload: { type: 'item_completed', turn_id: 'turn-a',
      item: { type: 'UserMessage', id: 'child-input', content: [{ type: 'text', text: 'Child input' }] } } },
  ].map(record => JSON.stringify(record) + '\n').join(''));
  const result = await collect(f).then(rows => ({ rows }), error => ({ error }));
  if (boundary === 1) expect(result).toMatchObject({ error: { code: 'TRANSCRIPT_UNAVAILABLE' } });
  else expect(result).toMatchObject({ rows: [{ message: { type: 'user-message', content: 'Child input' } }] });
});

test.each([false, -1, '2', 1.5])('rejects malformed inherited-history boundaries: %j', async boundary => {
  const f = await fixture('paginated');
  await fs.writeFile(f.source, JSON.stringify({ type: 'session_meta', timestamp, payload: {
    id: 'child-a', timestamp, history_mode: 'paginated', subagent_history_start_ordinal: boundary,
  } }) + '\n');
  const failure = await collect(f).then(() => null, error => error);
  expect(failure).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test.each([1, 2, undefined])('requires the inherited prefix to reach its declared end (last ordinal: %j)', async ordinal => {
  const f = await fixture('paginated');
  f.items.splice(0);
  f.client.listThreadTurns.mockResolvedValue({ data: [], nextCursor: null, backwardsCursor: null });
  await fs.writeFile(f.source, [
    { type: 'session_meta', ordinal: 0, timestamp, payload: { id: 'child-a', timestamp,
      history_mode: 'paginated', subagent_history_start_ordinal: 3 } },
    { type: 'event_msg', ordinal: 1, timestamp, payload: { type: 'item_completed', turn_id: 'parent-turn',
      item: { type: 'AgentMessage', id: 'inherited-answer', content: [{ type: 'Text', text: 'Inherited answer' }] } } },
    ...(ordinal === 1 ? [] : [{ type: 'turn_context', ordinal, payload: {} }]),
  ].map(record => JSON.stringify(record) + '\n').join(''));
  const result = await collect(f).then(rows => ({ rows }), error => ({ error }));
  if (ordinal === 2) expect(result).toEqual({ rows: [] });
  else expect(result).toMatchObject({ error: { code: 'TRANSCRIPT_UNAVAILABLE' } });
});

test.each(['legacy', 'paginated'] as const)('rejects a parseable unterminated record in %s mode', async mode => {
  const f = await fixture(mode);
  f.items.splice(0);
  await fs.appendFile(f.source, JSON.stringify({ type: 'event_msg', timestamp, payload: {
    type: 'item_completed', turn_id: 'turn-a', item: { type: 'UserMessage', id: 'torn-input',
      content: [{ type: 'text', text: 'Unterminated input' }] },
  } }));
  const failure = await collect(f).then(() => null, error => error);
  expect(failure).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

for (const mode of ['legacy', 'paginated'] as const) {
  test.each([undefined, null, 'call-a'])('accepts standalone function output in ' + mode + ' with call ID %j', async callId => {
    const f = await fixture(mode);
    await fs.appendFile(f.source, JSON.stringify({ type: 'response_item', timestamp, payload: {
      type: 'function_call_output', name: 'synthetic_context', namespace: 'functions', call_id: callId,
      output: [{ type: 'input_text', text: 'Synthetic context' }],
    } }) + '\n');
    expect((await collect(f)).length).toBeGreaterThan(0);
  });

  test.each([
    { type: 'function_call_output', call_id: '', output: 'Synthetic output' },
    { type: 'function_call_output', output: false },
    { type: 'custom_tool_call_output', output: 'Synthetic output' },
  ])('rejects malformed tool output in ' + mode + ': %j', async payload => {
    const f = await fixture(mode);
    await fs.appendFile(f.source, JSON.stringify({ type: 'response_item', timestamp, payload }) + '\n');
    const failure = await collect(f).then(() => null, error => error);
    expect(failure).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  });
}

test.each([
  { type: 'event_msg', payload: { type: 'agent_message', message: false } },
  { type: 'event_msg', payload: { type: 'agent_reasoning', text: false } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: false }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'unknown', text: 'Skipped' }] } },
  { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: false }] } },
])('rejects malformed legacy conversation records: %j', async record => {
  const f = await fixture();
  await fs.writeFile(f.source, [
    { type: 'session_meta', timestamp, payload: { id: 'child-a', timestamp, history_mode: 'legacy' } }, record,
  ].map(value => JSON.stringify(value) + '\n').join(''));
  const failure = await collect(f).then(() => null, error => error);
  expect(failure).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test('metadata-only thread parsing validates retained identity and ignores empty turns', () => {
  const thread = { id: 'child-a', parentThreadId: 'root-a', sessionId: 'child-a', historyMode: 'paginated',
    ephemeral: false, path: '/synthetic/rollout.jsonl', updatedAt: 1, status: { type: 'notLoaded' }, turns: [] };
  expect(parseThreadMetadata({ thread })).toMatchObject({ id: 'child-a', status: 'notLoaded' });
  expect(() => parseThreadMetadata({ thread: { ...thread, historyMode: 'unknown' } })).toThrow();
  expect(() => parseThreadMetadata({ thread: { ...thread, sessionId: undefined } })).toThrow();
});
