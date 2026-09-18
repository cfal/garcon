import { expect, test } from 'bun:test';
import { MessageSession, type MessageSessionOptions } from '../message-session.js';

function endpoint(options: Partial<MessageSessionOptions> = {}) {
  const output: string[] = [];
  const accepted: string[] = [];
  const failures: Error[] = [];
  const session = new MessageSession({ deliver: body => accepted.push(body), failed: error => failures.push(error), ...options });
  const socket = { send(encoded: string) { output.push(encoded); }, close() {} };
  return { session, socket, output, accepted, failures };
}

function network() {
  const controller = endpoint();
  const worker = endpoint();
  let controllerConnection: ReturnType<MessageSession['attach']>;
  let workerConnection: ReturnType<MessageSession['attach']>;
  const attach = () => {
    controller.output.length = 0;
    worker.output.length = 0;
    controllerConnection = controller.session.attach(controller.socket, worker.session.received);
    workerConnection = worker.session.attach(worker.socket, controller.session.received);
  };
  const exchange = () => {
    for (let limit = 0; limit < 2000; limit++) {
      const outgoing = controller.output.shift();
      const incoming = worker.output.shift();
      if (outgoing !== undefined) workerConnection.receive(outgoing);
      if (incoming !== undefined) controllerConnection.receive(incoming);
      if (outgoing === undefined && incoming === undefined) return;
    }
    throw new Error('Message exchange did not converge');
  };
  const disconnect = () => { controllerConnection.disconnected(); workerConnection.disconnected(); };
  attach(); exchange();
  return {
    controller, worker, attach, exchange, disconnect,
    get controllerConnection() { return controllerConnection; },
    get workerConnection() { return workerConnection; },
    close() { controller.session.close(); worker.session.close(); },
  };
}

test('receipts retire a prefix, never messages that were merely queued offline', () => {
  const peer = endpoint();
  try {
    const connection = peer.session.attach(peer.socket, 0);
    peer.session.send('one'); peer.session.send('two'); peer.session.send('three');
    connection.receive(JSON.stringify({ kind: 'receipt', through: 2 }));
    expect(peer.session.retainedFrames).toBe(1);
    connection.receive(JSON.stringify({ kind: 'receipt', through: 1 }));
    expect(peer.session.retainedFrames).toBe(1);
    connection.disconnected();
    peer.session.send('offline');
    expect(() => peer.session.attach(peer.socket, 4)).toThrow('cannot resume');
    expect(peer.failures).toHaveLength(1);
  } finally { peer.session.close(); }
});

test('a received mutation whose receipt was lost is dispatched once across reconnect', () => {
  const net = network();
  try {
    net.controller.session.send('mutation');
    const encoded = net.controller.output.shift()!;
    net.workerConnection.receive(encoded);
    net.workerConnection.receive(encoded);
    expect(net.worker.accepted).toEqual(['mutation']);
    expect(net.controller.session.retainedFrames).toBe(1);
    net.disconnect(); net.attach(); net.exchange();
    expect(net.worker.accepted).toEqual(['mutation']);
    expect(net.controller.session.retainedFrames).toBe(0);
    expect(net.controller.session.retainedBytes).toBe(0);
  } finally { net.close(); }
});

test('both directions preserve the sent prefix through repeated partial reconnects', () => {
  const net = network();
  const commands: string[] = [], events: string[] = [];
  try {
    for (let batch = 0; batch < 20; batch++) {
      net.disconnect();
      for (let item = 0; item < 3; item++) {
        const command = `command-${batch}-${item}`, event = `event-${batch}-${item}`;
        commands.push(command); events.push(event);
        net.controller.session.send(command); net.worker.session.send(event);
      }
      net.attach();
      net.workerConnection.receive(net.controller.output.shift()!);
      net.workerConnection.receive(net.controller.output.shift()!);
      net.disconnect(); net.attach(); net.exchange();
    }
    expect(net.worker.accepted).toEqual(commands);
    expect(net.controller.accepted).toEqual(events);
    expect(net.worker.failures).toEqual([]);
    expect(net.controller.failures).toEqual([]);
  } finally { net.close(); }
});

