import type { ExecutionInstanceRef } from '../../common/execution-location.js';
import { sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import type { NodeDeadline } from '../execution-nodes/deadline.js';
import type { ProviderHistoryImportService } from '../execution-nodes/provider-history-import.js';
import { NodeBulkError } from '../execution-nodes/transport/bulk-transfers.js';
import type { NodeHistoryMemoryBudget } from '../execution-nodes/transport/provider-history-memory.js';
import { NodeHistoryRowError } from '../execution-nodes/transport/provider-history-row.js';
import { parseNodeProviderHistoryCommand, sameNodeHistoryImport, type NodeHistoryFacet, type NodeHistoryFailureCode,
  type NodeHistoryImportTarget, type NodeProviderHistoryCommand, type NodeProviderHistoryReply } from '../execution-nodes/transport/provider-history-wire.js';
import { DomainError } from '../lib/domain-error.js';
import type { NodeExecutionResources } from './execution-resources.js';
import type { NodeNativeOccupancy } from './native-occupancy.js';
import type { NodeProviderCapacity } from './provider-capacity.js';
import { NodeHistoryCursorError, NodeHistoryImportCursor, type NodeHistoryCursorOptions } from './provider-history-cursor.js';

export interface NodeHistoryPhysicalBinding {
  readonly signal: AbortSignal;
  validate(): void;
  transfer: NodeHistoryCursorOptions['transfer'];
}

export interface NodeProviderHistoryHostOptions {
  readonly instance: ExecutionInstanceRef;
  readonly session: NodeSessionIdentity;
  readonly agentId: string;
  readonly signal: AbortSignal;
  readonly resources: Pick<NodeExecutionResources, 'capture'>;
  readonly capacity: NodeProviderCapacity;
  readonly occupancy: Pick<NodeNativeOccupancy, 'reserveExecution'>;
  readonly memory: NodeHistoryMemoryBudget;
  readonly facets: Readonly<Record<NodeHistoryFacet, ProviderHistoryImportService | null>>;
  readonly maxIdentities?: number;
  readonly createClock?: NodeHistoryCursorOptions['createClock'];
  readonly scheduleTimeout?: NodeHistoryCursorOptions['scheduleTimeout'];
  assertAdmission(target: NodeHistoryImportTarget): void;
  capture(target: NodeHistoryImportTarget): NodeHistoryPhysicalBinding;
}

interface ImportRecord {
  readonly target: NodeHistoryImportTarget;
  cursor: NodeHistoryImportCursor | null;
  validate: (() => void) | null;
  failure: NodeHistoryFailureCode | null;
}

/** Retains body-free consumed identities; cancellation can reconcile settlement without re-opening a source. */
export class NodeProviderHistoryImportHost {
  readonly #records = new Map<string, ImportRecord>();
  readonly #maxIdentities: number;
  readonly #detach: () => void;
  #closed = false;

  constructor(private readonly options: NodeProviderHistoryHostOptions) {
    this.#maxIdentities = options.maxIdentities ?? 4096;
    if (!Number.isSafeInteger(this.#maxIdentities) || this.#maxIdentities < 1) throw new TypeError('Invalid history identity limit');
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  async execute(input: NodeProviderHistoryCommand, signal: AbortSignal, deadline: NodeDeadline): Promise<NodeProviderHistoryReply> {
    const command = parseNodeProviderHistoryCommand(input);
    if (!command) throw new NodeHistoryCursorError('NODE_HISTORY_INVALID', 'Invalid history import command');
    const target: NodeHistoryImportTarget = Object.freeze({ identity: Object.freeze({ ...command.identity }), instanceId: command.instanceId,
      connectionId: command.connectionId, bulkAttemptId: command.bulkAttemptId });
    const base = { ...target, kind: 'provider-history-result' } as const;
    const fail = (code: NodeHistoryFailureCode): NodeProviderHistoryReply => ({ ...base, operation: 'failed', code });
    if (command.instanceId !== this.options.instance.instanceId || !sameNodeSession(command.identity, this.options.session)) return fail('NODE_HISTORY_INVALID');
    let record = this.#records.get(command.identity.operationId);
    if (record && !sameNodeHistoryImport(record.target, target)) return fail('NODE_HISTORY_INVALID');
    try {
      signal.throwIfAborted();
      if (this.#closed) return fail('NODE_HISTORY_UNAVAILABLE');
      if (command.operation === 'cancel') {
        if (!record) record = this.#consume(target);
        record.cursor?.cancel();
        return { ...base, operation: 'cancelled', settled: record.cursor === null };
      }
      this.options.assertAdmission(target);
      if (command.operation === 'open') {
        if (record) return fail('NODE_HISTORY_INVALID');
        record = this.#consume(target);
        this.#open(record, command);
        return { ...base, operation: 'opened' };
      }
      if (!record?.cursor) return fail(record?.failure ?? 'NODE_HISTORY_UNAVAILABLE');
      record.validate!();
      if (command.operation === 'next') {
        const next = await record.cursor.next(command.sequence, signal, deadline);
        return next.kind === 'eof' ? { ...base, operation: 'eof', sequence: next.sequence }
          : { ...base, operation: 'row', sequence: next.sequence, encoding: next.encoding, descriptor: next.descriptor };
      }
      await record.cursor.transfer(command.sequence, command.grant, command.descriptor, signal, deadline);
      return { ...base, operation: 'transferred', sequence: command.sequence };
    } catch (error) {
      record?.cursor?.cancel(error);
      const code = failureCode(error);
      if (record) record.failure = code;
      signal.throwIfAborted();
      return fail(code);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#detach();
    for (const record of this.#records.values()) record.cursor?.cancel(this.options.signal.reason);
  }

  #consume(target: NodeHistoryImportTarget): ImportRecord {
    if (this.#records.size >= this.#maxIdentities) throw new NodeBulkError('NODE_CAPACITY', 'History operation identities are exhausted');
    const record = { target, cursor: null, validate: null, failure: null };
    this.#records.set(target.identity.operationId, record);
    return record;
  }

  #open(record: ImportRecord, command: Extract<NodeProviderHistoryCommand, { operation: 'open' }>): void {
    if (command.chat.agentId !== this.options.agentId) throw new NodeHistoryCursorError('NODE_HISTORY_INVALID', 'History provider owner differs');
    const source = this.options.facets[command.facet];
    if (!source) throw new NodeHistoryCursorError('NODE_HISTORY_UNAVAILABLE', 'The history import facet is unavailable');
    const binding = this.options.capture(record.target);
    const resource = this.options.resources.capture({ ...this.options.instance, workspaceId: command.workspaceId });
    const signal = AbortSignal.any([this.options.signal, binding.signal, resource.signal]);
    const validate = () => { signal.throwIfAborted(); binding.validate(); resource.validate(); };
    validate();
    const release = this.options.capacity.reserve('work');
    if (!release) throw new NodeBulkError('NODE_CAPACITY', 'History provider capacity is reserved');
    let native: ReturnType<NodeNativeOccupancy['reserveExecution']> | null = null;
    try {
      native = this.options.occupancy.reserveExecution(command.chat.chatId); native.enter();
      const reservation = native;
      const cursor = record.cursor = new NodeHistoryImportCursor({ source, request: { chat: { ...command.chat, projectPath: resource.projectPath } },
        signal, memory: this.options.memory, createClock: this.options.createClock, scheduleTimeout: this.options.scheduleTimeout,
        release() { reservation.release(); release(); },
        transfer: async (bytes, sequence, grant, descriptor, caller, deadline) => {
          validate(); await binding.transfer(bytes, sequence, grant, descriptor, caller, deadline); validate();
        } });
      record.validate = validate;
      void cursor.settled.then((settlement) => {
        record.cursor = null; record.validate = null;
        if (settlement.kind !== 'complete') record.failure = failureCode(settlement.error);
      });
    } catch (error) { native?.release(); release(); throw error; }
  }
}

function failureCode(error: unknown): NodeHistoryFailureCode {
  if (error instanceof NodeHistoryRowError || error instanceof NodeHistoryCursorError) return error.code;
  if (error instanceof NodeBulkError || error instanceof DomainError) return error.code === 'NODE_CAPACITY' ? 'NODE_CAPACITY' : 'NODE_HISTORY_UNAVAILABLE';
  if (error instanceof AggregateError) return 'NODE_HISTORY_MULTIPLE_FAILURES';
  return 'NODE_HISTORY_SOURCE_FAILED';
}
