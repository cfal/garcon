import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentTurnCommandResponse, CommandAcceptedResponse, CompactCommandRequest, ExecutionSettingsPatchRequest,
} from '../../../common/chat-command-contracts.js';
import { generationModelTestConfigurationKey, type GenerationModelTestResponse } from '../../../common/generation-test-contracts.js';
import { codexUsageFormat } from '../../../server-agents/codex/src/agents/codex/usage-format.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { codexRequestModel, LIVE_CODEX_THINKING_MODE, liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment, type ScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { prepareScriptedCodexSpeed, STANDARD_ONLY_MODEL } from '../../support/scripted-codex-speed.js';

type Speed = 'standard' | 'fast' | 'ultrafast';
type InferenceTier = 'priority' | 'ultrafast' | undefined;

describe('Codex scripted per-chat speed', () => {
  let environment: ScriptedCodexTestEnvironment;
  beforeAll(async () => { environment = await startScriptedCodexTestEnvironment(); });
  afterAll(async () => { await environment?.dispose(); });

  test('starts premium chats directly and overrides their host default for an empty Standard envelope', async () => {
    await withIntegrationFixture('codex-speed-start', async (fixture) => {
      const config = join(fixture.executionDirs.home, '.codex', 'config.toml');
      const originalConfig = await readFile(config, 'utf8');
      expect(originalConfig).toContain('service_tier = "ultrafast"');
      for (const [speed, tier] of [['fast', 'priority'], ['ultrafast', 'ultrafast'], ['standard', undefined]] as const) {
        const chatId = fixture.newChatId();
        const marker = `Synthetic ${speed} start`;
        const before = environment.model.requests().length;
        environment.model.scriptTurn([codexAssistantMessage(marker)]);
        const afterIndex = fixture.client.markEvents();
        const turn = await fixture.client.startChat({
          ...liveCodexStartRequest({ chatId, projectPath: fixture.executionDirs.project, command: marker }),
          agentSettings: { ownerId: 'codex', schemaVersion: 1, values: speed === 'standard' ? {} : { speed } },
        });
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker, afterIndex });
        expect(environment.model.requests()).toHaveLength(before + 1);
        const body = environment.model.requests()[before]!.body;
        expect(body).toMatchObject({ model: codexRequestModel(), reasoning: { effort: LIVE_CODEX_THINKING_MODE } });
        expect(body.service_tier).toBe(tier);
      }
      expect(await readFile(config, 'utf8')).toBe(originalConfig);
      environment.model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: (directories) => prepareScriptedCodexSpeed(environment, directories),
    });
  }, 60_000);

  test('routes per-chat speed without changing model, effort or executor config', async () => {
    await withIntegrationFixture('codex-speed', async (fixture) => {
      const config = join(fixture.executionDirs.home, '.codex', 'config.toml');
      const originalConfig = await readFile(config, 'utf8');
      const restrictedConfig = `features.ultrafast_mode = false\n${originalConfig}`;
      const fastChat = fixture.newChatId();
      const standardChat = fixture.newChatId();
      const premiumChild = fixture.newChatId();
      const standardChild = fixture.newChatId();
      const savedSettings = async (chatId: string) => {
        const { sessions } = await fixture.client.listChats();
        const chat = sessions.find(({ id }) => id === chatId);
        if (!chat) throw new Error(`Missing test chat: ${chatId}`);
        return chat.agentSettings;
      };
      const startChat = (chatId: string) => fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'Synthetic speed check.',
      }));
      const resumeChat = async (chatId: string) => fixture.client.runChat({
        ...liveCodexRunRequest({ chatId, command: 'Continue synthetic speed check.' }),
        agentSettings: await savedSettings(chatId),
      });
      const recordedSpeeds = async (chatId: string) => {
        const native = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
        const path = native.nativeSession?.value.path;
        if (typeof path !== 'string') throw new Error('Missing synthetic rollout path');
        const usageState = codexUsageFormat.createState();
        return (await readFile(path, 'utf8')).split('\n').flatMap((line) => {
          if (!codexUsageFormat.lineMarkers.some((marker) => line.includes(marker))) return [];
          const record = codexUsageFormat.parseLine(line, usageState);
          return record && 'speed' in record ? [record.speed] : [];
        });
      };
      const expectTurnTier = async (
        submit: (id: string) => Promise<AgentTurnCommandResponse>, chatId: string, expectedTier: InferenceTier,
      ) => {
        const marker = `speed-${crypto.randomUUID()}`;
        const index = environment.model.requests().length;
        environment.model.scriptTurn([codexAssistantMessage(marker)]);
        const afterIndex = fixture.client.markEvents();
        const turn = await submit(chatId);
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker, afterIndex });
        // Codex sends explicit Standard to its thread API, then omits the tier on inference.
        // https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/protocol/src/openai_models.rs#L1144-L1149
        const body = environment.model.requests()[index]!.body;
        expect(body).toMatchObject({ model: codexRequestModel(), reasoning: { effort: LIVE_CODEX_THINKING_MODE } });
        expect(body.service_tier).toBe(expectedTier);
      };
      const changeSpeed = async (chatId: string, speed: Speed, thinkingMode?: ExecutionSettingsPatchRequest['thinkingMode']) => {
        const response = await fixture.client.fetch('/api/v1/chats/execution-settings', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, thinkingMode, agentSettingsPatch: { speed } } satisfies ExecutionSettingsPatchRequest),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true, agentSettings: { values: { speed } } });
      };

      await expectTurnTier(startChat, standardChat, undefined);
      await writeFile(config, restrictedConfig);
      await expectTurnTier(startChat, fastChat, undefined);
      const beforeChange = environment.model.requests().length;
      await writeFile(config, 'invalid = [\n');
      try {
        await changeSpeed(fastChat, 'fast');
        expect((await savedSettings(fastChat)).values.speed).toBe('fast');
      } finally {
        await writeFile(config, restrictedConfig);
      }
      await changeSpeed(fastChat, 'fast');
      expect(environment.model.requests()).toHaveLength(beforeChange);
      await expectTurnTier(resumeChat, fastChat, 'priority');
      await expectTurnTier(resumeChat, standardChat, undefined);

      const held = environment.model.scriptHeldTurn([codexAssistantMessage('Finished the held turn.')]);
      const queuedPrompt = 'Use the saved speed when this is dequeued.';
      environment.model.scriptTurn([codexAssistantMessage('Finished the queued turn.')]);
      const queueCursor = fixture.client.markEvents();
      const running = await fixture.client.runChat({
        ...liveCodexRunRequest({ chatId: fastChat, command: 'Hold this turn.' }),
        agentSettings: { ownerId: 'codex', schemaVersion: 1, values: { speed: 'fast' } },
      });
      try {
        expect((await held.requested).body.service_tier).toBe('priority');
        await fixture.client.enqueueNew(fastChat, queuedPrompt);
        // The next operation reloads config; the active turn keeps its admitted tier.
        expect(await readFile(config, 'utf8')).toBe(restrictedConfig);
        await writeFile(config, originalConfig);
        await changeSpeed(fastChat, 'ultrafast');
      } finally {
        held.release();
      }
      await fixture.client.waitForTurnTerminal(fastChat, running.turnId, { afterIndex: queueCursor });
      const queued = await fixture.client.waitForCommittedUserInput(fastChat, queuedPrompt, { afterIndex: queueCursor });
      const queuedTerminal = await fixture.client.waitForTurnTerminal(fastChat, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(queued) + 1,
      });
      expect(queuedTerminal.type).toBe('agent-run-finished');
      expect(environment.model.requests().at(-1)?.body.service_tier).toBe('ultrafast');
      await expectTurnTier(resumeChat, fastChat, 'ultrafast');
      await expectTurnTier(resumeChat, standardChat, undefined);

      for (const [sourceChatId, child, tier] of [
        [fastChat, premiumChild, 'ultrafast'],
        [standardChat, standardChild, undefined],
      ] as const) {
        const beforeFork = environment.model.requests().length;
        await fixture.client.forkChat({ sourceChatId, chatId: child });
        expect(environment.model.requests()).toHaveLength(beforeFork);
        await expectTurnTier(resumeChat, child, tier);
      }
      await fixture.restartGarcon();
      expect((await savedSettings(fastChat)).values.speed).toBe('ultrafast');
      await expectTurnTier(resumeChat, fastChat, 'ultrafast');
      await changeSpeed(standardChild, 'fast');
      for (const [child, tier, expectedSpeeds] of [
        [premiumChild, 'ultrafast', ['ultrafast', 'ultrafast']],
        [standardChild, 'priority', ['standard', 'fast']],
      ] satisfies [string, InferenceTier, Speed[]][]) {
        await expectTurnTier(resumeChat, child, tier);
        expect(await recordedSpeeds(child)).toEqual(expectedSpeeds);
      }

      await changeSpeed(fastChat, 'fast');
      environment.model.scriptTurn([codexAssistantMessage('Synthetic compaction summary.')]);
      const beforeCompact = environment.model.requests().length;
      const compactCursor = fixture.client.markEvents();
      const compact = await fixture.client.post<CommandAcceptedResponse>('/api/v1/chats/compact', {
        chatId: fastChat, clientRequestId: crypto.randomUUID(),
      } satisfies CompactCommandRequest);
      const compactTerminal = await fixture.client.waitForTurnTerminal(fastChat, compact.turnId, { afterIndex: compactCursor });
      expect(compactTerminal.type).toBe('agent-run-finished');
      expect(environment.model.requests()[beforeCompact]?.body.service_tier).toBe('priority');
      expect(await recordedSpeeds(fastChat)).toEqual(['standard', 'fast', 'fast', 'ultrafast', 'ultrafast', 'ultrafast', 'fast']);
      await changeSpeed(fastChat, 'standard');
      await expectTurnTier(resumeChat, fastChat, undefined);
      expect(await readFile(config, 'utf8')).toBe(originalConfig);

      await fixture.client.patch('/api/v1/chats/model', { chatId: fastChat, model: STANDARD_ONLY_MODEL });
      const beforeRejection = environment.model.requests().length;
      for (const thinkingMode of [undefined, 'none'] as const) {
        await changeSpeed(fastChat, 'ultrafast', thinkingMode);
        expect((await savedSettings(fastChat)).values.speed).toBe('ultrafast');
        const cursor = fixture.client.markEvents();
        const denied = await fixture.client.runChat({
          ...liveCodexRunRequest({ chatId: fastChat, command: 'Must not infer with an unavailable speed.' }),
          model: STANDARD_ONLY_MODEL, thinkingMode: thinkingMode ?? LIVE_CODEX_THINKING_MODE,
          agentSettings: await savedSettings(fastChat),
        });
        expect(await fixture.client.waitForTurnTerminal(fastChat, denied.turnId, { afterIndex: cursor }))
          .toMatchObject({ type: 'agent-run-failed', error: expect.stringContaining('Ultrafast speed is unavailable') });
      }
      expect(environment.model.requests()).toHaveLength(beforeRejection);
      // Fork-run creates the native child from source settings before applying run overrides.
      expect(await rejectionOf(fixture.client.forkRunChat({
        sourceChatId: fastChat, chatId: fixture.newChatId(), model: codexRequestModel(),
        command: 'An override must not bypass source fork validation.', thinkingMode: LIVE_CODEX_THINKING_MODE,
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
      }))).toMatchObject({ status: 422, body: { errorCode: 'INVALID_SETTINGS',
        error: expect.stringContaining('Ultrafast speed is unavailable') } });
      expect(environment.model.requests()).toHaveLength(beforeRejection);
      await changeSpeed(fastChat, 'standard');
      await fixture.client.patch('/api/v1/chats/model', { chatId: fastChat, model: codexRequestModel() });
      await fixture.client.fetch('/api/v1/chats/execution-settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: fastChat, thinkingMode: LIVE_CODEX_THINKING_MODE } satisfies ExecutionSettingsPatchRequest),
      }).then((response) => expect(response.status).toBe(200));
      await expectTurnTier(resumeChat, fastChat, undefined);
      const beforeColdRejection = environment.model.requests().length;

      await fixture.restartGarcon({ beforeStart: () => writeFile(config, restrictedConfig) });
      const denial = await rejectionOf(fixture.client.startChat({
        ...liveCodexStartRequest({
          chatId: fixture.newChatId(), projectPath: fixture.executionDirs.project, command: 'Must never reach inference.',
        }),
        agentSettings: { ownerId: 'codex', schemaVersion: 1, values: { speed: 'ultrafast' } },
      }));
      expect(denial).toMatchObject({
        status: 422, body: { errorCode: 'INVALID_SETTINGS', error: expect.stringContaining('Ultrafast speed is unavailable') },
      });
      const resumeCursor = fixture.client.markEvents();
      const rejectedResume = await resumeChat(premiumChild);
      expect(await fixture.client.waitForTurnTerminal(premiumChild, rejectedResume.turnId, { afterIndex: resumeCursor }))
        .toMatchObject({ type: 'agent-run-failed', error: expect.stringContaining('Ultrafast speed is unavailable') });
      const beforeForkRejection = (await fixture.client.listChats()).sessions.map(({ id }) => id).sort();
      expect(await rejectionOf(fixture.client.forkChat({ sourceChatId: premiumChild, chatId: fixture.newChatId() })))
        .toMatchObject({ status: 422, body: { errorCode: 'INVALID_SETTINGS',
          error: expect.stringContaining('Ultrafast speed is unavailable') } });
      expect((await fixture.client.listChats()).sessions.map(({ id }) => id).sort()).toEqual(beforeForkRejection);
      expect(environment.model.requests()).toHaveLength(beforeColdRejection);
      environment.model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: (directories) => prepareScriptedCodexSpeed(environment, directories),
    });
  }, 120_000);

  test('leaves premium capacity failures for a manually admitted retry', async () => {
    await withIntegrationFixture('codex-speed-capacity', async (fixture) => {
      for (const [speed, tier] of [['fast', 'priority'], ['ultrafast', 'ultrafast']] as const) {
        const chatId = fixture.newChatId();
        const agentSettings = { ownerId: 'codex', schemaVersion: 1, values: { speed } };
        const before = environment.model.requests().length;
        environment.model.scriptFault({ kind: 'stream-error', code: 'server_is_overloaded', message: 'Synthetic capacity failure.' });
        const cursor = fixture.client.markEvents();
        const failed = await fixture.client.startChat({
          ...liveCodexStartRequest({ chatId, projectPath: fixture.executionDirs.project, command: 'Synthetic capacity check.' }),
          agentSettings,
        });
        expect(await fixture.client.waitForTurnTerminal(chatId, failed.turnId, { afterIndex: cursor }))
          .toMatchObject({ type: 'agent-run-failed', error: expect.stringContaining('capacity') });
        expect(environment.model.requests()).toHaveLength(before + 1);
        expect(environment.model.requests().at(-1)?.body.service_tier).toBe(tier);
        const marker = `Synthetic manual ${speed} retry.`;
        environment.model.scriptTurn([codexAssistantMessage(marker)]);
        const retryCursor = fixture.client.markEvents();
        const retry = await fixture.client.runChat({ ...liveCodexRunRequest({ chatId, command: marker }), agentSettings });
        await waitForVisibleResponse({ fixture, chatId, turnId: retry.turnId, marker, afterIndex: retryCursor });
        expect(environment.model.requests()).toHaveLength(before + 2);
        expect(environment.model.requests().at(-1)?.body.service_tier).toBe(tier);
      }
      environment.model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: async (directories) => {
        await prepareScriptedCodexSpeed(environment, directories);
        const config = join(directories.home, '.codex', 'config.toml');
        // Isolates Garcon's retry policy from the native transport's own retry budget.
        await writeFile(config, `${await readFile(config, 'utf8')}stream_max_retries = 0\n`);
      },
    });
  }, 60_000);

  test('runs background generation at Standard despite an Ultrafast executor default', async () => {
    await withIntegrationFixture('codex-speed-generation', async ({ client }) => {
      const selection = { executorId: client.executorId, agentId: 'codex', model: codexRequestModel(), thinkingMode: LIVE_CODEX_THINKING_MODE } as const;
      await client.updateSettings({ ui: { commitMessage: selection } });
      const index = environment.model.requests().length;
      environment.model.scriptTurn([codexAssistantMessage('OK')]);
      const result = await client.post<GenerationModelTestResponse>('/api/v1/app/generation/test', {
        target: 'commitMessage', configurationKey: generationModelTestConfigurationKey(selection),
      });
      expect(result.success).toBe(true);
      expect(environment.model.requests()).toHaveLength(index + 1);
      const { body } = environment.model.requests()[index]!;
      expect(body.model).toBe(selection.model);
      expect(body.service_tier).toBeUndefined();
      environment.model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: (directories) => prepareScriptedCodexSpeed(environment, directories),
    });
  }, 60_000);
});
