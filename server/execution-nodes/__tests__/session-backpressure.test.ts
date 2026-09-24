import { expect, test } from 'bun:test';
import { createServer, connect, type Socket, type AddressInfo } from 'node:net';
import { WebSocketLink } from '../websocket-link.js';
import { linkOptions } from './integration-fixture.js';

test('failures after proof verification are not reported as authentication failures', async () => {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const reported = Promise.withResolvers<string>();
  controller.onError(message => reported.resolve(message));
  controller.onSession(() => { throw new Error('Synthetic post-authentication failure'); });
  try {
    controller.dial(worker.listen());
    expect(await reported.promise).toBe('Execution-node continuity lost');
  } finally { await controller.dispose(); await worker.dispose(); }
});

async function throttledProxy(target: URL, bytesPerSecond: number) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let connections = 0;
  const server = createServer(client => {
    connections++;
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(client); sockets.add(upstream);
    client.on('data', (chunk: Buffer) => {
      upstream.write(chunk);
      client.pause();
      const timer = setTimeout(() => {
        timers.delete(timer);
        client.resume();
      }, Math.ceil(chunk.length * 1000 / bytesPerSecond));
      timers.add(timer);
    });
    upstream.on('data', chunk => client.write(chunk));
    const close = () => {
      sockets.delete(client); sockets.delete(upstream);
      client.destroy(); upstream.destroy();
    };
    client.on('close', close); upstream.on('close', close);
    client.on('error', close); upstream.on('error', close);
  });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const url = new URL(target.href);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.href,
    get connections() { return connections; },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`12 MiB queued output survives socket backpressure (${dialer} dials)`, async () => {
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    const sender = dialer === 'controller' ? controller : worker;
    const receiver = dialer === 'controller' ? worker : controller;
    const proxy = await throttledProxy(new URL(receiver.listen()), 8 * 1024 * 1024);
    try {
      sender.dial(proxy.url);
      const [sending, receiving] = await Promise.all([sender.ready, receiver.ready]);
      const done = Promise.withResolvers<void>();
      let received = 0;
      receiving.onMessage(payload => {
        expect(payload).toBe('r'.repeat(512 * 1024));
        if (++received === 24) done.resolve();
      });
      const failures: Error[] = [];
      sending.onFailure(error => failures.push(error));
      for (let index = 0; index < 24; index++) sending.send('r'.repeat(512 * 1024));
      await done.promise;
      expect(failures).toEqual([]);
      expect(sender.current).toBe(sending);
      expect(receiver.current).toBe(receiving);
    } finally { await sender.dispose(); await receiver.dispose(); await proxy.close(); }
  }, 15_000);

  test(`13 MiB followed by another write crosses a slow link without losing liveness (${dialer} dials)`, async () => {
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    const sender = dialer === 'controller' ? controller : worker;
    const receiver = dialer === 'controller' ? worker : controller;
    const proxy = await throttledProxy(new URL(receiver.listen()), 512 * 1024);
    try {
      sender.dial(proxy.url);
      const [sending, receiving] = await Promise.all([sender.ready, receiver.ready]);
      const done = Promise.withResolvers<void>();
      const received: number[] = [];
      const availability: boolean[] = [];
      sending.onAvailability(connected => availability.push(connected));
      receiving.onAvailability(connected => availability.push(connected));
      receiving.onMessage(payload => {
        received.push(payload.length);
        if (received.length === 2) done.resolve();
      });
      sending.send('x'.repeat(13 * 1024 * 1024));
      sending.send('second');
      receiving.send('concurrent reverse traffic');
      await done.promise;
      expect(received).toEqual([13 * 1024 * 1024, 6]);
      expect(availability).toEqual([]);
      expect(proxy.connections).toBe(1);
      expect(sender.current).toBe(sending);
    } finally { await sender.dispose(); await receiver.dispose(); await proxy.close(); }
  }, 50_000);
}
