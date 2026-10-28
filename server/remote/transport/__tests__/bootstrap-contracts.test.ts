import { TestWebSocketLink as WebSocketLink, handleTestRpc } from '../../__tests__/test-session-transport.js';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import { expect, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { connectNoiseWebSocket } from '@cfal/noise-ws';
import { AgentCallError } from '@garcon/server-agent-interface';
import { isLinkHello, isLinkProof, proofPayload } from '../link-handshake.js';
import { isProtocolOffer } from '@garcon/common/protocol-contracts';
import { ExecutorRpc } from '../rpc.js';
import { SESSION_MESSAGE_BYTES, SessionSocketFrames } from '../session-socket.js';
import { TestSessionTransport, WorkerSessionTransport } from '../../__tests__/test-session-transport.js';
import { EXECUTOR_NOISE_CONTEXT } from '../websocket-link.js';
import { primaryHello, signedProof, selectedDecision } from '../../__tests__/link-hello.js';

// These bytes are independent of the current serializers and fixture generator.
const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const hellos = {
  primary: {
    controller: '{"type":"hello","build":"1.0.0","protocol":{"bootstrap":1,"contracts":{}},"role":"controller","executorId":"fixture-executor","runtimeId":"fixture-controller","nonce":"0000000000000000000000000000000000000000000000000000000000000000","lane":"primary","sessionId":"11111111-1111-4111-8111-111111111111","primarySessionId":null,"primaryProfileId":null}',
    worker: '{ "role":"worker","type":"hello","build":"2.0.0","protocol":{"contracts":{},"bootstrap":1},"executorId":null,"runtimeId":"fixture-worker","nonce":"1111111111111111111111111111111111111111111111111111111111111111","lane":"primary","sessionId":null,"primarySessionId":null,"primaryProfileId":null }',
  },
  bulk: {
    controller: '{"type":"hello","build":"1.0.0","protocol":null,"role":"controller","executorId":"fixture-executor","runtimeId":"fixture-controller","nonce":"2222222222222222222222222222222222222222222222222222222222222222","lane":"bulk","sessionId":"22222222-2222-4222-8222-222222222222","primarySessionId":"11111111-1111-4111-8111-111111111111","primaryProfileId":"1788f993b4772e3516f5409992386cee14668f98ca23773646f1670a8ffaf8d9"}',
    worker: '{ "role":"worker","type":"hello","build":"2.0.0","protocol":null,"executorId":"fixture-executor","runtimeId":"fixture-worker","nonce":"3333333333333333333333333333333333333333333333333333333333333333","lane":"bulk","sessionId":"22222222-2222-4222-8222-222222222222","primarySessionId":"11111111-1111-4111-8111-111111111111","primaryProfileId":"1788f993b4772e3516f5409992386cee14668f98ca23773646f1670a8ffaf8d9" }',
  },
};
const proofs = [
  ['primary', 'controller', '{"type":"proof","decision":{"ok":true,"profileId":"1788f993b4772e3516f5409992386cee14668f98ca23773646f1670a8ffaf8d9"},"signature":"43c4cfec62640123ffd9c8cd8937e6cf6bd104f9a1d6845e5e9fd2716c2af743"}'],
  ['primary', 'controller', '{"type":"proof","decision":{"ok":false,"code":"BOOTSTRAP_MISMATCH"},"signature":"076014610e9aae79b1a89af4d8079e083be27ad6063d49a83ab8edc51fca9c7a"}'],
  ['primary', 'worker', '{"type":"proof","decision":{"ok":true,"profileId":"1788f993b4772e3516f5409992386cee14668f98ca23773646f1670a8ffaf8d9"},"signature":"ded56edb9aba68fa53bd77cae6f401d4090fda3298c1337f00789e06d2b35cb3"}'],
  ['primary', 'worker', '{"type":"proof","decision":{"ok":false,"code":"BOOTSTRAP_MISMATCH"},"signature":"bc76c60495edf206930ef17bf665a5ec8be5849209939c5e0ef5f44661727a4c"}'],
  ['bulk', 'controller', '{"type":"proof","decision":{"ok":true,"profileId":"1788f993b4772e3516f5409992386cee14668f98ca23773646f1670a8ffaf8d9"},"signature":"5b5b017480295e90534a362f0a4cbcac0356accd7e58a3a196894f600d90f412"}'],
  ['bulk', 'controller', '{"type":"proof","decision":{"ok":false,"code":"BULK_PROFILE_MISMATCH"},"signature":"4c90b4f5e32c4d9e3a00b7332ba07cfe3cdd995e9a40efd5a3d81ba29f391e95"}'],
  ['bulk', 'worker', '{"type":"proof","decision":{"ok":true,"profileId":"1788f993b4772e3516f5409992386cee14668f98ca23773646f1670a8ffaf8d9"},"signature":"fb3883e05b7fa30493d01edc137b2756bb17594b4edd0a1193c21725345c408f"}'],
  ['bulk', 'worker', '{"type":"proof","decision":{"ok":false,"code":"BULK_PROFILE_MISMATCH"},"signature":"9d86036e331e97552c8af9063c84a89efd6884350cb42bdf8a5ac6d1b6905f40"}'],
] as const;

test('bootstrap hello envelopes retain all eleven exact keys on both lanes', () => {
  for (const pair of Object.values(hellos)) for (const encoded of Object.values(pair)) {
    const hello = JSON.parse(encoded);
    expect(isLinkHello(hello)).toBe(true);
    expect(isLinkHello({ ...hello, extra: true })).toBe(false);
    for (const key of Object.keys(hello)) {
      const incomplete = { ...hello };
      delete incomplete[key];
      expect(isLinkHello(incomplete)).toBe(false);
    }
  }
});

test.each(proofs)('bootstrap %s %s proof retains its literal signature: %s', (lane, role, encoded) => {
  const proof: unknown = JSON.parse(encoded);
  expect(isLinkProof(proof)).toBe(true);
  if (!isLinkProof(proof)) throw new Error('Invalid frozen proof');
  const pair = hellos[lane];
  const signature = createHmac('sha256', secret)
    .update(proofPayload(role, pair.controller, pair.worker, proof.decision)).digest('hex');
  expect(signature).toBe(proof.signature);
  expect(JSON.stringify({ type: 'proof', decision: proof.decision, signature })).toBe(encoded);
  expect(isLinkProof({ ...proof, extra: true })).toBe(false);
  for (const key of Object.keys(proof)) {
    const incomplete: Record<string, unknown> = { ...proof };
    delete incomplete[key];
    expect(isLinkProof(incomplete)).toBe(false);
  }
});

test('bootstrap offers accept the frozen maximums, not just small examples', () => {
  const contracts = Object.fromEntries(Array.from({ length: 512 }, (_, index) =>
    [`c${String(index).padStart(63, '0')}`, [1, 2, 3, 65535]]));
  expect(isProtocolOffer({ bootstrap: 65535, contracts })).toBe(true);
  expect(isProtocolOffer({ bootstrap: 65536, contracts })).toBe(false);
  expect(isProtocolOffer({ bootstrap: 1, contracts: { ...contracts, overflow: [1] } })).toBe(false);
  expect(isProtocolOffer({ bootstrap: 1, contracts: { ['c'.repeat(65)]: [1] } })).toBe(false);
  expect(isProtocolOffer({ bootstrap: 1, contracts: { feature: [1, 2, 3, 4, 5] } })).toBe(false);
});

const callId = '44444444-4444-4444-8444-444444444444';
const request = '{"type":"request","id":"44444444-4444-4444-8444-444444444444","seq":1,"integrationId":"fixture-agent","method":"execution.runningSessions","version":1,"request":null}';
const result = '{"type":"result","id":"44444444-4444-4444-8444-444444444444","value":[]}';
const failure = '{"type":"error","id":"44444444-4444-4444-8444-444444444444","error":{"code":"OPERATION_UNSUPPORTED","message":"Fixture refusal","retryable":false,"outcome":"not-dispatched"}}';
const cancel = '{"type":"cancel","id":"44444444-4444-4444-8444-444444444444"}';

function rpcFixture(role: 'controller' | 'worker' = 'controller') {
  const frames: string[] = [];
  const sent = Promise.withResolvers<string>();
  const transport = new (role === 'controller' ? TestSessionTransport : WorkerSessionTransport)('fixture-session', 'fixture-worker', () => {});
  const socket = transport.attach({ send(encoded) { frames.push(encoded); sent.resolve(encoded); }, close() {} });
  return { transport, socket, rpc: new ExecutorRpc(transport), frames, sent: sent.promise };
}

test.each([result, failure])('bootstrap RPC sends a literal request and accepts a literal reply: %s', async reply => {
  const fixture = rpcFixture();
  const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(callId);
  try {
    const pending = fixture.rpc.call('fixture-agent', RPC_V1['execution.runningSessions'], null);
    uuid.mockRestore();
    expect(fixture.frames).toEqual([request]);
    fixture.socket.receive(reply);
    if (reply === result) await expect(pending).resolves.toEqual([]);
    else await expect(pending).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', outcome: 'not-dispatched' });
  } finally { uuid.mockRestore(); fixture.transport.close(); }
});

test.each([result, failure])('bootstrap RPC accepts a literal request and sends a literal reply: %s', async reply => {
  const fixture = rpcFixture('worker');
  handleTestRpc(fixture.rpc, async frame => {
    expect(frame).toEqual(JSON.parse(request));
    if (reply === failure) throw new AgentCallError('not-dispatched', 'Fixture refusal', 'OPERATION_UNSUPPORTED');
    return [];
  });
  try {
    fixture.socket.receive(request);
    expect(await fixture.sent).toBe(reply);
  } finally { fixture.transport.close(); }
});

test('bootstrap RPC cancellation keeps its literal envelope in both directions', async () => {
  const caller = rpcFixture();
  const callee = rpcFixture('worker');
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  handleTestRpc(callee.rpc, async (_frame, signal) => {
    signal.addEventListener('abort', () => released.resolve(), { once: true });
    entered.resolve();
    await released.promise;
    return [];
  });
  const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(callId);
  try {
    const abort = new AbortController();
    const pending = caller.rpc.call('fixture-agent', RPC_V1['execution.runningSessions'], null, { signal: abort.signal });
    uuid.mockRestore();
    expect(caller.frames).toEqual([request]);
    callee.socket.receive(request);
    await entered.promise;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    expect(caller.frames).toEqual([request, cancel]);
    callee.socket.receive(cancel);
    await released.promise;
  } finally { uuid.mockRestore(); released.resolve(); caller.transport.close(); callee.transport.close(); }
});

test('bootstrap terminal detach keeps its literal envelope in both directions', async () => {
  const fixture = rpcFixture();
  const detached = Promise.withResolvers<unknown>();
  const encoded = '{"type":"terminal-detach","request":{"type":"terminal-detach","terminalId":"fixture-terminal","attachmentId":"fixture-attachment","authority":{"key":"fixture-authority","expiresAtMs":null}}}';
  const request = { type: 'terminal-detach' as const, terminalId: 'fixture-terminal', attachmentId: 'fixture-attachment',
    authority: { key: 'fixture-authority', expiresAtMs: null } };
  fixture.rpc.onTerminalDetach(async value => { detached.resolve(value); });
  try {
    fixture.rpc.detachTerminal(RPC_V1['terminals.detach'], request);
    expect(fixture.frames).toEqual([encoded]);
    fixture.socket.receive(encoded);
    expect(await detached.promise).toEqual(request);
  } finally { fixture.transport.close(); }
});

test.each(['controller', 'worker'] as const)('bootstrap %s heartbeats retain literal ping and pong envelopes', async role => {
  const link = new WebSocketLink({ role, executorId: 'synthetic-executor', secret, noTls: true });
  const hello = primaryHello(role === 'controller' ? 'worker' : 'controller');
  const local = JSON.stringify(hello);
  const ping = Promise.withResolvers<string>();
  const pong = Promise.withResolvers<string>();
  const socket = connectNoiseWebSocket(link.listen(), {
    psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
    onOpen(socket) { socket.send(local); },
    onMessage(socket, data) {
      if (typeof data !== 'string') throw new Error('Expected a text heartbeat or handshake');
      const frame = JSON.parse(data);
      if (frame.type === 'hello') socket.send(JSON.stringify(signedProof(secret, hello.role, local, data,
        selectedDecision(hello.protocol!, frame.protocol))));
      else if (frame.type === 'ping') { ping.resolve(data); socket.send('{"type":"pong"}'); }
      else if (frame.type === 'pong') pong.resolve(data);
    },
  });
  try {
    const session = await link.ready;
    socket.send('{"type":"pong"}');
    socket.send('{"type":"ping"}');
    expect(await pong.promise).toBe('{"type":"pong"}');
    expect(await ping.promise).toBe('{"type":"ping"}');
    expect(session.connected).toBe(true);
  } finally { socket.close(); await link.dispose(); }
}, 10_000);

test('bootstrap session framing retains the 32768-byte fragment and 16777216-byte message limits', () => {
  const fragments: Uint8Array[] = [];
  const socket = new SessionSocketFrames({ bufferedAmount: 0, send(fragment) {
    if (typeof fragment === 'string') throw new Error('Expected a binary fragment');
    fragments.push(fragment);
  } }, () => {});
  try {
    expect(SESSION_MESSAGE_BYTES).toBe(16777216);
    const message = 'x'.repeat(32768) + 'end';
    const first = Buffer.concat([Buffer.from([0]), Buffer.alloc(32768, 'x')]);
    const last = Buffer.from([1, 101, 110, 100]);
    socket.send(message);
    expect(fragments).toEqual([first, last]);
    expect(socket.receive(first)).toBeNull();
    expect(socket.receive(last)).toBe(message);
    expect(() => socket.send('x'.repeat(16777217))).toThrow('Message exceeds frame budget');
    for (let index = 0; index < 512; index++) expect(socket.receive(first)).toBeNull();
    expect(() => socket.receive(last)).toThrow('Invalid session message fragment');
  } finally { socket.dispose(); }
});
