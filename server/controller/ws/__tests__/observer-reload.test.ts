import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { ChatHandler } from '../chat.js';
import type { PrimaryWebSocket } from '../primary-delivery.js';
import { LOCAL_SERVER_PRINCIPAL } from '../../lib/http-route-types.js';
import { ChatRegistry } from '../../chats/store.js';
import { DomainError } from '../../../common/domain-error.js';
import { parseServerWsMessage, ClientRequestErrorMessage } from '../../../../common/ws-events.js';

const chatId = '1783725900000101';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function unused(): never { throw new Error('Unexpected dependency'); }

async function fixture(transcriptReload: ConstructorParameters<typeof ChatHandler>[0]['transcriptReload']) {
  const directory = await mkdtemp(join(tmpdir(), 'observer-reload-ws-'));
  const registry = new ChatRegistry(directory);
  await registry.init();
  registry.addChat({ id: chatId, agentId: 'test', model: 'model', projectPath: '/synthetic',
    parentChatId: null, lineage: null, preambleSelection: { revision: 0, orderedPreambleIds: [] } });
  cleanups.push(async () => { await registry.flush(); await rm(directory, { recursive: true, force: true }); });
  const messages: Record<string, unknown>[] = [];
  const socket = { data: { connectionId: 'socket', principal: LOCAL_SERVER_PRINCIPAL }, readyState: 1,
    subscribe: () => true, close() {}, send(payload: string) { messages.push(JSON.parse(payload)); return payload.length; },
  } satisfies PrimaryWebSocket;
  const handler = new ChatHandler({ registry, serverInstanceId: 'server', transcriptReload,
    processing: { phase: unused, snapshot: unused }, chatViews: { readReplay: unused, resendCandidates: unused },
    queue: { readChatExecutionControl: unused }, transientFeeds: { snapshot: unused } }).createHandler();
  return { handler, socket, messages,
    reload: () => handler.message(socket, { type: 'chat-reload', chatId, clientRequestId: 'reload' }),
    cancel: () => handler.message(socket, { type: 'chat-reload-cancel', chatId, reloadRequestId: 'reload' }) };
}

test.each([
  new DomainError('SESSION_BUSY', 'Busy', 409, true),
  new AgentIntegrationError('SESSION_BUSY', 'Busy', true),
])('native source busy maps to CHAT_RUNNING (%s)', async error => {
  const f = await fixture(async () => { throw error; });
  await f.reload();
  expect(f.messages.at(-1)).toMatchObject({ type: 'client-request-error', code: 'CHAT_RUNNING' });
});

test.each(['saving', 'reading'] as const)('uncertain replacement beats late cancellation during %s', async phase => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const f = await fixture(async (_id, { onProgress }) => {
    onProgress({ phase, rows: 2 });
    entered.resolve();
    await finish.promise;
    throw new DomainError('RELOAD_OUTCOME_UNKNOWN', 'Refresh current history', 503, false);
  });
  const request = f.reload();
  await entered.promise;
  await f.cancel();
  finish.resolve();
  await request;
  const message = parseServerWsMessage(f.messages.at(-1)!);
  expect(message).toBeInstanceOf(ClientRequestErrorMessage);
  expect(message).toMatchObject({ code: 'RELOAD_OUTCOME_UNKNOWN', retryable: false });
});

test('a definite saving failure is not reported as cancellation after saving was admitted', async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const f = await fixture(async (_id, { onProgress }) => {
    onProgress({ phase: 'saving', rows: 2 });
    entered.resolve();
    await finish.promise;
    throw new DomainError('HISTORY_LOAD_FAILED', 'Definite promotion failure', 409, true);
  });
  const request = f.reload();
  await entered.promise;
  await f.cancel();
  finish.resolve();
  await request;
  expect(f.messages.at(-1)).toMatchObject({ code: 'HISTORY_LOAD_FAILED' });
});
