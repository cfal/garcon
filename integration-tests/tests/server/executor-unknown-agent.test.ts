import { expect, test } from 'bun:test';
import type { SlashCommandsResponse } from '../../../common/slash-commands.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`unknown-agent discovery preserves client responses (${executionBackend})`, async () => {
    await withIntegrationFixture(`unknown-agent-${executionBackend}`, async ({ client, dirs, executionDirs }) => {
      for (const [executorId, projectPath] of [['local', dirs.project], [client.executorId, executionDirs.project]] as const) {
        const query = new URLSearchParams({ executorId, projectPath, agent: 'unknown-agent' });
        await expect(client.get(`/api/v1/agents/auth?${query}`)).rejects.toMatchObject({
          status: 400, body: { error: 'Unknown agent: unknown-agent' },
        });
        expect(await client.get<SlashCommandsResponse>(`/api/v1/commands?${query}`)).toEqual({ commands: [] });
      }
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      const query = new URLSearchParams({
        executorId: client.executorId, projectPath: executionDirs.project, agent: 'unknown-agent',
      });
      for (const path of ['agents/auth', 'commands']) {
        await expect(client.get(`/api/v1/${path}?${query}`)).rejects.toMatchObject({
          status: 503, body: { errorCode: 'EXECUTOR_UNAVAILABLE' },
        });
      }
    }, { executionBackend });
  }, 30_000);
}
