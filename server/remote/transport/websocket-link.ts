import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  connectNoiseWebSocket, createNoiseServer,
  type NoiseErrorCode, type NoiseLimits, type NoiseOptions, type NoiseSocketData, type NoiseWebSocket,
} from '@cfal/noise-ws';
import { isExecutorSecret } from './connection-url.js';
import { failureReason } from './failure-reason.js';
import { MessageContinuityError } from './message-session.js';
import { SESSION_SOCKET_BUFFER_BYTES, SessionSocketFrames } from './session-socket.js';
import { SessionTransport } from './session-transport.js';
import { EXECUTOR_PROTOCOL_REVISION } from './rpc-protocol.js';
import { version as packageVersion } from '../../../package.json';
import { isLinkHello, type LinkHello, type LinkDialTarget, type LinkRole } from './link-handshake.js';
import { isSessionId, type RpcLane } from './rpc-lane.js';
import { MessageQueueBudget, type MessageQueueSnapshot } from './message-queue-budget.js';
import type { ExecutorSocketAdmission, SocketAdmissionLease } from './socket-admission.js';

export interface WebSocketLinkOptions {
  readonly role: LinkRole;
  readonly executorId?: string;
  readonly secret: string;
  readonly runtimeId?: string;
  readonly noTls?: boolean;
  readonly allowUnverifiedTls?: boolean;
  readonly maxQueuedBytes?: number;
  readonly maxQueuedFrames?: number;
  // Delays before successive redials; the last one repeats.
  readonly redialDelaysMs?: readonly number[];
  // How long a session must stay up before losing it restarts the redial delays.
  readonly stableSessionMs?: number;
  // Noise's timeouts, buffer, and per-key record budget, when not its defaults.
  readonly noiseLimits?: NoiseLimits;
  readonly socketAdmission?: ExecutorSocketAdmission;
}

export interface ExecutorListenerTls {
  readonly cert: string;
  readonly key: string;
}

export const EXECUTOR_NOISE_CONTEXT = 'garcon-executor/v1';
const LISTENER_STOP_SETTLE_MS = 25;

// Peers must share both the release and the wire protocol revision.
const LINK_VERSION = `${packageVersion}+protocol.${EXECUTOR_PROTOCOL_REVISION}`;

// VS Code's reconnection delays: one immediate attempt, then backing off to 30 s.
// https://github.com/microsoft/vscode/blob/815dd9c54b76316974aa8fe7d485375e2bc3b194/src/vs/platform/remote/common/remoteAgentConnection.ts#L649-L663
export const REDIAL_DELAYS_MS = [0, 5_000, 5_000, 10_000, 10_000, 10_000, 10_000, 10_000, 30_000];
// A lost session that lasted this long is redialed at once. A peer that drops each
// session right after it opens, such as one failing initialization, is backed off.
const STABLE_SESSION_MS = 10_000;
// Sockets a link holds at once, including those still authenticating.
const MAX_SOCKETS = 4;

// Why a connection carrying a session closed; each closure retires its session.
export type LinkClosureCause =
  | 'liveness-timeout'
  | 'socket-closed'
  | 'socket-error'
  | 'protocol-error'
  | 'record-limit'
  | 'session-retired'
  | 'local-close';

export interface LinkClosure {
  readonly lane: RpcLane;
  readonly sessionId: string;
  readonly primarySessionId: string;
  readonly cause: LinkClosureCause;
  readonly queues: MessageQueueSnapshot | null;
  readonly primaryRedials: number;
  // Closures with this cause over the link's lifetime, including this one.
  readonly count: number;
  // Why the connection or its session failed, when known: the Noise error
  // code, or the error that retired the session.
  readonly reason?: string;
}

// A connection that failed to open, to authenticate, or to keep its session.
export interface LinkFailure {
  // Listener failures before a valid peer hello have no known lane.
  readonly lane?: RpcLane;
  readonly message: string;
  // Failures of this kind since the last session started, including this one.
  // A kind whose message or reason changes, such as a mismatch with another
  // build, counts again from one.
  readonly count: number;
  // Why a peer that holds the secret failed to authenticate or lost its connection.
  readonly reason?: string;
}

type LinkFailureKind = NoiseErrorCode | 'authentication-timeout' | 'authentication-failed' | 'version-mismatch' | 'connection-lost';

