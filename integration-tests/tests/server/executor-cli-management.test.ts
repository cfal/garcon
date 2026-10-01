import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutorConnection, ExecutorSnapshot } from '../../../common/executors.js';
import { discoverRuntime } from '../../../cli/discovery.js';
import { GarconClient } from '../../../cli/garcon-client.js';
import { withCliFixture, runCli } from '../../support/cli-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`executor administration and provider assignments work through the CLI (${executionBackend})`, async () => {
    await withCliFixture(`executor-cli-management-${executionBackend}`, async fixture => {
      const origin = fixture.client.executorId;
      const invoke = async (args: string[]) => {
        const result = await runCli(fixture, ['executor', ...args, '--json']);
        expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: '' });
        return JSON.parse(result.stdout);
      };
      expect((await invoke(['list'])).executors.some((entry: ExecutorSnapshot) => entry.id === origin)).toBe(true);
      if (origin !== 'local') {
        const denied = await runCli(fixture, ['executor', 'providers', '--json']);
        expect(denied).toMatchObject({ exitCode: 3, stdout: '' });
        expect(denied.stderr).toContain('CLI_ACCESS_DENIED');
        await fixture.client.patch(`/api/v1/executors/${origin}`, { allowExecutorManagement: true });
        const inherited = await fixture.client.post<{ id: string }>('/api/v1/executors', {
          label: 'Synthetic inherited address', direction: 'executor-connects',
        });
        const reveal = await runCli(fixture, ['executor', 'connection', inherited.id, '--json']);
        expect(reveal).toMatchObject({ exitCode: 3, stdout: '' });
        expect(reveal.stderr).toContain('GARCON_PUBLIC_URL');
        expect(reveal.stderr).not.toContain('controller.invalid');
        const missing = await runCli(fixture, ['executor', 'create', '--label', 'Synthetic missing address',
          '--direction', 'executor-connects', '--json']);
        expect(missing).toMatchObject({ exitCode: 3, stdout: '' });
        expect(missing.stderr).toContain('GARCON_PUBLIC_URL');
        expect(missing.stderr).not.toContain('outcome is unknown');
        expect((await invoke(['list'])).executors.some((entry: ExecutorSnapshot) => entry.label === 'Synthetic missing address')).toBe(false);
        await invoke(['delete', inherited.id]);
      }
      const { id } = await invoke(['create', '--label', 'Synthetic worker', '--direction', 'executor-connects',
        '--advertise-url', 'wss://controller.test/proxy/{executorId}?route=synthetic']);
      for (const label of ['SYNTHETIC WORKER', 'local']) {
        const duplicate = await runCli(fixture, ['executor', 'create', '--label', label, '--direction', 'executor-connects',
          '--advertise-url', 'wss://controller.test/executor/{executorId}']);
        expect(duplicate).toMatchObject({ exitCode: 3, stdout: '' });
        expect(duplicate.stderr).toContain('VALIDATION_FAILED');
        expect(duplicate.stderr).not.toContain('outcome is unknown');
      }
      expect((await invoke(['list'])).executors.filter((entry: ExecutorSnapshot) => entry.label.toLowerCase() === 'synthetic worker')).toHaveLength(1);
      const oversized = await runCli(fixture, ['executor', 'create', '--label', 'Synthetic oversized address', '--direction', 'executor-connects',
        '--advertise-url', `wss://controller.test/${'{executorId}'.repeat(150)}`]);
      expect(oversized).toMatchObject({ exitCode: 3, stdout: '' });
      expect(oversized.stderr).toContain('exceeds 4096');
      expect((await invoke(['list'])).executors.some((entry: ExecutorSnapshot) => entry.label === 'Synthetic oversized address')).toBe(false);
      expect(await invoke(['show', id])).toMatchObject({ id, availability: 'offline', allowExecutorManagement: false, allowControllerCli: false });
      const descriptor = await invoke(['connection', id]) as ExecutorConnection;
      expect(descriptor.connectionUrl).toStartWith(`wss://controller.test/proxy/${id}?route=synthetic#secret=`);
      expect(JSON.stringify(await invoke(['list']))).not.toContain('secret');
      expect(await invoke(['update', id, '--label', 'Synthetic renamed worker', '--allow-controller-cli', 'true', '--allow-executor-management', 'true']))
        .toMatchObject({ label: 'Synthetic renamed worker', allowControllerCli: true, allowExecutorManagement: true });
      expect(await invoke(['disable', id])).toMatchObject({ enabled: false });
      expect(await invoke(['enable', id])).toMatchObject({ enabled: true });
      const provider = fixture.directAgents.openAi.provider.providerId;
      expect((await invoke(['providers'])).providers.some((entry: { id: string }) => entry.id === provider)).toBe(true);
      expect(await invoke(['assign-provider', id, '--provider', provider])).toEqual({ executorId: id, providerId: provider, assigned: true });
      expect((await invoke(['providers'])).providers.find((entry: { id: string }) => entry.id === provider).executorIds).toContain(id);
      expect(await invoke(['unassign-provider', id, '--provider', provider])).toEqual({ executorId: id, providerId: provider, assigned: false });
      const { id: outbound } = await invoke(['create', '--label', 'Synthetic listener', '--direction', 'controller-connects',
        '--connection-url', `ws://127.0.0.1:9/executor#secret=${'A'.repeat(43)}`, '--no-tls', 'true']);
      const duplicateRename = await runCli(fixture, ['executor', 'update', outbound, '--label', 'SYNTHETIC RENAMED WORKER']);
      expect(duplicateRename).toMatchObject({ exitCode: 3, stdout: '' });
      expect(duplicateRename.stderr).toContain('VALIDATION_FAILED');
      expect(await invoke(['show', outbound])).toMatchObject({ label: 'Synthetic listener' });
      expect(await invoke(['show', outbound])).toMatchObject({ direction: 'controller-connects' });
      await invoke(['delete', outbound]);
      if (origin !== 'local') {
        expect(await invoke(['update', origin, '--label', 'Synthetic origin'])).toMatchObject({ label: 'Synthetic origin' });
        for (const args of [['disable', origin], ['delete', origin], ['update', origin, '--allow-executor-management', 'false']]) {
          const result = await runCli(fixture, ['executor', ...args]);
          expect(result).toMatchObject({ exitCode: 3, stdout: '' });
          expect(result.stderr).toContain('CLI_ACCESS_DENIED');
        }
        await fixture.client.patch(`/api/v1/executors/${origin}`, { allowExecutorManagement: false });
        expect((await runCli(fixture, ['executor', 'connection', id])).stderr).toContain('CLI_ACCESS_DENIED');
        expect((await runCli(fixture, ['executor', 'delete', id])).stderr).toContain('CLI_ACCESS_DENIED');
        expect((await invoke(['list'])).executors.some((entry: ExecutorSnapshot) => entry.id === id)).toBe(true);
        await fixture.client.patch(`/api/v1/executors/${origin}`, { allowExecutorManagement: true });
      }
      expect(await invoke(['delete', id])).toEqual({ id, deleted: true });
    }, { executionBackend });
  }, 60_000);

  test(`CLI onboarding inherits the controller public URL (${executionBackend})`, async () => {
    await withCliFixture(`executor-cli-public-url-${executionBackend}`, async fixture => {
      const origin = fixture.client.executorId;
      if (origin !== 'local') await fixture.client.patch(`/api/v1/executors/${origin}`, { allowExecutorManagement: true });
      const created = await runCli(fixture, ['executor', 'create', '--label', 'Synthetic inherited worker', '--direction', 'executor-connects', '--json']);
      expect(created, created.stderr).toMatchObject({ exitCode: 0, stderr: '' });
      const { id } = JSON.parse(created.stdout);
      const reveal = await runCli(fixture, ['executor', 'connection', id, '--json']);
      expect(reveal, reveal.stderr).toMatchObject({ exitCode: 0, stderr: '' });
      const connection = JSON.parse(reveal.stdout) as ExecutorConnection;
      expect(connection.connectionUrl).toStartWith(`wss://controller.test/garcon/executor/${id}#secret=`);
      const stored = JSON.parse(await readFile(join(fixture.dirs.workspace, 'executors.json'), 'utf8'));
      expect(stored.executors.find((entry: { id: string }) => entry.id === id).connection)
        .toEqual({ kind: 'executor-connects', advertisedUrl: null });
    }, { executionBackend, serverEnvironment: { GARCON_PUBLIC_URL: 'https://controller.test/garcon/' } });
  }, 60_000);
}

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`CLI management preserves active work and restart fencing (${executionBackend})`, async () => {
    await withCliFixture(`executor-cli-fences-${executionBackend}`, async fixture => {
      const origin = fixture.client.executorId;
      await fixture.client.patch(`/api/v1/executors/${origin}`, { allowExecutorManagement: true });
      const old = new GarconClient(await discoverRuntime({ configDir: fixture.executionDirs.config, runtime: 'executor' }));
      const held = fixture.fakeProviders.openAi.holdNext({ model: fixture.directAgents.openAi.provider.model });
      try {
        const chatId = fixture.newChatId();
        const turn = await fixture.client.startDirectChat({ chatId, content: 'Synthetic held management turn',
          projectPath: fixture.executionDirs.project, agent: fixture.directAgents.openAi });
        await held.received;
        const blocked = await runCli(fixture, ['executor', 'disable', origin], 'controller');
        expect(blocked).toMatchObject({ exitCode: 3, stdout: '' });
        expect(blocked.stderr).toContain('EXECUTOR_IN_USE');
        held.releaseText('Synthetic completion');
        await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
      } finally { held.releaseText('Synthetic cleanup'); }
      await fixture.crashAndRestartGarcon({ preserveExecutorWorker: true });
      await expect(old.createExecutor({ label: 'Stale', direction: 'executor-connects' })).rejects.toThrow('restarted');
      const current = await runCli(fixture, ['executor', 'show', origin, '--json']);
      expect(current, current.stderr).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(current.stdout)).toMatchObject({ allowExecutorManagement: true, allowControllerCli: true });
    }, { executionBackend });
  }, 60_000);
}
