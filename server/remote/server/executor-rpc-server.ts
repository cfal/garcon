import {
  AgentCallError,
  type AgentIntegration,
  type ExecutionRuntimeApi,
  type ExecutorInfo,
} from '@garcon/server-agent-interface';
import { NULLABLE_AGENT_FACETS, type ExecutorRpcRequest, type IntegrationManifest } from '../transport/rpc-protocol.js';
import type { ExecutorRpc } from '../transport/rpc.js';
import { decodeFileText, validateFileRpcRequest, invalidFileData } from '../transport/file-protocol.js';
import { TerminalRpcServer } from './terminal-rpc-server.js';
import { GitRpcServer } from './git-rpc-server.js';
import { isGitRpcMethod, type GitRpcMethods } from '../transport/git-protocol.js';
import { HistoryRpcServer } from './history-rpc-server.js';
import type { ProducerRelay, ProducerRelaySession } from './producer-relay.js';
import { sameContinuity } from '../transport/protocol-compatibility.js';
import { rpcWireV1 } from '../transport/rpc-wire-v1.js';
import { registerRpcHandlers, type RpcCallCapture } from '../transport/rpc-registrations.js';
import type { RequestFor } from '../transport/rpc-protocol.js';
import type { GuardRpcReply, ObserveUndeliveredReply } from '../transport/rpc.js';

export interface ExecutorRpcServer {
  readonly ready: Promise<void>;
  attachBulk(rpc: ExecutorRpc): void;
  dispose(): Promise<void>;
}

// `relay` outlives this session: it keeps bindings resumable by the next one.
export function serveExecutionRuntime(
  runtime: ExecutionRuntimeApi,
  rpc: ExecutorRpc,
  relay: ProducerRelay,
): ExecutorRpcServer {
  let info: ExecutorInfo;
  let disposed = false;
  let terminalWorker: TerminalRpcServer | null = null;
  let gitWorker: GitRpcServer | null = null;
  let disconnectTerminals = () => {};
  const unsubscribeAvailability = rpc.transport.onAvailability((connected) => { if (!connected) disconnectTerminals(); });
  const integrations = new Map<string, AgentIntegration>();
  const producerSession: ProducerRelaySession = { protocol: rpc.transport.protocol, offer: (payload) => rpc.offerProducer(payload) };
  relay.shortenSuspendedGrace();
  const historyScopes = new Set<HistoryRpcServer>();
  const ready = (async () => {
    info = await runtime.getInfo();
    gitWorker = new GitRpcServer(runtime);
    if (info.services.terminals) {
      const service = await runtime.getTerminalService();
      terminalWorker = new TerminalRpcServer(service, rpc);
      disconnectTerminals = () => { terminalWorker?.disconnect(); service.disconnect(); };
      if (disposed) { disconnectTerminals(); throw new AgentCallError('not-dispatched', 'Worker session retired'); }
    }
    for (const id of info.integrationIds) {
      const integration = await runtime.getAgentIntegration(id);
      if (disposed) throw new AgentCallError('not-dispatched', 'Worker session retired');
      integrations.set(id, integration);
      relay.track(integration);
    }
  })();
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    relay.suspend(producerSession);
    unsubscribeAvailability();
    disconnectTerminals();
    unsubscribe();
    rpc.retireUnknown();
    for (const scope of historyScopes) scope.dispose();
    historyScopes.clear();
  };
  // Registration precedes readiness so an immediate describe cannot outrun dispatch installation.
  let unsubscribe = () => {};
  unsubscribe = rpc.transport.onFailure(() => { void dispose(); });
  void ready.catch((error: unknown) => rpc.transport.close(error instanceof Error ? error : new Error(String(error))));
  rpc.onProducerAck((acknowledgements) => relay.acknowledge(producerSession, acknowledgements));
  rpc.onTerminalDetach(async (request) => {
    await ready;
    if (!disposed) await terminalWorker?.detach(request);
  });
  const install = (endpoint: ExecutorRpc, history: HistoryRpcServer | null) => endpoint.handle(WORKER_RPC_HANDLERS.bind({
    runtime, relay, ready, integrations, producerSession, history, info: () => info, disposed: () => disposed,
    git: () => gitWorker, terminals: () => terminalWorker,
  }));
  install(rpc, null);
  return {
    ready, dispose,
    attachBulk(endpoint) {
      if (disposed || endpoint.transport.lane !== 'bulk' || endpoint.transport.primarySessionId !== rpc.transport.id
        || !sameContinuity(endpoint.transport.continuity, rpc.transport.continuity)) {
        throw new AgentCallError('not-dispatched', 'Bulk endpoint does not belong to this runtime generation');
      }
      const history = new HistoryRpcServer(integrations);
      historyScopes.add(history);
      endpoint.transport.onFailure(() => { history.dispose(); historyScopes.delete(history); });
      install(endpoint, history);
    },
  };
}

