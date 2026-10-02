import { expect, test } from 'bun:test';
import { webSocketProtocolsForAuth } from '../../../common/ws-auth.js';
import { withTimeout } from '../../support/deferred.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('missing chat IDs receive correlated validation errors on the public socket', async () => {
  await withIntegrationFixture('ws-request-validation', async (fixture) => {
    const socket = new WebSocket(
      fixture.garcon.baseUrl.replace(/^http/, 'ws') + '/ws',
      webSocketProtocolsForAuth(fixture.garcon.authToken),
    );
    try {
      await withTimeout(new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('Primary socket failed to open'));
      }), 5_000, () => 'Primary socket did not open');
      for (const type of ['chat-subscribe', 'chat-reload']) {
        for (const chatId of [undefined, null, '', 123]) {
          const clientRequestId = `${type}-${String(chatId)}`;
          const response = new Promise<unknown>((resolve) => {
            socket.onmessage = event => {
              const message = JSON.parse(String(event.data));
              if (message.clientRequestId === clientRequestId) resolve(message);
            };
          });
          socket.send(JSON.stringify({
            type, chatId, clientRequestId, transcriptViewId: 'view-1', afterOrdinal: 0,
          }));
          expect(await withTimeout(response, 5_000, () => `No response for ${clientRequestId}`))
            .toMatchObject({
              type: 'client-request-error', clientRequestId, requestType: type,
              code: 'MISSING_CHAT_ID', retryable: false,
            });
        }
      }
    } finally {
      socket.close();
    }
  });
}, 30_000);
