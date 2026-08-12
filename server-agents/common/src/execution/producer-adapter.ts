import crypto from 'node:crypto';
import {
  AgentIntegrationError,
  agentOwnershipEpoch,
  type AgentExecutionHandle,
  type AgentExecutionV5,
  type AgentPermissionLifecycle,
  type AgentProducerSink,
  type AgentRunFailureDetail,
  type AgentStartRequestV5,
  type AgentResumeRequestV5,
  type AgentTurnOwnerOperationIdentityV4,
} from '@garcon/server-agent-interface';
import {
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
} from '@garcon/common/chat-types';
import type {
  AgentProjectionProducerEvent,
  AgentProjectionProducerMessage,
  AgentProjectionRuntimeExecution,
} from './projection-events.js';

interface RuntimeHandle extends AgentExecutionHandle {
  readonly agentSessionId: string;
}

interface ProducerBinding {
  readonly sink: AgentProducerSink;
  readonly permissions: Map<string, string>;
}

export interface AgentProducerAdapter {
  readonly execution: AgentExecutionV5;
}

export function createAgentProducerAdapter(
  runtime: AgentProjectionRuntimeExecution,
): AgentProducerAdapter {
  const bindings = new WeakMap<AgentTurnOwnerOperationIdentityV4, ProducerBinding>();

  runtime.subscribeProjectionEvents((event) => {
    const binding = bindings.get(event.operation);
    if (!binding) return;
    publishRuntimeEvent(binding, event);
  });

  const execution: AgentExecutionV5 = {
    async start(request) {
      const operation = operationFor(request, 'chat-start');
      bindings.set(operation, { sink: request.sink, permissions: new Map() });
      const session = await runtime.start(toStartRequest(request, operation));
      return handle(session.agentSessionId);
    },

    async resume(request) {
      const operation = operationFor(request, 'agent-run');
      bindings.set(operation, { sink: request.sink, permissions: new Map() });
      await runtime.resume(toResumeRequest(request, operation));
      return handle(request.agentSessionId);
    },

    abort(value) {
      return runtime.abort(runtimeHandle(value).agentSessionId);
    },

    runningSessions: () => runtime.runningSessions(),
  };

  return { execution };
}

function publishRuntimeEvent(
  binding: ProducerBinding,
  event: AgentProjectionProducerEvent,
): void {
  switch (event.type) {
    case 'messages':
      publishMessages(binding, event.operation.turnId, event.messages);
      return;
    case 'session-created':
      binding.sink.publish({ type: 'session', session: event.session });
      return;
    case 'finished':
      binding.sink.publish({
        type: 'run-ended',
        runId: event.operation.turnId,
        outcome: 'finished',
      });
      return;
    case 'failed':
      binding.sink.publish({
        type: 'run-ended',
        runId: event.operation.turnId,
        outcome: 'failed',
        error: failureDetail(event.error),
      });
      return;
    case 'processing':
      return;
  }
}

function publishMessages(
  binding: ProducerBinding,
  runId: string,
  messages: readonly AgentProjectionProducerMessage[],
): void {
  let rows: AgentProjectionProducerMessage[] = [];
  const flush = () => {
    if (rows.length === 0) return;
    binding.sink.publish({
      type: 'rows',
      rows: rows.map((row) => ({
        message: row.message,
        ...(row.nativeAlias ? { providerMeta: row.nativeAlias } : {}),
      })),
    });
    rows = [];
  };

  for (const row of messages) {
    const { message } = row;
    if (message instanceof PermissionRequestMessage) {
      flush();
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
    rows.push(row);
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

function operationFor(
  request: AgentStartRequestV5 | AgentResumeRequestV5,
  commandType: 'chat-start' | 'agent-run',
): AgentTurnOwnerOperationIdentityV4 {
  const ownership = agentOwnershipEpoch('v5-runtime-adapter');
  const turnOwner = {
    agentOwnershipEpoch: ownership,
    commandType,
    clientRequestId: request.runId,
    turnId: request.runId,
  } as const;
  return {
    agentOwnershipEpoch: ownership,
    commandType,
    clientRequestId: request.runId,
    clientMessageId: null,
    turnId: request.runId,
    turnOwner,
  };
}

function toStartRequest(
  request: AgentStartRequestV5,
  operation: AgentTurnOwnerOperationIdentityV4,
): Parameters<AgentProjectionRuntimeExecution['start']>[0] {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    settings: request.settings,
    endpoint: request.endpoint,
    operation,
    admission: request.admission,
    priorContext: request.priorContext,
    prompt: request.prompt,
    attachments: request.attachments,
    carriedContext: request.carriedContext,
  };
}

function toResumeRequest(
  request: AgentResumeRequestV5,
  operation: AgentTurnOwnerOperationIdentityV4,
): Parameters<AgentProjectionRuntimeExecution['resume']>[0] {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    settings: request.settings,
    endpoint: request.endpoint,
    operation,
    admission: request.admission,
    priorContext: request.priorContext,
    agentSessionId: request.agentSessionId,
    nativeSession: request.nativeSession,
    prompt: request.prompt,
    attachments: request.attachments,
  };
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

function failureDetail(error: unknown): AgentRunFailureDetail {
  if (error instanceof AgentIntegrationError) {
    return { code: error.code, ...(error.message ? { message: error.message } : {}) };
  }
  return {
    code: 'PROVIDER_FAILURE',
    ...(error instanceof Error && error.message ? { message: error.message } : {}),
  };
}
