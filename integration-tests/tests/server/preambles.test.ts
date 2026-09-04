import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Preamble,
  PreambleDefinitionInput,
  PreamblesMutationResponse,
  PreamblesSnapshot,
} from '../../../common/preambles.js';
import type { AgentRunFailedMessage } from '../../../common/ws-events.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import type { ChatMessagesPage } from '../../support/garcon-client.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

async function createPreamble(
  fixture: IntegrationFixture,
  revision: number,
  preamble: PreambleDefinitionInput,
): Promise<PreamblesMutationResponse> {
  return fixture.client.post('/api/v1/preambles', {
    expectedRevision: revision,
    preamble,
  });
}

function applicationTitles(snapshot: ChatMessagesPage): string[][] {
  return messagesOfType(snapshot.messages, 'transcript-notice')
    .filter((message) => message.detail?.type === 'preamble-application')
    .map((message) => message.detail?.type === 'preamble-application'
      ? message.detail.preambles.map((preamble) => preamble.title)
      : []);
}

function expectApplicationImmediatelyBefore(
  snapshot: ChatMessagesPage,
  userContent: string,
  titles: readonly string[],
): void {
  const userIndex = snapshot.messages.findIndex(({ message }) => (
    message.type === 'user-message' && message.content === userContent
  ));
  expect(userIndex).toBeGreaterThan(0);
  expect(snapshot.messages[userIndex - 1]?.message).toMatchObject({
    type: 'transcript-notice',
    detail: {
      type: 'preamble-application',
      preambles: titles.map((title) => ({ title })),
    },
  });
}

async function expectPreambleSlashBlocked(request: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await request;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(GarconApiError);
  expect(failure).toMatchObject({
    status: 422,
    body: {
      errorCode: 'PREAMBLE_SLASH_COMMAND_BLOCKED',
      error: 'Matching preambles haven’t been sent yet. Start with a regular message before using provider slash commands.',
    },
  });
}

const MINUTE_MS = 60_000;

function nextScheduledRun(now = Date.now()): string {
  let nextRunAt = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  if (nextRunAt - now < 10_000) nextRunAt += MINUTE_MS;
  return new Date(nextRunAt).toISOString();
}

