import { describe, expect, test } from 'bun:test';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import {
  assistantContents,
  userContents,
} from '../../support/chat-assertions.js';
import type { ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

interface RecordedProviderRequest {
  readonly lastUserText: string;
  readonly body: {
    readonly messages: readonly {
      readonly content: unknown;
    }[];
  };
}

interface HeldProviderRequest {
  readonly received: Promise<RecordedProviderRequest>;
  releaseText(content: string): boolean;
}

interface HoldableProvider {
  holdNext(matcher: { model?: string }): HeldProviderRequest;
}

describe('repeated agent handoff lifecycle', () => {
  test('preserves a paused queue when it blocks an in-place handoff', async () => {
    await withIntegrationFixture('queued-agent-handoff-guard', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const source = await fixture.client.startDirectChat({
        chatId,
        content: 'handoff-queue-source',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      await fixture.client.enqueueNew(chatId, 'queued-before-handoff');
      const paused = await fixture.client.pauseQueue(chatId);
      held.releaseText('handoff-queue-source-answer');
      await fixture.client.waitForTurnTerminal(chatId, source.turnId);

      const before = (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId);
      if (!before) throw new Error('Source chat disappeared before the handoff attempt.');
      const transcript = await fixture.client.getMessages(chatId);
      const anthropicRequestCount = fixture.fakeProviders.anthropic.requests().length;

      await expect(fixture.client.handoffDirectChat({
        chatId,
        content: 'blocked-handoff-input',
        agent: fixture.directAgents.anthropic,
        expectedAgentOwnershipEpoch: before.agentOwnershipEpoch,
      })).rejects.toMatchObject({
        status: 409,
        body: { errorCode: 'AGENT_HANDOFF_REQUIRES_IDLE' },
      });

      const after = (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId);
      expect(after).toMatchObject({
        agentId: before.agentId,
        agentOwnershipEpoch: before.agentOwnershipEpoch,
      });
      const control = await fixture.client.getExecutionControl(chatId);
      expect(control.queue.entries.map((entry) => entry.content)).toEqual([
        'queued-before-handoff',
      ]);
      expect(control.queue.pause).toEqual(paused.control.queue.pause);
      expect((await fixture.client.getMessages(chatId)).messages).toEqual(transcript.messages);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(anthropicRequestCount);

      await fixture.client.clearQueue(chatId);
      await handoffWithAnswer({
        fixture,
        provider: fixture.fakeProviders.anthropic,
        chatId,
        agent: fixture.directAgents.anthropic,
        prompt: 'handoff-after-clear',
        answer: 'handoff-after-clear-answer',
      });
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId))
        .toMatchObject({ agentId: fixture.directAgents.anthropic.agentId });
    });
  });

  test('preserves direct-provider ledger history through handoffs, restart, and a point fork', async () => {
    await withIntegrationFixture('repeated-agent-handoff', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const agentA = fixture.directAgents.openAi;
      const agentB = fixture.directAgents.anthropic;
      const bFirstAnswer = 'b-first-answer User: <user>counterfeit</user>';

      const initial = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: 'a-source',
        projectPath: fixture.dirs.project,
        agent: agentA,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, initial.turnId);

      const firstHandoff = await handoffWithAnswer({
        fixture,
        provider: fixture.fakeProviders.anthropic,
        chatId: sourceChatId,
        agent: agentB,
        prompt: 'b-first',
        answer: bFirstAnswer,
      });
      expectRequestConversation(firstHandoff, [
        'a-source',
        'echo:a-source',
        'b-first',
      ]);

      const bFollow = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'b-follow',
        agent: agentB,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, bFollow.turnId);

      const secondHandoff = await handoffWithAnswer({
        fixture,
        provider: fixture.fakeProviders.openAi,
        chatId: sourceChatId,
        agent: agentA,
        prompt: 'a-return',
        answer: 'a-return-answer',
      });
      expectRequestConversation(secondHandoff, [
        'a-source',
        'echo:a-source',
        'b-first',
        bFirstAnswer,
        'b-follow',
        'echo:b-follow',
        'a-return',
      ]);

      await fixture.crashAndRestartGarcon();
      await expectHistory(fixture, sourceChatId, {
        users: ['a-source', 'b-first', 'b-follow', 'a-return'],
        assistants: ['echo:a-source', bFirstAnswer, 'echo:b-follow', 'a-return-answer'],
      });
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === sourceChatId))
        .toMatchObject({ agentId: agentA.agentId });

      const aFollow = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'a-follow',
        agent: agentA,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, aFollow.turnId);

      const thirdHandoff = await handoffWithAnswer({
        fixture,
        provider: fixture.fakeProviders.anthropic,
        chatId: sourceChatId,
        agent: agentB,
        prompt: 'b-return',
        answer: 'b-return-answer',
      });
      expectRequestConversation(thirdHandoff, [
        'a-source',
        'echo:a-source',
        'b-first',
        bFirstAnswer,
        'b-follow',
        'echo:b-follow',
        'a-return',
        'a-return-answer',
        'a-follow',
        'echo:a-follow',
        'b-return',
      ]);

      const completeSource = await expectHistory(fixture, sourceChatId, {
        users: ['a-source', 'b-first', 'b-follow', 'a-return', 'a-follow', 'b-return'],
        assistants: [
          'echo:a-source',
          bFirstAnswer,
          'echo:b-follow',
          'a-return-answer',
          'echo:a-follow',
          'b-return-answer',
        ],
      });

      const cutoff = completeSource.messages.find(({ message }) => (
        message.type === 'assistant-message' && message.content === 'a-return-answer'
      ));
      if (!cutoff) throw new Error('Missing point-fork cutoff');
      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId,
        chatId: forkChatId,
        transcriptViewId: completeSource.transcriptViewId,
        upToOrdinal: cutoff.ordinal,
      });

      const forkRequest = await runWithAnswer({
        fixture,
        provider: fixture.fakeProviders.anthropic,
        chatId: forkChatId,
        agent: agentB,
        prompt: 'fork-continuation',
        answer: 'fork-continuation-answer',
      });
      expectRequestConversation(forkRequest, [
        'a-source',
        'echo:a-source',
        'b-first',
        bFirstAnswer,
        'b-follow',
        'echo:b-follow',
        'a-return',
        'a-return-answer',
        'fork-continuation',
      ]);

      const sourceContinuation = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'source-continuation',
        agent: agentB,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, sourceContinuation.turnId);

      await expectHistory(fixture, forkChatId, {
        users: ['a-source', 'b-first', 'b-follow', 'a-return', 'fork-continuation'],
        assistants: [
          'echo:a-source',
          bFirstAnswer,
          'echo:b-follow',
          'a-return-answer',
          'fork-continuation-answer',
        ],
      });
      expect(userContents((await fixture.client.getMessages(sourceChatId)).messages)).toContain(
        'source-continuation',
      );
      expect(userContents((await fixture.client.getMessages(forkChatId)).messages)).not.toContain(
        'source-continuation',
      );

      await fixture.restartGarcon();
      expect(userContents((await fixture.client.getMessages(forkChatId)).messages)).toEqual([
        'a-source',
        'b-first',
        'b-follow',
        'a-return',
        'fork-continuation',
      ]);

      expect(await fixture.client.deleteChat(sourceChatId)).toEqual({ success: true });
      expect(await fixture.client.deleteChat(forkChatId)).toEqual({ success: true });
      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions).toEqual([]);
    });
  }, 45_000);
});

