import { AgentCallError } from '@garcon/server-agent-interface';
import { mkdir, rm } from 'node:fs/promises';
import { defaultAgentIntegrations } from '../runtime/agents/default-agent-integrations.js';
import { ExecutorRpc } from './transport/rpc.js';
import { RpcReplyJournal } from './transport/rpc-journal.js';
import { serveExecutionRuntime } from './server/executor-rpc-server.js';
import { ProducerRelay } from './server/producer-relay.js';
import { ExecutionRuntime } from '../runtime/execution-runtime.js';
import { shouldLogLinkFailure, WebSocketLink, type ExecutorListenerTls } from './transport/websocket-link.js';
import { TerminalRuntime } from '../runtime/terminals/runtime.js';
import { startCliGateway } from './server/cli-gateway.js';
import { cliGatewayRuntimeFile, executorDataDirectory } from '../../common/cli-runtime-paths.js';
import { acquireWorkspaceLease } from '../common/workspace-lease.js';
import { loadListenerSecret } from './listener-secret.js';
import { monitorEventLoopStalls } from '../common/event-loop-stalls.js';
import { reportSlowSteps } from '@garcon/server-agent-common/shared/event-loop';

export interface ExecutorWorkerOptions {
  readonly configDir: string;
  readonly projectBasePath: string;
  readonly noTls: boolean;
  readonly allowUnverifiedTls?: boolean;
  readonly connection: { readonly kind: 'dial'; readonly url: string; readonly secret: string }
    | { readonly kind: 'listen'; readonly port: number; readonly bindAddress?: string; readonly tls?: ExecutorListenerTls };
  readonly advertisedUrl?: string;
}

export async function runExecutorWorker(
  options: ExecutorWorkerOptions,
  onListening: (url: string, secret: string) => void = (url) => console.log(JSON.stringify({ type: 'executor-listening', url })),
): Promise<void> {
  delete process.env.GARCON_CONTROLLER_URL;
  const dataDir = executorDataDirectory(options.configDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lease = await acquireWorkspaceLease(dataDir, { onCompromised(error) {
    console.error('Executor storage lease was compromised:', error.message);
    process.kill(process.pid, 'SIGTERM');
  } });
  try {
    // A failed gateway startup must not leave a predecessor's runtime selectable by children.
    await rm(cliGatewayRuntimeFile(lease.workspaceDir), { force: true });
    await serveExecutorWorker(options, lease.workspaceDir, onListening);
  } finally { await lease.release(); }
}

async function serveExecutorWorker(options: ExecutorWorkerOptions, dataDir: string, onListening: (url: string, secret: string) => void): Promise<void> {
  delete process.env.GARCON_AGENT_EXECUTOR_CONFIG;
  delete process.env.GARCON_WORKSPACE_DIR;
  delete process.env.GARCON_WORKSPACE;
  delete process.env.GARCON_CLI_RUNTIME;
  process.env.GARCON_CONFIG_DIR = options.configDir;
  process.env.GARCON_RUNTIME = 'executor';
  const secret = options.connection.kind === 'dial' ? options.connection.secret : await loadListenerSecret(dataDir);
  const link = new WebSocketLink({ role: 'worker', secret,
    noTls: options.noTls, allowUnverifiedTls: options.allowUnverifiedTls });
  let serving: ReturnType<typeof serveExecutionRuntime> | null = null;
  let runtime: ExecutionRuntime | null = null;
  const relay = new ProducerRelay();
  const journal = new RpcReplyJournal();
  // A stalled worker stops answering pings, and the controller retires its link after 15 s.
  const stopStallMonitor = monitorEventLoopStalls(({ stallMs, activities, heapUsedMb }) => {
    console.warn(JSON.stringify({ type: 'executor-event-loop-stalled', stallMs, heapUsedMb, activities }));
  });
  const stopSlowStepReports = reportSlowSteps((operation, stepMs) => {
    console.warn(JSON.stringify({ type: 'executor-slow-step', operation, stepMs: Math.round(stepMs) }));
  });
  let currentRpc: ExecutorRpc | null = null;
  let gateway: Awaited<ReturnType<typeof startCliGateway>> | null = null;
  let terminals: TerminalRuntime | null = null;
  const stopped = Promise.withResolvers<void>();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    currentRpc = null;
    let failure: unknown;
    try {
      for (const dispose of [stopStallMonitor, stopSlowStepReports, () => gateway?.dispose(), () => link.dispose(), () => serving?.dispose(), () => relay.dispose(), () => journal.dispose(), () => runtime?.dispose(), () => terminals?.shutdown()]) {
        try { await dispose(); } catch (error) { failure ??= error; }
      }
      if (failure !== undefined) throw failure;
    } finally { stopped.resolve(); }
  })();
  const onSignal = () => { void stop().catch((error: unknown) => { console.error('Executor cleanup failed:', error); }); };
  try {
    gateway = await startCliGateway({ dataDir, currentRpc: () => currentRpc }).catch((error: unknown) => {
      console.warn(JSON.stringify({ type: 'executor-cli-unavailable',
        message: error instanceof Error ? error.message : 'CLI gateway could not start' }));
      return null;
    });
    terminals = new TerminalRuntime({ projectBasePath: options.projectBasePath, terminalRuntimeId: link.runtimeId });
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    link.onClosure((closure) => {
      console.warn(JSON.stringify({ type: 'executor-link-closed', ...closure }));
    });
    link.onError((failure) => {
      if (shouldLogLinkFailure(failure)) console.warn(JSON.stringify({ type: 'executor-unavailable', ...failure }));
    });
    link.onSession((transport) => {
      void serving?.dispose();
      if (runtime && transport.executorId !== runtime.id) {
        const rpc = new ExecutorRpc(transport);
        currentRpc = null;
        const retained = runtime;
        // Description lets the controller report the required restart without rebinding retained processes.
        rpc.handle(async (call) => {
          if (call.method === 'executor.describe') return { info: await retained.getInfo(), integrations: [] };
          throw new AgentCallError('not-dispatched', 'Restart the worker to serve a different executor');
        });
        return;
      }
      // Replies outlive sessions only for the controller of the executor this worker serves.
      const rpc = new ExecutorRpc(transport, { journal });
      currentRpc = rpc;
      transport.onFailure(() => { if (currentRpc === rpc) currentRpc = null; });
      runtime ??= new ExecutionRuntime({
        id: transport.executorId, workspaceDir: dataDir, projectBasePath: options.projectBasePath,
        integrations: defaultAgentIntegrations,
        terminalRuntime: terminals!,
        resolveCredential: ({ agentId, reference, signal }) => {
          if (!currentRpc) throw new AgentCallError('not-dispatched', 'Executor controller is disconnected');
          return currentRpc.call(agentId, 'credentials.resolve', { reference }, { signal });
        },
      });
      serving = serveExecutionRuntime(runtime, rpc, relay);
      transport.onAvailability((connected) => {
        if (!connected) return;
        console.log(JSON.stringify({ type: 'executor-connected', executorId: transport.executorId, runtimeId: link.runtimeId }));
      });
    });
    if (options.connection.kind === 'listen') {
      const bindAddress = options.connection.bindAddress ?? '0.0.0.0';
      const address = new URL(link.listen(options.connection.port, bindAddress, options.connection.tls));
      if (bindAddress === '0.0.0.0') address.hostname = bindAddress;
      onListening(address.href, secret);
    } else {
      link.dial(options.connection.url);
      console.log(JSON.stringify({ type: 'executor-started', direction: 'executor-connects' }));
    }
    await stopped.promise;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await stop();
  }
}
