import { afterEach, expect, test, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { effectiveExecutorId } from '../../../../common/executors.js';
import { AssistantMessage, BashToolUseMessage } from '../../../../common/chat-types.js';
import { ChatRegistry } from '../../chats/store.js';
import { ApiProviderEndpointResolver } from '../../api-providers/endpoint-resolver.js';
import { integrationFixture } from '../../../remote/__tests__/integration-fixture.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptAdoptionService } from '../../ledger/adoption.js';
import { AgentDirectory, type ExecutionIntegrationDirectory } from '../directory.js';
import { IntegrationRegistry } from '../../../runtime/agents/integration-registry.js';
import { AgentEventBus } from '../event-bus.js';
import { AgentRuntimeRouter } from '../runtime-router.js';
import { DomainError } from '../../../common/domain-error.js';

const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const IDS = ['local', FIRST, SECOND];
const CHAT_IDS = ['1783725900000400', '1783725900000401', '1783725900000402'];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(chatExecutors: readonly string[] = IDS) {
  const root = await mkdtemp(join(homedir(), 'garcon-executor-routing-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const chats = new ChatRegistry(root);
  await chats.init();
  cleanups.push(() => chats.flush());
  const providers = IDS.map((id) => integrationFixture(root, id));
  const registries = new Map(providers.map((provider) => [provider.scope.executorId, new IntegrationRegistry({ instances: [provider.integration] })]));
  const ready = new Set(IDS);
  const executors = {
    isReady: (executorId: string) => ready.has(executorId),
    integrationsFor(executorId: string) {
      if (!ready.has(executorId)) throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor unavailable', 503, true);
      return registries.get(executorId)!;
    },
    knownIntegration: ({ executorId, agentId }) => registries.get(executorId)?.get(agentId) ?? null,
    requireIntegration({ executorId, agentId }) { return this.integrationsFor(executorId).require(agentId); },
  } satisfies ExecutionIntegrationDirectory;
  const directory = new AgentDirectory(registries.get('local')!, executors);
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'ledger')), { serverInstanceId: 'synthetic-server' });
  cleanups.push(async () => { ledger.close(); });
  const adoption = new TranscriptAdoptionService({
    ledger, registry: chats, integrations: directory, getCarryOverRevision: () => '', loadFrozenPrefix: async () => [],
  });
  for (const [index, executorId] of chatExecutors.entries()) {
    chats.addChat({
      id: CHAT_IDS[index]!, executorId, agentId: 'test', model: 'synthetic-model', projectPath: root,
      parentChat: null, preambleSelection: { revision: 0, orderedPreambleIds: [] },
    });
    ledger.initializeChat(CHAT_IDS[index]!);
  }
  const mentions: string[] = [];
  const router = new AgentRuntimeRouter({
    registry: chats, directory, ledger, adoption, events: new AgentEventBus(),
    endpointResolver: new ApiProviderEndpointResolver(() => [], () => []),
    getCarryOverRevision: () => '', createCarriedContext: async () => ({ kind: 'no-history' }),
    hasPendingOwnershipTransfer: () => false,
    async resolveFileMentions(prompt, _projectPath, executorId) { mentions.push(effectiveExecutorId(executorId)); return prompt; },
  });
  return { root, chats, providers, directory, ledger, router, mentions, ready };
}

test('same-agent execution, expansion, Stop, and one-shot queries resolve the selected executor', async () => {
  const f = await fixture();
  for (const chatId of CHAT_IDS) await f.router.startSession(chatId, 'synthetic prompt');
  expect(f.providers.map((provider) => provider.calls.start)).toEqual([1, 1, 1]);
  expect(f.mentions).toEqual(IDS);
  await f.router.abortSession(CHAT_IDS[1]!);
  expect(f.providers.map((provider) => provider.calls.abort)).toEqual([0, 1, 0]);
  expect(f.router.isChatRunning(CHAT_IDS[0]!)).toBe(true);
  expect(f.router.isChatRunning(CHAT_IDS[2]!)).toBe(true);
  await f.router.runSingleQuery('synthetic query', { agentId: 'test', executorId: SECOND });
  expect(f.providers.map((provider) => provider.calls.query)).toEqual([0, 0, 1]);
  f.ready.delete(SECOND);
  await expect(f.router.runSingleQuery('synthetic query', { agentId: 'test', executorId: SECOND })).rejects.toThrow('unavailable');
  expect(f.providers.map((provider) => provider.calls.query)).toEqual([0, 0, 1]);
});

