import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import type { ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  reloadUntilNativeContains,
} from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

describe('scripted Claude agent-created chats', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('starts another real scripted Claude chat and returns correlated results', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    let releasePath = '';
    let childTurn: ReturnType<typeof testEnvironment.model.scriptHeldTurn> | undefined;
    let sourceContinuation: ReturnType<typeof testEnvironment.model.scriptHeldTurn> | undefined;

    try {
      await withIntegrationFixture('claude-scripted-agent-start', async (fixture) => {
        const sourceChatId = fixture.newChatId();
        const sourcePrompt = marker('SOURCE_PROMPT');
        const childPrompt = marker('CHILD_PROMPT');
        const childReply = marker('CHILD_REPLY');
        const sourceReply = marker('SOURCE_REPLY');
        const successRef = '69b623a7-757e-49f6-93b8-4b7ea1bc569b';
        const failureRef = '2cf0e440-11b4-41aa-bc90-36145b214f66';
        const startCommand = [
          '<garcon-start-agent>',
          JSON.stringify({
            prompt: childPrompt,
            params: [
              {
                ref: successRef,
                agent: 'claude',
                model: 'haiku',
                reasoningEffort: 'low',
              },
              {
                ref: failureRef,
                agent: 'claude',
                model: 'haiku',
                reasoningEffort: 'extreme',
              },
            ],
          }, null, 2),
          '</garcon-start-agent>',
        ].join('\n');
        const startedPath = path.join(fixture.dirs.project, 'agent-start-source-started');
        releasePath = path.join(fixture.dirs.project, 'agent-start-source-release');

        testEnvironment.model.scriptTurn([
          claudeText(startCommand),
          claudeToolUse('toolu_agent_start_gate', 'Bash', {
            command: `touch "${startedPath}"; while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
          }),
        ]);
        childTurn = testEnvironment.model.scriptHeldTurn([claudeText(childReply)]);
        sourceContinuation = testEnvironment.model.scriptHeldTurn([claudeText(sourceReply)]);

        const settingsBefore = await fixture.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
        const sourceCursor = fixture.client.markEvents();
        const startRequest = liveClaudeStartRequest({
          chatId: sourceChatId,
          projectPath: fixture.dirs.project,
          command: sourcePrompt,
          permissionMode: 'bypassPermissions',
        });
        const source = await fixture.client.startChat({ ...startRequest, origin: 'cli' });
        await waitForFile(startedPath);

        const outcomeEvent = await fixture.client.waitForEvent(
          (event): event is ChatMessagesMessage => event.type === 'chat-messages'
            && event.chatId === sourceChatId
            && event.messages.some((entry) => (
              entry.message.type === 'transcript-notice'
              && entry.message.detail?.type === 'sub-agent-start-outcome'
              && entry.message.detail.deliveryStatus === 'delivered'
            )),
          'Claude source sub-agent outcome',
          { afterIndex: sourceCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        );
        const outcome = outcomeEvent.messages
          .map((entry) => entry.message)
          .find((message) => message.type === 'transcript-notice'
            && message.detail?.type === 'sub-agent-start-outcome');
        if (outcome?.type !== 'transcript-notice'
          || outcome.detail?.type !== 'sub-agent-start-outcome') {
          throw new Error('Sub-agent outcome was not present in its commit event.');
        }
        const success = outcome.detail.results.find((result) => result.ref === successRef);
        if (!success || success.error) throw new Error('Created sub-agent result was missing.');
        const childChatId = success.chatId;
        expect(outcome.detail.results).toEqual([
          { ref: successRef, error: false, msg: 'created', chatId: childChatId },
          { ref: failureRef, error: true, msg: 'unsupported-reasoning-effort' },
        ]);

        const resultContent = [
          `<garcon-create-chat-result ref="${successRef}" error="false" msg="created" chat-id="${childChatId}" />`,
          `<garcon-create-chat-result ref="${failureRef}" error="true" msg="unsupported-reasoning-effort" />`,
        ].join('\n');
        const childRequest = await childTurn.requested;
        expect(childRequest.lastUserText).toContain(childPrompt);
        childTurn.release();
        await writeFile(releasePath, 'release', 'utf8');
        const continuationRequest = await sourceContinuation.requested;
        const continuationInput = [
          ...continuationRequest.userTexts,
          ...continuationRequest.toolResults.map((result) => result.content),
        ].join('\n');
        expect(continuationInput).toContain(resultContent);
        sourceContinuation.release();

        expectFinished((await fixture.client.waitForTurnTerminal(
          sourceChatId,
          source.turnId,
          { afterIndex: sourceCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);
        await waitForTranscriptContent(fixture, childChatId, childReply);

        const child = (await fixture.client.listChats()).sessions.find((chat) => chat.id === childChatId);
        expect(child).toMatchObject({
          agentId: 'claude',
          model: 'haiku',
          projectPath: fixture.dirs.project,
          tags: ['sub-agent'],
        });
        const childTranscript = await fixture.client.getMessages(childChatId);
        expect(userContents(childTranscript.messages)).toEqual([childPrompt]);
        expect(assistantContents(childTranscript.messages)).toContain(childReply);

        const sourceTranscript = await fixture.client.getMessages(sourceChatId);
        expect(JSON.stringify(sourceTranscript.messages)).not.toContain('<garcon-start-agent>');
        expect(messagesOfType(sourceTranscript.messages, 'transcript-notice').filter(
          (message) => message.detail?.type === 'sub-agent-start-outcome',
        )).toEqual([
          expect.objectContaining({
            detail: {
              type: 'sub-agent-start-outcome',
              deliveryStatus: 'delivered',
              results: outcome.detail.results,
            },
          }),
        ]);

        const settingsAfter = await fixture.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
        expect(settingsAfter.recentAgentSettings).toEqual(settingsBefore.recentAgentSettings);
        expect(settingsAfter.paths.recentProjectPaths).toEqual(settingsBefore.paths.recentProjectPaths);
        expect(settingsAfter.executionDefaults).toEqual(settingsBefore.executionDefaults);

        const chatCountBeforeReload = (await fixture.client.listChats()).total;
        await reloadUntilNativeContains(fixture, sourceChatId, sourceReply);
        const reloadedSource = await fixture.client.getMessages(sourceChatId);
        expect(JSON.stringify(reloadedSource.messages)).not.toContain('<garcon-start-agent>');
        expect(messagesOfType(reloadedSource.messages, 'transcript-notice').filter(
          (message) => message.detail?.type === 'sub-agent-start-outcome',
        )).toEqual([
          expect.objectContaining({
            detail: {
              type: 'sub-agent-start-outcome',
              deliveryStatus: 'delivered',
              results: outcome.detail.results,
            },
          }),
        ]);
        expect((await fixture.client.listChats()).total).toBe(chatCountBeforeReload);

        const store = new TranscriptLedgerStore(
          path.join(fixture.dirs.workspace, 'transcript-ledgers'),
        );
        try {
          const sourceView = store.currentView(sourceChatId);
          if (!sourceView) throw new Error('Reloaded source has no current transcript view.');
          expect(store.rowsAfter(sourceChatId, sourceView.viewId, 0)).toContainEqual(
            expect.objectContaining({
              kind: 'notice',
              detail: {
                type: 'sub-agent-start-request',
                prompt: childPrompt,
                params: [
                  {
                    ref: successRef,
                    agentId: 'claude',
                    providerId: null,
                    endpointId: null,
                    model: 'haiku',
                    reasoningEffort: 'low',
                  },
                  {
                    ref: failureRef,
                    agentId: 'claude',
                    providerId: null,
                    endpointId: null,
                    model: 'haiku',
                    reasoningEffort: 'extreme',
                  },
                ],
              },
            }),
          );
        } finally {
          store.close();
        }

        const requestCountBeforeRestart = testEnvironment.model.requests().length;
        await fixture.restartGarcon();
        await fixture.client.ping();
        expect((await fixture.client.listChats()).sessions.map((chat) => chat.id))
          .toEqual(expect.arrayContaining([sourceChatId, childChatId]));
        expect(testEnvironment.model.requests()).toHaveLength(requestCountBeforeRestart);
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      childTurn?.release();
      sourceContinuation?.release();
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('does not resume an in-flight multi-chat batch after a crash', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;

    try {
      await withIntegrationFixture('claude-scripted-agent-start-crash', async (fixture) => {
        const sourceChatId = fixture.newChatId();
        const sourcePrompt = marker('CRASH_SOURCE_PROMPT');
        const childPrompt = marker('CRASH_CHILD_PROMPT');
        const acceptedChildReply = marker('CRASH_ACCEPTED_CHILD_REPLY');
        const childAgent = fixture.directAgents.openAi;
        const refs = Array.from(
          { length: 16 },
          (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
        );
        const startCommand = [
          '<garcon-start-agent>',
          JSON.stringify({
            prompt: childPrompt,
            params: refs.map((ref) => directStartParams(childAgent, ref)),
          }, null, 2),
          '</garcon-start-agent>',
        ].join('\n');

        testEnvironment.model.scriptTurn([claudeText(startCommand)]);
        const acceptedChildTurn = fixture.fakeProviders.openAi.holdNext({
          lastUserText: childPrompt,
        });
        const interruptedChildTurn = fixture.fakeProviders.openAi.holdNext({
          lastUserText: childPrompt,
        });

        await fixture.client.startChat({
          ...liveClaudeStartRequest({
            chatId: sourceChatId,
            projectPath: fixture.dirs.project,
            command: sourcePrompt,
            permissionMode: 'bypassPermissions',
          }),
          origin: 'cli',
        });
        await acceptedChildTurn.received;
        acceptedChildTurn.releaseText(acceptedChildReply);
        await interruptedChildTurn.received;

        const interruptedRequest = interruptedChildTurn.expectAbort();
        await fixture.crashAndRestartGarcon();
        await interruptedRequest;
        interruptedChildTurn.releaseTruncatedStream();
        const claudeRequestCountAfterRestart = testEnvironment.model.requests().length;
        const directRequestCountAfterRestart = fixture.fakeProviders.openAi.requests().length;

        const createdChildren = (await fixture.client.listChats()).sessions.filter(
          (chat) => chat.tags.includes('sub-agent'),
        );
        expect(createdChildren).toHaveLength(2);

        const observedChildReplies: string[] = [];
        for (const child of createdChildren) {
          expect(child).toMatchObject({
            agentId: childAgent.agentId,
            model: childAgent.provider.model,
            projectPath: fixture.dirs.project,
            tags: ['sub-agent'],
          });
          const transcript = await fixture.client.getMessages(child.id);
          expect(userContents(transcript.messages)).toEqual([childPrompt]);
          observedChildReplies.push(...assistantContents(transcript.messages));
        }
        expect(observedChildReplies).toEqual([acceptedChildReply]);
        const sourceTranscript = await fixture.client.getMessages(sourceChatId);
        expect(JSON.stringify(sourceTranscript.messages)).not.toContain('<garcon-start-agent>');
        expect(messagesOfType(sourceTranscript.messages, 'transcript-notice').filter(
          (message) => message.detail?.type === 'sub-agent-start-outcome',
        )).toEqual([]);
        expect(testEnvironment.model.requests()).toHaveLength(claudeRequestCountAfterRestart);
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(directRequestCountAfterRestart);
        expect((await fixture.client.listChats()).sessions.filter(
          (chat) => chat.tags.includes('sub-agent'),
        ).map((chat) => chat.id)).toEqual(createdChildren.map((chat) => chat.id));
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      testEnvironment.model.reset();
    }
  }, 120_000);
});

function marker(label: string): string {
  return `SCRIPTED_CLAUDE_AGENT_START_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function directStartParams(agent: ConfiguredDirectTestAgent, ref: string) {
  const { provider } = agent;
  return {
    ref,
    agent: agent.agentId,
    provider: provider.providerId,
    endpoint: provider.endpointId,
    model: provider.model,
    reasoningEffort: 'none',
  };
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`Claude never created ${filePath}.`);
}

async function waitForTranscriptContent(
  fixture: Parameters<Parameters<typeof withIntegrationFixture>[1]>[0],
  chatId: string,
  content: string,
): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const transcript = await fixture.client.getMessages(chatId);
    if (JSON.stringify(transcript.messages).includes(content)) return;
    await Bun.sleep(25);
  }
  throw new Error(`Transcript ${chatId} never contained the scripted child response.`);
}
