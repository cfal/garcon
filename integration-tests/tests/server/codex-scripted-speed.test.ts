import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandAcceptedResponse, CompactCommandRequest } from '../../../common/chat-command-contracts.js';
import { generationModelTestConfigurationKey, type GenerationModelTestResponse } from '../../../common/generation-test-contracts.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { codexRequestModel, LIVE_CODEX_THINKING_MODE, liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment, type ScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { prepareScriptedCodexSpeed, STANDARD_ONLY_MODEL } from '../../support/scripted-codex-speed.js';

describe('Codex scripted per-chat speed', () => {
  let environment: ScriptedCodexTestEnvironment;
  beforeAll(async () => { environment = await startScriptedCodexTestEnvironment(); });
  afterAll(async () => { await environment?.dispose(); });

  test('routes per-chat speed without changing model, effort or executor config', async () => {
    await withIntegrationFixture('codex-speed', async (fixture) => {
      const config = join(fixture.executionDirs.home, '.codex', 'config.toml');
      const originalConfig = await readFile(config, 'utf8');
      const restrictedConfig = `features.ultrafast_mode = false\n${originalConfig}`;
      await writeFile(config, restrictedConfig);
      const fastChat = fixture.newChatId();
      const standardChat = fixture.newChatId();
      const run = async (chatId: string, expectedTier: string, start = false) => {
        const marker = `speed-${crypto.randomUUID()}`;
        const index = environment.model.requests().length;
        environment.model.scriptTurn([codexAssistantMessage(marker)]);
        const afterIndex = fixture.client.markEvents();
        const turn = start
          ? await fixture.client.startChat(liveCodexStartRequest({ chatId, projectPath: fixture.executionDirs.project, command: 'Synthetic speed check.' }))
          : await fixture.client.runChat({
            ...liveCodexRunRequest({ chatId, command: 'Continue synthetic speed check.' }),
            agentSettings: (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)!.agentSettings,
          });
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker, afterIndex });
        // Codex sends explicit Standard to its thread API, then omits the tier on inference.
        // https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/protocol/src/openai_models.rs#L1144-L1149
        const body = environment.model.requests()[index]!.body;
        expect(body).toMatchObject({ model: codexRequestModel(), reasoning: { effort: LIVE_CODEX_THINKING_MODE } });
        expect(body.service_tier)
          .toBe(expectedTier === 'default' ? undefined : expectedTier);
      };
      const changeSpeed = async (speed: 'standard' | 'fast' | 'ultrafast') => {
        const response = await fixture.client.fetch('/api/v1/chats/execution-settings', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: fastChat, agentSettingsPatch: { speed } }),
        });
        expect({ status: response.status, body: await response.json() }).toMatchObject({
          status: 200, body: { success: true, agentSettings: { values: { speed } } },
        });
      };

      await run(fastChat, 'default', true);
      await run(standardChat, 'default', true);
      const beforeChange = environment.model.requests().length;
      await changeSpeed('fast');
      expect(environment.model.requests()).toHaveLength(beforeChange);
      await run(fastChat, 'priority');
      await run(standardChat, 'default');
      const held = environment.model.scriptHeldTurn([codexAssistantMessage('Finished the held turn.')]);
      const queuedMarker = 'Finished the queued turn.';
      environment.model.scriptTurn([codexAssistantMessage(queuedMarker)]);
      const queueCursor = fixture.client.markEvents();
      const running = await fixture.client.runChat({ ...liveCodexRunRequest({ chatId: fastChat, command: 'Hold this turn.' }),
        agentSettings: { ownerId: 'codex', schemaVersion: 1, values: { speed: 'fast' } } });
      try {
        expect((await held.requested).body.service_tier).toBe('priority');
        await fixture.client.enqueueNew(fastChat, 'Use the saved speed when this is dequeued.');
        // Feature discovery reloads this file, but the active thread still filters with its original config.
        expect(await readFile(config, 'utf8')).toBe(restrictedConfig);
        await writeFile(config, originalConfig);
        await changeSpeed('ultrafast');
      } finally {
        held.release();
      }
      await fixture.client.waitForTurnTerminal(fastChat, running.turnId, { afterIndex: queueCursor });
      const queued = await fixture.client.waitForCommittedUserInput(fastChat, 'Use the saved speed when this is dequeued.', { afterIndex: queueCursor });
      const queuedTerminal = await fixture.client.waitForTurnTerminal(fastChat, undefined, { afterIndex: fixture.client.events().lastIndexOf(queued) + 1 });
      expect(queuedTerminal.type).toBe('agent-run-finished');
      expect(environment.model.requests().at(-1)?.body.service_tier).toBe('ultrafast');
      await run(fastChat, 'ultrafast');
      await run(standardChat, 'default');
      for (const [sourceChatId, tier] of [[fastChat, 'ultrafast'], [standardChat, 'default']] as const) {
        const child = fixture.newChatId();
        const beforeFork = environment.model.requests().length;
        await fixture.client.forkChat({ sourceChatId, chatId: child });
        expect(environment.model.requests()).toHaveLength(beforeFork);
        await run(child, tier);
      }
      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === fastChat)?.agentSettings.values.speed).toBe('ultrafast');
      await run(fastChat, 'ultrafast');
      await changeSpeed('fast');
      environment.model.scriptTurn([codexAssistantMessage('Synthetic compaction summary.')]);
      const beforeCompact = environment.model.requests().length;
      const compactCursor = fixture.client.markEvents();
      const compact = await fixture.client.post<CommandAcceptedResponse>('/api/v1/chats/compact', {
        chatId: fastChat, clientRequestId: crypto.randomUUID(),
      } satisfies CompactCommandRequest);
      expect((await fixture.client.waitForTurnTerminal(fastChat, compact.turnId, { afterIndex: compactCursor })).type).toBe('agent-run-finished');
      expect(environment.model.requests()[beforeCompact]?.body.service_tier).toBe('priority');
      await changeSpeed('standard');
      await run(fastChat, 'default');
      expect(await readFile(config, 'utf8')).toBe(originalConfig);
      await fixture.client.patch('/api/v1/chats/model', { chatId: fastChat, model: STANDARD_ONLY_MODEL });
      const beforeRejection = environment.model.requests().length;
      for (const thinkingMode of [undefined, 'none']) {
        const unavailable = await fixture.client.fetch('/api/v1/chats/execution-settings', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: fastChat, thinkingMode, agentSettingsPatch: { speed: 'ultrafast' } }),
        });
        expect(unavailable.ok).toBe(false);
        expect(await unavailable.text()).toContain('Ultrafast speed is unavailable');
      }
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === fastChat)?.agentSettings.values.speed).toBe('standard');
      expect(environment.model.requests()).toHaveLength(beforeRejection);
      await fixture.restartGarcon({ beforeStart: () => writeFile(config, restrictedConfig) });
      const denied = fixture.newChatId();
      const denial = await rejectionOf(fixture.client.startChat({ ...liveCodexStartRequest({ chatId: denied,
        projectPath: fixture.executionDirs.project, command: 'Must never reach inference.' }),
        agentSettings: { ownerId: 'codex', schemaVersion: 1, values: { speed: 'ultrafast' } } }));
      expect(denial).toMatchObject({
        status: 422, body: { errorCode: 'INVALID_SETTINGS', error: expect.stringContaining('Ultrafast speed is unavailable') },
      });
      expect(environment.model.requests()).toHaveLength(beforeRejection);
      environment.model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: (directories) => prepareScriptedCodexSpeed(environment, directories),
    });
  }, 120_000);

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
