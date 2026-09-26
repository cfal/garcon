import { expect, test } from 'bun:test';
import { linkOptions } from '../../__tests__/integration-fixture.js';
import { tcpLinkProxy } from '../../__tests__/tcp-link-proxy.js';
import { ExecutorRpc } from '../rpc.js';
import type { SessionTransport } from '../session-transport.js';
import { WebSocketLink } from '../websocket-link.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`authenticated fragments preserve liveness at 12 KiB/s (${dialer} dials)`, async () => {
    const sender = new WebSocketLink({ ...linkOptions, role: dialer });
    const receiver = new WebSocketLink({ ...linkOptions, role: dialer === 'controller' ? 'worker' : 'controller' });
    const proxy = await tcpLinkProxy(new URL(receiver.listen()));
    try {
      sender.dial(proxy.url);
      const [sending, receiving] = await Promise.all([sender.ready, receiver.ready]);
      const failures: Error[] = [];
      sending.onFailure(error => failures.push(error));
      receiving.onFailure(error => failures.push(error));
      const done = Promise.withResolvers<string>();
      receiving.onMessage(payload => done.resolve(payload));
      const payload = 'x'.repeat(256 * 1024);
      proxy.throttle(12 * 1024);
      sending.send(payload);
      expect(await done.promise).toBe(payload);
      expect(failures).toEqual([]);
      expect(proxy.connections).toBe(1);
      expect(sender.current).toBe(sending);
      expect(receiver.current).toBe(receiving);
    } finally { await sender.dispose(); await receiver.dispose(); await proxy.close(); }
  }, 40_000);

  test(`silent half-open link retires once and reconnects without replay (${dialer} dials)`, async () => {
    const sender = new WebSocketLink({ ...linkOptions, role: dialer });
    const receiver = new WebSocketLink({ ...linkOptions, role: dialer === 'controller' ? 'worker' : 'controller' });
    const proxy = await tcpLinkProxy(new URL(receiver.listen()));
    let requests = 0;
    receiver.onSession(session => new ExecutorRpc(session).handle(async () => { requests++; return []; }));
    try {
      sender.dial(proxy.url);
      const [sending, receiving] = await Promise.all([sender.ready, receiver.ready]);
      const failed = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const failures = [0, 0];
      [sending, receiving].forEach((session, index) => session.onFailure(() => {
        failures[index]!++;
        failed[index]!.resolve();
      }));
      proxy.blackhole();
      const started = Date.now();
      const pending = new ExecutorRpc(sending).call('test', 'execution.runningSessions', null).catch((error: unknown) => error);
      await Promise.all(failed.map(result => result.promise));
      expect(Date.now() - started).toBeGreaterThanOrEqual(15_000);
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(await pending).toMatchObject({ outcome: 'unknown' });
      expect(failures).toEqual([1, 1]);
      const replacement = Promise.withResolvers<SessionTransport>();
      sender.onSession(session => { if (session !== sending) replacement.resolve(session); });
      proxy.restore();
      proxy.disconnect();
      const next = await replacement.promise;
      expect(next).not.toBe(sending);
      await expect(new ExecutorRpc(next).call('test', 'execution.runningSessions', null)).resolves.toEqual([]);
      expect(requests).toBe(1);
      expect(failures).toEqual([1, 1]);
    } finally { await sender.dispose(); await receiver.dispose(); await proxy.close(); }
  }, 30_000);
}
