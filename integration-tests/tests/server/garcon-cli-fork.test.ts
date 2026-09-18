import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = 'cli-fork';

async function runCli(fixture: IntegrationFixture, arguments_: readonly string[]) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'cli/main.ts',
      '--config-dir', fixture.dirs.config,
      '--workspace', WORKSPACE,
      '--server', fixture.garcon.baseUrl,
      ...arguments_,
    ],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GARCON_CONFIG_DIR: '',
      GARCON_WORKSPACE: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('garcon-cli fork', () => {
  test('creates bare and prompted forks through the atomic server contracts', async () => {
    await withIntegrationFixture('garcon-cli-fork', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const source = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: 'cli-fork-source',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, source.turnId);
      const sourceTranscript = await fixture.client.getMessages(sourceChatId);

      const bare = await runCli(fixture, ['fork', sourceChatId, '--json']);
      expect(bare).toMatchObject({ exitCode: 0, stderr: '' });
      const bareJson = JSON.parse(bare.stdout);
      expect(bareJson).toMatchObject({
        schemaVersion: 1,
        command: 'fork',
        workspace: WORKSPACE,
        sourceChatId,
        chat: {
          parentChat: {
            chatId: sourceChatId,
            relation: 'fork',
            transcriptViewId: sourceTranscript.transcriptViewId,
            ordinal: sourceTranscript.lastOrdinal,
          },
        },
      });
      expect(userContents((await fixture.client.getMessages(bareJson.chat.id)).messages))
        .toEqual(['cli-fork-source']);

      const synchronous = await runCli(fixture, [
        'fork', sourceChatId, '--json', 'cli-fork-synchronous',
      ]);
      expect(synchronous).toMatchObject({ exitCode: 0, stderr: '' });
      const synchronousJson = JSON.parse(synchronous.stdout);
      expect(synchronousJson).toMatchObject({
        schemaVersion: 1,
        command: 'fork',
        sourceChatId,
        receipt: {
          commandType: 'fork-run',
          chatId: synchronousJson.chat.id,
          turnId: synchronousJson.turnReceipt.turnId,
          status: 'accepted',
        },
        parentChat: { chatId: sourceChatId, relation: 'fork' },
        turnReceipt: {
          state: 'completed',
          chatId: synchronousJson.chat.id,
          output: {
            availability: 'available',
            completeness: 'complete',
            text: expect.stringContaining('cli-fork-synchronous'),
          },
        },
      });
      expect(userContents((await fixture.client.getMessages(synchronousJson.chat.id)).messages))
        .toEqual(['cli-fork-source', 'cli-fork-synchronous']);

      const held = fixture.fakeProviders.openAi.holdNext({});
      const asynchronous = await runCli(fixture, [
        'fork-async', sourceChatId, '--json', 'cli-fork-asynchronous',
      ]);
      expect(asynchronous).toMatchObject({ exitCode: 0, stderr: '' });
      const asynchronousJson = JSON.parse(asynchronous.stdout);
      expect(asynchronousJson).toMatchObject({
        schemaVersion: 1,
        command: 'fork-async',
        sourceChatId,
        receipt: {
          commandType: 'fork-run',
          chatId: asynchronousJson.chat.id,
          status: 'accepted',
        },
        parentChat: { chatId: sourceChatId, relation: 'fork' },
      });
      expect(asynchronousJson).not.toHaveProperty('turnReceipt');
      await held.received;
      expect((await fixture.client.listChats()).sessions.find(
        (entry) => entry.id === asynchronousJson.chat.id,
      )).toMatchObject({ isProcessing: true });
      held.releaseEcho();
      await fixture.client.waitForTurnTerminal(
        asynchronousJson.chat.id,
        asynchronousJson.receipt.turnId,
      );
      expect(assistantContents(
        (await fixture.client.getMessages(asynchronousJson.chat.id)).messages,
      ).some((content) => content.includes('cli-fork-asynchronous'))).toBeTrue();
    }, { namedWorkspace: WORKSPACE });
  }, 60_000);
});
