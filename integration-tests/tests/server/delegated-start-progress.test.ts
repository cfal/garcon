import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunFinishedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import { COMPACTION_MODEL, CHILD_TASK, prepareDelegatedHistory, requestSnapshotChild,
  waitForStartOutcome, startupPhases } from '../../support/delegated-start-progress.js';

describe('delegated startup progress', () => {
  test('preserves committed preparation rows across a crash without replaying startup', async () => {
    await withIntegrationFixture('delegated-start-progress-crash', async (fixture) => {
      const parent = await prepareDelegatedHistory(fixture);
      const compacting = fixture.fakeProviders.openAi.holdNext({ model: COMPACTION_MODEL });
      const { cursor } = await requestSnapshotChild(fixture, parent);
      const accepted = await waitForStartOutcome(fixture, parent, 'accepted', cursor);
      if (accepted.status !== 'accepted') throw new Error('Missing child');
      await compacting.received;
      const phases = await startupPhases(fixture, accepted.chatId);
      const aborted = compacting.expectAbort();
      await fixture.crashAndRestartGarcon();
      await aborted;
      expect(await startupPhases(fixture, accepted.chatId)).toEqual(phases);
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === accepted.chatId)?.processingPhase).toBeNull();
      expect(messagesOfType((await fixture.client.getMessages(accepted.chatId)).messages, 'user-message')
        .some((message) => message.content === CHILD_TASK)).toBe(true);
      expect(messagesOfType((await fixture.client.getMessages(parent)).messages, 'transcript-notice')
        .flatMap((message) => message.detail?.type === 'agent-start-outcome'
          && 'chatId' in message.detail && message.detail.chatId === accepted.chatId ? [message.detail.status] : []))
        .toEqual(['accepted']);
    });
  }, 90_000);

  test('acknowledges before compaction, releases the parent, and replays durable milestones', async () => {
    await withIntegrationFixture('delegated-start-progress', async (fixture) => {
      const parent = await prepareDelegatedHistory(fixture);
      const compacting = fixture.fakeProviders.openAi.holdNext({ model: COMPACTION_MODEL });
      const { cursor, turnId } = await requestSnapshotChild(fixture, parent);
      const accepted = await waitForStartOutcome(fixture, parent, 'accepted', cursor);
      if (accepted.status !== 'accepted') throw new Error('Missing child');
      const child = accepted.chatId;
      await compacting.received;
      expect(await startupPhases(fixture, child)).toEqual(['preparing-context', 'compacting-context']);
      const persisted = JSON.parse(await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'));
      expect(persisted.sessions[child].parentChat).toEqual({ chatId: parent, relation: 'delegation' });
      expect(messagesOfType((await fixture.client.getMessages(child)).messages, 'user-message')
        .some((message) => message.content === CHILD_TASK)).toBe(true);

      await fixture.client.waitForEvent((event): event is AgentRunFinishedMessage => event.type === 'agent-run-finished'
        && event.chatId === parent && event.turnId !== turnId, 'parent acknowledgment turn finished', { afterIndex: cursor });
      const next = await fixture.client.runDirectChat({ chatId: parent,
        content: 'Independent parent work while the child compacts.', agent: fixture.directAgents.openAi });
      await fixture.client.waitForTurnTerminal(parent, next.turnId);
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === child)?.processingPhase).toBe('running');
      const observer = await fixture.connectObserver('during-compaction');
      expect(messagesOfType((await observer.getMessages(child)).messages, 'transcript-notice')
        .some((notice) => notice.detail?.type === 'agent-start-progress' && notice.detail.phase === 'compacting-context')).toBe(true);

      compacting.releaseText('<summary>Synthetic retained context.</summary>');
      await waitForStartOutcome(fixture, parent, 'completed', cursor);
      expect(await startupPhases(fixture, child)).toEqual(['preparing-context', 'compacting-context', 'starting-agent', 'started']);
      await fixture.restartGarcon();
      expect(await startupPhases(fixture, child)).toEqual(['preparing-context', 'compacting-context', 'starting-agent', 'started']);
    });
  }, 90_000);

  test('retains the accepted child and returns its failed turn when compaction exhausts retries', async () => {
    await withIntegrationFixture('delegated-start-compaction-failure', async (fixture) => {
      const parent = await prepareDelegatedHistory(fixture);
      const first = fixture.fakeProviders.openAi.holdNext({ model: COMPACTION_MODEL });
      const second = fixture.fakeProviders.openAi.holdNext({ model: COMPACTION_MODEL });
      const { cursor } = await requestSnapshotChild(fixture, parent);
      const accepted = await waitForStartOutcome(fixture, parent, 'accepted', cursor);
      if (accepted.status !== 'accepted') throw new Error('Missing child');
      await first.received;
      first.releaseText('Invalid synthetic summary.');
      await second.received;
      second.releaseText('Invalid synthetic summary.');
      expect(await waitForStartOutcome(fixture, parent, 'failed', cursor))
        .toMatchObject({ chatId: accepted.chatId, errorCode: 'CARRYOVER_COMPACTION_FAILED' });
      expect(await startupPhases(fixture, accepted.chatId)).toEqual(['preparing-context', 'compacting-context', 'failed']);
      expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === accepted.chatId)).toBe(true);
      await fixture.restartGarcon();
      expect(await startupPhases(fixture, accepted.chatId)).toEqual(['preparing-context', 'compacting-context', 'failed']);
    });
  }, 90_000);

  test('stops compaction promptly and reports interruption for the accepted child', async () => {
    await withIntegrationFixture('delegated-start-compaction-stop', async (fixture) => {
      const parent = await prepareDelegatedHistory(fixture);
      const compacting = fixture.fakeProviders.openAi.holdNext({ model: COMPACTION_MODEL });
      const { cursor } = await requestSnapshotChild(fixture, parent);
      const accepted = await waitForStartOutcome(fixture, parent, 'accepted', cursor);
      if (accepted.status !== 'accepted') throw new Error('Missing child');
      await compacting.received;
      const aborted = compacting.expectAbort();
      expect(await fixture.client.stopChat({ chatId: accepted.chatId, clientRequestId: crypto.randomUUID() }))
        .toMatchObject({ outcome: 'interrupt-requested' });
      await aborted;
      expect(await waitForStartOutcome(fixture, parent, 'interrupted', cursor))
        .toMatchObject({ chatId: accepted.chatId, reason: 'user-stop' });
      expect(await startupPhases(fixture, accepted.chatId)).toEqual(['preparing-context', 'compacting-context', 'interrupted']);
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === accepted.chatId)?.processingPhase).toBeNull();
    });
  }, 90_000);
});
