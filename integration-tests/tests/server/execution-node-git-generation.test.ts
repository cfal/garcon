import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

for (const executionBackend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`commit generation keeps repository and model nodes independent (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-generation-${executionBackend}`, async fixture => {
      const { client, directAgents, dirs, executionDirs } = fixture;
      const agent = directAgents.openAi;
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
      for (const [nodeId, project, generationNodeId, expected, excluded] of [
        [client.nodeId, executionDirs.project, 'local', 'Synthetic worker diff', 'Synthetic controller diff'],
        ['local', dirs.project, client.nodeId, 'Synthetic controller diff', 'Synthetic worker diff'],
      ]) {
        const held = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
        const pending = client.post<{ message: string }>('/api/v1/git/generate-commit-message', {
          ...generation, nodeId, project, generationNodeId, files: ['example.txt'],
        });
        const request = await held.received;
        expect(request.lastUserText).toContain(`+${expected}`);
        expect(request.lastUserText).not.toContain(excluded);
        expect(held.releaseText('feat: synthetic generated commit')).toBe(true);
        expect(await pending).toEqual({ message: 'feat: synthetic generated commit', directoryPrefix: '' });
      }
      const offline = await client.post<{ id: string }>('/api/v1/execution-nodes', {
        label: 'Synthetic offline generator', direction: 'node-connects',
      });
      const requestsBefore = fixture.fakeProviders.openAi.requests().length;
      await expect(client.post('/api/v1/git/generate-commit-message', {
        ...generation, nodeId: 'local', project: dirs.project, generationNodeId: offline.id, files: ['example.txt'],
      })).rejects.toMatchObject({ status: 503 });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestsBefore);
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
