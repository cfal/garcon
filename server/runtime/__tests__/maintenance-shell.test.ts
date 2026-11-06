import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAgentResourceRef, type AgentRunEndedEvent } from '@garcon/server-agent-interface';
import { defaultAgentIntegrations } from '../agents/default-agent-integrations.js';
import { IntegrationHostFactory } from '../agents/integration-host.js';
import { IntegrationRegistry } from '../agents/integration-registry.js';
import { RuntimeMaintenance } from '../maintenance.js';

for (const command of ['exit 3', 'kill -9 $$']) {
  test.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(`real Shell exit evidence gates maintenance: ${command}`, async () => {
    const temporary = join(homedir(), 'tmp'); await mkdir(temporary, { recursive: true });
    const root = await mkdtemp(join(temporary, 'maintenance-shell-'));
    const registry = new IntegrationRegistry({ integrations: defaultAgentIntegrations.filter(integration => integration.integrationId === 'shell'),
      hostFactory: new IntegrationHostFactory({ workspaceDir: root, resolveCredential: async () => null }) });
    const guard = new RuntimeMaintenance(); const integration = guard.integration(registry.require('shell'));
    try {
      const ended = Promise.withResolvers<AgentRunEndedEvent>();
      integration.producers.subscribe(({ event }) => { if (event.type === 'run-ended') ended.resolve(event); });
      const producerBinding = createAgentResourceRef(integration.producers.scope, 'producer');
      await integration.producers.bind({ binding: producerBinding, chatId: '1000000000000000' });
      await integration.execution.start({ chatId: '1000000000000000', projectPath: root, model: 'sh', permissionMode: 'default',
        thinkingMode: 'none', settings: integration.settings.defaults(), endpoint: null, runId: 'synthetic-run', producerBinding,
        prompt: `printf '%s' "$$" > pid; while [ ! -f release ]; do sleep 0.01; done; ${command}`, attachments: [], carriedContext: null });
      const deadline = Date.now() + 5000;
      while (!await Bun.file(join(root, 'pid')).exists() && Date.now() < deadline) await Bun.sleep(10);
      const pid = Number(await readFile(join(root, 'pid'), 'utf8'));
      expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid, 0)).not.toThrow();
      const remove = () => guard.remove([integration], () => () => {}, async () => 'removed');
      await expect(remove()).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
      await writeFile(join(root, 'release'), '');
      const terminal = await ended.promise;
      expect(() => process.kill(pid, 0)).toThrow();
      if (command === 'exit 3') {
        expect(terminal.commandOutcome).toMatchObject({ outcome: 'failed', exitCode: 3, signal: null });
        expect(await remove()).toBe('removed');
      } else {
        expect(terminal.commandOutcome).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
        await expect(remove()).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
      }
    } finally { await integration.lifecycle.stop(); await rm(root, { recursive: true, force: true }); }
  }, 15_000);
}
