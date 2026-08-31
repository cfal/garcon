import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type {
  CommandAcceptedResponse,
  CompactCommandRequest,
  ForkRunCommandResponse,
} from '../../../common/chat-command-contracts.js';
import type { SelfHandoffRunCommandRequest } from '../../../common/self-handoff-contracts.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import {
  type IntegrationDirectories,
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  reloadUntilNativeContains,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  codexAgentSettings,
  liveCodexForkRunRequest,
  liveCodexRunRequest,
  liveCodexStartRequest,
  type CodexFastMode,
} from '../../support/live-codex.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('Codex Fast mode command snapshots', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment({ supportsPriority: true });
  });

  afterEach(() => {
    environment?.model.reset();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('makes compact, handoff, fork-run, and native fork snapshots authoritative', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;

    await withIntegrationFixture('codex-fast-mode-command-snapshots', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourcePrompt = marker('SOURCE_ON_PROMPT');
      const sourceReply = marker('SOURCE_ON_REPLY');
      testEnvironment.model.scriptTurn([codexAssistantMessage(sourceReply)]);
      const sourceMarker = testEnvironment.model.markRequests();
      const sourceCursor = fixture.client.markEvents();
      const source = await fixture.client.startChat(liveCodexStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: sourcePrompt,
        fastMode: 'on',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: source.turnId,
        marker: sourceReply,
        afterIndex: sourceCursor,
      });
      expect(testEnvironment.model.requestsSince(sourceMarker)).toHaveLength(1);
      expect(testEnvironment.model.requestsSince(sourceMarker)[0]!.body.service_tier)
        .toBe('priority');
      await reloadUntilNativeContains(fixture, sourceChatId, sourceReply);
      await expectPersistedFastMode(fixture.dirs, sourceChatId, 'on');

      const compactSummary = marker('COMPACT_STANDARD_SUMMARY');
      testEnvironment.model.scriptTurn([codexAssistantMessage(compactSummary)]);
      const compactMarker = testEnvironment.model.markRequests();
      const compactCursor = fixture.client.markEvents();
      const compactRequest: CompactCommandRequest = {
        clientRequestId: crypto.randomUUID(),
        chatId: sourceChatId,
        agentSettings: codexAgentSettings('off'),
        instructions: 'Produce a deterministic compact summary.',
      };
      const compact = await fixture.client.post<CommandAcceptedResponse>(
        '/api/v1/chats/compact',
        compactRequest,
      );
      if (!compact.turnId) throw new Error('Codex compact response omitted its turn id.');
      expect((await fixture.client.waitForTurnTerminal(
        sourceChatId,
        compact.turnId,
        { afterIndex: compactCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      )).type).toBe('agent-run-finished');
      await fixture.client.waitForProcessing(sourceChatId, false, {
        afterIndex: compactCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(testEnvironment.model.requestsSince(compactMarker)).toHaveLength(1);
      expect(testEnvironment.model.requestsSince(compactMarker)[0]!.body)
        .not.toHaveProperty('service_tier');
      await expectPersistedFastMode(fixture.dirs, sourceChatId, 'on');

      const handoffTargetId = fixture.newChatId();
      const handoffPrompt = marker('HANDOFF_OFF_PROMPT');
      const handoffReply = marker('HANDOFF_OFF_REPLY');
      testEnvironment.model.scriptTurn([codexAssistantMessage(handoffReply)]);
      const handoffMarker = testEnvironment.model.markRequests();
      const handoffCursor = fixture.client.markEvents();
      const handoffRequest: SelfHandoffRunCommandRequest = {
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        sourceChatId,
        chatId: handoffTargetId,
        command: handoffPrompt,
        agentSettings: codexAgentSettings('off'),
      };
      const handoff = await fixture.client.post<ForkRunCommandResponse>(
        '/api/v1/chats/handoff-run',
        handoffRequest,
      );
      await waitForVisibleResponse({
        fixture,
        chatId: handoffTargetId,
        turnId: handoff.turnId,
        marker: handoffReply,
        afterIndex: handoffCursor,
      });
      expect(handoff.chat.agentSettings).toEqual(codexAgentSettings('off'));
      expect(handoff.chat.parentChat).toMatchObject({
        chatId: sourceChatId,
        relation: 'handoff',
      });
      expect(testEnvironment.model.requestsSince(handoffMarker)).toHaveLength(1);
      expect(testEnvironment.model.requestsSince(handoffMarker)[0]!.body)
        .not.toHaveProperty('service_tier');
      await expectPersistedFastMode(fixture.dirs, handoffTargetId, 'off');
      await expectPersistedFastMode(fixture.dirs, sourceChatId, 'on');

      const forkRunTargetId = fixture.newChatId();
      const forkRunPrompt = marker('FORK_RUN_OFF_PROMPT');
      const forkRunReply = marker('FORK_RUN_OFF_REPLY');
      testEnvironment.model.scriptTurn([codexAssistantMessage(forkRunReply)]);
      const forkRunMarker = testEnvironment.model.markRequests();
      const forkRunCursor = fixture.client.markEvents();
      const forkRun = await fixture.client.forkRunChat(liveCodexForkRunRequest({
        sourceChatId,
        chatId: forkRunTargetId,
        command: forkRunPrompt,
        fastMode: 'off',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: forkRunTargetId,
        turnId: forkRun.turnId,
        marker: forkRunReply,
        afterIndex: forkRunCursor,
      });
      expect(forkRun.chat.agentSettings).toEqual(codexAgentSettings('off'));
      expect(forkRun.chat.parentChat).toMatchObject({
        chatId: sourceChatId,
        relation: 'fork',
      });
      expect(testEnvironment.model.requestsSince(forkRunMarker)).toHaveLength(1);
      expect(testEnvironment.model.requestsSince(forkRunMarker)[0]!.body)
        .not.toHaveProperty('service_tier');
      await expectPersistedFastMode(fixture.dirs, forkRunTargetId, 'off');
      await expectPersistedFastMode(fixture.dirs, sourceChatId, 'on');

      await assertBareForkTier({
        fixture,
        environment: testEnvironment,
        sourceChatId,
        fastMode: 'off',
      });
      await assertBareForkTier({
        fixture,
        environment: testEnvironment,
        sourceChatId,
        fastMode: 'on',
      });
      await expectPersistedFastMode(fixture.dirs, sourceChatId, 'on');

      const standardSourceId = fixture.newChatId();
      const standardSourceReply = marker('SOURCE_OFF_REPLY');
      testEnvironment.model.scriptTurn([codexAssistantMessage(standardSourceReply)]);
      const standardSourceCursor = fixture.client.markEvents();
      const standardSource = await fixture.client.startChat(liveCodexStartRequest({
        chatId: standardSourceId,
        projectPath: fixture.dirs.project,
        command: marker('SOURCE_OFF_PROMPT'),
        fastMode: 'off',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: standardSourceId,
        turnId: standardSource.turnId,
        marker: standardSourceReply,
        afterIndex: standardSourceCursor,
      });
      await reloadUntilNativeContains(fixture, standardSourceId, standardSourceReply);
      await expectPersistedFastMode(fixture.dirs, standardSourceId, 'off');

      const priorityTargetId = fixture.newChatId();
      const priorityReply = marker('PRIORITY_SNAPSHOT_REPLY');
      testEnvironment.model.scriptTurn([codexAssistantMessage(priorityReply)]);
      const priorityMarker = testEnvironment.model.markRequests();
      const priorityCursor = fixture.client.markEvents();
      const priority = await fixture.client.forkRunChat(liveCodexForkRunRequest({
        sourceChatId: standardSourceId,
        chatId: priorityTargetId,
        command: marker('PRIORITY_SNAPSHOT_PROMPT'),
        fastMode: 'on',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: priorityTargetId,
        turnId: priority.turnId,
        marker: priorityReply,
        afterIndex: priorityCursor,
      });
      expect(testEnvironment.model.requestsSince(priorityMarker)).toHaveLength(1);
      expect(testEnvironment.model.requestsSince(priorityMarker)[0]!.body.service_tier)
        .toBe('priority');
      expect(priority.chat.agentSettings).toEqual(codexAgentSettings('on'));
      await expectPersistedFastMode(fixture.dirs, priorityTargetId, 'on');
      await expectPersistedFastMode(fixture.dirs, standardSourceId, 'off');
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 180_000);
});

async function assertBareForkTier(input: {
  readonly fixture: IntegrationFixture;
  readonly environment: ScriptedCodexTestEnvironment;
  readonly sourceChatId: string;
  readonly fastMode: CodexFastMode;
}): Promise<void> {
  const targetChatId = input.fixture.newChatId();
  const fork = await input.fixture.client.forkChat({
    sourceChatId: input.sourceChatId,
    chatId: targetChatId,
    agentSettings: codexAgentSettings(input.fastMode),
  });
  expect(fork.chat.agentSettings).toEqual(codexAgentSettings(input.fastMode));
  expect(fork.chat.parentChat).toMatchObject({
    chatId: input.sourceChatId,
    relation: 'fork',
  });
  await expectPersistedFastMode(input.fixture.dirs, targetChatId, input.fastMode);

  const reply = marker(`BARE_FORK_${input.fastMode.toUpperCase()}_REPLY`);
  input.environment.model.scriptTurn([codexAssistantMessage(reply)]);
  const requestMarker = input.environment.model.markRequests();
  const cursor = input.fixture.client.markEvents();
  const turn = await input.fixture.client.runChat(withoutAgentSettings(liveCodexRunRequest({
    chatId: targetChatId,
    command: marker(`BARE_FORK_${input.fastMode.toUpperCase()}_PROMPT`),
    fastMode: input.fastMode,
  })));
  await waitForVisibleResponse({
    fixture: input.fixture,
    chatId: targetChatId,
    turnId: turn.turnId,
    marker: reply,
    afterIndex: cursor,
  });
  expect(input.environment.model.requestsSince(requestMarker)).toHaveLength(1);
  const body = input.environment.model.requestsSince(requestMarker)[0]!.body;
  if (input.fastMode === 'on') {
    expect(body.service_tier).toBe('priority');
  } else {
    expect(body).not.toHaveProperty('service_tier');
  }
}

function withoutAgentSettings<T extends { readonly agentSettings?: unknown }>(
  request: T,
): Omit<T, 'agentSettings'> {
  const { agentSettings, ...rest } = request;
  void agentSettings;
  return rest;
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
      const settingsById = record(chat.agentSettingsById);
      const settings = record(settingsById?.codex);
      const values = record(settings?.values);
      return values?.codexFastMode === expected ? true : null;
    },
  });
}

function marker(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
