import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { sameNodeSession } from '../../common/node-operation.js';
import { DomainError } from '../lib/domain-error.js';
import { ControllerLeaseResponder } from './transport/lease-channel.js';
import { parseNodeLeaseFrameText } from './transport/lease-wire.js';
import { NODE_HANDSHAKE_TIMEOUT_MS, NodeSessionHandshakeError, parseNodeSessionFrameText, serializeNodeSessionFrame,
  type NodeSessionAccepted, type NodeSessionReady } from './transport/session-wire.js';
import type { NodeSocketWriter } from './transport/socket-writer.js';
import { NodeDeadline } from './deadline.js';
import type { LeaseClock } from '../execution-node/lease-clock.js';

export interface ControllerNodeHandshakeOptions {
  readonly controllerId: string;
  readonly controllerBootId: string;
  readonly nodeId: string;
  readonly signal: AbortSignal;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  readonly clock?: LeaseClock;
  validate(): void;
  accepted(connection: NodeSessionAccepted): void;
  disconnected(error: NodeSessionHandshakeError): void;
}

/** Receives authority only from the captured paired-node socket; readiness does not complete recovery. */
export class ControllerNodeHandshake {
  readonly #closing = new AbortController();
  readonly #ready = Promise.withResolvers<NodeSessionReady>();
  readonly #hello: string;
  readonly #detach: () => void;
  #connection: NodeSessionAccepted | null = null;
  #lease: ControllerLeaseResponder | null = null;
  #timer: { cancel(): void } | null = null;
  #deadline: NodeDeadline | null = null;
  #started = false;
  #isReady = false;

  constructor(private readonly writer: Pick<NodeSocketWriter, 'send' | 'close'>, private readonly options: ControllerNodeHandshakeOptions) {
    this.#hello = serializeNodeSessionFrame({ type: 'node-controller-hello', version: NODE_WIRE_VERSION,
      controllerId: options.controllerId, controllerBootId: options.controllerBootId, nodeId: options.nodeId });
    this.options = Object.freeze({ ...options });
    void this.#ready.promise.catch(() => {});
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  get ready(): Promise<NodeSessionReady> { return this.#ready.promise; }

  start(): void {
    if (this.#started || this.#closing.signal.aborted) return;
    this.#started = true;
    this.#armDeadline(NODE_HANDSHAKE_TIMEOUT_MS);
    try {
      this.#validate();
      if (!this.writer.send(this.#hello)) this.close();
    } catch (error) { this.#close(handshakeError(error)); }
  }

  receive(text: string): void {
    if (this.#closing.signal.aborted) return;
    try {
      this.#validate();
      if (!this.#started) throw new NodeSessionHandshakeError('NODE_PROTOCOL');
      const frame = parseNodeSessionFrameText(text);
      if (frame?.type === 'node-session-rejected') { this.#close(new NodeSessionHandshakeError(frame.code)); return; }
      if (frame?.type === 'node-session-accepted') {
        if (this.#connection || frame.controllerId !== this.options.controllerId || frame.nodeId !== this.options.nodeId
          || frame.session.controllerBootId !== this.options.controllerBootId) throw new NodeSessionHandshakeError('NODE_PROTOCOL');
        const connection = Object.freeze({ ...frame, session: Object.freeze(frame.session) });
        this.#connection = connection;
        this.#armDeadline(connection.readinessTimeoutMs);
        this.options.accepted(connection);
        this.#validate();
        this.#lease = new ControllerLeaseResponder(this.writer, { session: connection.session, signal: this.#closing.signal,
          validate: () => this.#validate() });
        return;
      }
      const connection = this.#connection;
      if (!connection) throw new NodeSessionHandshakeError('NODE_PROTOCOL');
      if (frame?.type === 'node-session-ready') {
        if (this.#isReady || !sameNodeSession(frame.session, connection.session) || frame.connectionId !== connection.connectionId
          || frame.manifests.some((manifest) => manifest.nodeId !== connection.nodeId)) throw new NodeSessionHandshakeError('NODE_PROTOCOL');
        this.#isReady = true;
        this.#timer?.cancel(); this.#timer = null;
        this.#deadline = null;
        this.#ready.resolve(Object.freeze({ ...frame, session: connection.session, manifests: Object.freeze(frame.manifests) }));
        return;
      }
      const lease = parseNodeLeaseFrameText(text);
      if (!lease || lease.type !== 'node-lease-challenge') throw new NodeSessionHandshakeError('NODE_PROTOCOL');
      this.#lease!.receive(text);
    } catch (error) { this.#close(handshakeError(error)); }
  }

  close(): void { this.#close(new NodeSessionHandshakeError('NODE_UNAVAILABLE')); }

  #close(error: NodeSessionHandshakeError): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(error);
    this.#timer?.cancel(); this.#timer = null;
    this.#detach();
    this.#lease?.close();
    this.#ready.reject(error);
    try { this.writer.close(); } catch { /* Closure remains final. */ }
    try { this.options.disconnected(error); } catch { /* A failed physical hop cannot restore admission. */ }
  }

  #armDeadline(durationMs: number): void {
    this.#timer?.cancel();
    const deadline = this.#deadline = new NodeDeadline(durationMs, this.options.clock);
    this.#timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      if (this.#deadline === deadline) this.#close(this.#timeout());
    }, deadline.remainingMs);
  }

  #validate(): void {
    this.#closing.signal.throwIfAborted();
    if (this.#deadline?.remainingMs === 0) throw this.#timeout();
    this.options.validate();
    this.#closing.signal.throwIfAborted();
  }

  #timeout(): NodeSessionHandshakeError {
    return new NodeSessionHandshakeError(this.#connection ? 'NODE_READINESS_TIMEOUT' : 'NODE_HANDSHAKE_TIMEOUT');
  }
}

function handshakeError(error: unknown): NodeSessionHandshakeError {
  if (error instanceof NodeSessionHandshakeError) return error;
  if (error instanceof DomainError) {
    if (error.code === 'NODE_SESSION_EXPIRED' || error.code === 'NODE_REMOVED' || error.code === 'NODE_UNAUTHORIZED'
      || error.code === 'NODE_INCOMPATIBLE') return new NodeSessionHandshakeError(error.code);
    if (error.code === 'NODE_ADMIN_REQUIRED') return new NodeSessionHandshakeError('NODE_UNAUTHORIZED');
  }
  return new NodeSessionHandshakeError('NODE_UNAVAILABLE');
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
