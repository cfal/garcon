import { describe, expect, test } from 'bun:test';
import type { ScheduledPromptsInvalidatedMessage } from '../../../common/ws-events.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';

type MessagesPage = Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>;

function countInputContent(page: MessagesPage, content: string): number {
  const identities = new Set<string>();
  for (const entry of page.messages) {
    if (entry.message.type !== 'user-message' || entry.message.content !== content) continue;
    identities.add(entry.message.metadata?.clientRequestId ?? `message:${entry.seq}`);
  }
  for (const input of page.pendingUserInputs) {
    if (input.content === content) identities.add(input.clientRequestId);
  }
  return identities.size;
}

async function restartWithoutFinalNativeUserRow(
  fixture: IntegrationFixture,
  chatId: string,
  content: string,
): Promise<void> {
  const held = fixture.fakeOpenAi.holdNext({ lastUserText: content });
  const accepted = await fixture.client.startDirectChat({
    chatId,
    content,
    projectPath: fixture.dirs.project,
    provider: fixture.provider,
  });
  await held.received;
  const aborted = held.expectAbort();
  await fixture.crashAndRestartBeforeNativeUserPersistence({
    chatId,
    clientRequestId: accepted.clientRequestId,
  });
  await aborted;
  held.releaseTruncatedStream();
}

