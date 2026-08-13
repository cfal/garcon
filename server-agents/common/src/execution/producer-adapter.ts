import crypto from 'node:crypto';
import {
  AgentIntegrationError,
  type AgentExecutionHandle,
  type AgentEstablishedSession,
  type AgentExecutionV5,
  type AgentPermissionLifecycle,
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
    operation: (request: Omit<T, 'sink'>) => Promise<R>,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }>;
}

export function createAgentProducerAdapter(runtime: AgentRuntimeExecution): AgentProducerAdapter {
  const bindings = new Map<string, ProducerBinding>();

  runtime.subscribeRuntimeEvents((event) => {
    const binding = bindings.get(event.chatId);
    if (binding) publishRuntimeEvent(binding, event);
  });

  const execution: AgentExecutionV5 = {
    async start(request) {
      const binding: ProducerBinding = {
        sink: request.sink,
        permissions: new Map<string, string>(),
        publishedSession: null,
      };
      bindings.set(request.chatId, binding);
      const session = await runtime.start(withoutSink(request));
      if (!sameSession(binding.publishedSession, session)) {
        binding.sink.publish({ type: 'session', session });
        binding.publishedSession = session;
      }
      return handle(session.agentSessionId);
    },

    async resume(request) {
      const binding: ProducerBinding = {
        sink: request.sink,
        permissions: new Map(),
        publishedSession: null,
      };
      bindings.set(request.chatId, binding);
      const execution = runtime.resume(withoutSink(request));
      void execution.catch((error) => {
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
    operation: (request: Omit<T, 'sink'>) => Promise<R>,
  ): Promise<{ readonly handle: AgentExecutionHandle; readonly value: R }> {
    bindings.set(request.chatId, {
      sink: request.sink,
      permissions: new Map(),
      publishedSession: null,
    });
    const value = await operation(withoutSink(request));
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
  let rows: typeof messages = [];
  const flush = () => {
    if (rows.length === 0) return;
    binding.sink.publish({ type: 'rows', rows });
    rows = [];
  };

  for (const row of messages) {
    const { message } = row;
    if (message instanceof PermissionRequestMessage) {
      flush();
      if (!runId) {
        binding.sink.publish({ type: 'rows', rows: [row] });
        continue;
      }
      const incarnation = crypto.randomUUID();
      binding.permissions.set(message.permissionRequestId, incarnation);
      binding.sink.publish({
        type: 'permission',
        runId,
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
      if (!runId) {
        binding.sink.publish({ type: 'rows', rows: [row] });
        continue;
      }
      binding.sink.publish({
        type: 'permission',
        runId,
        lifecycle: cancelledLifecycle(binding, message),
      });
      continue;
    }
    if (message instanceof PermissionResolvedMessage) {
      flush();
      binding.permissions.delete(message.permissionRequestId);
      continue;
    }
    rows = [...rows, row];
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
