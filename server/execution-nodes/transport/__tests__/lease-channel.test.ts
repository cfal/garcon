import { expect, mock, test } from 'bun:test';
import { NodeSupervisor, NODE_CONTROLLER_LEASE_MS } from '../../../execution-node/supervisor.js';
import { NodeSessionLeaseMonitor } from '../../../execution-node/session-lease-monitor.js';
import { ControllerLeaseResponder, NodeLeaseHeartbeat } from '../lease-channel.js';
import { MAX_NODE_LEASE_FRAME_BYTES, parseNodeLeaseFrameText, serializeNodeLeaseFrame } from '../lease-wire.js';

function fixture() {
  let now = 0;
  let discontinuity = false;
  const cleanup = mock(async () => {});
  const supervisor = new NodeSupervisor({ clock: { read: () => ({ elapsedMs: now, discontinuity }) }, cleanup });
  const session = supervisor.openSession('synthetic-controller');
  const connection = supervisor.attach(session);
  supervisor.completeRecovery(connection, supervisor.beginRecovery(connection));
  const polls: { callback(): void; cancelled: boolean; delayMs: number }[] = [];
  const schedulePoll = (callback: () => void, delayMs: number) => {
    const poll = { callback, delayMs, cancelled: false }; polls.push(poll);
    return { cancel() { poll.cancelled = true; } };
  };
  const failed = mock(() => {});
  new NodeSessionLeaseMonitor({ authoritySignal: connection.authoritySignal, supervisor, schedulePoll, failed });
  const requests: string[] = [];
  const replies: string[] = [];
  const nodeClose = mock(() => {});
  const controllerClose = mock(() => {});
  const disconnected = mock(() => {});
  const physical = new AbortController();
  const node = new NodeLeaseHeartbeat({ send: (text) => { requests.push(text); return true; }, close: nodeClose },
    { connection, supervisor, disconnected, schedulePoll });
  const validate = mock(() => {});
  const controller = new ControllerLeaseResponder({ send: (text) => { replies.push(text); return true; }, close: controllerClose },
    { session, signal: physical.signal, validate });
  return { supervisor, session, connection, node, controller, requests, replies, nodeClose, controllerClose,
    disconnected, physical, validate, cleanup, failed, polls,
    advance(ms: number) { now += ms; }, suspend() { discontinuity = true; },
    tick(delayMs: number) {
      const poll = polls.findLast((poll) => !poll.cancelled && poll.delayMs === delayMs);
      if (!poll) throw new Error('Missing synthetic lease poll');
      poll.cancelled = true; poll.callback();
    },
    exchange() { controller.receive(requests.at(-1)!); node.receive(replies.at(-1)!); },
    async close() { node.close(); controller.close(); await supervisor.shutdown(); },
  };
}

test('lease codecs contain only exact session-qualified challenge and renewal fields', () => {
  const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
  const frame = { type: 'node-lease-challenge', version: 1, session, challengeId: 'synthetic-challenge' } as const;
  for (const type of ['node-lease-challenge', 'node-lease-renewal'] as const) {
    expect(parseNodeLeaseFrameText(serializeNodeLeaseFrame({ ...frame, type }))).toEqual({ ...frame, type });
  }
  for (const invalid of [{ ...frame, extra: true }, { ...frame, version: 2 }, { ...frame, challengeId: '' },
    { ...frame, challengeId: 'bad/identity' }, { ...frame, session: { ...session, extra: true } }, { ...frame, type: 'node-output' }]) {
    expect(parseNodeLeaseFrameText(JSON.stringify(invalid))).toBeNull();
  }
  expect(parseNodeLeaseFrameText(' '.repeat(MAX_NODE_LEASE_FRAME_BYTES + 1))).toBeNull();
});

test('only a current challenge renewal extends the supervised session while physical traffic stays body-free', async () => {
  const f = fixture();
  try {
    expect(f.requests).toHaveLength(1);
    f.advance(4000); f.exchange();
    expect(f.replies).toHaveLength(1);
    expect(parseNodeLeaseFrameText(f.replies[0]!)?.type).toBe('node-lease-renewal');
    f.advance(NODE_CONTROLLER_LEASE_MS - 1); f.tick(100);
    expect(f.connection.authoritySignal.aborted).toBe(false);
    f.advance(1); f.tick(100);
    expect(f.connection.authoritySignal.aborted).toBe(true);
    await f.supervisor.retryCleanup();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.polls.every((poll) => poll.cancelled)).toBe(true);
  } finally { await f.close(); }
});

