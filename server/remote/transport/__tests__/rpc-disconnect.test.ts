import { expect, test } from 'bun:test';
import { remoteFixture, requestFor } from '../../__tests__/integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`lost result fails once without redispatch (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      fixture.generations[0]!.hooks.start = async () => {
        fixture.worker.disconnect(); fixture.controller.disconnect();
      };
      await expect(integration.execution.start(request)).rejects.toMatchObject({ outcome: 'unknown' });
      expect(fixture.generations[0]!.calls.start).toBe(1);
      expect(fixture.generations[0]!.calls.abort).toBe(0);
    } finally { await fixture.dispose(); }
  });

  test(`malformed error retires the RPC instead of stranding a pending call (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      fixture.generations[0]!.hooks.start = async () => { entered.resolve(); await release.promise; };
      let requestId = '';
      fixture.worker.current!.onMessage((encoded) => {
        const frame = JSON.parse(encoded);
        if (frame.method === 'execution.start') requestId = frame.id;
      });
      const call = integration.execution.start(request).catch((error: unknown) => error);
      await entered.promise;
      fixture.worker.current!.send(JSON.stringify({ type: 'error', id: requestId, error: { outcome: 'unknown' } }));
      expect(await call).toMatchObject({ outcome: 'unknown' });
      release.resolve();
    } finally { await fixture.dispose(); }
  });
}
