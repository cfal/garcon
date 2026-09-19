import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MessageContinuityError, type SessionSocket } from './message-session.js';
import { SessionTransport } from './session-transport.js';
import { version } from '../../package.json';

type Role = 'controller' | 'worker';
interface HelloFields {
  readonly type: 'hello';
  readonly version: string;
  readonly runtimeId: string;
  readonly peerRuntimeId: string | null;
  readonly sessionId: string | null;
  readonly nonce: string;
  readonly received: number;
}
type Hello = HelloFields & (
  | { readonly role: 'controller'; readonly nodeId: string }
  | { readonly role: 'worker' }
);

export interface WebSocketLinkOptions {
  readonly role: Role;
  readonly nodeId?: string;
  readonly secret: string;
  readonly runtimeId?: string;
  readonly allowInsecureDevelopment?: boolean;
  readonly reconnectGraceMs?: number;
  readonly maxRetainedBytes?: number;
  readonly maxRetainedFrames?: number;
  readonly reconnectDelayMs?: number;
}

export interface LinkSocket extends SessionSocket { readonly bufferedAmount: number }
export interface LinkSocketHandlers {
  receive(encoded: string): void;
  closed(): void;
}

interface Connection {
  readonly socket: LinkSocket;
  readonly hello: Hello;
  readonly timeout: ReturnType<typeof setTimeout>;
  replayTimeout: ReturnType<typeof setTimeout> | null;
  peer: Hello | null;
  session: SessionTransport | null;
  hooks: ReturnType<SessionTransport['attach']> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  lastReceivedAt: number;
  closed: boolean;
}

export class WebSocketLink {
  readonly runtimeId: string;
  readonly ready: Promise<SessionTransport>;
  readonly #ready = Promise.withResolvers<SessionTransport>();
  readonly #sessions = new Set<(session: SessionTransport) => void>();
  readonly #connections = new Set<Connection>();
  readonly #dialSockets = new Set<WebSocket>();
  readonly #errors = new Set<(message: string) => void>();
  #current: SessionTransport | null = null;
  #disposed = false;
  #quiescing = false;
  #dialTimer: ReturnType<typeof setTimeout> | null = null;
  #server: ReturnType<typeof Bun.serve<LinkSocketHandlers | null>> | null = null;
  #dialing = false;

  constructor(private readonly options: WebSocketLinkOptions) {
    if (options.secret.length < 32) throw new Error('Execution-node shared secret must contain at least 32 characters');
    if (options.role === 'controller' && !options.nodeId) throw new Error('Controller execution-node ID is required');
    this.runtimeId = options.runtimeId ?? crypto.randomUUID();
    this.ready = this.#ready.promise;
    void this.ready.catch(() => undefined);
  }

