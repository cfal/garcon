import {
  AgentCallError,
  type AgentHistoryImport,
  type AgentIntegration,
  type AgentImportedTranscriptRow,
  type ExecutionNode,
  type ExecutionNodeInfo,
} from '@garcon/server-agent-interface';
import { AgentResourceTable } from '@garcon/server-agent-common/execution/resource-table';
import { NULLABLE_AGENT_FACETS, type AgentRpcRequest, type IntegrationManifest } from './agent-protocol.js';
import type { AgentRpc } from './rpc.js';
import { FileTransfers } from './file-transfers.js';
import { validateFileRpcRequest, invalidFileTransfer } from './file-protocol.js';
import { TerminalWorker } from './terminal-worker.js';
import { GitWorker } from './git-worker.js';
import { isGitRpcMethod, type GitRpcRequest } from './git-protocol.js';

interface HistoryReader {
  readonly iterator: AsyncIterator<readonly AgentImportedTranscriptRow[]>;
  readonly controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  reading: boolean;
}

export function serveAgentNode(node: ExecutionNode, rpc: AgentRpc, cleanupTimeoutMs = 2000) {
  let info: ExecutionNodeInfo;
  let disposed = false;
  let cleanup: Promise<void> | null = null;
  let fileTransfers: FileTransfers | null = null;
  let terminalWorker: TerminalWorker | null = null;
  let gitWorker: GitWorker | null = null;
  let disconnectTerminals = () => {};
  const unsubscribeAvailability = rpc.transport.onAvailability((connected) => { if (!connected) disconnectTerminals(); });
  const integrations = new Map<string, AgentIntegration>();
  const readers = new Map<string, AgentResourceTable<'history-reader', HistoryReader>>();
  const readerResources = new Set<HistoryReader>();
  const subscriptions = new Set<() => void>();
  const ready = (async () => {
    info = await node.getInfo();
    gitWorker = new GitWorker(node, { nodeId: info.nodeId, instanceId: info.instanceId, sessionId: rpc.transport.id });
    if (info.services.terminals) {
      const service = await node.getTerminalService();
      terminalWorker = new TerminalWorker(service, rpc);
      disconnectTerminals = () => { terminalWorker?.disconnect(); service.disconnect(); };
      if (disposed) { disconnectTerminals(); throw new AgentCallError('not-dispatched', 'Worker session retired'); }
    }
    if (info.services.files) fileTransfers = new FileTransfers(await node.getFilesService(), { nodeId: info.nodeId, instanceId: info.instanceId, sessionId: rpc.transport.id });
    for (const id of info.integrationIds) {
      const integration = await node.getAgentIntegration(id);
      if (disposed) throw new AgentCallError('not-dispatched', 'Worker session retired');
      integrations.set(id, integration);
      readers.set(id, new AgentResourceTable(integration.producers.scope, 'history-reader', 16));
      subscriptions.add(integration.producers.subscribe((notification) => rpc.publish({ type: 'producer', notification })));
    }
  })();
  const dispose = (): Promise<void> => {
    if (cleanup) return cleanup;
    disposed = true;
    gitWorker?.dispose();
    unsubscribeAvailability();
    disconnectTerminals();
    unsubscribe();
    rpc.retireUnknown();
    for (const unsubscribeProducer of subscriptions) unsubscribeProducer();
    subscriptions.clear();
    for (const resource of readerResources) {
      if (resource.timer) clearTimeout(resource.timer);
      resource.controller.abort();
      void resource.iterator.return?.().catch(() => undefined);
    }
    readerResources.clear();
    cleanup = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([fileTransfers?.dispose(), node.dispose()]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Worker session cleanup timed out')), cleanupTimeoutMs);
            timer.unref();
          }),
        ]);
      } catch (error) {
        console.warn('Execution-node cleanup incomplete:', error instanceof Error ? error.message : String(error));
      } finally { clearTimeout(timer); }
    })();
    return cleanup;
  };
  // Registration precedes readiness so an immediate describe cannot outrun dispatch installation.
  let unsubscribe = () => {};
  unsubscribe = rpc.transport.onFailure(() => { void dispose(); });
  void ready.catch((error: unknown) => rpc.transport.close(error instanceof Error ? error : new Error(String(error))));
  rpc.onTerminalDetach(async (request) => {
    await ready;
    if (!disposed) await terminalWorker?.handle({ method: 'terminals.detach', request });
  });
  rpc.handle(async (call, signal) => {
    await ready;
    if (disposed || signal.aborted) throw new AgentCallError('not-dispatched', 'Worker session retired or request cancelled');
    if (call.method === 'node.describe') return { info, integrations: [...integrations.values()].map(manifest) };
    if (isGitRpcMethod(call.method)) {
      if (call.integrationId !== '') throw new AgentCallError('rejected', 'Git operations are node services');
      return required(gitWorker).handle(call as GitRpcRequest, signal);
    }
    if (call.method === 'apiProviders.discoverModels') return node.discoverApiProviderModels(call.request, { signal });
    if (call.method === 'projects.inspect') return (await node.getProjectService()).inspect(call.request, { signal });
    if (call.method === 'projects.resolveFileMentions') return (await node.getProjectService()).resolveFileMentions(call.request, { signal });
    if (call.method.startsWith('files.')) {
      if (call.integrationId !== '') throw invalidFileTransfer();
      validateFileRpcRequest(call.method, call.request);
    }
    switch (call.method) {
      case 'terminals.list': case 'terminals.create': case 'terminals.rename': case 'terminals.terminate':
      case 'terminals.attach': case 'terminals.input': case 'terminals.resize': case 'terminals.detach':
        if (call.integrationId !== '') throw new AgentCallError('rejected', 'Terminals are node services');
        return required(terminalWorker).handle(call);
      case 'files.tree': return (await node.getFilesService()).tree(call.request, { signal });
      case 'files.browse': return (await node.getFilesService()).browse(call.request, { signal });
      case 'files.list': return (await node.getFilesService()).list(call.request, { signal });
      case 'files.identity': return (await node.getFilesService()).identity(call.request, { signal });
      case 'files.revision': return (await node.getFilesService()).revision(call.request, { signal });
      case 'files.openRead': return required(fileTransfers).openRead(call.request, signal);
      case 'files.readChunk': return required(fileTransfers).readChunk(call.request, signal);
      case 'files.beginWrite': return required(fileTransfers).beginWrite(call.request, signal);
      case 'files.writeChunk': return required(fileTransfers).writeChunk(call.request, signal);
      case 'files.commitWrite': return required(fileTransfers).commitWrite(call.request, signal);
      case 'files.close': return required(fileTransfers).close(call.request);
    }
    const integration = integrations.get(call.integrationId);
    if (!integration) throw new AgentCallError('not-dispatched', 'Unknown integration', 'OPERATION_UNSUPPORTED');
    const options = { signal };
    switch (call.method) {
      case 'producers.bind': return integration.producers.bind(call.request, options);
      case 'producers.close': return integration.producers.close(call.request, options);
      case 'permissions.respond': return integration.permissions.respond(call.request, options);
      case 'execution.start': return integration.execution.start(call.request, options);
      case 'execution.resume': return integration.execution.resume(call.request, options);
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
      case 'compaction.compact': return required(integration.compaction).compact(call.request, options);
      case 'forking.fork': return required(integration.forking).fork({ ...call.request, signal });
      case 'forking.discard': return required(integration.forking).discard(call.request, signal);
      case 'steering.captureTarget': return required(integration.steering).captureTarget(call.request, options);
      case 'steering.steer': return required(integration.steering).steer(call.request, options);
      case 'endpoints.validate': return required(integration.endpoints).validate(call.request);
      case 'singleQuery.run': return required(integration.singleQuery).run({ ...call.request, signal });
      case 'history.open': {
        if (call.request.source !== 'nativeHistoryImport' && call.request.source !== 'legacyHistoryImport') {
          throw new AgentCallError('rejected', 'Unknown history source');
        }
        const history: AgentHistoryImport = required(integration[call.request.source]);
        const controller = new AbortController();
        const iterator = history.load({ ...call.request.request, signal: controller.signal })[Symbol.asyncIterator]();
        const table = readers.get(call.integrationId)!;
        const resource: HistoryReader = { iterator, controller, timer: null, reading: false };
        let ref;
        try {
          ref = table.add(resource);
        } catch (error) {
          controller.abort();
          await iterator.return?.();
          throw error;
        }
        resource.timer = setTimeout(() => {
          table.delete(ref); readerResources.delete(resource);
          controller.abort();
          void iterator.return?.().catch(() => undefined);
        }, 120_000);
        resource.timer.unref();
        readerResources.add(resource);
        return ref;
      }
      case 'history.next': {
        const resource = readers.get(call.integrationId)!.get(call.request);
        if (resource.reading) throw new AgentCallError('rejected', 'Concurrent history reads are not permitted');
        resource.reading = true;
        resource.timer?.refresh();
        const abort = () => resource.controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
          const result = await resource.iterator.next();
          return { done: result.done === true, rows: result.value ?? [] };
        } finally {
          signal.removeEventListener('abort', abort);
          resource.reading = false;
        }
      }
      case 'history.close': {
        const resource = readers.get(call.integrationId)!.take(call.request);
        readerResources.delete(resource);
        if (resource.timer) clearTimeout(resource.timer);
        resource.controller.abort();
        await resource.iterator.return?.();
        return;
      }
      case 'nativeActivity.lastActivity': return required(integration.nativeActivity).lastActivity(call.request, signal);
      case 'nativeSessions.resolveNativeSession': return required(integration.nativeSessions).resolveNativeSession({ ...call.request, signal });
      case 'nativeSessions.describeSource': return required(integration.nativeSessions).describeSource({ ...call.request, signal });
      case 'nativeSessions.release': return required(integration.nativeSessions).release({ ...call.request, signal });
      case 'configurationValidation.validate': return required(integration.configurationValidation).validate(call.request);
      case 'sessionConfiguration.apply': return required(integration.sessionConfiguration).apply(...call.request.args);
      case 'projectPathUpdates.prepare': return required(integration.projectPathUpdates).prepare(call.request, options);
      case 'projectPathUpdates.commit': return required(integration.projectPathUpdates).commit(call.request, options);
      case 'projectPathUpdates.rollback': return required(integration.projectPathUpdates).rollback(call.request, options);
      case 'credentials.resolve': throw new AgentCallError('rejected', 'Credential resolution is controller-owned');
      default: return unknownMethod(call);
    }
  });
  return { ready, dispose };
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
  throw new AgentCallError('not-dispatched', `Unknown execution-node RPC method: ${(call as AgentRpcRequest).method}`, 'OPERATION_UNSUPPORTED');
}
