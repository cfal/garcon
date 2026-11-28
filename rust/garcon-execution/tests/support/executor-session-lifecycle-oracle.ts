import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDirectory, type ExecutionIntegrationDirectory } from '../../../../server/controller/agents/directory.ts';
import { AgentEventBus } from '../../../../server/controller/agents/event-bus.ts';
import { AgentRuntimeRouter } from '../../../../server/controller/agents/runtime-router.ts';
import { ApiProviderEndpointResolver } from '../../../../server/controller/api-providers/endpoint-resolver.ts';
import { ChatRegistry } from '../../../../server/controller/chats/store.ts';
import { TranscriptAdoptionService } from '../../../../server/controller/ledger/adoption.ts';
import { TranscriptLedgerService } from '../../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../../server/controller/ledger/store.ts';
import { integrationFixture } from '../../../../server/remote/__tests__/integration-fixture.ts';
import { IntegrationRegistry } from '../../../../server/runtime/agents/integration-registry.ts';

const REMOTE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TARGET = '1767225600000000';
const SAFE = '1767225600000001';

export async function executorSessionTrace(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), 'garcon-executor-session-oracle-'));
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'ledger')), { serverInstanceId: 'fixture' });
  const chats = new ChatRegistry(root);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await chats.init();
    const provider = integrationFixture(root, REMOTE);
    const registry = new IntegrationRegistry({ instances: [provider.integration] });
    const directory = new AgentDirectory({
      isReady: () => true, knownIntegration: ({ agentId }) => registry.get(agentId),
      requireIntegration: ({ agentId }) => registry.require(agentId), integrationsFor: () => registry,
    } satisfies ExecutionIntegrationDirectory);
    const adoption = new TranscriptAdoptionService({ ledger, registry: chats, integrations: directory,
      getCarryOverRevision: () => '', loadFrozenPrefix: async () => [] });
    const router = new AgentRuntimeRouter({
      registry: chats, directory, ledger, adoption, events: new AgentEventBus(),
      endpointResolver: new ApiProviderEndpointResolver(() => [], () => []),
      getCarryOverRevision: () => '', hasPendingOwnershipTransfer: () => false,
      async createCarriedContext() {
        if (scenario === 'setup') { held.resolve(); await release.promise; }
        return { kind: 'no-history' };
      },
      async resolveFileMentions(command) { return command; },
    });
    for (const [id, executorId] of [[TARGET, REMOTE], [SAFE, OTHER]] as const) {
      chats.addChat({ id, executorId, projectPath: root, agentId: 'test', model: 'synthetic',
        parentChatId: null, lineage: null, preambleSelection: { revision: 0, orderedPreambleIds: [] } });
      ledger.initializeChat(id);
    }
    const leases = new Map<string, ReturnType<typeof ledger.openProducer>>();
    const open = ledger.openProducer.bind(ledger);
    ledger.openProducer = (chatId, owner) => {
      const lease = open(chatId, owner);
      leases.set(chatId, lease);
      return lease;
    };
    router.reopenProducer(SAFE);
    ledger.beginRun(SAFE, 'safe-run');
    if (scenario !== 'setup') provider.hooks.start = async () => { held.resolve(); await release.promise; };
    const pending = router.startSession(TARGET, 'synthetic input', { turnId: 'lost-run' }).catch(() => {});
    try {
      await held.promise;
      const target = leases.get(TARGET)!;
      router.executionSessionLost(scenario === 'unrelated' ? 'unrelated' : REMOTE);
      router.executionSessionLost(scenario === 'unrelated' ? 'unrelated' : REMOTE);
      const terminal = ledger.currentRows(TARGET).filter(row => row.kind === 'run-ended').map(row => ({
        outcome: row.outcome, origin: row.origin, error: row.error,
      }));
      const snapshot = { terminal, targetClosed: target.closed, safeClosed: leases.get(SAFE)!.closed,
        targetActive: router.isChatRunning(TARGET), safeActive: router.isChatRunning(SAFE) };
      if (scenario === 'reopened') {
        router.reopenProducer(TARGET);
        return { ...snapshot, reopened: leases.get(TARGET) !== target && !leases.get(TARGET)!.closed };
      }
      return snapshot;
    } finally { release.resolve(); await pending; }
  } finally {
    release.resolve();
    ledger.close();
    await chats.flush();
    await rm(root, { force: true, recursive: true });
  }
}
