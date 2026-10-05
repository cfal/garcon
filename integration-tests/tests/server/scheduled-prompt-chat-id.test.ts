import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScheduledPromptsInvalidatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const MINUTE_MS = 60_000;

function nextRunAtWithBoundaryBuffer(now = Date.now()): string {
  let nextRunAt = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  if (nextRunAt - now < 10_000) nextRunAt += MINUTE_MS;
  return new Date(nextRunAt).toISOString();
}

describe('scheduled prompt chat ID variables', () => {
  test('uses one allocated chat ID in the rendered prompt and created chat', async () => {
    await withIntegrationFixture('scheduled-prompt-chat-id', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const projectPath = join(fixture.executionDirs.project, 'scheduled project ');
      await mkdir(projectPath);
      await mkdir(projectPath.trimEnd());
      for (const candidate of [projectPath, projectPath.trimEnd()]) {
        expect(await fixture.client.get(`/api/v1/projects/resolve?executorId=${fixture.client.executorId}&projectPath=${encodeURIComponent(candidate)}`))
          .toMatchObject({ resolution: { kind: 'available', effectiveProjectKey: candidate } });
      }
      const rawPrompt = 'Scheduled chat {{chat_id}}; literal \\{{chat_id}}';
      const before = await fixture.client.listChats();
      expect(before.sessions).toEqual([]);

      const initial = await fixture.client.getScheduledPrompts();
      const created = await fixture.client.createScheduledPrompt({
        expectedRevision: initial.revision,
        scheduledPrompt: {
          schedule: { type: 'once', runAtUtc: nextRunAtWithBoundaryBuffer() },
          target: {
            type: 'new-chat', executorId: fixture.client.executorId,
            agentId: agent.agentId,
            projectPath,
            model: agent.provider.model,
            apiProviderId: agent.provider.providerId,
            modelEndpointId: agent.provider.endpointId,
            modelProtocol: agent.provider.protocol,
            permissionMode: 'default',
            thinkingMode: 'none',
            agentSettingsById: { [agent.agentId]: agent.agentSettings },
            tags: ['scheduled'],
            preambleChoice: { mode: 'defaults' },
          },
          prompt: rawPrompt,
        },
      });
      expect(created.snapshot.prompts).toHaveLength(1);
      expect(created.snapshot.prompts[0]?.prompt).toBe(rawPrompt);
      expect(created.snapshot.prompts[0]?.target).toMatchObject({ projectPath });
      expect((await fixture.client.getScheduledPrompts()).prompts[0]?.target).toMatchObject({ projectPath });

      const eventCursor = fixture.client.markEvents();
      const timeoutMs = 90_000;
      const [providerRequest] = await Promise.all([
        fixture.fakeProviders.openAi.waitForRequest(
          { model: agent.provider.model },
          { timeoutMs },
        ),
        fixture.client.waitForEvent(
          (event): event is ScheduledPromptsInvalidatedMessage =>
            event.type === 'scheduled-prompts-invalidated' && event.reason === 'executed',
          'scheduled prompt execution',
          { afterIndex: eventCursor, timeoutMs },
        ),
      ]);

      const match = /^Scheduled chat (\d{16}); literal \{\{chat_id\}\}$/.exec(
        providerRequest.lastUserText,
      );
      expect(match).not.toBeNull();
      const renderedChatId = match?.[1];
      if (!renderedChatId) throw new Error('Scheduled prompt did not contain a rendered chat ID');

      const chats = await fixture.client.listChats();
      expect(chats.sessions.map((chat) => chat.id)).toEqual([renderedChatId]);
      expect(chats.sessions[0]?.tags).toEqual(['scheduled']);
      expect(chats.sessions[0]?.projectPath).toBe(projectPath);

      const after = await fixture.client.getScheduledPrompts();
      expect(after.prompts).toEqual([]);
      // The one-off is gone, so the entry carries the label it ran with.
      expect(after.runLog).toContainEqual(expect.objectContaining({
        scheduledPromptId: created.snapshot.prompts[0]?.id,
        promptLabel: rawPrompt,
        outcome: 'created-chat',
        chatId: renderedChatId,
      }));
    });
  }, 120_000);
});
