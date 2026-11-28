import { expect, test } from 'bun:test';
import { GarconTestClient } from '../../../../../integration-tests/support/garcon-client.js';
import { ClientTrace } from '../../trace-sink.js';

test('names a top-level test and captures both client transports', async () => {
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: 0,
    async fetch(request, server) {
      if (new URL(request.url).pathname === '/ws' && server.upgrade(request)) return;
      return Response.json({ echoed: await request.json() }, {
        status: 201,
        headers: { 'x-content-type-options': 'nosniff' },
      });
    },
    websocket: {
      message(socket, data) {
        const { clientRequestId, sentAt } = JSON.parse(data.toString());
        socket.send(JSON.stringify({
          type: 'ws-pong',
          clientRequestId,
          sentAt,
          serverTime: new Date().toISOString(),
          processing: { outcome: 'unavailable' },
          serverInstanceId: 'fixture-instance',
        }));
        socket.send(JSON.stringify({
          type: 'chat-title-updated', chatId: '1234567890123456', title: 'Synthetic', clientRequestId: 'an-http-command',
        }));
      },
    },
  });
  try {
    const client = await GarconTestClient.connect(`http://127.0.0.1:${server.port}`);
    try {
      expect(await client.post('/sample?foo=bar', { body: 'request' })).toEqual({ echoed: { body: 'request' } });
      await client.ping();
      await client.waitForEvent((event) => event.type === 'chat-title-updated', 'synthetic broadcast');
    } finally {
      await client.close();
    }
  } finally {
    server.stop(true);
  }
});

test('assigns placeholders in exchange order rather than callback order', async () => {
  const origin = 'http://127.0.0.1:4099';
  const trace = new ClientTrace(process.env.GARCON_TEST_TRACE_DIR!, origin, null, (value) => value);
  const firstChat = String(Date.now() * 1000);
  const secondChat = String(Number(firstChat) + 1);
  const first = Promise.withResolvers<Response>();
  const slow = trace.http(new URL('/first', origin), {}, new Headers(), () => first.promise);
  trace.receive({ type: 'changed', chatId: secondChat });
  await trace.http(new URL('/second', origin), {}, new Headers(), async () =>
    Response.json({ chatId: secondChat, url: 'http://localhost:4242' }));
  first.resolve(Response.json({ chatId: firstChat, url: 'http://localhost:4141' }));
  await slow;
});
