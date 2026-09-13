import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { sameNodeSession } from '../../common/node-operation.js';
import { NodeExecutionRequestBudget, NodeExecutionServer } from '../execution-nodes/transport/execution-channel.js';
import type { NodeExecutionClient } from '../execution-nodes/transport/execution-channel.js';
import type { NodeBulkSessionChannel } from '../execution-nodes/transport/bulk-session-channel.js';
import { isNodeExecutionReconciliation } from '../execution-nodes/transport/execution-wire.js';
import { isNodeSessionConfigurationReconciliation } from '../execution-nodes/transport/provider-session-configuration-wire.js';
import { NodeSocketReplyOutbox } from '../execution-nodes/transport/reply-outbox.js';
import type { NodeSocketReplyOutboxOptions } from '../execution-nodes/transport/reply-outbox.js';
import type { NodeSocketWriter } from '../execution-nodes/transport/socket-writer.js';
import type { NodeOutputRetirements } from './output-retirements.js';
import { NodeSessionOutputRelay } from './output-relay.js';
import type { NodeHostedConnection, NodeSessionCoordinator } from './session-coordinator.js';
import { NodeAuthorityError, type NodeRecoveryAttempt } from './supervisor.js';
import { nodeWorkerApplicationSession, parseNodeWorkerApplicationText, type NodeWorkerApplicationFrame } from './worker/application-protocol.js';
import { serializeNodeWorkerExecution } from './worker/execution-protocol.js';
import { NodeWorkerTransportError } from './worker/framing.js';
import { NodeWorkerServiceReplyError, NodeWorkerServiceServer, type NodeWorkerServiceClient } from './worker/service-channel.js';
import { NodeOutputRetirementUnconfirmedError } from './worker/output-retirement-client.js';
import type { NodeWorkerPeer } from './worker/peer.js';
import type { NodeWorkerServiceCommand, NodeWorkerServiceResult } from './worker/service-protocol.js';

export interface NodeSessionBridgeOptions {
  readonly connection: NodeHostedConnection;
  readonly instanceIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
  readonly coordinator: Pick<NodeSessionCoordinator, 'supervisor' | 'beginRecovery' | 'completeRecovery' | 'retireOutput' | 'flushOutputRetirements'> & {
    peer(connection: NodeHostedConnection): {
      service(connectionId: number): Pick<NodeWorkerServiceClient, 'call'>;
      execution(instanceId: string, connectionId: number): Pick<NodeExecutionClient, 'call'>;
      forward: NodeWorkerPeer['forward'];
    };
  };
  readonly retirements: NodeOutputRetirements;
  readonly bulk: Pick<NodeBulkSessionChannel, 'send' | 'close'>;
  readonly scheduleOutputTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  readonly replyLimits?: Pick<NodeSocketReplyOutboxOptions, 'maxEntries' | 'maxBytes' | 'maxAgeMs' | 'scheduleTimeout'>;
  readonly now?: () => number;
  validate(): void;
  disconnected(error: unknown): void;
}

interface BridgeRecovery {
  attempt: NodeRecoveryAttempt;
  generation: number | null;
  readonly cancellation: AbortController;
}

/** Relays one authenticated physical session while worker authority and retirement metadata survive disconnects. */
export class NodeSessionBridge {
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #execution = new Map<string, NodeExecutionServer>();
  readonly #executionBudget = new NodeExecutionRequestBudget();
  readonly #replies: NodeSocketReplyOutbox;
  readonly #output: NodeSessionOutputRelay;
  #service: NodeWorkerServiceServer | null = null;
  #recovery: BridgeRecovery | null = null;
  #lastGeneration = 0;
  #suspendedGeneration = 0;

