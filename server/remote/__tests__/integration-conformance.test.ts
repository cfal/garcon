import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAgentIntegrationConformance } from '@garcon/server-agent-interface/testing';
import { defaultAgentIntegrations } from '../../runtime/agents/default-agent-integrations.js';
import { ExecutionRuntime } from '../../runtime/execution-runtime.js';
import { RemoteExecutorClient } from '../client/executor-client.js';
import { WebSocketLink } from '../transport/websocket-link.js';
import { ExecutorRpc } from '../transport/rpc.js';
import { serveExecutionRuntime } from '../server/executor-rpc-server.js';
import { linkOptions } from './integration-fixture.js';

for (const backend of ['local', 'controller', 'worker'] as const) {
  test(`every shipped integration conforms through ${backend}`, async () => {
    const temporary = join(homedir(), 'tmp');
    await mkdir(temporary, { recursive: true });
    const workspaceDir = await mkdtemp(join(temporary, 'executor-conformance-'));
    const local = new ExecutionRuntime({
      id: linkOptions.executorId, workspaceDir, integrations: defaultAgentIntegrations,
      projectBasePath: workspaceDir,
      resolveCredential: async () => null, readEnvironment: () => undefined,
      loggerFactory: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    });
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    let serving: ReturnType<typeof serveExecutionRuntime> | null = null;
    try {
      worker.onSession((transport) => { serving = serveExecutionRuntime(local, new ExecutorRpc(transport)); });
      const connected = backend === 'local' ? null : RemoteExecutorClient.connect(controller);
      if (backend === 'controller') controller.dial(worker.listen());
      if (backend === 'worker') worker.dial(controller.listen());
      const executor = connected ? await connected : local;
      const info = await executor.getInfo();
      expect(info.integrationIds).toHaveLength(defaultAgentIntegrations.length);
      for (const integrationClass of defaultAgentIntegrations) {
        const integration = await executor.getAgentIntegration(integrationClass.integrationId);
        await runAgentIntegrationConformance({ integrationClass, integration });
        expect(await executor.getAgentIntegration(integrationClass.integrationId)).toBe(integration);
      }
      expect((await executor.getFilesService()).read).toBeFunction();
      expect(info.services.terminals).toBe(true);
      const terminals = await executor.getTerminalService();
      expect(await terminals.list({ key: 'synthetic-principal', expiresAtMs: null })).toMatchObject({
        success: true, terminalRuntimeId: expect.any(String), attachmentEpoch: expect.any(String), terminals: [],
      });
      expect((await executor.getGitService()).getStatus).toBeFunction();
      expect((await executor.getGhService()).getStatus).toBeFunction();
      for (const service of [executor.getProcessService]) {
        await expect(service.call(executor)).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', outcome: 'not-dispatched' });
      }
      await executor.dispose();
    } finally {
      await controller.dispose(); await worker.dispose();
      await serving?.dispose(); await local.dispose();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }, 30_000);
}
