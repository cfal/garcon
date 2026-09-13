import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { userContents } from '../../support/chat-assertions.js';

describe.skipIf(!nodeSessionSystemdAvailable)('remote history failure through authenticated Reload', () => {
  test.each(['late-capacity', 'corrupt-row', 'lost-eof'] as const)('%s preserves the current view after receiving earlier remote rows', async (mode) => {
    await withIntegrationFixture(`remote-history-reload-${mode}`, async (fixture) => {
      const chatId = fixture.newChatId(); const agent = fixture.directAgents.openAi;
      const started = await fixture.client.startDirectChat({ chatId, agent, projectPath: fixture.dirs.project, content: 'Synthetic original input' });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      const before = await fixture.client.getMessages(chatId);
      await expect(fixture.client.reloadChat(chatId)).rejects.toMatchObject({ response: { requestType: 'chat-reload', code: 'HISTORY_LOAD_FAILED',
        message: mode === 'late-capacity' ? 'History transport capacity is reserved or cannot carry this row at its configured allocation.'
          : mode === 'lost-eof' ? 'Synthetic remote EOF cancellation' : 'Remote history import did not complete.' } });
      expect(await fixture.client.getMessages(chatId)).toEqual(before);
      const resumed = await fixture.client.runDirectChat({ chatId, agent, content: 'Synthetic subsequent input' });
      await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
      const after = await fixture.client.getMessages(chatId);
      expect(after.transcriptViewId).toBe(before.transcriptViewId);
      expect(userContents(after.messages)).toEqual(['Synthetic original input', 'Synthetic subsequent input']);
      expect(JSON.stringify(after)).not.toContain('Synthetic remote replacement');
      await fixture.restartGarcon();
      expect(await fixture.client.getMessages(chatId)).toEqual(after);
    }, { bindAddress: '0.0.0.0', authentication: 'account',
      preloadModules: [fileURLToPath(new URL('../../support/remote-history-reload-preload.ts', import.meta.url))],
      serverEnvironment: { GARCON_TEST_REMOTE_HISTORY: mode,
        ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
        ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
      } });
  }, 30_000);
});
