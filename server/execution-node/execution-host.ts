import {
  parseProducerStreamIdentity, producerStreamKey, type ProducerStreamIdentity,
} from '@garcon/server-agent-interface';
import { sameNodeSession, type NodeOperationIdentity } from '../../common/node-operation.js';
import { sameExecutionLocation } from '../../common/execution-location.js';
import type { NodeExecutionCommand } from '../execution-nodes/transport/execution-wire.js';
import type { NodeExecutionResult } from '../execution-nodes/transport/execution-receipt-wire.js';
import { NodeBulkTransfers } from '../execution-nodes/transport/bulk-transfers.js';
import { DomainError } from '../lib/domain-error.js';
import { NodeExecutionBodyGrants } from './execution-body-grants.js';
import { NodeExecutionOutputGrants } from './execution-output-grants.js';
import { NodeExecutionWireAdapter } from './execution-wire-adapter.js';
import type { NodeOutputPermissionHandles, NodeOutputStream } from './output-stream.js';
import type { NodeOperationGrant, NodeOperationTable } from './operation-table.js';
import type { NodeExecutionSourceTarget } from './execution-resources.js';
import { NodePermissionHandles } from './permission-handles.js';
import { MAX_NODE_STREAM_IDENTITIES, NodeStreamIdentityExhaustedError } from './replay-cache.js';
import type { NodeConnectionLease, NodeSupervisor } from './supervisor.js';

interface HostedStream {
  readonly cancellation: AbortController;
  readonly operations: Set<NodeOperationGrant>;
  readonly detach: () => void;
  source: NodeExecutionSourceTarget | null;
  detachResource: (() => void) | null;
}

export type NodeExecutionSourceCapture =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'absent'; validate(): void }
  | { readonly kind: 'captured'; readonly signal: AbortSignal; validate(): void };

/** Composes operation receipts with the concrete byte, output, and permission grants they authorize. */
export class NodeExecutionHost {
  readonly bodies: NodeExecutionBodyGrants;
  readonly transfers: NodeBulkTransfers;
  readonly permissions: NodePermissionHandles;
  readonly #outputs: NodeExecutionOutputGrants;
  readonly #adapter: NodeExecutionWireAdapter;
  readonly #operations = new Map<string, NodeOperationGrant>();
  readonly #streams = new Map<string, HostedStream | null>();
  readonly #detach: () => void;
  #closed = false;

