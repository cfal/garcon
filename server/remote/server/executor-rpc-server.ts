import {
  AgentCallError,
  type AgentIntegration,
  type ExecutionRuntimeApi,
  type ExecutorInfo,
} from '@garcon/server-agent-interface';
import { NULLABLE_AGENT_FACETS, rpcContinuity, type ExecutorRpcRequest, type IntegrationManifest } from '../transport/rpc-protocol.js';
import type { ExecutorRpc } from '../transport/rpc.js';
import { decodeFileText, validateFileRpcRequest, invalidFileData } from '../transport/file-protocol.js';
import { TerminalRpcServer } from './terminal-rpc-server.js';
import { GitRpcServer } from './git-rpc-server.js';
import { isGitRpcMethod, type GitRpcRequest } from '../transport/git-protocol.js';
import { HistoryRpcServer } from './history-rpc-server.js';
import type { ProducerRelay, ProducerRelaySession } from './producer-relay.js';

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
  const producerSession: ProducerRelaySession = { offer: (payload) => rpc.offerProducer(payload) };
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
    if (!disposed) await terminalWorker?.handle({ method: 'terminals.detach', request });
  });
  const install = (endpoint: ExecutorRpc, history: HistoryRpcServer | null) => endpoint.handle(async (call, signal, _guardReply, onUndeliveredReply) => {
    await ready;
    // A journaled call runs to completion even if its session retired first.
    if (signal.aborted || (disposed && rpcContinuity(call.method) !== 'journaled')) {
      throw new AgentCallError('not-dispatched', 'Worker session retired or request cancelled');
    }
    if (call.method === 'executor.describe') return { info, integrations: [...integrations.values()].map(manifest) };
    if (call.method === 'controllerCli.describe' || call.method === 'controllerCli.request') {
      throw new AgentCallError('rejected', 'CLI dispatch is controller-owned');
    }
    if (isGitRpcMethod(call.method)) {
      if (call.integrationId !== '') throw new AgentCallError('rejected', 'Git operations are executor services');
      return required(gitWorker).handle(call as GitRpcRequest, signal);
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
        return required(terminalWorker).handle(call);
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
        await integration.producers.bind(call.request, options);
        if (disposed) integration.producers.detach(call.request.binding);
        else relay.bind(producerSession, integration, call.request.binding);
        return;
      }
      case 'producers.close': {
        // No session owns a suspended binding, so the controller may close it from a
        // replacement session without resuming it first.
        if (!relay.owns(producerSession, integration, call.request) && !relay.suspended(integration, call.request)) {
          throw new AgentCallError('rejected', 'Producer binding belongs to a retired session', 'STALE_RESOURCE');
        }
        await integration.producers.close(call.request, options);
        relay.close(call.request);
        return;
      }
      case 'producers.cancelLaunch': {
        if (typeof call.request?.binding?.id !== 'string' || typeof call.request.runId !== 'string') {
          throw new AgentCallError('rejected', 'Invalid launch cancellation request');
        }
        relay.cancelLaunch(integration, call.request.binding, call.request.runId);
        return;
      }
      case 'producers.resume': {
        const bindings: unknown = call.request?.bindings;
        if (!Array.isArray(bindings) || bindings.some((entry) => (
          !entry?.binding || !Number.isSafeInteger(entry.acknowledgedSeq) || entry.acknowledgedSeq < 0
        ))) throw new AgentCallError('rejected', 'Invalid producer resume request');
        return { resumed: relay.resume(producerSession, integration, call.request.bindings) };
      }
      case 'permissions.respond': return integration.permissions.respond(call.request, options);
      case 'execution.start':
        return relay.launch(producerSession, integration, call.request, signal, onUndeliveredReply, (launchSignal) => (
          integration.execution.start(call.request, { signal: launchSignal })
        ));
      case 'execution.resume':
        return relay.launch(producerSession, integration, call.request, signal, onUndeliveredReply, (launchSignal) => (
          integration.execution.resume(call.request, { signal: launchSignal })
        ));
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
      case 'auth.launchLogin': return required(required(integration.auth).launchLogin)();
      case 'auth.completeLogin': return required(required(integration.auth).completeLogin)(call.request.sessionId, call.request.code);
      case 'auth.loginStatus': return required(required(integration.auth).loginStatus)(call.request.expectedSessionId);
      case 'commands.discover': return required(integration.commands).discover(call.request.projectPath, signal);
      case 'compaction.compact': {
        const compaction = required(integration.compaction);
        return relay.launch(producerSession, integration, call.request, signal, onUndeliveredReply, (launchSignal) => (
          compaction.compact(call.request, { signal: launchSignal })
        ));
      }
      case 'forking.fork': return required(integration.forking).fork({ ...call.request, signal });
      case 'forking.discard': return required(integration.forking).discard(call.request, signal);
      case 'steering.captureTarget': return required(integration.steering).captureTarget(call.request, options);
      case 'steering.steer': return required(integration.steering).steer(call.request, options);
      case 'endpoints.validate': return required(integration.endpoints).validate(call.request);
      case 'singleQuery.run': return required(integration.singleQuery).run({ ...call.request, signal });
      case 'history.open': case 'history.next': case 'history.close':
        return required(history).handle(call, signal);
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
      case 'credentials.resolve': throw new AgentCallError('rejected', 'Credential resolution is controller-owned');
      case 'calls.reconcile': throw new AgentCallError('rejected', 'Call reconciliation belongs to the RPC layer');
      default: return unknownMethod(call);
    }
  });
  install(rpc, null);
  return {
    ready, dispose,
    attachBulk(endpoint) {
      if (disposed || endpoint.transport.lane !== 'bulk' || endpoint.transport.primarySessionId !== rpc.transport.id) {
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

function unknownMethod(call: GitRpcRequest): never {
  throw new AgentCallError('not-dispatched', `Unknown executor RPC method: ${(call as ExecutorRpcRequest).method}`, 'OPERATION_UNSUPPORTED');
}
