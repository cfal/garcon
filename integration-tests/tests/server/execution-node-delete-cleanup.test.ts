import { expect, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeleteIntentV2 } from '../../../server/chats/agent-ownership-journal.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const executionBackend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  for (const restart of [false, true]) {
    test(`offline native deletion retries ${restart ? 'after restart' : 'on reconnect'} (${executionBackend})`, async () => {
      await withIntegrationFixture(`native-delete-${executionBackend}-${restart}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const started = await fixture.client.startDirectChat({
          chatId, agent: fixture.directAgents.openAi, projectPath: fixture.executionDirs.project,
          content: 'Synthetic native cleanup input',
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        await fixture.client.waitForProcessing(chatId, false);
        await fixture.restartGarcon();
        const nativePath = await fixture.directOpenAiNativePath(chatId);
        expect((await stat(nativePath)).isFile()).toBe(true);
        const nodeId = fixture.client.nodeId;
        await fixture.client.patch(`/api/v1/execution-nodes/${nodeId}`, { enabled: false });
        await fixture.client.deleteChat(chatId);
        const journalPath = join(fixture.dirs.workspace, 'agent-ownership-journal.json');
        const intents = async (): Promise<DeleteIntentV2[]> => JSON.parse(await readFile(journalPath, 'utf8')).ownershipIntents;
        expect(await intents()).toMatchObject([{ chatId, phase: 'registry-removed' }]);
        expect((await stat(nativePath)).isFile()).toBe(true);
        expect(await stat(join(fixture.dirs.workspace, 'transcript-ledgers', chatId)).catch(() => null)).toBeNull();

        if (restart) {
          await fixture.restartGarcon({ beforeStart: async () => {
            const path = join(fixture.dirs.workspace, 'execution-nodes.json');
            const config = JSON.parse(await readFile(path, 'utf8'));
            const node = config.nodes.find((entry: { id: string }) => entry.id === nodeId);
            node.enabled = true;
            await writeFile(path, JSON.stringify(config));
          } });
        } else {
          await fixture.client.patch(`/api/v1/execution-nodes/${nodeId}`, { enabled: true });
        }

        const deadline = Date.now() + 10_000;
        while ((await intents()).length > 0 && Date.now() < deadline) await Bun.sleep(25);
        expect(await intents()).toEqual([]);
        expect(await stat(nativePath).catch(() => null)).toBeNull();
        expect((await fixture.client.listChats()).sessions).toEqual([]);
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
      }, { executionBackend });
    }, 40_000);
  }
}
