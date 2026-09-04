import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type {
  PreambleDefinitionInput,
  PreamblesMutationResponse,
} from '../../../common/preambles.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { forkAfterSourceSettles } from '../../support/fork-test-support.js';
import type { ChatMessagesPage } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  reloadUntilNativeContains,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  liveClaudeRunRequest,
  liveClaudeStartRequest,
} from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

const PREAMBLE_BODY = 'SYNTHETIC_SCRIPTED_PROVIDER_PREAMBLE_BODY';
const PREAMBLE_TITLE = 'Scripted provider instructions';

describe('scripted provider preamble boundaries', () => {
  let claudeEnvironment: ScriptedClaudeTestEnvironment | undefined;
  let codexEnvironment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    claudeEnvironment = await startScriptedClaudeTestEnvironment();
    try {
      codexEnvironment = await startScriptedCodexTestEnvironment();
    } catch (error) {
      claudeEnvironment.dispose();
      claudeEnvironment = undefined;
      throw error;
    }
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      claudeEnvironment?.dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      await codexEnvironment?.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Scripted preamble environment cleanup failed.');
    }
  });

  test('delivers and reconstructs preambles across native boundaries', async () => {
    if (!claudeEnvironment || !codexEnvironment) {
      throw new Error('Scripted provider environments were not initialized.');
    }
    const claude = claudeEnvironment;
    const codex = codexEnvironment;

    await withIntegrationFixture('preambles-scripted-boundaries', async (fixture) => {
      await createGlobalPreamble(fixture);

      const sourceChatId = fixture.newChatId();
      const initialPrompt = 'scripted new chat prompt';
      const initialReply = 'scripted new chat reply';
      claude.model.scriptTurn([claudeText(initialReply)]);
      const initialRequestIndex = claude.model.requests().length;
      const initialCursor = fixture.client.markEvents();
      const initial = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: initialPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: initial.turnId,
        marker: initialReply,
        afterIndex: initialCursor,
      });
      expectPrefixedPrompt(claude.model.requests()[initialRequestIndex]?.lastUserText, initialPrompt);

      await reloadUntilNativeContains(fixture, sourceChatId, initialReply);
      const initialHistory = await fixture.client.getMessages(sourceChatId);
      expectApplicationImmediatelyBefore(initialHistory, initialPrompt);
      expect(applicationTitles(initialHistory)).toEqual([[PREAMBLE_TITLE]]);
      expect(JSON.stringify(initialHistory)).not.toContain(PREAMBLE_BODY);

      const forkChatId = fixture.newChatId();
      await forkAfterSourceSettles(fixture, sourceChatId, forkChatId);
      expect(applicationTitles(await fixture.client.getMessages(forkChatId))).toEqual([
        [PREAMBLE_TITLE],
      ]);

      const forkPrompt = 'scripted fork prompt';
      const forkReply = 'scripted fork reply';
      claude.model.scriptTurn([claudeText(forkReply)]);
      const forkRequestIndex = claude.model.requests().length;
      const forkCursor = fixture.client.markEvents();
      const fork = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: forkChatId,
        command: forkPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: forkChatId,
        turnId: fork.turnId,
        marker: forkReply,
        afterIndex: forkCursor,
      });
      expectPrefixedPrompt(claude.model.requests()[forkRequestIndex]?.lastUserText, forkPrompt);
      const forkHistory = await fixture.client.getMessages(forkChatId);
      expect(applicationTitles(forkHistory)).toEqual([
        [PREAMBLE_TITLE],
        [PREAMBLE_TITLE],
      ]);
      expectApplicationImmediatelyBefore(forkHistory, forkPrompt);

      await reloadUntilNativeContains(fixture, forkChatId, forkReply);
      const reloadedForkHistory = await fixture.client.getMessages(forkChatId);
      expect(applicationTitles(reloadedForkHistory)).toEqual([
        [PREAMBLE_TITLE],
        [PREAMBLE_TITLE],
      ]);
      expectApplicationImmediatelyBefore(reloadedForkHistory, forkPrompt);
      expect(JSON.stringify(reloadedForkHistory)).not.toContain(PREAMBLE_BODY);

      const continuationChatId = fixture.newChatId();
      const continuationPrompt = 'scripted continuation prompt';
      const continuationReply = 'scripted continuation reply';
      claude.model.scriptTurn([claudeText(continuationReply)]);
      const continuationRequestIndex = claude.model.requests().length;
      const continuationCursor = fixture.client.markEvents();
      const continuation = await fixture.client.post<{ turnId?: string }>(
        '/api/v1/chats/handoff-run',
        {
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          sourceChatId,
          chatId: continuationChatId,
          command: continuationPrompt,
        },
      );
      await waitForVisibleResponse({
        fixture,
        chatId: continuationChatId,
        turnId: continuation.turnId,
        marker: continuationReply,
        afterIndex: continuationCursor,
      });
      expectPrefixedPrompt(
        claude.model.requests()[continuationRequestIndex]?.lastUserText,
        continuationPrompt,
      );
      const continuationHistory = await fixture.client.getMessages(continuationChatId);
      expect(applicationTitles(continuationHistory)).toEqual([
        [PREAMBLE_TITLE],
        [PREAMBLE_TITLE],
      ]);
      expectApplicationImmediatelyBefore(continuationHistory, continuationPrompt);

      const source = (await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === sourceChatId,
      );
      if (!source) throw new Error('Scripted source chat disappeared before agent switch.');
      const codexAgent = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'codex',
      );
      if (!codexAgent) throw new Error('Codex integration is unavailable.');

      const switchPrompt = 'scripted agent switch prompt';
      const switchReply = 'scripted agent switch reply';
      codex.model.scriptTurn([codexAssistantMessage(switchReply)]);
      const switchRequestIndex = codex.model.requests().length;
      const switchCursor = fixture.client.markEvents();
      const switched = await fixture.client.runChat({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId: sourceChatId,
        command: switchPrompt,
        handoff: {
          expectedAgentOwnershipEpoch: source.agentOwnershipEpoch,
          target: {
            agentId: codexAgent.id,
            model: codexAgent.defaultModel,
            permissionMode: 'bypassPermissions',
            thinkingMode: 'low',
            agentSettings: codexAgent.defaultSettings,
          },
        },
      });
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: switched.turnId,
        marker: switchReply,
        afterIndex: switchCursor,
      });
      expectPrefixedPrompt(codex.model.requests()[switchRequestIndex]?.lastUserText, switchPrompt);

      const switchedHistory = await fixture.client.getMessages(sourceChatId);
      expect(applicationTitles(switchedHistory)).toEqual([
        [PREAMBLE_TITLE],
        [PREAMBLE_TITLE],
      ]);
      expectApplicationImmediatelyBefore(switchedHistory, switchPrompt);
      expect(JSON.stringify(switchedHistory)).not.toContain(PREAMBLE_BODY);

      await reloadUntilNativeContains(fixture, sourceChatId, switchReply);
      const reloadedHistory = await fixture.client.getMessages(sourceChatId);
      expect(applicationTitles(reloadedHistory)).toEqual([
        [PREAMBLE_TITLE],
        [PREAMBLE_TITLE],
      ]);
      expectApplicationImmediatelyBefore(reloadedHistory, switchPrompt);
      expect(JSON.stringify(reloadedHistory)).not.toContain(PREAMBLE_BODY);

      claude.model.assertSettled();
      codex.model.assertSettled();
    }, {
      serverEnvironment: {
        ...claude.serverEnvironment,
        ...codex.serverEnvironment,
      },
      prepareWorkspace: codex.prepareWorkspace,
    });
  }, 180_000);
});

