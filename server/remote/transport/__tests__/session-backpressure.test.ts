import { expect, test } from 'bun:test';
import { tcpLinkProxy } from '../../__tests__/tcp-link-proxy.js';
import { WebSocketLink } from '../websocket-link.js';
import { linkOptions } from '../../__tests__/integration-fixture.js';

test('failures after proof verification are not reported as authentication failures', async () => {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const reported = Promise.withResolvers<string>();
  controller.onError(message => reported.resolve(message));
  controller.onSession(() => { throw new Error('Synthetic post-authentication failure'); });
  try {
    controller.dial(worker.listen());
    expect(await reported.promise).toBe('Executor continuity lost');
  } finally { await controller.dispose(); await worker.dispose(); }
});

for (const dialer of ['controller', 'worker'] as const) {
  test(`12 MiB queued output survives socket backpressure (${dialer} dials)`, async () => {
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    const sender = dialer === 'controller' ? controller : worker;
    const receiver = dialer === 'controller' ? worker : controller;
    const proxy = await tcpLinkProxy(new URL(receiver.listen()));
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
      proxy.throttle(8 * 1024 * 1024);
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
    const proxy = await tcpLinkProxy(new URL(receiver.listen()));
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
      proxy.throttle(512 * 1024);
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
