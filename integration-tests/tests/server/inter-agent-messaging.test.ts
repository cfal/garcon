import { describe, expect, test } from 'bun:test';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { withTimeout } from '../../support/deferred.js';

describe('inter-agent messaging', () => {
  test('routes an assistant command through a hidden target turn with durable audit notices', async () => {
    await withIntegrationFixture('inter-agent-message-hidden-turn', async (fixture) => {
      const targetChatId = fixture.newChatId();
      const sourceChatId = fixture.newChatId();
      const targetPrompt = 'Prepare to receive an inter-agent message.';
      const sourcePrompt = 'Send the requested message.';
      const body = 'Coordinate the next verification pass.';
      const envelope = `<garcon-message from="${sourceChatId}">\n${body}\n</garcon-message>`;
      const command = `<garcon-send-message to="${targetChatId}" hide-sender="false">\n${body}\n</garcon-send-message>`;

      const targetInitial = fixture.fakeProviders.openAi.holdNext({ lastUserText: targetPrompt });
      const targetStarted = await fixture.client.startDirectChat({
        chatId: targetChatId,
        content: targetPrompt,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await targetInitial.received;
      targetInitial.releaseText('Target ready.');
      expect((await fixture.client.waitForTurnTerminal(targetChatId, targetStarted.turnId)).type)
        .toBe('agent-run-finished');

      const sourceTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: sourcePrompt });
      const hiddenTargetTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: envelope });
      const eventCursor = fixture.client.markEvents();
      const sourceStarted = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: sourcePrompt,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await sourceTurn.received;
      sourceTurn.releaseText(command);

      const hiddenRequest = await hiddenTargetTurn.received;
      expect(hiddenRequest.lastUserText).toBe(envelope);
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages'
          && event.chatId === sourceChatId
          && event.messages.some((entry) => (
            entry.message.type === 'transcript-notice'
            && entry.message.detail?.type === 'inter-agent-message-outcome'
          )),
        'source inter-agent message outcome',
        { afterIndex: eventCursor },
      );

      const source = await fixture.client.getMessages(sourceChatId);
      expect(userContents(source.messages)).toEqual([sourcePrompt]);
      expect(assistantContents(source.messages)).toEqual([]);
      expect(JSON.stringify(source.messages)).not.toContain('<garcon-send-message');
      expect(messagesOfType(source.messages, 'transcript-notice')).toContainEqual(
        expect.objectContaining({
          title: 'Inter-agent message',
          content: body,
          detail: {
            type: 'inter-agent-message-outcome',
            results: [{ chatId: targetChatId, status: 'queued' }],
          },
        }),
      );

      const targetDuringControl = await fixture.client.getMessages(targetChatId);
      expect(userContents(targetDuringControl.messages)).toEqual([targetPrompt]);
      expect(JSON.stringify(targetDuringControl.messages)).not.toContain('<garcon-message');
      expect(messagesOfType(targetDuringControl.messages, 'transcript-notice')).toContainEqual(
        expect.objectContaining({
          title: `Message from chat ${sourceChatId}`,
          content: body,
          detail: { type: 'inter-agent-message-received', fromChatId: sourceChatId },
        }),
      );
      expect((await fixture.client.getExecutionControl(targetChatId)).queue.entries).toEqual([]);

      hiddenTargetTurn.releaseText('Message received.');
      await fixture.client.waitForProcessing(targetChatId, false, { afterIndex: eventCursor });
      expect((await fixture.client.waitForTurnTerminal(
        sourceChatId,
        sourceStarted.turnId,
        { afterIndex: eventCursor },
      )).type).toBe('agent-run-finished');

      const targetCompleted = await fixture.client.getMessages(targetChatId);
      expect(userContents(targetCompleted.messages)).toEqual([targetPrompt]);
      expect(assistantContents(targetCompleted.messages)).toEqual(['Target ready.', 'Message received.']);
    });
  }, 120_000);

  test('keeps Stop usable while a message waits for a target turn that cannot be steered', async () => {
    await withIntegrationFixture('inter-agent-message-unsteerable-stop', async (fixture) => {
      const targetChatId = fixture.newChatId();
      const sourceChatId = fixture.newChatId();
      const targetPrompt = 'Keep working until stopped.';
      const sourcePrompt = 'Message the busy chat.';
      const body = 'Pick this up after the current turn.';
      const envelope = `<garcon-message from="${sourceChatId}">\n${body}\n</garcon-message>`;
      const command = `<garcon-send-message to="${targetChatId}" hide-sender="false">\n${body}\n</garcon-send-message>`;

      // Direct agents cannot be steered, so the message waits for this turn to settle.
      const heldTarget = fixture.fakeProviders.openAi.holdNext({ lastUserText: targetPrompt });
      const targetStarted = await fixture.client.startDirectChat({
        chatId: targetChatId,
        content: targetPrompt,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldTarget.received;

      const sourceTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: sourcePrompt });
      const hiddenTargetTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: envelope });
      const sourceCursor = fixture.client.markEvents();
      const sourceStarted = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: sourcePrompt,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await sourceTurn.received;
      sourceTurn.releaseText(command);
      expect((await fixture.client.waitForTurnTerminal(
        sourceChatId,
        sourceStarted.turnId,
        { afterIndex: sourceCursor },
      )).type).toBe('agent-run-finished');

      const targetAborted = heldTarget.expectAbort();
      const stopped = await withTimeout(
        fixture.client.stopChat({ chatId: targetChatId, clientRequestId: crypto.randomUUID() }),
        5_000,
        () => 'Stop waited behind the pending inter-agent message',
      );
      expect(stopped.outcome).toBe('interrupt-requested');
      await targetAborted;
      expect(await fixture.client.waitForTurnTerminal(targetChatId, targetStarted.turnId))
        .toMatchObject({ type: 'agent-run-finished', outcome: 'interrupted' });

      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages'
          && event.chatId === sourceChatId
          && event.messages.some((entry) => (
            entry.message.type === 'transcript-notice'
            && entry.message.detail?.type === 'inter-agent-message-outcome'
          )),
        'queued source inter-agent outcome',
        { afterIndex: sourceCursor },
      );
      const source = await fixture.client.getMessages(sourceChatId);
      expect(messagesOfType(source.messages, 'transcript-notice')).toContainEqual(expect.objectContaining({
        detail: {
          type: 'inter-agent-message-outcome',
          results: [{ chatId: targetChatId, status: 'queued' }],
        },
      }));

      // The message waited outside the target's queue when Stop arrived, so Stop
      // paused nothing, and the message runs once the stopped turn settles.
      expect((await fixture.client.getExecutionControl(targetChatId)).queue.pause).toBeNull();
      expect((await hiddenTargetTurn.received).lastUserText).toBe(envelope);
      const hiddenCursor = fixture.client.markEvents();
      hiddenTargetTurn.releaseText('Picked up after the stop.');
      expect((await fixture.client.waitForTurnTerminal(targetChatId, undefined, { afterIndex: hiddenCursor })).type)
        .toBe('agent-run-finished');
      expect(assistantContents((await fixture.client.getMessages(targetChatId)).messages))
        .toEqual(['Picked up after the stop.']);
    });
  }, 120_000);

  test('drops queued control input on restart without redispatching durable request evidence', async () => {
    await withIntegrationFixture('inter-agent-message-restart-loss', async (fixture) => {
      const targetChatId = fixture.newChatId();
      const sourceChatId = fixture.newChatId();
      const targetPrompt = 'Hold the target while control input is queued.';
      const sourcePrompt = 'Queue the inter-agent message.';
      const queuedUserPrompt = 'This public queued input is also process-ephemeral.';
      const afterRestartPrompt = 'Continue after restart.';
      const body = 'This control input must not survive restart.';
      const envelope = `<garcon-message from="${sourceChatId}">\n${body}\n</garcon-message>`;
      const command = `<garcon-send-message to="${targetChatId}" hide-sender="false">\n${body}\n</garcon-send-message>`;

      const heldTarget = fixture.fakeProviders.openAi.holdNext({ lastUserText: targetPrompt });
      const targetStarted = await fixture.client.startDirectChat({
        chatId: targetChatId,
        content: targetPrompt,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldTarget.received;
      await fixture.client.enqueueNew(targetChatId, queuedUserPrompt);
      const paused = await fixture.client.pauseQueue(targetChatId);
      expect(paused.control.queue.pause?.kind).toBe('manual');

      const sourceTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: sourcePrompt });
      const sourceCursor = fixture.client.markEvents();
      const sourceStarted = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: sourcePrompt,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await sourceTurn.received;
      sourceTurn.releaseText(command);
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages'
          && event.chatId === sourceChatId
          && event.messages.some((entry) => (
            entry.message.type === 'transcript-notice'
            && entry.message.detail?.type === 'inter-agent-message-outcome'
          )),
        'queued source inter-agent outcome',
        { afterIndex: sourceCursor },
      );
      expect((await fixture.client.waitForTurnTerminal(
        sourceChatId,
        sourceStarted.turnId,
        { afterIndex: sourceCursor },
      )).type).toBe('agent-run-finished');

      heldTarget.releaseText('Target remains paused.');
      expect((await fixture.client.waitForTurnTerminal(targetChatId, targetStarted.turnId)).type)
        .toBe('agent-run-finished');
      const beforeRestartTarget = await fixture.client.getMessages(targetChatId);
      expect(messagesOfType(beforeRestartTarget.messages, 'transcript-notice')).not.toContainEqual(
        expect.objectContaining({
          detail: { type: 'inter-agent-message-received', fromChatId: sourceChatId },
        }),
      );

      await fixture.restartGarcon();

      const restartedSource = await fixture.client.getMessages(sourceChatId);
      const sourceOutcomes = messagesOfType(
        restartedSource.messages,
        'transcript-notice',
      ).filter((message) => message.detail?.type === 'inter-agent-message-outcome');
      expect(sourceOutcomes).toEqual([
        expect.objectContaining({
          content: body,
          detail: {
            type: 'inter-agent-message-outcome',
            results: [{ chatId: targetChatId, status: 'queued' }],
          },
        }),
      ]);
      expect(JSON.stringify(restartedSource.messages)).not.toContain('<garcon-send-message');

      const restartedTarget = await fixture.client.getMessages(targetChatId);
      expect(messagesOfType(restartedTarget.messages, 'transcript-notice')).not.toContainEqual(
        expect.objectContaining({
          detail: { type: 'inter-agent-message-received', fromChatId: sourceChatId },
        }),
      );
      expect((await fixture.client.getExecutionControl(targetChatId)).queue).toMatchObject({
        entries: [],
        pause: null,
      });

      const postRestartTurn = fixture.fakeProviders.openAi.holdNext({
        lastUserText: afterRestartPrompt,
      });
      const postRestartStarted = await fixture.client.runDirectChat({
        chatId: targetChatId,
        content: afterRestartPrompt,
        agent: fixture.directAgents.openAi,
      });
      await postRestartTurn.received;
      postRestartTurn.releaseText('Restart completed without hidden delivery.');
      expect((await fixture.client.waitForTurnTerminal(
        targetChatId,
        postRestartStarted.turnId,
      )).type).toBe('agent-run-finished');

      expect(fixture.fakeProviders.openAi.requests().some((request) => (
        request.lastUserText.includes(envelope)
        || request.lastUserText.includes(queuedUserPrompt)
      ))).toBe(false);
      const completedTarget = await fixture.client.getMessages(targetChatId);
      expect(messagesOfType(completedTarget.messages, 'transcript-notice')).not.toContainEqual(
        expect.objectContaining({
          detail: { type: 'inter-agent-message-received', fromChatId: sourceChatId },
        }),
      );
    });
  }, 120_000);
});
