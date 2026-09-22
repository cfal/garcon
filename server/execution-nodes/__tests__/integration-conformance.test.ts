import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAgentIntegrationConformance } from '@garcon/server-agent-interface/testing';
import { defaultAgentIntegrations } from '../../agents/default-agent-integrations.js';
import { InProcessExecutionNode } from '../in-process.js';
import { RemoteExecutionNode } from '../remote.js';
import { WebSocketLink } from '../websocket-link.js';
import { AgentRpc } from '../rpc.js';
import { serveAgentNode } from '../agent-worker.js';
import { linkOptions } from './integration-fixture.js';

for (const backend of ['local', 'controller', 'worker'] as const) {
  test(`every shipped integration conforms through ${backend}`, async () => {
    const temporary = join(homedir(), 'tmp');
    await mkdir(temporary, { recursive: true });
    const workspaceDir = await mkdtemp(join(temporary, 'node-conformance-'));
    const local = new InProcessExecutionNode({
      id: linkOptions.nodeId, workspaceDir, integrations: defaultAgentIntegrations,
      projectBasePath: workspaceDir,
      resolveCredential: async () => null, readEnvironment: () => undefined,
      loggerFactory: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    });
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    let serving: ReturnType<typeof serveAgentNode> | null = null;
    try {
      worker.onSession((transport) => { serving = serveAgentNode(local, new AgentRpc(transport)); });
      const connected = backend === 'local' ? null : RemoteExecutionNode.connect(controller);
      if (backend === 'controller') controller.dial(worker.listen());
      if (backend === 'worker') worker.dial(controller.listen());
      const node = connected ? await connected : local;
      const info = await node.getInfo();
      expect(info.integrationIds).toHaveLength(defaultAgentIntegrations.length);
      for (const integrationClass of defaultAgentIntegrations) {
        const integration = await node.getAgentIntegration(integrationClass.integrationId);
        await runAgentIntegrationConformance({ integrationClass, integration });
        expect(await node.getAgentIntegration(integrationClass.integrationId)).toBe(integration);
      }
      expect((await node.getFilesService()).read).toBeFunction();
      expect(info.services.terminals).toBe(true);
      const terminals = await node.getTerminalService();
      expect(await terminals.list({ key: 'synthetic-principal', expiresAtMs: null })).toMatchObject({
        success: true, terminalRuntimeId: expect.any(String), attachmentEpoch: expect.any(String), terminals: [],
      });
      for (const service of [node.getProcessService, node.getGitService]) {
        await expect(service.call(node)).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', outcome: 'not-dispatched' });
      }
      await node.dispose();
    } finally {
      await controller.dispose(); await worker.dispose();
      await serving?.dispose(); await local.dispose();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }, 30_000);
}
