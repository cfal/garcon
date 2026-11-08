import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment, type ScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { prepareScriptedCodexSpeed } from '../../support/scripted-codex-speed.js';

describe('Codex scripted per-chat speed', () => {
  let environment: ScriptedCodexTestEnvironment;
  beforeAll(async () => { environment = await startScriptedCodexTestEnvironment(); });
  afterAll(async () => { await environment?.dispose(); });

  test('defaults to Standard, isolates Fast, persists it across restart, and turns it off explicitly', async () => {
    await withIntegrationFixture('codex-speed', async (fixture) => {
      const fastChat = fixture.newChatId();
      const standardChat = fixture.newChatId();
      const run = async (chatId: string, expectedTier: string, start = false) => {
        const marker = `speed-${crypto.randomUUID()}`;
        const index = environment.model.requests().length;
        environment.model.scriptTurn([codexAssistantMessage(marker)]);
        const afterIndex = fixture.client.markEvents();
        const turn = start
          ? await fixture.client.startChat(liveCodexStartRequest({ chatId, projectPath: fixture.dirs.project, command: 'Synthetic speed check.' }))
          : await fixture.client.runChat({
            ...liveCodexRunRequest({ chatId, command: 'Continue synthetic speed check.' }),
            agentSettings: (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)!.agentSettings,
          });
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker, afterIndex });
        // Codex sends explicit Standard to its thread API, then omits the tier on inference.
        // https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/protocol/src/openai_models.rs#L1084-L1088
        expect(environment.model.requests()[index]?.body.service_tier)
          .toBe(expectedTier === 'default' ? undefined : expectedTier);
      };
      const changeSpeed = async (speed: 'standard' | 'fast') => {
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
      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === fastChat)?.agentSettings.values.speed).toBe('fast');
      await run(fastChat, 'priority');
      await changeSpeed('standard');
      await run(fastChat, 'default');
      environment.model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: (directories) => prepareScriptedCodexSpeed(environment, directories),
    });
  }, 120_000);
});
