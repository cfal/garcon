import type { FileSink } from 'bun';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import type { NodeProviderManifest } from '../../execution-nodes/provider-manifest.js';
import { NodeExecutionClient, NodeExecutionRequestBudget } from '../../execution-nodes/transport/execution-channel.js';
import { NodeWorkerExecutionPort } from './execution-port.js';
import { nodeWorkerApplicationSession, parseNodeWorkerApplicationText, type NodeWorkerApplicationFrame } from './application-protocol.js';
import { NodeWorkerServiceClient } from './service-channel.js';
import type { NodeWorkerBulkFrame } from './bulk-protocol.js';
import { parseNodeBulkFrameText } from '../../execution-nodes/transport/bulk-channel-wire.js';
import type { NodeWorkerOutputRetirement } from './output-retirement.js';
import type { NodeWorkerOutputAcknowledgement } from './service-protocol.js';
import { parseNodeWorkerConfiguration, type NodeWorkerConfiguration } from './configuration.js';
import { readNodeWorkerFrames, NodeWorkerTransportError } from './framing.js';
import { NODE_WORKER_PULSE_INTERVAL_MS, NODE_WORKER_INERT_TIMEOUT_MS } from './lifeline.js';
import { nodeWorkerPipePort } from './pipes.js';
import {
  MAX_NODE_WORKER_LIFECYCLE_BYTES, parseNodeWorkerChildText, serializeNodeWorkerParent,
  type NodeWorkerParentMessage,
} from './protocol.js';
import type { NodeWorkerRole } from './roles.js';
import { NodeWorkerWriter, type NodeWorkerSubmission } from './writer.js';
import { NODE_WORKER_EXECUTION_LIMITS, NODE_WORKER_WRITER_LIMITS } from './limits.js';

export interface NodeWorkerProcessPort {
  readonly stdin: Pick<FileSink, 'write' | 'flush' | 'end'>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
}

export interface NodeWorkerPeerOptions {
  readonly role: NodeWorkerRole;
  readonly signal: AbortSignal;
  /** Checks the parent authority before every local pulse; a pulse cannot extend a controller lease. */
  validate(): void;
  failed(error: NodeWorkerTransportError): void;
  /** All frames decoded from one native read share its monotonic timestamp. */
  received?(frame: NodeWorkerApplicationFrame, text: string, readAt: number): void | Promise<void>;
}