test('executor loss settles its pending launch and fences its producer without disturbing other executors', async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.providers[1]!.hooks.start = async () => { started.resolve(); await release.promise; };
  await f.router.startSession(CHAT_IDS[0]!, 'local input');
  await f.router.startSession(CHAT_IDS[2]!, 'other input');
  const pending = f.router.startSession(CHAT_IDS[1]!, 'remote input');
  await started.promise;
  f.router.executionSessionLost(FIRST);
  const terminals = f.ledger.currentRows(CHAT_IDS[1]!).filter((row) => row.kind === 'run-ended');
  expect(terminals).toHaveLength(1);
  expect(terminals[0]).toMatchObject({ outcome: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
  expect(f.router.isChatRunning(CHAT_IDS[0]!)).toBe(true);
  expect(f.router.isChatRunning(CHAT_IDS[2]!)).toBe(true);
  release.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
  expect(f.router.isChatRunning(CHAT_IDS[1]!)).toBe(false);
  expect(f.ledger.currentSession(CHAT_IDS[1]!)).toBeNull();
  await f.router.abortSession(CHAT_IDS[2]!);
  expect(f.providers.map((provider) => provider.calls.abort)).toEqual([0, 1, 1]);
});

test('unknown explicit executor does not borrow a Local integration', async () => {
  const f = await fixture();
  expect(f.directory.get('test', crypto.randomUUID())).toBeNull();
  expect(() => f.directory.require('test', crypto.randomUUID())).toThrow('unavailable');
});

test('executor loss closes every producer even when one chat cannot commit its terminal', async () => {
  const f = await fixture(['local', FIRST, FIRST]);
  const failedChat = CHAT_IDS[1]!;
  const healthyChat = CHAT_IDS[2]!;
  for (const chatId of CHAT_IDS) await f.router.startSession(chatId, 'synthetic input');
  const db = new Database(join(f.root, 'ledger', failedChat, 'ledger.sqlite'));
  try {
    db.exec("CREATE TRIGGER inject_write_failure BEFORE INSERT ON transcript_rows BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END");
  } finally { db.close(); }

  expect(() => f.router.executionSessionLost(FIRST)).not.toThrow();
  expect(f.router.isChatRunning(failedChat)).toBe(false);
  expect(f.router.isChatRunning(healthyChat)).toBe(false);
  expect(f.router.isChatRunning(CHAT_IDS[0]!)).toBe(true);
  expect(f.ledger.currentRows(healthyChat).filter(row => row.kind === 'run-ended')).toEqual([
    expect.objectContaining({ outcome: 'failed', error: { code: 'OUTCOME_UNKNOWN', message: expect.any(String) } }),
  ]);
  const before = f.ledger.currentRows(healthyChat);
  for (const publish of f.providers[1]!.nativePublishers) {
    publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-23T00:00:00.000Z', 'Synthetic late output') }] });
  }
  expect(f.ledger.currentRows(healthyChat)).toEqual(before);
  expect(f.ledger.currentRows(failedChat).filter(row => row.kind === 'provider-row')).toEqual([]);
});

test('a permission reply remains actionable while its executor is reconnecting', async () => {
  const f = await fixture();
  const chatId = CHAT_IDS[1]!;
  const occurrence = '11111111-1111-4111-8111-111111111111';
  const respond = mock(async () => undefined);
  await f.router.startSession(chatId, 'synthetic input');
  const runId = f.ledger.activeRunId(chatId)!;
  f.providers[1]!.nativePublishers[0]!({
    type: 'permission', runId,
    lifecycle: {
      kind: 'requested', permissionOccurrenceId: occurrence,
      requestedTool: new BashToolUseMessage('2026-09-23T00:00:00.000Z', 'synthetic-tool', 'pwd'),
      options: [],
    },
    decision: { permissionOccurrenceId: occurrence, respond },
  });
  const control = {
    serverInstanceId: 'synthetic-server', chatId,
    runId, permissionOccurrenceId: occurrence,
  };
  f.ready.delete(FIRST);
  await expect(f.router.resolvePermission(chatId, occurrence, { allow: true }, control))
    .rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
  expect(respond).not.toHaveBeenCalled();
  f.ready.add(FIRST);
  await expect(f.router.resolvePermission(chatId, occurrence, { allow: true }, control)).resolves.toBeUndefined();
  expect(respond).toHaveBeenCalledTimes(1);
  expect(f.ledger.currentRows(chatId).filter(row => row.kind === 'permission-resolved')).toHaveLength(1);
});
