import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentTurnReceipt } from '../../../common/agent-turn-receipt.js';
import type { ChatListRefreshRequestedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const phase of ['decision', 'completion']) {
  test(`a delete rejected during ambiguous handoff ${phase} leaves the recovered chat executable`, async () => {
    await withIntegrationFixture(`journal-delete-conflict-${phase}`, async (fixture) => {
      const chatId = fixture.newChatId();
      const target = fixture.directAgents.anthropic;
      const started = await fixture.client.startDirectChat({
        chatId, agent: fixture.directAgents.openAi, projectPath: fixture.dirs.project,
        content: 'synthetic source input',
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      const modePath = join(fixture.dirs.root, 'journal-fault-mode');
      await writeFile(modePath, phase);
      await expect(fixture.client.handoffDirectChat({
        chatId, agent: target, content: 'synthetic rejected handoff input',
      })).rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
      const deletion = await fixture.client.deleteChat(chatId).then(() => null, (error: unknown) => error);
      expect(deletion).not.toBeNull();
      await writeFile(modePath, 'none');
      await fixture.client.waitForEvent(
        (event): event is ChatListRefreshRequestedMessage => event.type === 'chat-list-refresh-requested'
          && event.reason === 'agent-handoff' && event.chatId === chatId,
        'handoff recovered after a conflicting deletion',
      );
      const resumed = await fixture.client.runDirectChat({
        chatId, agent: target, content: 'synthetic explicit input after recovery',
      });
      await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
      expect(parseAgentTurnReceipt(await fixture.client.get(
        `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${resumed.turnId}`,
      ))).toMatchObject({ state: 'completed' });
      const cursor = fixture.client.markEvents();
      await fixture.client.enqueueNew(chatId, 'synthetic queued input after recovery');
      await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor, timeoutMs: 5_000 });
      expect(deletion).toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(2);
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)?.agentId).toBe(target.agentId);
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      preloadModules: [fileURLToPath(new URL('../../support/journal-durability-preload.ts', import.meta.url))],
      resolveServerEnvironment: (directories) => ({ GARCON_TEST_JOURNAL_FAULT_DIR: directories.root }),
    });
  }, 30_000);
}
