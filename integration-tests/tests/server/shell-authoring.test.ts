import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessagesMessage, ChatTitleUpdatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`Shell uses configured automatic title generation (${executionBackend})`, async () => {
    await withIntegrationFixture(`shell-title-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const chatId = fixture.newChatId();
      const source = '  printf synthetic-title-output\n ';
      const title = fixture.fakeProviders.openAi.holdNext({});
      const cursor = client.markEvents();
      const started = await client.startChat({
        chatId, agentId: 'shell', model: 'sh', projectPath: fixture.executionDirs.project,
        permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
        origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: source,
      });
      expect((await title.received).lastUserText).toContain(source.trim());
      title.releaseText('Synthetic automatic title');
      const updated = await client.waitForEvent(
        (event): event is ChatTitleUpdatedMessage => event.type === 'chat-title-updated' && event.chatId === chatId,
        'automatic Shell title', { afterIndex: cursor },
      );
      expect(updated).toMatchObject({ title: 'Synthetic automatic title' });
      expect((await client.waitForTurnTerminal(chatId, started.turnId)).type).toBe('agent-run-finished');
      expect((await client.getMessages(chatId)).messages.find(row => row.message.type === 'user-message')?.message)
        .toMatchObject({ content: source, metadata: { contentMode: 'literal' } });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);

      const before = (await client.getMessages(chatId)).messages.length;
      expect(await rejectionOf(client.runChat({ chatId, clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(), command: 'touch unsupported-attachment',
        images: [{ name: 'synthetic.png', mimeType: 'image/png', data: 'data:image/png;base64,YQ==' }],
      }))).toMatchObject({ status: 422, body: { errorCode: 'UNSUPPORTED_AGENT' } });
      expect((await client.getMessages(chatId)).messages).toHaveLength(before);
    }, { executionBackend, chatTitleEnabled: true });
  }, 60_000);
}

test('conversation starts trim execution input while exact retries preserve request identity', async () => {
  await withIntegrationFixture('conversation-start-normalization', async fixture => {
    const { client } = fixture;
    const source = '  Synthetic conversation input.\n ';
    const response = fixture.fakeProviders.openAi.holdNext({ lastUserText: source.trim() });
    const request = client.directStartRequest({ chatId: fixture.newChatId(),
      agent: fixture.directAgents.openAi, projectPath: fixture.executionDirs.project, content: source });
    const started = await client.startChat(request);
    expect((await response.received).lastUserText).toBe(source.trim());
    response.releaseText('Synthetic response.');
    await client.waitForTurnTerminal(started.chatId, started.turnId);
    expect((await client.getMessages(started.chatId)).messages.find(row => row.message.type === 'user-message')?.message)
      .toMatchObject({ content: source.trim() });
    expect(await client.startChat(request)).toMatchObject({ status: 'duplicate', turnId: started.turnId });
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
  });
}, 30_000);

test('Shell permits explicit title generation, prose refinement, and scheduled chat ID templates', async () => {
  await withIntegrationFixture('shell-authoring', async fixture => {
    const { client } = fixture;
    const chatId = fixture.newChatId();
    const started = await client.startChat({
      chatId, agentId: 'shell', model: 'sh', projectPath: fixture.executionDirs.project,
      permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
      origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
      command: 'printf synthetic-output',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await client.waitForProcessing(chatId, false);
    expect(fixture.fakeProviders.openAiResponses.requests()).toHaveLength(0);
    fixture.fakeProviders.openAiResponses.respondThinkingThenTextNext(
      { lastUserTextIncludes: 'synthetic-output' }, 'Synthetic command title',
    );
    expect(await client.generateChatTitle({ chatId, message: 'synthetic-output' }))
      .toMatchObject({ title: 'Synthetic command title' });

    const target = fixture.directAgents.openAi;
    await client.updateSettings({ ui: { promptRefinement: {
      executorId: client.executorId, agentId: target.agentId, model: target.provider.model,
      apiProviderId: target.provider.providerId, modelEndpointId: target.provider.endpointId,
      modelProtocol: target.provider.protocol, thinkingMode: 'none',
    } } });
    const refinement = fixture.fakeProviders.openAi.holdNext({ model: target.provider.model });
    const response = client.refinePrompt({ draft: 'echo draft-command', target: 'prompt' });
    expect((await refinement.received).lastUserText).toContain('echo draft-command');
    refinement.releaseText('Refined prose for deliberate editing.');
    expect(await response).toMatchObject({ refinedPrompt: 'Refined prose for deliberate editing.' });
    expect((await client.getMessages(chatId)).messages.filter(row => row.message.type === 'user-message')).toHaveLength(1);

    const schedules = await client.getScheduledPrompts();
    const runAt = Math.ceil((Date.now() + 10_000) / 60_000) * 60_000;
    const cursor = client.markEvents();
    await client.createScheduledPrompt({ expectedRevision: schedules.revision, scheduledPrompt: {
      schedule: { type: 'once', runAtUtc: new Date(runAt).toISOString() },
      target: { type: 'existing-chat', chatId, busyBehavior: 'queue' },
      prompt: '  printf "%s" {{chat_id}} > scheduled-id\n ',
    } });
    await client.waitForCommittedUserInput(chatId, `  printf "%s" ${chatId} > scheduled-id\n `,
      { afterIndex: cursor, timeoutMs: 90_000 });
    await client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor });
    await client.waitForProcessing(chatId, false);
    expect(await readFile(join(fixture.executionDirs.project, 'scheduled-id'), 'utf8')).toBe(chatId);
  }, { chatTitleAgent: 'openAiResponses' });
}, 120_000);

test('agent commands can start and resume Shell tasks', async () => {
  await withIntegrationFixture('shell-automation', async fixture => {
    const { client } = fixture;
    const parent = fixture.newChatId();
    const source = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Start a synthetic task.' });
    const cursor = client.markEvents();
    await client.startDirectChat({ chatId: parent, agent: fixture.directAgents.openAi,
      projectPath: fixture.executionDirs.project, content: 'Start a synthetic task.' });
    await source.received;
    source.releaseText('<garcon-start-agent ref="shell-task" async="true" agent="shell" model="sh" title="Synthetic task">printf started > automated-task</garcon-start-agent>');
    const event = await client.waitForEvent(
      (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === parent
        && event.messages.some(row => row.message.type === 'transcript-notice'
          && row.message.detail?.type === 'agent-start-outcome'),
      'Shell child admission', { afterIndex: cursor },
    );
    const notice = event.messages.map(row => row.message).find(message => message.type === 'transcript-notice'
      && message.detail?.type === 'agent-start-outcome');
    if (notice?.type !== 'transcript-notice' || notice.detail?.type !== 'agent-start-outcome'
      || notice.detail.status !== 'accepted') throw new Error(`Shell task was not admitted: ${JSON.stringify(notice)}`);
    const child = notice.detail.chatId;
    await client.waitForTurnTerminal(child);
    await client.waitForProcessing(child, false);
    expect(await readFile(join(fixture.executionDirs.project, 'automated-task'), 'utf8')).toBe('started');
    expect((await client.listChats()).sessions.find(chat => chat.id === child)?.title).toBe('Synthetic task');

    await client.waitForProcessing(parent, false);
    const resume = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Continue the synthetic task.' });
    const resumeCursor = client.markEvents();
    await client.runDirectChat({ chatId: parent, agent: fixture.directAgents.openAi, content: 'Continue the synthetic task.' });
    await resume.received;
    resume.releaseText(`<garcon-resume-agent ref="shell-resume" chat-id="${child}">printf resumed >> automated-task</garcon-resume-agent>`);
    await client.waitForTurnTerminal(child, undefined, { afterIndex: resumeCursor });
    await client.waitForProcessing(child, false);
    expect(await readFile(join(fixture.executionDirs.project, 'automated-task'), 'utf8')).toBe('startedresumed');

    const sender = fixture.newChatId();
    const control = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Send a synthetic control message.' });
    const controlCursor = client.markEvents();
    await client.startDirectChat({ chatId: sender, agent: fixture.directAgents.openAi,
      projectPath: fixture.executionDirs.project, content: 'Send a synthetic control message.' });
    await control.received;
    control.releaseText(`<garcon-send-message to="${child}" hide-sender="false">synthetic control input</garcon-send-message>`);
    // Control envelopes are admitted unchanged; the shell, not an origin gate, rejects invalid syntax.
    expect((await client.waitForTurnTerminal(child, undefined, { afterIndex: controlCursor })).type)
      .toBe('agent-run-failed');
    const outcome = await client.waitForEvent(
      (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === sender
        && event.messages.some(row => row.message.type === 'transcript-notice'
          && row.message.detail?.type === 'inter-agent-message-outcome'),
      'Shell control admission', { afterIndex: controlCursor },
    );
    expect(JSON.stringify(outcome.messages)).toContain('"status":"queued"');
  });
}, 60_000);
