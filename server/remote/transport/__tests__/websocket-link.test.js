import { expect, test } from 'bun:test';
import { connectNoiseWebSocket } from '@cfal/noise-ws';
import { WebSocketLink, EXECUTOR_NOISE_CONTEXT, shouldLogLinkFailure } from '../websocket-link.ts';
import { EXECUTOR_PROTOCOL_REVISION } from '../rpc-protocol.ts';
import { version as packageVersion } from '../../../../package.json';
import { tcpLinkProxy } from '../../__tests__/tcp-link-proxy.ts';
import { connectWithWrongKey, sendMalformedRecord } from '../../__tests__/failing-peers.ts';

const secret = Buffer.alloc(32, 42).toString('base64url');
const linkVersion = `${packageVersion}+protocol.${EXECUTOR_PROTOCOL_REVISION}`;

// Builds of one release share a package version, so only the protocol revision tells them apart.
const incompatiblePeers = [
  ['another release', 'synthetic-incompatible'],
  ['this release without a protocol revision', packageVersion],
  ['this release at another protocol revision', `${packageVersion}+protocol.${EXECUTOR_PROTOCOL_REVISION + 1}`],
];

// Answers a link's hello as the peer of a role would, reporting the given build.
function peerOfBuild(address, role, version) {
  const hello = Promise.withResolvers();
  const socket = connectNoiseWebSocket(address, {
    psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
    onMessage(socket, data) {
      const local = JSON.parse(data);
      hello.resolve(local);
      const peer = { ...local, version, role: role === 'controller' ? 'worker' : 'controller' };
      if (peer.role === 'worker') delete peer.executorId;
      else peer.executorId = 'synthetic-executor';
      socket.send(JSON.stringify(peer));
    },
  });
  return { socket, hello: hello.promise };
}

function versionMismatch(peerVersion) {
  return `Executor version mismatch: local ${linkVersion}, peer ${JSON.stringify(peerVersion)}. Use matching builds.`;
}

for (const role of ['controller', 'worker']) {
  for (const [peerBuild, peerVersion] of incompatiblePeers) {
    test(`reports a version mismatch with ${peerBuild} separately from authentication (${role})`, async () => {
      const link = new WebSocketLink({ role, executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true });
      const failures = [];
      link.onError(failure => failures.push(failure));
      const peer = peerOfBuild(link.listen(), role, peerVersion);
      try {
        await peer.socket.closed;
        expect(link.current).toBeNull();
        expect((await peer.hello).version).toBe(linkVersion);
        expect(failures).toEqual([{ message: versionMismatch(peerVersion), count: 1 }]);
      } finally { peer.socket.close(); await link.dispose(); }
    });
  }
}

test('counts each kind of connection failure until a session starts, however failures alternate', async () => {
  const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [20] };
  const controller = new WebSocketLink({ ...common, role: 'controller' });
  const worker = new WebSocketLink({ ...common, role: 'worker' });
  const failures = [];
  controller.onError(failure => failures.push(failure));
  const address = controller.listen();
  const wrongKey = 'Executor encrypted connection failed (AUTHENTICATION_FAILED)';
  const malformed = 'Executor encrypted connection failed (PROTOCOL_ERROR)';
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await connectWithWrongKey(address);
      await sendMalformedRecord(address);
    }
    expect(failures).toEqual([1, 2, 3].flatMap(count => [{ message: wrongKey, count }, { message: malformed, count }]));

    worker.dial(address);
    await Promise.all([controller.ready, worker.ready]);
    await connectWithWrongKey(address);
    expect(failures.slice(6)).toEqual([{ message: wrongKey, count: 1 }]);
  } finally { await worker.dispose(); await controller.dispose(); }
});

test('counts version mismatches from one again when the peer build changes', async () => {
  const link = new WebSocketLink({ role: 'controller', executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true });
  const failures = [];
  link.onError(failure => failures.push(failure));
  const address = link.listen();
  try {
    for (const version of ['synthetic-old', 'synthetic-old', 'synthetic-other']) {
      await peerOfBuild(address, 'controller', version).socket.closed;
    }
    expect(failures).toEqual([
      { message: versionMismatch('synthetic-old'), count: 1 },
      { message: versionMismatch('synthetic-old'), count: 2 },
      { message: versionMismatch('synthetic-other'), count: 1 },
    ]);
  } finally { await link.dispose(); }
});

test('logs a kind of link failure at its 1st, 2nd, 4th, 8th, ... occurrence', () => {
  const counts = Array.from({ length: 40 }, (_, index) => index + 1);
  expect(counts.filter(count => shouldLogLinkFailure({ message: 'synthetic failure', count }))).toEqual([1, 2, 4, 8, 16, 32]);
});

