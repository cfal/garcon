import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScheduledPromptsInvalidatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

const MINUTE_MS = 60_000;

function nextRunAtWithBoundaryBuffer(now = Date.now()): string {
  let nextRunAt = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  if (nextRunAt - now < 10_000) nextRunAt += MINUTE_MS;
  return new Date(nextRunAt).toISOString();
}

describe('scheduled prompt runtime variables', () => {
  test('shares chat ID and dates between the prompt and custom title without exposing the task name', async () => {
    await withIntegrationFixture('scheduled-prompt-chat-id', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const projectPath = join(fixture.executionDirs.project, 'scheduled project ');
      await mkdir(projectPath);
      await mkdir(projectPath.trimEnd());
      for (const candidate of [projectPath, projectPath.trimEnd()]) {
        expect(await fixture.client.get(`/api/v1/projects/resolve?executorId=${fixture.client.executorId}&projectPath=${encodeURIComponent(candidate)}`))
          .toMatchObject({ resolution: { kind: 'available', effectiveProjectKey: candidate } });
      }
      const rawPrompt = 'Scheduled chat {{chat_id}}; literal \\{{chat_id}}; UTC {{current_date}}; local {{current_date_local}}';
      const before = await fixture.client.listChats();
      expect(before.sessions).toEqual([]);

      const initial = await fixture.client.getScheduledPrompts();
      const beforeDispatch = new Date();
      const created = await fixture.client.createScheduledPrompt({
        expectedRevision: initial.revision,
        scheduledPrompt: {
          name: 'Private task list name',
          schedule: { type: 'once', runAtUtc: nextRunAtWithBoundaryBuffer() },
          target: {
            type: 'new-chat', executorId: fixture.client.executorId,
            chatTitleTemplate: 'Review {{chat_id}} / {{current_date}} / {{current_date_local}}',
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
      expect(created.snapshot.prompts[0]?.name).toBe('Private task list name');
      expect(created.snapshot.prompts[0]?.target).toMatchObject({ projectPath });
      expect((await fixture.client.getScheduledPrompts()).prompts).toEqual(created.snapshot.prompts);

      const candidate = { schedule: { type: 'once', runAtUtc: nextRunAtWithBoundaryBuffer() },
        target: created.snapshot.prompts[0]!.target, prompt: rawPrompt };
      for (const invalid of [
        { ...candidate, name: 'Two\nlines' },
        { ...candidate, target: { ...candidate.target, chatTitleTemplate: '' } },
        { ...candidate, target: { type: 'existing-chat', chatId: '1000000000000001', busyBehavior: 'queue', chatTitleTemplate: 'No rename' } },
      ]) {
        const error = await rejectionOf(fixture.client.post('/api/v1/scheduled-prompts', {
          expectedRevision: created.snapshot.revision, scheduledPrompt: invalid,
        }));
        expect(error).toMatchObject({ status: 400, body: { errorCode: 'SCHEDULED_PROMPT_VALIDATION_FAILED' } });
      }

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

      const match = /^Scheduled chat (\d{16}); literal \{\{chat_id\}\}; UTC (\d{4}-\d{2}-\d{2}); local (\d{4}-\d{2}-\d{2})$/.exec(
        providerRequest.lastUserText,
      );
      expect(match).not.toBeNull();
      const renderedChatId = match?.[1];
      if (!renderedChatId) throw new Error('Scheduled prompt did not contain a rendered chat ID');

      const chats = await fixture.client.listChats();
      expect(chats.sessions.map((chat) => chat.id)).toEqual([renderedChatId]);
      expect(chats.sessions[0]?.tags).toEqual(['scheduled']);
      expect(chats.sessions[0]?.projectPath).toBe(projectPath);
      expect(chats.sessions[0]?.title).toBe(`Review ${renderedChatId} / ${match?.[2]} / ${match?.[3]}`);

      const after = await fixture.client.getScheduledPrompts();
      const executionWindow = [beforeDispatch, new Date()];
      expect(executionWindow.map(at => at.toISOString().slice(0, 10))).toContain(match?.[2]);
      const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit' });
      expect(executionWindow.map(at => localDate.format(at))).toContain(match?.[3]);
      expect(providerRequest.lastUserText).not.toContain('Private task list name');
      expect(after.prompts).toEqual([]);
      // The one-off is gone, so the entry carries the label it ran with.
      expect(after.runLog).toContainEqual(expect.objectContaining({
        scheduledPromptId: created.snapshot.prompts[0]?.id,
        promptLabel: rawPrompt,
        outcome: 'created-chat',
        chatId: renderedChatId,
      }));
    }, { serverEnvironment: { TZ: 'Pacific/Kiritimati' }, chatTitleEnabled: true });
  }, 120_000);
});
