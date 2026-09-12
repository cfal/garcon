import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { NODE_CHALLENGE_INTERVAL_MS, type NodeConnectionLease, type NodeSupervisor } from '../../execution-node/supervisor.js';
import { parseNodeLeaseFrameText, serializeNodeLeaseFrame } from './lease-wire.js';
import type { NodeSocketWriter } from './socket-writer.js';

type LeaseWriter = Pick<NodeSocketWriter, 'send' | 'close'>;

export interface NodeLeaseHeartbeatOptions {
  readonly connection: NodeConnectionLease;
  readonly supervisor: Pick<NodeSupervisor, 'issueChallenge' | 'renew' | 'disconnect'>;
  readonly schedulePoll?: (callback: () => void, delayMs: number) => { cancel(): void };
  disconnected(): void;
}

/** Challenges one physical connection; the session monitor owns expiry across disconnection and replacement. */
export class NodeLeaseHeartbeat {
  readonly #detach: () => void;
  #timer: { cancel(): void } | null = null;
  #closed = false;

  constructor(private readonly writer: LeaseWriter, private readonly options: NodeLeaseHeartbeatOptions) {
    const close = () => this.close();
    options.connection.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.connection.signal.removeEventListener('abort', close);
    if (options.connection.signal.aborted) this.close();
    else this.#poll();
  }

  receive(serialized: string): void {
    if (this.#closed) return;
    try {
      const frame = parseNodeLeaseFrameText(serialized);
      if (!frame || frame.type !== 'node-lease-renewal' || !sameNodeSession(frame.session, this.options.connection.session)) {
        this.close(); return;
      }
      this.options.supervisor.renew(this.options.connection, frame.challengeId);
    } catch { this.close(); }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.#timer?.cancel();
    this.#timer = null;
    try { this.options.supervisor.disconnect(this.options.connection); } catch { /* Physical closure remains final. */ }
    try { this.writer.close(); } catch { /* A socket failure cannot retain the polling lifetime. */ }
    try { this.options.disconnected(); } catch { /* The supervisor has already fenced this connection. */ }
  }

  #poll(): void {
    if (this.#closed) return;
    try {
      const challengeId = this.options.supervisor.issueChallenge(this.options.connection);
      if (challengeId && !this.writer.send(serializeNodeLeaseFrame({ type: 'node-lease-challenge', version: NODE_WIRE_VERSION,
        session: this.options.connection.session, challengeId }))) this.close();
    } catch { this.close(); }
    if (this.#closed) return;
    this.#timer = (this.options.schedulePoll ?? schedulePoll)(() => {
      this.#timer = null;
      this.#poll();
    }, NODE_CHALLENGE_INTERVAL_MS);
  }
}

export interface ControllerLeaseResponderOptions {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  validate(): void;
}

/** Answers only the captured authenticated node session; replaced sockets cannot renew a successor. */
export class ControllerLeaseResponder {
  readonly #session: NodeSessionIdentity;
  readonly #detach: () => void;
  #closed = false;

  constructor(private readonly writer: LeaseWriter, private readonly options: ControllerLeaseResponderOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session) throw new TypeError('Invalid node lease session');
    this.#session = Object.freeze(session);
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  receive(serialized: string): void {
    if (this.#closed) return;
    try {
      this.options.signal.throwIfAborted();
      this.options.validate();
      if (this.#closed || this.options.signal.aborted) return;
      const frame = parseNodeLeaseFrameText(serialized);
      if (!frame || frame.type !== 'node-lease-challenge' || !sameNodeSession(frame.session, this.#session)
        || !this.writer.send(serializeNodeLeaseFrame({ ...frame, type: 'node-lease-renewal' }))) this.close();
    } catch { this.close(); }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    try { this.writer.close(); } catch { /* Closure remains final even if native teardown fails. */ }
  }
}

function schedulePoll(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
