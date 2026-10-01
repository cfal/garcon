import { expect, test } from 'bun:test';
import { ExecutorRpc, ParkedRpcCalls } from '../rpc.js';
import { SessionTransport } from '../session-transport.js';

interface SentFrame {
  readonly type: string;
  readonly id: string;
  readonly method?: string;
}

function session(id: string, parked: ParkedRpcCalls) {
  const sent: SentFrame[] = [];
  const transport = new SessionTransport(id, 'worker', () => {});
  const connection = transport.attach({ send: (payload) => { sent.push(JSON.parse(payload)); }, close() {} });
  return {
    rpc: new ExecutorRpc(transport, { parked }),
    sent,
    transport,
    receive: (frame: object) => connection.receive(JSON.stringify(frame)),
  };
}

// Loses the first session with one journaled call outstanding and starts
// reconciling it on a replacement session of the same worker.
function lostCall(dispatchDeadline: number) {
  const parked = new ParkedRpcCalls();
  const lost = session('lost', parked);
  const replacement = session('replacement', parked);
  const settled = lost.rpc.call('', 'projects.inspect', { projectPath: '/test-project' }, { timeoutMs: 10_000, dispatchDeadline })
    .catch((error: unknown) => error);
  const callId = lost.sent[0]!.id;
  lost.transport.close();
  const reconciling = replacement.rpc.reconcileParked().catch((error: unknown) => error);
  return {
    parked, replacement, settled, callId, reconciling,
    reconciled(state: string) {
      replacement.receive({ type: 'result', id: replacement.sent[0]!.id, value: { states: [{ id: callId, state }] } });
    },
    dispose() {
      replacement.transport.close();
      parked.close();
    },
  };
}

// Holds the event loop until the deadline has passed, so its expiry cannot run first.
function passWithoutYielding(deadline: number): void {
  while (performance.now() < deadline + 10) { /* holds the loop */ }
}

test('a call the worker still runs when it is reconciled after its dispatch deadline stops waiting', async () => {
  const dispatchDeadline = performance.now() + 50;
  const call = lostCall(dispatchDeadline);
  try {
    passWithoutYielding(dispatchDeadline);
    call.reconciled('pending');
    await call.reconciling;

    expect(await call.settled).toMatchObject({
      outcome: 'unknown', message: 'The executor did not reconnect in time, so the outcome is unknown.',
    });
    expect(call.replacement.sent.filter(({ type }) => type === 'cancel').map(({ id }) => id)).toEqual([call.callId]);
  } finally { call.dispose(); }
});

test('a call the worker never received is not sent when it is reconciled after its dispatch deadline', async () => {
  const dispatchDeadline = performance.now() + 50;
  const call = lostCall(dispatchDeadline);
  try {
    passWithoutYielding(dispatchDeadline);
    call.reconciled('not-received');
    await call.reconciling;

    expect(await call.settled).toMatchObject({ outcome: 'not-dispatched', message: 'The executor did not reconnect in time.' });
    expect(call.replacement.sent.filter(({ method }) => method === 'projects.inspect')).toHaveLength(0);
  } finally { call.dispose(); }
});

test('a call reconciled as running before its dispatch deadline waits for its reply within its own deadline', async () => {
  const call = lostCall(performance.now() + 30);
  try {
    call.reconciled('pending');
    await call.reconciling;
    await Bun.sleep(60);
    const resolution = { kind: 'synthetic-resolution' };
    call.replacement.receive({ type: 'result', id: call.callId, value: { resolution } });

    expect(await call.settled).toEqual({ resolution });
  } finally { call.dispose(); }
});

test('a call keeps its dispatch deadline when the replacement session is lost while reconciling it', async () => {
  const call = lostCall(performance.now() + 20);
  try {
    call.replacement.transport.close();
    expect(call.parked.size).toBe(1);

    expect(await call.settled).toMatchObject({
      outcome: 'unknown', message: 'The executor did not reconnect in time, so the outcome is unknown.',
    });
    expect(call.parked.size).toBe(0);
  } finally { call.dispose(); }
});
