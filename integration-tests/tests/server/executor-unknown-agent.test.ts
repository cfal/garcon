import { expect, test } from 'bun:test';
import type { SlashCommandsResponse } from '../../../common/slash-commands.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`unknown-agent discovery preserves client responses (${executionBackend})`, async () => {
    await withIntegrationFixture(`unknown-agent-${executionBackend}`, async ({ client, dirs, executionDirs }) => {
      for (const [executorId, projectPath] of [['local', dirs.project], [client.executorId, executionDirs.project]] as const) {
        const query = new URLSearchParams({ executorId, projectPath, agent: 'unknown-agent' });
        expect(await rejectionOf(client.get(`/api/v1/agents/auth?${query}`))).toMatchObject({
          status: 400, body: { error: 'Unknown agent: unknown-agent' },
        });
        expect(await client.get<SlashCommandsResponse>(`/api/v1/commands?${query}`)).toEqual({ commands: [] });
      }
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      const query = new URLSearchParams({
        executorId: client.executorId, projectPath: executionDirs.project, agent: 'unknown-agent',
      });
      for (const path of ['agents/auth', 'commands']) {
        expect(await rejectionOf(client.get(`/api/v1/${path}?${query}`))).toMatchObject({
          status: 503, body: { errorCode: 'EXECUTOR_UNAVAILABLE' },
        });
      }
    }, { executionBackend });
  }, 30_000);
}

test('starts on never-connected or unknown executors report executor unavailability', async () => {
  await withIntegrationFixture('unready-executor-start', async (fixture) => {
    const { client, directAgents, dirs } = fixture;
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const neverConnected = await client.post<{ id: string }>('/api/v1/executors', {
      label: 'Synthetic unreachable worker', direction: 'controller-connects',
      connectionUrl: `ws://127.0.0.1:9/executor#secret=${secret}`, noTls: true,
    });
    for (const executorId of [neverConnected.id, crypto.randomUUID()]) {
      expect(await rejectionOf(client.startChat(client.directStartRequest({
        chatId: fixture.newChatId(), agent: directAgents.openAi, projectPath: dirs.project,
        content: 'Synthetic start before the executor connects', executorId,
      })))).toMatchObject({
        status: 503, body: { errorCode: 'EXECUTOR_UNAVAILABLE', retryable: true },
      });
    }
    expect(fixture.fakeProviders.openAi.requests()).toEqual([]);
  }, { executionBackend: 'in-process' });
}, 30_000);