describe('recovered input continuation', () => {
  test('converges reconnect after an HTTP continuation event is missed', async () => {
    await withIntegrationFixture('recovered-continuation-reconnect', async (fixture) => {
      const chatId = fixture.newChatId();
      const predecessor = 'reconnect-unconfirmed-predecessor';
      const successor = 'reconnect-queued-successor';
      const held = fixture.fakeOpenAi.holdNext({ lastUserText: predecessor });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: predecessor,
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await held.received;
      await fixture.client.enqueueNew(chatId, successor);
      const aborted = held.expectAbort();
      await fixture.crashAndRestartBeforeNativeUserPersistence({
        chatId,
        clientRequestId: accepted.clientRequestId,
      });
      await aborted;
      held.releaseTruncatedStream();

      const before = await fixture.client.getExecutionControl(chatId);
      const continuationId = before.recoveredInputContinuation?.id;
      if (!continuationId) throw new Error('Recovered continuation was not installed.');
      const initialReconnect = await fixture.client.reconnectState([chatId]);
      expect(initialReconnect.controlResults).toEqual([{
        chatId,
        outcome: 'snapshot',
        control: before,
      }]);

      const heldSuccessor = fixture.fakeOpenAi.holdNext({ lastUserText: successor });
      await fixture.client.disconnect();
      const continued = await fixture.client.continueRecoveredInput({ chatId, continuationId });
      expect(continued.control.recoveredInputContinuation).toBeNull();
      await fixture.client.reconnect();
      const reconnected = await fixture.client.reconnectState([chatId]);
      expect(reconnected.controlResults).toEqual([expect.objectContaining({
        chatId,
        outcome: 'snapshot',
        control: expect.objectContaining({
          recoveredInputContinuation: null,
        }),
      })]);
      const reconnectedControl = reconnected.controlResults[0];
      if (reconnectedControl?.outcome !== 'snapshot') throw new Error('Reconnect did not return control.');
      expect(reconnectedControl.control.version).toBeGreaterThanOrEqual(continued.control.version);

      await heldSuccessor.received;
      const cursor = fixture.client.markEvents();
      heldSuccessor.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor });
      expect(fixture.fakeOpenAi.requests().filter((request) => (
        request.lastUserText === successor
      ))).toHaveLength(1);
    });
  });

  test('keeps transcript identity and generation stable through direct continuation', async () => {
    await withIntegrationFixture('recovered-continuation-transcript', async (fixture) => {
      const chatId = fixture.newChatId();
      const predecessor = 'transcript-unconfirmed-predecessor';
      const successor = 'transcript-direct-successor';
      await restartWithoutFinalNativeUserRow(fixture, chatId, predecessor);

      const before = await Promise.all([
        fixture.client.getMessages(chatId),
        fixture.client.getMessages(chatId),
        fixture.client.getMessages(chatId),
      ]);
      expect(new Set(before.map((page) => page.generationId)).size).toBe(1);
      for (const page of before) expect(countInputContent(page, predecessor)).toBe(1);

      const heldSuccessor = fixture.fakeOpenAi.holdNext({ lastUserText: successor });
      const accepted = await fixture.client.runDirectChat({
        chatId,
        content: successor,
        provider: fixture.provider,
      });
      await heldSuccessor.received;
      const during = await Promise.all([
        fixture.client.getMessages(chatId),
        fixture.client.getMessages(chatId),
      ]);
      expect(during.map((page) => page.generationId)).toEqual([
        before[0].generationId,
        before[0].generationId,
      ]);
      for (const page of during) {
        expect(countInputContent(page, predecessor)).toBe(1);
        expect(countInputContent(page, successor)).toBe(1);
      }

      const cursor = fixture.client.markEvents();
      heldSuccessor.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, { afterIndex: cursor });
      const after = await fixture.client.getMessages(chatId);
      expect(after.generationId).toBe(before[0].generationId);
      expect(countInputContent(after, predecessor)).toBe(1);
      expect(countInputContent(after, successor)).toBe(1);
      expect(fixture.fakeOpenAi.requests().filter((request) => (
        request.lastUserText === successor
      ))).toHaveLength(1);
    });
  });

  test('keeps real scheduled skip and queue policies behind continuation', async () => {
    await withIntegrationFixture('recovered-continuation-real-cron', async (fixture) => {
      const chatId = fixture.newChatId();
      await restartWithoutFinalNativeUserRow(
        fixture,
        chatId,
        'scheduled-unconfirmed-predecessor',
      );
      const recovered = await fixture.client.getExecutionControl(chatId);
      const continuationId = recovered.recoveredInputContinuation?.id;
      if (!continuationId) throw new Error('Recovered continuation was not installed.');

      const now = Date.now();
      const nextMinute = Math.floor(now / 60_000) * 60_000 + 60_000;
      const runAtMs = nextMinute - now >= 20_000 ? nextMinute : nextMinute + 60_000;
      const runAtUtc = new Date(runAtMs).toISOString();
      const afterIndex = fixture.client.markEvents();
      const executed = fixture.client.waitForEventCount(
        (message): message is ScheduledPromptsInvalidatedMessage =>
          message.type === 'scheduled-prompts-invalidated' && message.reason === 'executed',
        2,
        'two scheduled prompt executions',
        { afterIndex, timeoutMs: 90_000 },
      );

      const initial = await fixture.client.getScheduledPrompts();
      const afterSkip = await fixture.client.createScheduledPrompt({
        expectedRevision: initial.revision,
        scheduledPrompt: {
          schedule: { type: 'once', runAtUtc },
          target: { type: 'existing-chat', chatId, busyBehavior: 'skip' },
          prompt: 'scheduled skip behind continuation',
        },
      });
      await fixture.client.createScheduledPrompt({
        expectedRevision: afterSkip.snapshot.revision,
        scheduledPrompt: {
          schedule: { type: 'once', runAtUtc },
          target: { type: 'existing-chat', chatId, busyBehavior: 'queue' },
          prompt: 'scheduled queue behind continuation',
        },
      });
      await executed;

      const afterExecution = await fixture.client.getScheduledPrompts();
      expect(afterExecution.runLog.some((entry) => entry.includes(
        `Prompt skipped because chat ${chatId} was busy.`,
      ))).toBe(true);
      expect(afterExecution.runLog.some((entry) => entry.includes(
        `Prompt queued for busy chat ${chatId}.`,
      ))).toBe(true);
      const blocked = await fixture.client.getExecutionControl(chatId);
      expect(blocked.recoveredInputContinuation?.id).toBe(continuationId);
      expect(blocked.queue.entries.map((entry) => entry.content)).toEqual([
        'scheduled queue behind continuation',
      ]);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'scheduled-unconfirmed-predecessor',
      ]);

      const heldScheduled = fixture.fakeOpenAi.holdNext({
        lastUserText: 'scheduled queue behind continuation',
      });
      await fixture.client.continueRecoveredInput({ chatId, continuationId });
      await heldScheduled.received;
      const cursor = fixture.client.markEvents();
      heldScheduled.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor });
      expect(fixture.fakeOpenAi.requests().filter((request) => (
        request.lastUserText === 'scheduled queue behind continuation'
      ))).toHaveLength(1);
    });
  }, 105_000);
});
