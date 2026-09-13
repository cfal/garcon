import { NODE_WIRE_VERSION, parseProducerStreamIdentity, producerStreamKey, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { sameNodeSession } from '../../../common/node-operation.js';
import { parseNodeBulkFrameText, serializeNodeBulkFrame } from '../../execution-nodes/transport/bulk-channel-wire.js';
import { DEFAULT_NODE_BULK_LIMITS } from '../../execution-nodes/transport/bulk-transfers.js';
import { MAX_NODE_STREAM_IDENTITIES, NodeReplayGapError, NodeStreamIdentityExhaustedError, type NodeReplayOptions } from '../replay-cache.js';
import { NodeAuthorityError, type NodeConnectionLease } from '../supervisor.js';
import type { NodeWorkerApplicationFrame } from './application-protocol.js';
import type { NodeWorkerAuthority } from './authority.js';
import type { NodeWorkerBulkFrame } from './bulk-protocol.js';
import { NodeWorkerTransportError } from './framing.js';
import { NodeWorkerOutputAssembler } from './output-assembler.js';
import { NodeWorkerOutputDelivery, type NodeOutputDeliveryAttempt } from './output-delivery.js';
import { NodeWorkerOutputDeliverySender } from './output-delivery-sender.js';
import { serializeNodeWorkerOutputRetirement, type NodeWorkerOutputRetirement } from './output-retirement.js';
import { confirmNodeOutputRetirement, NodeOutputRetirementUnconfirmedError } from './output-retirement-client.js';
import type { NodeWorkerPeer } from './peer.js';
import { NodeWorkerRetirementRelay } from './retirement-relay.js';
import { NodeWorkerServiceReplyError } from './service-channel.js';
import { isNodeSessionConfigurationReconciliation } from '../../execution-nodes/transport/provider-session-configuration-wire.js';
import { serializeNodeWorkerOutputSuspension, type NodeWorkerOutputAcknowledgement, type NodeWorkerServiceCommand, type NodeWorkerServiceResult } from './service-protocol.js';
import type { NodeWorkerWriter } from './writer.js';

interface SessionStream {
  readonly instanceId: string;
  readonly stream: ProducerStreamIdentity;
  readonly cancellation: AbortController;
  retired: boolean;
  outputFenced: boolean;
}

interface SessionDeliveryAttempt {
  readonly connectionId: number;
  readonly connection: NodeConnectionLease;
  readonly token: NodeOutputDeliveryAttempt;
  readonly detach: () => void;
}

export interface NodeWorkerSessionServicesOptions {
  readonly authority: NodeWorkerAuthority;
  readonly instanceIds: ReadonlySet<string>;
  readonly writer: Pick<NodeWorkerWriter, 'submit' | 'waitForRelease'>;
  readonly replay: NodeReplayOptions;
  child(instanceId: string): Pick<NodeWorkerPeer, 'service' | 'forward' | 'waitForRelease'>;
}

/** Owns immutable instance routes and the sole session replay cache; instances retain native authority. */
export class NodeWorkerSessionServices {
  readonly #streams = new Map<string, SessionStream>();
  readonly #delivery: NodeWorkerOutputDelivery;
  readonly #assembler: NodeWorkerOutputAssembler;
  readonly #upstream: NodeWorkerRetirementRelay;
  readonly #downstream = new Map<string, NodeWorkerRetirementRelay>();
  readonly #bulkFailures = new Map<string, number>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  #attempt: SessionDeliveryAttempt | null = null;

  constructor(private readonly options: NodeWorkerSessionServicesOptions) {
    this.options = Object.freeze({ ...options, instanceIds: new Set(options.instanceIds) });
    const { authority, instanceIds, writer } = options;
    const validate = () => this.#validate();
    const failed = () => authority.retire();
    this.#upstream = new NodeWorkerRetirementRelay({
      send: (frame, signal) => writer.submit(serializeNodeWorkerOutputRetirement(frame), 'urgent', { signal, validate }, 'application').drained,
      waitForRelease: (signal) => writer.waitForRelease(signal), failed });
    for (const instanceId of instanceIds) this.#downstream.set(instanceId, new NodeWorkerRetirementRelay({
      send: (frame, signal) => options.child(instanceId).forward(frame, signal).drained,
      waitForRelease: (signal) => options.child(instanceId).waitForRelease(signal), failed }));
    this.#delivery = new NodeWorkerOutputDelivery({ session: authority.session, instanceIds, signal: authority.signal,
      replay: options.replay, now: () => authority.poll(), validate, failed,
      disconnected: (_error, token) => this.#deliveryDisconnected(token) });
    this.#assembler = new NodeWorkerOutputAssembler({ session: authority.session, instanceIds, signal: authority.signal,
      now: () => authority.poll(), validate, failed });
    const close = () => this.close();
    this.#detach = () => authority.signal.removeEventListener('abort', close);
    authority.signal.addEventListener('abort', close, { once: true });
    if (authority.signal.aborted) this.close();
  }

  async service(connectionId: number, connection: NodeConnectionLease, command: NodeWorkerServiceCommand, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    const { authority } = this.options;
    try {
      this.#validate(); authority.assertConnection(connection); signal.throwIfAborted();
      switch (command.method) {
        case 'install-output': {
          authority.assertAdmission(connection);
          const owner = this.#install(command.instanceId, command.stream);
          try {
            await this.#confirmRetirements(connectionId, connection, signal, owner.instanceId);
            authority.assertAdmission(connection); signal.throwIfAborted(); owner.cancellation.signal.throwIfAborted();
            const result = await this.options.child(owner.instanceId).service(connectionId).call(command,
              AbortSignal.any([signal, owner.cancellation.signal]));
            authority.assertConnection(connection); signal.throwIfAborted(); owner.cancellation.signal.throwIfAborted();
            if (result.kind !== 'output-installed') this.#retire(owner, 'session');
            if (result.kind === 'rejected' && result.code === 'NODE_CAPACITY') return { kind: 'rejected', code: 'NODE_OUTPUT_RETIRED' };
            return result;
          } catch (error) { this.#retire(owner, 'session'); throw error; }
        }
        case 'retire-output': {
          this.retirement({ type: 'node-worker-output-retired', reason: 'output-retired', version: NODE_WIRE_VERSION,
            instanceId: command.instanceId, stream: command.stream }, 'coordinator');
          const owner = this.#streams.get(producerStreamKey(command.stream));
          if (!owner) throw new NodeStreamIdentityExhaustedError();
          await this.#confirmRetirement(owner, connectionId, connection, signal);
          authority.assertConnection(connection); signal.throwIfAborted();
          return { kind: 'output-fenced', instanceId: owner.instanceId, stream: owner.stream };
        }
        case 'provider-session-configuration':
          if (!isNodeSessionConfigurationReconciliation(command)) authority.assertAdmission(connection);
          if (!this.options.instanceIds.has(command.instanceId)) throw protocol();
          return await this.options.child(command.instanceId).service(connectionId).call(command, signal);
        case 'provider-catalog':
        case 'provider-auth':
        case 'provider-commands':
        case 'provider-configuration':
        case 'provider-single-query':
        case 'provider-text-generation':
        case 'reserve-body':
          authority.assertAdmission(connection);
          if (!this.options.instanceIds.has(command.instanceId)) throw protocol();
          return await this.options.child(command.instanceId).service(connectionId).call(command, signal);
        case 'permission': {
          const owner = this.#streams.get(producerStreamKey(command.command.permission.stream));
          if (!owner) throw protocol();
          if (owner.retired) await this.#confirmRetirement(owner, connectionId, connection, signal);
          return await this.options.child(owner.instanceId).service(connectionId).call(command, signal);
        }
        case 'begin-output-recovery': {
          this.#suspend();
          const sender = new NodeWorkerOutputDeliverySender(this.options.writer, { session: authority.session, connectionId,
            signal: connection.signal, validate: () => authority.assertConnection(connection) });
          const token = this.#delivery.beginRecovery(async (record, attempt, progress) => {
            await this.#upstream.flush();
            await sender.send(record, attempt, progress);
          });
          const suspend = () => { if (this.#attempt?.token === token) this.#suspend(); };
          this.#attempt = { connectionId, connection, token, detach: () => connection.signal.removeEventListener('abort', suspend) };
          connection.signal.addEventListener('abort', suspend, { once: true });
          return { kind: 'output-recovery', generation: token.generation };
        }
        case 'replay-output': {
          const token = this.#token(connectionId, command.generation);
          if (!token) return unavailable();
          const ranges = await this.#delivery.replay(token, command.cursors);
          return ranges ? { kind: 'output-replayed', ranges } : unavailable();
        }
        case 'resume-output': {
          const token = this.#token(connectionId, command.generation);
          if (token) {
            await this.#confirmRetirements(connectionId, connection, signal);
            await this.#upstream.flush();
          }
          this.#validate(); authority.assertConnection(connection); signal.throwIfAborted();
          return { kind: 'output-live', live: !!token && this.#delivery.resumeLive(token) };
        }
      }
    } catch (error) {
      if (error instanceof NodeOutputRetirementUnconfirmedError) {
        if (command.method === 'install-output' && error.result.kind === 'rejected' && error.result.code === 'NODE_CAPACITY') {
          return { kind: 'rejected', code: 'NODE_OUTPUT_RETIRED' };
        }
        return error.result;
      }
      if (error instanceof NodeWorkerServiceReplyError
        && (command.method === 'provider-auth' || command.method === 'provider-session-configuration')) return { kind: 'unknown' };
      if (error instanceof NodeStreamIdentityExhaustedError) return { kind: 'rejected', code: 'NODE_STREAM_IDENTITIES_EXHAUSTED' };
      if (error instanceof NodeAuthorityError || signal.aborted) return unavailable();
      if (error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_PROTOCOL') return { kind: 'rejected', code: 'VALIDATION_FAILED' };
      return { kind: 'unknown' };
    }
  }

  receiveChild(instanceId: string, frame: NodeWorkerApplicationFrame, text: string): void {
    this.#validate();
    if (!this.options.instanceIds.has(instanceId) || !('instanceId' in frame) || frame.instanceId !== instanceId) throw protocol();
    if (frame.type === 'node-worker-output') { this.#assembler.receive(instanceId, text); return; }
    if (frame.type === 'node-worker-output-retired') { this.retirement(frame, 'instance'); return; }
    if (frame.type !== 'node-worker-bulk') throw protocol();
    const payload = parseNodeBulkFrameText(frame.payload);
    if (payload?.type !== 'node-bulk-result' && payload?.type !== 'node-bulk-failed') throw protocol();
    if (payload.type === 'node-bulk-failed' && !this.#rememberBulkFailure(frame, payload.transfer.transferId)) return;
    this.#sendBulk(frame);
  }

  bulk(frame: NodeWorkerBulkFrame): void {
    this.#validate();
    const { authority } = this.options;
    const connection = authority.connection(frame.connectionId);
    if (!sameNodeSession(frame.session, authority.session) || !this.options.instanceIds.has(frame.instanceId)) throw protocol();
    const payload = parseNodeBulkFrameText(frame.payload);
    if (!payload || payload.type === 'node-bulk-result' || payload.type === 'node-bulk-failed') throw protocol();
    this.#pruneBulkFailures();
    const key = JSON.stringify([frame.instanceId, payload.transfer.transferId]);
    if (payload.type === 'node-bulk-chunk' && this.#bulkFailures.has(key)) return;
    try { this.options.child(frame.instanceId).forward(frame, connection.signal); }
    catch (error) {
      if (!(error instanceof NodeWorkerTransportError) || error.code !== 'NODE_WORKER_CAPACITY') throw error;
      if (payload.type !== 'node-bulk-chunk') return;
      if (!this.#rememberBulkFailure(frame, payload.transfer.transferId)) return;
      this.#sendBulk({ ...frame, payload: serializeNodeBulkFrame({ type: 'node-bulk-failed', version: NODE_WIRE_VERSION,
        transfer: payload.transfer, code: 'NODE_BULK_UNAVAILABLE' }) });
    }
  }

  retirement(frame: NodeWorkerOutputRetirement, source: 'instance' | 'coordinator'): void {
    this.#validate();
    if (!sameNodeSession(frame.stream, this.options.authority.session) || !this.options.instanceIds.has(frame.instanceId)) throw protocol();
    const owner = this.#streams.get(producerStreamKey(frame.stream));
    if (owner && owner.instanceId !== frame.instanceId) throw protocol();
    if (!owner && this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) return;
    this.#retire(owner ?? this.#install(frame.instanceId, frame.stream), source, frame.reason);
  }

  acknowledge(frame: NodeWorkerOutputAcknowledgement): void {
    this.#validate();
    const token = this.#token(frame.connectionId, frame.generation);
    if (token) this.#delivery.acknowledge(token, frame.ack);
  }

  disconnected(): void { this.#suspend(); this.#bulkFailures.clear(); }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(); this.#detach(); this.#suspend();
    this.#upstream.close(); for (const relay of this.#downstream.values()) relay.close();
    this.#assembler.close(); this.#delivery.close();
    for (const owner of this.#streams.values()) owner.cancellation.abort();
    this.#streams.clear(); this.#bulkFailures.clear();
  }

  #install(instanceId: string, value: ProducerStreamIdentity): SessionStream {
    const stream = parseProducerStreamIdentity(value);
    if (!stream || !sameNodeSession(stream, this.options.authority.session) || !this.options.instanceIds.has(instanceId)) throw protocol();
    const key = producerStreamKey(stream);
    if (this.#streams.has(key)) throw protocol();
    if (this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) throw new NodeStreamIdentityExhaustedError();
    const owner: SessionStream = { instanceId, stream: Object.freeze(stream), cancellation: new AbortController(), retired: false, outputFenced: false };
    this.#streams.set(key, owner);
    try {
      this.#delivery.install(instanceId, stream, owner.cancellation.signal, (error) =>
        this.#retire(owner, 'session', error instanceof NodeReplayGapError ? 'replay-gap' : 'output-retired'));
      this.#assembler.install(instanceId, stream, owner.cancellation.signal, (serialized, sequence) => {
        try { this.#delivery.accept(stream, serialized, sequence); }
        catch { this.#retire(owner, 'session'); }
      }, () => this.#retire(owner, 'session'));
      return owner;
    } catch (error) { this.#retire(owner, 'session'); throw error; }
  }

  #retire(owner: SessionStream, source: 'instance' | 'session' | 'coordinator', reason: NodeWorkerOutputRetirement['reason'] = 'output-retired'): void {
    if (owner.retired) return;
    owner.retired = true;
    const frame = { type: 'node-worker-output-retired', reason, version: NODE_WIRE_VERSION, stream: owner.stream, instanceId: owner.instanceId } as const;
    owner.cancellation.abort();
    if (source !== 'coordinator') this.#upstream.enqueue(frame);
    if (source !== 'instance') this.#downstream.get(owner.instanceId)!.enqueue(frame);
  }

  async #confirmRetirements(connectionId: number, connection: NodeConnectionLease, signal: AbortSignal, instanceId?: string): Promise<void> {
    for (const owner of this.#streams.values()) {
      if (owner.retired && !owner.outputFenced && (instanceId === undefined || owner.instanceId === instanceId)) {
        await this.#confirmRetirement(owner, connectionId, connection, signal);
      }
    }
  }

  async #confirmRetirement(owner: SessionStream, connectionId: number, connection: NodeConnectionLease, signal: AbortSignal): Promise<void> {
    if (owner.outputFenced) return;
    await confirmNodeOutputRetirement(this.options.child(owner.instanceId).service(connectionId), owner, signal);
    this.#validate(); this.options.authority.assertConnection(connection); signal.throwIfAborted();
    owner.outputFenced = true;
  }

  #sendBulk(frame: NodeWorkerBulkFrame): void {
    const { authority } = this.options;
    const connection = authority.connection(frame.connectionId);
    try {
      const submission = this.options.writer.submit(JSON.stringify(frame), 'urgent', { signal: connection.signal,
        validate: () => authority.assertConnection(connection) }, 'application');
      void submission.drained.catch(() => { if (!connection.signal.aborted) authority.retire(); });
    } catch (error) {
      // Lost bulk replies settle through the caller's bounded timeout; effects are never replayed.
      if (!(error instanceof NodeWorkerTransportError) || error.code !== 'NODE_WORKER_CAPACITY') throw error;
    }
  }

  #rememberBulkFailure(frame: NodeWorkerBulkFrame, transferId: string): boolean {
    const now = this.#pruneBulkFailures();
    const key = JSON.stringify([frame.instanceId, transferId]);
    if (this.#bulkFailures.has(key)) return false;
    if (this.#bulkFailures.size < this.options.instanceIds.size * DEFAULT_NODE_BULK_LIMITS.maxTransfers) {
      this.#bulkFailures.set(key, now + DEFAULT_NODE_BULK_LIMITS.retentionMs);
    }
    return true;
  }

  #pruneBulkFailures(): number {
    const now = this.options.authority.poll();
    for (const [key, expires] of this.#bulkFailures) if (expires <= now) this.#bulkFailures.delete(key);
    return now;
  }

  #token(connectionId: number, generation: number): NodeOutputDeliveryAttempt | null {
    return this.#attempt?.connectionId === connectionId && this.#attempt.token.generation === generation ? this.#attempt.token : null;
  }

  #deliveryDisconnected(token: NodeOutputDeliveryAttempt): void {
    const attempt = this.#attempt;
    if (attempt?.token !== token) return;
    this.#suspend();
    const { authority, writer } = this.options;
    const { connection, connectionId } = attempt;
    if (connection.signal.aborted || this.#closing.signal.aborted) return;
    try {
      const text = serializeNodeWorkerOutputSuspension({ type: 'node-worker-output-suspended', version: NODE_WIRE_VERSION,
        session: authority.session, connectionId, generation: token.generation });
      const submission = writer.submit(text, 'control', { signal: connection.signal, validate: () => authority.assertConnection(connection) }, 'lifecycle');
      void submission.drained.catch(() => { if (!connection.signal.aborted) authority.retire(); });
    } catch { if (!connection.signal.aborted) authority.retire(); }
  }

  #suspend(): void {
    const attempt = this.#attempt;
    if (!attempt) return;
    this.#attempt = null; attempt.detach(); this.#delivery.suspend(attempt.token);
  }

  #validate(): void { this.#closing.signal.throwIfAborted(); this.options.authority.poll(); this.options.authority.signal.throwIfAborted(); }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
function unavailable(): NodeWorkerServiceResult { return { kind: 'rejected', code: 'NODE_UNAVAILABLE' }; }
