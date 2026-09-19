import {
  AgentCallError,
  createAgentResourceRef,
  type AgentIntegration,
  type AgentProducerNotification,
  type AgentResourceScope,
  type ExecutionNode,
  type AgentStartRequestV5,
  type AgentImportedTranscriptRow,
  type AgentSingleQueryRequest,
} from '@garcon/server-agent-interface';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import type { AgentRuntimeExecution, AgentRuntimePublisher } from '@garcon/server-agent-common/execution/runtime-events';
import { AgentRpc } from '../rpc.js';
import { RemoteExecutionNode } from '../remote.js';
import { WebSocketLink } from '../websocket-link.js';
import { serveAgentNode } from '../agent-worker.js';
import { LocalExecutionProjectService } from '../project-service.js';
import { discoverApiProviderModels } from '../../api-providers/discovery.js';

export const linkOptions = { nodeId: 'test-node', secret: 'test-secret-longer-than-32-characters', allowInsecureDevelopment: true, reconnectDelayMs: 20 };

export function integrationFixture(projectBasePath = '/test-project', nodeId = 'test-node') {
  const scope: AgentResourceScope = { nodeId, instanceId: crypto.randomUUID(), integrationId: 'test' };
  const published: AgentProducerNotification[] = [];
  const nativePublishers: AgentRuntimePublisher[] = [];
  const calls = { start: 0, resume: 0, abort: 0, migrate: 0, initialize: 0, stop: 0, import: 0, query: 0 };
  const hooks = {
    start: async () => {},
    stop: async () => {},
    query: async (_request: AgentSingleQueryRequest) => 'query result',
    history: async function* (_signal: AbortSignal): AsyncGenerator<readonly AgentImportedTranscriptRow[]> { yield []; },
  };
  const runtime: AgentRuntimeExecution = {
    async start(_request, publish) {
      calls.start++;
      nativePublishers.push(publish);
      await hooks.start();
      return { agentSessionId: 'test-session', nativeSession: null, nativeSeedReceipt: null };
    },
    async resume(_request, publish) { calls.resume++; nativePublishers.push(publish); },
    async abort() { calls.abort++; return true; },
    runningSessions() { return []; },
  };
  const producer = createAgentProducerAdapter(runtime, {
    scope, logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  producer.producers.subscribe((event) => published.push(event));
  const settings = createVersionedSettings({ ownerId: 'test', schemaVersion: 1, defaults: {}, descriptors: [] });
  const integration = {
    descriptor: {
      id: 'test', label: 'Test', icon: null, supportedPermissionModes: ['default'], supportedThinkingModes: ['medium'],
      supportedEndpointProtocols: [], supportsImages: false, supportsProjectPathUpdate: false,
      requiresNativePathForProjectPathUpdate: false, configuration: [],
    },
    attachments: null, execution: producer.execution, producers: producer.producers, permissions: producer.permissions,
    settings, migration: createVersion1RecordMigration({ settings, nativeSessions: null }),
    catalog: { async snapshot() { throw new AgentCallError('rejected', 'Unused catalog'); } },
    lifecycle: {
      async start() { calls.initialize++; },
      async stop() { calls.stop++; await hooks.stop(); },
      async migrateOwnedStorage() { calls.migrate++; },
    },
    nativeHistoryImport: { async *load({ signal }) { calls.import++; yield* hooks.history(signal); } },
    singleQuery: { async run(request: AgentSingleQueryRequest) { calls.query++; return hooks.query(request); } },
    auth: null, commands: null, compaction: null, forking: null, steering: null, endpoints: null,
    legacyHistoryImport: null, nativeActivity: null, nativeSessions: null, configurationValidation: null,
    sessionConfiguration: null, projectPathUpdates: null,
  } satisfies AgentIntegration;
  let disposed = false;
  const projects = new LocalExecutionProjectService(projectBasePath, (options) => {
    options?.signal?.throwIfAborted();
    if (disposed) throw new AgentCallError('not-dispatched', 'Disposed');
  });
  const unavailable = async (): Promise<never> => { throw new AgentCallError('not-dispatched', 'Unavailable'); };
  const node = {
    id: scope.nodeId,
    get availability() { return disposed ? 'disposed' as const : 'ready' as const; },
    async getInfo() {
      return {
        nodeId: scope.nodeId, instanceId: scope.instanceId, integrationIds: ['test'],
        projectBasePath,
        services: { agents: true, files: false, processes: false, git: false, terminals: false },
      };
    },
    async getAgentIntegration() { return integration; },
    async getProjectService() { return projects; },
    discoverApiProviderModels,
    getProcessService: unavailable, getFilesService: unavailable, getGitService: unavailable, getTerminalService: unavailable,
    onAvailabilityChanged() { return () => {}; },
    async dispose() { disposed = true; await integration.lifecycle.stop(); },
  } satisfies ExecutionNode;
  return { node, integration, scope, calls, hooks, nativePublishers, published };
}

export async function remoteFixture(
  dialer: 'controller' | 'worker',
  configure: (controller: WebSocketLink, worker: WebSocketLink) => void = () => {},
  projectBasePath?: string,
) {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const generations: ReturnType<typeof integrationFixture>[] = [];
  const scopes: ReturnType<typeof serveAgentNode>[] = [];
  configure(controller, worker);
  worker.onSession((session) => {
    const fixture = integrationFixture(projectBasePath);
    generations.push(fixture);
    scopes.push(serveAgentNode(fixture.node, new AgentRpc(session), 50));
  });
  const connected = RemoteExecutionNode.connect(controller);
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const node = await connected;
  return {
    controller, worker, node, generations,
    async dispose() {
      await node.dispose(); await worker.dispose();
      await Promise.all(scopes.map((scope) => scope.dispose()));
    },
  };
}

export function outgoingFault(link: WebSocketLink) {
  const fault = { inject: (_encoded: string): 'drop' | 'disconnect' | null => null };
  link.onSession((session) => {
    const attach = session.attach.bind(session);
    session.attach = (socket, received) => attach({
      close: () => socket.close(),
      send(encoded) {
        const action = fault.inject(encoded);
        if (action === 'drop') return;
        if (action === 'disconnect') {
          socket.close();
          throw new Error('Injected test disconnect');
        }
        socket.send(encoded);
      },
    }, received);
  });
  return fault;
}

export async function requestFor(integration: AgentIntegration): Promise<AgentStartRequestV5> {
  const producerBinding = createAgentResourceRef(integration.producers.scope, 'producer');
  await integration.producers.bind({ binding: producerBinding, chatId: 'test-chat' });
  return {
    chatId: 'test-chat', runId: crypto.randomUUID(), projectPath: '/test-project', model: 'test-model',
    permissionMode: 'default', thinkingMode: 'medium', settings: integration.settings.defaults(), endpoint: null,
    producerBinding, prompt: 'test prompt', carriedContext: null, attachments: [],
  };
}
