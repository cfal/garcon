import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAgentIntegrationConformance } from '@garcon/server-agent-interface/testing';
import { defaultAgentIntegrations } from '../../runtime/agents/default-agent-integrations.js';
import { ExecutionRuntime } from '../../runtime/execution-runtime.js';
import { descriptorPathsDirectory } from '../../runtime/files/directory-creation.js';
import { runtimeAdapter, RUNTIME_BACKENDS } from './runtime-adapter.js';
import { linkOptions } from './integration-fixture.js';

for (const backend of RUNTIME_BACKENDS) {
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
    let adapter: Awaited<ReturnType<typeof runtimeAdapter>> | null = null;
    try {
      adapter = await runtimeAdapter(local, backend);
      const { executor } = adapter;
      const info = await executor.getInfo();
      expect(info.integrationIds).toHaveLength(defaultAgentIntegrations.length);
      expect(info.services).toEqual({ files: true, git: true, gh: true, terminals: true, directoryCreation: descriptorPathsDirectory() !== null });
      for (const integrationClass of defaultAgentIntegrations) {
        const integration = await executor.getAgentIntegration(integrationClass.integrationId);
        const native = await local.getAgentIntegration(integrationClass.integrationId);
        expect(integration.literalExecution).toEqual(native.literalExecution);
        expect(integration.readiness === null).toBe(native.readiness === null);
        if (integrationClass.integrationId === 'shell') {
          const request = { nextProjectPath: workspaceDir, chat: {
            chatId: '1783725900000000', agentId: 'shell', agentSessionId: null, projectPath: workspaceDir,
            model: 'sh', nativeSession: null, carryOverRevision: '', nativeSeedReceipt: null,
            settings: integration.settings.defaults(),
          } };
          // A caller can abandon a preparation reply without retaining native work.
          await integration.projectPathUpdates!.prepare(request);
          expect(await integration.projectPathUpdates!.prepare(request)).toBeNull();
        }
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
      await executor.dispose();
    } finally {
      await adapter?.dispose(); await local.dispose();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }, 30_000);
}