function manifest(integration: AgentIntegration): IntegrationManifest {
  return {
    descriptor: integration.descriptor, scope: integration.producers.scope,
    settings: { descriptors: integration.settings.describe(), defaults: integration.settings.defaults() },
    attachments: integration.attachments,
    capabilities: Object.fromEntries(NULLABLE_AGENT_FACETS.map((key) => [key, integration[key] !== null])) as IntegrationManifest['capabilities'],
    literalExecution: integration.literalExecution,
    authMethods: {
      launchLogin: typeof integration.auth?.launchLogin === 'function',
      completeLogin: typeof integration.auth?.completeLogin === 'function',
      loginStatus: typeof integration.auth?.loginStatus === 'function',
    },
    singleQueryRunsToolsWithoutPermission: integration.singleQuery?.runsToolsWithoutPermission === true,
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new AgentCallError('rejected', 'Integration capability unavailable', 'OPERATION_UNSUPPORTED');
  return value;
}

function unreachable(call: never): never { throw new Error('Unregistered worker RPC method'); }

export const WORKER_RPC_WIRES = Object.freeze([
  rpcWireV1('apiProviders.discoverModels'),
  rpcWireV1('auth.completeLogin'),
  rpcWireV1('auth.launchLogin'),
  rpcWireV1('auth.loginStatus'),
  rpcWireV1('auth.status'),
  rpcWireV1('catalog.snapshot'),
  rpcWireV1('commands.discover'),
  rpcWireV1('compaction.compact'),
  rpcWireV1('configurationValidation.validate'),
  rpcWireV1('endpoints.validate'),
  rpcWireV1('execution.abort'),
  rpcWireV1('execution.resume'),
  rpcWireV1('execution.runningSessions'),
  rpcWireV1('execution.start'),
  rpcWireV1('executor.describe'),
  rpcWireV1('files.browse'),
  rpcWireV1('files.createDirectory'),
  rpcWireV1('files.identity'),
  rpcWireV1('files.list'),
  rpcWireV1('files.read'),
  rpcWireV1('files.revision'),
  rpcWireV1('files.save'),
  rpcWireV1('files.tree'),
  rpcWireV1('forking.discard'),
  rpcWireV1('forking.fork'),
  rpcWireV1('gh.createPullRequestComment'),
  rpcWireV1('gh.getPullRequest'),
  rpcWireV1('gh.getPullRequestReviewTarget'),
  rpcWireV1('gh.getStatus'),
  rpcWireV1('gh.listPullRequests'),
  rpcWireV1('gh.minimizePullRequestComment'),
  rpcWireV1('git.acceptConflictSide'),
  rpcWireV1('git.applyStash'),
  rpcWireV1('git.checkout'),
  rpcWireV1('git.collectCommitMessageContext'),
  rpcWireV1('git.commit'),
  rpcWireV1('git.commitIndex'),
  rpcWireV1('git.createBranch'),
  rpcWireV1('git.createStash'),
  rpcWireV1('git.createWorktree'),
  rpcWireV1('git.deleteUntracked'),
  rpcWireV1('git.discard'),
  rpcWireV1('git.dropStash'),
  rpcWireV1('git.fetch'),
  rpcWireV1('git.getBlame'),
  rpcWireV1('git.getBranches'),
  rpcWireV1('git.getCommitSnapshot'),
  rpcWireV1('git.getComparisonFreshness'),
  rpcWireV1('git.getComparisonSnapshot'),
  rpcWireV1('git.getConflictDetails'),
  rpcWireV1('git.getConflicts'),
  rpcWireV1('git.getFileHistory'),
  rpcWireV1('git.getGraph'),
  rpcWireV1('git.getHistoryCommits'),
  rpcWireV1('git.getQuickSummary'),
  rpcWireV1('git.getRefs'),
  rpcWireV1('git.getRemoteStatus'),
  rpcWireV1('git.getRemotes'),
  rpcWireV1('git.getRepoInfo'),
  rpcWireV1('git.getReviewDocumentFileBodies'),
  rpcWireV1('git.getStashes'),
  rpcWireV1('git.getStatus'),
  rpcWireV1('git.getTargetCandidates'),
  rpcWireV1('git.getWorkbenchSnapshot'),
  rpcWireV1('git.getWorkingTreeFingerprint'),
  rpcWireV1('git.getWorktrees'),
  rpcWireV1('git.initialCommit'),
  rpcWireV1('git.markConflictResolved'),
  rpcWireV1('git.popStash'),
  rpcWireV1('git.pull'),
  rpcWireV1('git.push'),
  rpcWireV1('git.removeWorktree'),
  rpcWireV1('git.revertCommit'),
  rpcWireV1('git.stageHunk'),
  rpcWireV1('git.stagePaths'),
  rpcWireV1('git.stageSelection'),
  rpcWireV1('history.close'),
  rpcWireV1('history.next'),
  rpcWireV1('history.open'),
  rpcWireV1('lifecycle.migrateOwnedStorage'),
  rpcWireV1('lifecycle.start'),
  rpcWireV1('lifecycle.stop'),
  rpcWireV1('migration.translateLegacyModel'),
  rpcWireV1('migration.translateLegacyNativeSession'),
  rpcWireV1('migration.translateLegacySettings'),
  rpcWireV1('nativeActivity.lastActivity'),
  rpcWireV1('nativeSessions.describeSource'),
  rpcWireV1('nativeSessions.release'),
  rpcWireV1('nativeSessions.resolveNativeSession'),
  rpcWireV1('permissions.respond'),
  rpcWireV1('producers.bind'),
  rpcWireV1('producers.cancelLaunch'),
  rpcWireV1('producers.close'),
  rpcWireV1('producers.resume'),
  rpcWireV1('projectPathUpdates.commit'),
  rpcWireV1('projectPathUpdates.prepare'),
  rpcWireV1('projectPathUpdates.rollback'),
  rpcWireV1('projects.inspect'),
  rpcWireV1('projects.resolveFileMentions'),
  rpcWireV1('projects.ticketProjectDefault'),
  rpcWireV1('readiness.status'),
  rpcWireV1('sessionConfiguration.apply'),
  rpcWireV1('settings.migrate'),
  rpcWireV1('singleQuery.run'),
  rpcWireV1('steering.captureTarget'),
  rpcWireV1('steering.steer'),
  rpcWireV1('terminals.attach'),
  rpcWireV1('terminals.create'),
  rpcWireV1('terminals.detach'),
  rpcWireV1('terminals.input'),
  rpcWireV1('terminals.list'),
  rpcWireV1('terminals.rename'),
  rpcWireV1('terminals.resize'),
  rpcWireV1('terminals.terminate'),
] as const);

interface RuntimeRpcContext {
  readonly runtime: ExecutionRuntimeApi;
  readonly relay: ProducerRelay;
  readonly ready: Promise<void>;
  readonly integrations: ReadonlyMap<string, AgentIntegration>;
  readonly producerSession: ProducerRelaySession;
  readonly history: HistoryRpcServer | null;
  info(): ExecutorInfo;
  disposed(): boolean;
  git(): GitRpcServer | null;
  terminals(): TerminalRpcServer | null;
}

async function dispatchWorkerV1(context: RuntimeRpcContext | { readonly retained: ExecutionRuntimeApi },
  call: RequestFor<(typeof WORKER_RPC_WIRES)[number]['definition']>, signal: AbortSignal,
  _guardReply: GuardRpcReply, onUndeliveredReply: ObserveUndeliveredReply, capture: RpcCallCapture): Promise<unknown> {
  const { wire } = capture;
  if ('retained' in context) {
    if (call.method === 'executor.describe') return { info: await context.retained.getInfo(), integrations: [] };
    throw new AgentCallError('not-dispatched', 'Restart the worker to serve a different executor');
  }
  const { runtime, relay, ready, integrations, producerSession, history } = context;
    await ready;
    // A journaled call runs to completion even if its session retired first.
    if (signal.aborted || (context.disposed() && wire.definition.continuity !== 'journaled')) {
      throw new AgentCallError('not-dispatched', 'Worker session retired or request cancelled');
    }
    if (call.method === 'executor.describe') return { info: context.info(), integrations: [...integrations.values()].map(manifest) };

    if (isGitCall(call)) {
      if (call.integrationId !== '') throw new AgentCallError('rejected', 'Git operations are executor services');
      return required(context.git()).handle(call, signal);
    }
    if (call.method === 'apiProviders.discoverModels') return runtime.discoverApiProviderModels(call.request, { signal });
    if (call.method === 'projects.inspect') return (await runtime.getProjectService()).inspect(call.request, { signal });
    if (call.method === 'projects.ticketProjectDefault') {
      if (call.integrationId !== '') throw new AgentCallError('rejected', 'Project operations are executor services');
      return (await runtime.getProjectService()).ticketProjectDefault(call.request, { signal });
    }
    if (call.method === 'projects.resolveFileMentions') return (await runtime.getProjectService()).resolveFileMentions(call.request, { signal });
    if (call.method.startsWith('files.')) {
      if (call.integrationId !== '') throw invalidFileData();
      validateFileRpcRequest(call.method, call.request);
    }
    switch (call.method) {
      case 'terminals.list': case 'terminals.create': case 'terminals.rename': case 'terminals.terminate':
      case 'terminals.attach': case 'terminals.input': case 'terminals.resize': case 'terminals.detach':
        if (call.integrationId !== '') throw new AgentCallError('rejected', 'Terminals are executor services');
        return required(context.terminals()).handle(call, wire);
      case 'files.tree': return (await runtime.getFilesService()).tree(call.request, { signal });
      case 'files.browse': return (await runtime.getFilesService()).browse(call.request, { signal });
      case 'files.list': return (await runtime.getFilesService()).list(call.request, { signal });
      case 'files.identity': return (await runtime.getFilesService()).identity(call.request, { signal });
      case 'files.revision': return (await runtime.getFilesService()).revision(call.request, { signal });
      case 'files.read': {
        const { bytes, ...metadata } = await (await runtime.getFilesService()).read(call.request, { signal });
        return { ...metadata, data: Buffer.from(bytes).toString('base64') };
      }
      case 'files.save': {
        const { data, ...target } = call.request;
        return (await runtime.getFilesService()).save({ ...target, content: decodeFileText(data) }, { signal });
      }
      case 'files.createDirectory': return (await runtime.getFilesService()).createDirectory(call.request, { signal });
    }
    const integration = integrations.get(call.integrationId);
    if (!integration) throw new AgentCallError('not-dispatched', 'Unknown integration', 'OPERATION_UNSUPPORTED');
    const options = { signal };
    switch (call.method) {
      case 'producers.bind': {
        relay.bind(producerSession, integration, call.request.binding, required(wire.producer));
        try {
          await integration.producers.bind(call.request, options);
          if (context.disposed()) {
            relay.close(call.request.binding);
            integration.producers.detach(call.request.binding);
          }
        } catch (error) {
          relay.close(call.request.binding);
          integration.producers.detach(call.request.binding);
          throw error;
        }
        return;
      }
      case 'producers.close': {
        relay.assertResource(integration, call.request, required(wire.definition.acceptsResource));
        // No session owns a suspended binding, so the controller may close it from a
        // replacement session without resuming it first.
        if (!relay.owns(producerSession, integration, call.request) && !relay.suspended(producerSession, integration, call.request)) {
          throw new AgentCallError('rejected', 'Producer binding belongs to a retired session', 'STALE_RESOURCE');
        }
        await integration.producers.close(call.request, options);
        relay.close(call.request);
        return;
      }
      case 'producers.cancelLaunch': {
        relay.assertResource(integration, call.request.binding, required(wire.definition.acceptsResource));
        if (typeof call.request?.binding?.id !== 'string' || typeof call.request.runId !== 'string') {
          throw new AgentCallError('rejected', 'Invalid launch cancellation request');
        }
        relay.cancelLaunch(producerSession, integration, call.request.binding, call.request.runId);
        return;
      }
      case 'producers.resume': {
        const bindings: unknown = call.request?.bindings;
        if (!Array.isArray(bindings) || bindings.some((entry) => (
          !entry?.binding || !Number.isSafeInteger(entry.acknowledgedSeq) || entry.acknowledgedSeq < 0
        ))) throw new AgentCallError('rejected', 'Invalid producer resume request');
        for (const { binding } of call.request.bindings) relay.assertResource(integration, binding, required(wire.definition.acceptsResource));
        return { resumed: relay.resume(producerSession, integration, call.request.bindings) };
      }
      case 'permissions.respond': return integration.permissions.respond(call.request, options);
      case 'execution.start':
        return relay.launch(producerSession, integration, call.request, signal, onUndeliveredReply, (launchSignal) => (
          integration.execution.start(call.request, { signal: launchSignal })
        ), required(wire.definition.acceptsResource));
      case 'execution.resume':
        return relay.launch(producerSession, integration, call.request, signal, onUndeliveredReply, (launchSignal) => (
          integration.execution.resume(call.request, { signal: launchSignal })
        ), required(wire.definition.acceptsResource));
      case 'execution.abort': return integration.execution.abort(call.request, options);
      case 'execution.runningSessions': return integration.execution.runningSessions(options);
      case 'catalog.snapshot': return integration.catalog.snapshot({ ...call.request, signal });
      case 'settings.migrate': return integration.settings.migrate(call.request);
      case 'lifecycle.start': return integration.lifecycle.start();
      case 'lifecycle.stop': return integration.lifecycle.stop();
      case 'lifecycle.migrateOwnedStorage': return integration.lifecycle.migrateOwnedStorage();
      case 'migration.translateLegacyModel': return integration.migration.translateLegacyModel({ ...call.request, signal });
      case 'migration.translateLegacyNativeSession': return integration.migration.translateLegacyNativeSession({ ...call.request, signal });
      case 'migration.translateLegacySettings': return integration.migration.translateLegacySettings({ ...call.request, signal });
      case 'auth.status': return required(integration.auth).status(signal);
      case 'readiness.status': return required(integration.readiness).status(signal);
      case 'auth.launchLogin': return required(required(integration.auth).launchLogin)();
      case 'auth.completeLogin': return required(required(integration.auth).completeLogin)(call.request.sessionId, call.request.code);
      case 'auth.loginStatus': return required(required(integration.auth).loginStatus)(call.request.expectedSessionId);
      case 'commands.discover': return required(integration.commands).discover(call.request.projectPath, signal);
      case 'compaction.compact': {
        const compaction = required(integration.compaction);
        return relay.launch(producerSession, integration, call.request, signal, onUndeliveredReply, (launchSignal) => (
          compaction.compact(call.request, { signal: launchSignal })
        ), required(wire.definition.acceptsResource));
      }
      case 'forking.fork': return required(integration.forking).fork({ ...call.request, signal });
      case 'forking.discard': return required(integration.forking).discard(call.request, signal);
      case 'steering.captureTarget': return required(integration.steering).captureTarget(call.request, options);
      case 'steering.steer': return required(integration.steering).steer(call.request, options);
      case 'endpoints.validate': return required(integration.endpoints).validate(call.request);
      case 'singleQuery.run': return required(integration.singleQuery).run({ ...call.request, signal });
      case 'history.open': case 'history.next': case 'history.close':
        return required(history).handle(call, signal, wire.definition);
      case 'nativeActivity.lastActivity': return required(integration.nativeActivity).lastActivity(call.request, signal);
      case 'nativeSessions.resolveNativeSession': return required(integration.nativeSessions).resolveNativeSession({ ...call.request, signal });
      case 'nativeSessions.describeSource': return required(integration.nativeSessions).describeSource({ ...call.request, signal });
      case 'nativeSessions.release': return required(integration.nativeSessions).release({ ...call.request, signal });
      case 'configurationValidation.validate': return required(integration.configurationValidation).validate(call.request);
      case 'sessionConfiguration.apply': return required(integration.sessionConfiguration).apply(...call.request.args);
      // Native preparation must return its compensation resource even after the RPC waiter cancels.
      case 'projectPathUpdates.prepare': return required(integration.projectPathUpdates).prepare(call.request);
      case 'projectPathUpdates.commit': return required(integration.projectPathUpdates).commit(call.request, options);
      case 'projectPathUpdates.rollback': return required(integration.projectPathUpdates).rollback(call.request, options);
      default: return unreachable(call);
    }
}

export const WORKER_RPC_HANDLERS = registerRpcHandlers(WORKER_RPC_WIRES, dispatchWorkerV1);

function isGitCall(call: ExecutorRpcRequest): call is Extract<ExecutorRpcRequest, { method: keyof GitRpcMethods }> {
  return isGitRpcMethod(call.method);
}
