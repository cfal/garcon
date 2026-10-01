import { expect, spyOn, test } from 'bun:test';
import { createAgentResourceRef } from '@garcon/server-agent-interface';
import { ExecutorRpc } from '../transport/rpc.js';
import { remoteFixture } from './integration-fixture.js';

const request = { response: createAgentResourceRef({ executorId: 'synthetic', instanceId: 'synthetic', integrationId: 'test' }, 'permission-response'), decision: { allow: true } };

for (const dialer of ['controller', 'worker'] as const) {
  test(`permission replies cap caller timeouts and reject invalid values (${dialer} dials)`, async () => {
    const f = await remoteFixture(dialer);
    const calls = spyOn(ExecutorRpc.prototype, 'call');
    try {
      const integration = await f.executor.getAgentIntegration('test');
      for (const timeoutMs of [undefined, 60_000, 25]) {
        await integration.permissions.respond(request, { timeoutMs }).catch(() => {});
        const sent = calls.mock.calls.filter(([, method]) => method === 'permissions.respond').at(-1)!;
        expect(sent[3]?.timeoutMs).toBe(timeoutMs === 25 ? 25 : 20_000);
      }
      const before = calls.mock.calls.length;
      for (const timeoutMs of [0, -1, Infinity, NaN, 1.5]) {
        await expect(integration.permissions.respond(request, { timeoutMs })).rejects.toThrow('positive safe integer');
      }
      expect(calls.mock.calls.length).toBe(before);
      const reconnecting = Promise.withResolvers<void>();
      f.executor.onAvailabilityChanged(value => { if (value === 'reconnecting') reconnecting.resolve(); });
      await f.worker.dispose();
      await reconnecting.promise;
      await expect(integration.permissions.respond(request, { timeoutMs: 25 })).rejects.toMatchObject({ outcome: 'not-dispatched' });
    } finally { calls.mockRestore(); await f.dispose(); }
  });
}