test('a disconnected session expires through its logical monitor with no more socket events', async () => {
  const f = fixture();
  try {
    f.node.close();
    expect(f.connection.signal.aborted).toBe(true);
    expect(f.connection.authoritySignal.aborted).toBe(false);
    expect(f.disconnected).toHaveBeenCalledTimes(1);
    f.advance(NODE_CONTROLLER_LEASE_MS); f.tick(100);
    expect(f.connection.authoritySignal.aborted).toBe(true);
    await f.supervisor.retryCleanup();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.nodeClose).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test.each(['expired', 'foreign session', 'malformed', 'clock discontinuity'] as const)(
  '%s renewal cannot restore or extend execution authority', async (cause) => {
    const f = fixture();
    try {
      const challenge = parseNodeLeaseFrameText(f.requests[0]!)!;
      if (cause === 'expired') f.advance(NODE_CONTROLLER_LEASE_MS);
      if (cause === 'clock discontinuity') f.suspend();
      f.node.receive(cause === 'malformed' ? '{}' : serializeNodeLeaseFrame({ ...challenge, type: 'node-lease-renewal',
        challengeId: challenge.challengeId,
        session: cause === 'foreign session' ? { ...f.session, logicalSessionId: 'synthetic-foreign' } : f.session }));
      expect(f.connection.signal.aborted).toBe(true);
      expect(f.nodeClose).toHaveBeenCalledTimes(1);
      if (cause !== 'expired' && cause !== 'clock discontinuity') { f.advance(NODE_CONTROLLER_LEASE_MS); f.tick(100); }
      expect(f.connection.authoritySignal.aborted).toBe(true);
    } finally { await f.close(); }
  },
);

test('a six-second challenge round trip keeps progressing across five-second issuance', async () => {
  const f = fixture();
  try {
    f.advance(5000); f.tick(5000);
    for (let index = 0; index < 5; index++) {
      f.advance(1000);
      f.controller.receive(f.requests[index]!);
      f.node.receive(f.replies.at(-1)!);
      expect(f.connection.signal.aborted).toBe(false);
      f.advance(4000); f.tick(5000);
    }
    expect(f.nodeClose).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(() => f.supervisor.assertAdmission(f.connection)).not.toThrow();
  } finally { await f.close(); }
});

test.each(['unknown', 'consumed', 'expired'] as const)('%s challenge replies stay inert without closing a healthy socket or extending its lease', async cause => {
  const f = fixture();
  try {
    const first = parseNodeLeaseFrameText(f.requests[0]!)!;
    f.advance(5000); f.tick(5000); f.exchange();
    f.advance(5000); f.tick(5000); f.exchange();
    f.advance(5000);
    const stale = cause === 'consumed' ? parseNodeLeaseFrameText(f.replies.at(-1)!)! : first;
    f.node.receive(serializeNodeLeaseFrame({ ...stale, type: 'node-lease-renewal',
      challengeId: cause === 'unknown' ? 'synthetic-unknown' : stale.challengeId }));
    expect(f.connection.signal.aborted).toBe(false);
    expect(f.nodeClose).not.toHaveBeenCalled();
    f.advance(10_000); f.tick(100);
    expect(f.connection.authoritySignal.aborted).toBe(true);
    expect(f.nodeClose).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('a replaced physical socket cannot answer or renew on its successor', async () => {
  const f = fixture();
  try {
    const old = parseNodeLeaseFrameText(f.requests[0]!)!;
    const replacement = f.supervisor.attach(f.session);
    expect(f.nodeClose).toHaveBeenCalledTimes(1);
    f.node.receive(serializeNodeLeaseFrame({ ...old, type: 'node-lease-renewal' }));
    expect(replacement.signal.aborted).toBe(false);
    expect(f.supervisor.status).toBe('recovering');
    expect(f.disconnected).toHaveBeenCalledTimes(1);
    f.physical.abort(); f.controller.receive(f.requests[0]!);
    expect(f.replies).toHaveLength(0);
    expect(f.controllerClose).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('reentrant controller invalidation sends no renewal', async () => {
  const f = fixture();
  try {
    f.validate.mockImplementation(() => f.physical.abort());
    f.controller.receive(f.requests[0]!);
    expect(f.replies).toHaveLength(0);
    expect(f.controllerClose).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('a refused heartbeat closes its physical connection without extending the logical lease', async () => {
  const f = fixture();
  try {
    const connection = f.supervisor.attach(f.session);
    const close = mock(() => {});
    new NodeLeaseHeartbeat({ send: () => false, close }, { connection, supervisor: f.supervisor, disconnected() {} });
    expect(close).toHaveBeenCalledTimes(1);
    expect(connection.signal.aborted).toBe(true);
    expect(connection.authoritySignal.aborted).toBe(false);
    f.advance(NODE_CONTROLLER_LEASE_MS); f.tick(100);
    expect(connection.authoritySignal.aborted).toBe(true);
  } finally { await f.close(); }
});

test('closing a session lease monitor cancels polling without mutating the supervised authority', () => {
  const authority = new AbortController(); const poll = mock(() => 0); const cancel = mock(() => {});
  const monitor = new NodeSessionLeaseMonitor({ authoritySignal: authority.signal, supervisor: { poll },
    schedulePoll: () => ({ cancel }), failed() {} });
  expect(poll).toHaveBeenCalledTimes(1);
  monitor.close(); monitor.close();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(authority.signal.aborted).toBe(false);
});
