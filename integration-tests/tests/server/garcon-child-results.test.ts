import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentChildOutcomeNoticeDetail } from '../../../common/garcon-agent-result.js';
import { garconCommandResultContent } from '../../../common/garcon-command-results.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import type { ChatRegistrySnapshot } from '../../../server/chats/store.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

async function outcome(fixture: IntegrationFixture, chatId: string, ref: string, status: string, afterIndex: number): Promise<AgentChildOutcomeNoticeDetail> {
  const matches = (detail: unknown): detail is AgentChildOutcomeNoticeDetail => !!detail && typeof detail === 'object'
    && 'type' in detail && (detail.type === 'agent-start-outcome' || detail.type === 'agent-resume-outcome')
    && 'ref' in detail && detail.ref === ref && 'status' in detail && detail.status === status;
  const event = await fixture.client.waitForEvent(
    (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === chatId
      && event.messages.some(({ message }) => message.type === 'transcript-notice' && matches(message.detail)),
    `${ref} ${status}`, { afterIndex, timeoutMs: 30_000 },
  );
  const detail = messagesOfType(event.messages, 'transcript-notice').find((message) => matches(message.detail))?.detail;
  if (!matches(detail)) throw new Error('Missing child outcome');
  return detail;
}

describe('delegated snapshot turns and results', () => {
  for (const interruption of ['user-stop', 'chat-deleted'] as const) test(`reports ${interruption} for the exact delegated child turn`, async () => {
    await withIntegrationFixture(`child-result-${interruption}`, async (fixture) => {
      const agent = fixture.directAgents.openAiResponses;
      const model = fixture.fakeProviders.openAiResponses;
      const parent = fixture.newChatId();
      const initial = model.holdNext({ lastUserText: 'Delegate the synthetic interruptible task.' });
      const child = model.holdNext({ lastUserText: 'Keep the synthetic child active.' });
      const ack = model.holdNext({ lastUserTextIncludes: 'status="accepted"' });
      const terminal = model.holdNext({ lastUserTextIncludes: 'status="interrupted"' });
      const cursor = fixture.client.markEvents();
      await fixture.client.startDirectChat({ chatId: parent, projectPath: fixture.dirs.project, content: 'Delegate the synthetic interruptible task.', agent });
      await initial.received;
      initial.releaseText(`<garcon-start-agent ref="interruption" agent="${agent.agentId}" provider="${agent.provider.providerId}" model="${agent.provider.model}">Keep the synthetic child active.</garcon-start-agent>`);
      const admitted = await outcome(fixture, parent, 'interruption', 'accepted', cursor);
      if (admitted.status !== 'accepted') throw new Error('Missing child admission');
      await child.received;
      await ack.received;
      ack.releaseText('Synthetic interruption admission observed.');
      child.expectAbort();
      if (interruption === 'chat-deleted') await fixture.client.deleteChat(admitted.chatId);
      else await fixture.client.stopChat({ chatId: admitted.chatId, clientRequestId: 'synthetic-stop' });
      const interrupted = await outcome(fixture, parent, 'interruption', 'interrupted', cursor);
      expect(interrupted).toMatchObject({ chatId: admitted.chatId, reason: interruption, output: { availability: 'available', text: '' } });
      expect((await terminal.received).lastUserText).toBe(garconCommandResultContent(interrupted));
      terminal.releaseText('Synthetic interruption observed.');
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === parent
          && event.messages.some(({ message }) => message.type === 'assistant-message' && message.content === 'Synthetic interruption observed.'),
        'child interruption result consumed', { afterIndex: cursor },
      );
      expect(userContents((await fixture.client.getMessages(parent)).messages)).toEqual(['Delegate the synthetic interruptible task.']);
      expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === admitted.chatId)).toBe(interruption === 'user-stop');
    });
  }, 60_000);

  test('restart preserves the child but loses its pending callback without replaying either turn', async () => {
    await withIntegrationFixture('child-pending-result-restart', async (fixture) => {
      const agent = fixture.directAgents.openAiResponses;
      const model = fixture.fakeProviders.openAiResponses;
      const parent = fixture.newChatId();
      const initial = model.holdNext({ lastUserText: 'Start the synthetic pending task.' });
      const child = model.holdNext({ lastUserText: 'Keep the synthetic child pending.' });
      const ack = model.holdNext({ lastUserTextIncludes: 'status="accepted"' });
      const cursor = fixture.client.markEvents();
      await fixture.client.startDirectChat({ chatId: parent, projectPath: fixture.dirs.project, content: 'Start the synthetic pending task.', agent });
      await initial.received;
      initial.releaseText(`<garcon-start-agent ref="pending" title="Synthetic pending child" agent="${agent.agentId}" provider="${agent.provider.providerId}" model="${agent.provider.model}">Keep the synthetic child pending.</garcon-start-agent>`);
      const admitted = await outcome(fixture, parent, 'pending', 'accepted', cursor);
      if (admitted.status !== 'accepted') throw new Error('Missing child admission');
      await child.received;
      expect((await ack.received).lastUserText).toBe(garconCommandResultContent(admitted));
      ack.releaseText('Pending admission observed.');
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === parent
          && event.messages.some(({ message }) => message.type === 'assistant-message' && message.content === 'Pending admission observed.'),
        'pending acknowledgment consumed', { afterIndex: cursor },
      );
      child.expectAbort();
      const requestCount = model.requests().length;
      await fixture.restartGarcon();
      expect(model.requests()).toHaveLength(requestCount);
      expect((await fixture.client.getChatSnapshot(admitted.chatId)).chat.title).toBe('Synthetic pending child');
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === admitted.chatId)?.parentChat)
        .toEqual({ chatId: parent, relation: 'delegation' });
      const next = model.holdNext({ lastUserTextIncludes: 'Fresh turn after restart.' });
      const nextCursor = fixture.client.markEvents();
      const fresh = await fixture.client.runDirectChat({ chatId: admitted.chatId, content: 'Fresh turn after restart.', agent });
      await next.received;
      next.releaseText('Fresh result has no recovered callback.');
      await fixture.client.waitForTurnTerminal(admitted.chatId, fresh.turnId!, { afterIndex: nextCursor });
      const notices = messagesOfType((await fixture.client.getMessages(parent)).messages, 'transcript-notice')
        .filter((notice) => notice.detail?.type === 'agent-start-outcome');
      expect(notices.map((notice) => notice.detail)).toEqual([admitted]);
      expect(model.requests()).toHaveLength(requestCount + 1);
    });
  }, 60_000);

  for (const crossAgent of [false, true]) test(`${crossAgent ? 'cross-agent' : 'same-agent'} snapshot child resumes and reports exact turns`, async () => {
    await withIntegrationFixture(`child-results-${crossAgent}`, async (fixture) => {
      const parentAgent = fixture.directAgents.openAiResponses;
      const childAgent = crossAgent ? fixture.directAgents.openAi : parentAgent;
      const parentModel = fixture.fakeProviders.openAiResponses;
      const childModel = crossAgent ? fixture.fakeProviders.openAi : parentModel;
      const parent = fixture.newChatId();
      const prompt = 'Review the synthetic snapshot.';
      const childPrompt = 'Inspect the copied discussion.';
      const carriedPrompt = '<carried-context version="3">\n'
        + '  <instructions>Previous conversation context follows. Continue from it without repeating it.</instructions>\n'
        + '  <transcript>\n    <user>Review the synthetic snapshot.</user>\n'
        + '    <assistant>Copied source conclusion.</assistant>\n  </transcript>\n</carried-context>\n\n'
        + childPrompt;
      const followup = 'Inspect the next synthetic revision.';
      const initial = parentModel.holdNext({ lastUserText: prompt });
      const child = childModel.holdNext({ lastUserText: carriedPrompt });
      const acknowledgment = parentModel.holdNext({ lastUserTextIncludes: 'status="accepted"' });
      const result = parentModel.holdNext({ lastUserTextIncludes: 'status="completed"' });
      const cursor = fixture.client.markEvents();
      await fixture.client.startDirectChat({ chatId: parent, projectPath: fixture.dirs.project, content: prompt, agent: parentAgent });
      await initial.received;
      initial.releaseText(`Copied source conclusion.\n<garcon-start-agent ref="snapshot" fork="true" title="Synthetic snapshot review" agent="${childAgent.agentId}" provider="${childAgent.provider.providerId}" model="${childAgent.provider.model}">${childPrompt}</garcon-start-agent>`);
      const admitted = await outcome(fixture, parent, 'snapshot', 'accepted', cursor);
      if (admitted.status !== 'accepted') throw new Error('Child was not admitted');
      const request = await child.received;
      expect(request.lastUserText).toBe(carriedPrompt);
      const serialized = JSON.stringify(request.body);
      expect(serialized).toContain(prompt);
      expect(serialized).toContain('Copied source conclusion.');
      expect(serialized).not.toContain('Later parent output.');
      expect(serialized.split(childPrompt)).toHaveLength(2);
      expect((await fixture.client.getChatSnapshot(admitted.chatId)).chat.title).toBe('Synthetic snapshot review');
      expect((await acknowledgment.received).lastUserText).toBe(garconCommandResultContent(admitted));
      acknowledgment.releaseText('Later parent output.');
      child.releaseText('Only the new child answer.');
      const completed = await outcome(fixture, parent, 'snapshot', 'completed', cursor);
      expect(completed).toMatchObject({ output: { availability: 'available', text: 'Only the new child answer.', completeness: 'complete' } });
      expect((await result.received).lastUserText).toBe(garconCommandResultContent(completed));
      const resumedChild = childModel.holdNext({ lastUserText: followup });
      const resumeAck = parentModel.holdNext({ lastUserTextIncludes: 'status="accepted"' });
      const resumeResult = parentModel.holdNext({ lastUserTextIncludes: 'status="completed"' });
      result.releaseText(`<garcon-resume-agent ref="followup" chat-id="${admitted.chatId}">${followup}</garcon-resume-agent>`);
      const resumed = await outcome(fixture, parent, 'followup', 'accepted', cursor);
      expect(resumed).toMatchObject({ type: 'agent-resume-outcome', chatId: admitted.chatId });
      expect((await resumedChild.received).lastUserText).toBe(followup);
      expect((await resumeAck.received).lastUserText).toBe(garconCommandResultContent(resumed));
      resumeAck.releaseText('Resume admission received.');
      resumedChild.releaseText('Only the resumed answer.');
      const resumedResult = await outcome(fixture, parent, 'followup', 'completed', cursor);
      expect(resumedResult).toMatchObject({ output: { text: 'Only the resumed answer.' } });
      expect((await resumeResult.received).lastUserText).toBe(garconCommandResultContent(resumedResult));
      resumeResult.releaseText('Resume completion received.');
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === parent
          && event.messages.some(({ message }) => message.type === 'assistant-message' && message.content === 'Resume completion received.'),
        'resume completion acknowledged', { afterIndex: cursor },
      );
      const parentHistory = await fixture.client.getMessages(parent);
      expect(userContents(parentHistory.messages)).toEqual([prompt]);
      const childHistory = await fixture.client.getMessages(admitted.chatId);
      expect(userContents(childHistory.messages)).toEqual([prompt, childPrompt, followup]);
      const beforeRestart = childHistory.messages;
      const persisted: ChatRegistrySnapshot = JSON.parse(await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'));
      expect(persisted.sessions[admitted.chatId]?.preambleSelection).toEqual({ revision: 0, orderedPreambleIds: [] });
      const requestCount = childModel.requests().length;
      await fixture.restartGarcon();
      expect((await fixture.client.getChatSnapshot(admitted.chatId)).chat.title).toBe('Synthetic snapshot review');
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === admitted.chatId)?.parentChat)
        .toEqual({ chatId: parent, relation: 'delegation' });
      await fixture.client.deleteChat(parent);
      expect((await fixture.client.getMessages(admitted.chatId)).messages).toEqual(beforeRestart);
      expect(childModel.requests()).toHaveLength(requestCount);
    });
  }, 60_000);
});
