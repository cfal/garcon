import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const SETTLED_PROMPT = 'claude-settled-turn';
const RUNNING_PROMPT = 'claude-running-turn';

describe('Claude fork while a turn is running', () => {
  test('forks ledger snapshots while native history trails and recovers after the turn', async () => {
    const environment: Record<string, string> = {};
    let turnReleasePath = '';

    await withIntegrationFixture('claude-fork-while-running', async (fixture) => {
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is missing from the agent catalog');
      expect(claude.supportsForkWhileRunning).toBe(true);
      expect(claude.supportsForkAtMessage).toBe(true);

      const sourceChatId = fixture.newChatId();
      const settled = await fixture.client.startChat({
        clientRequestId: randomUUID(),
        clientMessageId: randomUUID(),
        chatId: sourceChatId,
        agentId: claude.id,
        projectPath: fixture.dirs.project,
        model: claude.defaultModel,
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: claude.defaultSettings,
        command: SETTLED_PROMPT,
      });
      expect((await fixture.client.waitForTurnTerminal(sourceChatId, settled.turnId)).type)
        .toBe('agent-run-finished');

      // The first turn arrived on the event stream; rebuilding from native history is what makes
      // its seqs resolvable while the next turn is in flight.
      await fixture.client.reloadChat(sourceChatId);
      const settledHistory = await fixture.client.getMessages(sourceChatId);
      expect(userContents(settledHistory.messages)).toEqual([SETTLED_PROMPT]);
      expect(assistantContents(settledHistory.messages)).toEqual([`echo:${SETTLED_PROMPT}`]);
      const settledLastSeq = settledHistory.lastOrdinal;

      // This turn streams its assistant reply but holds it out of the transcript.
      const runCursor = fixture.client.markEvents();
      const running = await fixture.client.runChat({
        clientRequestId: randomUUID(),
        clientMessageId: randomUUID(),
        chatId: sourceChatId,
        command: RUNNING_PROMPT,
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: claude.defaultSettings,
        model: claude.defaultModel,
      });
      // Admission commits the user row before provider evidence, so the wait
      // targets the streamed assistant reply itself rather than seq movement.
      const streaming = await waitForAssistantEcho(fixture, sourceChatId, `echo:${RUNNING_PROMPT}`);

      // The ledger prefix is immediately forkable even when no provider-native
      // position exists yet.
      const streamingPointChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId,
        chatId: streamingPointChatId,
        transcriptViewId: streaming.transcriptViewId,
        upToOrdinal: streaming.lastOrdinal,
      });
      const streamingPoint = await fixture.client.getMessages(streamingPointChatId);
      expect(userContents(streamingPoint.messages)).toEqual(userContents(streaming.messages));
      expect(assistantContents(streamingPoint.messages))
        .toEqual(assistantContents(streaming.messages));

      // Settled history stays forkable at a point while the agent works.
      const pointChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId,
        chatId: pointChatId,
        transcriptViewId: settledHistory.transcriptViewId,
        upToOrdinal: settledLastSeq,
      });
      const pointForked = await fixture.client.getMessages(pointChatId);
      expect(userContents(pointForked.messages)).toEqual([SETTLED_PROMPT]);
      expect(assistantContents(pointForked.messages)).toEqual([`echo:${SETTLED_PROMPT}`]);

      // A whole-chat fork copies the transcript as it stands instead of refusing.
      const sourceAtWholeFork = await fixture.client.getMessages(sourceChatId);
      const wholeChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: wholeChatId });
      const wholeForked = await fixture.client.getMessages(wholeChatId);
      expect(userContents(wholeForked.messages)).toEqual(userContents(sourceAtWholeFork.messages));
      expect(assistantContents(wholeForked.messages))
        .toEqual(assistantContents(sourceAtWholeFork.messages));

      await writeFile(turnReleasePath, '');
      expect((await fixture.client.waitForTurnTerminal(sourceChatId, running.turnId, {
        afterIndex: runCursor,
      })).type).toBe('agent-run-finished');
      await fixture.client.reloadChat(sourceChatId);

      // The same point forks once the transcript owns it.
      const reloaded = await fixture.client.getMessages(sourceChatId);
      expect(assistantContents(reloaded.messages)).toEqual([
        `echo:${SETTLED_PROMPT}`,
        `echo:${RUNNING_PROMPT}`,
      ]);

      const recoveredChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId,
        chatId: recoveredChatId,
        transcriptViewId: reloaded.transcriptViewId,
        upToOrdinal: reloaded.lastOrdinal,
      });
      const recovered = await fixture.client.getMessages(recoveredChatId);
      expect(userContents(recovered.messages)).toEqual([SETTLED_PROMPT, RUNNING_PROMPT]);
      expect(assistantContents(recovered.messages)).toEqual([
        `echo:${SETTLED_PROMPT}`,
        `echo:${RUNNING_PROMPT}`,
      ]);
    }, {
      serverEnvironment: environment,
      async prepareWorkspace(directories) {
        const fakeModule = fileURLToPath(
          new URL('../../support/fake-claude-cli.ts', import.meta.url),
        );
        const binaryPath = join(directories.root, 'claude');
        await writeFile(
          binaryPath,
          `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fakeModule).href)};\n`,
        );
        await chmod(binaryPath, 0o755);
        turnReleasePath = join(directories.root, 'claude-turn-release');
        environment.CLAUDE_BINARY = binaryPath;
        environment.CLAUDE_CONFIG_DIR = join(directories.home, '.claude-integration');
        environment.ANTHROPIC_API_KEY = 'integration-fake-claude-key';
        environment.CLAUDE_TEST_RELEASE_PATH = turnReleasePath;
        environment.CLAUDE_TEST_STREAM_PROMPT = RUNNING_PROMPT;
      },
    });
  }, 30_000);
});

async function waitForAssistantEcho(
  fixture: IntegrationFixture,
  chatId: string,
  content: string,
): Promise<Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = await fixture.client.getMessages(chatId);
    if (assistantContents(page.messages).includes(content)) return page;
    await Bun.sleep(250);
  }
  throw new Error(`Chat ${chatId} never streamed assistant content ${content}`);
}
