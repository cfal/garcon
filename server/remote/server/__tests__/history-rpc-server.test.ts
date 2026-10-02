import { expect, test } from 'bun:test';
import type { AgentImportedTranscriptRow, AgentRunningSession } from '@garcon/server-agent-interface';
import { AssistantMessage } from '@garcon/common/chat-types';
import { integrationFixture } from '../../__tests__/integration-fixture.js';
import { HistoryRpcServer } from '../history-rpc-server.js';
import type { ExecutorRpcMethods, ExecutorRpcRequest, HistoryReaderRef } from '../../transport/rpc-protocol.js';

const signal = new AbortController().signal;

function request<K extends 'history.open' | 'history.next' | 'history.close'>(method: K, value: ExecutorRpcMethods[K]['request']) {
  return { type: 'request', id: crypto.randomUUID(), seq: 1, integrationId: 'test', method, request: value } as Extract<ExecutorRpcRequest, { method: K }>;
}

function historyFixture() {
  const native = integrationFixture();
  const server = new HistoryRpcServer(new Map([['test', native.integration]]));
  const open = () => server.handle(request('history.open', { source: 'nativeHistoryImport', request: {
    chat: { chatId: '1000000000000001', projectPath: '/project', agentId: 'test', model: 'test-model', agentSessionId: 'native-session',
      nativeSession: null, nativeSeedReceipt: null, carryOverRevision: 'revision', settings: native.integration.settings.defaults() },
  } }), signal) as Promise<HistoryReaderRef>;
  return { native, server, open };
}

test('an open held in runningSessions cannot register a reader after bulk scope closure', async () => {
  const fixture = historyFixture();
  const released = Promise.withResolvers<readonly AgentRunningSession[]>();
  fixture.native.integration.execution.runningSessions = async () => released.promise;
  try {
    const opening = fixture.open().catch((error: unknown) => error);
    fixture.server.dispose();
    released.resolve([]);
    expect(await opening).toMatchObject({ code: 'STALE_RESOURCE' });
    expect(fixture.native.calls.import).toBe(0);
    await expect(fixture.open()).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
  } finally { released.resolve([]); fixture.server.dispose(); await fixture.native.executor.dispose(); }
});

test('queued pages and a late native batch never advance a closed reader', async () => {
  const fixture = historyFixture();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let reads = 0;
  let returned = 0;
  const closed = Promise.withResolvers<void>();
  fixture.native.integration.nativeHistoryImport.load = ({ signal }) => ({
    [Symbol.asyncIterator]() {
      return {
        async next() {
          reads++;
          entered.resolve();
          await released.promise;
          expect(signal.aborted).toBe(true);
          return { done: false, value: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'late synthetic row') }] };
        },
        async return() { returned++; closed.resolve(); return { done: true, value: [] }; },
      };
    },
  });
  try {
    const reader = await fixture.open();
    const pages = Array.from({ length: 4 }, (_, page) => fixture.server.handle(request('history.next', { reader, page }), signal)
      .catch((error: unknown) => error));
    await entered.promise;
    fixture.server.dispose();
    released.resolve();
    for (const page of await Promise.all(pages)) expect(page).toMatchObject({ code: 'STALE_RESOURCE' });
    await closed.promise;
    expect(reads).toBe(1);
    expect(returned).toBe(1);
  } finally { released.resolve(); fixture.server.dispose(); await fixture.native.executor.dispose(); }
});

test('unstarted native iterators are returned and a row above the page target still fits', async () => {
  const fixture = historyFixture();
  let returned = 0;
  fixture.native.integration.nativeHistoryImport.load = () => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<readonly AgentImportedTranscriptRow[]>> { return { done: true, value: [] }; },
        async return() { returned++; return { done: true, value: [] }; },
      };
    },
  });
  try {
    const first = await fixture.open();
    await fixture.server.handle(request('history.close', first), signal);
    expect(returned).toBe(1);
    const message = new AssistantMessage('2026-01-01T00:00:00Z', 'x'.repeat(1200 * 1024));
    fixture.native.integration.nativeHistoryImport.load = async function* () { yield [{ message }]; };
    const second = await fixture.open();
    expect(await fixture.server.handle(request('history.next', { reader: second, page: 0 }), signal)).toEqual({ done: false, rows: [{ message }] });
    expect(await fixture.server.handle(request('history.next', { reader: second, page: 1 }), signal)).toEqual({ done: true, rows: [] });
  } finally { fixture.server.dispose(); await fixture.native.executor.dispose(); }
});
