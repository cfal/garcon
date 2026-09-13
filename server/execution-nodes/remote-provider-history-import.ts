import type { AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { isExecutionIdentity, type ExecutionInstanceRef, type ProjectWorkspaceRef } from '../../common/execution-location.js';
import type { NodeSessionIdentity } from '../../common/node-operation.js';
import { NODE_WORKER_SERVICE_LIMITS } from '../execution-node/worker/limits.js';
import type { NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import { MAX_NODE_REQUEST_TIMEOUT_MS, NodeDeadline } from './deadline.js';
import type { ProviderHistoryImportRequest, ProviderHistoryImportService } from './provider-history-import.js';
import type { NodeHistoryOperationIssuer } from './provider-history-operations.js';
import type { NodeHistoryBulkPort } from './transport/provider-history-bulk-channel.js';
import type { NodeHistoryBulkReceiver } from './transport/provider-history-receiver.js';
import { NodeBulkError } from './transport/bulk-transfers.js';
import { matchesNodeHistoryReply, parseNodeProviderHistoryCommand, parseNodeProviderHistoryReply,
  type NodeHistoryFacet, type NodeHistoryFailureCode, type NodeProviderHistoryCommand } from './transport/provider-history-wire.js';

export interface RemoteProviderHistoryConnection {
  readonly nodeId: string;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly bulkAttemptId: string;
  readonly signal: AbortSignal;
  readonly controlSignal: AbortSignal;
  readonly service: Pick<NodeWorkerServiceClient, 'call'>;
  readonly receiver: Pick<NodeHistoryBulkReceiver, 'reserve'>;
  readonly operations: Pick<NodeHistoryOperationIssuer, 'allocate'>;
  readonly bulk: NodeHistoryBulkPort;
  validate(): void;
  validateControl(): void;
}

type Rows = readonly AgentImportedTranscriptRow[];
type OpenImport = Extract<NodeProviderHistoryCommand, { operation: 'open' }>;
const CLEANUP_TIMEOUT_MS = 5000;

/** Binds one independently selected facet to a physical import attempt without replay or native path access. */
export class RemoteProviderHistoryImportService implements ProviderHistoryImportService {
  constructor(
    private readonly instance: ExecutionInstanceRef,
    private readonly facet: NodeHistoryFacet,
    private readonly workspaceFor: (projectPath: string) => ProjectWorkspaceRef | null,
    private readonly capture: () => RemoteProviderHistoryConnection,
  ) {
    if (!isExecutionIdentity(instance.nodeId) || !isExecutionIdentity(instance.instanceId)
      || facet !== 'legacy' && facet !== 'native') throw new TypeError('Invalid remote history owner');
    this.instance = Object.freeze({ ...instance });
  }

  read(request: ProviderHistoryImportRequest, caller: AbortSignal): AsyncIterable<Rows> {
    caller.throwIfAborted();
    const { projectPath, ...chat } = structuredClone(request.chat);
    const workspace = this.workspaceFor(projectPath);
    if (!workspace || workspace.nodeId !== this.instance.nodeId) throw unavailable();
    const connection = this.capture();
    const binding: RemoteProviderHistoryConnection = Object.freeze({ nodeId: connection.nodeId,
      session: Object.freeze({ ...connection.session }), connectionId: connection.connectionId, bulkAttemptId: connection.bulkAttemptId,
      signal: connection.signal, controlSignal: connection.controlSignal, service: connection.service,
      receiver: connection.receiver, operations: connection.operations, bulk: connection.bulk,
      validate: connection.validate.bind(connection), validateControl: connection.validateControl.bind(connection) });
    if (binding.nodeId !== this.instance.nodeId) throw unavailable();
    binding.signal.throwIfAborted(); binding.validate();
    const input = { method: 'provider-history-import', operation: 'open', instanceId: this.instance.instanceId,
      workspaceId: workspace.workspaceId, connectionId: binding.connectionId, bulkAttemptId: binding.bulkAttemptId,
      facet: this.facet, chat } as const;
    const ending = { returned: false, cancellation: new AbortController() };
    const iterator = this.#read(input, binding, caller, ending);
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => iterator.next(),
        return: () => { ending.returned = true; ending.cancellation.abort(unavailable()); return iterator.return(); },
        throw: (error) => { ending.cancellation.abort(error); return iterator.throw(error); },
      }),
    };
  }

  async *#read(input: Omit<OpenImport, 'identity' | 'after'>, binding: RemoteProviderHistoryConnection, caller: AbortSignal,
    ending: { returned: boolean; cancellation: AbortController }): AsyncGenerator<Rows, void> {
    const signal = AbortSignal.any([caller, binding.signal, ending.cancellation.signal]);
    signal.throwIfAborted(); binding.validate();
    const operation = binding.operations.allocate(binding.session, input.instanceId);
    if (!operation) throw unavailable();
    const command: OpenImport = { ...input, identity: { ...binding.session, operationId: operation.operationId }, after: operation.after };
    const { identity, instanceId, connectionId, bulkAttemptId } = command;
    const target = { method: 'provider-history-import', identity, instanceId, connectionId, bulkAttemptId } as const;
    let opened = false;
    let completed = false;
    let sourceFailure: { error: unknown } | null = null;
    let cleanup: Promise<void> | null = null;
    const cancel = () => {
      if (!opened || completed) return Promise.resolve();
      return cleanup ??= Promise.resolve().then(async () => {
        // Physical retirement owns cleanup after control loss; a surviving control channel can still cancel a lost bulk attempt.
        if (binding.controlSignal.aborted) return;
        try {
          binding.validateControl();
          await requestWithin(binding.controlSignal, CLEANUP_TIMEOUT_MS, async (cleanupSignal, deadline) => {
            const reply = await call(binding, { ...target, operation: 'cancel' }, cleanupSignal, deadline, true);
            if (reply.operation !== 'cancelled') throw unavailable();
            // Acceptance with settled=false leaves native capacity with the instance until its iterator actually settles.
          });
        } catch (error) {
          if (!binding.controlSignal.aborted) throw new RemoteProviderHistoryImportError('NODE_HISTORY_CLEANUP_UNCONFIRMED', { cause: error });
        }
      });
    };
    const aborted = () => { void cancel().finally(operation.release).catch(() => {}); };
    try {
      signal.throwIfAborted(); binding.validate();
      if (!parseNodeProviderHistoryCommand(command)) throw failure('NODE_HISTORY_INVALID');
      opened = true;
      signal.addEventListener('abort', aborted, { once: true });
      await requestWithin(signal, NODE_WORKER_SERVICE_LIMITS.providerRequestTimeoutMs,
        (requestSignal, deadline) => call(binding, command, requestSignal, deadline));
      for (let sequence = 1; ; sequence++) {
        if (!Number.isSafeInteger(sequence)) throw failure('NODE_HISTORY_INVALID');
        const next = await requestWithin(signal, NODE_WORKER_SERVICE_LIMITS.providerRequestTimeoutMs,
          (requestSignal, deadline) => call(binding, { ...target, operation: 'next', sequence }, requestSignal, deadline));
        signal.throwIfAborted(); binding.validate();
        if (next.operation === 'eof') { completed = true; return; }
        if (next.operation !== 'row') throw failure('NODE_HISTORY_INVALID');
        const row = await requestWithin(signal, MAX_NODE_REQUEST_TIMEOUT_MS, async (requestSignal, deadline) => {
          const validate = () => { requestSignal.throwIfAborted(); binding.validate(); };
          const reservation = binding.receiver.reserve(target, sequence, next.descriptor, binding.bulk, requestSignal, validate);
          try {
            await Promise.all([reservation.verified,
              call(binding, { ...target, operation: 'transfer', sequence, grant: reservation.grant, descriptor: next.descriptor }, requestSignal, deadline)]);
            validate();
            return reservation.take();
          } finally { reservation.close(); }
        });
        signal.throwIfAborted(); binding.validate();
        yield [row];
      }
    } catch (error) {
      if (!ending.returned || error !== ending.cancellation.signal.reason || caller.aborted || binding.signal.aborted) {
        sourceFailure = { error: caller.aborted ? caller.reason
          : error instanceof NodeBulkError ? failure(error.code === 'NODE_CAPACITY' ? 'NODE_CAPACITY'
            : error.code === 'NODE_BULK_INVALID' ? 'NODE_HISTORY_INVALID' : 'NODE_HISTORY_UNAVAILABLE') : error };
        throw sourceFailure.error;
      }
    } finally {
      try {
        signal.removeEventListener('abort', aborted);
        try { await cancel(); }
        catch (error) {
          caller.throwIfAborted();
          if (sourceFailure) throw new AggregateError([sourceFailure.error, error], 'History import and cleanup failed');
          throw error;
        }
        caller.throwIfAborted();
      } finally { operation.release(); }
    }
  }
}

