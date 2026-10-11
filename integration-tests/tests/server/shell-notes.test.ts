import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { ChatTitleUpdatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`Notes persist without execution and preserve mixed formats across Reload (${executionBackend})`, async () => {
    await withIntegrationFixture(`shell-notes-${executionBackend}`, async fixture => {
      const chatId = fixture.newChatId();
      const source = '  # Synthetic note\n touch must-not-exist\n/md printf inert\n';
      const first = await fixture.client.startChat({ chatId, agentId: 'shell', model: 'notes',
        projectPath: fixture.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
        agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: source });
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe('agent-run-finished');
      await fixture.client.waitForProcessing(chatId, false);
      const holdingCommand = 'while [ ! -f release-notes-test ]; do sleep 0.05; done';
      const holding = await fixture.client.runChat({ chatId, model: 'sh', command: holdingCommand,
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
      await fixture.client.waitForProcessing(chatId, true);
      const queuedSource = 'touch queued-must-not-exist';
      await fixture.client.enqueue({ chatId, content: queuedSource, expectedModel: 'notes',
        clientRequestId: crypto.randomUUID() });
      const paused = await fixture.client.pauseQueue(chatId);
      expect(await rejectionOf(fixture.client.patch('/api/v1/chats/model', { chatId, model: 'sh' })))
        .toMatchObject({ status: 409, body: { errorCode: 'SESSION_BUSY' } });
      expect(await rejectionOf(fixture.client.runChat({ chatId, model: 'sh', command: 'touch override-must-not-exist',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() })))
        .toMatchObject({ status: 409 });
      await writeFile(join(fixture.executionDirs.project, 'release-notes-test'), 'released');
      await fixture.client.waitForTurnTerminal(chatId, holding.turnId);
      await fixture.client.waitForProcessing(chatId, false);
      expect(await rejectionOf(fixture.client.patch('/api/v1/chats/model', { chatId, model: 'sh' })))
        .toMatchObject({ status: 409, body: { errorCode: 'SESSION_BUSY' } });
      const cursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, paused.control.queue.pause!.id);
      await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor });
      await fixture.client.waitForProcessing(chatId, false);
      await fixture.client.patch('/api/v1/chats/model', { chatId, model: 'notes-markdown' });
      expect(await rejectionOf(fixture.client.enqueue({ chatId, content: 'stale note', expectedModel: 'notes',
        clientRequestId: crypto.randomUUID() }))).toMatchObject({ status: 409 });
      const markdown = '# Synthetic heading\n\n**Saved Markdown**\n<garcon-get-chat-id />';
      const request = { chatId, command: markdown, model: 'notes-markdown',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() };
      const next = await fixture.client.runChat(request);
      await fixture.client.waitForTurnTerminal(chatId, next.turnId);
      await fixture.client.waitForProcessing(chatId, false);
      const inputs = async () => (await fixture.client.getMessages(chatId)).messages.map(row => row.message)
        .filter(message => message.type === 'user-message');
      const before = await inputs();
      expect(before).toHaveLength(4);
      expect(before).toEqual([
        expect.objectContaining({ content: source, metadata: expect.objectContaining({ contentMode: 'literal', contentFormat: 'plain' }) }),
        expect.objectContaining({ content: holdingCommand, metadata: expect.objectContaining({ contentMode: 'literal', contentFormat: 'plain' }) }),
        expect.objectContaining({ content: queuedSource, metadata: expect.objectContaining({ contentMode: 'literal', contentFormat: 'plain' }) }),
        expect.objectContaining({ content: markdown, metadata: expect.objectContaining({ contentMode: 'literal', contentFormat: 'markdown' }) }),
      ]);
      if (executionBackend !== 'in-process') await fixture.crashAndRestartExecutorWorker();
      await fixture.restartGarcon();
      await fixture.client.reloadChat(chatId);
      expect(await inputs()).toEqual(before);
      expect((await fixture.client.runChat(request)).status).toBe('duplicate');
      for (const name of ['must-not-exist', 'queued-must-not-exist', 'override-must-not-exist']) {
        expect(await Bun.file(join(fixture.executionDirs.project, name)).exists()).toBe(false);
      }
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(0);
    }, { executionBackend });
  }, 90_000);
}

test.each(['notes', 'notes-markdown'])('%s honors the configured automatic title generator', async model => {
  await withIntegrationFixture(`notes-title-${model}`, async fixture => {
    const chatId = fixture.newChatId();
    const title = fixture.fakeProviders.openAi.holdNext({});
    const cursor = fixture.client.markEvents();
    const started = await fixture.client.startChat({ chatId, agentId: 'shell', model,
      projectPath: fixture.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
      agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
      clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: '# Synthetic titled note' });
    expect((await title.received).lastUserText).toContain('# Synthetic titled note');
    title.releaseText('Synthetic note title');
    await fixture.client.waitForEvent((event): event is ChatTitleUpdatedMessage =>
      event.type === 'chat-title-updated' && event.chatId === chatId && event.title === 'Synthetic note title',
    'automatic Notes title', { afterIndex: cursor });
    await fixture.client.waitForTurnTerminal(chatId, started.turnId);
  }, { chatTitleEnabled: true });
}, 60_000);