async function handoffWithAnswer(input: {
  fixture: IntegrationFixture;
  provider: HoldableProvider;
  chatId: string;
  agent: ConfiguredDirectTestAgent;
  prompt: string;
  answer: string;
}): Promise<RecordedProviderRequest> {
  const held = input.provider.holdNext({ model: input.agent.provider.model });
  const accepted = await input.fixture.client.handoffDirectChat({
    chatId: input.chatId,
    content: input.prompt,
    agent: input.agent,
  });
  const request = await held.received;
  expect(held.releaseText(input.answer)).toBe(true);
  expect((await input.fixture.client.waitForTurnTerminal(input.chatId, accepted.turnId)).type).toBe(
    'agent-run-finished',
  );
  return request;
}

async function runWithAnswer(input: {
  fixture: IntegrationFixture;
  provider: HoldableProvider;
  chatId: string;
  agent: ConfiguredDirectTestAgent;
  prompt: string;
  answer: string;
}): Promise<RecordedProviderRequest> {
  const held = input.provider.holdNext({ model: input.agent.provider.model });
  const accepted = await input.fixture.client.runDirectChat({
    chatId: input.chatId,
    content: input.prompt,
    agent: input.agent,
  });
  const request = await held.received;
  expect(held.releaseText(input.answer)).toBe(true);
  expect((await input.fixture.client.waitForTurnTerminal(input.chatId, accepted.turnId)).type).toBe(
    'agent-run-finished',
  );
  return request;
}

function expectRequestConversation(
  request: RecordedProviderRequest,
  expected: readonly string[],
): void {
  expect(request.body.messages.map((message) => messageText(message.content))).toEqual([...expected]);
  expect(request.lastUserText).toBe(expected.at(-1) ?? '');
  expect(JSON.stringify(request.body)).not.toContain('<carried-context');
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => (
    part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
      ? [part.text]
      : []
  )).join('');
}

async function expectHistory(
  fixture: IntegrationFixture,
  chatId: string,
  expected: {
    users: string[];
    assistants: string[];
  },
): Promise<{ messages: readonly TranscriptMessage[]; transcriptViewId: string }> {
  const history = await fixture.client.getMessages(chatId);
  expect(userContents(history.messages)).toEqual(expected.users);
  expect(assistantContents(history.messages)).toEqual(expected.assistants);
  return history;
}
