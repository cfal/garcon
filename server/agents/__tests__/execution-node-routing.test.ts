import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { effectiveNodeId } from '../../../common/execution-nodes.js';
import { ChatRegistry } from '../../chats/store.js';
import { ApiProviderEndpointResolver } from '../../api-providers/endpoint-resolver.js';
import { integrationFixture } from '../../execution-nodes/__tests__/integration-fixture.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptAdoptionService } from '../../ledger/adoption.js';
import { AgentDirectory, type ExecutionIntegrationDirectory } from '../directory.js';
import { IntegrationRegistry } from '../integration-registry.js';
import { AgentEventBus } from '../event-bus.js';
import { AgentRuntimeRouter } from '../runtime-router.js';

const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const IDS = ['local', FIRST, SECOND];
const CHAT_IDS = ['1783725900000400', '1783725900000401', '1783725900000402'];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(homedir(), 'garcon-node-routing-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const chats = new ChatRegistry(root);
  await chats.init();
  cleanups.push(() => chats.flush());
  const providers = IDS.map((id) => integrationFixture(root, id));
  const registries = new Map(providers.map((provider) => [provider.scope.nodeId, new IntegrationRegistry({ instances: [provider.integration] })]));
  const ready = new Set(IDS);
  const nodes = {
    isReady: (nodeId: string) => ready.has(nodeId),
    integrationsFor(nodeId: string) {
      if (!ready.has(nodeId)) throw new Error('Execution node unavailable');
      return registries.get(nodeId)!;
    },
    knownIntegration: ({ nodeId, agentId }) => registries.get(nodeId)?.get(agentId) ?? null,
    requireIntegration({ nodeId, agentId }) { return this.integrationsFor(nodeId).require(agentId); },
  } satisfies ExecutionIntegrationDirectory;
  const directory = new AgentDirectory(registries.get('local')!, nodes);
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'ledger')), { serverInstanceId: 'synthetic-server' });
  cleanups.push(async () => { ledger.close(); });
  const adoption = new TranscriptAdoptionService({
    ledger, registry: chats, integrations: directory, getCarryOverRevision: () => '', loadFrozenPrefix: async () => [],
  });
  for (const [index, nodeId] of IDS.entries()) {
    chats.addChat({
      id: CHAT_IDS[index]!, nodeId, agentId: 'test', model: 'synthetic-model', projectPath: root,
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
    async resolveFileMentions(prompt, _projectPath, nodeId) { mentions.push(effectiveNodeId(nodeId)); return prompt; },
  });
  return { chats, providers, directory, ledger, router, mentions, ready };
}

test('same-agent execution, expansion, Stop, and one-shot queries resolve the selected node', async () => {
  const f = await fixture();
  for (const chatId of CHAT_IDS) await f.router.startSession(chatId, 'synthetic prompt');
  expect(f.providers.map((provider) => provider.calls.start)).toEqual([1, 1, 1]);
  expect(f.mentions).toEqual(IDS);
  await f.router.abortSession(CHAT_IDS[1]!);
  expect(f.providers.map((provider) => provider.calls.abort)).toEqual([0, 1, 0]);
  expect(f.router.isChatRunning(CHAT_IDS[0]!)).toBe(true);
  expect(f.router.isChatRunning(CHAT_IDS[2]!)).toBe(true);
  await f.router.runSingleQuery('synthetic query', { agentId: 'test', nodeId: SECOND });
  expect(f.providers.map((provider) => provider.calls.query)).toEqual([0, 0, 1]);
  f.ready.delete(SECOND);
  await expect(f.router.runSingleQuery('synthetic query', { agentId: 'test', nodeId: SECOND })).rejects.toThrow('unavailable');
  expect(f.providers.map((provider) => provider.calls.query)).toEqual([0, 0, 1]);
});

test('node loss settles its pending launch and fences its producer without disturbing other nodes', async () => {
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
  await pending;
  expect(f.router.isChatRunning(CHAT_IDS[1]!)).toBe(false);
  expect(f.ledger.currentSession(CHAT_IDS[1]!)).toBeNull();
  await f.router.abortSession(CHAT_IDS[2]!);
  expect(f.providers.map((provider) => provider.calls.abort)).toEqual([0, 0, 1]);
});

test('unknown explicit node does not borrow a Local integration', async () => {
  const f = await fixture();
  expect(f.directory.get('test', crypto.randomUUID())).toBeNull();
  expect(() => f.directory.require('test', crypto.randomUUID())).toThrow('unavailable');
});
