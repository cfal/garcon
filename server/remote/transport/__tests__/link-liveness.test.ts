import { expect, test } from 'bun:test';
import { linkOptions } from '../../__tests__/integration-fixture.js';
import { tcpLinkProxy } from '../../__tests__/tcp-link-proxy.js';
import { ExecutorRpc } from '../rpc.js';
import type { SessionTransport } from '../session-transport.js';
import { WebSocketLink, type LinkClosure } from '../websocket-link.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`slow bulk stays live while silent bulk retires without primary loss (${dialer} dials)`, async () => {
    const sender = new WebSocketLink({ ...linkOptions, role: dialer });
    const receiver = new WebSocketLink({ ...linkOptions, role: dialer === 'controller' ? 'worker' : 'controller' });
    const proxy = await tcpLinkProxy(new URL(receiver.listen()));
    const closures: LinkClosure[] = [];
    sender.onClosure(closure => closures.push(closure));
    receiver.onClosure(closure => closures.push(closure));
    try {
      sender.dial(proxy.url);
      const [parent, peer] = await Promise.all([sender.ready, receiver.ready]);
      const id = crypto.randomUUID();
      sender.prepareBulk(parent, id);
      receiver.prepareBulk(peer, id);
      const sending = Promise.withResolvers<SessionTransport>();
      const receiving = Promise.withResolvers<SessionTransport>();
      sender.onBulkSession(session => sending.resolve(session));
      receiver.onBulkSession(session => receiving.resolve(session));
      sender.dialBulk(parent, id);
      const [bulk, opposite] = await Promise.all([sending.promise, receiving.promise]);
      await Promise.all([bulk.ready, opposite.ready]);
      const path = proxy.capture(2);
      path.throttle(12 * 1024);
      const done = Promise.withResolvers<string>();
      opposite.onMessage(payload => done.resolve(payload));
      const payload = 'x'.repeat(256 * 1024);
      bulk.send(payload);
      expect(await done.promise).toBe(payload);
      expect(closures).toEqual([]);
      path.restore();
      path.blackhole();
      const failed = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      bulk.onFailure(() => failed[0]!.resolve());
      opposite.onFailure(() => failed[1]!.resolve());
      await Promise.all(failed.map(result => result.promise));
      expect(closures.some(closure => closure.cause === 'liveness-timeout')).toBe(true);
      expect(closures.every(closure => closure.lane === 'bulk')).toBe(true);
      expect(sender.current).toBe(parent);
      expect(receiver.current).toBe(peer);
      expect(parent.connected && peer.connected).toBe(true);
    } finally { await sender.dispose(); await receiver.dispose(); await proxy.close(); }
  }, 65_000);

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
    const closures: LinkClosure[] = [];
    sender.onClosure(closure => closures.push(closure));
    receiver.onClosure(closure => closures.push(closure));
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
      // The first end to notice the silence closes its socket, which the other end may see first.
      expect(closures.some(closure => closure.cause === 'liveness-timeout')).toBe(true);
      expect(closures.every(closure => closure.count === 1
        && (closure.cause === 'liveness-timeout' || closure.cause === 'socket-closed'))).toBe(true);
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
