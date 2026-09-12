import { describe, expect, spyOn, test } from 'bun:test';
import { NodeSupervisor, NODE_CHALLENGE_INTERVAL_MS, NODE_CONTROLLER_LEASE_MS, NODE_RECOVERY_TIMEOUT_MS, NODE_CLEANUP_TIMEOUT_MS } from '../supervisor.js';
import { SuspendAwareLeaseClock } from '../lease-clock.js';

function fixture(cleanup, options = {}) {
  let elapsed = 0;
  let discontinuity = false;
  const cleanups = [];
  const supervisor = new NodeSupervisor({
    ...options,
    clock: { read() {
      const reading = { elapsedMs: elapsed, discontinuity };
      discontinuity = false;
      return reading;
    } },
    async cleanup(session, reason) {
      cleanups.push({ session, reason });
      await cleanup?.(session, reason);
    },
  });
  const identity = supervisor.openSession('controller-boot');
  const connection = supervisor.attach(identity);
  supervisor.completeRecovery(connection, supervisor.beginRecovery(connection));
  return {
    supervisor, identity, connection, cleanups,
    advance(ms) { elapsed += ms; },
    suspend() { discontinuity = true; },
  };
}

describe('remote controller supervision', () => {
  test('reconciliation requires the current physical connection without reopening admissions', async () => {
    const { supervisor, identity, connection } = fixture();
    expect(() => supervisor.assertConnection(connection)).not.toThrow();
    supervisor.disconnect(connection);
    expect(() => supervisor.assertConnection(connection)).toThrow();
    const replacement = supervisor.attach(identity);
    expect(() => supervisor.assertConnection(replacement)).not.toThrow();
    expect(() => supervisor.assertAdmission(replacement)).toThrow('still recovering');
    expect(() => supervisor.assertConnection(connection)).toThrow();
    await supervisor.revoke();
    expect(() => supervisor.assertConnection(replacement)).toThrow();
    await supervisor.shutdown();
  });

  test.each([false, true])('production cleanup deadline is cancelled after settlement (failed: %s)', async (fail) => {
    const schedule = spyOn(globalThis, 'setTimeout');
    const cancel = spyOn(globalThis, 'clearTimeout');
    try {
      const { supervisor } = fixture(async () => {
        if (fail) throw new Error('Synthetic cleanup failure');
      });
      expect(await supervisor.revoke()).toBe(!fail);
      const deadlines = schedule.mock.calls.flatMap((args, index) => args[1] === NODE_CLEANUP_TIMEOUT_MS ? [index] : []);
      expect(deadlines).toHaveLength(1);
      expect(cancel).toHaveBeenCalledWith(schedule.mock.results[deadlines[0]].value);
    } finally {
      schedule.mockRestore();
      cancel.mockRestore();
    }
  });

  test('a cleanup deadline bounds control waits without starting overlapping cleanup', async () => {
    const worker = Promise.withResolvers();
    let expire;
    let cancelled = 0;
    const f = fixture(() => worker.promise, {
      scheduleTimeout(callback, delay) {
        expect(delay).toBe(NODE_CLEANUP_TIMEOUT_MS);
        expire = callback;
        return { cancel() { cancelled += 1; } };
      },
    });
    const revocation = f.supervisor.revoke();
    try {
      expect(typeof expire).toBe('function');
      expire();
      expect(await revocation).toBe(false);
      expect(f.supervisor.cleanupFailure).toMatchObject({ code: 'NODE_CLEANUP_FAILED' });
      expect(f.supervisor.status).toBe('cleaning-up');
      expect(f.connection.authoritySignal.aborted).toBe(true);
      expect(() => f.supervisor.openSession('next-controller')).toThrow('completed cleanup');
      expect(await f.supervisor.revoke()).toBe(false);
      expect(await f.supervisor.retryCleanup()).toBe(false);
      expect(f.cleanups).toHaveLength(1);
      expect(cancelled).toBe(0);
    } finally {
      worker.resolve();
      await new Promise(setImmediate);
    }
    expect(cancelled).toBe(1);
    expect(f.supervisor.cleanupFailure).toBeNull();
    expect(f.supervisor.status).toBe('offline');
    expect(() => f.supervisor.openSession('next-controller')).not.toThrow();
    await f.supervisor.shutdown();
  });

  test('shutdown reports timed-out cleanup while keeping its lifetime closed', async () => {
    const worker = Promise.withResolvers();
    let expire;
    const f = fixture(() => worker.promise, {
      scheduleTimeout(callback) { expire = callback; return { cancel() {} }; },
    });
    const shutdown = f.supervisor.shutdown();
    try {
      expect(typeof expire).toBe('function');
      expire();
      expect(await shutdown).toBe(false);
      expect(await f.supervisor.shutdown()).toBe(false);
      expect(f.cleanups).toHaveLength(1);
      expect(() => f.supervisor.openSession('next-controller')).toThrow('shut down');
    } finally {
      worker.resolve();
      await new Promise(setImmediate);
    }
    expect(await f.supervisor.shutdown()).toBe(true);
  });

  test('failed cleanup can retry after its timed-out operation settles, with stale deadlines inert', async () => {
    const worker = Promise.withResolvers();
    const deadlines = [];
    let attempts = 0;
    const f = fixture(() => ++attempts === 1 ? worker.promise : Promise.resolve(), {
      scheduleTimeout(callback) { deadlines.push(callback); return { cancel() {} }; },
    });
    const cleanup = f.supervisor.revoke();
    deadlines[0]();
    expect(await cleanup).toBe(false);
    expect(await f.supervisor.retryCleanup()).toBe(false);
    expect(attempts).toBe(1);
    worker.reject(new Error('Synthetic late cleanup failure'));
    await new Promise(setImmediate);
    expect(f.supervisor.status).toBe('cleaning-up');
    expect(await f.supervisor.retryCleanup()).toBe(true);
    expect(attempts).toBe(2);
    const next = f.supervisor.attach(f.supervisor.openSession('next-controller'));
    f.supervisor.completeRecovery(next, f.supervisor.beginRecovery(next));
    deadlines.forEach((expire) => expire());
    expect(f.supervisor.status).toBe('online');
    expect(f.supervisor.cleanupFailure).toBeNull();
    expect(next.authoritySignal.aborted).toBe(false);
    await f.supervisor.shutdown();
  });

  test.each([false, true])('cleanup reason is captured before a later shutdown (yield: %s)', async (yieldFirst) => {
    const f = fixture();
    const cleanup = f.supervisor.revoke();
    if (yieldFirst) await Promise.resolve();
    await f.supervisor.shutdown();
    expect(await cleanup).toBe(true);
    expect(f.cleanups.map(({ reason }) => reason)).toEqual(['revoked']);
  });

  test.each([4_999, 5_000, 9_000, 14_999, 15_000])('challenge validity ends at its lease deadline (%ims)', async (age) => {
    const { supervisor, connection, advance } = fixture();
    const challenge = supervisor.issueChallenge(connection);
    advance(age);
    expect(supervisor.renew(connection, challenge)).toBe(age < NODE_CONTROLLER_LEASE_MS);
    expect(supervisor.renew(connection, challenge)).toBe(false);
    await supervisor.shutdown();
  });

  test.each(['revoke', 'shutdown', 'controllerShutdown'])('%s retries failed cleanup without opening admission', async (operation) => {
    let attempts = 0;
    const { supervisor, connection } = fixture(async () => {
      if (++attempts === 1) throw new Error('Synthetic cleanup failure');
    });
    expect(await supervisor[operation](connection)).toBe(false);
    expect(supervisor.status).toBe('cleaning-up');
    expect(await supervisor[operation](connection)).toBe(true);
    expect(attempts).toBe(2);
    expect(supervisor.status).toBe('offline');
    await supervisor.shutdown();
  });

  test('renewals cannot keep a broken recovery authoritative indefinitely', async () => {
    const { supervisor, identity, connection, advance, cleanups } = fixture();
    supervisor.disconnect(connection);
    const replacement = supervisor.attach(identity);
    for (let index = 0; index < 3; index += 1) {
      const challenge = supervisor.issueChallenge(replacement);
      expect(supervisor.renew(replacement, challenge)).toBe(true);
      advance(NODE_CHALLENGE_INTERVAL_MS);
    }
    expect(supervisor.status).toBe('cleaning-up');
    expect(await supervisor.retryCleanup()).toBe(true);
    expect(cleanups[0].reason).toBe('recovery-expired');
  });

  test('administrative shutdown promotes the reason when retrying older failed cleanup', async () => {
    const reasons = [];
    const { supervisor } = fixture(async (_identity, reason) => {
      reasons.push(reason);
      if (reasons.length === 1) throw new Error('Synthetic cleanup failure');
    });
    expect(await supervisor.revoke()).toBe(false);
    expect(await supervisor.shutdown()).toBe(true);
    expect(reasons).toEqual(['revoked', 'node-shutdown']);
  });

  test('renews only an outstanding challenge on the exact live connection', async () => {
    const { supervisor, connection, advance, cleanups } = fixture();
    const first = supervisor.issueChallenge(connection);
    expect(typeof first).toBe('string');
    expect(supervisor.issueChallenge(connection)).toBeNull();
    expect(supervisor.renew(connection, 'unrecognized')).toBe(false);
    advance(NODE_CHALLENGE_INTERVAL_MS);
    const second = supervisor.issueChallenge(connection);
    expect(second).not.toBe(first);
    expect(supervisor.renew(connection, first)).toBe(true);
    expect(supervisor.renew(connection, second)).toBe(true);
    advance(NODE_CONTROLLER_LEASE_MS - 1);
    expect(supervisor.renew(connection, second)).toBe(false);
    expect(() => supervisor.assertAdmission(connection)).not.toThrow();
    advance(1);
    expect(supervisor.renew(connection, second)).toBe(false);
    expect(connection.signal.aborted).toBe(true);
    expect(await supervisor.retryCleanup()).toBe(true);
    expect(cleanups).toEqual([{ session: connection.session, reason: 'lease-expired' }]);
  });

  test('a brief disconnect preserves work but gates new admission through recovery', async () => {
    const { supervisor, identity, connection, advance, cleanups } = fixture();
    supervisor.disconnect(connection);
    expect(supervisor.status).toBe('reconnecting');
    advance(1_000);
    expect(connection.signal.aborted).toBe(true);
    expect(connection.authoritySignal.aborted).toBe(false);
    const replacement = supervisor.attach(identity);
    expect(supervisor.status).toBe('recovering');
    expect(() => supervisor.assertAdmission(replacement)).toThrow('still recovering');
    supervisor.disconnect(connection);
    expect(() => supervisor.completeRecovery(connection)).toThrow('no longer authoritative');
    expect(supervisor.status).toBe('recovering');
    supervisor.completeRecovery(replacement, supervisor.beginRecovery(replacement));
    expect(() => supervisor.assertAdmission(replacement)).not.toThrow();
    expect(cleanups).toEqual([]);
    await supervisor.shutdown();
  });

  test('socket replacement never extends the lease or revives expired authority', async () => {
    const { supervisor, identity, connection, advance } = fixture();
    const challenge = supervisor.issueChallenge(connection);
    advance(NODE_CONTROLLER_LEASE_MS - 1);
    const replacement = supervisor.attach(identity);
    expect(supervisor.renew(connection, challenge)).toBe(false);
    const freshChallenge = supervisor.issueChallenge(replacement);
    advance(1);
    expect(supervisor.renew(replacement, freshChallenge)).toBe(false);
    expect(() => supervisor.attach(identity)).toThrow('no longer authoritative');
    expect(await supervisor.retryCleanup()).toBe(true);
    expect(() => supervisor.attach(identity)).toThrow('no longer authoritative');
  });

  test('retires synchronously and blocks a replacement until process/PTY cleanup completes', async () => {
    let finishCleanup;
    const stopped = new Promise((resolve) => { finishCleanup = resolve; });
    const { supervisor, identity, connection } = fixture(() => stopped);
    const cleanup = supervisor.revoke();
    expect(connection.signal.aborted).toBe(true);
    expect(supervisor.status).toBe('cleaning-up');
    expect(() => supervisor.openSession('controller-replacement')).toThrow('completed cleanup');
    expect(() => supervisor.assertAdmission(connection)).toThrow('no longer authoritative');
    finishCleanup();
    expect(await cleanup).toBe(true);
    const replacement = supervisor.openSession('controller-replacement');
    expect(replacement.nodeBootId).toBe(identity.nodeBootId);
    expect(replacement.logicalSessionId).not.toBe(identity.logicalSessionId);
    expect(replacement.controllerBootId).toBe('controller-replacement');
    await supervisor.shutdown();
  });

  test('failed cleanup remains fenced and must be explicitly retried', async () => {
    let attempts = 0;
    const { supervisor, connection } = fixture(async () => {
      if (++attempts === 1) throw new Error('Synthetic worker still alive');
    });
    expect(await supervisor.controllerShutdown(connection)).toBe(false);
    expect(connection.signal.aborted).toBe(true);
    expect(supervisor.status).toBe('cleaning-up');
    expect(() => supervisor.openSession('new-controller')).toThrow('completed cleanup');
    expect(await supervisor.retryCleanup()).toBe(true);
    expect(supervisor.status).toBe('offline');
    expect(attempts).toBe(2);
  });

  test('clock uncertainty invalidates authority before buffered requests execute', async () => {
    const { supervisor, connection, suspend, cleanups } = fixture();
    suspend();
    expect(() => supervisor.assertAdmission(connection)).toThrow('no longer authoritative');
    expect(await supervisor.retryCleanup()).toBe(true);
    expect(cleanups[0].reason).toBe('clock-discontinuity');
    expect(() => supervisor.openSession('new-controller')).not.toThrow();
    await supervisor.shutdown();
  });

  test('rejects a competing session and never reopens a shut-down supervisor', async () => {
    const { supervisor, identity, connection } = fixture();
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(connection)).toBe(true);
    expect(() => supervisor.openSession('another-controller')).toThrow('still authoritative');
    await supervisor.shutdown();
    expect(() => supervisor.openSession('another-controller')).toThrow('shut down');
    expect(supervisor.renew(connection, 'late')).toBe(false);
  });

  test('a stale shutdown or abort callback cannot clean up replacement authority', async () => {
    const { supervisor, identity, connection, cleanups } = fixture();
    const replacement = supervisor.attach(identity);
    supervisor.completeRecovery(replacement, supervisor.beginRecovery(replacement));
    expect(await supervisor.controllerShutdown(connection)).toBe(false);
    let reentrantCleanup;
    replacement.signal.addEventListener('abort', () => { reentrantCleanup = supervisor.retryCleanup(); });
    expect(await supervisor.controllerShutdown(replacement)).toBe(true);
    expect(await reentrantCleanup).toBe(true);
    expect(cleanups).toHaveLength(1);
    const next = supervisor.attach(supervisor.openSession('next-controller'));
    supervisor.completeRecovery(next, supervisor.beginRecovery(next));
    expect(await supervisor.controllerShutdown(replacement)).toBe(false);
    expect(() => supervisor.assertAdmission(next)).not.toThrow();
    await supervisor.shutdown();
  });

  test('connection-scoped revocation cannot abort a replacement socket or logical session', async () => {
    const { supervisor, identity, connection, cleanups } = fixture();
    const replacement = supervisor.attach(identity);
    supervisor.completeRecovery(replacement, supervisor.beginRecovery(replacement));
    expect(await supervisor.revokeConnection(connection)).toBe(false);
    expect(() => supervisor.assertAdmission(replacement)).not.toThrow();
    expect(await supervisor.revokeConnection(replacement)).toBe(true);
    expect(cleanups).toHaveLength(1);
    const next = supervisor.attach(supervisor.openSession('controller-next'));
    supervisor.completeRecovery(next, supervisor.beginRecovery(next));
    expect(await supervisor.revokeConnection(replacement)).toBe(false);
    expect(next.authoritySignal.aborted).toBe(false);
    expect(() => supervisor.assertAdmission(next)).not.toThrow();
    await supervisor.shutdown();
  });

  test('each socket has its own teardown signal while admitted work keeps logical authority', async () => {
    const { supervisor, identity, connection } = fixture();
    const replacement = supervisor.attach(identity);
    expect(connection.signal.aborted).toBe(true);
    expect(connection.signal).not.toBe(replacement.signal);
    expect(connection.authoritySignal).toBe(replacement.authoritySignal);
    expect(connection.authoritySignal.aborted).toBe(false);
    supervisor.disconnect(connection);
    expect(replacement.signal.aborted).toBe(false);
    supervisor.disconnect(replacement);
    expect(replacement.signal.aborted).toBe(true);
    expect(replacement.authoritySignal.aborted).toBe(false);
    await supervisor.revoke();
    expect(replacement.authoritySignal.aborted).toBe(true);
  });

  test('same-socket replay retries and mid-session gaps have exact recovery-attempt fences', async () => {
    const { supervisor, connection } = fixture();
    const first = supervisor.beginRecovery(connection);
    expect(supervisor.status).toBe('recovering');
    expect(() => supervisor.assertAdmission(connection)).toThrow('still recovering');
    const second = supervisor.beginRecovery(connection);
    expect(supervisor.completeRecovery(connection, first)).toBe(false);
    expect(supervisor.completeRecovery(connection, { ...second })).toBe(false);
    expect(supervisor.status).toBe('recovering');
    expect(supervisor.completeRecovery(connection, second)).toBe(true);
    expect(supervisor.completeRecovery(connection, second)).toBe(false);
    expect(() => supervisor.assertAdmission(connection)).not.toThrow();
    await supervisor.shutdown();
  });

  test('a missing attempt cannot open admission on a newly attached socket', async () => {
    const { supervisor, identity } = fixture();
    const connection = supervisor.attach(identity);
    expect(supervisor.completeRecovery(connection, null)).toBe(false);
    expect(supervisor.completeRecovery(connection, undefined)).toBe(false);
    expect(() => supervisor.assertAdmission(connection)).toThrow('still recovering');
    await supervisor.shutdown();
  });

  test('socket churn and new replay attempts cannot extend the original recovery deadline', async () => {
    const { supervisor, identity, connection, advance, cleanups } = fixture();
    supervisor.disconnect(connection);
    advance(4_000);
    let current = supervisor.attach(identity);
    const oldAttempt = supervisor.beginRecovery(current);
    expect(supervisor.renew(current, supervisor.issueChallenge(current))).toBe(true);
    advance(4_000);
    current = supervisor.attach(identity);
    supervisor.beginRecovery(current);
    expect(supervisor.renew(current, supervisor.issueChallenge(current))).toBe(true);
    advance(NODE_RECOVERY_TIMEOUT_MS - 8_001);
    const lastAttempt = supervisor.beginRecovery(current);
    expect(supervisor.completeRecovery(current, oldAttempt)).toBe(false);
    advance(1);
    expect(() => supervisor.completeRecovery(current, lastAttempt)).toThrow('no longer authoritative');
    expect(await supervisor.retryCleanup()).toBe(true);
    expect(cleanups[0].reason).toBe('recovery-expired');
  });

  test.each(['retryCleanup', 'revoke', 'shutdown', 'revokeConnection', 'controllerShutdown'])(
    'a dropped %s re-entry rejection fails cleanup without an unhandled process error', async (operation) => {
      const child = Bun.spawn([process.execPath, `${import.meta.dir}/supervisor-dropped-reentry-fixture.js`, operation], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
      try {
        const [output, diagnostic, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(code, diagnostic).toBe(0);
        expect(JSON.parse(output)).toMatchObject({
          cleaned: false, status: 'cleaning-up', failure: { code: 'NODE_CLEANUP_REENTRANT' },
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  test('retained contexts follow the active attempt through gated settlement', async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const before = Promise.withResolvers();
    const after = Promise.withResolvers();
    let first = true;
    let activeProbe;
    let settledProbe;
    const observe = () => {
      const status = supervisor.status;
      return supervisor.retryCleanup().then(
        (result) => ({ status, result }), (error) => ({ status, error }),
      );
    };
    const { supervisor } = fixture(() => {
      if (!first) return;
      first = false;
      activeProbe = before.promise.then(observe);
      settledProbe = after.promise.then(observe);
      entered.resolve();
      return release.promise;
    });
    const cleanup = supervisor.revoke();
    await entered.promise;
    before.resolve();
    expect(await activeProbe).toMatchObject({ status: 'cleaning-up', error: { name: 'CleanupReentryError' } });
    expect(() => supervisor.openSession('next-controller')).toThrow();
    release.resolve();
    expect(await cleanup).toBe(false);
    expect(await supervisor.retryCleanup()).toBe(true);
    after.resolve();
    expect(await settledProbe).toEqual({ status: 'offline', result: true });
    await supervisor.shutdown();
  });

  test('settled cleanup contexts cannot see offline admission while still classified as re-entry', async () => {
    for (let depth = 0; depth < 12; depth += 1) {
      let probe;
      let first = true;
      const supervisor = new NodeSupervisor({
        async cleanup() {
          if (!first) return;
          first = false;
          let chain = Promise.resolve();
          for (let index = 0; index < depth; index += 1) chain = chain.then(() => {});
          probe = chain.then(() => {
            const status = supervisor.status;
            return supervisor.retryCleanup().then(
              (result) => ({ status, result }), (error) => ({ status, error }),
            );
          });
        },
      });
      supervisor.openSession('synthetic-controller');
      const cleaned = await supervisor.revoke();
      const outcome = await probe;
      if (outcome.status === 'offline') expect(outcome).toEqual({ status: 'offline', result: true });
      else {
        expect(outcome.error).toMatchObject({ name: 'CleanupReentryError' });
        expect(cleaned).toBe(false);
      }
      await supervisor.retryCleanup();
    }
  });

  test.each(['retryCleanup', 'revoke', 'shutdown', 'revokeConnection', 'controllerShutdown'])(
    '%s rejects cleanup re-entry through its returned promise without synchronous effects', async (operation) => {
      let probe = true;
      let thrown;
      let rejection;
      let result;
      const { supervisor, connection, cleanups } = fixture(() => {
        if (!probe) return;
        probe = false;
        try {
          result = supervisor[operation](connection);
        } catch (error) {
          thrown = error;
          return;
        }
        return result.catch((error) => { rejection = error; throw error; });
      });
      const cleaned = await supervisor.revoke();
      expect(thrown).toBeUndefined();
      expect(result).toBeInstanceOf(Promise);
      expect(rejection).toMatchObject({ name: 'CleanupReentryError' });
      expect(cleaned).toBe(false);
      expect(supervisor.cleanupFailure).toMatchObject({ code: 'NODE_CLEANUP_REENTRANT' });
      expect(await supervisor.retryCleanup()).toBe(true);
      expect(cleanups.map(({ reason }) => reason)).toEqual(['revoked', 'revoked']);
      expect(() => supervisor.openSession('next-controller')).not.toThrow();
      await supervisor.shutdown();
    },
  );

  test.each(['retryCleanup', 'revoke', 'shutdown', 'revokeConnection', 'controllerShutdown'])(
    'cleanup cannot self-await through %s, including after an async boundary', async (operation) => {
      let recurse = true;
      const { supervisor, connection } = fixture(async () => {
        if (recurse) {
          await Promise.resolve();
          await supervisor[operation](connection);
        }
      });
      expect(await supervisor.revoke()).toBe(false);
      expect(supervisor.cleanupFailure).toMatchObject({ code: 'NODE_CLEANUP_REENTRANT' });
      expect(supervisor.status).toBe('cleaning-up');
      recurse = false;
      expect(await supervisor.retryCleanup()).toBe(true);
      expect(supervisor.cleanupFailure).toBeNull();
      await supervisor.shutdown();
    },
  );

  test('external cleanup requests share the barrier without being mistaken for callback re-entry', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { supervisor, cleanups } = fixture(() => pending);
    const first = supervisor.revoke();
    await Promise.resolve();
    const second = supervisor.retryCleanup();
    const shutdown = supervisor.shutdown();
    expect(second).toBe(first);
    expect(shutdown).toBe(first);
    release();
    expect(await first).toBe(true);
    expect(cleanups).toHaveLength(1);
  });

  test.each([false, true])('settled cleanup context can request a later retry (failed: %s)', async (failFirst) => {
    const trigger = Promise.withResolvers();
    let deferredRetry;
    let attempts = 0;
    const { supervisor } = fixture(async () => {
      if (++attempts !== 1) return;
      deferredRetry = trigger.promise.then(() => supervisor.retryCleanup());
      if (failFirst) throw new Error('Synthetic cleanup failure');
    });
    expect(await supervisor.revoke()).toBe(!failFirst);
    trigger.resolve();
    expect(await deferredRetry).toBe(true);
    expect(attempts).toBe(failFirst ? 2 : 1);
    expect(supervisor.status).toBe('offline');
    expect(supervisor.cleanupFailure).toBeNull();
    await supervisor.shutdown();
  });

  test('a prior cleanup context may join a different in-flight attempt', async () => {
    const trigger = Promise.withResolvers();
    const worker = Promise.withResolvers();
    let deferredRetry;
    let joined;
    let attempts = 0;
    const { supervisor } = fixture(async () => {
      if (++attempts === 1) {
        deferredRetry = trigger.promise.then(() => {
          joined = supervisor.retryCleanup();
          return joined;
        });
      } else {
        await worker.promise;
      }
    });
    expect(await supervisor.revoke()).toBe(true);
    supervisor.openSession('next-controller');
    const cleanup = supervisor.revoke();
    trigger.resolve();
    try {
      await Promise.resolve();
      expect(joined).toBe(cleanup);
      worker.resolve();
      expect(await deferredRetry).toBe(true);
      expect(await cleanup).toBe(true);
      expect(attempts).toBe(2);
      expect(supervisor.cleanupFailure).toBeNull();
    } finally {
      worker.resolve();
      await supervisor.shutdown();
    }
  });

  test('a timed-out attempt still rejects its own deferred cleanup control', async () => {
    const trigger = Promise.withResolvers();
    let expire;
    const { supervisor } = fixture(async () => {
      await trigger.promise;
      await supervisor.retryCleanup();
    }, {
      scheduleTimeout(callback) { expire = callback; return { cancel() {} }; },
    });
    const cleanup = supervisor.revoke();
    expire();
    expect(await cleanup).toBe(false);
    trigger.resolve();
    await new Promise(setImmediate);
    expect(supervisor.cleanupFailure).toMatchObject({ code: 'NODE_CLEANUP_REENTRANT' });
    expect(supervisor.status).toBe('cleaning-up');
  });

  test('cleanup failure diagnostics exclude callback secrets and clear only after confirmed cleanup', async () => {
    let attempts = 0;
    const { supervisor } = fixture(async () => {
      if (++attempts === 1) throw new Error('private synthetic credential /private/native/path');
    });
    expect(await supervisor.revoke()).toBe(false);
    expect(supervisor.cleanupFailure).toMatchObject({ code: 'NODE_CLEANUP_FAILED' });
    expect(Object.isFrozen(supervisor.cleanupFailure)).toBe(true);
    expect(JSON.stringify(supervisor.cleanupFailure)).not.toContain('private');
    expect(await supervisor.retryCleanup()).toBe(true);
    expect(supervisor.cleanupFailure).toBeNull();
  });
});

describe('suspend-aware lease clock', () => {
  test.each([NaN, -1, Infinity])('invalid active clock reading retires authority before admission: %s', async (invalid) => {
    let elapsedMs = 0;
    const supervisor = new NodeSupervisor({
      clock: { read: () => ({ elapsedMs, discontinuity: false }) }, async cleanup() {},
    });
    const connection = supervisor.attach(supervisor.openSession('controller-a'));
    supervisor.completeRecovery(connection, supervisor.beginRecovery(connection));
    expect(supervisor.status).toBe('online');
    elapsedMs = invalid;
    expect(() => supervisor.assertAdmission(connection)).toThrow('no longer authoritative');
    expect(connection.authoritySignal.aborted).toBe(true);
    expect(await supervisor.retryCleanup()).toBe(true);
    await supervisor.shutdown();
  });

  test('repeated sub-threshold suspension cannot extend the controller-required lifetime', async () => {
    let monotonic = 0;
    let wall = 0;
    const supervisor = new NodeSupervisor({
      clock: new SuspendAwareLeaseClock(() => monotonic, () => wall), async cleanup() {},
    });
    const connection = supervisor.attach(supervisor.openSession('controller-a'));
    supervisor.completeRecovery(connection, supervisor.beginRecovery(connection));
    for (let index = 0; index < 15; index += 1) {
      monotonic += 100;
      wall += 1_000;
      supervisor.poll();
    }
    expect(connection.signal.aborted).toBe(true);
    expect(() => supervisor.assertAdmission(connection)).toThrow('no longer authoritative');
    await supervisor.shutdown();
  });

  test('a finite clock discontinuity while idle establishes a fresh baseline without rejecting the first session', async () => {
    let monotonic = 0;
    let wall = 0;
    const supervisor = new NodeSupervisor({
      clock: new SuspendAwareLeaseClock(() => monotonic, () => wall), async cleanup() {},
    });
    expect(supervisor.status).toBe('offline');
    monotonic += 3_600_000;
    wall += 3_601_500;
    const connection = supervisor.attach(supervisor.openSession('controller-a'));
    supervisor.completeRecovery(connection, supervisor.beginRecovery(connection));
    expect(() => supervisor.assertAdmission(connection)).not.toThrow();
    await supervisor.shutdown();
  });

  test('invalid clock readings block new sessions with a distinct reason', async () => {
    const supervisor = new NodeSupervisor({ clock: { read: () => ({ elapsedMs: NaN, discontinuity: true }) }, async cleanup() {} });
    expect(() => supervisor.openSession('')).toThrow('Invalid controller boot identity');
    expect(() => supervisor.openSession('controller-a')).toThrow('lease clock is unavailable');
    await supervisor.shutdown();
  });

  test('tolerated divergence counts conservatively and even a small clock regression is uncertain', () => {
    let monotonic = 0;
    let wall = 100;
    const clock = new SuspendAwareLeaseClock(() => monotonic, () => wall);
    clock.read();
    monotonic += 100;
    wall += 1_000;
    expect(clock.read()).toEqual({ elapsedMs: 1_000, discontinuity: false });
    monotonic += 1_000;
    wall += 100;
    expect(clock.read()).toEqual({ elapsedMs: 2_000, discontinuity: false });
    wall -= 1;
    expect(clock.read()).toEqual({ elapsedMs: 2_000, discontinuity: true });
  });

  test('detects excluded suspend time, wall adjustments and monotonic regression', () => {
    let monotonic = 100;
    let wall = 10_000;
    const clock = new SuspendAwareLeaseClock(() => monotonic, () => wall);
    expect(clock.read()).toEqual({ elapsedMs: 100, discontinuity: false });
    monotonic += 5_000;
    wall += 5_000;
    expect(clock.read().discontinuity).toBe(false);
    wall += 60_000;
    expect(clock.read().discontinuity).toBe(true);
    expect(clock.read().discontinuity).toBe(false);
    wall -= 5_000;
    expect(clock.read().discontinuity).toBe(true);
    monotonic -= 1;
    expect(clock.read().discontinuity).toBe(true);
    monotonic = NaN;
    expect(clock.read().discontinuity).toBe(true);
  });
});
