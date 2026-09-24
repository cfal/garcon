import { expect, test } from 'bun:test';
import { withTimeout } from '../../support/deferred.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { webSocketProtocolsForAuth } from '../../../common/ws-auth.js';

test.each(['remote-controller-dials', 'remote-node-dials'] as const)('the primary payload limit does not constrain the execution-node channel (%s)', async (executionBackend) => {
  await withIntegrationFixture('primary-payload-limit', async (fixture) => {
    const socket = new WebSocket(fixture.garcon.baseUrl.replace(/^http/, 'ws') + '/ws', webSocketProtocolsForAuth(fixture.garcon.authToken));
    const opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Primary socket failed to open'));
    });
    const closed = new Promise<CloseEvent>((resolve) => { socket.onclose = resolve; });
    try {
      await withTimeout(opened, 5000, () => 'Primary socket did not open');
      socket.send(JSON.stringify({ type: 'ws-ping', excess: '\u00e9'.repeat(1024) }));
      expect((await withTimeout(closed, 5000, () => 'Oversized primary message was not rejected')).code).toBe(1009);
      await fixture.client.ping();
      const chatId = fixture.newChatId();
      const turn = await fixture.client.startDirectChat({
        chatId, content: 'Synthetic remote input '.repeat(128),
        projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      expect(await fixture.client.waitForTurnTerminal(chatId, turn.turnId)).toMatchObject({ type: 'agent-run-finished' });
    } finally { socket.close(); }
  }, {
    executionBackend,
    serverEnvironment: { GARCON_WS_MAX_PAYLOAD_LENGTH: '1024' },
  });
}, 30_000);
