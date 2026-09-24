import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashToolUseMessage } from '../../../common/chat-types.js';
import { ApiProviderEndpointResolver } from '../../../server/api-providers/endpoint-resolver.js';
import { ChatRegistry } from '../../../server/chats/store.js';
import { AgentDirectory, type ExecutionIntegrationDirectory } from '../../../server/agents/directory.js';
import { AgentEventBus } from '../../../server/agents/event-bus.js';
import { IntegrationRegistry } from '../../../server/agents/integration-registry.js';
import { AgentRuntimeRouter } from '../../../server/agents/runtime-router.js';
import { integrationFixture, linkOptions } from '../../../server/execution-nodes/__tests__/integration-fixture.js';
import { serveAgentNode } from '../../../server/execution-nodes/agent-worker.js';
import { AgentRpc } from '../../../server/execution-nodes/rpc.js';
import { RemoteExecutionNode } from '../../../server/execution-nodes/remote.js';
import { WebSocketLink } from '../../../server/execution-nodes/websocket-link.js';
import { TranscriptAdoptionService } from '../../../server/ledger/adoption.js';
import { TranscriptLedgerService } from '../../../server/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { PermissionNotActionableError } from '../../../server/ledger/errors.js';
import { DomainError } from '../../../server/lib/domain-error.js';

const NODE = '22222222-2222-4222-8222-222222222222';
const CHAT = '1783725900000400';
const OCCURRENCE = '11111111-1111-4111-8111-111111111111';

for (const dialer of ['controller', 'worker'] as const) {
  test(`disconnect denies permissions and retires their ledger actionability (${dialer} dials)`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-permission-reconnect-'));
    const chats = new ChatRegistry(root);
    await chats.init();
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'ledger')), { serverInstanceId: 'synthetic-server' });
    const controller = new WebSocketLink({ ...linkOptions, nodeId: NODE, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, nodeId: NODE, role: 'worker' });
    const native = integrationFixture(root, NODE);
    const serving: ReturnType<typeof serveAgentNode>[] = [];
    worker.onSession(session => serving.push(serveAgentNode(native.node, new AgentRpc(session))));
    const connected = RemoteExecutionNode.connect(controller);
    if (dialer === 'controller') controller.dial(worker.listen());
    else worker.dial(controller.listen());
    const remote = await connected;
    try {
      const integration = await remote.getAgentIntegration('test');
      const integrations = new IntegrationRegistry({ instances: [integration] });
      const nodes = {
        isReady: () => remote.availability === 'ready',
        integrationsFor() { return integrations; },
        knownIntegration: ({ agentId }) => integrations.get(agentId),
        requireIntegration({ agentId }) {
          if (remote.availability !== 'ready') {
            throw new DomainError('EXECUTION_NODE_UNAVAILABLE', 'Execution node is unavailable', 503, true);
          }
          return integrations.require(agentId);
        },
      } satisfies ExecutionIntegrationDirectory;
      const directory = new AgentDirectory(new IntegrationRegistry({ instances: [] }), nodes);
      const adoption = new TranscriptAdoptionService({
        ledger, registry: chats, integrations: directory, getCarryOverRevision: () => '', loadFrozenPrefix: async () => [],
      });
      chats.addChat({ id: CHAT, nodeId: NODE, agentId: 'test', model: 'synthetic-model', projectPath: root,
        parentChat: null, preambleSelection: { revision: 0, orderedPreambleIds: [] } });
      ledger.initializeChat(CHAT);
      const router = new AgentRuntimeRouter({
        registry: chats, directory, ledger, adoption, events: new AgentEventBus(),
        endpointResolver: new ApiProviderEndpointResolver(() => [], () => []),
        getCarryOverRevision: () => '', createCarriedContext: async () => ({ kind: 'no-history' }),
        hasPendingOwnershipTransfer: () => false, resolveFileMentions: async prompt => prompt,
      });
      remote.onAvailabilityChanged(value => { if (value === 'offline') router.executionSessionLost(NODE); });
      await router.startSession(CHAT, 'Synthetic permission input');
      const runId = ledger.activeRunId(CHAT)!;
      const decisions: boolean[] = [];
      native.nativePublishers[0]!({ type: 'permission', runId,
        lifecycle: { kind: 'requested', permissionOccurrenceId: OCCURRENCE,
          requestedTool: new BashToolUseMessage('2026-09-23T00:00:00.000Z', 'synthetic-tool', 'pwd'), options: [] },
        decision: { permissionOccurrenceId: OCCURRENCE, async respond(decision) { decisions.push(decision.allow); } },
      });
      await integration.execution.runningSessions();
      expect(ledger.currentRows(CHAT).filter(row => row.kind === 'permission-requested')).toHaveLength(1);
      const original = controller.current;
      const restored = Promise.withResolvers<void>();
      remote.onAvailabilityChanged(availability => { if (availability === 'ready') restored.resolve(); });
      controller.disconnect();
      worker.disconnect();
      expect(remote.availability).toBe('offline');
      const control = { serverInstanceId: 'synthetic-server', chatId: CHAT, runId, permissionOccurrenceId: OCCURRENCE };
      await restored.promise;
      expect(controller.current).not.toBe(original);
      expect(serving).toHaveLength(2);
      await expect(router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control)).rejects.toBeInstanceOf(PermissionNotActionableError);
      expect(decisions).toEqual([false]);
      expect(ledger.currentRows(CHAT).filter(row => row.kind === 'permission-resolved')).toHaveLength(0);
      expect(ledger.currentRows(CHAT).find(row => row.kind === 'run-ended')).toMatchObject({
        outcome: 'failed', error: { code: 'OUTCOME_UNKNOWN', message: expect.stringContaining('Reload from native history') },
      });
    } finally {
      ledger.close();
      await remote.dispose();
      await worker.dispose();
      await Promise.all(serving.map(scope => scope.dispose()));
      await native.node.dispose();
      await chats.flush();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
