import { expect, test } from 'bun:test';
import { NodeSupervisor, NODE_STARTUP_TIMEOUT_MS, NODE_RECOVERY_TIMEOUT_MS } from '../supervisor.js';

function fixture() {
  let elapsedMs = 0;
  const reasons: string[] = [];
  const supervisor = new NodeSupervisor({ clock: { read: () => ({ elapsedMs, discontinuity: false }) },
    async cleanup(_session, reason) { reasons.push(reason); } });
  const session = supervisor.openSession('synthetic-controller');
  let connection = supervisor.attach(session);
  return {
    supervisor, session, reasons,
    get connection() { return connection; },
    advanceRenewed(ms: number) {
      const target = elapsedMs + ms;
      while (elapsedMs < target) {
        const challenge = supervisor.issueChallenge(connection);
        if (challenge) expect(supervisor.renew(connection, challenge)).toBe(true);
        elapsedMs = Math.min(target, elapsedMs + 5_000);
      }
    },
    replace() {
      supervisor.disconnect(connection);
      connection = supervisor.attach(session);
    },
  };
}

test('startup survives the recovery interval and replacement cannot renew its absolute deadline', async () => {
  const f = fixture();
  try {
    f.advanceRenewed(20_000);
    expect(f.connection.authoritySignal.aborted).toBe(false);
    expect(f.supervisor.remainingReadinessMs(f.session)).toBe(NODE_STARTUP_TIMEOUT_MS - 20_000);
    f.replace();
    expect(f.supervisor.remainingReadinessMs(f.session)).toBe(NODE_STARTUP_TIMEOUT_MS - 20_000);
    f.advanceRenewed(20_000);
    f.replace();
    f.advanceRenewed(20_000);
    expect(f.supervisor.status).toBe('cleaning-up');
    expect(f.connection.authoritySignal.aborted).toBe(true);
    await f.supervisor.retryCleanup();
    expect(f.reasons).toEqual(['startup-expired']);
  } finally { await f.supervisor.shutdown(); }
});

test('a recovery acknowledgement cannot discard unfinished startup authority', async () => {
  const f = fixture();
  try {
    const recovery = f.supervisor.beginRecovery(f.connection);
    expect(f.supervisor.completeRecovery(f.connection, recovery)).toBe(false);
    expect(() => f.supervisor.assertAdmission(f.connection)).toThrow();
    f.advanceRenewed(20_000);
    expect(f.supervisor.remainingReadinessMs(f.session)).toBe(40_000);
    f.supervisor.completeStartup(f.session);
    expect(f.supervisor.completeRecovery(f.connection, recovery)).toBe(true);
    expect(() => f.supervisor.assertAdmission(f.connection)).not.toThrow();
  } finally { await f.supervisor.shutdown(); }
});

test('first recovery gets its own bounded budget after slow startup; subsequent attempts retain that deadline', async () => {
  const f = fixture();
  try {
    f.advanceRenewed(55_000);
    f.supervisor.completeStartup(f.session);
    const initial = f.supervisor.beginRecovery(f.connection);
    expect(f.supervisor.remainingReadinessMs(f.session)).toBe(NODE_RECOVERY_TIMEOUT_MS);
    f.advanceRenewed(5_000);
    f.replace();
    f.supervisor.completeStartup(f.session);
    const replacement = f.supervisor.beginRecovery(f.connection);
    expect(replacement).not.toBe(initial);
    expect(f.supervisor.remainingReadinessMs(f.session)).toBe(10_000);
    f.advanceRenewed(10_000);
    expect(f.supervisor.status).toBe('cleaning-up');
    expect(() => f.supervisor.completeRecovery(f.connection, replacement)).toThrow();
    await f.supervisor.retryCleanup();
    expect(f.reasons).toEqual(['recovery-expired']);
  } finally { await f.supervisor.shutdown(); }
});
