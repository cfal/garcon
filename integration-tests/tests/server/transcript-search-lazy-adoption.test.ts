import { describe, expect, test } from 'bun:test';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

describe('transcript search maintenance adoption', () => {
  test('[TLV5-L01.02-SEARCH-LAZY-ADOPTION-SERVER-01][TLV5-SEARCH.11-SERVER-01] adopts and indexes without opening the chat', async () => {
    const environment: Record<string, string> = {};
    await withIntegrationFixture('transcript-search-lazy-adoption', async (fixture) => {
      const chatId = fixture.newChatId();
      const marker = 'syntheticlazyadoptionmarker';
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is required for lazy adoption.');
      await fixture.client.updateSettings({
        features: { transcriptSearch: { enabled: true } },
      });
      const started = await fixture.client.startChat({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        agentId: claude.id,
        projectPath: fixture.dirs.project,
        model: claude.defaultModel,
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: claude.defaultSettings,
        command: marker,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe(
        'agent-run-finished',
      );
      await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId,
        agentId: claude.id,
      });

      await fixture.restartGarcon({
        beforeStart: async () => {
          await rm(join(fixture.dirs.workspace, 'transcript-ledgers', chatId), {
            recursive: true,
            force: true,
          });
        },
      });

      const result = await fixture.client.waitForChatSearch(
        { query: marker, chatIds: [chatId] },
        (response) => response.index.pendingChatCount === 0
          && response.index.unindexedChatCount === 0
          && response.index.indexedChatCount === 1
          && response.results.some((entry) => entry.chatId === chatId),
      );
      const adopted = await fixture.client.getMessages(chatId);

      const adoptedRows = adopted.messages.filter((entry) => (
        entry.message.type === 'user-message' && entry.message.content === marker
      ));
      expect(adoptedRows).toHaveLength(1);
      const match = result.results.find((entry) => entry.chatId === chatId);
      expect(result.results.map((entry) => entry.chatId)).toEqual([chatId]);
      expect(match?.transcriptViewId).toBe(adopted.transcriptViewId);
      expect(match?.snippets).toContainEqual(expect.objectContaining({
        ordinal: adoptedRows[0]?.ordinal,
        role: 'user',
        text: marker,
      }));
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
        environment.CLAUDE_BINARY = binaryPath;
        environment.CLAUDE_CONFIG_DIR = join(directories.home, '.claude-integration');
        environment.ANTHROPIC_API_KEY = 'integration-fake-claude-key';
      },
    });
  }, 30_000);
});
