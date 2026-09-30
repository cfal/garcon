import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { connectNoiseWebSocket } from '@cfal/noise-ws';
import { WebSocketLink, EXECUTOR_NOISE_CONTEXT, shouldLogLinkFailure } from '../websocket-link.ts';
import { EXECUTOR_PROTOCOL_REVISION } from '../rpc-protocol.ts';
import { version as packageVersion } from '../../../../package.json';
import { tcpLinkProxy } from '../../__tests__/tcp-link-proxy.ts';
import { faultyNoiseListener } from '../../__tests__/noise-socket-faults.ts';
import { connectWithOwnRole, connectWithWrongKey, openSilentSocket, sendMalformedRecord } from '../../__tests__/failing-peers.ts';

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

// Answers a link's hello with a frame that is not JSON.
function malformedHandshake(address) {
  return connectNoiseWebSocket(address, {
    psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
    onMessage(socket) { socket.send('{"type": SYNTHETIC_SENTINEL}'); },
  });
}

// Answers a link's hello as the peer of its role would, then its proof with a signature that does not match.
function invalidProof(address, role) {
  return connectNoiseWebSocket(address, {
    psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
    onMessage(socket, data) {
      const local = JSON.parse(data);
      if (local.type === 'proof') { socket.send(JSON.stringify({ type: 'proof', signature: '0'.repeat(64) })); return; }
      const peer = { ...local, role: role === 'controller' ? 'worker' : 'controller', runtimeId: crypto.randomUUID(), nonce: crypto.randomUUID() };
      if (peer.role === 'worker') delete peer.executorId;
      else peer.executorId = 'synthetic-executor';
      socket.send(JSON.stringify(peer));
    },
  });
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

for (const role of ['controller', 'worker']) {
  test(`reports why a peer failed to authenticate without echoing a frame that fails to parse (${role})`, async () => {
    const link = new WebSocketLink({ role, executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true });
    const failures = [];
    link.onError(failure => failures.push(failure));
    const socket = malformedHandshake(link.listen());
    try {
      await socket.closed;
      expect(failures).toEqual([
        { message: 'Executor authentication failed', count: 1, reason: 'Malformed executor handshake frame' },
      ]);
    } finally { socket.close(); await link.dispose(); }
  });

  test(`reports a peer whose proof does not match the handshake (${role})`, async () => {
    const link = new WebSocketLink({ role, executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true });
    const failures = [];
    link.onError(failure => failures.push(failure));
    const socket = invalidProof(link.listen(), role);
    try {
      await socket.closed;
      expect(link.current).toBeNull();
      expect(failures).toEqual([
        { message: 'Executor authentication failed', count: 1, reason: 'Executor proof is missing or invalid' },
      ]);
    } finally { socket.close(); await link.dispose(); }
  });
}

test('counts a failure from one again when its reason changes', async () => {
  const link = new WebSocketLink({ role: 'controller', executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true });
  const failures = [];
  link.onError(failure => failures.push(failure));
  const address = link.listen();
  try {
    await malformedHandshake(address).closed;
    await malformedHandshake(address).closed;
    await connectWithOwnRole(address, secret);
    expect(failures).toEqual([
      { message: 'Executor authentication failed', count: 1, reason: 'Malformed executor handshake frame' },
      { message: 'Executor authentication failed', count: 2, reason: 'Malformed executor handshake frame' },
      { message: 'Executor authentication failed', count: 1, reason: 'Executor handshake mismatch' },
    ]);
  } finally { await link.dispose(); }
});

test('makes room for a peer by closing the oldest socket that has not finished its encrypted handshake', async () => {
  const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [20] };
  const controller = new WebSocketLink({ ...common, role: 'controller', noiseLimits: { handshakeTimeoutMs: 60_000 } });
  const worker = new WebSocketLink({ ...common, role: 'worker' });
  const failures = [];
  controller.onError(failure => failures.push(failure));
  const address = controller.listen();
  const silent = [];
  try {
    for (let index = 0; index < 4; index++) silent.push(await openSilentSocket(address));
    worker.dial(address);
    await Promise.all([controller.ready, worker.ready]);
    await silent[0].closed;

    expect(silent.map(({ socket }) => socket.readyState)).toEqual([WebSocket.CLOSED, WebSocket.OPEN, WebSocket.OPEN, WebSocket.OPEN]);
    // Closing a socket to make room is not a failure of the peer.
    expect(failures).toEqual([]);
  } finally {
    for (const { socket } of silent) socket.close();
    await worker.dispose(); await controller.dispose();
  }
});

