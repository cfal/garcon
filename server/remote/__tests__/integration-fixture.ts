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
import type { SessionSocket } from '../transport/message-session.js';
import { connectRemoteExecutor } from './runtime-adapter.js';
import { WebSocketLink } from '../transport/websocket-link.js';
import { serveExecutionRuntime } from '../server/executor-rpc-server.js';
import { ProducerRelay, type ProducerRelayOptions } from '../server/producer-relay.js';
import { RpcReplyJournal } from '../transport/rpc-journal.js';
import type { RemoteExecutorClientOptions } from '../client/executor-client.js';
import { ProjectService } from '../../runtime/projects/project-service.js';
import { discoverApiProviderModels } from '../../runtime/providers/discovery.js';

export const linkOptions = { executorId: 'test-executor', secret: Buffer.alloc(32, 42).toString('base64url'), allowInsecureDevelopment: true, redialDelaysMs: [20] };

export function integrationFixture(projectBasePath = '/test-project', executorId = 'test-executor') {
  const scope: AgentResourceScope = { executorId, instanceId: crypto.randomUUID(), integrationId: 'test' };
  const published: AgentProducerNotification[] = [];
  const nativePublishers: AgentRuntimePublisher[] = [];
  const calls = { start: 0, resume: 0, abort: 0, migrate: 0, initialize: 0, stop: 0, import: 0, query: 0 };
  const hooks = {
    start: async (_request: AgentRuntimeStartRequest) => {},
    initialize: async () => {},
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
      async start() { calls.initialize++; await hooks.initialize(); },
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
  executorId = linkOptions.executorId,
  resumption: { readonly relay?: ProducerRelayOptions; readonly client?: RemoteExecutorClientOptions } = {},
) {
  const controller = new WebSocketLink({ ...linkOptions, executorId, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, executorId, role: 'worker' });
  const fixture = integrationFixture(projectBasePath, executorId);
  const generations = [fixture];
  const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
  const relay = new ProducerRelay(resumption.relay);
  const journal = new RpcReplyJournal();
  configure(controller, worker, fixture);
  worker.onSession((session) => {
    scopes.push(serveExecutionRuntime(fixture.executor, new ExecutorRpc(session, { journal }), relay));
  });
  const connected = connectRemoteExecutor(controller, undefined, resumption.client);
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const executor = await connected;
  return {
    controller, worker, executor, generations, journal,
    async dispose() {
      await executor.dispose(); await worker.dispose();
      await Promise.all(scopes.map((scope) => scope.dispose()));
      relay.dispose();
      journal.dispose();
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

// Holds a link's outgoing session messages, as a stalled network path would, so a test
// controls when they reach the peer. The hold starts after a chosen message has passed,
// wherever the peer's socket buffers stand. Released messages keep their order, and
// anything sent before the backlog drains queues behind it.
export function outgoingHold(link: WebSocketLink) {
  const held: { readonly socket: SessionSocket; readonly encoded: string }[] = [];
  let holding = false;
  let startsAfter: ((encoded: string) => boolean) | null = null;
  link.onSession((session) => {
    const attach = session.attach.bind(session);
    session.attach = (socket) => attach({
      close: () => socket.close(),
      canSend: (bytes) => holding || held.length > 0 || socket.canSend?.(bytes) !== false,
      send(encoded) {
        if (holding || held.length > 0) {
          held.push({ socket, encoded });
          return;
        }
        socket.send(encoded);
        if (startsAfter?.(encoded)) {
          startsAfter = null;
          holding = true;
        }
      },
    });
  });
  return {
    holdAfter(matches: (encoded: string) => boolean) { startsAfter = matches; },
    async release() {
      holding = false;
      while (held.length > 0) {
        const next = held[0]!;
        if (next.socket.canSend?.(Buffer.byteLength(next.encoded)) === false) {
          await Bun.sleep(1);
          continue;
        }
        held.shift();
        next.socket.send(next.encoded);
      }
    },
  };
}

export function isProducerResumeReply(encoded: string): boolean {
  return encoded.startsWith('{"type":"result"') && encoded.includes('"resumed":');
}

// Matches the reply that carries a launch's execution handle.
export function isExecutionHandleReply(encoded: string): boolean {
  return encoded.includes('"type":"result"') && encoded.includes('"kind":"execution"');
}

// Refuses the next matching message at the session queue's admission check, as
// a full queue does, without closing the session.
export function admissionFault(link: WebSocketLink) {
  let refused: ((encoded: string) => boolean) | null = null;
  link.onSession((session) => {
    const canAdmit = session.channel.canAdmit.bind(session.channel);
    session.channel.canAdmit = (body) => {
      if (!refused?.(body)) return canAdmit(body);
      refused = null;
      return false;
    };
  });
  return {
    refuseNext(matches: (encoded: string) => boolean): void { refused = matches; },
  };
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
