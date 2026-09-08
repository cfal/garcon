import { describe, expect, test } from "bun:test";
import { withIntegrationFixture } from "../../support/integration-fixture.js";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

describe("scheduled prompt minute recurrence", () => {
  test.each([5, 90, 360])("persists a %i-minute cadence through HTTP, edits, and restart", async (intervalMinutes) => {
    await withIntegrationFixture("scheduled-prompt-minute-recurrence", async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const initial = await fixture.client.getScheduledPrompts();
      const firstRunAtUtc = new Date(
        Math.floor((Date.now() + HOUR_MS) / MINUTE_MS) * MINUTE_MS,
      ).toISOString();

      const created = await fixture.client.createScheduledPrompt({
        expectedRevision: initial.revision,
        scheduledPrompt: {
          schedule: {
            type: "recurring",
            firstRunAtUtc,
            intervalMinutes,
            endAtUtc: null,
          },
          target: {
            type: "new-chat",
            agentId: agent.agentId,
            projectPath: fixture.dirs.project,
            model: agent.provider.model,
            apiProviderId: agent.provider.providerId,
            modelEndpointId: agent.provider.endpointId,
            modelProtocol: agent.provider.protocol,
            permissionMode: "default",
            thinkingMode: "none",
            agentSettingsById: { [agent.agentId]: agent.agentSettings },
            tags: [],
          },
          prompt: "Continue the work",
        },
      });

      expect(created.snapshot.prompts).toHaveLength(1);
      expect(created.snapshot.prompts[0]?.schedule).toEqual({
        type: "recurring",
        intervalMinutes,
        nextRunAt: firstRunAtUtc,
        endAt: null,
      });
      expect((await fixture.client.getScheduledPrompts()).prompts).toEqual(
        created.snapshot.prompts,
      );
      const prompt = created.snapshot.prompts[0]!;
      const definition = {
        schedule: { type: 'recurring', firstRunAtUtc, intervalMinutes: intervalMinutes + 1, endAtUtc: null },
        target: prompt.target,
        prompt: prompt.prompt,
      };
      await fixture.client.put('/api/v1/scheduled-prompts', {
        id: prompt.id, expectedRevision: created.snapshot.revision, scheduledPrompt: definition,
      });
      const edited = await fixture.client.getScheduledPrompts();
      expect(edited.prompts[0]?.schedule).toMatchObject({ intervalMinutes: intervalMinutes + 1 });
      for (const key of ['intervalHours', 'intervalDays']) {
        await expect(fixture.client.post('/api/v1/scheduled-prompts', {
          expectedRevision: edited.revision,
          scheduledPrompt: { ...definition, schedule: { ...definition.schedule, [key]: 1 } },
        })).rejects.toThrow();
      }
      await fixture.restartGarcon();
      expect(await fixture.client.getScheduledPrompts()).toEqual(edited);
    });
  });
});
