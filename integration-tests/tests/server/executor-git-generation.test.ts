import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`commit generation keeps repository and model executors independent (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-generation-${executionBackend}`, async fixture => {
      const { client, directAgents, dirs, executionDirs } = fixture;
      const agent = directAgents.openAi;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${agent.provider.providerId}`, {});
      const generation = {
        agentId: agent.agentId, model: agent.provider.model, thinkingMode: 'none',
        apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
        modelProtocol: agent.provider.protocol, customPrompt: 'Synthetic commit request: {{files}}\n{{diff}}',
      };
      for (const [project, contents] of [
        [dirs.project, 'Synthetic controller diff'],
        [executionDirs.project, 'Synthetic worker diff'],
      ]) {
        await initializeFixtureRepository(project);
        await writeFile(join(project, 'example.txt'), `${contents}\n`);
        await runFixtureGit(project, 'add', 'example.txt');
      }
      for (const [executorId, project, generationExecutorId, expected, excluded] of [
        [client.executorId, executionDirs.project, 'local', 'Synthetic worker diff', 'Synthetic controller diff'],
        ['local', dirs.project, client.executorId, 'Synthetic controller diff', 'Synthetic worker diff'],
      ]) {
        const held = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
        const pending = client.post<{ message: string; directoryPrefix: string }>('/api/v1/git/generate-commit-message', {
          ...generation, executorId, project, generationExecutorId, files: ['example.txt'],
        });
        const request = await held.received;
        expect(request.lastUserText).toContain(`+${expected}`);
        expect(request.lastUserText).not.toContain(excluded);
        expect(held.releaseText('feat: synthetic generated commit')).toBe(true);
        expect(await pending).toEqual({ message: 'feat: synthetic generated commit', directoryPrefix: '' });
      }
      const offline = await client.post<{ id: string }>('/api/v1/executors', {
        label: 'Synthetic offline generator', direction: 'executor-connects',
      });
      const requestsBefore = fixture.fakeProviders.openAi.requests().length;
      await expect(client.post('/api/v1/git/generate-commit-message', {
        executorId: 'local', project: dirs.project, generationExecutorId: client.executorId,
        agentId: 'synthetic-unsupported-agent', model: 'synthetic-model', files: ['example.txt'],
      })).rejects.toMatchObject({ status: 422, body: { errorCode: 'UNSUPPORTED_AGENT' } });
      await expect(client.post('/api/v1/git/generate-commit-message', {
        ...generation, executorId: 'local', project: dirs.project, generationExecutorId: offline.id, files: ['example.txt'],
      })).rejects.toMatchObject({ status: 503 });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestsBefore);
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
