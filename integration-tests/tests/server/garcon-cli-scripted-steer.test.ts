import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { userContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = 'cli-scripted-steer';

function runCli(arguments_: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'cli/main.ts', ...arguments_],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GARCON_CONFIG_DIR: '',
      GARCON_WORKSPACE: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
}

describe('scripted Codex CLI steering', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('send-async --allow-steer steers the active Codex turn exactly once', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const firstPrompt = marker('CLI_FIRST_PROMPT');
    const steerPrompt = marker('CLI_STEER_PROMPT');
    const firstReply = marker('CLI_FIRST_REPLY');
    const steeredReply = marker('CLI_STEERED_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([codexAssistantMessage(firstReply)]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(steeredReply)]);

    await withIntegrationFixture('garcon-cli-scripted-steer', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
        permissionMode: 'bypassPermissions',
      }));
      const firstTurnId = first.turnId;
      if (!firstTurnId) throw new Error('Scripted Codex start did not return a turn identity.');
      await held.requested;

      const steered = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        'send-async', chatId, '--allow-steer', steerPrompt,
      ]);

      expect(steered.exitCode).toBe(0);
      expect(steered.stderr).toBe('');
      expect(steered.stdout).toBe(
        `chat id: ${chatId}\ndelivery: steer\nturn id: ${firstTurnId}\n`,
      );

      const chatsAfter = await fixture.client.listChats();
      expect(chatsAfter.sessions.find((chat) => chat.id === chatId)?.tags).not.toContain('cli');

      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, firstTurnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const requests = testEnvironment.model.requests();
      const steeredRequest = requests.at(-1);
      if (!steeredRequest) throw new Error('Codex did not make a steered model request.');
      expect(steeredRequest.lastUserText).toContain(steerPrompt);
      expect(requests.filter((request) => request.lastUserText.includes(steerPrompt)))
        .toHaveLength(1);

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([firstPrompt, steerPrompt]);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
      namedWorkspace: WORKSPACE,
    });
  }, 120_000);
});

function marker(label: string): string {
  return `SCRIPTED_CLI_CODEX_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}