describe('preambles', () => {
  test('[TLV5-PREAMBLE.03-SERVER-01] applies ordered current preambles once at every boundary', async () => {
    await withIntegrationFixture('preambles', async (fixture) => {
      const nestedProject = join(fixture.dirs.project, 'nested');
      await mkdir(nestedProject, { recursive: true });

      const definitions: PreambleDefinitionInput[] = [
        {
          enabled: true,
          title: 'Global opening',
          content: 'SYNTHETIC_GLOBAL_OPENING_BODY',
          scope: { type: 'global' },
        },
        {
          enabled: true,
          title: 'Nested project',
          content: 'SYNTHETIC_NESTED_PROJECT_BODY',
          scope: {
            type: 'project-paths',
            rules: [{ projectPath: fixture.dirs.project, includeNested: true }],
          },
        },
        {
          enabled: true,
          title: 'Global closing',
          content: 'SYNTHETIC_GLOBAL_CLOSING_BODY',
          scope: { type: 'global' },
        },
        {
          enabled: false,
          title: 'Disabled global',
          content: 'SYNTHETIC_DISABLED_GLOBAL_BODY',
          scope: { type: 'global' },
        },
      ];

      let catalog: PreamblesSnapshot = { revision: 0, preambles: [] };
      for (const definition of definitions) {
        catalog = (await createPreamble(fixture, catalog.revision, definition)).snapshot;
      }
      expect(catalog.preambles.map((preamble) => preamble.title)).toEqual([
        'Global opening',
        'Nested project',
        'Global closing',
        'Disabled global',
      ]);

      const sourceChatId = fixture.newChatId();
      const firstHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const first = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: 'first visible prompt',
        projectPath: nestedProject,
        agent: fixture.directAgents.openAi,
      });
      const firstProviderRequest = await firstHeld.received;
      expect(firstProviderRequest.lastUserText).toMatch(
        /^<garcon-preambles version="1" application="[a-f0-9]{64}">\nSYNTHETIC_GLOBAL_OPENING_BODY\n\nSYNTHETIC_NESTED_PROJECT_BODY\n\nSYNTHETIC_GLOBAL_CLOSING_BODY\n<\/garcon-preambles>\n\n<!-- garcon-preamble-input --> first visible prompt$/u,
      );
      expect(firstProviderRequest.lastUserText).not.toContain('SYNTHETIC_DISABLED_GLOBAL_BODY');
      expect(firstHeld.releaseText('first synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(sourceChatId, first.turnId);

      const firstHistory = await fixture.client.getMessages(sourceChatId);
      expect(firstHistory.messages.map((entry) => entry.message.type)).toEqual([
        'transcript-notice',
        'user-message',
        'assistant-message',
      ]);
      expect(applicationTitles(firstHistory)).toEqual([[
        'Global opening',
        'Nested project',
        'Global closing',
      ]]);
      expect(userContents(firstHistory.messages)).toEqual(['first visible prompt']);
      expect(JSON.stringify(firstHistory)).not.toContain('SYNTHETIC_GLOBAL_OPENING_BODY');
      expect(JSON.stringify(firstHistory)).not.toContain('SYNTHETIC_NESTED_PROJECT_BODY');
      expect(JSON.stringify(firstHistory)).not.toContain('SYNTHETIC_GLOBAL_CLOSING_BODY');
      expectApplicationImmediatelyBefore(firstHistory, 'first visible prompt', [
        'Global opening',
        'Nested project',
        'Global closing',
      ]);

      const ordinaryHeld = fixture.fakeProviders.openAi.holdNext({
        lastUserText: 'ordinary visible prompt',
      });
      const ordinary = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'ordinary visible prompt',
        agent: fixture.directAgents.openAi,
      });
      await ordinaryHeld.received;
      expect(ordinaryHeld.releaseText('ordinary synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(sourceChatId, ordinary.turnId);
      expect(applicationTitles(await fixture.client.getMessages(sourceChatId))).toHaveLength(1);

      const slashForkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: slashForkChatId });
      let slashFailure: unknown;
      try {
        await fixture.client.runDirectChat({
          chatId: slashForkChatId,
          content: '/provider-command',
          agent: fixture.directAgents.openAi,
        });
      } catch (error) {
        slashFailure = error;
      }
      expect(slashFailure).toBeInstanceOf(GarconApiError);
      expect(slashFailure).toMatchObject({
        status: 422,
        body: {
          errorCode: 'PREAMBLE_SLASH_COMMAND_BLOCKED',
          error: 'Matching preambles haven\u2019t been sent yet. Start with a regular message before using provider slash commands.',
        },
      });
      expect(userContents((await fixture.client.getMessages(slashForkChatId)).messages)).not.toContain(
        '/provider-command',
      );

      const afterSlashHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const afterSlash = await fixture.client.runDirectChat({
        chatId: slashForkChatId,
        content: 'regular message after blocked slash command',
        agent: fixture.directAgents.openAi,
      });
      const afterSlashRequest = await afterSlashHeld.received;
      expect(afterSlashRequest.lastUserText).toContain('SYNTHETIC_GLOBAL_OPENING_BODY');
      expect(afterSlashRequest.lastUserText).not.toContain('SYNTHETIC_DISABLED_GLOBAL_BODY');
      expect(afterSlashHeld.releaseText('after slash synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(slashForkChatId, afterSlash.turnId);
      expect(applicationTitles(await fixture.client.getMessages(slashForkChatId))).toHaveLength(2);

      const queuedSlashForkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: queuedSlashForkChatId });
      const queuedSlashCursor = fixture.client.markEvents();
      await fixture.client.enqueueNew(queuedSlashForkChatId, '/queued-provider-command');
      const queuedSlashFailure = await fixture.client.waitForEvent(
        (event): event is AgentRunFailedMessage => (
          event.type === 'agent-run-failed' && event.chatId === queuedSlashForkChatId
        ),
        'queued preamble slash-command rejection',
        { afterIndex: queuedSlashCursor },
      );
      expect(queuedSlashFailure.error).toContain('Matching preambles haven’t been sent yet');
      expect((await fixture.client.getExecutionControl(queuedSlashForkChatId)).queue.entries)
        .toHaveLength(0);
      expect(userContents((await fixture.client.getMessages(queuedSlashForkChatId)).messages))
        .not.toContain('/queued-provider-command');

      const queuedRegularHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const queuedRegularCursor = fixture.client.markEvents();
      await fixture.client.enqueueNew(queuedSlashForkChatId, 'queued regular message');
      const queuedRegularRequest = await queuedRegularHeld.received;
      expect(queuedRegularRequest.lastUserText).toContain('SYNTHETIC_GLOBAL_OPENING_BODY');
      expect(queuedRegularRequest.lastUserText).toEndWith('queued regular message');
      expect(queuedRegularHeld.releaseText('queued regular response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(queuedSlashForkChatId, undefined, {
        afterIndex: queuedRegularCursor,
      });
      expectApplicationImmediatelyBefore(
        await fixture.client.getMessages(queuedSlashForkChatId),
        'queued regular message',
        ['Global opening', 'Nested project', 'Global closing'],
      );

      const opening = catalog.preambles[0] as Preamble;
      const updated = await fixture.client.put<PreamblesMutationResponse>('/api/v1/preambles', {
        expectedRevision: catalog.revision,
        id: opening.id,
        preamble: {
          enabled: true,
          title: 'Global opening current',
          content: 'SYNTHETIC_CURRENT_OPENING_BODY',
          scope: { type: 'global' },
        },
      });
      catalog = updated.snapshot;

      const targetChatId = fixture.newChatId();
      const forkHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const fork = await fixture.client.forkRunChat({
        sourceChatId,
        chatId: targetChatId,
        command: 'fork visible prompt',
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        permissionMode: 'default',
        thinkingMode: 'none',
        model: fixture.directAgents.openAi.provider.model,
        apiProviderId: fixture.directAgents.openAi.provider.providerId,
        modelEndpointId: fixture.directAgents.openAi.provider.endpointId,
        modelProtocol: fixture.directAgents.openAi.provider.protocol,
      });
      const forkProviderRequest = await forkHeld.received;
      expect(forkProviderRequest.lastUserText).toContain('SYNTHETIC_CURRENT_OPENING_BODY');
      expect(forkProviderRequest.lastUserText).toContain('SYNTHETIC_NESTED_PROJECT_BODY');
      expect(forkProviderRequest.lastUserText).toContain('SYNTHETIC_GLOBAL_CLOSING_BODY');
      expect(forkProviderRequest.lastUserText).not.toContain('SYNTHETIC_GLOBAL_OPENING_BODY');
      expect(forkProviderRequest.lastUserText).toEndWith('fork visible prompt');
      expect(forkHeld.releaseText('fork synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(targetChatId, fork.turnId);

      const forkHistory = await fixture.client.getMessages(targetChatId);
      expect(applicationTitles(forkHistory)).toEqual([
        ['Global opening', 'Nested project', 'Global closing'],
        ['Global opening current', 'Nested project', 'Global closing'],
      ]);
      expect(JSON.stringify(forkHistory)).not.toContain('SYNTHETIC_CURRENT_OPENING_BODY');
      expectApplicationImmediatelyBefore(forkHistory, 'fork visible prompt', [
        'Global opening current',
        'Nested project',
        'Global closing',
      ]);

      const continuationChatId = fixture.newChatId();
      const continuationHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const continuation = await fixture.client.post<{ chat: { id: string }; turnId?: string }>(
        '/api/v1/chats/handoff-run',
        {
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          sourceChatId,
          chatId: continuationChatId,
          command: 'continuation visible prompt',
        },
      );
      const continuationRequest = await continuationHeld.received;
      expect(continuationRequest.lastUserText).toContain('SYNTHETIC_CURRENT_OPENING_BODY');
      expect(continuationRequest.lastUserText).toContain('SYNTHETIC_NESTED_PROJECT_BODY');
      expect(continuationRequest.lastUserText).toContain('SYNTHETIC_GLOBAL_CLOSING_BODY');
      expect(continuationRequest.lastUserText).toEndWith('continuation visible prompt');
      expect(continuationHeld.releaseText('continuation synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(continuationChatId, continuation.turnId);

      const continuationHistory = await fixture.client.getMessages(continuationChatId);
      expect(applicationTitles(continuationHistory)).toEqual([
        ['Global opening', 'Nested project', 'Global closing'],
        ['Global opening current', 'Nested project', 'Global closing'],
      ]);
      expectApplicationImmediatelyBefore(continuationHistory, 'continuation visible prompt', [
        'Global opening current',
        'Nested project',
        'Global closing',
      ]);
      expect(JSON.stringify(continuationHistory)).not.toContain('SYNTHETIC_CURRENT_OPENING_BODY');

      const switchHeld = fixture.fakeProviders.anthropic.holdNext({
        model: fixture.directAgents.anthropic.provider.model,
      });
      const switched = await fixture.client.handoffDirectChat({
        chatId: sourceChatId,
        content: 'agent switch visible prompt',
        agent: fixture.directAgents.anthropic,
      });
      const switchRequest = await switchHeld.received;
      expect(switchRequest.lastUserText).toContain('SYNTHETIC_CURRENT_OPENING_BODY');
      expect(switchRequest.lastUserText).toContain('SYNTHETIC_NESTED_PROJECT_BODY');
      expect(switchRequest.lastUserText).toContain('SYNTHETIC_GLOBAL_CLOSING_BODY');
      expect(switchRequest.lastUserText).toEndWith('agent switch visible prompt');
      expect(switchHeld.releaseText('agent switch synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(sourceChatId, switched.turnId);

      const switchedHistory = await fixture.client.getMessages(sourceChatId);
      expect(applicationTitles(switchedHistory)).toEqual([
        ['Global opening', 'Nested project', 'Global closing'],
        ['Global opening current', 'Nested project', 'Global closing'],
      ]);
      expectApplicationImmediatelyBefore(switchedHistory, 'agent switch visible prompt', [
        'Global opening current',
        'Nested project',
        'Global closing',
      ]);
      expect(JSON.stringify(switchedHistory)).not.toContain('SYNTHETIC_CURRENT_OPENING_BODY');

      await fixture.restartGarcon();
      expect(applicationTitles(await fixture.client.getMessages(targetChatId))).toEqual([
        ['Global opening', 'Nested project', 'Global closing'],
        ['Global opening current', 'Nested project', 'Global closing'],
      ]);

      const resumedHeld = fixture.fakeProviders.openAi.holdNext({
        lastUserText: 'ordinary prompt after restart',
      });
      const resumed = await fixture.client.runDirectChat({
        chatId: targetChatId,
        content: 'ordinary prompt after restart',
        agent: fixture.directAgents.openAi,
      });
      const resumedRequest = await resumedHeld.received;
      expect(resumedRequest.lastUserText).not.toContain('SYNTHETIC_CURRENT_OPENING_BODY');
      expect(resumedHeld.releaseText('ordinary response after restart')).toBeTrue();
      await fixture.client.waitForTurnTerminal(targetChatId, resumed.turnId);
      expect(applicationTitles(await fixture.client.getMessages(targetChatId))).toHaveLength(2);
    });
  }, 60_000);

  test('retains newly prepared boundary chats after blocking an opening slash command', async () => {
    await withIntegrationFixture('preamble-slash-boundaries', async (fixture) => {
      const body = 'SYNTHETIC_RETAINED_BOUNDARY_BODY';
      await createPreamble(fixture, 0, {
        enabled: true,
        title: 'Retained boundary instructions',
        content: body,
        scope: { type: 'global' },
      });
      const agent = fixture.directAgents.openAi;

      const runRegularBoundary = async (
        chatId: string,
        content: string,
        expectedApplicationCount: number,
      ): Promise<void> => {
        const held = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
        const run = await fixture.client.runDirectChat({ chatId, content, agent });
        const providerRequest = await held.received;
        expect(providerRequest.lastUserText).toContain(body);
        expect(providerRequest.lastUserText).toEndWith(content);
        expect(held.releaseText(`response for ${content}`)).toBeTrue();
        await fixture.client.waitForTurnTerminal(chatId, run.turnId);
        const history = await fixture.client.getMessages(chatId);
        expect(applicationTitles(history)).toHaveLength(expectedApplicationCount);
        expectApplicationImmediatelyBefore(history, content, ['Retained boundary instructions']);
        expect(JSON.stringify(history)).not.toContain(body);
      };

      const newChatId = fixture.newChatId();
      const blockedStart = {
        chatId: newChatId,
        content: '/provider-command',
        projectPath: fixture.dirs.project,
        agent,
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
      };
      await expectPreambleSlashBlocked(fixture.client.startDirectChat(blockedStart));
      await expectPreambleSlashBlocked(fixture.client.startDirectChat(blockedStart));
      const blockedNewChat = (await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === newChatId,
      );
      expect(blockedNewChat).toMatchObject({
        title: 'New Session',
        preview: {
          firstMessage: 'New Session',
          lastMessage: 'New Session',
        },
      });
      expect(userContents((await fixture.client.getMessages(newChatId)).messages))
        .not.toContain('/provider-command');
      await runRegularBoundary(newChatId, 'regular new-chat message', 1);
      const admittedNewChat = (await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === newChatId,
      );
      expect(admittedNewChat?.title).toBe('regular new-chat message');
      expect(admittedNewChat?.preview.firstMessage).toBe('regular new-chat message');
      expect(admittedNewChat?.preview.lastMessage).not.toContain('/provider-command');

      const forkChatId = fixture.newChatId();
      await expectPreambleSlashBlocked(fixture.client.forkRunChat({
        sourceChatId: newChatId,
        chatId: forkChatId,
        command: '/provider-command',
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        permissionMode: 'default',
        thinkingMode: 'none',
        model: agent.provider.model,
        apiProviderId: agent.provider.providerId,
        modelEndpointId: agent.provider.endpointId,
        modelProtocol: agent.provider.protocol,
      }));
      expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === forkChatId))
        .toBeTrue();
      expect(userContents((await fixture.client.getMessages(forkChatId)).messages))
        .not.toContain('/provider-command');
      await runRegularBoundary(forkChatId, 'regular fork message', 2);

      const continuationChatId = fixture.newChatId();
      await expectPreambleSlashBlocked(fixture.client.post('/api/v1/chats/handoff-run', {
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        sourceChatId: newChatId,
        chatId: continuationChatId,
        command: '/provider-command',
      }));
      expect(
        (await fixture.client.listChats()).sessions.some((chat) => chat.id === continuationChatId),
      ).toBeTrue();
      expect(userContents((await fixture.client.getMessages(continuationChatId)).messages))
        .not.toContain('/provider-command');
      await runRegularBoundary(continuationChatId, 'regular continuation message', 2);
    });
  }, 60_000);

  test('applies preambles to scheduled new chats', async () => {
    await withIntegrationFixture('scheduled-preambles', async (fixture) => {
      const body = 'SYNTHETIC_SCHEDULED_PREAMBLE_BODY';
      await createPreamble(fixture, 0, {
        enabled: true,
        title: 'Scheduled instructions',
        content: body,
        scope: { type: 'global' },
      });

      const agent = fixture.directAgents.openAi;
      const initial = await fixture.client.getScheduledPrompts();
      await fixture.client.createScheduledPrompt({
        expectedRevision: initial.revision,
        scheduledPrompt: {
          schedule: { type: 'once', runAtUtc: nextScheduledRun() },
          target: {
            type: 'new-chat',
            agentId: agent.agentId,
            projectPath: fixture.dirs.project,
            model: agent.provider.model,
            apiProviderId: agent.provider.providerId,
            modelEndpointId: agent.provider.endpointId,
            modelProtocol: agent.provider.protocol,
            permissionMode: 'default',
            thinkingMode: 'none',
            agentSettingsById: { [agent.agentId]: agent.agentSettings },
            tags: ['scheduled-preamble'],
          },
          prompt: 'scheduled visible prompt',
        },
      });

      const providerRequest = await fixture.fakeProviders.openAi.waitForRequest(
        { model: agent.provider.model },
        { timeoutMs: 90_000 },
      );
      expect(providerRequest.lastUserText).toContain(body);
      expect(providerRequest.lastUserText).toEndWith('scheduled visible prompt');

      const chat = (await fixture.client.listChats()).sessions.find((entry) => (
        entry.tags.includes('scheduled-preamble')
      ));
      if (!chat) throw new Error('Scheduled preamble chat was not created.');
      const history = await fixture.client.getMessages(chat.id);
      expectApplicationImmediatelyBefore(history, 'scheduled visible prompt', [
        'Scheduled instructions',
      ]);
      expect(JSON.stringify(history)).not.toContain(body);
    });
  }, 120_000);
});
