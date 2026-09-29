import { expect, test } from 'bun:test';
import { connectNoiseWebSocket } from '@cfal/noise-ws';
import { WebSocketLink, EXECUTOR_NOISE_CONTEXT } from '../websocket-link.ts';

const secret = Buffer.alloc(32, 42).toString('base64url');

for (const role of ['controller', 'worker']) {
  test(`reports a version mismatch separately from authentication (${role})`, async () => {
    const link = new WebSocketLink({ role, executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true });
    const errors = [];
    link.onError(message => errors.push(message));
    let localVersion;
    const socket = connectNoiseWebSocket(link.listen(), {
      psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
      onMessage(socket, data) {
        const hello = JSON.parse(data);
        localVersion = hello.version;
        const peer = { ...hello, version: 'synthetic-incompatible', role: role === 'controller' ? 'worker' : 'controller' };
        if (peer.role === 'worker') delete peer.executorId;
        else peer.executorId = 'synthetic-executor';
        socket.send(JSON.stringify(peer));
      },
    });
    try {
      await socket.closed;
      expect(link.current).toBeNull();
      expect(errors).toEqual([`Executor version mismatch: local ${localVersion}, peer "synthetic-incompatible". Use matching builds.`]);
    } finally { socket.close(); await link.dispose(); }
  });
}

for (const dialer of ['controller', 'worker']) {
  test(`authenticated reconnect replaces the socket session (${dialer} dials)`, async () => {
    const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, reconnectDelayMs: 20 };
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
    const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, reconnectDelayMs: 20 };
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
  test(`attributes closures started by the session layer and by disposal (${dialer} dials)`, async () => {
    const common = { executorId: 'synthetic-executor', secret, allowInsecureDevelopment: true, reconnectDelayMs: 20 };
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

      expect(closures.dialing).toEqual([{ cause: 'session-retired', count: 1 }, { cause: 'socket-closed', count: 1 }]);
      expect(closures.listening).toEqual([{ cause: 'socket-closed', count: 1 }, { cause: 'local-close', count: 1 }]);
    } finally { await controller.dispose(); await worker.dispose(); }
  });
}
