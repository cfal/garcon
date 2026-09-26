import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentIntegration, AgentResumeRequestV5 } from '../../../server-agents/interface/src/index.js';
import { AssistantMessage } from '../../../common/chat-types.js';
import { ApiProviderEndpointResolver } from '../../../server/controller/api-providers/endpoint-resolver.js';
import { AgentDirectory } from '../../../server/controller/agents/directory.js';
import { AgentEventBus } from '../../../server/controller/agents/event-bus.js';
import { AgentRuntimeRouter } from '../../../server/controller/agents/runtime-router.js';
import { ChatRegistry } from '../../../server/controller/chats/store.js';
import { TranscriptAdoptionService } from '../../../server/controller/ledger/adoption.js';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { IntegrationRegistry } from '../../../server/runtime/agents/integration-registry.js';
import { integrationFixture, remoteFixture } from '../../../server/remote/__tests__/integration-fixture.js';

const CHAT = '1783725900000500';
const AT = '2026-09-25T00:00:00.000Z';
const SESSION = {
  agentSessionId: 'synthetic-current-session',
  nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'synthetic-current-session' } },
  nativeSeedReceipt: null,
};

for (const backend of ['local', 'controller', 'worker'] as const) {
  for (const source of ['ledger', 'legacy'] as const) {
    test(`cold compaction initializes ${source} authority (${backend})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'garcon-lazy-compaction-'));
      const chats = new ChatRegistry(root);
      await chats.init();
      const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'ledger')));
      const requests: AgentResumeRequestV5[] = [];
      let imports = 0;
      const configure = (native: ReturnType<typeof integrationFixture>) => {
        Object.assign(native.integration, {
          compaction: { async compact(request, options) {
            requests.push(request);
            return native.integration.execution.resume(request, options);
          } },
          legacyHistoryImport: { async *load() {
            imports++;
            yield [{ message: new AssistantMessage(AT, 'Synthetic legacy history') }];
          } },
        } satisfies Pick<AgentIntegration, 'compaction' | 'legacyHistoryImport'>);
      };
      const local = integrationFixture(root, 'local');
      configure(local);
      const remote = backend === 'local' ? null : await remoteFixture(
        backend, (_controller, _worker, native) => configure(native), root, '22222222-2222-4222-8222-222222222222',
      );
      const native = remote?.generations[0] ?? local;
      const integration = remote ? await remote.executor.getAgentIntegration('test') : local.integration;
      try {
        const integrations = new IntegrationRegistry({ instances: [integration] });
        const directory = new AgentDirectory(integrations, {
          isReady: () => true,
          integrationsFor: () => integrations,
          knownIntegration: ({ agentId }) => integrations.get(agentId),
          requireIntegration: ({ agentId }) => integrations.require(agentId),
        });
        chats.addChat({ id: CHAT, agentId: 'test', executorId: native.scope.executorId,
          projectPath: root, model: 'synthetic-model', agentSettingsById: { test: integration.settings.defaults() },
          parentChat: null, preambleSelection: { revision: 0, orderedPreambleIds: [] } });
        if (source === 'ledger') {
          ledger.initializeChat(CHAT, [{ kind: 'session', at: AT, detail: SESSION, providerMeta: null }]);
          chats.updateChat(CHAT, { agentSessionId: null, nativeSession: null });
        } else {
          chats.updateChat(CHAT, SESSION);
        }
        const adoption = new TranscriptAdoptionService({
          ledger, registry: chats, integrations: directory, getCarryOverRevision: () => '', loadFrozenPrefix: async () => [],
        });
        const router = new AgentRuntimeRouter({
          registry: chats, directory, ledger, adoption, events: new AgentEventBus(),
          endpointResolver: new ApiProviderEndpointResolver(() => [], () => []),
          getCarryOverRevision: () => '', createCarriedContext: async () => ({ kind: 'no-history' }),
          hasPendingOwnershipTransfer: () => false, resolveFileMentions: async prompt => prompt,
        });
        expect(imports).toBe(0);
        await router.compactSession(CHAT);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ agentSessionId: SESSION.agentSessionId, nativeSession: SESSION.nativeSession });
        expect(ledger.currentSession(CHAT)?.detail).toEqual(SESSION);
        expect(imports).toBe(source === 'legacy' ? 1 : 0);
        expect(native.calls.start).toBe(0);
        expect(native.calls.resume).toBe(1);
        native.nativePublishers[0]!({ type: 'run-ended', runId: requests[0]!.runId, outcome: 'finished' });
        await integration.execution.runningSessions();
        expect(ledger.activeRunId(CHAT)).toBeNull();
        expect(ledger.currentRows(CHAT).at(-1)).toMatchObject({ kind: 'run-ended', outcome: 'finished' });
      } finally {
        ledger.close();
        await Promise.resolve();
        await integration.execution.runningSessions();
        await remote?.dispose();
        await local.executor.dispose();
        await chats.flush();
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);
  }
}
