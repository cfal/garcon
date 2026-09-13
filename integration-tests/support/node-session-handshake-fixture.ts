import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Subprocess } from 'bun';
import type { ControllerTlsTrust } from '../../common/controller-tls.js';
import type { ExecutionNodePairing } from '../../common/execution-node-config.js';
import { sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import { NodeControllerHandshake, type NodeControllerHandshakeOptions } from '../../server/execution-node/controller-handshake.js';
import type { LeaseClock } from '../../server/execution-node/lease-clock.js';
import { createNodeControllerSocket, createNodeBulkSocket } from '../../server/execution-node/controller-socket.js';
import { NodeOutputRetirements } from '../../server/execution-node/output-retirements.js';
import { NodeSessionBridge } from '../../server/execution-node/session-bridge.js';
import { NodeSessionConnectionOwner } from '../../server/execution-node/session-connection-owner.js';
import { NodeSessionCoordinator, type NodeHostedConnection } from '../../server/execution-node/session-coordinator.js';
import { DEFAULT_NODE_REPLAY, type NodeReplayOptions } from '../../server/execution-node/replay-cache.js';
import { NodeSessionMarkerFile } from '../../server/execution-node/systemd/session-marker.js';
import { runSystemdHelper } from '../../server/execution-node/systemd/helper-process.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../server/execution-node/worker/launch.js';
import { NodeWorkerPeer } from '../../server/execution-node/worker/peer.js';
import { parseNodeWorkerApplicationText, type NodeWorkerApplicationFrame } from '../../server/execution-node/worker/application-protocol.js';
import { parseNodeWorkerOutputText } from '../../server/execution-node/worker/output-protocol.js';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES, type NodeWorkerContainmentRequest } from '../../server/execution-node/worker/protocol.js';
import type { NodeWorkerBulkFrame } from '../../server/execution-node/worker/bulk-protocol.js';
import type { NodeInstanceConfiguration } from '../../server/execution-node/worker/configuration.js';
import { NodeChannelAuthentication, type AuthenticatedNodeChannel } from '../../server/execution-nodes/channel-authentication.js';
import { ControllerNodeHandshake, type ControllerNodeHandshakeOptions } from '../../server/execution-nodes/controller-handshake.js';
import { NodePairingStore } from '../../server/execution-nodes/pairing-store.js';
import { NodeSessionClient } from '../../server/execution-nodes/session-client.js';
import { NodeEnrollmentTransport } from '../../server/execution-nodes/trust.js';
import { clientNodeSocketPort, serverNodeSocketPort, type NodeClientSocket } from '../../server/execution-nodes/transport/bun-sockets.js';
import { NodeSocketWriter } from '../../server/execution-nodes/transport/socket-writer.js';
import { NodeBulkSessionChannel, type NodeBulkSessionBinding } from '../../server/execution-nodes/transport/bulk-session-channel.js';
import type { NodeSessionAccepted } from '../../server/execution-nodes/transport/session-wire.js';
import { DomainError } from '../../server/lib/domain-error.js';
import type { TestCertificate } from './tls-certificates.js';

export const nodeSessionSystemdAvailable = process.platform === 'linux'
  && spawnSync('systemctl', ['--user', 'is-system-running'], { stdio: 'ignore', timeout: 2000 }).status === 0;

const socketLimits = { maxFrameBytes: MAX_NODE_WORKER_LIFECYCLE_BYTES, maxBufferedBytes: 4 * 1024 * 1024,
  reservedControlBytes: 16 * 1024, reservedLifecycleBytes: 4 * 1024, maxDrainWaiters: 64, drainTimeoutMs: 5000 };
interface ControllerSocketData {
  readonly authority: AuthenticatedNodeChannel;
  readonly physical: AbortController;
  handshake?: ControllerNodeHandshake;
  writer?: NodeSocketWriter;
  client?: NodeSessionClient;
  bulk?: NodeBulkSessionChannel;
}

