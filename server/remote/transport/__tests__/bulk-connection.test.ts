import { expect, test } from 'bun:test';
import { ExecutorRpcConnection } from '../rpc-connection.js';
import { RpcAdmissionBudgets } from '../rpc-admission.js';
import { ParkedRpcCalls, type ExecutorRpc } from '../rpc.js';
import { RpcReplyJournal } from '../rpc-journal.js';
import { WebSocketLink } from '../websocket-link.js';
import type { SessionTransport } from '../session-transport.js';

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Bulk condition did not hold');
    await Bun.sleep(2);
  }
}

function holdWrites(link: WebSocketLink) {
  const gates = { primary: false, bulk: false };
  const attachGate = (session: SessionTransport) => {
    const attach = session.attach.bind(session);
    session.attach = (socket) => attach({
      send: (payload) => socket.send(payload), close: () => socket.close(),
      canSend: (bytes) => !gates[session.lane] && socket.canSend?.(bytes) !== false,
    });
  };
  link.onSession(attachGate);
  link.onBulkSession(attachGate);
  return gates;
}

async function pair(dialer: 'controller' | 'worker', configure?: (controller: ReturnType<typeof holdWrites>, worker: WebSocketLink) => void) {
  const common = { executorId: 'test-executor', secret: Buffer.alloc(32, 42).toString('base64url'), noTls: true, redialDelaysMs: [60_000] };
  const controller = new WebSocketLink({ ...common, role: 'controller' });
  const worker = new WebSocketLink({ ...common, role: 'worker' });
  const gates = { controller: holdWrites(controller), worker: holdWrites(worker) };
  configure?.(gates.controller, worker);
  const parked = { primary: new ParkedRpcCalls(), bulk: new ParkedRpcCalls() };
  const controllerAdmission = new RpcAdmissionBudgets();
  const workerAdmission = new RpcAdmissionBudgets();
  const journal = new RpcReplyJournal();
  const connections = {} as Record<'controller' | 'worker', ExecutorRpcConnection>;
  const endpoints = {} as Record<'controller' | 'worker', ExecutorRpc[]>;
  const hooks = { read: async () => ['synthetic-file'], reverse: async () => ({ status: 200, body: [] }) };
  let executions = 0;
  const bulkTiming = { redialDelaysMs: [0, 10, 20], setupTimeoutMs: 300, stableSessionMs: 100 };
  controller.onSession((transport) => {
    connections.controller = new ExecutorRpcConnection(controller, transport, { parked, admission: controllerAdmission, bulkTiming });
    endpoints.controller = [];
    connections.controller.onEndpoint((rpc) => {
      endpoints.controller.push(rpc);
      rpc.handle(async () => hooks.reverse());
    });
  });
  worker.onSession((transport) => {
    connections.worker = new ExecutorRpcConnection(worker, transport, { journal, admission: workerAdmission, bulkTiming });
    endpoints.worker = [];
    connections.worker.onEndpoint((rpc) => {
      endpoints.worker.push(rpc);
      rpc.handle(async (call) => {
        if (call.method === 'files.list') { executions++; return hooks.read(); }
        return { ok: true };
      });
    });
  });
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  await Promise.all([controller.ready, worker.ready]);
  return {
    controller, worker, connections, endpoints, gates, hooks, journal, controllerAdmission, workerAdmission,
    get executions() { return executions; },
    start() { connections.controller.activate(); },
    async ready() { await until(() => Boolean(connections.controller.bulk.current && connections.worker.bulk.current)); },
    async dispose() {
      await controller.dispose(); await worker.dispose();
      parked.primary.close(); parked.bulk.close(); journal.dispose();
    },
  };
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`primary works before bulk and bulk flaps never replace it (${dialer} dials)`, async () => {
    const fixture = await pair(dialer);
    try {
      const primary = fixture.connections.controller.primary;
      expect(fixture.connections.controller.bulk.current).toBeNull();
      await expect(primary.call('', 'projects.inspect', { projectPath: '/project' })).resolves.toEqual({ ok: true });
      fixture.start();
      await fixture.ready();
      for (let loss = 0; loss < 3; loss++) {
        const oldBulk = fixture.connections.controller.bulk.current!;
        oldBulk.transport.close();
        expect(fixture.connections.controller.bulk.current).toBeNull();
        await fixture.ready();
        expect(fixture.connections.controller.bulk.current).not.toBe(oldBulk);
        expect(fixture.connections.controller.primary).toBe(primary);
        expect(primary.transport.connected).toBe(true);
      }
    } finally { await fixture.dispose(); }
  });

  test(`both directions stay recovery-only until reconciliation activates bulk (${dialer} dials)`, async () => {
    const fixture = await pair(dialer, (gates) => { gates.bulk = true; });
    try {
      fixture.start();
      await until(() => Boolean(fixture.worker.bulk?.connected));
      const workerBulk = fixture.endpoints.worker.find((rpc) => rpc.transport.lane === 'bulk')!;
      let admitted = false;
      const waiting = fixture.connections.worker.bulk.wait().then(() => { admitted = true; });
      await expect(workerBulk.call('', 'controllerCli.request', {
        expectedServerInstanceId: 'synthetic-server', http: { operation: 'GET /api/v1/chats', query: [], body: null },
      })).rejects.toMatchObject({ outcome: 'not-dispatched' });
      expect(admitted).toBe(false);
      expect(fixture.connections.controller.bulk.current).toBeNull();
      fixture.gates.controller.bulk = false;
      await fixture.ready();
      await waiting;
      await expect(workerBulk.call('', 'controllerCli.request', {
        expectedServerInstanceId: 'synthetic-server', http: { operation: 'GET /api/v1/chats', query: [], body: null },
      })).resolves.toEqual({ status: 200, body: [] });
    } finally { await fixture.dispose(); }
  });

  test(`bulk recovery adopts pending calls without waiting for their handlers (${dialer} dials)`, async () => {
    const fixture = await pair(dialer);
    const release = Promise.withResolvers<string[]>();
    try {
      fixture.start(); await fixture.ready();
      fixture.hooks.read = () => release.promise;
      const answer = fixture.connections.controller.bulk.current!.call('', 'files.list', { projectPath: '/project' });
      await until(() => fixture.executions === 1);
      fixture.controller.bulk!.close();
      await fixture.ready();
      expect(fixture.executions).toBe(1);
      expect(fixture.workerAdmission.incoming.size).toBe(1);
      release.resolve(['settled-after-activation']);
      await expect(answer).resolves.toEqual(['settled-after-activation']);
      await until(() => fixture.workerAdmission.incoming.size === 0);
    } finally { release.resolve([]); await fixture.dispose(); }
  });
}