async function createGlobalPreamble(fixture: IntegrationFixture): Promise<void> {
  const preamble: PreambleDefinitionInput = {
    enabled: true,
    title: PREAMBLE_TITLE,
    content: PREAMBLE_BODY,
    scope: { type: 'global' },
  };
  await fixture.client.post<PreamblesMutationResponse>('/api/v1/preambles', {
    expectedRevision: 0,
    preamble,
  });
}

function applicationTitles(snapshot: ChatMessagesPage): string[][] {
  return snapshot.messages.flatMap(({ message }) => (
    message.type === 'transcript-notice' && message.detail?.type === 'preamble-application'
      ? [message.detail.preambles.map((preamble) => preamble.title)]
      : []
  ));
}

function expectApplicationImmediatelyBefore(
  snapshot: ChatMessagesPage,
  userContent: string,
): void {
  const userIndex = snapshot.messages.findIndex(({ message }) => (
    message.type === 'user-message' && message.content === userContent
  ));
  expect(userIndex).toBeGreaterThan(0);
  expect(snapshot.messages[userIndex - 1]?.message).toMatchObject({
    type: 'transcript-notice',
    detail: {
      type: 'preamble-application',
      preambles: [{ title: PREAMBLE_TITLE }],
    },
  });
}

function expectPrefixedPrompt(content: string | undefined, visiblePrompt: string): void {
  expect(content).toContain([
    PREAMBLE_BODY,
    '</garcon-preambles>',
    '',
    `<!-- garcon-preamble-input --> ${visiblePrompt}`,
  ].join('\n'));
}
