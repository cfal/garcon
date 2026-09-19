import { join } from 'node:path';
import { defaultAgentIntegrations } from '../agents/default-agent-integrations.js';
import { AgentRpc } from './rpc.js';
import { serveAgentNode } from './agent-worker.js';
import { InProcessExecutionNode } from './in-process.js';
import { WebSocketLink } from './websocket-link.js';

export interface ExecutionWorkerOptions {
  readonly secret: string;
  readonly workspaceDir: string;
  readonly projectBasePath: string;
  readonly allowInsecureDevelopment: boolean;
  readonly connection: { readonly kind: 'dial'; readonly url: string } | { readonly kind: 'listen'; readonly port: number };
  readonly advertisedUrl?: string;
}

export async function runExecutionWorker(
  options: ExecutionWorkerOptions,
  onListening: (url: string) => void = (url) => console.log(JSON.stringify({ type: 'execution-node-listening', url })),
): Promise<void> {
  delete process.env.GARCON_AGENT_EXECUTION_NODE_CONFIG;
  delete process.env.GARCON_WORKSPACE_DIR;
  process.env.GARCON_WORKSPACE = 'execution-node-unavailable';
  process.env.GARCON_CONFIG_DIR = join(options.workspaceDir, 'cli-unavailable');
  const link = new WebSocketLink({ role: 'worker', secret: options.secret, allowInsecureDevelopment: options.allowInsecureDevelopment });
  let serving: ReturnType<typeof serveAgentNode> | null = null;
  const stopped = Promise.withResolvers<void>();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await link.dispose();
      await serving?.dispose();
    } finally { stopped.resolve(); }
  };
  const onSignal = () => { void stop(); };
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
    const node = new InProcessExecutionNode({
      id: transport.nodeId, workspaceDir: options.workspaceDir, projectBasePath: options.projectBasePath,
      integrations: defaultAgentIntegrations,
      resolveCredential: ({ agentId, reference, signal }) => rpc.call(agentId, 'credentials.resolve', { reference }, { signal }),
    });
    serving = serveAgentNode(node, rpc);
    transport.onAvailability((connected) => {
      if (!connected) return;
      lastError = null;
      console.log(JSON.stringify({ type: 'execution-node-ready', nodeId: transport.nodeId, runtimeId: link.runtimeId }));
    });
  });
  try {
    if (options.connection.kind === 'listen') {
      const address = new URL(link.listen(options.connection.port));
      address.hostname = '0.0.0.0';
      onListening(address.href);
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