export interface ControllerFixtureConnection {
  readonly client: NodeSessionClient;
  readonly signal: AbortSignal;
  readonly received: Set<(frame: NodeWorkerApplicationFrame, text: string) => void>;
  readonly bulk: Promise<NodeBulkSessionChannel>;
  readonly bulkReceived: Set<(frame: NodeWorkerBulkFrame) => void>;
  validate(): void;
}

export interface NodeSessionFixtureOptions {
  readonly clock?: LeaseClock;
  readonly controllerClock?: LeaseClock;
  readonly scheduleControllerTimeout?: ControllerNodeHandshakeOptions['scheduleTimeout'];
  readonly scheduleHeartbeat?: NodeControllerHandshakeOptions['scheduleHeartbeat'];
  readonly beforeWorkerConfiguration?: () => Promise<void>;
  readonly sessionCommand?: [string, ...string[]];
  readonly replay?: NodeReplayOptions;
  readonly maxOperations?: number;
  readonly instance?: Pick<NodeInstanceConfiguration, 'agentId' | 'environment'>;
  readonly beforeCleanup?: () => Promise<void>;
}

export async function createNodeSessionFixture(certificate: TestCertificate, trust: ControllerTlsTrust = certificate.trust,
  options: NodeSessionFixtureOptions = {}) {
  const storage = await mkdtemp(path.join(homedir(), 'garcon-session-wss-'));
  const directory = await createNodeWorkerWorkingDirectory(storage);
  const nodeId = `synthetic-${randomUUID()}`;
  const pairings = new NodePairingStore(storage); await pairings.init();
  const enrollment = await pairings.issueEnrollment(nodeId);
  const paired = await pairings.enroll({ version: 1, nodeId, controllerId: pairings.controllerId, token: enrollment.token });
  const marker = await NodeSessionMarkerFile.acquire({ runtimeDirectory: storage, nodeId, controllerId: pairings.controllerId,
    onCompromised() { throw new Error('Synthetic marker ownership lost'); } });
  const processes = new Map<object, Subprocess<'pipe', 'pipe', 'ignore'>>();
  const containmentRequests: NodeWorkerContainmentRequest[] = [];
  const approvedNodeIds = new Set([nodeId]);
  const instanceIds = new Set(['synthetic-instance']);
  const workerFrames = new Set<(frame: NodeWorkerApplicationFrame) => void>();
  const nodeFrames = new Set<(frame: NodeWorkerApplicationFrame) => boolean | void>();
  const controllerFrames = new Set<(frame: NodeWorkerApplicationFrame) => boolean>();
  let outputPressure: { minimumRecordBytes: number; blocked: PromiseWithResolvers<void>; active: boolean } | null = null;
  let socketBacklog: { bytes: number; writer: NodeSocketWriter } | null = null;
  let nodeWriter: NodeSocketWriter | null = null;
  const controllers = new Map<string, PromiseWithResolvers<ControllerFixtureConnection>>();
  const controllerBindings = new Map<string, { binding: NodeBulkSessionBinding; connection: ControllerFixtureConnection;
    ready: PromiseWithResolvers<NodeBulkSessionChannel>; channel: NodeBulkSessionChannel | null }>();
  const connectionKey = (session: NodeSessionIdentity, connectionId: number) =>
    JSON.stringify([session.controllerBootId, session.nodeBootId, session.logicalSessionId, connectionId]);
  const controllerFor = (session: NodeSessionIdentity, connectionId: number) => {
    const key = connectionKey(session, connectionId);
    let pending = controllers.get(key);
    if (!pending) { pending = Promise.withResolvers<ControllerFixtureConnection>(); controllers.set(key, pending); }
    return pending;
  };
  let output: { session: NodeSessionIdentity; retirements: NodeOutputRetirements; bridge: NodeSessionBridge | null } | null = null;
  const coordinator = new NodeSessionCoordinator({
    supervisor: { clock: options.clock },
    configuration: { role: 'session', nodeId, storageDirectory: storage, replay: options.replay ?? DEFAULT_NODE_REPLAY,
      instances: [{ id: 'synthetic-instance', agentId: options.instance?.agentId ?? 'direct-anthropic-compatible', label: 'Synthetic', homeDirectory: path.join(storage, 'native'),
        environment: options.instance?.environment ?? {}, workspaceIds: ['synthetic-workspace'], maxOperations: options.maxOperations ?? 1 }],
      workspaces: [{ id: 'synthetic-workspace', projectPath: storage }] },
    host: { nodeId, marker, helperWorkingDirectory: marker.helperWorkingDirectory, command: options.sessionCommand ?? nodeWorkerCommand('session'),
      async helper(request, helperOptions) {
        if (request.kind === 'stop') await options.beforeCleanup?.();
        return runSystemdHelper(request, helperOptions);
      },
      launchOptions: { workingDirectory: directory.path, environment: { BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS } },
      spawn(launch) {
        const child = Bun.spawn([...launch.argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
        const process = { exited: child.exited, closeInput() { void child.stdin.end(); }, kill() { child.kill(); } };
        processes.set(process, child); return process;
      } },
    createPeer(host, peerOptions) {
      const child = processes.get(host.process);
      if (!child) throw new Error('Synthetic worker missing');
      const peer = new NodeWorkerPeer(child, { ...peerOptions, clock: options.clock, containmentRequested(request) {
        containmentRequests.push(request);
        peerOptions.containmentRequested?.(request);
      } });
      if (options.beforeWorkerConfiguration) {
        const configure = peer.configure.bind(peer);
        peer.configure = async (...args) => {
          await options.beforeWorkerConfiguration!();
          return configure(...args);
        };
      }
      return peer;
    }, received(frame, text) {
      if (!output) throw new Error('Synthetic worker has no logical output owner');
      if (outputPressure && frame.type === 'node-worker-output-delivery'
        && parseNodeWorkerOutputText(frame.payload)!.descriptor.byteLength >= outputPressure.minimumRecordBytes) {
        outputPressure.active = true;
        outputPressure.blocked.resolve();
      }
      if (output.bridge) output.bridge.receiveWorker(frame, text);
      else if (frame.type === 'node-worker-output-retired') output.retirements.record(frame);
      for (const listener of workerFrames) listener(frame);
    },
  });
  const connections = new NodeSessionConnectionOwner(coordinator);
  const authentication = new NodeChannelAuthentication({ pairings, transport: new NodeEnrollmentTransport({ listenerUsesTls: true }),
    authorize(principal) { if (!approvedNodeIds.has(principal.nodeId)) throw new DomainError('NODE_REMOVED', 'Synthetic node unavailable', 403); } });
  let requests = 0; let upgrades = 0; let bulkUpgrades = 0; let controllerBootId = 'synthetic-controller-boot';
  const accepted: ControllerNodeHandshake[] = [];
  const sessionAdmissions: NodeSessionAccepted[] = [];
  const clients: NodeClientSocket[] = [];
  const server = Bun.serve<ControllerSocketData>({ hostname: '0.0.0.0', port: 0, tls: { cert: certificate.cert, key: certificate.key },
    fetch(request, server) {
      requests++;
      let authority: AuthenticatedNodeChannel;
      try { authority = authentication.authenticate(request, server); }
      catch (error) { return Response.json({ errorCode: error instanceof DomainError ? error.code : 'NODE_UNAVAILABLE' },
        { status: error instanceof DomainError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } }); }
      if (server.upgrade(request, { data: { authority, physical: new AbortController() } })) {
        if (authority.kind === 'session') upgrades++; else bulkUpgrades++;
        return;
      }
      authority.releaseHandshake(); return new Response(null, { status: 400 });
    },
    websocket: {
      maxPayloadLength: MAX_NODE_WORKER_LIFECYCLE_BYTES, perMessageDeflate: false,
      open(socket) {
        const { authority, physical } = socket.data;
        const writer = socket.data.writer = new NodeSocketWriter(serverNodeSocketPort(socket), { ...socketLimits, signal: physical.signal });
        if (authority.kind === 'bulk') {
          let owner: ReturnType<typeof controllerBindings.get>;
          const channel = socket.data.bulk = new NodeBulkSessionChannel(writer, { side: 'controller', principal: authority.principal, signal: physical.signal,
            validate() { physical.signal.throwIfAborted(); authority.validate(); },
            capture(principal, session, connectionId) {
              owner = controllerBindings.get(connectionKey(session, connectionId));
              if (!owner || owner.binding.principal.nodeId !== principal.nodeId
                || owner.binding.principal.controllerId !== principal.controllerId) throw new Error('Synthetic bulk socket has no current control connection');
              owner.binding.validate(); owner.channel?.close(); owner.channel = channel;
              return owner.binding;
            },
            received(frame) { for (const listener of owner!.connection.bulkReceived) listener(frame); },
            disconnected() { physical.abort(); authority.releaseHandshake(); } });
          void channel.ready.then(() => { authority.releaseHandshake(); owner!.ready.resolve(channel); }, () => authority.releaseHandshake());
          return;
        }
        const handshake = socket.data.handshake = new ControllerNodeHandshake(writer, { controllerId: pairings.controllerId, controllerBootId,
          nodeId: authority.principal.nodeId, signal: physical.signal, clock: options.controllerClock ?? options.clock,
          scheduleTimeout: options.scheduleControllerTimeout,
          validate() { physical.signal.throwIfAborted(); authority.validate(); },
          accepted(connection) {
            sessionAdmissions.push(connection);
            const received = new Set<(frame: NodeWorkerApplicationFrame, text: string) => void>();
            const validate = () => { physical.signal.throwIfAborted(); authority.validate(); };
            const client = socket.data.client = new NodeSessionClient(writer, { session: connection.session,
              connectionId: connection.connectionId, instanceIds, signal: physical.signal, validate,
              received(frame, text) { for (const listener of received) listener(frame, text); },
              disconnected() { physical.abort(); } });
            const bulk = Promise.withResolvers<NodeBulkSessionChannel>(); void bulk.promise.catch(() => {});
            const fixtureConnection: ControllerFixtureConnection = { client, signal: physical.signal, received, validate,
              bulk: bulk.promise, bulkReceived: new Set() };
            const key = connectionKey(connection.session, connection.connectionId);
            const owner = { binding: { principal: authority.principal, session: connection.session, connectionId: connection.connectionId, instanceIds,
              signal: physical.signal, validate }, connection: fixtureConnection, ready: bulk, channel: null };
            controllerBindings.set(key, owner);
            physical.signal.addEventListener('abort', () => {
              if (controllerBindings.get(key) === owner) controllerBindings.delete(key);
              bulk.reject(new Error('Synthetic control connection closed'));
            }, { once: true });
            void handshake.ready.then(() => controllerFor(connection.session, connection.connectionId).resolve(fixtureConnection), () => {});
          },
          disconnected() { physical.abort(); authority.releaseHandshake(); } });
        accepted.push(handshake);
        void handshake.ready.then(() => authority.releaseHandshake(), () => authority.releaseHandshake());
        handshake.start();
      },
      message(socket, message) {
        if (typeof message !== 'string') socket.terminate();
        else if (socket.data.bulk) socket.data.bulk.receive(message);
        else {
          const frame = parseNodeWorkerApplicationText(message);
          if (frame) {
            if (!socket.data.client) socket.terminate();
            else if ([...controllerFrames].every((accept) => accept(frame))) socket.data.client.receive(message);
          } else socket.data.handshake?.receive(message);
        }
      },
      drain(socket) { socket.data.writer?.drain(); },
      close(socket) { socket.data.physical.abort(); socket.data.handshake?.close(); socket.data.authority.releaseHandshake(); },
    },
  });
  const pairing: ExecutionNodePairing = { ...paired, controllerUrl: `https://127.0.0.1:${server.port}`, trust };
  const connect = (configured: ExecutionNodePairing = pairing) => {
    const physical = new AbortController();
    const ready = Promise.withResolvers<NodeHostedConnection>();
    const closed = Promise.withResolvers<void>();
    const socket = createNodeControllerSocket(configured); clients.push(socket);
    let handshake: NodeControllerHandshake | null = null;
    let bridge: NodeSessionBridge | null = null;
    let bulk: NodeBulkSessionChannel | null = null;
    const deadline = setTimeout(() => { ready.reject(new Error('Synthetic node handshake timeout')); physical.abort(); socket.terminate(); }, 8000);
    socket.addEventListener('open', () => {
      const port = clientNodeSocketPort(socket);
      const writer: NodeSocketWriter = nodeWriter = new NodeSocketWriter({
        get open() { return port.open; },
        get bufferedBytes() { return Math.max(port.bufferedBytes, socketBacklog?.writer === writer ? socketBacklog.bytes : 0,
          outputPressure?.active ? socketLimits.maxBufferedBytes - socketLimits.reservedControlBytes : 0); },
        bufferedFrameBytes: (bytes) => port.bufferedFrameBytes(bytes),
        send: (text) => port.send(text), terminate: () => port.terminate(),
      }, { ...socketLimits, signal: physical.signal });
      handshake = new NodeControllerHandshake(writer, { controllerId: pairing.controllerId, nodeId, signal: physical.signal, supervisor: coordinator.supervisor,
        clock: options.clock, scheduleHeartbeat: options.scheduleHeartbeat,
        connect: (boot, signal) => connections.connect(boot, signal), validate() { physical.signal.throwIfAborted(); },
        connected(connection) {
          if (!output || !sameNodeSession(output.session, connection.lease.session)) {
            output = { session: connection.lease.session, bridge: null,
              retirements: new NodeOutputRetirements({ session: connection.lease.session, instanceIds, signal: connection.lease.authoritySignal }) };
          }
        },
        ready(connection) {
          bridge = new NodeSessionBridge(writer, { connection, instanceIds, coordinator, retirements: output!.retirements,
            bulk: { send(frame) { return bulk?.send(frame) ?? false; }, close() { bulk?.close(); } },
            signal: AbortSignal.any([physical.signal, connection.lease.signal]), validate() { physical.signal.throwIfAborted(); },
            disconnected() { physical.abort(); } });
          output!.bridge = bridge;
          const bulkSocket = createNodeBulkSocket(configured); clients.push(bulkSocket);
          const bulkPhysical = new AbortController();
          const closeBulk = () => { bulkPhysical.abort(); bulkSocket.terminate(); };
          const controlSignal = AbortSignal.any([physical.signal, connection.lease.signal]);
          controlSignal.addEventListener('abort', closeBulk, { once: true });
          bulkSocket.addEventListener('open', () => {
            const bulkWriter = new NodeSocketWriter(clientNodeSocketPort(bulkSocket), { ...socketLimits, signal: bulkPhysical.signal });
            bulk = new NodeBulkSessionChannel(bulkWriter, { side: 'node', signal: bulkPhysical.signal,
              binding: { principal: { controllerId: configured.controllerId, nodeId: configured.nodeId }, session: connection.lease.session, connectionId: connection.connectionId, instanceIds, signal: controlSignal,
                validate() { coordinator.supervisor.assertConnection(connection.lease); } },
              validate() { bulkPhysical.signal.throwIfAborted(); }, disconnected: closeBulk,
              received(frame) {
                const submission = coordinator.peer(connection).forward(frame, bulkPhysical.signal);
                void submission.drained.catch(closeBulk);
              } });
            bulk.start();
          });
          bulkSocket.addEventListener('message', (event) => {
            if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_NODE_WORKER_LIFECYCLE_BYTES) closeBulk();
            else bulk?.receive(event.data);
          });
          bulkSocket.addEventListener('error', closeBulk);
          bulkSocket.addEventListener('close', () => { controlSignal.removeEventListener('abort', closeBulk); bulkPhysical.abort(); });
          ready.resolve(connection);
        }, disconnect(connection) { void coordinator.disconnect(connection).catch(ready.reject); },
        disconnected(error) { physical.abort(); ready.reject(error); } });
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_NODE_WORKER_LIFECYCLE_BYTES) { physical.abort(); socket.terminate(); return; }
      const frame = parseNodeWorkerApplicationText(event.data);
      if (frame) {
        for (const listener of nodeFrames) if (listener(frame) === false) return;
        if (bridge) bridge.receive(event.data); else socket.terminate();
      } else handshake?.receive(event.data);
    });
    socket.addEventListener('error', () => { ready.reject(new Error('Synthetic socket rejected')); physical.abort(); socket.terminate(); });
    socket.addEventListener('close', () => { clearTimeout(deadline); physical.abort(); handshake?.close(); ready.reject(new Error('Synthetic socket closed')); closed.resolve(); });
    void ready.promise.then(() => clearTimeout(deadline), () => clearTimeout(deadline));
    return { ready: ready.promise, closed: closed.promise, socket, stop() { physical.abort(); socket.terminate(); } };
  };
  return { storage, pairing, pairings, connect, coordinator, marker, processes, accepted, sessionAdmissions, workerFrames, controllerFrames, nodeFrames, containmentRequests,
    async pairAnotherNode() {
      const id = `synthetic-${randomUUID()}`;
      const enrollment = await pairings.issueEnrollment(id);
      const paired = await pairings.enroll({ version: 1, nodeId: id, controllerId: pairings.controllerId, token: enrollment.token });
      approvedNodeIds.add(id);
      return { ...pairing, nodeId: id, credential: paired.credential };
    },
    holdOutputAdmission(minimumRecordBytes: number) {
      if (outputPressure) throw new Error('Synthetic output pressure is already active');
      const pressure = outputPressure = { minimumRecordBytes, blocked: Promise.withResolvers<void>(), active: false };
      return { blocked: pressure.blocked.promise, release() {
        if (outputPressure === pressure) outputPressure = null;
        nodeWriter?.drain();
      } };
    },
    holdOrdinarySocketAdmission() {
      if (socketBacklog || !nodeWriter) throw new Error('Synthetic socket pressure is unavailable');
      const captured = socketBacklog = { bytes: socketLimits.maxBufferedBytes - socketLimits.reservedControlBytes, writer: nodeWriter };
      return { release() {
        if (socketBacklog === captured) socketBacklog = null;
        captured.writer.drain();
      } };
    },
    holdApplicationSocketAdmission() {
      if (socketBacklog || !nodeWriter) throw new Error('Synthetic socket pressure is unavailable');
      const captured = socketBacklog = { bytes: socketLimits.maxBufferedBytes - socketLimits.reservedLifecycleBytes, writer: nodeWriter };
      return { get remainingBytes() { return captured.bytes; }, drain(bytes: number) {
        if (!Number.isSafeInteger(bytes) || bytes < 1 || socketBacklog !== captured) throw new Error('Invalid synthetic socket drainage');
        captured.bytes = Math.max(0, captured.bytes - bytes); captured.writer.drain();
      }, release() {
        if (socketBacklog === captured) socketBacklog = null;
        captured.writer.drain();
      } };
    },
    controller(connection: NodeHostedConnection) { return controllerFor(connection.lease.session, connection.connectionId).promise; },
    requests: () => requests, upgrades: () => upgrades, bulkUpgrades: () => bulkUpgrades,
    restartController() { controllerBootId = 'synthetic-next-controller-boot'; },
    async dispose() {
      for (const client of clients) client.terminate();
      await server.stop(true);
      const cleaned = await coordinator.shutdown();
      await marker.release();
      if (cleaned) await rm(storage, { recursive: true, force: true });
      expect(cleaned).toBe(true);
    } };
}
