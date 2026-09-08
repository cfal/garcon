import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatRegistrySnapshot } from '../../../server/chats/store.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import type { PreamblesMutationResponse } from '../../../common/preambles.js';
import { garconCommandResultContent } from '../../../common/garcon-command-results.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

async function waitForOutcome(fixture: IntegrationFixture, chatId: string, type: 'agent-start-outcome' | 'agent-schedule-outcome', cursor: number) {
  const event = await fixture.client.waitForEvent(
    (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === chatId
      && event.messages.some(({ message }) => message.type === 'transcript-notice' && message.detail?.type === type),
    type, { afterIndex: cursor },
  );
  const notice = messagesOfType(event.messages, 'transcript-notice').find((message) => message.detail?.type === type);
  if (!notice?.detail || notice.detail.type !== type) throw new Error('Missing action outcome');
  return notice.detail;
}

describe('assistant start and schedule commands', () => {
  test.each([false, true])('resolves provider display names before child admission (ambiguous: %s)', async (ambiguous) => {
    await withIntegrationFixture(`agent-command-provider-name-${ambiguous}`, async (fixture) => {
      const agent = fixture.directAgents.openAi;
      if (ambiguous) await fixture.client.createOpenAiProvider(fixture.fakeProviders.openAi.baseUrl);
      const providerName = (await fixture.client.listAgentCatalog()).apiProviders
        .find((provider) => provider.id === agent.provider.providerId)?.label;
      if (!providerName) throw new Error('Missing fixture provider');
      const source = fixture.newChatId();
      const prompt = 'Request a child through a named provider.';
      const childPrompt = 'Synthetic named-provider child task.';
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: prompt });
      const cursor = fixture.client.markEvents();
      await fixture.client.startDirectChat({ chatId: source, content: prompt, projectPath: fixture.dirs.project, agent });
      await held.received;
      held.releaseText(`<garcon-start-agent ref="named-provider" async="true" agent="${agent.agentId}" provider="${providerName}" model="${agent.provider.model}">${childPrompt}</garcon-start-agent>`);
      const outcome = await waitForOutcome(fixture, source, 'agent-start-outcome', cursor);
      expect(outcome).toMatchObject({ type: 'agent-start-outcome', ref: 'named-provider', async: true });
      if (ambiguous) {
        expect(outcome).toMatchObject({ status: 'rejected', reason: 'ambiguous-provider' });
        expect(outcome).not.toHaveProperty('chatId');
      } else {
        expect(outcome.status).toBe('accepted');
        if (outcome.type !== 'agent-start-outcome' || outcome.status !== 'accepted') throw new Error('Missing child');
        expect((await fixture.fakeProviders.openAi.waitForRequest({ lastUserText: childPrompt })).lastUserText).toBe(childPrompt);
        const persisted: ChatRegistrySnapshot = JSON.parse(await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'));
        expect(persisted.sessions[outcome.chatId]).toMatchObject({
          apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
          parentChat: { chatId: source, relation: 'delegation' },
        });
      }
      const control = await fixture.fakeProviders.openAi.waitForRequest({ lastUserText: garconCommandResultContent(outcome) });
      expect(control.lastUserText).toBe(garconCommandResultContent(outcome));
      expect((await fixture.client.listChats()).sessions).toHaveLength(ambiguous ? 1 : 2);
      if (ambiguous) expect(fixture.fakeProviders.openAi.requests().some((request) => request.lastUserText === childPrompt)).toBe(false);
      expect(userContents((await fixture.client.getMessages(source)).messages)).toEqual([prompt]);
    });
  }, 60_000);

  test('delivers an empty scheduled action through the actual UTC cron job as ordinary same-chat input', async () => {
    await withIntegrationFixture('agent-command-cron-delivery', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const source = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Schedule the synthetic action.' });
      const action = fixture.fakeProviders.openAi.holdNext({ lastUserText: '<garcon-schedule-action />' });
      const cursor = fixture.client.markEvents();
      await fixture.client.startDirectChat({ chatId: source, content: 'Schedule the synthetic action.', projectPath: fixture.dirs.project, agent });
      await held.received;
      const now = Date.now();
      let next = Math.floor(now / 60_000) * 60_000 + 60_000;
      if (next - now < 10_000) next += 60_000;
      held.releaseText(`<garcon-schedule at="${new Date(next).toISOString()}" />`);
      expect(await waitForOutcome(fixture, source, 'agent-schedule-outcome', cursor)).toMatchObject({ status: 'created' });
      const received = await fixture.fakeProviders.openAi.waitForRequest(
        { lastUserText: '<garcon-schedule-action />' }, { timeoutMs: 90_000 },
      );
      expect(received.lastUserText).toBe('<garcon-schedule-action />');
      action.releaseText('Scheduled action complete.');
      expect(userContents((await fixture.client.getMessages(source)).messages))
        .toEqual(['Schedule the synthetic action.', '<garcon-schedule-action />']);
      expect((await fixture.client.listChats()).sessions).toHaveLength(1);
      expect((await fixture.client.getScheduledPrompts()).prompts).toEqual([]);
    });
  }, 120_000);
  test('creates one independent child with persisted parentage and schedules wrapped input in the source chat', async () => {
    await withIntegrationFixture('agent-command-creation', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const source = fixture.newChatId();
      const prompt = 'Start a synthetic child and schedule a follow-up.';
      const childPrompt = 'Perform the independent synthetic task.';
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: prompt });
      const child = fixture.fakeProviders.openAi.holdNext({ lastUserText: childPrompt });
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startDirectChat({ chatId: source, content: prompt, projectPath: fixture.dirs.project, agent });
      await held.received;
      held.releaseText(`<garcon-start-agent ref="task" async="true" agent="${agent.agentId}" provider="${agent.provider.providerId}" model="${agent.provider.model}">${childPrompt}</garcon-start-agent>\n<garcon-schedule every="5m">Review task {{chat_id}} &amp; report.</garcon-schedule>`);
      const [startOutcome, scheduleOutcome, childRequest] = await Promise.all([
        waitForOutcome(fixture, source, 'agent-start-outcome', cursor),
        waitForOutcome(fixture, source, 'agent-schedule-outcome', cursor),
        child.received,
      ]);
      expect(startOutcome).toMatchObject({ status: 'accepted' });
      if (startOutcome.type !== 'agent-start-outcome' || startOutcome.status !== 'accepted') throw new Error('Child was not created');
      expect(scheduleOutcome).toMatchObject({ status: 'created', intervalMinutes: 5, busyBehavior: 'queue' });
      expect(childRequest.lastUserText).toBe(childPrompt);
      child.releaseText('Synthetic child complete.');
      const chats = await fixture.client.listChats();
      expect(chats.sessions).toHaveLength(2);
      const created = chats.sessions.find((chat) => chat.id === startOutcome.chatId);
      expect(created).toMatchObject({ parentChat: { chatId: source, relation: 'delegation' }, projectPath: fixture.dirs.project, permissionMode: 'default' });
      const schedules = await fixture.client.getScheduledPrompts();
      expect(schedules.prompts).toHaveLength(1);
      expect(schedules.prompts[0]).toMatchObject({
        target: { type: 'existing-chat', chatId: source, busyBehavior: 'queue' },
        prompt: '<garcon-schedule-action>\nReview task {{chat_id}} &amp; report.\n</garcon-schedule-action>',
      });
      await fixture.client.waitForTurnTerminal(source, started.turnId, { afterIndex: cursor });
      await fixture.client.waitForProcessing(source, false, { afterIndex: cursor });
      const transcript = await fixture.client.getMessages(source);
      expect(userContents(transcript.messages)).toEqual([prompt]);
      expect(messagesOfType(transcript.messages, 'transcript-notice').filter((notice) => notice.detail?.type === 'agent-start-outcome')).toHaveLength(1);
      expect(messagesOfType(transcript.messages, 'transcript-notice').filter((notice) => notice.detail?.type === 'agent-schedule-outcome')).toHaveLength(1);
      expect(fixture.fakeProviders.openAi.requests().some((request) => request.lastUserText.startsWith('<garcon-start-agent-result '))).toBe(true);
      expect(fixture.fakeProviders.openAi.requests().some((request) => request.lastUserText.startsWith('<garcon-schedule-result '))).toBe(true);
      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === startOutcome.chatId)?.parentChat)
        .toEqual({ chatId: source, relation: 'delegation' });
      expect((await fixture.client.getScheduledPrompts()).prompts).toHaveLength(1);
    });
  }, 60_000);

  test('starts without preambles even when enabled defaults would block a slash command', async () => {
    await withIntegrationFixture('agent-command-no-preambles', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const source = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Request a child.' });
      const cursor = fixture.client.markEvents();
      await fixture.client.startDirectChat({ chatId: source, content: 'Request a child.', projectPath: fixture.dirs.project, agent });
      await held.received;
      await fixture.client.post<PreamblesMutationResponse>('/api/v1/preambles', {
        expectedRevision: 0,
        preamble: { enabled: true, title: 'Synthetic default', content: 'Synthetic boundary instructions.', scope: { type: 'global' } },
      });
      held.releaseText(`<garcon-start-agent ref="task" async="true" agent="${agent.agentId}" provider="${agent.provider.providerId}" model="${agent.provider.model}">/synthetic-command</garcon-start-agent>`);
      const outcome = await waitForOutcome(fixture, source, 'agent-start-outcome', cursor);
      expect(outcome).toMatchObject({ status: 'accepted' });
      if (outcome.type !== 'agent-start-outcome' || outcome.status !== 'accepted') throw new Error('Missing child');
      const received = await fixture.fakeProviders.openAi.waitForRequest({ lastUserText: '/synthetic-command' });
      expect(received.lastUserText).toBe('/synthetic-command');
      const chats = await fixture.client.listChats();
      expect(chats.sessions).toHaveLength(2);
      expect(chats.sessions.find((chat) => chat.id === outcome.chatId)?.parentChat).toEqual({ chatId: source, relation: 'delegation' });
      const child = await fixture.client.getMessages(outcome.chatId);
      expect(userContents(child.messages)).toEqual(['/synthetic-command']);
      expect(messagesOfType(child.messages, 'transcript-notice').some((notice) => notice.detail?.type === 'preamble-application')).toBe(false);
      const persisted: ChatRegistrySnapshot = JSON.parse(await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'));
      const registry = persisted.sessions[outcome.chatId]!;
      expect(registry.preambleSelection).toEqual({ revision: 0, orderedPreambleIds: [] });
    });
  }, 60_000);
});
