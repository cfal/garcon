import type { ExecutionTerminalService, TerminalAuthority, TerminalPeer, ExecutorCallOptions } from '@garcon/server-agent-interface';
import type { TerminalCreateRequest, TerminalStreamClientMessage } from '../../../common/terminal.js';
import { parseTerminalReference } from '../../../common/terminal-identity.js';
import { TerminalError } from '../../../common/terminal-error.js';
import { TerminalManager, type TerminalManagerOptions } from './terminal-manager.js';

interface Subscription {
  authority: TerminalAuthority;
  peer: TerminalPeer;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Owns PTYs independently of replaceable controller/provider sessions. */
export class TerminalRuntime {
  readonly id: string;
  readonly #managers = new Map<string, TerminalManager>();
  #stopped = false;

  constructor(private readonly options: TerminalManagerOptions) {
    this.id = options.terminalRuntimeId ?? crypto.randomUUID();
  }

  service(executorId: string): TerminalService {
    if (this.#stopped) throw new TerminalError('terminal-unavailable', 'Terminal executor is stopping.', 503);
    let manager = this.#managers.get(executorId);
    if (!manager) {
      manager = new TerminalManager({ ...this.options, executorId, terminalRuntimeId: this.id });
      this.#managers.set(executorId, manager);
    }
    return new TerminalService(manager);
  }

  shutdown(): void {
    this.#stopped = true;
    for (const manager of this.#managers.values()) manager.shutdown();
    this.#managers.clear();
  }
}

export class TerminalService implements ExecutionTerminalService {
  readonly #subscriptions = new Map<TerminalPeer, Subscription>();
  #disposed = false;
  #epoch = crypto.randomUUID();

  constructor(readonly manager: TerminalManager) {}

  async list(authority: TerminalAuthority, options?: ExecutorCallOptions) {
    this.#check(authority, options);
    return { success: true as const, terminalRuntimeId: this.manager.terminalRuntimeId, attachmentEpoch: this.#epoch, terminals: this.manager.list(authority) };
  }

  async create(authority: TerminalAuthority, request: TerminalCreateRequest, options?: ExecutorCallOptions) {
    this.#check(authority, options);
    if (request.executorId !== undefined && request.executorId !== this.manager.executorId) throw new TerminalError('terminal-validation', 'Terminal executor mismatch.');
    if (!request.expectedTerminalRuntimeId) throw new TerminalError('terminal-validation', 'List terminals before creating a shell.');
    return this.manager.create(authority, request);
  }

  async rename(authority: TerminalAuthority, terminalId: string, title: string | null, options?: ExecutorCallOptions) {
    this.#check(authority, options); this.#reference(terminalId);
    return this.manager.rename(authority, terminalId, title);
  }

  async terminate(authority: TerminalAuthority, terminalId: string, requestId: string, options?: ExecutorCallOptions) {
    this.#check(authority, options); this.#reference(terminalId);
    return this.manager.terminate(authority, terminalId, requestId);
  }

  async attach(authority: TerminalAuthority, peer: TerminalPeer, request: Extract<TerminalStreamClientMessage, { type: 'terminal-attach' }>) {
    this.#check(authority); this.#reference(request.terminalId);
    if (request.attachmentEpoch !== this.#epoch) throw new TerminalError('terminal-not-attached', 'Refresh terminal attachments after reconnecting.', 409);
    let subscription = this.#subscriptions.get(peer);
    if (!subscription) {
      const current: Subscription = { authority, timer: null, peer: {
        connectionId: peer.connectionId, ownedTerminalIds: peer.ownedTerminalIds,
        sendTerminalMessage: (message) => {
          if (this.#subscriptions.get(peer) !== current) return;
          if (authority.expiresAtMs !== null && authority.expiresAtMs <= Date.now()) { this.detachPeer(authority, peer); return; }
          peer.sendTerminalMessage(message);
        },
      } };
      subscription = current;
      this.#subscriptions.set(peer, current);
      const expire = () => {
        if (authority.expiresAtMs === null) return;
        const delay = authority.expiresAtMs - Date.now();
        if (delay <= 0) { this.detachPeer(authority, peer); return; }
        current.timer = setTimeout(expire, Math.min(delay, 2_147_000_000));
        current.timer.unref();
      };
      expire();
    }
    this.manager.attach(authority, subscription.peer, request);
  }

  async input(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, data: string) {
    this.#check(authority); this.#reference(terminalId);
    this.manager.input(authority, this.#peer(peer), terminalId, data);
  }

  async resize(authority: TerminalAuthority, peer: TerminalPeer, terminalId: string, cols: number, rows: number) {
    this.#check(authority); this.#reference(terminalId);
    this.manager.resize(authority, this.#peer(peer), terminalId, cols, rows);
  }

  detachPeer(authority: TerminalAuthority, peer: TerminalPeer): void {
    const subscription = this.#subscriptions.get(peer);
    if (!subscription) return;
    this.#subscriptions.delete(peer);
    if (subscription.timer) clearTimeout(subscription.timer);
    this.manager.detachPeer(authority, subscription.peer);
  }

  disconnect(): void {
    this.#epoch = crypto.randomUUID();
    for (const [peer, subscription] of this.#subscriptions) this.detachPeer(subscription.authority, peer);
  }

  dispose(): void { this.#disposed = true; this.disconnect(); }

  #peer(peer: TerminalPeer): TerminalPeer {
    const subscription = this.#subscriptions.get(peer);
    if (!subscription) throw new TerminalError('terminal-not-attached', 'Terminal attachment expired.', 409);
    return subscription.peer;
  }

  #check(authority: TerminalAuthority, options?: ExecutorCallOptions): void {
    options?.signal?.throwIfAborted();
    if (this.#disposed) throw new TerminalError('terminal-unavailable', 'Terminal connection retired.', 503);
    if (!authority.key || (authority.expiresAtMs !== null && authority.expiresAtMs <= Date.now())) {
      throw new TerminalError('terminal-auth-expired', 'Terminal authorization expired.', 401);
    }
  }

  #reference(id: string): void {
    const ref = parseTerminalReference(id);
    if (!ref || ref.executorId !== this.manager.executorId) throw new TerminalError('terminal-validation', 'Invalid terminal target.');
    if (ref.terminalRuntimeId !== this.manager.terminalRuntimeId) throw new TerminalError('terminal-runtime-changed', 'Terminal executor restarted.', 409);
  }
}
