import { afterEach, describe, expect, test } from 'bun:test';
import type {
  ExecutionSettingsPatchResponse,
} from '../../../common/chat-command-contracts.js';
import type { AgentRunFailedMessage } from '../../../common/ws-events.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { GarconApiError, type GarconTestClient } from '../../support/garcon-client.js';
import {
  type IntegrationDirectories,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import {
  LIVE_CODEX_MODEL,
  LIVE_CODEX_THINKING_MODE,
  liveCodexRunRequest,
  liveCodexStartRequest,
  type CodexFastMode,
} from '../../support/live-codex.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('Codex per-chat Fast mode', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  afterEach(async () => {
    await environment?.dispose();
    environment = undefined;
  });

  test('overrides global Fast per chat across live updates, restart, queues, and one-shot work', async () => {
    environment = await startScriptedCodexTestEnvironment({
      supportsPriority: true,
      globalServiceTier: 'fast',
    });
    const testEnvironment = environment;

    await withIntegrationFixture('codex-fast-mode-supported', async (fixture) => {
      await fixture.client.updateSettings({
        ui: {
          chatTitle: {
            enabled: false,
            agentId: 'codex',
            model: LIVE_CODEX_MODEL,
            apiProviderId: null,
            modelEndpointId: null,
            modelProtocol: null,
            thinkingMode: LIVE_CODEX_THINKING_MODE,
          },
        },
      });

      const chatId = fixture.newChatId();
      const standardReply = marker('STANDARD_REPLY');
      testEnvironment.model.scriptTurn([codexAssistantMessage(standardReply)]);
      const standardMarker = testEnvironment.model.markRequests();
      const standardCursor = fixture.client.markEvents();
      const standard = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('STANDARD_PROMPT'),
        fastMode: 'off',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: standard.turnId,
        marker: standardReply,
        afterIndex: standardCursor,
      });
      expect(testEnvironment.model.requestsSince(standardMarker)).toHaveLength(1);
      expect(testEnvironment.model.requestsSince(standardMarker)[0]!.body)
        .not.toHaveProperty('service_tier');

      const titleReply = marker('STANDARD_TITLE');
      testEnvironment.model.scriptTurn([codexAssistantMessage(titleReply)]);
      const titleMarker = testEnvironment.model.markRequests();
      await fixture.client.generateChatTitle({
        chatId,
        message: 'Generate a deterministic Standard title.',
      });
      expect(testEnvironment.model.requestsSince(titleMarker)).toHaveLength(1);
      expect(testEnvironment.model.requestsSince(titleMarker)[0]!.body)
        .not.toHaveProperty('service_tier');

      const fastChatId = fixture.newChatId();
      const fastReply = marker('FAST_REPLY');
      const heldFast = testEnvironment.model.scriptHeldTurn([codexAssistantMessage(fastReply)]);
      const fastCursor = fixture.client.markEvents();
      const fast = await fixture.client.startChat(liveCodexStartRequest({
        chatId: fastChatId,
        projectPath: fixture.dirs.project,
        command: marker('FAST_PROMPT'),
        fastMode: 'on',
      }));
      const activeFastRequest = await heldFast.requested;
      expect(activeFastRequest.body.service_tier).toBe('priority');

      await patchFastMode(fixture.client, fastChatId, 'off');
      await expectPersistedFastMode(fixture.dirs, fastChatId, 'off');
      heldFast.release();
      await waitForVisibleResponse({
        fixture,
        chatId: fastChatId,
        turnId: fast.turnId,
        marker: fastReply,
        afterIndex: fastCursor,
      });

      const nextReply = marker('POST_TOGGLE_STANDARD');
      testEnvironment.model.scriptTurn([codexAssistantMessage(nextReply)]);
      const nextMarker = testEnvironment.model.markRequests();
      const nextCursor = fixture.client.markEvents();
      const next = await fixture.client.runChat(liveCodexRunRequest({
        chatId: fastChatId,
        command: marker('POST_TOGGLE_PROMPT'),
        fastMode: 'off',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: fastChatId,
        turnId: next.turnId,
        marker: nextReply,
        afterIndex: nextCursor,
      });
      expect(testEnvironment.model.requestsSince(nextMarker)[0]!.body)
        .not.toHaveProperty('service_tier');

      await fixture.restartGarcon();
      const restartReply = marker('RESTART_STANDARD');
      testEnvironment.model.scriptTurn([codexAssistantMessage(restartReply)]);
      const restartMarker = testEnvironment.model.markRequests();
      const restartCursor = fixture.client.markEvents();
      const restarted = await fixture.client.runChat(liveCodexRunRequest({
        chatId: fastChatId,
        command: marker('RESTART_PROMPT'),
        fastMode: 'off',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: fastChatId,
        turnId: restarted.turnId,
        marker: restartReply,
        afterIndex: restartCursor,
      });
      expect(testEnvironment.model.requestsSince(restartMarker)[0]!.body)
        .not.toHaveProperty('service_tier');

      await patchFastMode(fixture.client, fastChatId, 'on');
      const blockerReply = marker('QUEUE_BLOCKER_FAST_REPLY');
      const heldBlocker = testEnvironment.model.scriptHeldTurn([
        codexAssistantMessage(blockerReply),
      ]);
      const blockerCursor = fixture.client.markEvents();
      const blocker = await fixture.client.runChat(liveCodexRunRequest({
        chatId: fastChatId,
        command: marker('QUEUE_BLOCKER_FAST_PROMPT'),
        fastMode: 'on',
      }));
      expect((await heldBlocker.requested).body.service_tier).toBe('priority');
      const queuedPrompt = marker('QUEUED_WHILE_FAST');
      const queued = await fixture.client.enqueueNew(fastChatId, queuedPrompt);
      expect(queued.control.queue.entries).toHaveLength(1);
      expect(queued.control.queue.entries[0]).not.toHaveProperty('agentSettings');
      const paused = await fixture.client.pauseQueue(fastChatId);
      expect(paused.control.queue.pause?.kind).toBe('manual');
      await patchFastMode(fixture.client, fastChatId, 'off');
      await expectPersistedFastMode(fixture.dirs, fastChatId, 'off');
      heldBlocker.release();
      await waitForVisibleResponse({
        fixture,
        chatId: fastChatId,
        turnId: blocker.turnId,
        marker: blockerReply,
        afterIndex: blockerCursor,
      });
      const queuedReply = marker('QUEUED_STANDARD_REPLY');
      testEnvironment.model.scriptTurn([codexAssistantMessage(queuedReply)]);
      const queueMarker = testEnvironment.model.markRequests();
      const queueCursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(fastChatId, paused.control.queue.pause!.id);
      const queuedTerminal = await fixture.client.waitForTurnTerminal(
        fastChatId,
        undefined,
        { afterIndex: queueCursor },
      );
      await waitForVisibleResponse({
        fixture,
        chatId: fastChatId,
        turnId: queuedTerminal.turnId,
        marker: queuedReply,
        afterIndex: queueCursor,
      });
      const queuedRequests = testEnvironment.model.requestsSince(queueMarker);
      expect(queuedRequests).toHaveLength(1);
      expect(queuedRequests[0]!.lastUserText).toContain(queuedPrompt);
      expect(queuedRequests[0]!.body).not.toHaveProperty('service_tier');
      await expectPersistedFastMode(fixture.dirs, fastChatId, 'off');
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 180_000);

  test('rejects unsupported Priority before a model request and preserves live Off', async () => {
    environment = await startScriptedCodexTestEnvironment({ supportsPriority: false });
    const testEnvironment = environment;

    await withIntegrationFixture('codex-fast-mode-unsupported', async (fixture) => {
      const unsupportedChatId = fixture.newChatId();
      const unsupportedMarker = testEnvironment.model.markRequests();
      const unsupportedCursor = fixture.client.markEvents();
      await expect(fixture.client.startChat(liveCodexStartRequest({
        chatId: unsupportedChatId,
        projectPath: fixture.dirs.project,
        command: marker('UNSUPPORTED_FAST_PROMPT'),
        fastMode: 'on',
      }))).rejects.toBeInstanceOf(GarconApiError);
      const terminal = await fixture.client.waitForEvent(
        (event): event is AgentRunFailedMessage => (
          event.type === 'agent-run-failed' && event.chatId === unsupportedChatId
        ),
        'unsupported Codex Fast mode failure',
        { afterIndex: unsupportedCursor },
      );
      expect(terminal.error).toContain('Fast mode is unavailable');
      expect(testEnvironment.model.requestsSince(unsupportedMarker)).toEqual([]);

      const liveChatId = fixture.newChatId();
      const held = testEnvironment.model.scriptHeldTurn([
        codexAssistantMessage(marker('LIVE_STANDARD_REPLY')),
      ]);
      const liveCursor = fixture.client.markEvents();
      const live = await fixture.client.startChat(liveCodexStartRequest({
        chatId: liveChatId,
        projectPath: fixture.dirs.project,
        command: marker('LIVE_STANDARD_PROMPT'),
        fastMode: 'off',
      }));
      const liveRequest = await held.requested;
      expect(liveRequest.body).not.toHaveProperty('service_tier');

      let patchError: unknown;
      try {
        await patchFastMode(fixture.client, liveChatId, 'on');
      } catch (error) {
        patchError = error;
      }
      expect(patchError).toBeInstanceOf(GarconApiError);
      expect(patchError).toMatchObject({
        status: 422,
        body: { errorCode: 'INVALID_SETTINGS' },
      });
      await expectPersistedFastMode(fixture.dirs, liveChatId, 'off');

      held.release();
      await waitForVisibleResponse({
        fixture,
        chatId: liveChatId,
        turnId: live.turnId,
        afterIndex: liveCursor,
      });
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 120_000);
});

function marker(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function patchFastMode(
  client: GarconTestClient,
  chatId: string,
  mode: CodexFastMode,
): Promise<ExecutionSettingsPatchResponse> {
  return client.patch('/api/v1/chats/execution-settings', {
    chatId,
    agentSettingsPatch: { codexFastMode: mode },
  });
}

async function expectPersistedFastMode(
  directories: IntegrationDirectories,
  chatId: string,
  expected: CodexFastMode,
): Promise<void> {
  await waitForPersistedChat({
    directories,
    chatId,
    timeoutMessage: `Chat ${chatId} did not persist Codex Fast mode ${expected}.`,
    select: (chat) => {
      const settingsById = chat.agentSettingsById;
      if (!settingsById || typeof settingsById !== 'object' || Array.isArray(settingsById)) {
        return null;
      }
      const settings = (settingsById as Record<string, unknown>).codex;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
      const values = (settings as Record<string, unknown>).values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
      return (values as Record<string, unknown>).codexFastMode === expected ? true : null;
    },
  });
}
