import {
  AgentCallError,
  AgentIntegrationError,
  createAgentResourceRef,
  type AgentExecutionHandle,
  type AgentEstablishedSession,
  type AgentExecutionV5,
  type AgentHost,
  type AgentPermissions,
  type AgentProducerBinding,
  type AgentProducerEvent,
  type AgentProducerNotification,
  type AgentProducers,
  type AgentResumeRequestV5,
  type AgentRunFailureDetail,
  type ExecutorCallOptions,
} from '@garcon/server-agent-interface';
import { AgentResourceTable } from './resource-table.js';
import type {
  AgentRuntimePublisher,
  AgentRuntimeExecution,
  AgentRuntimeResumeRequest,
  RuntimePermissionResponse,
} from './runtime-events.js';

interface ProducerBinding {
  readonly ref: AgentProducerBinding;
  readonly chatId: string;
  readonly cancellation: AbortController;
  closed: boolean;
  detached: boolean;
  publishedSession: AgentEstablishedSession | null;
}

interface Operation {
  readonly binding: ProducerBinding;
  readonly runId: string;
  agentSessionId: string | null;
  abortedSessionOnClose: string | null;
  ended: boolean;
  readonly handle: AgentExecutionHandle;
}

export function createAgentProducerAdapter(runtime: AgentRuntimeExecution, host: Pick<AgentHost, 'logger' | 'scope'>) {
  // Bindings follow transcript lifetime, not the concurrent-operation budget.
  const bindings = new AgentResourceTable<'producer', ProducerBinding>(host.scope, 'producer', Infinity);
  const handles = new AgentResourceTable<'execution', Operation>(host.scope, 'execution');
  const responses = new AgentResourceTable<'permission-response', {
    readonly operation: Operation;
    readonly capability: RuntimePermissionResponse;
  }>(host.scope, 'permission-response');
  const listeners = new Set<(notification: AgentProducerNotification) => void>();
  const active = new Map<string, Operation>();

  function emit(binding: ProducerBinding, event: AgentProducerNotification['event']): void {
    if (binding.detached) return;
    if (binding.closed) throw new AgentCallError('rejected', 'Producer binding has closed', 'STALE_RESOURCE');
    for (const listener of listeners) listener({ binding: binding.ref, event });
  }

  function expectedOperation(request: {
    readonly chatId: string;
    readonly expectedRunId: string;
    readonly producerBinding: AgentProducerBinding;
  }): Operation | null {
    const binding = bindings.get(request.producerBinding);
    const operation = active.get(request.chatId);
    return operation && operation.binding === binding && operation.runId === request.expectedRunId
      && !operation.ended ? operation : null;
  }

  function retire(operation: Operation): void {
    operation.ended = true;
    if (active.get(operation.binding.chatId) === operation) active.delete(operation.binding.chatId);
    handles.delete(operation.handle);
    responses.removeWhere((value) => value.operation === operation);
    if (operation.binding.detached) bindings.delete(operation.binding.ref);
  }

  function denyDetachedPermission(capability: RuntimePermissionResponse): void {
    void Promise.resolve().then(() => capability.respond({ allow: false })).catch((error) => {
      host.logger.warn('Failed to deny permission after executor disconnect', { reason: String(error) });
    });
  }

  async function abortClosedOperation(operation: Operation): Promise<void> {
    const sessionId = operation.agentSessionId;
    if (operation.ended || !sessionId || operation.abortedSessionOnClose === sessionId) return;
    const replacement = active.get(operation.binding.chatId);
    // Native abort targets a session, so a replacement must not inherit this cleanup.
    if (replacement && replacement !== operation && replacement.agentSessionId === sessionId) return;
    operation.abortedSessionOnClose = sessionId;
    try {
      await runtime.abort(sessionId);
    } catch (error) {
      host.logger.warn('Failed to abort execution for a closed producer binding', {
        chatId: operation.binding.chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const producers: AgentProducers = {
    scope: host.scope,
    async bind({ binding, chatId }, options) {
      options?.signal?.throwIfAborted();
      if (!chatId) throw new TypeError('Producer chat ID is required');
      bindings.bind(binding, { ref: binding, chatId, cancellation: new AbortController(), closed: false, detached: false, publishedSession: null });
    },
    async close(ref) {
      const binding = bindings.get(ref);
      binding.closed = true;
      bindings.delete(ref);
      binding.cancellation.abort();
      handles.removeWhere((operation) => operation.binding === binding);
      responses.removeWhere((value) => value.operation.binding === binding);
      const operation = active.get(binding.chatId);
      if (operation?.binding === binding) {
        active.delete(binding.chatId);
        await abortClosedOperation(operation);
      }
    },
    detach(ref) {
      let binding: ProducerBinding;
      try { binding = bindings.get(ref); }
      catch (error) {
        if (error instanceof AgentCallError && error.code === 'STALE_RESOURCE') return;
        throw error;
      }
      binding.detached = true;
      responses.removeWhere((value) => {
        if (value.operation.binding !== binding) return false;
        denyDetachedPermission(value.capability);
        return true;
      });
      if (active.get(binding.chatId)?.binding !== binding) bindings.delete(ref);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  const permissions: AgentPermissions = {
    async respond({ response, decision }, options) {
      options?.signal?.throwIfAborted();
      const { operation, capability } = responses.take(response);
      assertCurrent(operation);
      await capability.respond(decision);
    },
  };

  function assertCurrent(operation: Operation): void {
    if (operation.ended || operation.binding.closed || operation.binding.detached || active.get(operation.binding.chatId) !== operation) {
      throw new AgentCallError('rejected', 'Execution has retired', 'STALE_RESOURCE');
    }
  }

  function publisherFor(operation: Operation): AgentRuntimePublisher {
    const binding = operation.binding;
    return (event) => {
      if (event.type === 'permission' && !event.runId) {
        host.logger.warn('Dropped an unnamed provider permission event', {
          chatId: binding.chatId, eventType: event.type, reason: 'missing operation run ID',
        });
        return;
      }
      try {
        let normalized: AgentProducerEvent;
        if (event.type === 'permission') {
          if (event.lifecycle.kind === 'requested') {
            if (event.decision?.permissionOccurrenceId !== event.lifecycle.permissionOccurrenceId) {
              throw new TypeError('Permission response does not match its occurrence');
            }
            if (binding.detached) { denyDetachedPermission(event.decision); return; }
            const response = !operation.ended && active.get(binding.chatId) === operation
              ? responses.add({ operation, capability: event.decision })
              : createAgentResourceRef(host.scope, 'permission-response');
            normalized = { ...event, lifecycle: event.lifecycle, decision: {
              permissionOccurrenceId: event.lifecycle.permissionOccurrenceId, response,
            } };
          } else {
            responses.removeWhere((value) => value.operation === operation
              && value.capability.permissionOccurrenceId === event.lifecycle.permissionOccurrenceId);
            normalized = { type: 'permission', runId: event.runId, lifecycle: event.lifecycle };
          }
        } else normalized = event;
        if (event.type === 'session') {
          operation.agentSessionId = event.session.agentSessionId;
          if (binding.closed) void abortClosedOperation(operation);
        }
        emit(binding, normalized);
        if (event.type === 'session') binding.publishedSession = event.session;
      } catch (error) {
        host.logger.warn('Dropped a provider event for an unavailable transcript sink', {
          chatId: binding.chatId, eventType: event.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (event.type === 'run-ended' && event.runId === operation.runId) {
          retire(operation);
        }
      }
    };
  }

  function construct<T extends { readonly producerBinding: AgentProducerBinding; readonly chatId: string; readonly runId: string }>(
    request: T, options?: ExecutorCallOptions,
  ) {
    options?.signal?.throwIfAborted();
    const binding = bindings.get(request.producerBinding);
    if (binding.detached) throw new AgentCallError('rejected', 'Producer binding has detached', 'STALE_RESOURCE');
    if (binding.chatId !== request.chatId) throw new AgentCallError('rejected', 'Producer chat mismatch', 'STALE_RESOURCE');
    const operation: Operation = {
      binding, runId: request.runId, agentSessionId: null, abortedSessionOnClose: null, ended: false,
      handle: createAgentResourceRef(host.scope, 'execution'),
    };
    const { producerBinding: _binding, ...context } = request;
    const runtimeRequest = { ...context, admission: {
      signal: options?.signal
        ? AbortSignal.any([options.signal, binding.cancellation.signal])
        : binding.cancellation.signal,
      async markStarted() { emit(binding, { type: 'started', runId: request.runId }); },
    } };
    return { operation, runtimeRequest, publish: publisherFor(operation) };
  }

  function activate(operation: Operation): void {
    const prior = active.get(operation.binding.chatId);
    if (prior) retire(prior);
    handles.removeWhere((entry) => entry.binding.chatId === operation.binding.chatId);
    active.set(operation.binding.chatId, operation);
    handles.bind(operation.handle, operation);
  }

  function prepare<T extends { readonly producerBinding: AgentProducerBinding; readonly chatId: string; readonly runId: string }>(request: T, options?: ExecutorCallOptions) {
    const prepared = construct(request, options);
    const prior = active.get(request.chatId);
    if (prior && prior.binding !== prepared.operation.binding) {
      throw new AgentCallError('rejected', 'An earlier turn is still running on the executor. Wait for it to finish or restart the worker.', 'SESSION_BUSY');
    }
    activate(prepared.operation);
    return prepared;
  }

  const execution: AgentExecutionV5 = {
    async start(request, options) {
      const { operation, runtimeRequest, publish } = prepare(request, options);
      try {
        const session = await runtime.start(runtimeRequest, publish);
        operation.agentSessionId = session.agentSessionId;
        if (operation.binding.closed) {
          await abortClosedOperation(operation);
          throw new AgentCallError('rejected', 'Producer binding has closed', 'STALE_RESOURCE');
        }
        if (!sameSession(operation.binding.publishedSession, session)) publish({ type: 'session', session });
        return operation.handle;
      } catch (error) {
        if (operation.binding.closed) await abortClosedOperation(operation);
        retire(operation);
        if (operation.binding.closed) {
          throw new AgentCallError('rejected', 'Producer binding has closed', 'STALE_RESOURCE');
        }
        throw error;
      }
    },
    async resume(request, options) {
      const { operation, runtimeRequest, publish } = prepare(request, options);
      operation.agentSessionId = request.agentSessionId;
      void runtime.resume(runtimeRequest, publish).catch((error) => {
        publish({ type: 'run-ended', runId: request.runId, outcome: 'failed', error: failureDetail(error) });
      });
      return operation.handle;
    },
    async abort(ref, options) {
      options?.signal?.throwIfAborted();
      const operation = handles.get(ref);
      assertCurrent(operation);
      if (!operation.agentSessionId) return false;
      return runtime.abort(operation.agentSessionId);
    },
    async runningSessions() { return runtime.runningSessions(); },
  };

  async function runExisting<R>(
    request: AgentResumeRequestV5,
    operation: (request: AgentRuntimeResumeRequest, publish: AgentRuntimePublisher) => Promise<R>,
    options?: ExecutorCallOptions,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }> {
    const prepared = prepare(request, options);
    prepared.operation.agentSessionId = request.agentSessionId;
    try {
      const value = await operation(prepared.runtimeRequest, prepared.publish);
      return { handle: prepared.operation.handle, value };
    } catch (error) {
      retire(prepared.operation);
      throw error;
    }
  }

  return { execution, producers, permissions, runExisting, expectedOperation, assertCurrent };
}

export type AgentProducerAdapter = ReturnType<typeof createAgentProducerAdapter>;

function sameSession(left: AgentEstablishedSession | null, right: AgentEstablishedSession): boolean {
  return left?.agentSessionId === right.agentSessionId
    && JSON.stringify(left.nativeSession) === JSON.stringify(right.nativeSession)
    && JSON.stringify(left.nativeSeedReceipt) === JSON.stringify(right.nativeSeedReceipt);
}

export function failureDetail(error: unknown): AgentRunFailureDetail {
  if (error instanceof AgentIntegrationError) {
    return { code: error.code, ...(error.message ? { message: error.message } : {}) };
  }
  return { code: 'PROVIDER_FAILURE', ...(error instanceof Error && error.message ? { message: error.message } : {}) };
}
