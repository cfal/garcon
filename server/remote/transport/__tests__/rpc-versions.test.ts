import { expect, mock, test } from 'bun:test';
import { AgentIntegrationError, type AgentIntegrationErrorCode } from '@garcon/server-agent-interface';
import { RPC_V1, type RpcContractDefinition } from '@garcon/common/executor-contracts';
import { isRecord } from '@garcon/common/json';
import { ExecutorRpc, ParkedRpcCalls, TRANSPORT_RPC_CLIENTS, TRANSPORT_RPC_HANDLERS } from '../rpc.js';
import { RpcReplyJournal } from '../rpc-journal.js';
import { createRoleContracts, registerRpcHandlers, type RpcWire } from '../rpc-registrations.js';
import type { RequestFor } from '../rpc-protocol.js';
import type { RemoteSessions } from '../../client/executor-client.js';
import { decodeFailure, type Failure } from '../rpc-failure.js';
import { protocolProfileId } from '../protocol-compatibility.js';
import { rpcPolicyV1 } from '../rpc-routing.js';
import { SessionTransport } from '../session-transport.js';
import type { RpcLane } from '../rpc-lane.js';

declare module '../rpc-protocol.js' {
  interface ExecutorRpcVersions {
    'test.versioned': {
      readonly 1: { readonly request: { text: string }; readonly result: { text: string } };
      readonly 2: { readonly request: { count: number }; readonly result: { count: number } };
    };
  }
}

const first = Object.freeze({ name: 'test.versioned', version: 1, lane: 'primary', continuity: 'journaled',
  direction: 'controller-to-worker', requires: [RPC_V1['calls.reconcile']] } as const satisfies RpcContractDefinition);
const second = Object.freeze({ ...first, version: 2 } as const);

function textValue(value: unknown): { text: string } {
  if (!isRecord(value) || typeof value.text !== 'string') throw new SyntaxError('Invalid synthetic v1 data');
  return { text: value.text };
}

function countValue(value: unknown): { count: number } {
  if (!isRecord(value) || !Number.isSafeInteger(value.count)) throw new SyntaxError('Invalid synthetic v2 data');
  return { count: Number(value.count) };
}

const futureCode = 'SYNTHETIC_V2_FAILURE' as AgentIntegrationErrorCode;
function failureV2(failure: Failure): Error {
  if (failure.code === futureCode && failure.domain === undefined && typeof failure.message === 'string' && failure.retryable === false) {
    return new AgentIntegrationError(futureCode, failure.message, false);
  }
  return decodeFailure(failure);
}

const wire1: RpcWire<typeof first> = Object.freeze({ definition: first, request: textValue, result: textValue,
  failure: decodeFailure, policy: (request: unknown, lane: RpcLane) => rpcPolicyV1(first, request, lane) });
const wire2: RpcWire<typeof second> = Object.freeze({ definition: second, request: countValue, result: countValue,
  failure: failureV2, policy: (request: unknown, lane: RpcLane) => rpcPolicyV1(second, request, lane) });
type SyntheticCall = RequestFor<typeof first | typeof second>;
type Dispatch = (call: SyntheticCall) => Promise<unknown>;

function fixture() {
  const journal = new RpcReplyJournal();
  const parked = new ParkedRpcCalls();
  const connections: { close(): void }[] = [];
  const dispatch = mock(async (call: SyntheticCall): Promise<unknown> => call.request);

  function connect(clientWire = wire2, workerWire = wire2) {
    const handlers = registerRpcHandlers([wire1, workerWire], (invoke: Dispatch, call) => invoke(call));
    const controller = createRoleContracts('controller', { clients: [...TRANSPORT_RPC_CLIENTS, wire1, clientWire],
      handlers: [TRANSPORT_RPC_HANDLERS], resources: [], cli: [] });
    const worker = createRoleContracts('worker', { clients: TRANSPORT_RPC_CLIENTS,
      handlers: [TRANSPORT_RPC_HANDLERS, handlers], resources: [], cli: [] });
    const profile = controller.offer;
    const continuity = { executorId: 'local', controllerRuntimeId: 'synthetic-controller', workerRuntimeId: 'synthetic-worker',
      profileId: protocolProfileId(profile) };
    const id = crypto.randomUUID();
    const left = new SessionTransport(id, 'synthetic-worker', { profile, continuity, contracts: controller }, () => {});
    const right = new SessionTransport(id, 'synthetic-controller', { profile, continuity, contracts: worker }, () => {});
    const sent: string[] = [];
    const replies: string[] = [];
    const gates = { requests: true, replies: true };
    let rewrite: ((payload: string) => string) | undefined;
    let onReply: ((payload: string) => void) | undefined;
    const leftSocket = left.attach({ send(payload) {
      sent.push(payload);
      if (gates.requests) queueMicrotask(() => rightSocket.receive(payload));
    }, close() {} });
    const rightSocket = right.attach({ send(payload) {
      replies.push(payload);
      if (gates.replies) {
        const encoded = rewrite?.(payload) ?? payload;
        queueMicrotask(() => leftSocket.receive(encoded));
      }
      onReply?.(payload);
    }, close() {} });
    const client = new ExecutorRpc(left, { parked });
    const service = new ExecutorRpc(right, { journal });
    service.handle(handlers.bind(dispatch));
    const connected = { client, service, left, right, sent, replies, gates,
      receive: leftSocket.receive,
      observeReply(fn: (payload: string) => void) { onReply = fn; },
      rewrite(fn: (payload: string) => string) { rewrite = fn; },
      close() { left.close(); right.close(); } };
    connections.push(connected);
    return connected;
  }

  return { connect, journal, parked, dispatch,
    close() { for (const connection of connections) connection.close(); parked.close(); journal.dispose(); } };
}

