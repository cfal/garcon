import { expect, test } from 'bun:test';
import { connectNoiseWebSocket } from '@cfal/noise-ws';
import { WebSocketLink, EXECUTION_NODE_NOISE_CONTEXT } from '../websocket-link.ts';
import { outgoingFault } from './integration-fixture.ts';

const secret = Buffer.alloc(32, 42).toString('base64url');

for (const dialer of ['controller', 'worker']) {
  test(`authenticated WebSocket replay with ${dialer} dialing`, async () => {
    const common = { nodeId: 'synthetic-node', secret, allowInsecureDevelopment: true, reconnectDelayMs: 20 };
    const controller = new WebSocketLink({ ...common, role: 'controller' });
    const worker = new WebSocketLink({ ...common, role: 'worker' });
    const events = [];
    const first = Promise.withResolvers();
    const last = Promise.withResolvers();
    controller.onSession((session) => session.onMessage((value) => {
      events.push(value);
      if (value === 'first') first.resolve();
      if (value === 'last') last.resolve();
    }));
    const listening = dialer === 'controller' ? worker : controller;
    const dialing = dialer === 'controller' ? controller : worker;
    try {
      dialing.dial(listening.listen());
      const [controllerSession, workerSession] = await Promise.all([controller.ready, worker.ready]);
      workerSession.send('first');
      await first.promise;
      controller.disconnect(); worker.disconnect();
      workerSession.send('retained'); workerSession.send('last');
      await last.promise;
      expect(events).toEqual(['first', 'retained', 'last']);
      expect(controller.current).toBe(controllerSession);
      expect(worker.current).toBe(workerSession);
      expect(controllerSession.peerRuntimeId).toBe(worker.runtimeId);
    } finally {
      await controller.dispose(); await worker.dispose();
    }
  }, 10_000);
}

for (const role of ['controller', 'worker']) {
  for (const attack of ['reflected proof', 'wrong secret']) {
    test(`rejects ${attack} when authenticating a ${role} peer`, async () => {
      const link = new WebSocketLink({
        role, nodeId: 'synthetic-node', secret,
        allowInsecureDevelopment: true,
      });
      let accepted = 0;
      link.onSession(() => { accepted++; });
      const socket = connectNoiseWebSocket(link.listen(), {
        psk: Buffer.from(secret, 'base64url'), context: EXECUTION_NODE_NOISE_CONTEXT,
        onMessage: (socket, data) => {
        const frame = JSON.parse(data);
        if (frame.type === 'hello') {
          const peer = {
            ...frame, role: role === 'controller' ? 'worker' : 'controller',
            runtimeId: crypto.randomUUID(), nonce: crypto.randomUUID(),
          };
          if (peer.role === 'controller') peer.nodeId = 'synthetic-node';
          else delete peer.nodeId;
          socket.send(JSON.stringify(peer));
        } else if (frame.type === 'proof') {
          socket.send(JSON.stringify({ ...frame, signature: attack === 'reflected proof' ? frame.signature : '0'.repeat(64) }));
        } else {
          socket.close();
        }
        },
      });
      try {
        await socket.closed;
        expect(accepted).toBe(0);
      } finally { socket.close(); await link.dispose(); }
    });
  }
}

test('both endpoints replay retained messages before new replies', async () => {
  const common = { nodeId: 'synthetic-node', secret, allowInsecureDevelopment: true, reconnectDelayMs: 20 };
  const controller = new WebSocketLink({ ...common, role: 'controller' });
  const worker = new WebSocketLink({ ...common, role: 'worker' });
  const fault = outgoingFault(worker);
  const events = [];
  const complete = Promise.withResolvers();
  controller.onSession((session) => session.onMessage((value) => {
    events.push(value);
    if (events.filter((entry) => entry === 'reply').length === 2) complete.resolve();
  }));
  worker.onSession((session) => session.onMessage(() => session.send('reply')));
  try {
    controller.dial(worker.listen());
    const [left, right] = await Promise.all([controller.ready, worker.ready]);
    let drop = true;
    fault.inject = (encoded) => {
      if (drop && JSON.parse(encoded).kind === 'message') { drop = false; return 'drop'; }
      return null;
    };
    right.send('retained');
    controller.disconnect(); worker.disconnect();
    left.send('request');
    left.onAvailability((ready) => { if (ready) left.send('another request'); });
    await complete.promise;
    expect(events).toEqual(['retained', 'reply', 'reply']);
  } finally { await controller.dispose(); await worker.dispose(); }
});