for (const dialer of ['controller', 'worker']) {
  test(`authenticated reconnect replaces the socket session (${dialer} dials)`, async () => {
    const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [20] };
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
    try {
      if (dialer === 'controller') controller.dial(worker.listen());
      else worker.dial(controller.listen());
      const [left, right] = await Promise.all([controller.ready, worker.ready]);
      right.send('first');
      await first.promise;
      const replaced = Promise.withResolvers();
      worker.onSession(session => { if (session !== right) void session.ready.then(() => { session.send('last'); replaced.resolve(); }); });
      controller.disconnect(); worker.disconnect();
      expect(() => right.send('not replayed')).toThrow();
      await replaced.promise;
      await last.promise;
      expect(events).toEqual(['first', 'last']);
      expect(controller.current).not.toBe(left);
      expect(worker.current).not.toBe(right);
      expect(controller.current.peerRuntimeId).toBe(worker.runtimeId);
    } finally { await controller.dispose(); await worker.dispose(); }
  });
}

test('disposing an authenticated listener releases its port for replacement', async () => {
  const common = {
    executorId: 'synthetic-executor', secret,
    allowInsecureDevelopment: true, reconnectDelayMs: 60_000,
  };
  const controller = new WebSocketLink({ ...common, role: 'controller' });
  const worker = new WebSocketLink({ ...common, role: 'worker' });
  const replacement = new WebSocketLink({ ...common, role: 'controller' });
  try {
    const address = controller.listen(0, '127.0.0.1');
    const port = Number(new URL(address).port);
    worker.dial(address);
    await Promise.all([controller.ready, worker.ready]);

    await controller.dispose();

    expect(new URL(replacement.listen(port, '127.0.0.1')).port).toBe(String(port));
  } finally {
    await controller.dispose();
    await worker.dispose();
    await replacement.dispose();
  }
});

