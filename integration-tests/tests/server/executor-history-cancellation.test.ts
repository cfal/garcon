import { expect, test } from 'bun:test';
import { remoteFixture, requestFor } from '../../../server/remote/__tests__/integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`cancelled history opens release late readers on their original session (${dialer} dials)`, async () => {
    const openIds = new Set<string>();
    const closeIds = new Set<string>();
    let held: ReturnType<typeof Promise.withResolvers<() => void>>;
    let closed: ReturnType<typeof Promise.withResolvers<void>>;
    let closeCount = 0;
    const fixture = await remoteFixture(dialer, (_controller, worker) => {
      worker.onSession((session) => {
        session.onMessage((encoded) => {
          const frame = JSON.parse(encoded);
          if (frame.type === 'request' && frame.method === 'history.open') openIds.add(frame.id);
          if (frame.type === 'request' && frame.method === 'history.close') closeIds.add(frame.id);
        });
        const send = session.send.bind(session);
        session.send = (encoded) => {
          const frame = JSON.parse(encoded);
          if (frame.type === 'result' && openIds.delete(frame.id)) {
            held.resolve(() => send(encoded));
          } else {
            send(encoded);
            if (frame.type === 'result' && closeIds.delete(frame.id)) {
              closeCount++;
              closed.resolve();
            }
          }
        };
      });
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const chat = {
        chatId: request.chatId, projectPath: request.projectPath, agentId: 'test', model: request.model,
        agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: null,
        carryOverRevision: 'synthetic-revision', settings: request.settings,
      };
      for (let i = 0; i < 17; i++) {
        const cancellation = new AbortController();
        held = Promise.withResolvers<() => void>();
        closed = Promise.withResolvers<void>();
        const reader = integration.nativeHistoryImport!.load({ chat, signal: cancellation.signal })[Symbol.asyncIterator]();
        const result = reader.next().catch((error: unknown) => error);
        const release = await held.promise;
        // Completion of this request ensures history.open has left the worker's cancellation map.
        await integration.execution.runningSessions();
        cancellation.abort();
        expect(await result).toMatchObject({ outcome: 'unknown' });
        release();
        await closed.promise;
        expect(closeCount).toBe(i + 1);
      }
      await integration.execution.runningSessions();
      expect(fixture.executor.availability).toBe('ready');
      expect(fixture.generations[0]!.calls.import).toBe(0);
    } finally { await fixture.dispose(); }
  });
}
