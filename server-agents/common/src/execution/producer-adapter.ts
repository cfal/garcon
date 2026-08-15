import crypto from 'node:crypto';
import {
  AgentIntegrationError,
  type AgentExecutionHandle,
  type AgentEstablishedSession,
  type AgentExecutionV5,
  type AgentLogger,
  type AgentPermissionLifecycle,
  type AgentProducedRow,
  type AgentProducerSink,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import {
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
} from '@garcon/common/chat-types';
import type {
  AgentRuntimeEvent,
  AgentRuntimePublisher,
  AgentRuntimeExecution,
} from './runtime-events.js';

interface RuntimeHandle extends AgentExecutionHandle {
  readonly agentSessionId: string;
}

interface ProducerBinding {
  readonly sink: AgentProducerSink;
  readonly permissions: Map<string, string>;
  publishedSession: AgentEstablishedSession | null;
}

export interface AgentProducerAdapter {
  readonly execution: AgentExecutionV5;
  runExisting<T extends {
    readonly chatId: string;
    readonly agentSessionId: string;
    readonly sink: AgentProducerSink;
  }, R>(
    request: T,
    operation: (request: Omit<T, 'sink'>, publish: AgentRuntimePublisher) => Promise<R>,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }>;
}

export function createAgentProducerAdapter(
  runtime: AgentRuntimeExecution,
  logger: AgentLogger,
): AgentProducerAdapter {
  // Keyed by the sink itself so state that outlives a single operation, like the session
  // already published, follows the transcript it belongs to. Nothing routes through this map:
  // it is read when a publisher is built, never when an event arrives. A binding becomes
  // collectible once the runtime releases the last publisher holding it.
  const bindings = new WeakMap<AgentProducerSink, ProducerBinding>();

  function bindingFor(sink: AgentProducerSink): ProducerBinding {
    const existing = bindings.get(sink);
    if (existing) return existing;
    const created: ProducerBinding = { sink, permissions: new Map(), publishedSession: null };
    bindings.set(sink, created);
    return created;
  }

  // The capability a runtime publishes through. It closes over one binding, so an operation that
  // outlives its transcript keeps publishing at its own closed sink and has no way to reach a
  // replacement.
  function publisherFor(sink: AgentProducerSink, chatId: string): AgentRuntimePublisher {
    const binding = bindingFor(sink);
    return (event) => {
      try {
        publishRuntimeEvent(binding, event);
      } catch (error) {
        // A closed or fenced sink rejects synchronously, and this runs inside the provider's own
        // event dispatch - which several runtimes share across every chat. Letting the rejection
        // escape would tear that stream down for unrelated chats, so the event is dropped here
        // under the accepted at-most-once loss.
        logger.warn('Dropped a provider event for an unavailable transcript sink', {
          chatId,
          eventType: event.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  const execution: AgentExecutionV5 = {
    async start(request) {
      const binding = bindingFor(request.sink);
      const session = await runtime.start(
        withoutSink(request),
        publisherFor(request.sink, request.chatId),
      );
      if (!sameSession(binding.publishedSession, session)) {
        binding.sink.publish({ type: 'session', session });
        binding.publishedSession = session;
      }
      return handle(session.agentSessionId);
    },

    async resume(request) {
      const binding = bindingFor(request.sink);
      const completion = runtime.resume(
        withoutSink(request),
        publisherFor(request.sink, request.chatId),
      );
      void completion.catch((error) => {
        try {
          binding.sink.publish({
            type: 'run-ended',
            runId: request.runId,
            outcome: 'failed',
            error: failureDetail(error),
          });
        } catch {
          // A closed or fenced sink already made the failed run historical.
        }
      });
      return handle(request.agentSessionId);
    },

    abort(value) {
      return runtime.abort(runtimeHandle(value).agentSessionId);
    },

    runningSessions: () => runtime.runningSessions(),
  };

  async function runExisting<T extends {
    readonly chatId: string;
    readonly agentSessionId: string;
    readonly sink: AgentProducerSink;
  }, R>(
    request: T,
    operation: (request: Omit<T, 'sink'>, publish: AgentRuntimePublisher) => Promise<R>,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }> {
    const value = await operation(
      withoutSink(request),
      publisherFor(request.sink, request.chatId),
    );
    return { handle: handle(request.agentSessionId), value };
  }

  return { execution, runExisting };
}

function publishRuntimeEvent(binding: ProducerBinding, event: AgentRuntimeEvent): void {
  if (event.type === 'messages') {
    publishMessages(binding, event.runId, event.rows);
    return;
  }
  if (event.type === 'session') {
    binding.sink.publish({ type: 'session', session: event.session });
    binding.publishedSession = event.session;
    return;
  }
  binding.sink.publish({
    type: 'run-ended',
    runId: event.runId,
    outcome: event.outcome,
    ...(event.error ? { error: event.error } : {}),
  });
}

function sameSession(
  left: AgentEstablishedSession | null,
  right: AgentEstablishedSession,
): boolean {
  return left?.agentSessionId === right.agentSessionId
    && JSON.stringify(left.nativeSession) === JSON.stringify(right.nativeSession)
    && JSON.stringify(left.nativeSeedReceipt) === JSON.stringify(right.nativeSeedReceipt);
}

function publishMessages(
  binding: ProducerBinding,
  runId: string | null,
  messages: Extract<AgentRuntimeEvent, { readonly type: 'messages' }>['rows'],
): void {
  let pendingRows: AgentProducedRow[] = [];

  function flush(): void {
    if (pendingRows.length === 0) return;
    binding.sink.publish({ type: 'rows', rows: pendingRows });
    pendingRows = [];
  }

  for (const row of messages) {
    const { message } = row;
    // Permission facts stay typed even when no run correlates them. A fresh ID can never
    // match the chat's active run, so core commits the fact as durable history that is
    // never actionable, instead of leaking a permission message into conversational rows.
    if (message instanceof PermissionRequestMessage) {
      flush();
      const incarnation = crypto.randomUUID();
      binding.permissions.set(message.permissionRequestId, incarnation);
      binding.sink.publish({
        type: 'permission',
        runId: runId ?? crypto.randomUUID(),
        lifecycle: {
          kind: 'requested',
          requestId: message.permissionRequestId,
          incarnation,
          requestedTool: message.requestedTool,
          options: [],
        },
      });
      continue;
    }
    if (message instanceof PermissionCancelledMessage) {
      flush();
      binding.sink.publish({
        type: 'permission',
        runId: runId ?? crypto.randomUUID(),
        lifecycle: cancelledLifecycle(binding, message),
      });
      continue;
    }
    if (message instanceof PermissionResolvedMessage) {
      flush();
      binding.permissions.delete(message.permissionRequestId);
      continue;
    }
    pendingRows.push(row);
  }
  flush();
}

function cancelledLifecycle(
  binding: ProducerBinding,
  message: PermissionCancelledMessage,
): Extract<AgentPermissionLifecycle, { readonly kind: 'cancelled' }> {
  const incarnation = binding.permissions.get(message.permissionRequestId) ?? crypto.randomUUID();
  binding.permissions.delete(message.permissionRequestId);
  return {
    kind: 'cancelled',
    requestId: message.permissionRequestId,
    incarnation,
    reason: message.reason ?? null,
  };
}

function withoutSink<T extends { readonly sink: AgentProducerSink }>(request: T): Omit<T, 'sink'> {
  const { sink: _sink, ...runtimeRequest } = request;
  return runtimeRequest;
}

function handle(agentSessionId: string): RuntimeHandle {
  return Object.freeze({ agentSessionId });
}

function runtimeHandle(value: AgentExecutionHandle): RuntimeHandle {
  if (!('agentSessionId' in value) || typeof value.agentSessionId !== 'string') {
    throw new TypeError('Agent execution handle is invalid');
  }
  return value as RuntimeHandle;
}

export function failureDetail(error: unknown): AgentRunFailureDetail {
  if (error instanceof AgentIntegrationError) {
    return { code: error.code, ...(error.message ? { message: error.message } : {}) };
  }
  return {
    code: 'PROVIDER_FAILURE',
    ...(error instanceof Error && error.message ? { message: error.message } : {}),
  };
}