for (const role of ['controller', 'worker']) {
  for (const attack of ['reflected proof', 'wrong secret']) {
    test(`rejects ${attack} when authenticating a ${role} peer`, async () => {
      const link = new WebSocketLink({
        role, executorId: 'synthetic-executor', secret,
        allowInsecureDevelopment: true,
      });
      let accepted = 0;
      link.onSession(() => { accepted++; });
      const socket = connectNoiseWebSocket(link.listen(), {
        psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
        onMessage: (socket, data) => {
        const frame = JSON.parse(data);
        if (frame.type === 'hello') {
          const peer = {
            ...frame, role: role === 'controller' ? 'worker' : 'controller',
            runtimeId: crypto.randomUUID(), nonce: crypto.randomUUID(),
          };
          if (peer.role === 'controller') peer.executorId = 'synthetic-executor';
          else delete peer.executorId;
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

async function eventually(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition did not hold in time');
    await Bun.sleep(5);
  }
}

for (const dialer of ['controller', 'worker']) {
  test(`counts session closures by cause on both ends (${dialer} dials)`, async () => {
    const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [20] };
    const controller = new WebSocketLink({ ...common, role: 'controller' });
    const worker = new WebSocketLink({ ...common, role: 'worker' });
    const [dialing, listening] = dialer === 'controller' ? [controller, worker] : [worker, controller];
    const closures = { dialing: [], listening: [] };
    dialing.onClosure(closure => closures.dialing.push(closure));
    listening.onClosure(closure => closures.listening.push(closure));
    let sessions = 0;
    listening.onSession(() => { sessions += 1; });
    try {
      dialing.dial(listening.listen());
      await eventually(() => sessions === 1 && dialing.current?.connected && listening.current?.connected);
      listening.disconnect();
      await eventually(() => sessions === 2 && dialing.current?.connected && listening.current?.connected);
      listening.disconnect();
      await eventually(() => closures.dialing.length === 2 && closures.listening.length === 2);

      expect(closures.listening).toEqual([{ cause: 'local-close', count: 1 }, { cause: 'local-close', count: 2 }]);
      expect(closures.dialing).toEqual([{ cause: 'socket-closed', count: 1 }, { cause: 'socket-closed', count: 2 }]);
    } finally { await controller.dispose(); await worker.dispose(); }
  });
}

for (const dialer of ['controller', 'worker']) {
  test(`redials at once after a stable session and backs off after a short one (${dialer} dials)`, async () => {
    const common = {
      executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [0, 60_000], stableSessionMs: 100,
    };
    const controller = new WebSocketLink({ ...common, role: 'controller' });
    const worker = new WebSocketLink({ ...common, role: 'worker' });
    const [dialing, listening] = dialer === 'controller' ? [controller, worker] : [worker, controller];
    let sessions = 0;
    listening.onSession(() => { sessions += 1; });
    try {
      dialing.dial(listening.listen());
      await eventually(() => sessions === 1 && dialing.current?.connected && listening.current?.connected);
      await Bun.sleep(150);
      listening.disconnect();
      await eventually(() => sessions === 2 && dialing.current?.connected && listening.current?.connected, 1_000);
      listening.disconnect();
      await Bun.sleep(300);

      expect(sessions).toBe(2);
      expect(dialing.current).toBeNull();
    } finally { await controller.dispose(); await worker.dispose(); }
  });
}

test('rejects invalid redial delays', () => {
  for (const redialDelaysMs of [[], [-1], [1.5]]) {
    expect(() => new WebSocketLink({ role: 'worker', secret, redialDelaysMs })).toThrow('Executor redial delays must be non-negative integers');
  }
});

for (const dialer of ['controller', 'worker']) {
  test(`attributes closures started by the session layer and by disposal (${dialer} dials)`, async () => {
    const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [20] };
    const controller = new WebSocketLink({ ...common, role: 'controller' });
    const worker = new WebSocketLink({ ...common, role: 'worker' });
    const [dialing, listening] = dialer === 'controller' ? [controller, worker] : [worker, controller];
    const closures = { dialing: [], listening: [] };
    dialing.onClosure(closure => closures.dialing.push(closure));
    listening.onClosure(closure => closures.listening.push(closure));
    let sessions = 0;
    listening.onSession(() => { sessions += 1; });
    try {
      dialing.dial(listening.listen());
      await eventually(() => sessions === 1 && dialing.current?.connected && listening.current?.connected);
      dialing.current.close(new Error('Synthetic session retirement'));
      await eventually(() => sessions === 2 && dialing.current?.connected && listening.current?.connected);
      await listening.dispose();
      await eventually(() => closures.dialing.length === 2);

      expect(closures.dialing).toEqual([
        { cause: 'session-retired', count: 1, reason: 'Synthetic session retirement' },
        { cause: 'socket-closed', count: 1 },
      ]);
      expect(closures.listening).toEqual([{ cause: 'socket-closed', count: 1 }, { cause: 'local-close', count: 1 }]);
    } finally { await controller.dispose(); await worker.dispose(); }
  });
}

for (const dialer of ['controller', 'worker']) {
  test(`counts a corrupted encrypted record as a protocol error where it arrives (${dialer} dials)`, async () => {
    const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [20] };
    const controller = new WebSocketLink({ ...common, role: 'controller' });
    const worker = new WebSocketLink({ ...common, role: 'worker' });
    const [dialing, listening] = dialer === 'controller' ? [controller, worker] : [worker, controller];
    const proxy = await tcpLinkProxy(new URL(listening.listen()));
    const closures = { dialing: [], listening: [] };
    dialing.onClosure(closure => closures.dialing.push(closure));
    listening.onClosure(closure => closures.listening.push(closure));
    try {
      dialing.dial(proxy.url);
      const [session] = await Promise.all([dialing.ready, listening.ready]);
      proxy.corruptNextToTarget();
      session.send('synthetic payload');
      await eventually(() => closures.dialing.length === 1 && closures.listening.length === 1);

      expect(closures.listening).toEqual([
        { cause: 'protocol-error', count: 1, reason: 'Encrypted connection failed (AUTHENTICATION_FAILED)' },
      ]);
      expect(closures.dialing).toEqual([
        { cause: 'socket-closed', count: 1, reason: 'Encrypted connection failed (TRANSPORT_CLOSED)' },
      ]);
    } finally { await controller.dispose(); await worker.dispose(); await proxy.close(); }
  });

  test(`reports a dropped network path with its Noise error code on both ends (${dialer} dials)`, async () => {
    const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [60_000] };
    const controller = new WebSocketLink({ ...common, role: 'controller' });
    const worker = new WebSocketLink({ ...common, role: 'worker' });
    const [dialing, listening] = dialer === 'controller' ? [controller, worker] : [worker, controller];
    const reports = { dialing: { failures: [], closures: [] }, listening: { failures: [], closures: [] } };
    for (const [end, link] of [['dialing', dialing], ['listening', listening]]) {
      link.onError(failure => reports[end].failures.push(failure));
      link.onClosure(closure => reports[end].closures.push(closure));
    }
    // The proxy stands in for a tunnel that drops the TCP connection without a WebSocket or encrypted close.
    const path = await tcpLinkProxy(new URL(listening.listen(0, '127.0.0.1')));
    try {
      dialing.dial(path.url);
      await Promise.all([controller.ready, worker.ready]);
      path.disconnect();
      await eventually(() => reports.dialing.closures.length === 1 && reports.listening.closures.length === 1);

      for (const end of ['dialing', 'listening']) {
        expect(reports[end].failures).toEqual([{ message: 'Executor encrypted connection failed (TRANSPORT_CLOSED)', count: 1 }]);
        expect(reports[end].closures).toEqual([
          { cause: 'socket-closed', count: 1, reason: 'Encrypted connection failed (TRANSPORT_CLOSED)' },
        ]);
      }
    } finally { await path.close(); await controller.dispose(); await worker.dispose(); }
  });
}
