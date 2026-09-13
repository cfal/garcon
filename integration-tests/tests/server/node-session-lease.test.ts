import { expect, test } from 'bun:test';
import { controllerTlsOptions } from '../../../common/controller-tls.js';
import { NodeSupervisor } from '../../../server/execution-node/supervisor.js';
import { NodeSessionLeaseMonitor } from '../../../server/execution-node/session-lease-monitor.js';
import { clientNodeSocketPort, createNodeClientSocket, serverNodeSocketPort } from '../../../server/execution-nodes/transport/bun-sockets.js';
import { ControllerLeaseResponder, NodeLeaseHeartbeat } from '../../../server/execution-nodes/transport/lease-channel.js';
import { parseNodeLeaseFrameText, serializeNodeLeaseFrame } from '../../../server/execution-nodes/transport/lease-wire.js';
import { NodeSocketWriter } from '../../../server/execution-nodes/transport/socket-writer.js';
import { TlsCertificates } from '../../support/tls-certificates.js';

test('WSS lease renewals survive six-second round trips and stale replies cannot postpone expiry', async () => {
  const certificates = await TlsCertificates.create();
  const certificate = await certificates.selfSigned('lease');
  let now = 0;
  let cleanups = 0;
  const timers = new Set<{ at: number; callback(): void }>();
  const schedulePoll = (callback: () => void, delayMs: number) => {
    const timer = { at: now + delayMs, callback };
    timers.add(timer);
    return { cancel() { timers.delete(timer); } };
  };
  const advanceTo = (target: number) => {
    for (;;) {
      const timer = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!timer || timer.at > target) break;
      now = timer.at;
      timers.delete(timer);
      timer.callback();
    }
    now = target;
  };
  const supervisor = new NodeSupervisor({
    clock: { read: () => ({ elapsedMs: now, discontinuity: false }) },
    cleanup: async () => { cleanups++; },
  });
  const session = supervisor.openSession('synthetic-lease-controller');
  const connection = supervisor.attach(session);
  supervisor.completeStartup(connection.session);
  supervisor.completeRecovery(connection, supervisor.beginRecovery(connection));
  const monitor = new NodeSessionLeaseMonitor({ authoritySignal: connection.authoritySignal, supervisor, schedulePoll,
    failed() { throw new Error('Synthetic lease clock failed'); } });
  const physical = new AbortController();
  const limits = { maxFrameBytes: 4096, maxBufferedBytes: 16_384, reservedControlBytes: 4096, reservedLifecycleBytes: 1024,
    maxDrainWaiters: 4, drainTimeoutMs: 10_000, signal: physical.signal };
  let challengeSource!: ReadableStreamDefaultController<string>;
  let renewalSource!: ReadableStreamDefaultController<string>;
  const challenges = new ReadableStream<string>({ start(controller) { challengeSource = controller; } }).getReader();
  const renewals = new ReadableStream<string>({ start(controller) { renewalSource = controller; } }).getReader();
  let responder: ControllerLeaseResponder | undefined;
  let heartbeat: NodeLeaseHeartbeat | undefined;
  const closed = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0, tls: { cert: certificate.cert, key: certificate.key },
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        responder = new ControllerLeaseResponder(new NodeSocketWriter(serverNodeSocketPort(socket), limits),
          { session, signal: physical.signal, validate: () => physical.signal.throwIfAborted() });
      },
      message(_socket, message) { challengeSource.enqueue(String(message)); },
      close() { challengeSource.close(); },
    },
  });
  const socket = createNodeClientSocket(new URL(`wss://127.0.0.1:${server.port}`), { tls: controllerTlsOptions(certificate.trust) });
  socket.onopen = () => {
    heartbeat = new NodeLeaseHeartbeat(new NodeSocketWriter(clientNodeSocketPort(socket), limits),
      { connection, supervisor, schedulePoll, disconnected() {} });
  };
  socket.onmessage = event => {
    heartbeat!.receive(String(event.data));
    renewalSource.enqueue(String(event.data));
  };
  socket.onclose = () => { renewalSource.close(); closed.resolve(); };
  const read = async (reader: ReadableStreamDefaultReader<string>) => {
    const message = await reader.read();
    if (message.done) throw new Error('WSS lease channel closed before the expected frame');
    return message.value;
  };
  const respond = async (challenge: string) => {
    responder!.receive(challenge);
    const reply = parseNodeLeaseFrameText(await read(renewals));
    expect(reply).toEqual({ ...parseNodeLeaseFrameText(challenge)!, type: 'node-lease-renewal' });
  };
  try {
    const first = await read(challenges);
    let preceding = first;
    let consumed = first;
    for (let round = 0; round < 5; round++) {
      advanceTo(round * 5000 + 5000);
      const next = await read(challenges);
      advanceTo(round * 5000 + 6000);
      await respond(preceding);
      expect(connection.signal.aborted).toBe(false);
      expect(() => supervisor.assertAdmission(connection)).not.toThrow();
      consumed = preceding;
      preceding = next;
    }
    expect(cleanups).toBe(0);
    advanceTo(40_000);
    for (const stale of [first, consumed, serializeNodeLeaseFrame({
      ...parseNodeLeaseFrameText(first)!, challengeId: 'synthetic-unknown-challenge',
    })]) {
      await respond(stale);
      expect(connection.signal.aborted).toBe(false);
    }
    advanceTo(40_999);
    expect(connection.authoritySignal.aborted).toBe(false);
    advanceTo(41_000);
    expect(connection.authoritySignal.aborted).toBe(true);
    await closed.promise;
    await supervisor.retryCleanup();
    expect(cleanups).toBe(1);
    expect(timers.size).toBe(0);
  } finally {
    monitor.close(); heartbeat?.close(); responder?.close(); physical.abort(); socket.terminate();
    await server.stop(true);
    await supervisor.shutdown();
    await certificates.dispose();
  }
}, 10_000);
