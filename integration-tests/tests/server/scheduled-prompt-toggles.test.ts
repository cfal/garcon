import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScheduledPromptsMutationResponse } from '../../../common/scheduled-prompts.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test('persists scheduled prompt pauses across controller restart (' + executionBackend + ')', async () => {
    await withIntegrationFixture('scheduled-prompt-toggles-' + executionBackend, async fixture => {
      const { client } = fixture;
      const agent = fixture.directAgents.openAi;
      const firstRunAtUtc = new Date(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000).toISOString();
      const created = await client.createScheduledPrompt({ expectedRevision: 0, scheduledPrompt: {
        schedule: { type: 'recurring', firstRunAtUtc, intervalMinutes: 60, endAtUtc: null },
        target: {
          type: 'new-chat', executorId: client.executorId, agentId: agent.agentId,
          projectPath: fixture.executionDirs.project, model: agent.provider.model,
          apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
          modelProtocol: agent.provider.protocol, permissionMode: 'default', thinkingMode: 'none',
          agentSettingsById: { [agent.agentId]: agent.agentSettings }, tags: [], preambleChoice: { mode: 'defaults' },
        },
        prompt: 'Synthetic scheduled review',
      } });
      const prompt = created.snapshot.prompts[0]!;
      expect(prompt.enabled).toBe(true);
      const paused = await client.put<ScheduledPromptsMutationResponse>('/api/v1/scheduled-prompts/enabled', {
        expectedRevision: created.snapshot.revision, id: prompt.id, enabled: false,
      });
      expect(paused.snapshot.prompts[0]?.enabled).toBe(false);
      const filePath = join(fixture.dirs.workspace, 'scheduled-prompts.json');
      expect(JSON.parse(await readFile(filePath, 'utf8')).prompts[0].enabled).toBe(false);
      await fixture.restartGarcon({ beforeStart: async () => {
        const file = JSON.parse(await readFile(filePath, 'utf8'));
        file.prompts[0].schedule.nextRunAt = '2020-01-01T09:00:00.000Z';
        await writeFile(filePath, JSON.stringify(file));
      } });
      const restarted = await fixture.client.getScheduledPrompts();
      expect(restarted.prompts[0]).toMatchObject({ enabled: false, schedule: { nextRunAt: '2020-01-01T09:00:00.000Z' } });
      expect(restarted.runLog).toEqual([]);
      const resumed = await fixture.client.put<ScheduledPromptsMutationResponse>('/api/v1/scheduled-prompts/enabled', {
        expectedRevision: restarted.revision, id: prompt.id, enabled: true,
      });
      expect(resumed.snapshot.prompts[0]?.enabled).toBe(true);
      const nextRun = Date.parse(resumed.snapshot.prompts[0]!.schedule.nextRunAt);
      expect(nextRun).toBeGreaterThan(Date.now());
      expect((nextRun - Date.parse('2020-01-01T09:00:00.000Z')) % 3_600_000).toBe(0);
      expect(resumed.snapshot.runLog).toEqual([]);
    }, { executionBackend });
  }, 120_000);
}