test('one session dispatches both versions with their exact payload and failure codecs', async () => {
  const harness = fixture();
  const link = harness.connect();
  try {
    const one = link.client.call('', first, { text: 'synthetic' });
    const two = link.client.call('', second, { count: 42 });
    expect(await one).toEqual({ text: 'synthetic' });
    expect(await two).toEqual({ count: 42 });
    expect(harness.dispatch.mock.calls.map(([call]) => call.version)).toEqual([1, 2]);
    harness.dispatch.mockImplementation(async () => { throw new AgentIntegrationError(futureCode, 'Synthetic failure', false); });
    await expect(link.client.call('', second, { count: 1 })).rejects.toMatchObject({ code: futureCode });
    await expect(link.client.call('', first, { text: 'failure' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(link.left.connected && link.right.connected).toBe(true);
  } finally { harness.close(); }
});

test('cancelled calls retain versioned late-result and late-error decoders without a cleanup callback', async () => {
  const harness = fixture();
  const link = harness.connect();
  link.gates.requests = false;
  const cleaned: number[] = [];
  try {
    for (const cleanup of [true, false]) {
      const abort = new AbortController();
      const pending = link.client.call('', second, { count: 7 }, { signal: abort.signal,
        ...(cleanup ? { onLateResult: (value: { count: number }) => { cleaned.push(value.count); } } : {}) });
      const { id } = JSON.parse(link.sent.at(-1)!);
      abort.abort();
      await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
      link.receive(JSON.stringify(cleanup ? { type: 'result', id, value: { count: 7 } }
        : { type: 'error', id, error: { code: futureCode, message: 'Synthetic late failure', retryable: false } }));
      await Promise.resolve();
      expect(link.left.connected).toBe(true);
    }
    expect(cleaned).toEqual([7]);
  } finally { harness.close(); }
});

test('journal completion and replay keep the originating codecs and exact bytes', async () => {
  const harness = fixture();
  const original = harness.connect();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<{ count: number }>();
  harness.dispatch.mockImplementation(async () => { entered.resolve(); return release.promise; });
  try {
    const pending = original.client.call('', second, { count: 23 });
    await entered.promise;
    original.close();
    const poisoned: RpcWire<typeof second> = { ...wire2, result: () => { throw new Error('Replacement codec must not run'); } };
    const replacement = harness.connect(poisoned, poisoned);
    await replacement.client.reconcileParked();
    replacement.gates.replies = false;
    const encoded = Promise.withResolvers<string>();
    replacement.observeReply(payload => encoded.resolve(payload));
    release.resolve({ count: 23 });
    const retained = await encoded.promise;
    expect(JSON.parse(retained).value).toEqual({ count: 23 });
    replacement.close();
    const resumed = harness.connect(poisoned, poisoned);
    await resumed.client.reconcileParked();
    expect(await pending).toEqual({ count: 23 });
    expect(resumed.replies).toContain(retained);
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  } finally { release.resolve({ count: 23 }); harness.close(); }
});

test('proven nonreceipt resends the captured request snapshot and decoder', async () => {
  const harness = fixture();
  const original = harness.connect();
  try {
    await original.client.reconcileParked();
    original.gates.requests = false;
    const input = { count: 17 };
    const pending = original.client.call('', second, input);
    input.count = 900;
    original.close();
    const replacement = harness.connect({ ...wire2, result: () => { throw new Error('Replacement codec must not run'); } });
    await replacement.client.reconcileParked();
    expect(await pending).toEqual({ count: 17 });
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.dispatch.mock.calls[0]![0]).toMatchObject({ version: 2, request: { count: 17 } });
  } finally { harness.close(); }
});

test.each(['duplicate', 'unexpected', 'missing'] as const)('rejects %s reconciliation IDs before permitting a resend', async kind => {
  const harness = fixture();
  const original = harness.connect();
  try {
    await original.client.reconcileParked();
    original.gates.requests = false;
    const pending = original.client.call('', second, { count: 17 }).catch(error => error);
    original.close();
    const replacement = harness.connect();
    replacement.rewrite(payload => {
      const frame = JSON.parse(payload);
      if (frame.value?.states) {
        const states = frame.value.states;
        if (kind === 'duplicate') states.push({ ...states[0], state: 'pending' });
        else if (kind === 'unexpected') states[0].id = 'not-requested';
        else states.pop();
      }
      return JSON.stringify(frame);
    });
    await expect(replacement.client.reconcileParked()).rejects.toThrow('Invalid call reconciliation reply');
    expect(harness.dispatch).not.toHaveBeenCalled();
    harness.close();
    expect(await pending).toMatchObject({ outcome: 'unknown' });
  } finally { harness.close(); }
});

// These assertions are compiled separately; malformed calls never run.
function versionedTypes(rpc: ExecutorRpc, sessions: RemoteSessions): void {
  rpc.call('', first, { text: 'one' }) satisfies Promise<{ text: string }>;
  rpc.call('', second, { count: 2 }) satisfies Promise<{ count: number }>;
  sessions.call('', second, { count: 2 }) satisfies Promise<{ count: number }>;
  // @ts-expect-error A v1 payload is not a v2 request.
  rpc.call('', second, { text: 'wrong version' });
  // @ts-expect-error Session acquisition preserves exact version typing.
  sessions.call('', first, { count: 1 });
  // @ts-expect-error No v3 implementation is declared.
  rpc.call('', { ...second, version: 3 }, { count: 3 });
  // @ts-expect-error The selected codec fixes the late cleanup payload.
  rpc.call('', second, { count: 2 }, { onLateResult: (value: { text: string }) => { void value; } });
}
void versionedTypes;
