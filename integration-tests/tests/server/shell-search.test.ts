import { expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`Shell search omits routine completion but retains command evidence (${executionBackend})`, async () => {
    await withIntegrationFixture(`shell-search-${executionBackend}`, async ({ client, newChatId, executionDirs }) => {
      const chatId = newChatId();
      const started = await client.startChat({ chatId, agentId: 'shell', model: 'bash',
        projectPath: executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
        agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'true',
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      await client.waitForProcessing(chatId, false);
      const run = async (command: string) => {
        const admitted = await client.runChat({ chatId, command,
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
        await client.waitForTurnTerminal(chatId, admitted.turnId);
        await client.waitForProcessing(chatId, false);
      };
      await client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
      await client.waitForSearchPhase(['ready'], { timeoutMs: 30_000 });
      expect((await client.searchChats({ query: 'Completed', chatIds: [chatId] })).results).toEqual([]);

      await run('printf Completed');
      await run('garcon_nonexistent_command');
      await run("head -c 70000 /dev/zero | tr '\\0' x");
      const assertSearch = async () => {
        const authored = await client.waitForChatSearch({ query: 'Completed', chatIds: [chatId] },
          response => response.results[0]?.matchedMessageCount === 3);
        expect(authored.results[0]?.snippets.map(snippet => snippet.role).sort()).toEqual(['assistant', 'system', 'user']);
        const failures = await client.waitForChatSearch({ query: '"Exit 127"', chatIds: [chatId] },
          response => response.results[0]?.snippets.some(snippet => snippet.role === 'system') === true);
        expect(failures.results[0]?.snippets.some(snippet => snippet.role === 'system' && snippet.text === 'Exit 127')).toBe(true);
        const warnings = await client.waitForChatSearch({ query: 'truncated', chatIds: [chatId] },
          response => response.results[0]?.snippets.some(snippet => snippet.role === 'system') === true);
        expect(warnings.results[0]?.snippets.some(snippet => snippet.text.includes('Output truncated'))).toBe(true);
      };
      await assertSearch();
      const resultsBefore = (await client.getMessages(chatId)).messages
        .filter(row => row.message.type === 'command-result').map(row => row.message);
      expect(resultsBefore).toHaveLength(4);
      await client.reloadChat(chatId);
      expect((await client.getMessages(chatId)).messages.filter(row => row.message.type === 'command-result')
        .map(row => row.message)).toEqual(resultsBefore);
      await assertSearch();
    }, { executionBackend });
  }, 60_000);
}
