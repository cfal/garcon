import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { NODE_STARTUP_TIMEOUT_MS, NODE_RECOVERY_TIMEOUT_MS } from '../../../server/execution-node/supervisor.js';
import { withTimeout } from '../../support/deferred.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable, type NodeSessionFixtureOptions } from '../../support/node-session-handshake-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => {
  certificates = await TlsCertificates.create();
  certificate = await certificates.selfSigned('startup-deadline');
});
afterAll(async () => certificates?.dispose());

async function fixture(options: Pick<NodeSessionFixtureOptions, 'scheduleControllerTimeout' | 'beforeCleanup'> = {}) {
  let elapsedMs = 0;
  const configure = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const heartbeats = new Set<() => void>();
  const f = await createNodeSessionFixture(certificate, certificate.trust, {
    ...options,
    clock: { read: () => ({ elapsedMs, discontinuity: false }) },
    controllerClock: { read: () => ({ elapsedMs: elapsedMs / 2, discontinuity: false }) },
    scheduleHeartbeat(callback) {
      heartbeats.add(callback);
      return { cancel() { heartbeats.delete(callback); } };
    },
    beforeWorkerConfiguration() { held.resolve(); return configure.promise; },
  });
  const renew = spyOn(f.coordinator.supervisor, 'renew');
  return {
    ...f, configure, held,
    async advanceRenewed(ms: number) {
      const target = elapsedMs + ms;
      while (elapsedMs < target) {
        elapsedMs = Math.min(target, elapsedMs + 5_000);
        const count = renew.mock.calls.length;
        const callbacks = [...heartbeats]; heartbeats.clear();
        expect(callbacks).toHaveLength(1);
        for (const callback of callbacks) callback();
        await waitFor(() => renew.mock.calls.length > count);
        expect(renew.mock.results.at(-1)).toMatchObject({ type: 'return', value: true });
      }
    },
    advance(ms: number) { elapsedMs += ms; },
    async dispose() {
      configure.resolve();
      renew.mockRestore();
      await f.dispose();
    },
  };
}