// Logs keep each kind of failure at its 1st, 2nd, 4th, 8th, ... occurrence since
// the last session started. A peer without the secret reaches only kinds whose
// message is fixed, so it cannot flood them by failing repeatedly or by
// alternating between failures.
export function shouldLogLinkFailure(failure: LinkFailure): boolean {
  return Number.isInteger(Math.log2(failure.count));
}

interface Connection {
  readonly socket: NoiseWebSocket;
  hello: LinkHello | null;
  readonly timeout: ReturnType<typeof setTimeout>;
  peer: LinkHello | null;
  session: SessionTransport | null;
  hooks: ReturnType<SessionTransport['attach']> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  lastReceivedAt: number;
  closed: boolean;
  authenticated: boolean;
  frames: SessionSocketFrames | null;
  closeCause: LinkClosureCause | null;
  closeReason: string | null;
  sessionStartedAt: number | null;
}

export class WebSocketLink {
  readonly runtimeId: string;
  readonly ready: Promise<SessionTransport>;
  readonly #ready = Promise.withResolvers<SessionTransport>();
  readonly #sessions = new Set<(session: SessionTransport) => void>();
  readonly #bulkSessions = new Set<(session: SessionTransport) => void>();
  readonly #quiesceListeners = new Set<() => void>();
  readonly #queueBudget = new MessageQueueBudget();
  readonly #socketLeases = new Map<NoiseWebSocket, SocketAdmissionLease>();
  readonly #connections = new Set<Connection>();
  readonly #sockets = new Set<NoiseWebSocket>();
  readonly #errors = new Set<(failure: LinkFailure) => void>();
  readonly #failures = new Map<string, LinkFailure>();
  readonly #closures = new Set<(closure: LinkClosure) => void>();
  readonly #closureCounts = new Map<string, number>();
  #current: SessionTransport | null = null;
  #bulk: SessionTransport | null = null;
  #bulkGrant: { primary: SessionTransport; id: string } | null = null;
  #bulkDial: NoiseWebSocket | null = null;
  #dialUrl: string | null = null;
  #disposed = false;
  #quiescing = false;
  #dialTimer: ReturnType<typeof setTimeout> | null = null;
  #server: ReturnType<typeof Bun.serve<NoiseSocketData>> | null = null;
  #listenerNoise: ReturnType<typeof createNoiseServer> | null = null;
  #dialing = false;
  // Redials since the last stable session, which index the redial delays.
  #redials = 0;

