import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { ScheduleInPromptResponse, ScheduledPromptsSnapshot } from '../../../common/scheduled-prompts.js';
import type { ScheduledPromptsInvalidatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`literal schedules preserve selection across edits and restart (${executionBackend})`, async () => {
    await withIntegrationFixture(`shell-schedules-${executionBackend}`, async fixture => {
      const cases = [
        { model: 'notes', nextModel: 'sh', source: 'touch forbidden-note', outcome: 'failed' },
        { model: 'sh', nextModel: 'notes', source: 'touch forbidden-command', outcome: 'failed' },
        { model: 'notes-markdown', source: '  /clear\n{{chat_id}}  \n', outcome: 'sent' },
        { model: 'sh', source: '/md printf "scheduled-output" > scheduled-output  \n', outcome: 'sent' },
        { model: 'notes', source: 'paused-note', outcome: 'skipped-busy' },
      ] as const;
      const targets = [];
      for (const scenario of cases) {
        const chatId = fixture.newChatId();
        const first = await fixture.client.startChat({ chatId, agentId: 'shell', model: scenario.model,
          projectPath: fixture.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
          agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'true' });
        await fixture.client.waitForTurnTerminal(chatId, first.turnId);
        await fixture.client.waitForProcessing(chatId, false);
        const created = await fixture.client.post<ScheduleInPromptResponse>('/api/v1/scheduled-prompts/in', {
          chatId, duration: '1h', prompt: scenario.source,
        });
        expect(created.scheduledPrompt.target).toMatchObject({ expectedSelection: {
          agentId: 'shell', model: scenario.model,
        } });
        targets.push({ chatId, scenario, scheduled: created.scheduledPrompt });
        if ('nextModel' in scenario) {
          await fixture.client.patch('/api/v1/chats/model', { chatId, model: scenario.nextModel });
          if (created.scheduledPrompt.target.type !== 'existing-chat') throw new Error('Expected existing chat');
          expect(await rejectionOf(fixture.client.post('/api/v1/scheduled-prompts/in', {
            chatId, duration: '1h', prompt: scenario.source,
            expectedSelection: created.scheduledPrompt.target.expectedSelection,
          }))).toMatchObject({ status: 409, body: { errorCode: 'SCHEDULED_PROMPT_SELECTION_CHANGED' } });
        }
      }
      await fixture.restartGarcon();
      const loaded = await fixture.client.getScheduledPrompts();
      for (const { scheduled } of targets) {
        expect(loaded.prompts.find(prompt => prompt.id === scheduled.id)?.target).toEqual(scheduled.target);
      }
      const pausedChat = targets.find(target => target.scenario.outcome === 'skipped-busy')!;
      const holdingCommand = 'while [ ! -f schedule-release ]; do sleep 0.05; done';
      const holding = await fixture.client.runChat({ chatId: pausedChat.chatId, model: 'sh', command: holdingCommand,
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
      await fixture.client.waitForProcessing(pausedChat.chatId, true);
      await fixture.client.enqueue({ chatId: pausedChat.chatId, content: 'queued synthetic note',
        expectedModel: 'notes', clientRequestId: crypto.randomUUID() });
      expect((await fixture.client.pauseQueue(pausedChat.chatId)).control.queue.pause).not.toBeNull();
      await writeFile(join(fixture.executionDirs.project, 'schedule-release'), 'released');
      await fixture.client.waitForTurnTerminal(pausedChat.chatId, holding.turnId);
      await fixture.client.waitForProcessing(pausedChat.chatId, false);
      let nextMinute = Math.ceil(Date.now() / 60_000) * 60_000;
      if (nextMinute - Date.now() < 15_000) nextMinute += 60_000;
      const runAtUtc = new Date(nextMinute).toISOString();
      let revision = loaded.revision;
      const afterIndex = fixture.client.markEvents();
      for (const { chatId, scenario, scheduled } of targets) {
        // Settings omits the capture when rebuilding an existing-chat target.
        const edited = await fixture.client.put<{ snapshot: ScheduledPromptsSnapshot }>('/api/v1/scheduled-prompts', {
          expectedRevision: revision, id: scheduled.id,
          scheduledPrompt: { target: { type: 'existing-chat', chatId, busyBehavior: 'skip' },
            schedule: { type: 'once', runAtUtc }, prompt: scenario.source },
        });
        revision = edited.snapshot.revision;
        expect(edited.snapshot.prompts.find(prompt => prompt.id === scheduled.id)?.target).toEqual(scheduled.target);
      }
      await fixture.client.waitForEventCount((event): event is ScheduledPromptsInvalidatedMessage =>
        event.type === 'scheduled-prompts-invalidated' && event.reason === 'executed',
      targets.length, 'all literal schedule outcomes', { afterIndex, timeoutMs: 90_000 });
      const finished = await fixture.client.getScheduledPrompts();
      expect(finished.prompts).toEqual([]);
      for (const { chatId, scenario, scheduled } of targets) {
        expect(finished.runLog).toContainEqual(expect.objectContaining({
          scheduledPromptId: scheduled.id, outcome: scenario.outcome,
        }));
        if (scenario.outcome === 'sent') {
          await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex });
          await fixture.client.waitForProcessing(chatId, false);
          await fixture.client.reloadChat(chatId);
        }
        const inputs = (await fixture.client.getMessages(chatId)).messages
          .map(row => row.message).filter(message => message.type === 'user-message');
        const expectedInputs = ['true'];
        if (scenario.outcome === 'sent') expectedInputs.push(scenario.source.replace('{{chat_id}}', chatId));
        if (scenario.outcome === 'skipped-busy') expectedInputs.push(holdingCommand);
        expect(inputs.map(message => message.content)).toEqual(expectedInputs);
      }
      expect(await Bun.file(join(fixture.executionDirs.project, 'forbidden-note')).exists()).toBe(false);
      expect(await Bun.file(join(fixture.executionDirs.project, 'forbidden-command')).exists()).toBe(false);
      expect(await Bun.file(join(fixture.executionDirs.project, 'scheduled-output')).text()).toBe('scheduled-output');
    }, { executionBackend });
  }, 120_000);
}
