import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  type RecordedChatCompletionsRequest,
} from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture, type IntegrationFixtureOptions } from '../../support/integration-fixture.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import {
  openCodePaths,
  OPENCODE_TEST_PROVIDER,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

let environment: ScriptedOpenCodeTestEnvironment;
const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

// Short fixture-only limits exercise the five-minute native defaults without a turn deadline.
// https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/provider/provider.ts#L35-L125
describeOnLinux('scripted OpenCode provider timeouts', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => environment.dispose());

  test('retries a header timeout under the native policy and completes the same turn', async () => {
    const held = environment.model.scriptHeldTurn([chatCompletionsText('unreachable reply')]);
    environment.model.scriptTurn([chatCompletionsText('header timeout recovery')]);
    await withIntegrationFixture('opencode-header-timeout', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'header timeout prompt',
      }));
      const heldRequest = await held.requested;
      try {
        await waitForVisibleResponse({
          fixture, chatId, turnId: turn.turnId,
          marker: 'header timeout recovery', afterIndex: cursor,
        });
        const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
          afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });
        expectFinished(terminal.type);
        await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor });
        const transcript = await fixture.client.getMessages(chatId);
        expect(userContents(transcript.messages)).toEqual(['header timeout prompt']);
        expect(assistantContents(transcript.messages)).toEqual(['header timeout recovery']);
        expect(messagesOfType(transcript.messages, 'error')).toEqual([]);
        const notices = messagesOfType(transcript.messages, 'transcript-notice')
          .filter((message) => message.title === 'Provider retry');
        expect(notices).toHaveLength(1);
        expect(notices[0]?.content).toContain('Provider response headers timed out after 2000ms');
        expect(environment.model.requests()).toHaveLength(2);
        expect(fixture.client.eventsSince(cursor).filter((event) =>
          (event.type === 'agent-run-failed' || event.type === 'agent-run-finished')
          && event.chatId === chatId && event.turnId === turn.turnId)).toHaveLength(1);
        await waitForModelRequestAbort(heldRequest);
      } finally {
        held.release();
      }

      environment.model.assertSettled();
    }, withTimeouts({ headerTimeout: 2_000 }));
  }, 120_000);

  test('retries an inter-chunk timeout and finishes without a visible failure', async () => {
    environment.model.scriptFault({ kind: 'stream-stall' });
    environment.model.scriptTurn([chatCompletionsText('chunk timeout recovery')]);
    await withIntegrationFixture('opencode-chunk-timeout', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'chunk timeout prompt',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: turn.turnId,
        marker: 'chunk timeout recovery', afterIndex: cursor,
      });
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual(['chunk timeout prompt']);
      expect(assistantContents(transcript.messages)).toEqual(['chunk timeout recovery']);
      expect(messagesOfType(transcript.messages, 'error')).toEqual([]);
      const notices = messagesOfType(transcript.messages, 'transcript-notice')
        .filter((message) => message.title === 'Provider retry');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.content).toContain('SSE read timed out');
      const requests = environment.model.requests();
      expect(requests).toHaveLength(2);
      await waitForModelRequestAbort(requests[0]!);
      environment.model.assertSettled();
    }, withTimeouts({ chunkTimeout: 1_000 }));
  }, 120_000);
});

async function waitForModelRequestAbort(request: RecordedChatCompletionsRequest): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (request.abortedAt !== null) return;
    await Bun.sleep(25);
  }
  throw new Error('OpenCode never closed the timed-out model request.');
}

function withTimeouts(options: { headerTimeout?: number; chunkTimeout?: number }): IntegrationFixtureOptions {
  return {
    resolveServerEnvironment: environment.resolveServerEnvironment,
    async prepareWorkspace(directories) {
      await environment.prepareWorkspace(directories);
      const path = openCodePaths(directories).config;
      const config = JSON.parse(await readFile(path, 'utf8'));
      Object.assign(config.provider[OPENCODE_TEST_PROVIDER].options, options);
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    },
    afterGarconStop: environment.afterGarconStop,
    extraDiagnostics: environment.extraDiagnostics,
  };
}
