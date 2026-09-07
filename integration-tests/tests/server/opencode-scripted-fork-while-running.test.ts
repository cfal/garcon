import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import { userContents } from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  openCodeNativeSession,
  readOpenCodeSessionRows,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type OpenCodeSessionRows,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode fork while running', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('seeds point and whole-session forks from their native prefixes', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('FIRST_PROMPT');
    const firstReply = marker('FIRST_REPLY');
    const secondPrompt = marker('SECOND_PROMPT');
    const secondReply = marker('SECOND_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    const heldSecondReply = testEnvironment.model.scriptHeldTurn([
      chatCompletionsText(secondReply),
    ]);

    await withIntegrationFixture('opencode-scripted-fork-running', async (fixture) => {
      const catalog = await fixture.client.listAgentCatalog();
      const opencode = catalog.agents.find((agent) => agent.id === 'opencode');
      if (!opencode) throw new Error('OpenCode integration is missing from the agent catalog.');
      expect(opencode.supportsForkWhileRunning).toBe(true);

      const sourceChatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const firstTurn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: firstTurn.turnId,
        marker: firstReply,
        afterIndex: firstCursor,
      });

      const settled = await fixture.client.getMessages(sourceChatId);
      const settledReply = settled.messages.find((entry) =>
        entry.message.type === 'assistant-message'
        && entry.message.content.includes(firstReply));
      if (!settledReply) throw new Error('OpenCode first reply was not persisted.');
      const sourceNative = await openCodeNativeSession(fixture, sourceChatId);
      const settledNativeConversation = nativeConversation(readOpenCodeSessionRows(sourceNative));
      expect(settledNativeConversation).toEqual([
        ['user', firstPrompt],
        ['assistant', firstReply],
      ]);

      const secondCursor = fixture.client.markEvents();
      const secondTurn = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId: sourceChatId,
        command: secondPrompt,
      }));
      await heldSecondReply.requested;
      await fixture.client.waitForProcessing(sourceChatId, true, {
        afterIndex: secondCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      const running = await fixture.client.getMessages(sourceChatId);
      expect(userContents(running.messages)).toEqual([firstPrompt, secondPrompt]);
      const runningNativeConversation = nativeConversation(readOpenCodeSessionRows(sourceNative));
      expect(runningNativeConversation).toEqual([
        ...settledNativeConversation,
        ['user', secondPrompt],
      ]);

      let pointForkChatId = '';
      let wholeForkChatId = '';
      let pointForkConversation: ConversationLine[] = [];
      let wholeForkConversation: ConversationLine[] = [];
      try {
        pointForkChatId = fixture.newChatId();
        await fixture.client.forkChat({
          sourceChatId,
          chatId: pointForkChatId,
          transcriptViewId: running.transcriptViewId,
          upToOrdinal: settledReply.ordinal,
        });
        const pointForkNative = await openCodeNativeSession(fixture, pointForkChatId);
        expect(pointForkNative.agentSessionId).not.toBe(sourceNative.agentSessionId);
        pointForkConversation = nativeConversation(readOpenCodeSessionRows(pointForkNative));
        expect(pointForkConversation).toEqual(settledNativeConversation);
        expect(renderedConversation(
          (await fixture.client.getMessages(pointForkChatId)).messages,
        )).toEqual(pointForkConversation);

        wholeForkChatId = fixture.newChatId();
        await fixture.client.forkChat({ sourceChatId, chatId: wholeForkChatId });
        const wholeForkNative = await openCodeNativeSession(fixture, wholeForkChatId);
        expect(wholeForkNative.agentSessionId).not.toBe(sourceNative.agentSessionId);
        expect(wholeForkNative.agentSessionId).not.toBe(pointForkNative.agentSessionId);
        wholeForkConversation = nativeConversation(readOpenCodeSessionRows(wholeForkNative));
        expect(wholeForkConversation).toEqual(runningNativeConversation);
        expect(renderedConversation(
          (await fixture.client.getMessages(wholeForkChatId)).messages,
        )).toEqual(wholeForkConversation);
        expect(nativeConversation(readOpenCodeSessionRows(sourceNative)))
          .toEqual(runningNativeConversation);
      } finally {
        heldSecondReply.release();
      }

      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: secondTurn.turnId,
        marker: secondReply,
        afterIndex: secondCursor,
      });
      const completedSourceConversation: ConversationLine[] = [
        ...runningNativeConversation,
        ['assistant', secondReply],
      ];
      expect(nativeConversation(readOpenCodeSessionRows(sourceNative)))
        .toEqual(completedSourceConversation);
      expect(renderedConversation((await fixture.client.getMessages(sourceChatId)).messages))
        .toEqual(completedSourceConversation);
      expect(nativeConversation(readOpenCodeSessionRows(
        await openCodeNativeSession(fixture, pointForkChatId),
      ))).toEqual(pointForkConversation);
      expect(renderedConversation((await fixture.client.getMessages(pointForkChatId)).messages))
        .toEqual(pointForkConversation);
      expect(nativeConversation(readOpenCodeSessionRows(
        await openCodeNativeSession(fixture, wholeForkChatId),
      ))).toEqual(wholeForkConversation);
      expect(renderedConversation((await fixture.client.getMessages(wholeForkChatId)).messages))
        .toEqual(wholeForkConversation);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);
});

type ConversationLine = ['user' | 'assistant', string];

function nativeConversation(rows: OpenCodeSessionRows): ConversationLine[] {
  const lines: ConversationLine[] = [];
  for (const message of rows.messages) {
    const parts = rows.parts.filter((part) => part.message_id === message.id);
    if (message.data.role === 'user') {
      const text = parts
        .filter((part) => part.data.type === 'text' && part.data.synthetic !== true)
        .map((part) => typeof part.data.text === 'string' ? part.data.text : '')
        .join('\n');
      if (text.trim()) lines.push(['user', text]);
      continue;
    }
    if (message.data.role !== 'assistant') continue;
    for (const part of parts) {
      if (part.data.type === 'text' && typeof part.data.text === 'string'
        && part.data.text.trim()) {
        lines.push(['assistant', part.data.text]);
      }
    }
  }
  return lines;
}

function renderedConversation(messages: readonly TranscriptMessage[]): ConversationLine[] {
  return messages.flatMap((entry): ConversationLine[] => {
    if (entry.message.type === 'user-message') return [['user', entry.message.content]];
    if (entry.message.type === 'assistant-message') {
      return [['assistant', entry.message.content]];
    }
    return [];
  });
}

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withScriptedOpenCode(): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

function marker(label: string): string {
  return `SCRIPTED_OPENCODE_FORK_RUNNING_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
