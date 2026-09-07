import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
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

const REQUEST_MARKER = '<garcon-get-chat-id />';

describe('scripted Claude chat ID discovery', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('[TLV5-CHAT-ID-DISCOVERY.05-CLAUDE-SCRIPTED-01] immediately steers the requested chat ID without a user or queue input', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    let releasePath = '';
    testEnvironment.model.scriptTurn(() => [
      claudeText(`${REQUEST_MARKER}I am fetching the chat ID`),
      claudeToolUse('toolu_chat_id_gate', 'Bash', {
        command: `while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
      }),
    ]);
    const continuation = testEnvironment.model.scriptHeldTurn([
      claudeText('Chat ID received.'),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-immediate-steer', async (fixture) => {
        const chatId = fixture.newChatId();
        releasePath = path.join(fixture.dirs.project, 'release-chat-id-tool');
        const cursor = fixture.client.markEvents();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Discover this chat identity.',
          permissionMode: 'bypassPermissions',
        }));

        await fixture.client.waitForEvent(
          (event): event is ChatMessagesMessage => event.type === 'chat-messages'
            && event.chatId === chatId
            && event.messages.some((entry) => (
              entry.message.type === 'transcript-notice'
              && entry.message.detail?.type === 'chat-id-disclosure'
            )),
          `Claude chat ID disclosure for ${chatId}`,
          { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        );
        await writeFile(releasePath, 'release', 'utf8');

        const steeredRequest = await continuation.requested;
        expect(JSON.stringify(steeredRequest)).toContain(
          `<garcon-chat-id>${chatId}</garcon-chat-id>`,
        );
        continuation.release();
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          started.turnId,
          { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        const page = await fixture.client.getMessages(chatId);
        expect(userContents(page.messages)).toEqual(['Discover this chat identity.']);
        expect(JSON.stringify(page.messages)).not.toContain(REQUEST_MARKER);
        expect(JSON.stringify(page.messages)).not.toContain('<garcon-chat-id>');
        expect(messagesOfType(page.messages, 'transcript-notice')
          .filter((message) => message.detail?.type.startsWith('chat-id-')))
          .toEqual([expect.objectContaining({
            title: 'Chat ID auto-discovery',
            content: `Sent chat ID ${chatId} to agent.`,
            detail: { type: 'chat-id-disclosure' },
          })]);

        await reloadUntilNativeContains(fixture, chatId, 'Chat ID received.');
        const reloaded = await fixture.client.getMessages(chatId);
        expect(userContents(reloaded.messages)).toEqual(['Discover this chat identity.']);
        expect(JSON.stringify(reloaded.messages)).not.toContain('<garcon-chat-id>');
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      continuation.release();
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('[TLV5-CHAT-ID-DISCOVERY.06-CLAUDE-SCRIPTED-01] strips and rejects the request while auto-discovery is disabled', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([
      claudeText(`${REQUEST_MARKER}No discovery should occur`),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-disabled', async (fixture) => {
        await fixture.client.updateSettings({
          features: { agentCommands: { chatIdDiscovery: false } },
        });
        try {
          const chatId = fixture.newChatId();
          const started = await fixture.client.startChat(liveClaudeStartRequest({
            chatId,
            projectPath: fixture.dirs.project,
            command: 'Keep discovery disabled.',
            permissionMode: 'bypassPermissions',
          }));
          expectFinished((await fixture.client.waitForTurnTerminal(
            chatId,
            started.turnId,
            { timeoutMs: LIVE_TURN_TIMEOUT_MS },
          )).type);

          const page = await fixture.client.getMessages(chatId);
          expect(JSON.stringify(page.messages)).not.toContain(REQUEST_MARKER);
          expect(messagesOfType(page.messages, 'transcript-notice')
            .filter((message) => message.detail?.type.startsWith('chat-id-')))
            .toEqual([expect.objectContaining({
              title: 'Chat ID auto-discovery',
              content: 'Chat ID auto-discovery is disabled.',
              detail: { type: 'chat-id-discovery-failure', reason: 'disabled' },
            })]);
          expect(testEnvironment.model.requestsSince(requestCursor).some(
            (request) => JSON.stringify(request).includes('<garcon-chat-id>'),
          )).toBe(false);
          testEnvironment.model.assertSettled();
        } finally {
          await fixture.client.updateSettings({
            features: { agentCommands: { chatIdDiscovery: true } },
          });
        }
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      testEnvironment.model.reset();
    }
  }, 120_000);
});
