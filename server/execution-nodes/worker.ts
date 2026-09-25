import { AgentCallError } from '@garcon/server-agent-interface';
import { mkdir, rm } from 'node:fs/promises';
import { defaultAgentIntegrations } from '../agents/default-agent-integrations.js';
import { AgentRpc } from './rpc.js';
import { serveAgentNode } from './agent-worker.js';
import { InProcessExecutionNode } from './in-process.js';
import { WebSocketLink } from './websocket-link.js';
import { TerminalRuntime } from '../terminals/node-service.js';
import { startCliGateway } from './cli-gateway.js';
import { cliGatewayRuntimeFile, executionNodeDataDirectory } from '../../common/cli-runtime-paths.js';
import { acquireWorkspaceLease } from '../lib/workspace-lease.js';
import { loadListenerSecret } from './listener-secret.js';

export interface ExecutionWorkerOptions {
  readonly configDir: string;
  readonly projectBasePath: string;
  readonly allowInsecureDevelopment: boolean;
  readonly allowUnverifiedTls?: boolean;
  readonly connection: { readonly kind: 'dial'; readonly url: string; readonly secret: string }
    | { readonly kind: 'listen'; readonly port: number; readonly bindAddress?: string };
  readonly advertisedUrl?: string;
}

export async function runExecutionWorker(
  options: ExecutionWorkerOptions,
  onListening: (url: string, secret: string) => void = (url) => console.log(JSON.stringify({ type: 'execution-node-listening', url })),
): Promise<void> {
  const dataDir = executionNodeDataDirectory(options.configDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lease = await acquireWorkspaceLease(dataDir, { onCompromised(error) {
    console.error('Execution-node storage lease was compromised:', error.message);
    process.kill(process.pid, 'SIGTERM');
  } });
  try {
    // A failed gateway startup must not leave a predecessor's runtime selectable by children.
    await rm(cliGatewayRuntimeFile(lease.workspaceDir), { force: true });
    await serveExecutionWorker(options, lease.workspaceDir, onListening);
  } finally { await lease.release(); }
}

async function serveExecutionWorker(options: ExecutionWorkerOptions, dataDir: string, onListening: (url: string, secret: string) => void): Promise<void> {
  delete process.env.GARCON_AGENT_EXECUTION_NODE_CONFIG;
  delete process.env.GARCON_WORKSPACE_DIR;
  delete process.env.GARCON_WORKSPACE;
  delete process.env.GARCON_CLI_RUNTIME;
  process.env.GARCON_CONFIG_DIR = options.configDir;
  process.env.GARCON_RUNTIME = 'execution-node';
  const secret = options.connection.kind === 'dial' ? options.connection.secret : await loadListenerSecret(dataDir);
  const link = new WebSocketLink({ role: 'worker', secret,
    allowInsecureDevelopment: options.allowInsecureDevelopment, allowUnverifiedTls: options.allowUnverifiedTls });
  let serving: ReturnType<typeof serveAgentNode> | null = null;
  let node: InProcessExecutionNode | null = null;
  let currentRpc: AgentRpc | null = null;
  let gateway: Awaited<ReturnType<typeof startCliGateway>> | null = null;
  let terminals: TerminalRuntime | null = null;
  const stopped = Promise.withResolvers<void>();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    currentRpc = null;
    let failure: unknown;
    try {
      for (const dispose of [() => gateway?.dispose(), () => link.dispose(), () => serving?.dispose(), () => node?.dispose(), () => terminals?.shutdown()]) {
        try { await dispose(); } catch (error) { failure ??= error; }
      }
      if (failure !== undefined) throw failure;
    } finally { stopped.resolve(); }
  })();
  const onSignal = () => { void stop().catch((error: unknown) => { console.error('Execution-node cleanup failed:', error); }); };
  try {
    gateway = await startCliGateway({ dataDir, currentRpc: () => currentRpc }).catch((error: unknown) => {
      console.warn(JSON.stringify({ type: 'execution-node-cli-unavailable',
        message: error instanceof Error ? error.message : 'CLI gateway could not start' }));
      return null;
    });
    terminals = new TerminalRuntime({ projectBasePath: options.projectBasePath, terminalRuntimeId: link.runtimeId });
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    let lastError: string | null = null;
    link.onError((message) => {
      if (message !== lastError) console.warn(JSON.stringify({ type: 'execution-node-unavailable', message }));
      lastError = message;
    });
    link.onSession((transport) => {
      void serving?.dispose();
      const rpc = new AgentRpc(transport);
      if (node && transport.nodeId !== node.id) {
        currentRpc = null;
        const retained = node;
        // Description lets the controller report the required restart without rebinding retained processes.
        rpc.handle(async (call) => {
          if (call.method === 'node.describe') return { info: await retained.getInfo(), integrations: [] };
          throw new AgentCallError('not-dispatched', 'Restart the worker to serve a different execution node');
        });
        return;
      }
      currentRpc = rpc;
      transport.onFailure(() => { if (currentRpc === rpc) currentRpc = null; });
      node ??= new InProcessExecutionNode({
        id: transport.nodeId, workspaceDir: dataDir, projectBasePath: options.projectBasePath,
        integrations: defaultAgentIntegrations,
        terminalRuntime: terminals!,
        resolveCredential: ({ agentId, reference, signal }) => {
          if (!currentRpc) throw new AgentCallError('not-dispatched', 'Execution-node controller is disconnected');
          return currentRpc.call(agentId, 'credentials.resolve', { reference }, { signal });
        },
      });
      serving = serveAgentNode(node, rpc);
      transport.onAvailability((connected) => {
        if (!connected) return;
        lastError = null;
        console.log(JSON.stringify({ type: 'execution-node-connected', nodeId: transport.nodeId, runtimeId: link.runtimeId }));
      });
    });
    if (options.connection.kind === 'listen') {
      const bindAddress = options.connection.bindAddress ?? '0.0.0.0';
      const address = new URL(link.listen(options.connection.port, bindAddress));
      if (bindAddress === '0.0.0.0') address.hostname = bindAddress;
      onListening(address.href, secret);
    } else {
      link.dial(options.connection.url);
      console.log(JSON.stringify({ type: 'execution-node-started', direction: 'node-connects' }));
    }
    await stopped.promise;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await stop();
  }
}
