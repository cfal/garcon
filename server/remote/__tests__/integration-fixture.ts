import {
  AgentCallError,
  createAgentResourceRef,
  type AgentIntegration,
  type AgentProducerNotification,
  type AgentResourceScope,
  type ExecutionRuntimeApi,
  type AgentStartRequestV5,
  type AgentImportedTranscriptRow,
  type AgentSingleQueryRequest,
} from '@garcon/server-agent-interface';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import type { AgentRuntimeExecution, AgentRuntimePublisher, AgentRuntimeStartRequest } from '@garcon/server-agent-common/execution/runtime-events';
import { ExecutorRpc } from '../transport/rpc.js';
import { RemoteExecutorClient } from '../client/executor-client.js';
import { WebSocketLink } from '../transport/websocket-link.js';
import { serveExecutionRuntime } from '../server/executor-rpc-server.js';
import { ProjectService } from '../../runtime/projects/project-service.js';
import { discoverApiProviderModels } from '../../runtime/providers/discovery.js';

export const linkOptions = { executorId: 'test-executor', secret: Buffer.alloc(32, 42).toString('base64url'), allowInsecureDevelopment: true, reconnectDelayMs: 20 };

export function integrationFixture(projectBasePath = '/test-project', executorId = 'test-executor') {
  const scope: AgentResourceScope = { executorId, instanceId: crypto.randomUUID(), integrationId: 'test' };
  const published: AgentProducerNotification[] = [];
  const nativePublishers: AgentRuntimePublisher[] = [];
  const calls = { start: 0, resume: 0, abort: 0, migrate: 0, initialize: 0, stop: 0, import: 0, query: 0 };
  const hooks = {
    start: async (_request: AgentRuntimeStartRequest) => {},
    stop: async () => {},
    query: async (_request: AgentSingleQueryRequest) => 'query result',
    history: async function* (_signal: AbortSignal): AsyncGenerator<readonly AgentImportedTranscriptRow[]> { yield []; },
  };
  const runtime: AgentRuntimeExecution = {
    async start(request, publish) {
      calls.start++;
      nativePublishers.push(publish);
      await hooks.start(request);
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
  const projects = new ProjectService(projectBasePath, (options) => {
    options?.signal?.throwIfAborted();
    if (disposed) throw new AgentCallError('not-dispatched', 'Disposed');
  });
  const unavailable = async (): Promise<never> => { throw new AgentCallError('not-dispatched', 'Unavailable'); };
  const executor = {
    id: scope.executorId,
    get availability() { return disposed ? 'disposed' as const : 'ready' as const; },
    async getInfo() {
      return {
        executorId: scope.executorId, instanceId: scope.instanceId, integrationIds: ['test'],
        projectBasePath,
        services: { files: false, git: false, gh: false, terminals: false },
      };
    },
    async getAgentIntegration() { return integration; },
    async getProjectService() { return projects; },
    discoverApiProviderModels,
    getFilesService: unavailable, getGitService: unavailable, getGhService: unavailable, getTerminalService: unavailable,
    onAvailabilityChanged() { return () => {}; },
    async dispose() { disposed = true; await integration.lifecycle.stop(); },
  } satisfies ExecutionRuntimeApi;
  return { executor, integration, scope, calls, hooks, nativePublishers, published };
}

export async function remoteFixture(
  dialer: 'controller' | 'worker',
  configure: (controller: WebSocketLink, worker: WebSocketLink, fixture: ReturnType<typeof integrationFixture>) => void = () => {},
  projectBasePath?: string,
) {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const fixture = integrationFixture(projectBasePath);
  const generations = [fixture];
  const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
  configure(controller, worker, fixture);
  worker.onSession((session) => {
    scopes.push(serveExecutionRuntime(fixture.executor, new ExecutorRpc(session)));
  });
  const connected = RemoteExecutorClient.connect(controller);
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const executor = await connected;
  return {
    controller, worker, executor, generations,
    async dispose() {
      await executor.dispose(); await worker.dispose();
      await Promise.all(scopes.map((scope) => scope.dispose()));
      await fixture.executor.dispose();
    },
  };
}

export function outgoingFault(link: WebSocketLink) {
  const fault = { inject: (_encoded: string): 'drop' | 'disconnect' | null => null };
  link.onSession((session) => {
    const attach = session.attach.bind(session);
    session.attach = (socket) => attach({
      close: () => socket.close(),
      canSend: (bytes) => socket.canSend?.(bytes) !== false,
      send(encoded) {
        const action = fault.inject(encoded);
        if (action === 'drop') return;
        if (action === 'disconnect') {
          socket.close();
          throw new Error('Injected test disconnect');
        }
        socket.send(encoded);
      },
    });
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
