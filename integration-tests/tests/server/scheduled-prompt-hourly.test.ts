import { describe, expect, test } from "bun:test";
import { withIntegrationFixture } from "../../support/integration-fixture.js";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

describe("scheduled prompt hourly recurrence", () => {
  test("persists an hourly cadence through the HTTP contract", async () => {
    await withIntegrationFixture("scheduled-prompt-hourly", async (fixture) => {
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
            intervalHours: 6,
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
        intervalHours: 6,
        nextRunAt: firstRunAtUtc,
        endAt: null,
      });
      expect((await fixture.client.getScheduledPrompts()).prompts).toEqual(
        created.snapshot.prompts,
      );
    });
  });
});
