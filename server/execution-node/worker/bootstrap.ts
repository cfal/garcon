import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import type { NodeProviderManifest } from '../../execution-nodes/provider-manifest.js';
import type { NodeConnectionLease } from '../supervisor.js';
import { NodeWorkerAuthority } from './authority.js';
import type { NodeWorkerConfiguration } from './configuration.js';
import { NodeWorkerTransportError } from './framing.js';
import type { NodeWorkerLifeline } from './lifeline.js';
import { parseNodeWorkerParentText, serializeNodeWorkerChild, type NodeWorkerGateMessage } from './protocol.js';
import type { NodeWorkerRole } from './roles.js';
import { NodeDeadline } from '../../execution-nodes/deadline.js';
import { nodeWorkerApplicationSession, parseNodeWorkerApplicationText, type NodeWorkerApplicationFrame } from './application-protocol.js';

export interface NodeWorkerRuntime {
  readonly manifests: readonly NodeProviderManifest[];
  control(message: NodeWorkerGateMessage): Promise<void>;
  application(frame: NodeWorkerApplicationFrame, text: string): void;
  close(): Promise<void>;
}

export interface NodeWorkerRuntimeContext {
  readonly authority: NodeWorkerAuthority;
  readonly connectionId: number;
  readonly connection: NodeConnectionLease;
  readonly configuration: NodeWorkerConfiguration;
  readonly startup: NodeDeadline;
}

export interface NodeWorkerBootstrapOptions {
  readonly role: NodeWorkerRole;
  readonly lifeline: NodeWorkerLifeline;
  send(text: string): Promise<void>;
  start(context: NodeWorkerRuntimeContext): Promise<NodeWorkerRuntime>;
  failed(error: NodeWorkerTransportError): void;
}

/** Reads EOF and parent pulses while provider initialization is pending. */
export class NodeWorkerBootstrap {
  #session: NodeSessionIdentity | null = null;
  #authority: NodeWorkerAuthority | null = null;
  #runtime: NodeWorkerRuntime | null = null;
  #starting: Promise<void> | null = null;
  #closing: Promise<void> | null = null;
  #connectionId = 0;
  #connected = false;
  #closed = false;
  #failing = false;

  constructor(private readonly options: NodeWorkerBootstrapOptions) {}

  receive(text: string): void {
    if (this.#closed) return;
    try {
      this.options.lifeline.poll();
      const message = parseNodeWorkerParentText(text);
      if (!message) {
        const frame = parseNodeWorkerApplicationText(text);
        if (!frame || !this.#runtime || !this.#session || !sameNodeSession(nodeWorkerApplicationSession(frame), this.#session)) throw protocolError();
        if ('connectionId' in frame) {
          if (frame.connectionId > this.#connectionId) throw protocolError();
          if (frame.connectionId < this.#connectionId || !this.#connected) return;
        }
        this.#runtime.application(frame, text);
        return;
      }
      if (message.type === 'node-worker-configure') {
        if (this.#session || message.configuration.role !== this.options.role) throw protocolError();
        this.#session = Object.freeze(message.session);
        this.options.lifeline.configure();
        const authority = this.#authority = new NodeWorkerAuthority({ session: message.session,
          signal: this.options.lifeline.signal, poll: () => this.options.lifeline.poll() });
        authority.signal.addEventListener('abort', () => this.#fail(), { once: true });
        const connection = authority.attach(message.connectionId);
        this.#connectionId = message.connectionId;
        this.#connected = true;
        this.#starting = this.#start({ configuration: message.configuration, connectionId: message.connectionId, connection, authority,
          startup: new NodeDeadline(message.startupTimeoutMs) });
        return;
      }
      if (!this.#authority || !this.#session || !sameNodeSession(message.session, this.#session)) throw protocolError();
      switch (message.type) {
        case 'node-worker-pulse':
          if (message.connectionId !== this.#connectionId) throw protocolError();
          this.options.lifeline.pulse(); return;
        case 'node-worker-attach':
          this.#authority.attach(message.connectionId);
          this.#connectionId = message.connectionId;
          this.#connected = true;
          break;
        case 'node-worker-admit':
          if (!this.#runtime) throw protocolError();
          this.#authority.openAdmissions(message.connectionId); break;
        case 'node-worker-disconnect':
          if (message.connectionId !== this.#connectionId || !this.#connected) return;
          this.#authority.disconnect(message.connectionId);
          this.#connected = false;
          break;
        case 'node-worker-bulk-attached': case 'node-worker-bulk-retired':
          if (!this.#runtime || message.connectionId > this.#connectionId) throw protocolError();
          if (message.connectionId < this.#connectionId || !this.#connected) return;
          this.#authority.connection(message.connectionId);
          break;
      }
      void this.#runtime?.control(message).catch(() => this.#fail());
    } catch { this.#fail(); }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const completion = Promise.withResolvers<void>();
    this.#closing = completion.promise;
    this.#closed = true;
    this.#authority?.retire();
    this.options.lifeline.close();
    void this.#closeRuntime().then(completion.resolve, completion.reject);
    return this.#closing;
  }

  async #closeRuntime(): Promise<void> {
    await this.#starting;
    await this.#runtime?.close();
    this.#runtime = null;
  }

  async #start(context: NodeWorkerRuntimeContext): Promise<void> {
    try {
      const runtime = await this.options.start(context);
      if (this.#closed || this.options.lifeline.signal.aborted) { await runtime.close(); return; }
      const connectionId = this.#connectionId;
      const connected = this.#connected;
      this.#runtime = runtime;
      if (context.connectionId !== connectionId) await runtime.control({ type: 'node-worker-attach',
        version: NODE_WIRE_VERSION, session: context.authority.session, connectionId });
      if (!connected) await runtime.control({ type: 'node-worker-disconnect',
        version: NODE_WIRE_VERSION, session: context.authority.session, connectionId });
      this.options.lifeline.poll();
      if (context.startup.remainingMs === 0) throw new NodeWorkerTransportError('NODE_WORKER_TIMEOUT');
      await this.options.send(serializeNodeWorkerChild({ type: 'node-worker-ready', version: NODE_WIRE_VERSION,
        session: context.authority.session, manifests: runtime.manifests }));
    } catch { this.#fail(); }
  }

  #fail(): void {
    if (this.#closed || this.#failing) return;
    this.#failing = true;
    this.#authority?.retire();
    try { this.options.failed(protocolError()); }
    catch { /* The observer cannot prevent retirement. */ }
    finally { void this.close().catch(() => {}); }
  }
}

function protocolError(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