  constructor(private readonly options: WebSocketLinkOptions) {
    if (!isExecutorSecret(options.secret)) throw new Error('Executor shared secret must be a canonical base64url 32-byte key');
    if (options.role === 'controller' && !options.executorId) throw new Error('Controller executor ID is required');
    if (options.redialDelaysMs && (options.redialDelaysMs.length === 0
      || options.redialDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0))) {
      throw new Error('Executor redial delays must be non-negative integers');
    }
    this.runtimeId = options.runtimeId ?? crypto.randomUUID();
    this.ready = this.#ready.promise;
    void this.ready.catch(() => undefined);
  }

  get current(): SessionTransport | null { return this.#current; }
  get bulk(): SessionTransport | null { return this.#bulk; }
  get role(): LinkRole { return this.options.role; }
  get isDialer(): boolean { return this.#dialing; }
  get quiescing(): boolean { return this.#quiescing || this.#disposed; }
  get executorId(): string | null { return this.options.role === 'controller' ? this.options.executorId! : this.#current?.executorId ?? null; }
  get acceptsSocket(): boolean {
    return !this.#disposed && !this.#quiescing && (this.#sockets.size < MAX_SOCKETS || this.#displaceableSocket() !== null);
  }

  onError(listener: (failure: LinkFailure) => void): () => void {
    this.#errors.add(listener);
    return () => { this.#errors.delete(listener); };
  }

  onClosure(listener: (closure: LinkClosure) => void): () => void {
    this.#closures.add(listener);
    return () => { this.#closures.delete(listener); };
  }

  upgrade(request: Request, server: Pick<Bun.Server<NoiseSocketData>, 'upgrade'>, noise: ReturnType<typeof createNoiseServer>): Response | undefined {
    if (!this.acceptsSocket) return new Response(null, { status: 503 });
    const lease = this.options.socketAdmission?.acquire();
    if (this.options.socketAdmission && !lease) return new Response(null, { status: 503 });
    // A peer without the secret never finishes the encrypted handshake, so a full
    // link makes room by closing a socket still in that handshake. Only an upgrade
    // the server will accept may do so, so a refused request cannot close a socket.
    if (this.#sockets.size >= MAX_SOCKETS) {
      if (!isWebSocketUpgrade(request)) { lease?.release(); return new Response(null, { status: 400 }); }
      this.#displaceableSocket()?.close();
    }
    const options = this.#noiseOptions();
    let upgraded = false;
    try {
      return noise.upgrade(request, {
        upgrade: (request, upgradeOptions) => {
          // Reserves ownership before the native upgrade, including unauthenticated sockets.
          this.#sockets.add(upgradeOptions!.data!.connection);
          const socket = upgradeOptions!.data!.connection;
          if (lease) this.#socketLeases.set(socket, lease);
          upgraded = server.upgrade(request, upgradeOptions);
          if (!upgraded) { this.#sockets.delete(socket); this.#socketLeases.delete(socket); }
          return upgraded;
        },
      }, options);
    } finally { options.psk.fill(0); if (!upgraded) lease?.release(); }
  }

  onSession(listener: (session: SessionTransport) => void): () => void {
    this.#sessions.add(listener);
    if (this.#current) listener(this.#current);
    return () => { this.#sessions.delete(listener); };
  }

  onBulkSession(listener: (session: SessionTransport) => void): () => void {
    this.#bulkSessions.add(listener);
    if (this.#bulk) listener(this.#bulk);
    return () => { this.#bulkSessions.delete(listener); };
  }

  onQuiesce(listener: () => void): () => void {
    this.#quiesceListeners.add(listener);
    return () => { this.#quiesceListeners.delete(listener); };
  }

  prepareBulk(primary: SessionTransport, id: string): void {
    if (this.quiescing || this.#current !== primary || !primary.connected || !isSessionId(id)) throw new Error('Bulk parent is unavailable');
    this.fenceBulk();
    this.#bulkGrant = { primary, id };
  }

  fenceBulk(): void {
    this.#bulkGrant = null;
    const socket = this.#bulkDial;
    this.#bulkDial = null;
    const bulk = this.#bulk;
    this.#bulk = null;
    bulk?.close();
    socket?.close();
    for (const connection of this.#connections) {
      if (connection.hello?.lane === 'bulk' || connection.peer?.lane === 'bulk') this.#close(connection, 'local-close');
    }
  }

  dialBulk(primary: SessionTransport, id: string): void {
    if (this.quiescing || !this.#dialUrl || this.#bulkDial || this.#bulk
      || this.#bulkGrant?.primary !== primary || this.#bulkGrant.id !== id) throw new Error('Bulk dial is not authorized');
    const options = this.#noiseOptions({ lane: 'bulk', sessionId: id, primarySessionId: primary.id });
    try {
      const socket = connectNoiseWebSocket(this.#dialUrl, { ...options, allowUnverifiedTls: this.options.allowUnverifiedTls });
      if (socket.readyState !== 'closed') {
        this.#bulkDial = socket;
        this.#sockets.add(socket);
      }
    } finally { options.psk.fill(0); }
  }

  listen(port = 0, hostname = '0.0.0.0', tls?: ExecutorListenerTls): string {
    if (tls && this.options.noTls) throw new Error('TLS credentials and no-TLS mode are mutually exclusive');
    if (!tls && !this.options.noTls) throw new Error('A listener requires TLS credentials or explicit no-TLS mode');
    if (this.#server || this.#disposed) throw new Error('Executor listener cannot start');
    const noise = createNoiseServer({ maxConnections: MAX_SOCKETS, maxPendingHandshakes: MAX_SOCKETS });
    this.#listenerNoise = noise;
    this.#server = Bun.serve<NoiseSocketData>({
      hostname, port, tls,
      fetch: (request, server) => {
        if (new URL(request.url).pathname !== '/executor') return new Response(null, { status: 404 });
        return this.upgrade(request, server, noise);
      },
      websocket: noise.websocket,
    });
    const address = new URL(this.#server.url);
    address.protocol = tls ? 'wss:' : 'ws:';
    address.pathname = '/executor';
    if (address.hostname === '0.0.0.0') address.hostname = '127.0.0.1';
    return address.href;
  }

  dial(url: string): void {
    if (this.#dialing || this.#disposed || this.#quiescing) throw new Error('Executor dial loop cannot start');
    const target = new URL(url);
    if (target.protocol !== 'wss:' && !(target.protocol === 'ws:' && this.options.noTls)) {
      throw new Error('Executor connections require TLS unless no-TLS mode is explicit');
    }
    if (target.hash || target.username || target.password) throw new Error('Executor network URL must not contain userinfo or a fragment');
    this.#dialing = true;
    this.#dialUrl = url;
    const connect = () => {
      this.#dialTimer = null;
      if (this.#disposed || this.#quiescing) return;
      // Noise remains mandatory when outer TLS is unverified. Optional certificate pinning
      // awaits https://github.com/oven-sh/bun/issues/43635.
      const options = this.#noiseOptions({ lane: 'primary', sessionId: null, primarySessionId: null });
      let socket: NoiseWebSocket;
      try {
        socket = connectNoiseWebSocket(url, { ...options, allowUnverifiedTls: this.options.allowUnverifiedTls });
      } finally { options.psk.fill(0); }
      if (socket.readyState !== 'closed') this.#sockets.add(socket);
      void socket.closed.then(() => {
        if (this.#disposed || this.#quiescing) return;
        const delays = this.options.redialDelaysMs ?? REDIAL_DELAYS_MS;
        this.#dialTimer = setTimeout(connect, delays[Math.min(this.#redials++, delays.length - 1)]);
      });
    };
    connect();
  }

  disconnect(): void {
    for (const connection of this.#connections) connection.closeCause ??= 'local-close';
    for (const socket of this.#sockets) socket.close();
  }

  quiesce(): void {
    this.#quiescing = true;
    if (this.#dialTimer) clearTimeout(this.#dialTimer);
    this.#dialTimer = null;
    for (const listener of this.#quiesceListeners) listener();
    for (const socket of this.#sockets) if (socket.readyState !== 'open') socket.close();
    for (const connection of this.#connections) if (!connection.hooks) this.#close(connection, 'local-close');
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#dialTimer) clearTimeout(this.#dialTimer);
    this.#ready.reject(new Error('Executor connector disposed'));
    this.#current?.close();
    this.fenceBulk();
    this.disconnect();
    this.#sessions.clear();
    this.#bulkSessions.clear();
    this.#quiesceListeners.clear();
    this.#errors.clear();
    this.#closures.clear();
    this.#listenerNoise?.close();
    this.#listenerNoise = null;
    const server = this.#server;
    this.#server = null;
    // Bun starts listener shutdown synchronously but may retain a closed WebSocket in its
    // active set indefinitely. Bounds only the bookkeeping wait so callers can reuse the port.
    const stopped = server?.stop(true).catch(() => undefined);
    if (stopped) await Promise.race([stopped, Bun.sleep(LISTENER_STOP_SETTLE_MS)]);
  }

  #noiseOptions(target?: LinkDialTarget): NoiseOptions {
    let connection: Connection | null = null;
    return {
      psk: Buffer.from(this.options.secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT, limits: this.options.noiseLimits,
      onOpen: (socket) => {
        if (this.#disposed || this.#quiescing) { socket.close(); return; }
        connection = this.#open(socket, target);
      },
      onMessage: (socket, message) => {
        if (connection) this.#receive(connection, message);
        else socket.close();
      },
      onError: (_socket, error) => {
        if (connection) {
          connection.closeCause ??= NOISE_CLOSURE_CAUSES[error.code];
          connection.closeReason ??= `Encrypted connection failed (${error.code})`;
        }
        // Noise reports a socket this link closed before it opened as CLOSED, which is not the peer failing.
        if (error.code !== 'CLOSED') this.#reportFailure(error.code, `Executor encrypted connection failed (${error.code})`, undefined, connection?.hello?.lane ?? target?.lane);
      },
      onClose: (socket) => {
        this.#sockets.delete(socket);
        this.#socketLeases.get(socket)?.release();
        this.#socketLeases.delete(socket);
        if (this.#bulkDial === socket) this.#bulkDial = null;
        if (connection) this.#closed(connection);
      },
    };
  }

  #open(socket: NoiseWebSocket, target?: LinkDialTarget): Connection {
    const hello = target ? this.#hello(target) : null;
    const connection: Connection = {
      socket, hello, peer: null, session: null, hooks: null, heartbeat: null,
      closed: false, authenticated: false, frames: null, lastReceivedAt: Date.now(), closeCause: null, closeReason: null, sessionStartedAt: null,
      timeout: setTimeout(() => {
        this.#reportFailure('authentication-timeout', 'Executor authentication timed out', undefined, connection.hello?.lane);
        this.#close(connection, 'protocol-error');
      }, 5000),
    };
    connection.timeout.unref();
    this.#connections.add(connection);
    try { if (hello) socket.send(JSON.stringify(hello)); } catch (error) { this.#close(connection, 'socket-error', error); }
    return connection;
  }

  #hello(target: LinkDialTarget, peer?: LinkHello): LinkHello {
    let sessionId = target.sessionId;
    if (target.lane === 'primary' && this.options.role === 'controller') sessionId = crypto.randomUUID();
    return {
      type: 'hello', version: LINK_VERSION, role: this.options.role,
      executorId: this.options.executorId ?? this.#current?.executorId ?? peer?.executorId ?? null,
      runtimeId: this.runtimeId, nonce: randomBytes(32).toString('hex'),
      lane: target.lane, sessionId, primarySessionId: target.primarySessionId,
    };
  }

  #receive(connection: Connection, message: string | Uint8Array): void {
    if (connection.closed || this.#disposed) return;
    connection.lastReceivedAt = Date.now();
    try {
      let encoded: string;
      if (typeof message === 'string') encoded = message;
      else {
        if (!connection.frames) throw new Error('Unauthenticated session fragment');
        const complete = connection.frames.receive(message);
        if (complete === null) return;
        encoded = complete;
      }
      if (connection.hooks) {
        if (encoded === '{"type":"ping"}') { this.#heartbeat(connection, 'pong'); return; }
        if (encoded === '{"type":"pong"}') return;
        if (typeof message === 'string') throw new MessageContinuityError('Session packets require binary framing');
        connection.hooks.receive(encoded);
        return;
      }
      if (Buffer.byteLength(encoded) > 8192) throw new Error('Handshake exceeds budget');
      const frame = parseHandshakeFrame(encoded);
      if (isLinkHello(frame) && !connection.peer) {
        if (frame.version !== LINK_VERSION) {
          this.#reportFailure('version-mismatch', `Executor version mismatch: local ${LINK_VERSION}, peer ${JSON.stringify(frame.version.slice(0, 80))}. Use matching builds.`, undefined, frame.lane);
          this.#close(connection, 'protocol-error');
          return;
        }
        if (frame.role === this.options.role) {
          throw new Error('Executor handshake mismatch');
        }
        connection.peer = frame;
        if (!connection.hello) {
          connection.hello = this.#hello(frame, frame);
          connection.socket.send(JSON.stringify(connection.hello));
        }
        this.#validateIdentity(connection);
        connection.socket.send(JSON.stringify({ type: 'proof', signature: this.#signature(connection, this.options.role) }));
        return;
      }
      if (!connection.peer || !frame || typeof frame !== 'object' || !('type' in frame) || frame.type !== 'proof'
        || !('signature' in frame) || typeof frame.signature !== 'string' || !/^[a-f0-9]{64}$/.test(frame.signature)
        || !timingSafeEqual(Buffer.from(frame.signature, 'hex'), Buffer.from(this.#signature(connection, connection.peer.role), 'hex'))) {
        throw new Error('Executor proof is missing or invalid');
      }
      connection.authenticated = true;
      this.#accept(connection);
    } catch (error) {
      // Closing the session closes this connection first, so the cause is recorded before.
      const reason = failureReason(error);
      connection.closeCause ??= 'protocol-error';
      connection.closeReason ??= reason;
      // Reported while the session is still current, so listeners learn of the loss before its closure.
      if (connection.authenticated) this.#reportFailure('connection-lost', 'Executor connection lost', reason, connection.hello?.lane);
      else this.#reportFailure('authentication-failed', 'Executor authentication failed', reason, connection.hello?.lane);
      if (error instanceof MessageContinuityError) connection.session?.close(error);
      this.#close(connection, 'protocol-error');
    }
  }

  #accept(connection: Connection): void {
    clearTimeout(connection.timeout);
    this.#validateIdentity(connection);
    const peer = connection.peer!;
    const hello = connection.hello!;
    const controller = hello.role === 'controller' ? hello : peer;
    const lane = hello.lane;
    const executorId = controller.executorId!;
    const sessionId = controller.sessionId!;
    if (lane === 'primary' ? this.#current : this.#bulk) throw new Error('Executor session already attached');
    const lease = this.#socketLeases.get(connection.socket);
    if (lease && !lease.promote(lane)) throw new Error('Executor socket role capacity exhausted');
    const session = new SessionTransport(sessionId, peer.runtimeId, (error) => {
      if (this.#current === session) this.#current = null;
      if (this.#bulk === session) this.#bulk = null;
      for (const attached of this.#connections) {
        if (attached.session === session) this.#retire(attached, error);
      }
    }, { ...this.options, budget: this.#queueBudget }, executorId, lane, hello.primarySessionId ?? sessionId);
    if (lane === 'primary') {
      this.#current = session;
      session.onAvailability((connected) => {
        if (!connected && this.#current === session) {
          this.#current = null;
          this.fenceBulk();
        }
      });
    } else this.#bulk = session;
    connection.session = session;
    try {
      for (const listener of lane === 'primary' ? this.#sessions : this.#bulkSessions) listener(session);
      // The session layer records why it retired before closing its socket, so a close
      // through the frames is a retirement for that reason unless a write failed.
      connection.frames = new SessionSocketFrames(
        connection.socket,
        () => this.#retire(connection, session.channel.failure),
        (error) => this.#close(connection, 'socket-error', error),
      );
      connection.hooks = session.attach(connection.frames);
    } catch (error) {
      session.close(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (connection.closed) { connection.hooks.disconnected(); return; }
    connection.sessionStartedAt = performance.now();
    for (const [key, failure] of this.#failures) {
      if (failure.lane === lane || (lane === 'primary' && failure.lane === undefined)) this.#failures.delete(key);
    }
    if (lane === 'primary') this.#ready.resolve(session);
    connection.heartbeat = setInterval(() => {
      try {
        if (Date.now() - connection.lastReceivedAt > 15_000) this.#close(connection, 'liveness-timeout');
        else this.#heartbeat(connection, 'ping');
      } catch (error) { this.#close(connection, 'socket-error', error); }
    }, 5000);
    connection.heartbeat.unref();
  }

  #heartbeat(connection: Connection, type: 'ping' | 'pong'): void {
    if (connection.socket.bufferedAmount < SESSION_SOCKET_BUFFER_BYTES) connection.socket.send(JSON.stringify({ type }));
  }

  #validateIdentity(connection: Connection): void {
    const hello = connection.hello!;
    const peer = connection.peer!;
    const controller = hello.role === 'controller' ? hello : peer;
    const worker = hello.role === 'worker' ? hello : peer;
    if (hello.lane !== peer.lane || !isSessionId(controller.sessionId)
      || worker.sessionId !== null && worker.sessionId !== controller.sessionId
      || worker.executorId !== null && worker.executorId !== controller.executorId
      || hello.primarySessionId !== peer.primarySessionId) throw new Error('Executor lane identity mismatch');
    if (hello.lane === 'primary') return;
    const grant = this.#bulkGrant;
    if (!grant || this.#current !== grant.primary || !grant.primary.connected
      || controller.sessionId !== grant.id || hello.primarySessionId !== grant.primary.id
      || controller.executorId !== grant.primary.executorId || peer.runtimeId !== grant.primary.peerRuntimeId) {
      throw new Error('Bulk connection is not authorized by the current primary');
    }
  }

  #signature(connection: Connection, purpose: LinkRole): string {
    const hello = connection.hello!;
    const peer = connection.peer!;
    const transcript = hello.role === 'controller' ? [hello, peer] : [peer, hello];
    return createHmac('sha256', this.options.secret).update(JSON.stringify(['garcon-executor', purpose, transcript])).digest('hex');
  }

  // The oldest socket whose peer has not proven the secret, or else the oldest
  // still finishing the handshake. A listener reaches 'confirming' only after
  // decrypting a first message keyed by the secret, so its peer holds the secret
  // or replayed an observed handshake.
  #displaceableSocket(): NoiseWebSocket | null {
    let confirming: NoiseWebSocket | null = null;
    for (const socket of this.#sockets) {
      if (socket.readyState === 'connecting' || socket.readyState === 'handshaking') return socket;
      if (socket.readyState === 'confirming') confirming ??= socket;
    }
    return confirming;
  }

  #reportFailure(kind: LinkFailureKind, message: string, reason?: string, lane?: RpcLane): void {
    if (this.#disposed) return;
    const key = `${lane ?? 'unclassified'}:${kind}`;
    const previous = this.#failures.get(key);
    const count = previous?.message === message && previous.reason === reason ? previous.count + 1 : 1;
    const failure: LinkFailure = { ...(lane === undefined ? {} : { lane }), message, count, ...(reason === undefined ? {} : { reason }) };
    this.#failures.set(key, failure);
    for (const listener of this.#errors) listener(failure);
  }

  #close(connection: Connection, cause: LinkClosureCause, failure?: unknown): void {
    connection.closeCause ??= cause;
    if (failure !== undefined && failure !== null) connection.closeReason ??= failureReason(failure);
    this.#closed(connection);
    connection.socket.close();
  }

  // Closing a session while the link is disposed is a local close, not a retirement.
  #retire(connection: Connection, failure: Error | null): void {
    if (this.#disposed) this.#close(connection, 'local-close');
    else this.#close(connection, 'session-retired', failure);
  }

  // A close this process did not start is the peer or network closing the socket.
  #closed(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.timeout);
    if (connection.heartbeat) clearInterval(connection.heartbeat);
    connection.frames?.dispose();
    this.#connections.delete(connection);
    if (connection.hello?.lane === 'primary' && connection.sessionStartedAt !== null
      && performance.now() - connection.sessionStartedAt >= (this.options.stableSessionMs ?? STABLE_SESSION_MS)) {
      this.#redials = 0;
    }
    if (connection.hooks && connection.session) this.#reportClosure(connection.session, connection.closeCause ?? 'socket-closed', connection.closeReason);
    connection.hooks?.disconnected();
  }

  #reportClosure(session: SessionTransport, cause: LinkClosureCause, reason: string | null): void {
    const key = `${session.lane}:${cause}`;
    const count = (this.#closureCounts.get(key) ?? 0) + 1;
    this.#closureCounts.set(key, count);
    const closure: LinkClosure = { cause, count, lane: session.lane, sessionId: session.id,
      primarySessionId: session.primarySessionId, queues: session.channel.queueSnapshot, primaryRedials: this.#redials,
      ...(reason === null ? {} : { reason }) };
    for (const listener of this.#closures) listener(closure);
  }
}

// Classifies a connection that Noise ended with an error. A busy long-lived link
// that uses up its per-key record budget must reconnect with fresh keys, which
// is routine rather than a protocol failure. Handshake timeouts and CLOSED end
// connections before they open, and NOT_OPEN only rejects a send, so no closure
// reports them.
const NOISE_CLOSURE_CAUSES = {
  TRANSPORT_CLOSED: 'socket-closed',
  RECORD_LIMIT: 'record-limit',
  TRANSPORT_ERROR: 'socket-error',
  BACKPRESSURE: 'socket-error',
  HANDSHAKE_TIMEOUT: 'liveness-timeout',
  MESSAGE_TIMEOUT: 'liveness-timeout',
  AUTHENTICATION_FAILED: 'protocol-error',
  PROTOCOL_ERROR: 'protocol-error',
  MESSAGE_TOO_LARGE: 'protocol-error',
  HANDLER_ERROR: 'protocol-error',
  NOT_OPEN: 'protocol-error',
  CLOSED: 'protocol-error',
} as const satisfies Record<NoiseErrorCode, LinkClosureCause>;

// Names the frame instead of keeping the parse error, whose message can echo the payload.
function parseHandshakeFrame(encoded: string): unknown {
  try { return JSON.parse(encoded); }
  catch { throw new Error('Malformed executor handshake frame'); }
}

// The checks a WebSocket upgrade must pass, from RFC 6455 section 4.2.1.
function isWebSocketUpgrade(request: Request): boolean {
  const headers = request.headers;
  return request.method === 'GET'
    && headers.get('upgrade')?.toLowerCase() === 'websocket'
    && (headers.get('connection') ?? '').split(',').some((token) => token.trim().toLowerCase() === 'upgrade')
    && headers.get('sec-websocket-version') === '13'
    && /^[A-Za-z0-9+/]{22}==$/.test(headers.get('sec-websocket-key') ?? '');
}