test('refuses a plain request or an invalid upgrade to a full listener without closing a socket', async () => {
  const link = new WebSocketLink({ role: 'worker', secret, allowInsecureDevelopment: true, noiseLimits: { handshakeTimeoutMs: 60_000 } });
  const address = link.listen();
  const silent = [];
  try {
    for (let index = 0; index < 4; index++) silent.push(await openSilentSocket(address));
    const plain = await fetch(address.replace('ws:', 'http:'));
    // An upgrade without its WebSocket key, which the server refuses.
    const invalidUpgrade = await fetch(address.replace('ws:', 'http:'), {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13' },
    });
    const oldest = await Promise.race([silent[0].closed.then(() => 'closed'), Bun.sleep(200).then(() => 'open')]);

    expect([plain.status, invalidUpgrade.status]).toEqual([400, 400]);
    expect(oldest).toBe('open');
  } finally {
    for (const { socket } of silent) socket.close();
    await link.dispose();
  }
});

test('makes room by closing a socket whose peer has not proven the secret before one whose peer has', async () => {
  const link = new WebSocketLink({
    role: 'controller', executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, noiseLimits: { handshakeTimeoutMs: 60_000 },
  });
  const listener = faultyNoiseListener(link);
  // Delivers the peer's first handshake message, which proves the secret, but not the record that opens it.
  listener.deliverOnly(1);
  const proven = connectNoiseWebSocket(listener.url, { psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT, onMessage() {} });
  const silent = [];
  try {
    await eventually(() => proven.readyState === 'confirming');
    for (let index = 0; index < 4; index++) silent.push(await openSilentSocket(listener.url));
    await silent[0].closed;
    const survivor = await Promise.race([proven.closed.then(() => 'closed'), Bun.sleep(200).then(() => 'open')]);

    expect(survivor).toBe('open');
  } finally {
    for (const { socket } of silent) socket.close();
    proven.close();
    await link.dispose();
    await listener.stop();
  }
});

