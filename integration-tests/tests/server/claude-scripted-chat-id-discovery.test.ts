import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import { liveClaudeRunRequest, liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

const REQUEST_MARKER = '<get-garcon-chat-id />';
const STEERING_PREFIX = 'The user sent steering guidance for the active task:\n\n';

describe('scripted Claude chat ID discovery', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('records a request without creating work when no input follows', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    testEnvironment.model.scriptTurn([
      claudeText(`${REQUEST_MARKER}I am fetching the chat ID`),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-no-input', async (fixture) => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Discover this chat identity.',
          permissionMode: 'bypassPermissions',
        }));
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          started.turnId,
          { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        const page = await fixture.client.getMessages(chatId);
        expect(page.messages.map((entry) => entry.message.type)).toEqual([
          'user-message',
          'assistant-message',
          'transcript-notice',
        ]);
        expect(messagesOfType(page.messages, 'assistant-message').map((message) => message.content))
          .toEqual(['I am fetching the chat ID']);
        expect(discoveryNotices(page.messages)).toEqual([
          {
            title: 'Request: Garcon Chat ID',
            content: 'Agent requested chat ID',
            detail: { type: 'chat-id-request' },
          },
        ]);
        expect(testEnvironment.model.requests().some(
          (request) => request.lastUserText.includes('<garcon-chat-id>'),
        )).toBe(false);
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('delivers one pending ID to a message queued before the request is published', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const first = testEnvironment.model.scriptHeldTurn([
      claudeText(`${REQUEST_MARKER}The chat ID is needed`),
    ]);
    const queued = testEnvironment.model.scriptHeldTurn([
      claudeText('Queued work complete.'),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-queued', async (fixture) => {
        const chatId = fixture.newChatId();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Start the active turn.',
          permissionMode: 'bypassPermissions',
        }));
        await first.requested;
        await fixture.client.enqueueNew(chatId, 'Run queued work.');
        first.release();

        const queuedRequest = await queued.requested;
        expect(queuedRequest.lastUserText).toContain('Run queued work.');
        expect(queuedRequest.lastUserText.endsWith(
          `\n\n<garcon-chat-id>${chatId}</garcon-chat-id>`,
        )).toBe(true);
        expect(queuedRequest.lastUserText.split('<garcon-chat-id>').length - 1).toBe(1);
        const queuedFinishCursor = fixture.client.markEvents();
        queued.release();
        await fixture.client.waitForProcessing(chatId, false, {
          afterIndex: queuedFinishCursor,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });

        const page = await fixture.client.getMessages(chatId);
        expect(userContents(page.messages)).toEqual([
          'Start the active turn.',
          'Run queued work.',
        ]);
        expect(discoveryNotices(page.messages)).toEqual([
          {
            title: 'Request: Garcon Chat ID',
            content: 'Agent requested chat ID',
            detail: { type: 'chat-id-request' },
          },
          {
            title: 'Response: Garcon Chat ID',
            content: `Sent chat ID ${chatId} to agent`,
            detail: { type: 'chat-id-disclosure', delivery: 'input' },
          },
        ]);
        const queuedUserIndex = page.messages.findIndex((entry) => (
          entry.message.type === 'user-message'
          && entry.message.content === 'Run queued work.'
        ));
        const responseNoticeIndex = page.messages.findIndex((entry) => (
          entry.message.type === 'transcript-notice'
          && entry.message.detail?.type === 'chat-id-disclosure'
        ));
        const queuedAssistantIndex = page.messages.findIndex((entry) => (
          entry.message.type === 'assistant-message'
          && entry.message.content === 'Queued work complete.'
        ));
        expect(queuedUserIndex).toBeGreaterThanOrEqual(0);
        expect(responseNoticeIndex).toBeGreaterThan(queuedUserIndex);
        expect(queuedAssistantIndex).toBeGreaterThan(responseNoticeIndex);
        expect(started.turnId).toBeTruthy();
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      first.release();
      queued.release();
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('delivers the pending ID through a steer after the request notice commits', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    let releasePath = '';
    testEnvironment.model.scriptTurn(() => [
      claudeText(`${REQUEST_MARKER}Waiting for the next instruction`),
      claudeToolUse('toolu_chat_id_gate', 'Bash', {
        command: `while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
      }),
    ]);
    const continuation = testEnvironment.model.scriptHeldTurn([
      claudeText('Steering applied.'),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-steer', async (fixture) => {
        const chatId = fixture.newChatId();
        releasePath = path.join(fixture.dirs.project, 'release-chat-id-tool');

        const cursor = fixture.client.markEvents();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Begin gated work.',
          permissionMode: 'bypassPermissions',
        }));
        await waitForDiscoveryRequest(fixture.client, chatId, cursor);

        const steerPrompt = 'Use the discovered identity.';
        const steered = await fixture.client.steer({
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          chatId,
          content: steerPrompt,
        });
        expect(steered).toMatchObject({ status: 'accepted', turnId: started.turnId });

        await writeFile(releasePath, 'release', 'utf8');
        const continuedRequest = await continuation.requested;
        const steeredToolResult = continuedRequest.toolResults.find(
          (result) => result.toolUseId === 'toolu_chat_id_gate',
        );
        if (!steeredToolResult) throw new Error('Claude omitted the steering tool result.');
        const disclosedSteer = `${STEERING_PREFIX}${steerPrompt}\n\n<garcon-chat-id>${chatId}</garcon-chat-id>`;
        expect(steeredToolResult.content).toContain(disclosedSteer);
        expect(steeredToolResult.content.split('<garcon-chat-id>').length - 1).toBe(1);
        continuation.release();
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          started.turnId,
          { timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        const page = await fixture.client.getMessages(chatId);
        expect(userContents(page.messages)).toEqual(['Begin gated work.', steerPrompt]);
        expect(JSON.stringify(page.messages)).not.toContain('<garcon-chat-id>');
        expect(discoveryNotices(page.messages)).toEqual([
          {
            title: 'Request: Garcon Chat ID',
            content: 'Agent requested chat ID',
            detail: { type: 'chat-id-request' },
          },
          {
            title: 'Response: Garcon Chat ID',
            content: `Sent chat ID ${chatId} to agent (steer)`,
            detail: { type: 'chat-id-disclosure', delivery: 'steer' },
          },
        ]);
        const steerUserIndex = page.messages.findIndex((entry) => (
          entry.message.type === 'user-message'
          && entry.message.content === steerPrompt
        ));
        const responseNoticeIndex = page.messages.findIndex((entry) => (
          entry.message.type === 'transcript-notice'
          && entry.message.detail?.type === 'chat-id-disclosure'
        ));
        const steeredAssistantIndex = page.messages.findIndex((entry) => (
          entry.message.type === 'assistant-message'
          && entry.message.content === 'Steering applied.'
        ));
        expect(steerUserIndex).toBeGreaterThanOrEqual(0);
        expect(responseNoticeIndex).toBeGreaterThan(steerUserIndex);
        expect(steeredAssistantIndex).toBeGreaterThan(responseNoticeIndex);

        await fixture.client.reloadChat(chatId);
        const reloaded = await fixture.client.getMessages(chatId);
        expect(JSON.stringify(reloaded.messages)).not.toContain(REQUEST_MARKER);
        expect(JSON.stringify(reloaded.messages)).not.toContain('<garcon-chat-id>');
        expect(discoveryNotices(reloaded.messages)).toEqual([]);
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      continuation.release();
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('leaves the provider marker untouched while discovery is disabled', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    testEnvironment.model.scriptTurn([
      claudeText(`${REQUEST_MARKER}No discovery should occur`),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-disabled', async (fixture) => {
        await fixture.client.updateSettings({
          features: { chatIdDiscovery: { enabled: false } },
        });
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
        expect(messagesOfType(page.messages, 'assistant-message').map((message) => message.content))
          .toEqual([`${REQUEST_MARKER}No discovery should occur`]);
        expect(discoveryNotices(page.messages)).toEqual([]);
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('keeps the request notice but drops pending disclosure across restart', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    testEnvironment.model.scriptTurn([
      claudeText(`${REQUEST_MARKER}The request will outlive this process`),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-restart', async (fixture) => {
        const chatId = fixture.newChatId();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Request before restart.',
          permissionMode: 'bypassPermissions',
        }));
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          started.turnId,
          { timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        await fixture.restartGarcon();
        const resumed = testEnvironment.model.scriptHeldTurn([
          claudeText('Restarted work complete.'),
        ]);
        const run = await fixture.client.runChat(liveClaudeRunRequest({
          chatId,
          command: 'Continue after restart.',
          permissionMode: 'bypassPermissions',
        }));
        const request = await resumed.requested;
        expect(request.lastUserText).toContain('Continue after restart.');
        expect(request.lastUserText).not.toContain('<garcon-chat-id>');
        resumed.release();
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          run.turnId,
          { timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        const page = await fixture.client.getMessages(chatId);
        expect(discoveryNotices(page.messages)).toEqual([
          {
            title: 'Request: Garcon Chat ID',
            content: 'Agent requested chat ID',
            detail: { type: 'chat-id-request' },
          },
        ]);
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      testEnvironment.model.reset();
    }
  }, 120_000);
});

function discoveryNotices(messages: readonly TranscriptMessage[]) {
  return messagesOfType(messages, 'transcript-notice')
    .filter((message) => (
      message.detail?.type === 'chat-id-request'
      || message.detail?.type === 'chat-id-disclosure'
    ))
    .map((message) => ({
      title: message.title,
      content: message.content,
      detail: message.detail,
    }));
}

async function waitForDiscoveryRequest(
  client: GarconTestClient,
  chatId: string,
  afterIndex: number,
): Promise<ChatMessagesMessage> {
  return client.waitForEvent(
    (event): event is ChatMessagesMessage => (
      event.type === 'chat-messages'
      && event.chatId === chatId
      && event.messages.some((entry) => (
        entry.message.type === 'transcript-notice'
        && entry.message.detail?.type === 'chat-id-request'
      ))
    ),
    `chat ID request notice for ${chatId}`,
    { afterIndex, timeoutMs: LIVE_TURN_TIMEOUT_MS },
  );
}