describe.skipIf(!nodeSessionSystemdAvailable)('absolute startup deadlines over real worker and WSS hops', () => {
  test('the controller enforces its advertised readiness timeout while the node remains within startup', async () => {
    const timers: { callback(): void; delayMs: number; cancelled: boolean }[] = [];
    const f = await fixture({ scheduleControllerTimeout(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false }; timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    } });
    try {
      const connection = f.connect();
      const nodeOutcome = connection.ready.catch((error: unknown) => error);
      await withTimeout(f.held.promise, 5_000, () => 'Worker configuration was not reached');
      await waitFor(() => f.sessionAdmissions.length === 1);
      const readiness = timers.find((timer) => !timer.cancelled && timer.delayMs === NODE_STARTUP_TIMEOUT_MS);
      expect(readiness).toBeDefined();
      expect(f.coordinator.supervisor.remainingReadinessMs(f.sessionAdmissions[0]!.session)).toBe(NODE_STARTUP_TIMEOUT_MS);
      readiness!.callback();
      await expect(f.accepted[0]!.ready).rejects.toMatchObject({ code: 'NODE_READINESS_TIMEOUT' });
      expect(await nodeOutcome).toBeInstanceOf(Error);
      expect(f.coordinator.supervisor.retirementReason).toBeNull();
    } finally { await f.dispose(); }
  }, 20_000);

  test('slow startup survives physical replacement and recovery starts after worker configuration', async () => {
    const f = await fixture();
    try {
      const first = f.connect();
      const firstOutcome = first.ready.catch((error: unknown) => error);
      await withTimeout(f.held.promise, 5_000, () => 'Worker configuration was not reached');
      await waitFor(() => f.sessionAdmissions.length === 1);
      const admitted = f.sessionAdmissions[0]!;
      expect(admitted.readinessTimeoutMs).toBe(NODE_STARTUP_TIMEOUT_MS);
      await f.advanceRenewed(20_000);
      expect(f.coordinator.supervisor.remainingReadinessMs(admitted.session)).toBe(40_000);
      expect(f.coordinator.supervisor.status).toBe('recovering');
      const marker = (await f.marker.read())!.identity;
      first.stop(); await first.closed;
      expect(await firstOutcome).toBeInstanceOf(Error);

      const second = f.connect();
      void second.ready.catch(() => {});
      await waitFor(() => f.sessionAdmissions.length === 2);
      expect(f.sessionAdmissions[1]).toMatchObject({ session: admitted.session, connectionId: 2, readinessTimeoutMs: 40_000 });
      await f.advanceRenewed(20_000);
      expect(f.coordinator.supervisor.remainingReadinessMs(admitted.session)).toBe(20_000);
      f.configure.resolve();
      const connection = await second.ready;
      const controller = await f.controller(connection);
      expect(connection.lease.session).toEqual(admitted.session);
      expect((await f.marker.read())!.identity).toEqual(marker);
      expect(f.processes.size).toBe(1);
      expect(f.coordinator.supervisor.remainingReadinessMs(admitted.session)).toBe(NODE_RECOVERY_TIMEOUT_MS);
      expect(() => f.coordinator.supervisor.assertAdmission(connection.lease)).toThrow();
      const recovery = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
      if (recovery.kind !== 'output-recovery') throw new Error('Expected output recovery');
      expect(await controller.client.service.call({ method: 'resume-output', generation: recovery.generation }, controller.signal))
        .toMatchObject({ kind: 'output-live', live: true });
      expect(() => f.coordinator.supervisor.assertAdmission(connection.lease)).not.toThrow();
    } finally { await f.dispose(); }
  }, 20_000);

  test('replacement cannot extend startup or revive a worker after its absolute deadline', async () => {
    const f = await fixture();
    try {
      const first = f.connect();
      const firstOutcome = first.ready.catch((error: unknown) => error);
      await withTimeout(f.held.promise, 5_000, () => 'Worker configuration was not reached');
      await waitFor(() => f.sessionAdmissions.length === 1);
      const admitted = f.sessionAdmissions[0]!;
      await f.advanceRenewed(20_000);
      first.stop(); await first.closed; await firstOutcome;
      const second = f.connect();
      const secondOutcome = second.ready.catch((error: unknown) => error);
      await waitFor(() => f.sessionAdmissions.length === 2);
      expect(f.sessionAdmissions[1]).toMatchObject({ session: admitted.session, readinessTimeoutMs: 40_000 });
      await f.advanceRenewed(35_000);
      f.advance(5_000);
      expect(f.coordinator.supervisor.status).toBe('cleaning-up');
      expect(f.coordinator.supervisor.retirementReason).toBe('startup-expired');
      f.configure.resolve();
      expect(await secondOutcome).toMatchObject({ code: 'NODE_READINESS_TIMEOUT' });
      expect(f.coordinator.supervisor.retirementReason).toBe('startup-expired');
      await expect(f.accepted.at(-1)!.ready).rejects.toMatchObject({ code: 'NODE_READINESS_TIMEOUT' });
      expect(await f.coordinator.supervisor.retryCleanup()).toBe(true);
      expect(f.coordinator.supervisor.status).toBe('offline');
      expect(await f.marker.read()).toBeNull();
      expect(f.processes.size).toBe(1);
    } finally { await f.dispose(); }
  }, 20_000);

  test('physical replacement preserves a partially consumed recovery deadline and expiry fences reuse', async () => {
    const cleanup = Promise.withResolvers<void>();
    const f = await fixture({ beforeCleanup: () => cleanup.promise });
    try {
      f.configure.resolve();
      const first = f.connect();
      const original = await first.ready;
      const identity = (await f.marker.read())!.identity;
      await f.advanceRenewed(5_000);
      first.stop(); await first.closed;
      const second = f.connect();
      const replacement = await second.ready;
      await f.controller(replacement);
      expect(replacement.lease.session).toEqual(original.lease.session);
      expect(f.sessionAdmissions[1]!.readinessTimeoutMs).toBe(10_000);
      await f.advanceRenewed(5_000);
      expect(f.coordinator.supervisor.remainingReadinessMs(original.lease.session)).toBe(5_000);
      f.advance(5_000);
      expect(f.coordinator.supervisor.status).toBe('cleaning-up');
      expect(f.coordinator.supervisor.retirementReason).toBe('recovery-expired');
      await second.closed;
      expect(replacement.lease.authoritySignal.reason).toMatchObject({ code: 'NODE_READINESS_TIMEOUT' });
      expect(f.coordinator.supervisor.retirementReason).toBe('recovery-expired');
      expect(() => f.coordinator.open('synthetic-next-controller')).toThrow();
      expect((await f.marker.read())!.identity).toEqual(identity);
      cleanup.resolve();
      expect(await f.coordinator.supervisor.retryCleanup()).toBe(true);
      expect(await f.marker.read()).toBeNull();
    } finally { cleanup.resolve(); await f.dispose(); }
  }, 20_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Startup fixture condition did not complete');
    await Bun.sleep(1);
  }
}
