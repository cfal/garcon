import { expect, test } from 'bun:test';
import { createConnection, type Socket } from 'node:net';
import { webSocketProtocolsForAuth } from '../../../common/ws-auth.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

async function pausedBrowser(baseUrl: string, authToken: string | null) {
  const url = new URL(baseUrl);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  // A reset is the expected outcome when the server drops a slow consumer.
  socket.on('error', () => {});
  const upgraded = new Promise<void>((resolve, reject) => {
    let response = '';
    const onData = (data: Buffer) => {
      response += data.toString('utf8');
      if (!response.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      socket.pause();
      if (!response.startsWith('HTTP/1.1 101 ')) reject(new Error('Browser upgrade rejected'));
      else resolve();
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('connect', () => socket.write([
      'GET /ws HTTP/1.1', `Host: ${url.host}`, 'Connection: Upgrade', 'Upgrade: websocket',
      `Sec-WebSocket-Protocol: ${webSocketProtocolsForAuth(authToken).join(', ')}`,
      'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', '', '',
    ].join('\r\n')));
  });
  const timeout = setTimeout(() => socket.destroy(new Error('Browser upgrade timed out')), 5_000);
  try { await upgraded; }
  catch (error) { socket.destroy(); throw error; }
  finally { clearTimeout(timeout); }
  return { socket, closed };
}

function maskedTextFrame(payload: string): Buffer {
  const text = Buffer.from(payload);
  const frame = Buffer.alloc(14 + text.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | 127;
  frame.writeBigUInt64BE(BigInt(text.length), 2);
  const mask = Buffer.from([1, 2, 3, 4]);
  mask.copy(frame, 10);
  for (let index = 0; index < text.length; index++) frame[14 + index] = text[index]! ^ mask[index % 4]!;
  return frame;
}

async function writeFrame(socket: Socket, frame: Buffer): Promise<void> {
  if (socket.destroyed || socket.write(frame)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      socket.off('drain', done);
      socket.off('close', done);
      resolve();
    };
    socket.once('drain', done);
    socket.once('close', done);
  });
}

async function expectDropped(browser: Awaited<ReturnType<typeof pausedBrowser>>): Promise<void> {
  browser.socket.resume();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      browser.closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Slow browser was not dropped')), 5_000);
      }),
    ]);
  } finally { clearTimeout(timeout); }
}

test('direct replies drop a slow browser at its budget without affecting another browser', async () => {
  await withIntegrationFixture('primary-direct-backpressure', async (fixture) => {
    const browser = await pausedBrowser(fixture.garcon.baseUrl, fixture.garcon.authToken);
    try {
      const frame = maskedTextFrame(JSON.stringify({ type: 'ws-ping', clientRequestId: 'x'.repeat(256 * 1024), sentAt: 1 }));
      for (let index = 0; index < 64 && !browser.socket.destroyed; index++) await writeFrame(browser.socket, frame);
      await expectDropped(browser);
      expect((await fixture.client.ping()).type).toBe('ws-pong');
      expect((await (await fixture.connectObserver('replacement')).ping()).type).toBe('ws-pong');
    } finally { browser.socket.destroy(); }
  }, { executionBackend: 'in-process', serverEnvironment: { GARCON_WS_BACKPRESSURE_LIMIT: '262144', GARCON_MAX_WS_CLIENTS: '2' } });
}, 30_000);

test('broadcasts drop a slow browser while a healthy subscriber stays connected', async () => {
  await withIntegrationFixture('primary-broadcast-backpressure', async (fixture) => {
    const browser = await pausedBrowser(fixture.garcon.baseUrl, fixture.garcon.authToken);
    try {
      for (let index = 0; index < 128; index++) {
        await fixture.client.updateSettings({ ui: { commitMessage: { customPrompt: `${index}:${'x'.repeat(31_000)}` } } });
      }
      await expectDropped(browser);
      expect((await fixture.client.ping()).type).toBe('ws-pong');
      expect(fixture.client.eventRecords().some((record) => record.parsed.type === 'settings-changed')).toBe(true);
    } finally { browser.socket.destroy(); }
  }, { executionBackend: 'in-process', serverEnvironment: { GARCON_WS_BACKPRESSURE_LIMIT: '262144' } });
}, 30_000);