  get current(): SessionTransport | null { return this.#current; }
  get nodeId(): string | null { return this.options.role === 'controller' ? this.options.nodeId! : this.#current?.nodeId ?? null; }
  get acceptsSocket(): boolean { return !this.#disposed && !this.#quiescing && this.#connections.size < 4; }

  onError(listener: (message: string) => void): () => void {
    this.#errors.add(listener);
    return () => { this.#errors.delete(listener); };
  }

  openSocket(socket: LinkSocket): LinkSocketHandlers {
    if (!this.acceptsSocket) {
      socket.close();
      return { receive() {}, closed() {} };
    }
    const connection = this.#open(socket);
    return {
      receive: (encoded) => this.#receive(connection, encoded),
      closed: () => this.#closed(connection),
    };
  }

  onSession(listener: (session: SessionTransport) => void): () => void {
    this.#sessions.add(listener);
    if (this.#current) listener(this.#current);
    return () => { this.#sessions.delete(listener); };
  }

  listen(port = 0): string {
    if (!this.options.allowInsecureDevelopment) throw new Error('Plaintext listener requires explicit development mode; use a TLS terminator otherwise');
    if (this.#server || this.#disposed) throw new Error('Execution-node listener cannot start');
    this.#server = Bun.serve<LinkSocketHandlers | null>({
      hostname: '0.0.0.0', port,
      fetch: (request, server) => {
        if (!this.acceptsSocket) return new Response(null, { status: 503 });
        if (new URL(request.url).pathname !== '/execution-node') return new Response(null, { status: 404 });
        if (server.upgrade(request, { data: null })) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        maxPayloadLength: 16 * 1024 * 1024,
        backpressureLimit: 4 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        open: (socket) => {
          socket.data = this.openSocket({
            get bufferedAmount() { return socket.getBufferedAmount(); },
            send: (frame) => { if (socket.send(frame) === 0) throw new Error('Socket write failed'); },
            close: () => socket.close(),
          });
        },
        message: (socket, message) => {
          socket.data?.receive(typeof message === 'string' ? message : message.toString());
        },
        close: (socket) => { socket.data?.closed(); },
      },
    });
    return `ws://127.0.0.1:${this.#server.port}/execution-node`;
  }

  dial(url: string): void {
    if (this.#dialing || this.#disposed || this.#quiescing) throw new Error('Execution-node dial loop cannot start');
    const target = new URL(url);
    if (target.protocol !== 'wss:' && !(target.protocol === 'ws:' && this.options.allowInsecureDevelopment)) {
      throw new Error('Execution-node connections require TLS outside explicit development mode');
    }
    if (target.hash || target.username || target.password) throw new Error('Execution-node network URL must not contain credentials');
    this.#dialing = true;
    const connect = () => {
      this.#dialTimer = null;
      if (this.#disposed || this.#quiescing) return;
      const socket = new WebSocket(url);
      this.#dialSockets.add(socket);
      const connecting = setTimeout(() => socket.close(), 5000);
      connecting.unref();
      let connection: Connection | null = null;
      socket.addEventListener('open', () => {
        clearTimeout(connecting);
        if (this.#disposed || this.#quiescing) { socket.close(); return; }
        connection = this.#open({
          get bufferedAmount() { return socket.bufferedAmount; },
          send: (frame) => {
            if (socket.readyState !== WebSocket.OPEN) throw new Error('Socket is not open');
            socket.send(frame);
          },
          close: () => socket.close(),
        });
      });
      socket.addEventListener('message', (event) => {
        if (connection && typeof event.data === 'string') this.#receive(connection, event.data);
        else socket.close();
      });
      socket.addEventListener('error', () => {
        this.#reportError('Execution-node connection could not be established');
        socket.close();
      });
      socket.addEventListener('close', () => {
        clearTimeout(connecting);
        this.#dialSockets.delete(socket);
        if (connection) this.#closed(connection);
        if (!this.#disposed && !this.#quiescing) {
          this.#dialTimer = setTimeout(connect, this.options.reconnectDelayMs ?? 5000);
        }
      });
    };
    connect();
  }

  disconnect(): void {
    for (const connection of this.#connections) this.#close(connection);
  }

  quiesce(): void {
    this.#quiescing = true;
    if (this.#dialTimer) clearTimeout(this.#dialTimer);
    this.#dialTimer = null;
    for (const socket of this.#dialSockets) {
      if (socket.readyState === WebSocket.CONNECTING) socket.close();
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#dialTimer) clearTimeout(this.#dialTimer);
    this.#ready.reject(new Error('Execution-node connector disposed'));
    this.#current?.close();
    this.disconnect();
    for (const socket of this.#dialSockets) socket.close();
    this.#sessions.clear();
    this.#errors.clear();
    await this.#server?.stop(true);
    this.#server = null;
  }

  #open(socket: LinkSocket): Connection {
    const hello: Hello = {
      type: 'hello', version,
      ...(this.options.role === 'controller' ? { role: 'controller' as const, nodeId: this.options.nodeId! } : { role: 'worker' as const }),
      runtimeId: this.runtimeId, peerRuntimeId: this.#current?.peerRuntimeId ?? null,
      sessionId: this.#current?.id ?? null,
      nonce: randomBytes(32).toString('hex'), received: this.#current?.channel.received ?? 0,
    };
    const connection: Connection = {
      socket, hello, peer: null, session: null, hooks: null, heartbeat: null, replayTimeout: null,
      closed: false, lastReceivedAt: Date.now(),
      timeout: setTimeout(() => {
        this.#reportError('Execution-node authentication timed out');
        this.#close(connection);
      }, 5000),
    };
    connection.timeout.unref();
    this.#connections.add(connection);
    try { socket.send(JSON.stringify(hello)); } catch { this.#close(connection); }
    return connection;
  }

  #receive(connection: Connection, encoded: string): void {
    if (connection.closed || this.#disposed) return;
    connection.lastReceivedAt = Date.now();
    try {
      if (connection.hooks) {
        if (encoded === '{"type":"ping"}') { connection.socket.send('{"type":"pong"}'); return; }
        if (encoded === '{"type":"pong"}') return;
        const received = connection.session!.channel.received;
        connection.hooks.receive(encoded);
        if (connection.session?.connected) {
          if (connection.replayTimeout) clearTimeout(connection.replayTimeout);
          connection.replayTimeout = null;
          this.#ready.resolve(connection.session);
        } else if (connection.session!.channel.received > received) {
          this.#waitForReplay(connection);
        }
        return;
      }
      if (Buffer.byteLength(encoded) > 8192) throw new Error('Handshake exceeds budget');
      const frame: unknown = JSON.parse(encoded);
      if (isHello(frame) && !connection.peer) {
        if (frame.version !== version || frame.role === this.options.role) {
          throw new Error('Execution-node handshake mismatch');
        }
        connection.peer = frame;
        connection.socket.send(JSON.stringify({ type: 'proof', signature: this.#signature(connection, this.options.role) }));
        return;
      }
      if (!connection.peer || !frame || typeof frame !== 'object' || !('type' in frame) || frame.type !== 'proof'
        || !('signature' in frame) || typeof frame.signature !== 'string' || !/^[a-f0-9]{64}$/.test(frame.signature)
        || !timingSafeEqual(Buffer.from(frame.signature, 'hex'), Buffer.from(this.#signature(connection, connection.peer.role), 'hex'))) {
        throw new Error('Execution-node authentication failed');
      }
      this.#accept(connection);
    } catch {
      this.#reportError(connection.hooks ? 'Execution-node continuity lost' : 'Execution-node authentication failed');
      this.#close(connection);
    }
  }

  #accept(connection: Connection): void {
    clearTimeout(connection.timeout);
    const peer = connection.peer!;
    const nodeId = connection.hello.role === 'controller' ? connection.hello.nodeId
      : peer.role === 'controller' ? peer.nodeId : '';
    if (connection.hello.sessionId !== (this.#current?.id ?? null)) throw new Error('Superseded handshake');
    let session = this.#current;
    const resume = session !== null && peer.runtimeId === session.peerRuntimeId
      && peer.peerRuntimeId === this.runtimeId && peer.sessionId === session.id && session.nodeId === nodeId;
    if (session?.channel.attached) throw new Error('Execution-node session already attached');
    if (!resume) {
      session?.close(new MessageContinuityError('Execution-node logical session replaced'));
      const replacement = new SessionTransport(this.#signature(connection, 'session'), peer.runtimeId, () => {
        if (this.#current === replacement) this.#current = null;
        for (const attached of this.#connections) {
          if (attached.session === replacement) this.#close(attached);
        }
      }, this.options, nodeId);
      this.#current = session = replacement;
      for (const listener of this.#sessions) listener(replacement);
    }
    connection.session = session;
    connection.hooks = session!.attach({
      send: (frame) => {
        if (connection.socket.bufferedAmount > 4 * 1024 * 1024) {
          throw new MessageContinuityError('Execution-node socket backpressure budget exhausted');
        }
        connection.socket.send(frame);
      },
      close: () => this.#close(connection),
    }, resume ? peer.received : 0);
    if (connection.closed) { connection.hooks.disconnected(); return; }
    this.#waitForReplay(connection);
    connection.heartbeat = setInterval(() => {
      try {
        if (Date.now() - connection.lastReceivedAt > 15_000) this.#close(connection);
        else connection.socket.send('{"type":"ping"}');
      } catch { this.#close(connection); }
    }, 5000);
    connection.heartbeat.unref();
  }

  #waitForReplay(connection: Connection): void {
    if (connection.replayTimeout) clearTimeout(connection.replayTimeout);
    if (connection.closed || connection.session?.connected) return;
    connection.replayTimeout = setTimeout(() => {
      connection.session!.close(new MessageContinuityError('Execution-node replay inactivity deadline exceeded'));
    }, this.options.reconnectGraceMs ?? 30_000);
    connection.replayTimeout.unref();
  }

  #signature(connection: Connection, purpose: Role | 'session'): string {
    const hello = connection.hello;
    const peer = connection.peer!;
    const transcript = hello.role === 'controller' ? [hello, peer] : [peer, hello];
    return createHmac('sha256', this.options.secret).update(JSON.stringify(['garcon-execution-node', purpose, transcript])).digest('hex');
  }

  #reportError(message: string): void {
    if (!this.#disposed) for (const listener of this.#errors) listener(message);
  }

  #close(connection: Connection): void {
    this.#closed(connection);
    connection.socket.close();
  }

  #closed(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.timeout);
    if (connection.replayTimeout) clearTimeout(connection.replayTimeout);
    if (connection.heartbeat) clearInterval(connection.heartbeat);
    this.#connections.delete(connection);
    connection.hooks?.disconnected();
  }
}

function isHello(value: unknown): value is Hello {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return frame.type === 'hello' && (frame.role === 'controller' || frame.role === 'worker')
    && ['version', 'runtimeId', 'nonce'].every((key) => typeof frame[key] === 'string' && frame[key].length > 0)
    && (frame.role === 'controller' ? typeof frame.nodeId === 'string' && frame.nodeId.length > 0 : !('nodeId' in frame))
    && (frame.peerRuntimeId === null || typeof frame.peerRuntimeId === 'string')
    && (frame.sessionId === null || typeof frame.sessionId === 'string')
    && typeof frame.received === 'number' && Number.isSafeInteger(frame.received) && frame.received >= 0;
}
