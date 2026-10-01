import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { effectiveExecutorId } from '../../../common/executors.js';
import { withCliFixture, runCli } from '../../support/cli-fixture.js';
import { GarconTestClient } from '../../support/garcon-client.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`CLI targets catalogs, starts and native lookups independently of its origin (${executionBackend})`, async () => {
    await withCliFixture(`executor-cli-targets-${executionBackend}`, async fixture => {
      const remoteId = fixture.client.executorId;
      const agent = fixture.directAgents.openAi;
      const projectPath = join(fixture.dirs.project, 'synthetic-project ');
      await mkdir(projectPath.trimEnd());
      await mkdir(projectPath);
      const local = await GarconTestClient.connect(fixture.garcon.baseUrl, { authToken: fixture.garcon.authToken, executorId: 'local' });
      try {
        const localProvider = await local.createOpenAiProvider(fixture.fakeProviders.openAi.baseUrl);
        for (const { runtime, executorId, provider, verb } of [
          { runtime: 'controller', executorId: remoteId, provider: agent.provider, verb: 'start' },
          { runtime: 'executor', executorId: 'local', provider: localProvider, verb: 'start-async' },
        ] as const) {
          const catalog = await runCli(fixture, ['list', 'providers', '--executor', executorId, '--json'], runtime);
          expect(catalog, catalog.stderr).toMatchObject({ exitCode: 0, stderr: '' });
          const providerIds = JSON.parse(catalog.stdout).providers.map((entry: { id: string }) => entry.id);
          expect(providerIds).toContain(provider.providerId);
          expect(providerIds).not.toContain(executorId === 'local' ? agent.provider.providerId : localProvider.providerId);

          const args = [verb, '--executor', executorId, '--agent', agent.agentId, '--provider', provider.providerId,
            '--endpoint', provider.endpointId, '--model', provider.model, '--json', 'Synthetic targeted task'];
          for (const cwd of [[], ['--cwd', 'relative-project']]) {
            const denied = await runCli(fixture, [...args, ...cwd], runtime);
            expect(denied).toMatchObject({ exitCode: 2, stdout: '' });
            expect(denied.stderr).toContain('explicit absolute --cwd');
          }
          // Identical path strings must not collapse distinct executor identities.
          const started = await runCli(fixture, [...args, '--cwd', projectPath], runtime);
          expect(started, started.stderr).toMatchObject({ exitCode: 0, stderr: '' });
          const receipt = JSON.parse(started.stdout).receipt;
          await fixture.client.waitForTurnTerminal(receipt.chatId, receipt.turnId);
          const snapshot = await fixture.client.getChatSnapshot(receipt.chatId);
          expect(effectiveExecutorId(snapshot.chat.executorId)).toBe(executorId);
          expect(snapshot.chat.projectPath).toBe(projectPath);
          const binding = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId: receipt.chatId, agentId: agent.agentId });
          const lookup = await runCli(fixture, ['lookup-native-session', binding.agentSessionId!, '--executor', executorId], runtime);
          expect(lookup).toEqual({ exitCode: 0, stdout: `${receipt.chatId}\n`, stderr: '' });
          const wrongTarget = await runCli(fixture, ['lookup-native-session', binding.agentSessionId!, '--executor', executorId === 'local' ? remoteId : 'local'], runtime);
          expect(wrongTarget).toMatchObject({ exitCode: 2, stdout: '' });
          expect(wrongTarget.stderr).toContain('NATIVE_SESSION_NOT_FOUND');
          const resumed = await runCli(fixture, ['resume', receipt.chatId, '--model', provider.model, 'Synthetic owned continuation'], runtime);
          expect(resumed, resumed.stderr).toMatchObject({ exitCode: 0, stderr: '' });
          expect(effectiveExecutorId((await fixture.client.getChatSnapshot(receipt.chatId)).chat.executorId)).toBe(executorId);
        }

        const offline = await fixture.client.post<{ id: string }>('/api/v1/executors', {
          label: 'Synthetic offline target', direction: 'executor-connects',
        });
        const before = (await fixture.client.listChats()).sessions.length;
        for (const id of [offline.id, '11111111-1111-4111-8111-111111111111']) {
          for (const runtime of ['controller', 'executor'] as const) {
            for (const args of [['list', 'agents', '--json'], ['start-async', '--cwd', fixture.dirs.project,
              '--agent', agent.agentId, '--model', agent.provider.model, 'Synthetic unavailable target']]) {
              const result = await runCli(fixture, [...args, '--executor', id], runtime);
              expect(result.exitCode, result.stderr).not.toBe(0);
              expect(result.stdout).toBe('');
              expect(result.stderr).toMatch(/EXECUTOR_(UNAVAILABLE|NOT_FOUND)/u);
            }
          }
        }
        expect((await fixture.client.listChats()).sessions.length).toBe(before);
      } finally { await local.close(); }
    }, { executionBackend, projectRoots: 'shared' });
  }, 60_000);
}
