import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { messagesOfType } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import { FakeCodexModel } from '../../support/fake-codex-model.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  OPENCODE_TEST_MODEL_ID,
  OPENCODE_TEST_PROVIDER,
  openCodePaths,
  readExecutionSupervisorStates,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  waitForSupervisorExit,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

let environment: ScriptedOpenCodeTestEnvironment | undefined;
const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode provider upgrade contracts', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  // https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/test/provider/openai.test.ts#L4-L31
  test('forwards the OpenAI ultrafast service tier through the real binary', async () => {
    const responses = FakeCodexModel.start();
    const held = responses.scriptHeldTurn([]);
    try {
      await withIntegrationFixture(
        'opencode-ultrafast',
        async (fixture) => {
          const chatId = fixture.newChatId();
          const prompt = 'OPENCODE_ULTRAFAST_PROMPT';
          await fixture.client.startChat(
            scriptedOpenCodeStartRequest({
              chatId,
              projectPath: fixture.dirs.project,
              command: prompt,
            }),
          );
          const request = await withTimeout(
            held.requested,
            LIVE_TURN_TIMEOUT_MS,
            () => 'OpenCode did not dispatch the configured OpenAI service tier',
          );
          expect(request.body.model).toBe(OPENCODE_TEST_MODEL_ID);
          expect(request.body.service_tier).toBe('ultrafast');
          expect(JSON.stringify(request.body.input)).toContain(prompt);
          expect(responses.requests()).toHaveLength(1);

          const stopCursor = fixture.client.markEvents();
          const stopped = await fixture.client.stopChat({
            clientRequestId: crypto.randomUUID(),
            chatId,
          });
          expect(stopped.outcome).toBe('interrupt-requested');
          await fixture.client.waitForProcessing(chatId, false, {
            afterIndex: stopCursor,
            timeoutMs: LIVE_TURN_TIMEOUT_MS,
          });
        },
        withOpenCodeProvider({
          npm: '@ai-sdk/openai',
          baseURL: `${responses.baseUrl}/v1`,
          modelOptions: { serviceTier: 'ultrafast', store: false },
        }),
      );
      responses.assertSettled();
    } finally {
      held.release();
      responses.stop();
    }
  }, 120_000);

  // https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/session/message-v2.ts#L300-L315
  test('replays xAI PNG native tool attachments but omits GIFs without losing tool text', async () => {
    const testEnvironment = requireEnvironment();
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
      '+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const reply = 'OPENCODE_XAI_ATTACHMENTS_REPLY';
    const pngCall = 'call_xai_read_png';
    const gifCall = 'call_xai_read_gif';

    const responses = FakeCodexModel.start();
    const held = responses.scriptHeldTurn([]);
    try {
      await withIntegrationFixture(
        'opencode-xai-tool-images',
        async (fixture) => {
          const pngPath = join(fixture.dirs.project, 'pixel.png');
          const gifPath = join(fixture.dirs.project, 'pixel.gif');
          await writeFile(pngPath, Buffer.from(png, 'base64'));
          await writeFile(gifPath, Buffer.from(gif, 'base64'));
          testEnvironment.model.scriptTurn([
            chatCompletionsToolUse(pngCall, 'read', { filePath: pngPath }),
            chatCompletionsToolUse(gifCall, 'read', { filePath: gifPath }),
          ]);
          testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

          const chatId = fixture.newChatId();
          const cursor = fixture.client.markEvents();
          const started = await fixture.client.startChat(
            scriptedOpenCodeStartRequest({
              chatId,
              projectPath: fixture.dirs.project,
              command: 'OPENCODE_XAI_ATTACHMENTS_PROMPT',
              permissionMode: 'bypassPermissions',
            }),
          );
          await waitForVisibleResponse({
            fixture,
            chatId,
            turnId: started.turnId,
            marker: reply,
            afterIndex: cursor,
          });
          expectFinished(
            (
              await fixture.client.waitForTurnTerminal(chatId, started.turnId, {
                afterIndex: cursor,
                timeoutMs: LIVE_TURN_TIMEOUT_MS,
              })
            ).type,
          );

          const requests = testEnvironment.model.requests();
          expect(requests).toHaveLength(2);
          expect(requests[1].toolResults).toEqual([
            { toolCallId: pngCall, content: 'Image read successfully' },
            { toolCallId: gifCall, content: 'Image read successfully' },
          ]);
          const transcript = await fixture.client.getMessages(chatId);
          // Parallel reads publish in completion order.
          expect(
            messagesOfType(transcript.messages, 'read-tool-use')
              .map((tool) => tool.toolId)
              .sort(),
          ).toEqual([pngCall, gifCall].sort());
          expect(messagesOfType(transcript.messages, 'unknown-tool-use')).toHaveLength(0);

          const supervisors = await readExecutionSupervisorStates(fixture);
          await fixture.restartGarcon({
            beforeStart: async () => {
              await waitForSupervisorExit(supervisors);
              const configPath = openCodePaths(fixture.dirs).config;
              const config = JSON.parse(await readFile(configPath, 'utf8'));
              const provider = structuredClone(config.provider[OPENCODE_TEST_PROVIDER]);
              provider.npm = '@ai-sdk/xai';
              provider.id = 'xai';
              provider.env = ['XAI_API_KEY'];
              provider.options.baseURL = `${responses.baseUrl}/v1`;
              config.provider.xai = provider;
              config.enabled_providers.push('xai');
              await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
            },
          });
          await fixture.client.runChat(
            scriptedOpenCodeRunRequest({
              chatId,
              command: 'OPENCODE_XAI_REPLAY_PROMPT',
              model: `xai/${OPENCODE_TEST_MODEL_ID}`,
            }),
          );
          const replayRequest = await withTimeout(
            held.requested,
            LIVE_TURN_TIMEOUT_MS,
            () => 'OpenCode did not replay the native tool attachments to xAI Responses',
          );
          const replay = JSON.stringify(replayRequest.body.input);
          expect(replay).toContain(`data:image/png;base64,${png}`);
          expect(replay).not.toContain(gif);
          expect(replay).not.toContain('data:image/gif');
          expect(replayRequest.functionCallOutputs.map((output) => output.callId)).toEqual([
            pngCall,
            gifCall,
          ]);
          for (const output of replayRequest.functionCallOutputs) {
            expect(output.output).toContain('Image read successfully');
          }
          expect(responses.requests()).toHaveLength(1);
          const stopCursor = fixture.client.markEvents();
          expect(
            (await fixture.client.stopChat({ clientRequestId: crypto.randomUUID(), chatId }))
              .outcome,
          ).toBe('interrupt-requested');
          await fixture.client.waitForProcessing(chatId, false, {
            afterIndex: stopCursor,
            timeoutMs: LIVE_TURN_TIMEOUT_MS,
          });
          testEnvironment.model.assertSettled();
        },
        {
          ...withOpenCodeProvider({ npm: '@ai-sdk/openai-compatible' }),
          resolveServerEnvironment: (directories) => ({
            ...testEnvironment.resolveServerEnvironment(directories),
            // Activates the native Responses loader without reusing the persisted config key.
            XAI_API_KEY: 'opencode-scripted-xai-env-key',
          }),
        },
      );
      responses.assertSettled();
    } finally {
      held.release();
      responses.stop();
    }
  }, 120_000);
});

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withOpenCodeProvider(options: {
  npm: '@ai-sdk/openai' | '@ai-sdk/openai-compatible';
  baseURL?: string;
  modelOptions?: Record<string, unknown>;
}): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    async prepareWorkspace(directories) {
      await testEnvironment.prepareWorkspace(directories);
      const configPath = openCodePaths(directories).config;
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      const provider = config.provider[OPENCODE_TEST_PROVIDER];
      provider.npm = options.npm;
      if (options.baseURL) provider.options.baseURL = options.baseURL;
      if (options.modelOptions)
        provider.models[OPENCODE_TEST_MODEL_ID].options = options.modelOptions;
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    },
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}