test('closes a socket whose peer has proven the secret when no other is still in the handshake', async () => {
  const link = new WebSocketLink({
    role: 'controller', executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, noiseLimits: { handshakeTimeoutMs: 60_000 },
  });
  const listener = faultyNoiseListener(link);
  const noise = { psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT, onMessage() {} };
  const opened = [];
  let silent = null;
  const proven = [];
  try {
    // Encrypted connections that never answer the link's hello.
    for (let index = 0; index < 3; index++) {
      const socket = connectNoiseWebSocket(listener.url, noise);
      opened.push(socket);
      await socket.ready;
    }
    listener.deliverOnly(1);
    proven.push(connectNoiseWebSocket(listener.url, noise));
    await eventually(() => proven[0].readyState === 'confirming');
    silent = await openSilentSocket(listener.url);
    await proven[0].closed;

    expect(opened.map(socket => socket.readyState)).toEqual(['open', 'open', 'open']);
  } finally {
    silent?.socket.close();
    for (const socket of [...opened, ...proven]) socket.close();
    await link.dispose();
    await listener.stop();
  }
});

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

  test(`reconnects with fresh keys when a busy link uses up its record budget (${dialer} dials)`, async () => {
    const common = {
      executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [20],
      noiseLimits: { maxRecordsPerDirection: 32 },
    };
    const controller = new WebSocketLink({ ...common, role: 'controller' });
    const worker = new WebSocketLink({ ...common, role: 'worker' });
    const [dialing, listening] = dialer === 'controller' ? [controller, worker] : [worker, controller];
    const closures = { controller: [], worker: [] };
    controller.onClosure(closure => closures.controller.push(closure));
    worker.onClosure(closure => closures.worker.push(closure));
    let sessions = 0;
    controller.onSession(() => { sessions += 1; });
    try {
      dialing.dial(listening.listen());
      const [session] = await Promise.all([worker.ready, controller.ready]);
      expect(() => { for (let index = 0; index < 32; index++) session.send(`synthetic message ${index}`); }).toThrow();
      await eventually(() => sessions === 2 && controller.current?.connected && worker.current?.connected);

      expect(closures.worker).toEqual([{ cause: 'record-limit', count: 1, reason: 'Encrypted connection failed (RECORD_LIMIT)' }]);
      expect(closures.controller).toEqual([
        { cause: 'socket-closed', count: 1, reason: 'Encrypted connection failed (TRANSPORT_CLOSED)' },
      ]);
    } finally { await controller.dispose(); await worker.dispose(); }
  });

  test(`counts a message over the receiver's size limit as a protocol error (${dialer} dials)`, async () => {
    const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [60_000] };
    const controller = new WebSocketLink({ ...common, role: 'controller', noiseLimits: { maxMessageBytes: 1024 } });
    const worker = new WebSocketLink({ ...common, role: 'worker' });
    const [dialing, listening] = dialer === 'controller' ? [controller, worker] : [worker, controller];
    const closures = { controller: [], worker: [] };
    controller.onClosure(closure => closures.controller.push(closure));
    worker.onClosure(closure => closures.worker.push(closure));
    try {
      dialing.dial(listening.listen());
      const [session] = await Promise.all([worker.ready, controller.ready]);
      session.send('x'.repeat(4096));
      await eventually(() => closures.controller.length === 1 && closures.worker.length === 1);

      expect(closures.controller).toEqual([
        { cause: 'protocol-error', count: 1, reason: 'Encrypted connection failed (MESSAGE_TOO_LARGE)' },
      ]);
      expect(closures.worker).toEqual([{ cause: 'socket-closed', count: 1, reason: 'Encrypted connection failed (TRANSPORT_CLOSED)' }]);
    } finally { await controller.dispose(); await worker.dispose(); }
  });
}

test('reports a peer that never starts the encrypted handshake', async () => {
  const link = new WebSocketLink({
    role: 'controller', executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, noiseLimits: { handshakeTimeoutMs: 50 },
  });
  const failures = [];
  link.onError(failure => failures.push(failure));
  const socket = new WebSocket(link.listen());
  const closed = new Promise(resolve => socket.addEventListener('close', resolve));
  try {
    await closed;
    expect(failures).toEqual([{ message: 'Executor encrypted connection failed (HANDSHAKE_TIMEOUT)', count: 1 }]);
  } finally { socket.close(); await link.dispose(); }
});

test('reports a dial whose encrypted handshake never completes', async () => {
  const listening = new WebSocketLink({ role: 'worker', secret, allowInsecureDevelopment: true });
  const dialing = new WebSocketLink({
    role: 'controller', executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true,
    redialDelaysMs: [60_000], noiseLimits: { handshakeTimeoutMs: 50 },
  });
  const path = await tcpLinkProxy(new URL(listening.listen(0, '127.0.0.1')));
  const failures = [];
  dialing.onError(failure => failures.push(failure));
  try {
    path.blackhole();
    dialing.dial(path.url);
    await eventually(() => failures.length > 0);
    expect(failures).toEqual([{ message: 'Executor encrypted connection failed (HANDSHAKE_TIMEOUT)', count: 1 }]);
  } finally { await path.close(); await dialing.dispose(); await listening.dispose(); }
});

