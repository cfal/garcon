import { expect, test } from 'bun:test';
import { WebSocketLink } from '../../../server/remote/transport/websocket-link.js';
import type { SessionTransport } from '../../../server/remote/transport/session-transport.js';

for (const dialer of ['controller', 'worker'] as const) {
  for (const failingPeer of ['controller', 'worker'] as const) {
    for (const phase of ['listener', 'attachment'] as const) {
      test(`reconnect survives a ${failingPeer} ${phase} exception (${dialer} dials)`, async () => {
        const options = { secret: Buffer.alloc(32, 42).toString('base64url'), allowInsecureDevelopment: true, reconnectDelayMs: 20 };
        const controller = new WebSocketLink({ ...options, role: 'controller', executorId: '22222222-2222-4222-8222-222222222222' });
        const worker = new WebSocketLink({ ...options, role: 'worker' });
        const failing = failingPeer === 'controller' ? controller : worker;
        const peer = failingPeer === 'controller' ? worker : controller;
        const retired = Promise.withResolvers<Error>();
        const recovered = Promise.withResolvers<SessionTransport>();
        const delivered = Promise.withResolvers<string>();
        const failure = new Error('Synthetic one-time setup failure');
        let first: SessionTransport | undefined;
        peer.onSession((session) => session.onMessage((message) => session.send(message)));
        failing.onSession((session) => {
          if (!first) {
            first = session;
            session.onFailure(retired.resolve);
            if (phase === 'listener') throw failure;
            session.onAvailability((connected) => { if (connected) throw failure; });
          } else {
            session.onMessage(delivered.resolve);
            void session.ready.then(() => recovered.resolve(session));
          }
        });
        try {
          if (dialer === 'controller') controller.dial(worker.listen());
          else worker.dial(controller.listen());
          expect(await retired.promise).toBe(failure);
          expect(first!.connected).toBe(false);
          const session = await recovered.promise;
          expect(failing.current).toBe(session);
          expect(session).not.toBe(first);
          session.send('Synthetic recovered delivery');
          expect(await delivered.promise).toBe('Synthetic recovered delivery');
          expect(peer.current?.connected).toBe(true);
        } finally {
          await controller.dispose();
          await worker.dispose();
        }
      });
    }
  }
}
