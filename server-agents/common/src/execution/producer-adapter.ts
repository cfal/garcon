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
  type NodeCallOptions,
} from '@garcon/server-agent-interface';
import { AgentResourceTable } from './resource-table.js';
import type {
  AgentRuntimePublisher,
  AgentRuntimeExecution,
  AgentRuntimeResumeRequest,
  AgentRuntimeEvent,
  RuntimePermissionResponse,
} from './runtime-events.js';

interface ProducerBinding {
  readonly ref: AgentProducerBinding;
  readonly chatId: string;
  closed: boolean;
  publishedSession: AgentEstablishedSession | null;
}

interface Operation {
  readonly binding: ProducerBinding;
  readonly runId: string;
  agentSessionId: string | null;
  ended: boolean;
  slot: ExecutionSlot | null;
  redirect: Operation | null;
  terminal: ((event: Extract<AgentRuntimeEvent, { type: 'run-ended' }>) => boolean) | null;
  afterEnd: (() => void) | null;
}

interface ExecutionSlot {
  current: Operation;
  ref: AgentExecutionHandle;
  cancelPreparation: (() => void) | null;
}

export function createAgentProducerAdapter(runtime: AgentRuntimeExecution, host: Pick<AgentHost, 'logger' | 'scope'>) {
  const bindings = new AgentResourceTable<'producer', ProducerBinding>(host.scope, 'producer');
  const handles = new AgentResourceTable<'execution', ExecutionSlot>(host.scope, 'execution');
  const responses = new AgentResourceTable<'permission-response', {
    readonly operation: Operation;
    readonly capability: RuntimePermissionResponse;
  }>(host.scope, 'permission-response');
  const listeners = new Set<(notification: AgentProducerNotification) => void>();
  const active = new Map<string, Operation>();

  function emit(binding: ProducerBinding, event: AgentProducerNotification['event']): void {
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
    responses.removeWhere((value) => value.operation === operation);
  }

  const producers: AgentProducers = {
    scope: host.scope,
    async bind({ binding, chatId }, options) {
      options?.signal?.throwIfAborted();
      if (!chatId) throw new TypeError('Producer chat ID is required');
      bindings.bind(binding, { ref: binding, chatId, closed: false, publishedSession: null });
    },
    async close(ref) {
      const binding = bindings.get(ref);
      binding.closed = true;
      bindings.delete(ref);
      handles.removeWhere((slot) => {
        if (slot.current.binding !== binding) return false;
        slot.cancelPreparation?.();
        return true;
      });
      responses.removeWhere((value) => value.operation.binding === binding);
      const operation = active.get(binding.chatId);
      if (operation?.binding === binding) active.delete(binding.chatId);
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
    if (operation.ended || operation.binding.closed || active.get(operation.binding.chatId) !== operation) {
      throw new AgentCallError('rejected', 'Execution has retired', 'STALE_RESOURCE');
    }
  }

  function publisherFor(operation: Operation): AgentRuntimePublisher {
    const binding = operation.binding;
    return (event) => {
      if ('runId' in event && event.runId === operation.runId && operation.redirect) {
        const successor = operation.slot!.current;
        publisherFor(successor)({ ...event, runId: successor.runId });
        return;
      }
      if (event.type === 'run-ended' && event.runId === operation.runId && operation.terminal?.(event)) return;
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
        emit(binding, normalized);
        if (event.type === 'session') {
          binding.publishedSession = event.session;
          operation.agentSessionId = event.session.agentSessionId;
        }
      } catch (error) {
        host.logger.warn('Dropped a provider event for an unavailable transcript sink', {
          chatId: binding.chatId, eventType: event.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (event.type === 'run-ended' && event.runId === operation.runId) {
          retire(operation);
          operation.afterEnd?.();
        }
      }
    };
  }

  function construct<T extends { readonly producerBinding: AgentProducerBinding; readonly chatId: string; readonly runId: string }>(
    request: T, options?: NodeCallOptions,
  ) {
    options?.signal?.throwIfAborted();
    const binding = bindings.get(request.producerBinding);
    if (binding.chatId !== request.chatId) throw new AgentCallError('rejected', 'Producer chat mismatch', 'STALE_RESOURCE');
    const operation: Operation = {
      binding, runId: request.runId, agentSessionId: null, ended: false,
      slot: null, redirect: null, terminal: null, afterEnd: null,
    };
    const { producerBinding: _binding, ...context } = request;
    const runtimeRequest = { ...context, admission: {
      signal: options?.signal ?? new AbortController().signal,
      async markStarted() { emit(binding, { type: 'started', runId: request.runId }); },
    } };
    return { operation, runtimeRequest, publish: publisherFor(operation) };
  }

  function activate(operation: Operation): void {
    const prior = active.get(operation.binding.chatId);
    if (prior) retire(prior);
    handles.removeWhere((entry) => {
      if (entry.current.binding.chatId !== operation.binding.chatId || entry.current === operation) return false;
      entry.cancelPreparation?.();
      return true;
    });
    active.set(operation.binding.chatId, operation);
    const ref = createAgentResourceRef(host.scope, 'execution');
    const slot: ExecutionSlot = { current: operation, ref, cancelPreparation: null };
    handles.bind(ref, slot);
    operation.slot = slot;
  }

  function prepare<T extends { readonly producerBinding: AgentProducerBinding; readonly chatId: string; readonly runId: string }>(request: T, options?: NodeCallOptions) {
    const prepared = construct(request, options);
    activate(prepared.operation);
    return prepared;
  }

  function prepareSuccessor(predecessor: Operation, request: AgentResumeRequestV5, options?: NodeCallOptions) {
    assertCurrent(predecessor);
    const slot = predecessor.slot!;
    if (slot.cancelPreparation) throw new AgentCallError('rejected', 'A goal preparation is already pending');
    const prepared = construct(request, options);
    if (prepared.operation.binding !== predecessor.binding || predecessor.agentSessionId !== request.agentSessionId) {
      throw new AgentCallError('rejected', 'Goal predecessor mismatch', 'STALE_RESOURCE');
    }
    prepared.operation.agentSessionId = request.agentSessionId;
    prepared.operation.slot = slot;
    let activated = false;
    let exposed = false;
    let cancelled = false;
    let completed = false;
    let failure: AgentRunFailureDetail | undefined;
    let terminal: Extract<AgentRuntimeEvent, { type: 'run-ended' }> | null = null;
    let reservation = () => { cancelled = true; };
    slot.cancelPreparation = reservation;
    const releasePreparation = () => {
      if (slot.cancelPreparation === reservation) slot.cancelPreparation = null;
    };
    const failedTerminal = () => ({
      type: 'run-ended' as const, runId: request.runId, outcome: 'failed' as const,
      error: failure ?? { code: 'PROVIDER_FAILURE', message: 'Goal control was not delivered' },
    });
    prepared.operation.terminal = (event) => {
      if (!completed) { terminal ??= event; return true; }
      if (failure) {
        prepared.operation.terminal = null;
        prepared.publish(failedTerminal());
        return true;
      }
      return false;
    };
    return {
      ...prepared,
      handle: slot.ref,
      releasePreparation,
      expose: (cancel: () => void) => {
        if (cancelled) { cancel(); throw new AgentCallError('rejected', 'Goal preparation interrupted', 'STALE_RESOURCE'); }
        exposed = true;
        slot.cancelPreparation = reservation = cancel;
        predecessor.afterEnd = () => {
          if (exposed && !activated) {
            prepared.operation.terminal = null;
            prepared.publish(failedTerminal());
            exposed = false;
          }
        };
      },
      activate: () => {
        assertCurrent(predecessor);
        releasePreparation();
        predecessor.afterEnd = null;
        predecessor.redirect = prepared.operation;
        retire(predecessor);
        slot.current = prepared.operation;
        active.set(request.chatId, prepared.operation);
        activated = true;
      },
      settle: (error?: unknown) => {
        completed = true;
        if (error !== undefined) failure = failureDetail(error);
        if (terminal) {
          prepared.publish(failure ? failedTerminal() : terminal);
          terminal = null;
        }
      },
      abandon: () => {
        exposed = false;
        releasePreparation();
        predecessor.afterEnd = null;
        retire(prepared.operation);
      },
    };
  }

  const execution: AgentExecutionV5 = {
    async start(request, options) {
      const { operation, runtimeRequest, publish } = prepare(request, options);
      try {
        const session = await runtime.start(runtimeRequest, publish);
        operation.agentSessionId = session.agentSessionId;
        if (!sameSession(operation.binding.publishedSession, session)) publish({ type: 'session', session });
        return operation.slot!.ref;
      } catch (error) {
        retire(operation);
        throw error;
      }
    },
    async resume(request, options) {
      const { operation, runtimeRequest, publish } = prepare(request, options);
      operation.agentSessionId = request.agentSessionId;
      void runtime.resume(runtimeRequest, publish).catch((error) => {
        publish({ type: 'run-ended', runId: request.runId, outcome: 'failed', error: failureDetail(error) });
      });
      return operation.slot!.ref;
    },
    async abort(ref, options) {
      options?.signal?.throwIfAborted();
      const slot = handles.get(ref);
      slot.cancelPreparation?.();
      slot.cancelPreparation = null;
      const operation = slot.current;
      assertCurrent(operation);
      if (!operation.agentSessionId) return false;
      return runtime.abort(operation.agentSessionId);
    },
    async runningSessions() { return runtime.runningSessions(); },
  };

  async function runExisting<R>(
    request: AgentResumeRequestV5,
    operation: (request: AgentRuntimeResumeRequest, publish: AgentRuntimePublisher) => Promise<R>,
    options?: NodeCallOptions,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }> {
    const prepared = prepare(request, options);
    prepared.operation.agentSessionId = request.agentSessionId;
    try {
      const value = await operation(prepared.runtimeRequest, prepared.publish);
      return { handle: prepared.operation.slot!.ref, value };
    } catch (error) {
      retire(prepared.operation);
      throw error;
    }
  }

  return { execution, producers, permissions, runExisting, expectedOperation, assertCurrent, prepareSuccessor };
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