// A controller link whose connection to its worker can be faulted beneath the encryption.
async function faultyLinkPair() {
  const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, redialDelaysMs: [60_000] };
  const controller = new WebSocketLink({ ...common, role: 'controller' });
  const worker = new WebSocketLink({ ...common, role: 'worker' });
  const listener = faultyNoiseListener(controller);
  worker.dial(listener.url);
  await Promise.all([controller.ready, worker.ready]);
  const closure = Promise.withResolvers();
  controller.onClosure(closure.resolve);
  return {
    controller, listener, closure: closure.promise,
    async dispose() { await worker.dispose(); await controller.dispose(); await listener.stop(); },
  };
}

test('counts a write the socket drops as a socket error', async () => {
  const pair = await faultyLinkPair();
  try {
    pair.listener.dropWrites();
    expect(() => pair.controller.current.send('synthetic payload')).toThrow();
    expect(await pair.closure).toEqual({ cause: 'socket-error', count: 1, reason: 'Encrypted connection failed (TRANSPORT_ERROR)' });
  } finally { await pair.dispose(); }
});

test('counts a close record that does not fit the socket buffer as a socket error', async () => {
  const pair = await faultyLinkPair();
  try {
    pair.listener.fillBuffer();
    pair.listener.closeConnections();
    expect(await pair.closure).toEqual({ cause: 'socket-error', count: 1, reason: 'Encrypted connection failed (BACKPRESSURE)' });
  } finally { await pair.dispose(); }
});

test('counts a frame too short to be an encrypted record as a protocol error', async () => {
  const pair = await faultyLinkPair();
  try {
    pair.listener.inject(Buffer.alloc(8));
    expect(await pair.closure).toEqual({ cause: 'protocol-error', count: 1, reason: 'Encrypted connection failed (PROTOCOL_ERROR)' });
  } finally { await pair.dispose(); }
});

// Authenticates to a controller link as its worker would, without the session layer,
// whose fragments each fit one encrypted record.
function workerOutsideSessionLayer(address) {
  let controllerHello;
  let workerHello;
  return connectNoiseWebSocket(address, {
    psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
    onMessage(socket, data) {
      if (typeof data !== 'string') return;
      const frame = JSON.parse(data);
      if (frame.type === 'hello') {
        controllerHello = frame;
        workerHello = { type: 'hello', version: frame.version, role: 'worker', runtimeId: crypto.randomUUID(), nonce: crypto.randomUUID() };
        socket.send(JSON.stringify(workerHello));
      } else if (frame.type === 'proof') {
        const transcript = JSON.stringify(['garcon-executor', 'worker', [controllerHello, workerHello]]);
        socket.send(JSON.stringify({ type: 'proof', signature: createHmac('sha256', secret).update(transcript).digest('hex') }));
      }
    },
  });
}

test('counts an encrypted message that never completes as a liveness timeout', async () => {
  const link = new WebSocketLink({
    role: 'controller', executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, noiseLimits: { messageTimeoutMs: 20 },
  });
  const listener = faultyNoiseListener(link);
  const closure = Promise.withResolvers();
  link.onClosure(closure.resolve);
  const worker = workerOutsideSessionLayer(listener.url);
  try {
    await link.ready;
    listener.deliverOnly(1);
    worker.send(new Uint8Array(70_000));
    expect(await closure.promise).toEqual({ cause: 'liveness-timeout', count: 1, reason: 'Encrypted connection failed (MESSAGE_TIMEOUT)' });
  } finally { worker.close(); await link.dispose(); await listener.stop(); }
});

test('reports a lost connection while its session is current, before its closure', async () => {
  const link = new WebSocketLink({ role: 'controller', executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true });
  const events = [];
  link.onError(failure => events.push({ failure: failure.message, reason: failure.reason, sessionCurrent: link.current !== null }));
  link.onClosure(closure => events.push({ closure: closure.cause }));
  const worker = workerOutsideSessionLayer(link.listen());
  try {
    await link.ready;
    // Session packets travel in binary frames, so a text frame breaks the session.
    worker.send('synthetic text frame');
    await eventually(() => events.length === 2);

    expect(events).toEqual([
      { failure: 'Executor connection lost', reason: 'Session packets require binary framing', sessionCurrent: true },
      { closure: 'protocol-error' },
    ]);
  } finally { worker.close(); await link.dispose(); }
});
