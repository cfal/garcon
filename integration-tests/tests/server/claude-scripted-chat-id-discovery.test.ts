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
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  reloadUntilNativeContains,
} from '../../support/live-agent.js';
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

        await reloadUntilNativeContains(fixture, chatId, 'Steering applied.');
        const reloaded = await fixture.client.getMessages(chatId);
        expect(JSON.stringify(reloaded.messages)).not.toContain(REQUEST_MARKER);
        expect(JSON.stringify(reloaded.messages)).not.toContain('<garcon-chat-id>');
        expect(discoveryNotices(reloaded.messages)).toEqual([
          {
            title: 'Request: Garcon Chat ID',
            content: 'Agent requested chat ID',
            detail: { type: 'chat-id-request' },
          },
        ]);
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      continuation.release();
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('delivers the pending ID to a message queued after the request commits', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    let releasePath = '';
    testEnvironment.model.scriptTurn(() => [
      claudeText(`${REQUEST_MARKER}Queue the next instruction`),
      claudeToolUse('toolu_chat_id_queue_gate', 'Bash', {
        command: `while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
      }),
    ]);
    testEnvironment.model.scriptTurn([
      claudeText('Active turn complete.'),
    ]);
    const queuedTurn = testEnvironment.model.scriptHeldTurn([
      claudeText('Queued turn complete.'),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-queue-after-request', async (fixture) => {
        const chatId = fixture.newChatId();
        releasePath = path.join(fixture.dirs.project, 'release-chat-id-queue');
        const cursor = fixture.client.markEvents();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Begin queue-gated work.',
          permissionMode: 'bypassPermissions',
        }));
        await waitForDiscoveryRequest(fixture.client, chatId, cursor);
        await fixture.client.enqueueNew(chatId, 'Run work queued after the request.');

        await writeFile(releasePath, 'release', 'utf8');
        const queuedRequest = await queuedTurn.requested;
        expect(queuedRequest.lastUserText).toContain('Run work queued after the request.');
        expect(queuedRequest.lastUserText.endsWith(
          `\n\n<garcon-chat-id>${chatId}</garcon-chat-id>`,
        )).toBe(true);
        expect(queuedRequest.lastUserText.split('<garcon-chat-id>').length - 1).toBe(1);
        const finishCursor = fixture.client.markEvents();
        queuedTurn.release();
        await fixture.client.waitForProcessing(chatId, false, {
          afterIndex: finishCursor,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });

        const page = await fixture.client.getMessages(chatId);
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
        expect(started.turnId).toBeTruthy();
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      queuedTurn.release();
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('lets a steer consume the pending ID ahead of a paused queue', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    let releasePath = '';
    testEnvironment.model.scriptTurn(() => [
      claudeText(`${REQUEST_MARKER}Choose the next delivery path`),
      claudeToolUse('toolu_chat_id_priority_gate', 'Bash', {
        command: `while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
      }),
    ]);
    const steeredTurn = testEnvironment.model.scriptHeldTurn([
      claudeText('Steered turn complete.'),
    ]);
    const queuedTurn = testEnvironment.model.scriptHeldTurn([
      claudeText('Paused queue complete.'),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-steer-before-queue', async (fixture) => {
        const chatId = fixture.newChatId();
        releasePath = path.join(fixture.dirs.project, 'release-chat-id-priority');
        const cursor = fixture.client.markEvents();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Begin priority-gated work.',
          permissionMode: 'bypassPermissions',
        }));
        await waitForDiscoveryRequest(fixture.client, chatId, cursor);
        await fixture.client.enqueueNew(chatId, 'Run this after the steer.');
        const paused = await fixture.client.pauseQueue(chatId);
        const steerPrompt = 'Use the ID in this steer.';
        expect(await fixture.client.steer({
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          chatId,
          content: steerPrompt,
        })).toMatchObject({ status: 'accepted', turnId: started.turnId });

        await writeFile(releasePath, 'release', 'utf8');
        const steeredRequest = await steeredTurn.requested;
        const steeredToolResult = steeredRequest.toolResults.find(
          (result) => result.toolUseId === 'toolu_chat_id_priority_gate',
        );
        if (!steeredToolResult) throw new Error('Claude omitted the priority steering result.');
        expect(steeredToolResult.content).toContain(
          `${STEERING_PREFIX}${steerPrompt}\n\n<garcon-chat-id>${chatId}</garcon-chat-id>`,
        );
        steeredTurn.release();
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          started.turnId,
          { timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        const stillPaused = await fixture.client.getExecutionControl(chatId);
        expect(stillPaused.queue.pause).toEqual(paused.control.queue.pause);
        await fixture.client.resumeQueue(chatId, stillPaused.queue.pause!.id);
        const queuedRequest = await queuedTurn.requested;
        expect(queuedRequest.lastUserText).toContain('Run this after the steer.');
        expect(queuedRequest.lastUserText).not.toContain('<garcon-chat-id>');
        const finishCursor = fixture.client.markEvents();
        queuedTurn.release();
        await fixture.client.waitForProcessing(chatId, false, {
          afterIndex: finishCursor,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });

        const page = await fixture.client.getMessages(chatId);
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
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      steeredTurn.release();
      queuedTurn.release();
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('coalesces repeated requests before delivery and rearms afterward', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    testEnvironment.model.scriptTurn([
      claudeText(`${REQUEST_MARKER}First request`),
      claudeText(`${REQUEST_MARKER}Second request`),
    ]);
    const firstDelivery = testEnvironment.model.scriptHeldTurn([
      claudeText('First disclosure received.'),
    ]);
    testEnvironment.model.scriptTurn([
      claudeText(`${REQUEST_MARKER}Third request`),
    ]);
    const secondDelivery = testEnvironment.model.scriptHeldTurn([
      claudeText('Second disclosure received.'),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-repeated-requests', async (fixture) => {
        const chatId = fixture.newChatId();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Request the ID twice.',
          permissionMode: 'bypassPermissions',
        }));
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          started.turnId,
          { timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);
        expect(discoveryNotices((await fixture.client.getMessages(chatId)).messages)
          .filter((notice) => notice.detail?.type === 'chat-id-request')).toHaveLength(2);

        const firstRun = await fixture.client.runChat(liveClaudeRunRequest({
          chatId,
          command: 'Deliver the coalesced request.',
          permissionMode: 'bypassPermissions',
        }));
        const firstRequest = await firstDelivery.requested;
        expect(firstRequest.lastUserText.split('<garcon-chat-id>').length - 1).toBe(1);
        firstDelivery.release();
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          firstRun.turnId,
          { timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        const rearmCursor = fixture.client.markEvents();
        const rearm = await fixture.client.runChat(liveClaudeRunRequest({
          chatId,
          command: 'Request the ID again.',
          permissionMode: 'bypassPermissions',
        }));
        await waitForDiscoveryRequest(fixture.client, chatId, rearmCursor);
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          rearm.turnId,
          { afterIndex: rearmCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        const secondRun = await fixture.client.runChat(liveClaudeRunRequest({
          chatId,
          command: 'Deliver the rearmed request.',
          permissionMode: 'bypassPermissions',
        }));
        const secondRequest = await secondDelivery.requested;
        expect(secondRequest.lastUserText.split('<garcon-chat-id>').length - 1).toBe(1);
        secondDelivery.release();
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          secondRun.turnId,
          { timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        const notices = discoveryNotices((await fixture.client.getMessages(chatId)).messages);
        expect(notices.filter((notice) => notice.detail?.type === 'chat-id-request')).toHaveLength(3);
        expect(notices.filter((notice) => notice.detail?.type === 'chat-id-disclosure')).toHaveLength(2);
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      firstDelivery.release();
      secondDelivery.release();
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('removes the marker and records an error while discovery is disabled', async () => {
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
          .toEqual(['No discovery should occur']);
        expect(discoveryNotices(page.messages)).toEqual([
          {
            title: 'Request: Garcon Chat ID',
            content: 'Chat ID auto-discovery is disabled.',
            detail: { type: 'chat-id-discovery-disabled' },
          },
        ]);

        await reloadUntilNativeContains(fixture, chatId, 'No discovery should occur');
        const reloaded = await fixture.client.getMessages(chatId);
        expect(messagesOfType(reloaded.messages, 'assistant-message').map((message) => message.content))
          .toEqual(['No discovery should occur']);
        expect(discoveryNotices(reloaded.messages)).toEqual([
          {
            title: 'Request: Garcon Chat ID',
            content: 'Chat ID auto-discovery is disabled.',
            detail: { type: 'chat-id-discovery-disabled' },
          },
        ]);
        testEnvironment.model.assertSettled();
      }, { serverEnvironment: testEnvironment.serverEnvironment });
    } finally {
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('clears an armed request when discovery is disabled', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    testEnvironment.model.scriptTurn([
      claudeText(`${REQUEST_MARKER}The request should be cleared`),
    ]);
    const nextTurn = testEnvironment.model.scriptHeldTurn([
      claudeText('Continued without disclosure.'),
    ]);

    try {
      await withIntegrationFixture('claude-chat-id-disable-pending', async (fixture) => {
        const chatId = fixture.newChatId();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Arm discovery before disabling it.',
          permissionMode: 'bypassPermissions',
        }));
        expectFinished((await fixture.client.waitForTurnTerminal(
          chatId,
          started.turnId,
          { timeoutMs: LIVE_TURN_TIMEOUT_MS },
        )).type);

        await fixture.client.updateSettings({
          features: { chatIdDiscovery: { enabled: false } },
        });
        const run = await fixture.client.runChat(liveClaudeRunRequest({
          chatId,
          command: 'Continue after disabling discovery.',
          permissionMode: 'bypassPermissions',
        }));
        const request = await nextTurn.requested;
        expect(request.lastUserText).toContain('Continue after disabling discovery.');
        expect(request.lastUserText).not.toContain('<garcon-chat-id>');
        nextTurn.release();
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
      nextTurn.release();
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
      || message.detail?.type === 'chat-id-discovery-disabled'
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