test('full ordinary primary queue admits lifecycle controls and retries refusal without retirement', async () => {
  const fixture = await pair('worker');
  try {
    fixture.start(); await fixture.ready();
    fixture.gates.controller.primary = true;
    const primary = fixture.connections.controller.primary.transport;
    const ordinary = JSON.stringify({ type: 'reply-ack', ids: [] });
    while (primary.channel.canAdmit(ordinary)) primary.send(ordinary);
    expect(primary.channel.queuedFrames).toBe(4092);
    fixture.worker.bulk!.close();
    await until(() => fixture.connections.controller.status.phase === 'preparing');
    expect(primary.channel.queuedFrames).toBe(4093);
    const frame = { type: 'bulk-prepare', sessionId: fixture.connections.controller.status.sessionId! } as const;
    for (let remaining = 0; remaining < 3; remaining++) expect(primary.channel.offerBulkControl(frame)).toBe(true);
    expect(primary.channel.offerBulkControl(frame)).toBe(false);
    expect(primary.connected).toBe(true);
    fixture.gates.controller.primary = false;
    await fixture.ready();
    expect(fixture.connections.controller.primary.transport).toBe(primary);
  } finally { await fixture.dispose(); }
});

test('parent loss fences attempts and rejects bulk waiters, including delayed activation', async () => {
  const fixture = await pair('controller', (gates) => { gates.bulk = true; });
  try {
    fixture.start();
    await until(() => Boolean(fixture.worker.bulk?.connected));
    const waiting = fixture.connections.controller.bulk.wait().catch((error: unknown) => error);
    const generation = fixture.connections.controller;
    generation.primary.transport.close();
    expect(await waiting).toMatchObject({ outcome: 'not-dispatched' });
    fixture.gates.controller.bulk = false;
    await until(() => fixture.worker.bulk === null);
    expect(generation.bulk.current).toBeNull();
    expect(generation.status.phase).toBe('offline');
  } finally { await fixture.dispose(); }
});

test('a delayed socket-ready continuation cannot undo reconciliation or activation', async () => {
  const release = Promise.withResolvers<void>();
  const fixture = await pair('controller', (_gates, worker) => {
    worker.onBulkSession((session) => {
      Object.defineProperty(session, 'ready', { value: session.ready.then(() => release.promise) });
    });
  });
  try {
    fixture.start();
    await fixture.ready();
    release.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fixture.connections.worker.status.phase).toBe('ready');
    await expect(fixture.connections.controller.bulk.current!.call('', 'files.list', { projectPath: '/project' }))
      .resolves.toEqual(['synthetic-file']);
  } finally { release.resolve(); await fixture.dispose(); }
});

test('bulk wait cancellation and quiescence do not retire a live primary', async () => {
  const fixture = await pair('controller');
  try {
    const controller = new AbortController();
    const waiting = fixture.connections.controller.bulk.wait({ signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    expect(await waiting).toMatchObject({ outcome: 'not-dispatched' });
    const quiesced = fixture.connections.controller.bulk.wait().catch((error: unknown) => error);
    fixture.controller.quiesce();
    expect(await quiesced).toMatchObject({ outcome: 'not-dispatched' });
    expect(fixture.connections.controller.primary.transport.connected).toBe(true);
    fixture.start();
    expect(fixture.controller.bulk).toBeNull();
  } finally { await fixture.dispose(); }
});

test('reverse lane acquisition is budgeted and cannot follow a replacement primary', async () => {
  const fixture = await pair('controller');
  const abort = new AbortController();
  try {
    const captured = fixture.connections.worker;
    const pending = captured.acquire('bulk', { signal: abort.signal, timeoutMs: null }).catch(error => error);
    expect(fixture.workerAdmission.outgoing.size).toBe(1);
    const context = await captured.acquire('primary', { signal: abort.signal, timeoutMs: 5000 });
    expect(context.rpc).toBe(captured.primary);
    captured.primary.transport.close();
    expect(await pending).toMatchObject({ outcome: 'not-dispatched' });
    expect(fixture.workerAdmission.outgoing.size).toBe(0);
    await expect(captured.acquire('bulk', { signal: abort.signal, timeoutMs: null })).rejects.toMatchObject({ outcome: 'not-dispatched' });
  } finally { await fixture.dispose(); }
});