async function call(binding: RemoteProviderHistoryConnection, command: NodeProviderHistoryCommand, signal: AbortSignal,
  deadline: NodeDeadline, cleanup = false) {
  signal.throwIfAborted();
  if (cleanup) binding.validateControl(); else binding.validate();
  const result = await binding.service.call(command, signal, deadline);
  signal.throwIfAborted();
  if (result.kind === 'rejected') throw failure(result.code === 'NODE_CAPACITY' ? 'NODE_CAPACITY' : 'NODE_HISTORY_UNAVAILABLE');
  const reply = parseNodeProviderHistoryReply(result);
  if (!reply || !matchesNodeHistoryReply(command, reply)) throw unavailable();
  if (reply.operation === 'failed') throw failure(reply.code);
  return reply;
}

async function requestWithin<T>(caller: AbortSignal, timeoutMs: number,
  execute: (signal: AbortSignal, deadline: NodeDeadline) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const signal = AbortSignal.any([caller, timeout.signal]);
  const deadline = new NodeDeadline(timeoutMs);
  const timer = setTimeout(() => timeout.abort(unavailable()), timeoutMs); timer.unref();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await Promise.race([execute(signal, deadline), cancelled.promise]);
    signal.throwIfAborted();
    if (deadline.remainingMs === 0) throw unavailable();
    return result;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    timeout.abort(unavailable());
  }
}

export class RemoteProviderHistoryImportError extends Error {
  constructor(readonly code: NodeHistoryFailureCode | 'NODE_HISTORY_CLEANUP_UNCONFIRMED', options?: ErrorOptions) {
    super(code === 'NODE_CAPACITY' ? 'History transport capacity is reserved or cannot carry this row at its configured allocation.'
      : code === 'NODE_HISTORY_TOO_LARGE' ? 'Remote history row exceeds its transport limit.'
      : code === 'NODE_HISTORY_CLEANUP_UNCONFIRMED' ? 'History cancellation settlement is unconfirmed.'
        : 'Remote history import did not complete.', options);
    this.name = 'RemoteProviderHistoryImportError';
  }
}

function failure(code: NodeHistoryFailureCode) { return new RemoteProviderHistoryImportError(code); }
function unavailable() { return failure('NODE_HISTORY_UNAVAILABLE'); }
