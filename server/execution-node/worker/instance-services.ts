import type { NodeProviderNativeHost } from '../provider-native-host.js';
import type { NodeProviderAuxiliaryHost } from '../provider-auxiliary-host.js';
import { NODE_WIRE_VERSION, parseProducerStreamIdentity, producerStreamKey, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { sameNodeSession } from '../../../common/node-operation.js';
import { NodeBulkChannel } from '../../execution-nodes/transport/bulk-channel.js';
import { NodeBulkError } from '../../execution-nodes/transport/bulk-transfers.js';
import type { NodeExecutionResult } from '../../execution-nodes/transport/execution-receipt-wire.js';
import type { NodeExecutionCommand } from '../../execution-nodes/transport/execution-wire.js';
import type { NodeExecutionHost } from '../execution-host.js';
import type { NodeProviderCatalogHost } from '../provider-catalog-host.js';
import type { NodeProviderAuthHost } from '../provider-auth-host.js';
import type { NodeProviderCommandsHost } from '../provider-commands-host.js';
import type { NodeProviderConfigurationHost } from '../provider-configuration-host.js';
import type { NodeSessionConfigurationHost } from '../provider-session-configuration-host.js';
import { MAX_NODE_STREAM_IDENTITIES, NodeStreamIdentityExhaustedError } from '../replay-cache.js';
import { NodeAuthorityError, type NodeConnectionLease } from '../supervisor.js';
import type { NodeWorkerAuthority } from './authority.js';
import { NodeWorkerBulkAttempts, type NodeWorkerBulkAttempt } from './bulk-attempts.js';
import type { NodeWorkerBulkGateMessage } from './protocol.js';
import { NodeWorkerBulkPort } from './bulk-port.js';
import type { NodeWorkerBulkFrame } from './bulk-protocol.js';
import { NodeWorkerTransportError } from './framing.js';
import { NodeWorkerOutputPort } from './output-port.js';
import { parseNodeWorkerOutputRetirementText, serializeNodeWorkerOutputRetirement } from './output-retirement.js';
import type { NodeWorkerServiceCommand, NodeWorkerServiceResult } from './service-protocol.js';
import type { NodeWorkerWriter } from './writer.js';
import type { NodeDeadline } from '../../execution-nodes/deadline.js';
import type { NodeProviderHistoryImportHost } from '../provider-history-host.js';
import type { NodeHistoryBulkSender } from '../../execution-nodes/transport/provider-history-sender.js';
import type { NodeHistoryBulkFrame } from '../../execution-nodes/transport/provider-history-bulk-wire.js';

interface InstanceStream {
  readonly stream: ProducerStreamIdentity;
  readonly cancellation: AbortController;
}

export interface NodeWorkerInstanceServicesOptions {
  readonly authority: NodeWorkerAuthority;
  readonly instanceId: string;
  readonly writer: Pick<NodeWorkerWriter, 'submit'>;
  readonly host: NodeExecutionHost;
  readonly catalog: NodeProviderCatalogHost;
  readonly auth: NodeProviderAuthHost;
  readonly commands: NodeProviderCommandsHost;
  readonly configuration: NodeProviderConfigurationHost;
  readonly nativeSessions: Pick<NodeProviderNativeHost, 'execute'> | null;
  readonly auxiliary: Pick<NodeProviderAuxiliaryHost, 'execute'> | null;
  readonly sessionConfiguration: Pick<NodeSessionConfigurationHost, 'execute' | 'close'>;
  readonly history: { readonly host: Pick<NodeProviderHistoryImportHost, 'execute' | 'close'>;
    readonly sender: Pick<NodeHistoryBulkSender, 'receive' | 'close'> } | null;
}

/** Keeps output and permission authority in its provider instance while physical body channels can be replaced. */
export class NodeWorkerInstanceServices {
  readonly #bulkAttempts: NodeWorkerBulkAttempts;
  readonly #output: NodeWorkerOutputPort;
  readonly #streams = new Map<string, InstanceStream | null>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  #bulk: { readonly connectionId: number; readonly channel: NodeBulkChannel } | null = null;

  constructor(private readonly options: NodeWorkerInstanceServicesOptions) {
    const { authority } = options;
    this.#bulkAttempts = new NodeWorkerBulkAttempts(authority);
    this.#output = new NodeWorkerOutputPort(options.writer, { session: authority.session, instanceId: options.instanceId,
      signal: authority.signal, now: () => authority.poll(), validate: () => this.#validate(), failed: () => authority.retire() });
    const close = () => this.close();
    this.#detach = () => authority.signal.removeEventListener('abort', close);
    authority.signal.addEventListener('abort', close, { once: true });
    if (authority.signal.aborted) this.close();
  }

  async service(connection: NodeConnectionLease, command: NodeWorkerServiceCommand, signal: AbortSignal, deadline?: NodeDeadline): Promise<NodeWorkerServiceResult> {
    try {
      this.#validate(); this.options.authority.assertConnection(connection); signal.throwIfAborted();
      if (command.method === 'confirm-bulk') {
        if (command.instanceId !== this.options.instanceId) throw protocol();
        this.#bulkAttempts.capture(command.connectionId, command.bulkAttemptId);
        return { kind: 'bulk-installed', instanceId: command.instanceId, bulkAttemptId: command.bulkAttemptId };
      }
      if (command.method === 'retire-output') {
        if (command.instanceId !== this.options.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
        if (!this.#streams.has(producerStreamKey(command.stream)) && this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) {
          throw new NodeStreamIdentityExhaustedError();
        }
        this.receiveRetirement(serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', reason: 'output-retired', version: NODE_WIRE_VERSION,
          instanceId: command.instanceId, stream: command.stream }));
        return { kind: 'output-fenced', instanceId: command.instanceId, stream: command.stream };
      }
      if (command.method === 'permission') {
        if (!this.#streams.has(producerStreamKey(command.command.permission.stream))) return { kind: 'permission-result', result: { kind: 'permission', receipt: null } };
        return { kind: 'permission-result', result: await this.options.host.permissions.execute(connection, command.command, signal) };
      }
      if (command.method === 'provider-session-configuration') {
        return await this.options.sessionConfiguration.execute(connection, command, signal);
      }
      if (command.method === 'provider-history-import') {
        if (!this.options.history || !deadline) return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
        if (command.instanceId !== this.options.instanceId || !sameNodeSession(command.identity, this.options.authority.session)) throw protocol();
        this.options.authority.assertConnection(this.options.authority.connection(command.connectionId));
        if (command.operation !== 'cancel') this.options.authority.assertAdmission(connection);
        return await this.options.history.host.execute(command, AbortSignal.any([signal, connection.signal, this.#closing.signal]), deadline);
      }
      this.options.authority.assertAdmission(connection);
      if (command.method === 'provider-single-query' || command.method === 'provider-text-generation') {
        if (command.instanceId !== this.options.instanceId || !sameNodeSession(command.identity, this.options.authority.session)) {
          return { kind: 'rejected', code: 'VALIDATION_FAILED' };
        }
        if (!this.options.auxiliary) return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
        return await this.options.auxiliary.execute(command, AbortSignal.any([signal, connection.signal, this.#closing.signal]));
      }
      if (command.method === 'provider-configuration') {
        if (command.instanceId !== this.options.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
        return await this.options.configuration.prepareUpdate(command, AbortSignal.any([signal, connection.signal, this.#closing.signal]));
      }
      if (command.method === 'provider-commands') {
        if (command.instanceId !== this.options.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
        return await this.options.commands.discover(command, AbortSignal.any([signal, connection.signal, this.#closing.signal]));
      }
      if (command.method === 'provider-native-sessions') {
        if (!this.options.nativeSessions) return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
        return await this.options.nativeSessions.execute(command, AbortSignal.any([signal, connection.signal, this.#closing.signal]));
      }
      if (command.method === 'provider-auth') {
        if (command.instanceId !== this.options.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
        return await this.options.auth.execute(command, AbortSignal.any([signal, connection.signal, this.#closing.signal]));
      }
      if (command.method === 'provider-catalog') {
        if (command.instanceId !== this.options.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
        return await this.options.catalog.snapshot({ strict: command.strict }, AbortSignal.any([signal, connection.signal, this.#closing.signal]));
      }
      if (command.method === 'install-output') {
        if (command.instanceId !== this.options.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
        this.#install(command.stream);
        return { kind: 'output-installed', instanceId: command.instanceId, stream: command.stream };
      }
      if (command.method === 'reserve-body') {
        if (command.instanceId !== this.options.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
        return { kind: 'body-reserved', transfer: this.options.host.bodies.reserve(command.identity, command.kind,
          command.controlId, command.descriptor, AbortSignal.any([signal, connection.signal])) };
      }
      return { kind: 'rejected', code: 'VALIDATION_FAILED' };
    } catch (error) {
      if (error instanceof NodeStreamIdentityExhaustedError) return { kind: 'rejected', code: 'NODE_STREAM_IDENTITIES_EXHAUSTED' };
      if (error instanceof NodeBulkError && error.code === 'NODE_CAPACITY') return { kind: 'rejected', code: 'NODE_CAPACITY' };
      if (error instanceof NodeAuthorityError) return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
      if (error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_PROTOCOL') return { kind: 'rejected', code: 'VALIDATION_FAILED' };
      return { kind: 'unknown' };
    }
  }

  async execution(connection: NodeConnectionLease, command: NodeExecutionCommand, signal: AbortSignal): Promise<NodeExecutionResult> {
    try {
      this.#validate(); this.options.authority.assertConnection(connection); signal.throwIfAborted();
      if (command.method === 'dispatch') this.options.host.bindOutput(connection, command.identity, command.stream);
      return await this.options.host.execute(connection, command, signal);
    } catch { return { kind: 'rejected', code: 'NODE_UNAVAILABLE' }; }
  }

  bulkLifetime(message: NodeWorkerBulkGateMessage): void {
    this.#validate();
    if (!sameNodeSession(message.session, this.options.authority.session)) throw protocol();
    if (message.type === 'node-worker-bulk-attached') this.#bulkAttempts.attach(message.connectionId, message.bulkAttemptId);
    else this.#bulkAttempts.retire(message.connectionId, message.bulkAttemptId);
  }

  captureBulk(connectionId: number, bulkAttemptId: string): NodeWorkerBulkAttempt {
    return this.#bulkAttempts.capture(connectionId, bulkAttemptId);
  }

  bulk(frame: NodeWorkerBulkFrame): void {
    this.#validate();
    const { authority, host, writer } = this.options;
    if (frame.instanceId !== this.options.instanceId || !sameNodeSession(frame.session, authority.session)) throw protocol();
    const connection = authority.connection(frame.connectionId);
    if (!this.#bulk || this.#bulk.connectionId !== frame.connectionId) {
      this.#bulk?.channel.close();
      const signal = AbortSignal.any([connection.signal, this.#closing.signal]);
      const validate = () => authority.assertConnection(connection);
      const port = new NodeWorkerBulkPort(writer, { session: authority.session, instanceId: this.options.instanceId,
        connectionId: frame.connectionId, signal, validate, closed() { if (!signal.aborted) authority.retire(); } });
      const channel = new NodeBulkChannel(port, {
        append: (transfer, offset, bytes) => { host.transfers.append(transfer, offset, bytes); },
        complete: (transfer) => { host.transfers.complete(transfer); }, cancel: (transfer) => host.bodies.cancel(transfer),
      }, { session: authority.session, signal, validate });
      this.#bulk = { connectionId: frame.connectionId, channel };
    }
    this.#bulk.channel.receive(frame.payload);
  }

  history(frame: NodeHistoryBulkFrame): void {
    this.#validate();
    if (frame.instanceId !== this.options.instanceId || !sameNodeSession(frame.identity, this.options.authority.session)) throw protocol();
    try { this.captureBulk(frame.connectionId, frame.bulkAttemptId).validate(); }
    catch (error) { if (error instanceof NodeBulkError || error instanceof NodeAuthorityError) return; throw error; }
    this.options.history?.sender.receive(frame);
  }

  receiveRetirement(text: string): void {
    this.#validate();
    const frame = parseNodeWorkerOutputRetirementText(text);
    if (!frame || frame.instanceId !== this.options.instanceId || !sameNodeSession(frame.stream, this.options.authority.session)) throw protocol();
    this.#output.receiveRetirement(text);
    this.#retire(frame.stream);
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(); this.#detach(); this.#output.close(); this.#bulk?.channel.close(); this.#bulk = null;
    this.#bulkAttempts.close();
    this.options.history?.host.close(); this.options.history?.sender.close();
    this.options.sessionConfiguration.close();
    for (const owner of this.#streams.values()) if (owner) this.#retire(owner.stream);
    this.#streams.clear();
  }

  #install(value: ProducerStreamIdentity): void {
    const stream = parseProducerStreamIdentity(value);
    if (!stream || !sameNodeSession(stream, this.options.authority.session)) throw protocol();
    const key = producerStreamKey(stream);
    if (this.#streams.has(key)) throw protocol();
    if (this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) throw new NodeStreamIdentityExhaustedError();
    const owner = { stream: Object.freeze(stream), cancellation: new AbortController() };
    this.#streams.set(key, owner);
    try {
      this.options.host.installStream(stream, owner.cancellation.signal, (permissions) =>
        this.#output.install(stream, owner.cancellation.signal, permissions, () => this.#retire(stream)));
      this.#validate(); owner.cancellation.signal.throwIfAborted();
    } catch (error) { this.#retire(stream); throw error; }
  }

  #retire(stream: ProducerStreamIdentity): void {
    const key = producerStreamKey(stream); const owner = this.#streams.get(key);
    if (!this.#streams.has(key)) {
      if (this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) return;
      this.#streams.set(key, null);
    }
    if (!owner) return;
    this.#streams.set(key, null);
    owner.cancellation.abort();
    this.options.host.retireStream(owner.stream);
  }

  #validate(): void { this.#closing.signal.throwIfAborted(); this.options.authority.poll(); this.options.authority.signal.throwIfAborted(); }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