  constructor(
    private readonly connection: NodeConnectionLease,
    private readonly supervisor: Pick<NodeSupervisor, 'assertConnection' | 'assertAdmission' | 'poll'>,
    private readonly table: NodeOperationTable,
  ) {
    const { session, authoritySignal: signal } = connection;
    this.transfers = new NodeBulkTransfers({ session, authoritySignal: signal, now: () => supervisor.poll() });
    this.bodies = new NodeExecutionBodyGrants({ session, signal, transfers: this.transfers });
    this.#outputs = new NodeExecutionOutputGrants({ session, signal });
    this.permissions = new NodePermissionHandles({ session, signal, supervisor });
    this.#adapter = new NodeExecutionWireAdapter(table, supervisor, {
      takeBody: (...args) => this.bodies.takeBody(...args), output: (...args) => this.#outputs.output(...args),
    });
    const close = () => this.close();
    signal.addEventListener('abort', close, { once: true });
    this.#detach = () => signal.removeEventListener('abort', close);
    if (signal.aborted) this.close();
  }

  installStream(
    value: ProducerStreamIdentity, signal: AbortSignal, createOutput: (permissions: NodeOutputPermissionHandles) => Pick<NodeOutputStream, 'forOperation'>,
  ): void {
    this.#assertOpen();
    const stream = parseProducerStreamIdentity(value);
    if (!stream || !sameNodeSession(stream, this.connection.session)) throw unavailable();
    const key = producerStreamKey(stream);
    if (this.#streams.has(key)) throw new TypeError('Execution stream cannot be rebound');
    if (this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) throw new NodeStreamIdentityExhaustedError();
    signal.throwIfAborted();
    const owner: HostedStream = { cancellation: new AbortController(), operations: new Set(), source: null, detachResource: null,
      detach: () => signal.removeEventListener('abort', retire) };
    const retire = () => this.retireStream(stream);
    const closing = AbortSignal.any([signal, owner.cancellation.signal, this.connection.authoritySignal]);
    this.#streams.set(key, owner);
    signal.addEventListener('abort', retire, { once: true });
    try {
      this.permissions.install(stream, closing, (runId) => [...owner.operations].some((grant) => grant.isRunLive(runId)));
      const output = createOutput(this.permissions);
      this.#assertOpen();
      closing.throwIfAborted();
      if (this.#streams.get(key) !== owner) throw unavailable();
      this.#outputs.install(stream, (isRunLive) => {
        const sink = output.forOperation(isRunLive);
        return { emit: (event) => {
          if (event.type === 'run-ended') this.permissions.retireRun(stream, event.runId, isRunLive);
          else if (event.type === 'permission' && event.lifecycle.kind !== 'requested') {
            this.permissions.retireOccurrence(stream, event.runId, event.lifecycle.permissionOccurrenceId, isRunLive);
          }
          sink.emit(event);
        } };
      }, closing, () => this.#assertOpen());
    } catch (error) { this.retireStream(stream); throw error; }
  }

  bindOutput(connection: NodeConnectionLease, identity: NodeOperationIdentity, stream: ProducerStreamIdentity): void {
    this.#assertOpen();
    this.supervisor.assertAdmission(connection);
    const grant = this.#operations.get(identity.operationId);
    const owner = this.#streams.get(producerStreamKey(stream));
    if (!grant || !owner || !sameNodeSession(identity, this.connection.session)) throw unavailable();
    grant.signal.throwIfAborted();
    if (owner.source && !sameSource(owner.source, grant.source)) throw unavailable();
    if (!owner.source && [...this.#streams.values()].some((other) => other?.source?.chatId === grant.source.chatId)) throw unavailable();
    this.#outputs.bind(grant, stream);
    if (!owner.source) {
      owner.source = grant.source;
      const capturedStream = Object.freeze({ ...stream });
      const retire = () => this.retireStream(capturedStream);
      grant.resourceSignal.addEventListener('abort', retire, { once: true });
      owner.detachResource = () => grant.resourceSignal.removeEventListener('abort', retire);
    }
    owner.operations.add(grant);
    grant.signal.addEventListener('abort', () => owner.operations.delete(grant), { once: true });
  }

  captureSource(input: NodeExecutionSourceTarget, stream: ProducerStreamIdentity | null): NodeExecutionSourceCapture {
    this.#assertOpen();
    const target = structuredClone(input);
    const entry = [...this.#streams].find(([, owner]) => owner?.source?.chatId === target.chatId);
    if (!entry) return stream ? { kind: 'conflict' } : { kind: 'absent', validate: () => {
      this.#assertOpen();
      if ([...this.#streams.values()].some(owner => owner?.source?.chatId === target.chatId)) throw unavailable();
    } };
    const [key, owner] = entry;
    if (!stream || key !== producerStreamKey(stream) || !owner?.source || !sameSource(owner.source, target)) return { kind: 'conflict' };
    return {
      kind: 'captured', signal: owner.cancellation.signal,
      validate: () => {
        this.#assertOpen();
        owner.cancellation.signal.throwIfAborted();
        if (this.#streams.get(key) !== owner) throw unavailable();
      },
    };
  }

  async execute(connection: NodeConnectionLease, command: NodeExecutionCommand, signal: AbortSignal): Promise<NodeExecutionResult> {
    const result = await this.#adapter.execute(connection, command, signal);
    if (result.kind !== 'prepared') return result;
    try {
      this.#assertOpen();
      this.supervisor.assertConnection(connection);
      signal.throwIfAborted();
      const grant = this.table.capture(connection, result.ticket.identity);
      this.bodies.install(grant);
      this.#operations.set(grant.identity.operationId, grant);
      grant.signal.addEventListener('abort', () => {
        this.#operations.delete(grant.identity.operationId);
      }, { once: true });
      return result;
    } catch {
      try { this.table.release(connection, result.ticket.identity); } catch { /* A replaced connection leaves only an expiring preparation. */ }
      return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
    }
  }

  retireStream(stream: ProducerStreamIdentity): void {
    const key = producerStreamKey(stream);
    const owner = this.#streams.get(key);
    if (!owner) return;
    this.#streams.set(key, null);
    owner.detach();
    owner.detachResource?.();
    owner.detachResource = null;
    owner.cancellation.abort(unavailable());
    for (const grant of owner.operations) void grant.abort().catch(() => {});
    owner.operations.clear();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.bodies.close(); this.transfers.close(); this.permissions.close(); this.#outputs.close();
    for (const owner of this.#streams.values()) if (owner) {
      owner.detach(); owner.detachResource?.(); owner.detachResource = null; owner.cancellation.abort(unavailable());
    }
    this.table.close();
    this.#streams.clear(); this.#operations.clear();
  }

  #assertOpen(): void {
    this.supervisor.poll();
    if (this.#closed || this.connection.authoritySignal.aborted) throw unavailable();
  }
}

function sameSource(left: NodeExecutionSourceTarget, right: NodeExecutionSourceTarget): boolean {
  return left.chatId === right.chatId && left.projectPath === right.projectPath && sameExecutionLocation(left.location, right.location);
}

function unavailable(): DomainError { return new DomainError('NODE_SESSION_EXPIRED', 'Execution host is unavailable', 409); }
