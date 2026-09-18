import { AgentCallError, type ExecutionNode } from '@garcon/server-agent-interface';
import { InProcessExecutionNode } from './in-process.js';
import { RemoteExecutionNode } from './remote.js';
import { WebSocketLink } from './websocket-link.js';
import { readExecutionNodeConfig } from './config.js';
import { IntegrationRegistry } from '../agents/integration-registry.js';

export async function createControllerExecutionServices(
  options: ConstructorParameters<typeof InProcessExecutionNode>[0],
) {
  const node = await createControllerExecutionNode(options);
  try {
    const info = await node.getInfo();
    const projects = await node.getProjectService();
    const integrations = new IntegrationRegistry({
      instances: await Promise.all(info.integrationIds.map((id) => node.getAgentIntegration(id))),
    });
    return {
      node, integrations, projects, projectBasePath: info.projectBasePath,
      localMachineServices: !process.env.GARCON_AGENT_EXECUTION_NODE_CONFIG,
      inspectProject: async (projectPath: string) => (await projects.inspect({ projectPath })).resolution,
      resolveFileMentions: (command: string, projectPath: string) => projects.resolveFileMentions({ command, projectPath }),
    };
  } catch (error) {
    await node.dispose();
    throw error;
  }
}

async function createControllerExecutionNode(
  options: ConstructorParameters<typeof InProcessExecutionNode>[0],
): Promise<ExecutionNode> {
  const configPath = process.env.GARCON_AGENT_EXECUTION_NODE_CONFIG;
  if (!configPath) return new InProcessExecutionNode(options);
  const config = await readExecutionNodeConfig(configPath);
  const link = new WebSocketLink({ ...config, role: 'controller' });
  try {
    if (config.connection.kind === 'listen') {
      console.log(`Execution node listening at ${link.listen(config.connection.port)}`);
    } else link.dial(config.connection.url);
    return await RemoteExecutionNode.connect(link, (rpc) => rpc.handle(async (call, signal) => {
      if (call.method !== 'credentials.resolve'
        || !options.integrations.some((integration) => integration.integrationId === call.integrationId)) {
        throw new AgentCallError('rejected', 'Operation is not permitted on the controller');
      }
      return options.resolveCredential({ agentId: call.integrationId, reference: call.request.reference, signal });
    }));
  } catch (error) {
    await link.dispose();
    throw error;
  }
}