  constructor(private readonly writer: NodeSocketWriter, private readonly options: NodeSessionBridgeOptions) {
    this.options = Object.freeze({ ...options, instanceIds: new Set(options.instanceIds) });
    this.#replies = new NodeSocketReplyOutbox(writer, { ...options.replyLimits, signal: this.#closing.signal, now: options.now,
      validate: () => this.#validate(), failed: (error) => this.#close(error) });
    this.#output = new NodeSessionOutputRelay(writer, { signal: this.#closing.signal, now: options.now,
      scheduleTimeout: options.scheduleOutputTimeout, validate: () => this.#validate(), failed: (error) => this.#close(error) });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    this.#service = new NodeWorkerServiceServer(this.#replies.channel(), (command, signal) => this.#call(command, signal), {
      session: options.connection.lease.session, connectionId: options.connection.connectionId, signal: this.#closing.signal,
      validate: () => this.#validate(), failed: (error) => this.#close(error),
    });
    if (options.signal.aborted) this.close();
  }

  receive(text: string): void {
    if (this.#closing.signal.aborted) return;
    try {
      this.#validate();
      const frame = parseNodeWorkerApplicationText(text);
      const { connection } = this.options;
      if (!frame || !sameNodeSession(nodeWorkerApplicationSession(frame), connection.lease.session)
        || 'instanceId' in frame && !this.options.instanceIds.has(frame.instanceId)) throw protocol();
      if ('connectionId' in frame) {
        if (frame.connectionId < connection.connectionId) return;
        if (frame.connectionId !== connection.connectionId) throw protocol();
      }
      switch (frame.type) {
        case 'node-worker-service-request': case 'node-worker-service-cancel': this.#service!.receive(frame); return;
        case 'node-worker-execution': this.#executionFor(frame.instanceId).receive(frame.payload); return;
        case 'node-worker-output-retired': this.options.coordinator.retireOutput(connection, frame); return;
        case 'node-worker-output-ack': {
          const submission = this.options.coordinator.peer(connection).forward(frame, this.#closing.signal);
          void submission.drained.catch((error) => { if (!this.#closing.signal.aborted) this.#close(error); });
          return;
        }
        default: throw protocol();
      }
    } catch (error) { this.#close(error); }
  }

  /** The logical owner keeps this receiver attached to the worker even while its physical socket is closed. */
  receiveWorker(frame: NodeWorkerApplicationFrame, text: string): void {
    try {
      if (frame.type === 'node-worker-output-retired') this.options.retirements.record(frame);
      if (this.#closing.signal.aborted) return;
      this.#validate();
      if (!sameNodeSession(nodeWorkerApplicationSession(frame), this.options.connection.lease.session)) throw protocol();
      if ('connectionId' in frame && frame.connectionId !== this.options.connection.connectionId) return;
      if (frame.type === 'node-worker-bulk') {
        try { if (!this.options.bulk.send(frame)) this.options.bulk.close(); }
        catch { this.options.bulk.close(); }
        return;
      }
      if (frame.type === 'node-worker-output-suspended') {
        const recovery = this.#recovery;
        if (frame.generation <= this.#suspendedGeneration) return;
        if (recovery?.generation === null) {
          if (frame.generation <= this.#lastGeneration) return;
        } else if (frame.generation !== this.#lastGeneration) return;
        this.#suspendedGeneration = frame.generation;
        const attempt = this.options.coordinator.beginRecovery(this.options.connection);
        if (recovery) recovery.attempt = attempt;
      } else if (frame.type !== 'node-worker-output-retired' && frame.type !== 'node-worker-output-delivery') throw protocol();
      this.#output.enqueue(text, frame.type === 'node-worker-output-delivery' ? 'data' : 'application');
    } catch (error) { this.#close(error); }
  }

  close(): void { this.#close(new NodeWorkerTransportError('NODE_WORKER_CLOSED')); }

  async #call(command: NodeWorkerServiceCommand, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    try {
      this.#validate(); signal.throwIfAborted();
      const { coordinator, connection } = this.options;
      const service = coordinator.peer(connection).service(connection.connectionId);
      if (command.method === 'begin-output-recovery') {
        return await this.#beginRecovery(signal);
      }
      if (command.method === 'resume-output') {
        const recovery = this.#recovery;
        if (!recovery || recovery.generation !== command.generation || command.generation <= this.#suspendedGeneration) return { kind: 'output-live', live: false };
        await coordinator.flushOutputRetirements(connection, signal);
        this.#validate(); signal.throwIfAborted();
        const result = await service.call(command, signal);
        this.#validate(); signal.throwIfAborted();
        if (this.#recovery !== recovery || command.generation <= this.#suspendedGeneration
          || result.kind !== 'output-live' || !result.live) return { kind: 'output-live', live: false };
        const admitted = await coordinator.completeRecovery(connection, recovery.attempt);
        this.#validate(); signal.throwIfAborted();
        if (this.#recovery !== recovery || command.generation <= this.#suspendedGeneration) return { kind: 'output-live', live: false };
        if (admitted) this.#recovery = null;
        return { kind: 'output-live', live: admitted };
      }
      if (command.method === 'install-output' || command.method === 'reserve-body' || command.method === 'provider-catalog' || command.method === 'provider-auth' || command.method === 'provider-commands' || command.method === 'provider-configuration'
        || command.method === 'provider-session-configuration' && !isNodeSessionConfigurationReconciliation(command)
        || command.method === 'permission' && command.command.method === 'permission-respond') coordinator.supervisor.assertAdmission(connection.lease);
      if (command.method === 'retire-output') {
        coordinator.retireOutput(connection, { type: 'node-worker-output-retired', version: NODE_WIRE_VERSION,
          instanceId: command.instanceId, stream: command.stream });
      }
      if (command.method === 'install-output') {
        await coordinator.flushOutputRetirements(connection, signal);
        this.#validate(); signal.throwIfAborted(); coordinator.supervisor.assertAdmission(connection.lease);
      }
      return await service.call(command, signal);
    } catch (error) {
      if (error instanceof NodeOutputRetirementUnconfirmedError) return error.result;
      if (error instanceof NodeWorkerServiceReplyError && command.method === 'provider-session-configuration') return { kind: 'unknown' };
      if (error instanceof NodeAuthorityError || signal.aborted || this.#closing.signal.aborted) return unavailable();
      this.#close(error);
      return { kind: 'unknown' };
    }
  }

  async #beginRecovery(signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    const { coordinator, connection } = this.options;
    this.#recovery?.cancellation.abort();
    const recovery: BridgeRecovery = { attempt: coordinator.beginRecovery(connection), generation: null, cancellation: new AbortController() };
    this.#recovery = recovery;
    const lifetime = AbortSignal.any([signal, recovery.cancellation.signal]);
    try {
      const result = await coordinator.peer(connection).service(connection.connectionId).call({ method: 'begin-output-recovery' }, lifetime);
      this.#validate(); lifetime.throwIfAborted();
      if (this.#recovery !== recovery || result.kind !== 'output-recovery') return unavailable();
      if (result.generation <= this.#lastGeneration || result.generation < this.#suspendedGeneration) throw protocol();
      this.#lastGeneration = result.generation;
      recovery.generation = result.generation;
      await this.options.retirements.replay((frame, active) => this.writer.sendApplicationWhenWritable(JSON.stringify(frame), active, () => this.#validate()), lifetime);
      this.#validate(); lifetime.throwIfAborted();
      return this.#recovery === recovery ? result : unavailable();
    } catch (error) {
      if (recovery.cancellation.signal.aborted) return unavailable();
      throw error;
    }
  }

  #executionFor(instanceId: string): NodeExecutionServer {
    const existing = this.#execution.get(instanceId);
    if (existing) return existing;
    const { connection, coordinator } = this.options;
    const replies = this.#replies.channel((payload) => serializeNodeWorkerExecution({ type: 'node-worker-execution', version: NODE_WIRE_VERSION,
      session: connection.lease.session, connectionId: connection.connectionId, instanceId, payload }));
    const server = new NodeExecutionServer(replies, { execute: async (command, signal) => {
      this.#validate(); signal.throwIfAborted();
      if (!isNodeExecutionReconciliation(command)) {
        try { coordinator.supervisor.assertAdmission(connection.lease); }
        catch { return { kind: 'rejected', code: 'NODE_UNAVAILABLE' }; }
      }
      return coordinator.peer(connection).execution(instanceId, connection.connectionId).call(command, signal);
    } }, { session: connection.lease.session, signal: this.#closing.signal, budget: this.#executionBudget, validate: () => this.#validate() });
    this.#execution.set(instanceId, server);
    return server;
  }

  #validate(): void {
    this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted(); this.options.validate();
    this.options.coordinator.supervisor.assertConnection(this.options.connection.lease);
    this.#closing.signal.throwIfAborted();
  }

  #close(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(error); this.#detach(); this.#recovery?.cancellation.abort(error); this.#recovery = null;
    this.#service?.close();
    for (const channel of this.#execution.values()) channel.close();
    this.#execution.clear(); this.writer.close();
    try { this.options.disconnected(error); } catch { /* Physical failure cannot retire the logical worker. */ }
  }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
function unavailable(): NodeWorkerServiceResult { return { kind: 'rejected', code: 'NODE_UNAVAILABLE' }; }
