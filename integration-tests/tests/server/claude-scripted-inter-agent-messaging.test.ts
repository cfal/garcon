import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  reloadFromNativeHistory,
  reloadUntilNativeContains,
} from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

describe('scripted Claude inter-agent messaging', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('steers an active target before its future-turn queue', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    let releasePath = '';
    let continuation: ReturnType<typeof testEnvironment.model.scriptHeldTurn> | undefined;

    try {
      await withIntegrationFixture('claude-scripted-inter-agent-message', async (fixture) => {
        const targetChatId = fixture.newChatId();
        const sourceChatId = fixture.newChatId();
        const targetPrompt = marker('TARGET_PROMPT');
        const sourcePrompt = marker('SOURCE_PROMPT');
        const body = marker('MESSAGE_BODY');
        const envelope = `<garcon-message from="${sourceChatId}">\n${body}\n</garcon-message>`;
        const command = `<garcon-send-message to="${targetChatId}" hide-sender="false">\n${body}\n</garcon-send-message>`;
        const startedPath = path.join(fixture.dirs.project, 'inter-agent-target-started');
        releasePath = path.join(fixture.dirs.project, 'inter-agent-target-release');

        testEnvironment.model.scriptTurn([
          claudeText('Target is waiting.'),
          claudeToolUse('toolu_inter_agent_gate', 'Bash', {
            command: `touch "${startedPath}"; while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
          }),
        ]);
        testEnvironment.model.scriptTurn([claudeText(command)]);
        continuation = testEnvironment.model.scriptHeldTurn([
          claudeText('Target received the message.'),
        ]);

        const targetCursor = fixture.client.markEvents();
        const target = await fixture.client.startChat(liveClaudeStartRequest({
          chatId: targetChatId,
          projectPath: fixture.dirs.project,
          command: targetPrompt,
          permissionMode: 'bypassPermissions',
        }));
        await waitForFile(startedPath);

        const sourceCursor = fixture.client.markEvents();
        const source = await fixture.client.startChat(liveClaudeStartRequest({
          chatId: sourceChatId,
          projectPath: fixture.dirs.project,
          command: sourcePrompt,
          permissionMode: 'bypassPermissions',
        }));
        await fixture.client.waitForEvent(
          (event): event is ChatMessagesMessage => event.type === 'chat-messages'
            && event.chatId === sourceChatId
            && event.messages.some((entry) => (
              entry.message.type === 'transcript-notice'
              && entry.message.detail?.type === 'inter-agent-message-outcome'
            )),
          'Claude source inter-agent outcome',
          { afterIndex: sourceCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        );

        const sourceTranscript = await fixture.client.getMessages(sourceChatId);
        expect(messagesOfType(sourceTranscript.messages, 'transcript-notice')).toContainEqual(
          expect.objectContaining({
            content: body,
            detail: {
              type: 'inter-agent-message-outcome',
              results: [{ chatId: targetChatId, status: 'delivered' }],
            },
          }),
        );
        expect(JSON.stringify(sourceTranscript.messages)).not.toContain('<garcon-send-message');
        expect((await fixture.client.getExecutionControl(targetChatId)).queue.entries).toEqual([]);

        await writeFile(releasePath, 'release', 'utf8');
        const steeredRequest = await continuation.requested;
        expect(steeredRequest.toolResults.some((result) => result.content.includes(envelope)))
          .toBe(true);
        continuation.release();

        expectFinished((await fixture.client.waitForTurnTerminal(
          sourceChatId,
          source.turnId,
          { afterIndex: sourceCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);
        expectFinished((await fixture.client.waitForTurnTerminal(
          targetChatId,
          target.turnId,
          { afterIndex: targetCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        const targetTranscript = await fixture.client.getMessages(targetChatId);
        expect(userContents(targetTranscript.messages)).toEqual([targetPrompt]);
        expect(JSON.stringify(targetTranscript.messages)).not.toContain('<garcon-message');
        expect(messagesOfType(targetTranscript.messages, 'transcript-notice')).toContainEqual(
          expect.objectContaining({
            title: `Message from chat ${sourceChatId}`,
            content: body,
            detail: { type: 'inter-agent-message-received', fromChatId: sourceChatId },
          }),
        );

        await reloadFromNativeHistory(fixture, sourceChatId);
        const reloadedSource = await fixture.client.getMessages(sourceChatId);
        expect(messagesOfType(reloadedSource.messages, 'transcript-notice').filter(
          (message) => message.detail?.type === 'inter-agent-message-outcome',
        )).toEqual([]);
        expect(JSON.stringify(reloadedSource.messages)).not.toContain('<garcon-send-message');

        const store = new TranscriptLedgerStore(
          path.join(fixture.dirs.workspace, 'transcript-ledgers'),
        );
        try {
          const sourceView = store.currentView(sourceChatId);
          if (!sourceView) throw new Error('Reloaded source has no current transcript view.');
          expect(reloadedSource.transcriptViewId).toBe(sourceView.viewId);
          expect(store.rowsAfter(sourceChatId, sourceView.viewId, 0)).toContainEqual(
            expect.objectContaining({
              kind: 'notice',
              detail: {
                type: 'inter-agent-send-request',
                recipients: [targetChatId],
                hideSender: false,
                body,
              },
            }),
          );
        } finally {
          store.close();
        }

        await reloadUntilNativeContains(fixture, targetChatId, 'Target received the message.');
        const reloadedTarget = await fixture.client.getMessages(targetChatId);
        expect(userContents(reloadedTarget.messages)).toEqual([targetPrompt]);
        expect(JSON.stringify(reloadedTarget.messages)).not.toContain('<garcon-message');
        expect(messagesOfType(reloadedTarget.messages, 'transcript-notice').filter(
          (message) => message.detail?.type === 'inter-agent-message-received',
        )).toEqual([
          expect.objectContaining({
            title: `Message from chat ${sourceChatId}`,
            content: body,
            detail: { type: 'inter-agent-message-received', fromChatId: sourceChatId },
          }),
        ]);
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      continuation?.release();
      testEnvironment.model.reset();
    }
  }, 120_000);
});

function marker(label: string): string {
  return `SCRIPTED_CLAUDE_INTER_AGENT_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
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