test('old socket callbacks cannot deliver or disconnect its replacement', () => {
  const net = network();
  try {
    const old = net.workerConnection;
    net.disconnect(); net.attach(); net.exchange();
    old.receive(JSON.stringify({ kind: 'message', ordinal: 1, body: 'stale' }));
    old.disconnected();
    expect(net.worker.session.connected).toBe(true);
    expect(net.worker.accepted).toEqual([]);
    net.controller.session.send('current'); net.exchange();
    expect(net.worker.accepted).toEqual(['current']);
  } finally { net.close(); }
});

test('missing data on an ordered connection terminates before a later terminal event', () => {
  const peer = endpoint();
  const connection = peer.session.attach(peer.socket, 0);
  connection.receive(JSON.stringify({ kind: 'message', ordinal: 1, body: 'session' }));
  connection.receive(JSON.stringify({ kind: 'message', ordinal: 3, body: 'terminal' }));
  expect(peer.accepted).toEqual(['session']);
  expect(peer.failures[0]?.message).toContain('gap');
  expect(() => peer.session.send('later')).toThrow();
  connection.receive(JSON.stringify({ kind: 'message', ordinal: 2, body: 'late row' }));
  expect(peer.accepted).toEqual(['session']);
});

for (const limits of [{ maxRetainedFrames: 1 }, { maxRetainedBytes: 100 }, { maxFrameBytes: 30 }]) {
  test(`retention exhaustion fences the session: ${JSON.stringify(limits)}`, () => {
    const peer = endpoint(limits);
    try {
      if ('maxRetainedFrames' in limits) peer.session.send('first');
      expect(() => peer.session.send('x'.repeat(200))).toThrow('budget exhausted');
      expect(peer.failures).toHaveLength(1);
      expect(peer.session.retainedFrames).toBe(0);
      expect(() => peer.session.attach(peer.socket, 0)).toThrow();
    } finally { peer.session.close(); }
  });
}

test('expired and rolled-back receive positions cannot resume a session', () => {
  let now = 1000;
  const peer = endpoint({ now: () => now, reconnectGraceMs: 1000 });
  const connection = peer.session.attach(peer.socket, 0);
  connection.disconnected();
  now += 1000;
  expect(() => peer.session.attach(peer.socket, 0)).toThrow('deadline');
  const net = network();
  try {
    net.worker.session.send('record'); net.exchange(); net.disconnect();
    expect(() => net.worker.session.attach(net.worker.socket, 0)).toThrow('cannot resume');
  } finally { net.close(); }
});

for (const packet of [null, {}, { kind: 'receipt', through: 1 }, { kind: 'receipt', through: -1 },
  { kind: 'message', ordinal: 0, body: '' }, { kind: 'message', ordinal: 1.5, body: '' },
  { kind: 'message', ordinal: 1, body: {} }]) {
  test(`invalid packet closes without dispatch: ${JSON.stringify(packet)}`, () => {
    const peer = endpoint();
    peer.session.attach(peer.socket, 0).receive(JSON.stringify(packet));
    expect(peer.accepted).toEqual([]);
    expect(peer.failures).toHaveLength(1);
    expect(peer.session.connected).toBe(false);
  });
}

test('consumer failure terminates continuity instead of acknowledging and continuing', () => {
  const peer = endpoint({ deliver() { throw new Error('dispatch failed'); } });
  const connection = peer.session.attach(peer.socket, 0);
  peer.output.length = 0;
  connection.receive(JSON.stringify({ kind: 'message', ordinal: 1, body: 'command' }));
  expect(peer.failures[0]?.message).toBe('dispatch failed');
  expect(peer.output).toEqual([]);
});
