import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { connectNoiseWebSocket } from '@cfal/noise-ws';
import { WebSocketLink, EXECUTOR_NOISE_CONTEXT } from '../websocket-link.js';
import { ExecutorSocketAdmission } from '../socket-admission.js';
import { isLinkHello, type LinkHello } from '../link-handshake.js';
import { primaryHello } from '../../__tests__/link-hello.js';

const secret = Buffer.alloc(32, 42).toString('base64url');

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Lane did not reach the expected condition');
    await Bun.sleep(2);
  }
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`bulk belongs to its authenticated primary and loss is role-local (${dialer} dials)`, async () => {
    const options = { executorId: 'synthetic-executor', secret, noTls: true, redialDelaysMs: [60_000] };
    const controller = new WebSocketLink({ ...options, role: 'controller' });
    const worker = new WebSocketLink({ ...options, role: 'worker' });
    try {
      if (dialer === 'controller') controller.dial(worker.listen());
      else worker.dial(controller.listen());
      const [parent, peer] = await Promise.all([controller.ready, worker.ready]);
      for (let attempt = 0; attempt < 2; attempt++) {
        const id = crypto.randomUUID();
        controller.prepareBulk(parent, id);
        worker.prepareBulk(peer, id);
        if (dialer === 'controller') controller.dialBulk(parent, id);
        else worker.dialBulk(peer, id);
        await until(() => Boolean(controller.bulk?.connected && worker.bulk?.connected));
        expect(controller.bulk?.id).toBe(id);
        expect(worker.bulk?.id).toBe(id);
        expect(controller.bulk?.primarySessionId).toBe(parent.id);
        expect(worker.bulk?.primarySessionId).toBe(parent.id);
        expect(controller.bulk?.peerRuntimeId).toBe(parent.peerRuntimeId);
        expect(worker.bulk?.peerRuntimeId).toBe(peer.peerRuntimeId);
        expect(controller.current).toBe(parent);
        expect(worker.current).toBe(peer);
        if (attempt === 0) {
          controller.bulk!.close();
          await until(() => worker.bulk === null);
          expect(parent.connected && peer.connected).toBe(true);
        }
      }
      parent.close();
      expect(controller.bulk).toBeNull();
      await until(() => worker.bulk === null && !peer.connected);
      expect(() => worker.dialBulk(peer, crypto.randomUUID())).toThrow();
    } finally { await controller.dispose(); await worker.dispose(); }
  });
}

function rawPeer(address: string, hello: LinkHello) {
  let peer: LinkHello;
  return connectNoiseWebSocket(address, {
    psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
    onOpen(socket) { socket.send(JSON.stringify(hello)); },
    onMessage(socket, data) {
      if (typeof data !== 'string') return;
      const frame = JSON.parse(data);
      if (isLinkHello(frame)) peer = frame;
      else if (frame.type === 'proof') {
        const transcript = hello.role === 'controller' ? [hello, peer] : [peer, hello];
        const signature = createHmac('sha256', secret).update(JSON.stringify(['garcon-executor', hello.role, transcript])).digest('hex');
        socket.send(JSON.stringify({ type: 'proof', signature }));
      }
    },
  });
}

test('bulk rejects stale grants, different peer runtimes, executor IDs and duplicate sockets without retiring primary', async () => {
  const controller = new WebSocketLink({ role: 'controller', executorId: 'synthetic-executor', secret, noTls: true });
  const worker = new WebSocketLink({ role: 'worker', secret, noTls: true, redialDelaysMs: [60_000] });
  const address = controller.listen();
  try {
    worker.dial(address);
    const [parent, peer] = await Promise.all([controller.ready, worker.ready]);
    const id = crypto.randomUUID();
    controller.prepareBulk(parent, id);
    worker.prepareBulk(peer, id);
    const valid: LinkHello = { ...primaryHello('worker'), lane: 'bulk', executorId: parent.executorId,
      runtimeId: worker.runtimeId, sessionId: id, primarySessionId: parent.id };
    for (const change of [
      { sessionId: crypto.randomUUID() }, { primarySessionId: crypto.randomUUID() },
      { runtimeId: crypto.randomUUID() }, { executorId: 'another-executor' }, { version: 'wrong-version' },
    ]) {
      await rawPeer(address, { ...valid, ...change }).closed;
      expect(controller.bulk).toBeNull();
      expect(parent.connected).toBe(true);
    }
    worker.dialBulk(peer, id);
    await until(() => Boolean(controller.bulk?.connected && worker.bulk?.connected));
    const bulk = controller.bulk;
    await rawPeer(address, valid).closed;
    expect(controller.bulk).toBe(bulk);
    expect(parent.connected && bulk!.connected).toBe(true);
    controller.prepareBulk(parent, crypto.randomUUID());
    await rawPeer(address, valid).closed;
    expect(parent.connected).toBe(true);
  } finally { await worker.dispose(); await controller.dispose(); }
});

test('socket roles have independent quotas and pending ownership is released exactly once', () => {
  const admission = new ExecutorSocketAdmission(1, 2);
  const primary = admission.acquire()!;
  const bulk = admission.acquire()!;
  expect(admission.acquire()).toBeNull();
  expect(primary.promote('primary')).toBe(true);
  expect(bulk.promote('bulk')).toBe(true);
  const spare = admission.acquire()!;
  expect(spare.promote('bulk')).toBe(false);
  primary.release();
  primary.release();
  expect(spare.promote('primary')).toBe(true);
  expect(primary.promote('bulk')).toBe(false);
  bulk.release();
  spare.release();
  expect(admission.acquire()?.promote('primary')).toBe(true);
  expect(admission.acquire()?.promote('bulk')).toBe(true);
});

test('hello shape is strict and session IDs are canonical', () => {
  const hello = primaryHello('controller');
  expect(isLinkHello(hello)).toBe(true);
  for (const change of [
    { sessionId: hello.sessionId!.toUpperCase() }, { primarySessionId: crypto.randomUUID() },
    { extra: true }, { lane: 'other' }, { nonce: crypto.randomUUID() }, { runtimeId: 'x'.repeat(129) },
  ]) expect(isLinkHello({ ...hello, ...change })).toBe(false);
});