/** Owns one captured pipe pair; replacement workers never inherit its pending initialization. */
export class NodeWorkerPeer {
  readonly #hello = Promise.withResolvers<number>();
  readonly #ready = Promise.withResolvers<readonly NodeProviderManifest[]>();
  readonly #closing = new AbortController();
  readonly #writer: NodeWorkerWriter;
  readonly #execution = new Map<string, NodeExecutionClient>();
  readonly #executionBudget = new NodeExecutionRequestBudget(NODE_WORKER_EXECUTION_LIMITS);
  #service: NodeWorkerServiceClient | null = null;
  #physical = new AbortController();
  readonly #detach: () => void;
  #session: NodeSessionIdentity | null = null;
  #configuration: NodeWorkerConfiguration | null = null;
  #connectionId = 0;
  #connected = false;
  #pid: number | null = null;
  #isReady = false;
  #deadline: ReturnType<typeof setTimeout> | null = null;
  #pulse: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly process: NodeWorkerProcessPort, private readonly options: NodeWorkerPeerOptions) {
    // Observers may attach after a pipe has already failed.
    void this.#hello.promise.catch(() => {});
    void this.#ready.promise.catch(() => {});
    const pipe = nodeWorkerPipePort(process.stdin);
    this.#writer = new NodeWorkerWriter({
      write: (bytes) => { this.#validate(); return pipe.write(bytes); }, close: () => pipe.close(),
    }, {
      ...NODE_WORKER_WRITER_LIMITS, signal: this.#closing.signal,
      failed: (error) => this.#fail(error),
    });
    const close = () => this.closeInput();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) { this.closeInput(); return; }
    this.#deadline = setTimeout(() => this.#fail(new NodeWorkerTransportError('NODE_WORKER_TIMEOUT')), NODE_WORKER_INERT_TIMEOUT_MS);
    this.#deadline.unref();
    void this.#read();
    void process.exited.then(() => this.#fail(), () => this.#fail());
  }

  get hello(): Promise<number> { return this.#hello.promise; }

  async configure(session: NodeSessionIdentity, connectionId: number, configuration: NodeWorkerConfiguration): Promise<readonly NodeProviderManifest[]> {
    this.#validate();
    if (this.#pid === null || this.#session || configuration.role !== this.options.role) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    const snapshot = parseNodeWorkerConfiguration(configuration);
    if (!snapshot) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    const text = serializeNodeWorkerParent({ type: 'node-worker-configure', version: NODE_WIRE_VERSION, session, connectionId, configuration: snapshot });
    this.#session = Object.freeze({ ...session });
    this.#configuration = snapshot;
    this.#connectionId = connectionId;
    this.#connected = true;
    this.#pulse = setInterval(() => {
      void this.#sendControl('node-worker-pulse', this.#connectionId).catch(() => this.#fail());
    }, NODE_WORKER_PULSE_INTERVAL_MS);
    this.#pulse.unref();
    try { await this.#writer.send(text, 'control'); }
    catch { this.#fail(); }
    return this.#ready.promise;
  }

  attach(connectionId: number): Promise<void> { return this.#sendControl('node-worker-attach', connectionId); }

  admit(connectionId: number): Promise<void> { return this.#sendControl('node-worker-admit', connectionId); }
  disconnect(connectionId: number): Promise<void> {
    return this.#connected && connectionId === this.#connectionId ? this.#sendControl('node-worker-disconnect', connectionId) : Promise.resolve();
  }

  execution(instanceId: string, connectionId: number): NodeExecutionClient {
    this.#validate();
    if (!this.#isReady || !this.#connected || !this.#session || !this.#configuration || connectionId !== this.#connectionId
      || !(this.#configuration.role === 'instance' ? [this.#configuration.instance] : this.#configuration.instances)
        .some((instance) => instance.id === instanceId)) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    const existing = this.#execution.get(instanceId);
    if (existing) return existing;
    const signal = AbortSignal.any([this.#closing.signal, this.#physical.signal]);
    const validate = () => {
      this.#validate();
      if (connectionId !== this.#connectionId || !this.#connected) throw new NodeWorkerTransportError('NODE_WORKER_CLOSED');
    };
    const port = new NodeWorkerExecutionPort(this.#writer, { session: this.#session, connectionId, instanceId, signal, validate,
      closed: () => { if (!signal.aborted) this.#fail(); } });
    const client = new NodeExecutionClient(port, { ...NODE_WORKER_EXECUTION_LIMITS, session: this.#session, signal, budget: this.#executionBudget, validate });
    this.#execution.set(instanceId, client);
    return client;
  }

  service(connectionId: number): NodeWorkerServiceClient {
    this.#assertPhysical(connectionId);
    if (this.#service) return this.#service;
    const signal = AbortSignal.any([this.#closing.signal, this.#physical.signal]);
    return this.#service = new NodeWorkerServiceClient(this.#writer, { session: this.#session!, connectionId, signal,
      validate: () => this.#assertPhysical(connectionId), failed: () => { if (!signal.aborted) this.#fail(); } });
  }

  forward(frame: NodeWorkerBulkFrame | NodeWorkerOutputRetirement | NodeWorkerOutputAcknowledgement, caller: AbortSignal): NodeWorkerSubmission {
    this.#validate(); caller.throwIfAborted();
    const text = JSON.stringify(frame);
    if (!this.#isReady || !this.#session || !parseNodeWorkerApplicationText(text)
      || !sameNodeSession(nodeWorkerApplicationSession(frame), this.#session)
      || 'instanceId' in frame && !this.#hasInstance(frame.instanceId)) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    const connectionId = 'connectionId' in frame ? frame.connectionId : null;
    const signal = AbortSignal.any([caller, this.#closing.signal, ...(connectionId === null ? [] : [this.#physical.signal])]);
    const validate = () => { this.#validate(); if (connectionId !== null) this.#assertPhysical(connectionId); };
    validate();
    const bulk = frame.type === 'node-worker-bulk' ? parseNodeBulkFrameText(frame.payload)! : null;
    // Relay completion stays behind chunks even when the upstream hop has already drained them.
    const priority = bulk?.type === 'node-bulk-chunk' || bulk?.type === 'node-bulk-complete' ? 'data' : 'urgent';
    const submission = this.#writer.submit(text, priority, { signal, validate });
    void submission.drained.catch(() => { if (!signal.aborted) this.#fail(); });
    return submission;
  }

  closeInput(): void { this.#close(new NodeWorkerTransportError('NODE_WORKER_CLOSED')); }

  waitForRelease(signal: AbortSignal): Promise<void> {
    this.#validate();
    return this.#writer.waitForRelease(AbortSignal.any([signal, this.#closing.signal]));
  }

  #close(error: NodeWorkerTransportError): void {
    if (this.#closing.signal.aborted) return;
    this.#detach();
    if (this.#pulse) clearInterval(this.#pulse);
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#pulse = null;
    this.#deadline = null;
    this.#closing.abort(error);
    this.#execution.clear();
    this.#service?.close(); this.#service = null;
    this.#hello.reject(error);
    this.#ready.reject(error);
  }

  async #read(): Promise<void> {
    try {
      let readAt = performance.now();
      for await (const text of readNodeWorkerFrames(this.process.stdout, MAX_NODE_WORKER_LIFECYCLE_BYTES, this.#closing.signal,
        () => { readAt = performance.now(); })) {
        this.#validate();
        const message = parseNodeWorkerChildText(text);
        if (!message) {
          const frame = parseNodeWorkerApplicationText(text);
          if (!frame || !this.#isReady || !this.#session || !sameNodeSession(nodeWorkerApplicationSession(frame), this.#session)
            || 'instanceId' in frame && !this.#hasInstance(frame.instanceId)) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
          if ('connectionId' in frame) {
            if (frame.connectionId > this.#connectionId) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
            if (frame.connectionId < this.#connectionId || !this.#connected) continue;
          }
          if (frame.type === 'node-worker-execution') {
            const client = this.#execution.get(frame.instanceId);
            if (!client) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
            client.receive(frame.payload);
          } else if (frame.type === 'node-worker-service-result') {
            if (!this.#service) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
            this.#service.receive(frame);
          } else if (frame.type === 'node-worker-output-retired' || frame.type === 'node-worker-bulk'
            || frame.type === 'node-worker-output-suspended' && this.options.role === 'session'
            || frame.type === (this.options.role === 'instance' ? 'node-worker-output' : 'node-worker-output-delivery')) {
            if (!this.options.received) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
            const received = this.options.received(frame, text, readAt);
            if (received) await received;
          } else throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
          continue;
        }
        if (message.type === 'node-worker-hello') {
          if (this.#pid !== null || message.role !== this.options.role) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
          this.#pid = message.pid;
          this.#hello.resolve(message.pid);
        } else {
          if (this.#isReady || !this.#session || !this.#configuration || !sameNodeSession(message.session, this.#session)
            || !expectedManifests(this.#configuration, message.manifests)) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
          this.#isReady = true;
          if (this.#deadline) clearTimeout(this.#deadline);
          this.#deadline = null;
          this.#ready.resolve(message.manifests);
        }
      }
      this.#fail();
    } catch { this.#fail(); }
  }

  async #sendControl(type: Exclude<NodeWorkerParentMessage['type'], 'node-worker-configure'>, connectionId: number): Promise<void> {
    this.#validate();
    if (!this.#session) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    const text = serializeNodeWorkerParent({ type, version: NODE_WIRE_VERSION, session: this.#session, connectionId });
    if (type === 'node-worker-attach') {
      if (connectionId <= this.#connectionId) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
      this.#connectionId = connectionId;
      this.#connected = true;
      this.#physical.abort();
      this.#physical = new AbortController();
      this.#execution.clear();
      this.#service = null;
    } else if (connectionId !== this.#connectionId) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    if (type === 'node-worker-admit' || type === 'node-worker-disconnect') {
      if (!this.#connected) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
      if (type === 'node-worker-disconnect') {
        this.#connected = false;
        this.#physical.abort();
        this.#execution.clear();
        this.#service = null;
      }
    }
    try { await this.#writer.send(text, 'control'); }
    catch (error) { this.#fail(); throw error; }
    this.#validate();
  }

  #validate(): void {
    this.#closing.signal.throwIfAborted();
    try { this.options.signal.throwIfAborted(); this.options.validate(); }
    catch { this.#fail(); this.#closing.signal.throwIfAborted(); }
  }

  #assertPhysical(connectionId: number): void {
    this.#validate();
    if (!this.#isReady || !this.#session || !this.#connected || connectionId !== this.#connectionId) throw new NodeWorkerTransportError('NODE_WORKER_CLOSED');
  }

  #hasInstance(instanceId: string): boolean {
    const configuration = this.#configuration;
    return !!configuration && (configuration.role === 'instance' ? [configuration.instance] : configuration.instances)
      .some((instance) => instance.id === instanceId);
  }

  #fail(error = new NodeWorkerTransportError('NODE_WORKER_CLOSED')): void {
    if (this.#closing.signal.aborted) return;
    this.#close(error);
    try { this.options.failed(error); } catch { /* Closure remains final. */ }
  }
}

function expectedManifests(configuration: NodeWorkerConfiguration, manifests: readonly NodeProviderManifest[]): boolean {
  const instances = configuration.role === 'session' ? configuration.instances : [configuration.instance];
  return manifests.length === instances.length && instances.every((instance) => manifests.some((manifest) =>
    manifest.nodeId === configuration.nodeId && manifest.instanceId === instance.id
      && manifest.descriptor.id === instance.agentId && manifest.maxOperations === instance.maxOperations));
}
