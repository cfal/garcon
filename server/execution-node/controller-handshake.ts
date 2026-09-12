import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../common/execution-location.js';
import { NodeLeaseHeartbeat } from '../execution-nodes/transport/lease-channel.js';
import { parseNodeLeaseFrameText } from '../execution-nodes/transport/lease-wire.js';
import { NODE_HANDSHAKE_TIMEOUT_MS, NodeSessionHandshakeError, parseNodeSessionFrameText, serializeNodeSessionFrame,
  type NodeSessionRejectionCode } from '../execution-nodes/transport/session-wire.js';
import type { NodeSocketWriter } from '../execution-nodes/transport/socket-writer.js';
import type { NodeHostedConnection } from './session-coordinator.js';
import { NodeAuthorityError, type NodeSupervisor } from './supervisor.js';

export interface NodeControllerHandshakeOptions {
  readonly controllerId: string;
  readonly nodeId: string;
  readonly signal: AbortSignal;
  readonly supervisor: Pick<NodeSupervisor, 'issueChallenge' | 'renew' | 'disconnect'>;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  readonly scheduleHeartbeat?: (callback: () => void, delayMs: number) => { cancel(): void };
  /** Opens or attaches only after the outer WSS connection has authenticated this controller namespace. */
  connect(controllerBootId: string, signal: AbortSignal): Promise<NodeHostedConnection>;
  validate(): void;
  connected(connection: NodeHostedConnection): void;
  ready(connection: NodeHostedConnection): void;
  disconnect(connection: NodeHostedConnection): void;
  disconnected(error: NodeSessionHandshakeError): void;
}

/** Establishes one authenticated physical hop without owning the worker's logical lifetime. */
export class NodeControllerHandshake {
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #timer: { cancel(): void };
  #connection: NodeHostedConnection | null = null;
  #heartbeat: NodeLeaseHeartbeat | null = null;
  #connecting = false;
  #rejecting = false;

  constructor(private readonly writer: Pick<NodeSocketWriter, 'send' | 'drained' | 'close'>, private readonly options: NodeControllerHandshakeOptions) {
    if (!isExecutionIdentity(options.controllerId) || !isExecutionIdentity(options.nodeId)) throw new TypeError('Invalid paired node identity');
    this.options = Object.freeze({ ...options });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    this.#timer = (options.scheduleTimeout ?? scheduleTimeout)(() => this.#close(new NodeSessionHandshakeError('NODE_HANDSHAKE_TIMEOUT')), NODE_HANDSHAKE_TIMEOUT_MS);
    if (options.signal.aborted) this.close();
  }

  receive(text: string): void {
    if (this.#closing.signal.aborted || this.#rejecting) return;
    try {
      this.#validate();
      if (this.#connection) {
        const lease = parseNodeLeaseFrameText(text);
        if (!lease || lease.type !== 'node-lease-renewal') throw new NodeSessionHandshakeError('NODE_PROTOCOL');
        this.#heartbeat?.receive(text);
        return;
      }
      const hello = parseNodeSessionFrameText(text);
      if (this.#connecting || !hello || hello.type !== 'node-controller-hello'
        || hello.controllerId !== this.options.controllerId || hello.nodeId !== this.options.nodeId) throw new NodeSessionHandshakeError('NODE_PROTOCOL');
      if (hello.version !== NODE_WIRE_VERSION) { void this.#reject('NODE_INCOMPATIBLE'); return; }
      this.#connecting = true;
      void this.#connect(hello.controllerBootId);
    } catch (error) { this.#close(error instanceof NodeSessionHandshakeError ? error : new NodeSessionHandshakeError('NODE_UNAVAILABLE')); }
  }

  close(): void { this.#close(new NodeSessionHandshakeError('NODE_UNAVAILABLE')); }

  async #connect(controllerBootId: string): Promise<void> {
    try {
      const connection = await this.options.connect(controllerBootId, this.#closing.signal);
      if (this.#closing.signal.aborted) {
        this.#disconnect(connection);
        return;
      }
      this.#connection = connection;
      this.#validate();
      if (connection.lease.session.controllerBootId !== controllerBootId || connection.lease.signal.aborted) throw new NodeSessionHandshakeError('NODE_SESSION_EXPIRED');
      this.options.connected(connection);
      this.#validate();
      this.#send(serializeNodeSessionFrame({ type: 'node-session-accepted', version: NODE_WIRE_VERSION,
        controllerId: this.options.controllerId, nodeId: this.options.nodeId,
        session: connection.lease.session, connectionId: connection.connectionId }));
      this.#heartbeat = new NodeLeaseHeartbeat(this.writer, { connection: connection.lease, supervisor: this.options.supervisor,
        schedulePoll: this.options.scheduleHeartbeat, disconnected: () => this.close() });
      this.#validate();
      const manifests = await connection.ready;
      this.#validate();
      connection.lease.signal.throwIfAborted();
      if (manifests.some((manifest) => manifest.nodeId !== this.options.nodeId)) throw new NodeSessionHandshakeError('NODE_PROTOCOL');
      this.#send(serializeNodeSessionFrame({ type: 'node-session-ready', version: NODE_WIRE_VERSION,
        session: connection.lease.session, connectionId: connection.connectionId, manifests }));
      this.#timer.cancel();
      this.options.ready(connection);
    } catch (error) {
      if (this.#closing.signal.aborted) return;
      const code = error instanceof NodeAuthorityError || error instanceof NodeSessionHandshakeError
        ? error.code : 'NODE_UNAVAILABLE';
      if (code === 'NODE_INCOMPATIBLE' || code === 'NODE_SESSION_EXPIRED' || code === 'NODE_UNAVAILABLE') await this.#reject(code);
      else this.#close(new NodeSessionHandshakeError(code));
    }
  }

  async #reject(code: NodeSessionRejectionCode): Promise<void> {
    this.#rejecting = true;
    try {
      this.#send(serializeNodeSessionFrame({ type: 'node-session-rejected', version: NODE_WIRE_VERSION, code }));
      await this.writer.drained(this.#closing.signal);
    } catch { /* The original rejection remains the reason even when its frame cannot drain. */ }
    this.#close(new NodeSessionHandshakeError(code));
  }

  #send(text: string): void {
    this.#validate();
    if (!this.writer.send(text)) throw new NodeSessionHandshakeError('NODE_UNAVAILABLE');
  }

  #validate(): void { this.#closing.signal.throwIfAborted(); this.options.validate(); this.#closing.signal.throwIfAborted(); }

  #close(error: NodeSessionHandshakeError): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(error);
    this.#timer.cancel();
    this.#detach();
    this.#heartbeat?.close();
    if (this.#connection) this.#disconnect(this.#connection);
    try { this.writer.close(); } catch { /* Closure is final even when native teardown fails. */ }
    try { this.options.disconnected(error); } catch { /* Physical callbacks cannot restore connection authority. */ }
  }

  #disconnect(connection: NodeHostedConnection): void {
    this.options.supervisor.disconnect(connection.lease);
    try { this.options.disconnect(connection); } catch { /* The logical lease still expires independently. */ }
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
