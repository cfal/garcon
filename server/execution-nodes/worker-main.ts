import { defaultAgentIntegrations } from '../agents/default-agent-integrations.js';
import { InProcessExecutionNode } from './in-process.js';
import { AgentRpc } from './rpc.js';
import { serveAgentNode } from './agent-worker.js';
import { WebSocketLink } from './websocket-link.js';
import { readExecutionNodeConfig } from './config.js';
import { join } from 'node:path';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: bun server/execution-nodes/worker-main.ts <private-config.json>');
const config = await readExecutionNodeConfig(configPath);
// Provider children must not discover a controller-local runtime through inherited settings.
delete process.env.GARCON_AGENT_EXECUTION_NODE_CONFIG;
delete process.env.GARCON_WORKSPACE_DIR;
process.env.GARCON_WORKSPACE = 'execution-node-unavailable';
process.env.GARCON_CONFIG_DIR = join(config.workspaceDir, 'cli-unavailable');
const link = new WebSocketLink({ ...config, role: 'worker' });
let serving: ReturnType<typeof serveAgentNode> | null = null;
link.onSession((transport) => {
  void serving?.dispose();
  const rpc = new AgentRpc(transport);
  const node = new InProcessExecutionNode({
    id: config.nodeId, workspaceDir: config.workspaceDir,
    projectBasePath: config.projectBasePath,
    integrations: defaultAgentIntegrations,
    resolveCredential: ({ agentId, reference, signal }) => rpc.call(agentId, 'credentials.resolve', { reference }, { signal }),
  });
  serving = serveAgentNode(node, rpc);
});
if (config.connection.kind === 'listen') {
  console.log(JSON.stringify({ type: 'execution-node-listening', url: link.listen(config.connection.port) }));
} else link.dial(config.connection.url);
await link.ready;
console.log(JSON.stringify({ type: 'execution-node-ready', nodeId: config.nodeId, runtimeId: link.runtimeId }));
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await link.dispose();
  await serving?.dispose();
};
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
