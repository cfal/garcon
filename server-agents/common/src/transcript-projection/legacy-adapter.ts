import type {
  AgentExecution,
  AgentExecutionEvent,
  AgentExecutionV4,
  AgentHost,
  AgentOperationIdentityV4,
  AgentStartedSession,
  AgentSteerResult,
  AgentTranscript,
  AgentTranscriptAccessResult,
  AgentTranscriptRequestV4,
  AgentTurnBoundOperationIdentityV4,
  AgentTurnOwnerOperationIdentityV4,
} from '@garcon/server-agent-interface';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import {
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { randomUUID } from 'node:crypto';
import {
  JournalBackedAgentTranscriptStream,
  transcriptSeedEntries,
} from './journal-stream.js';

export interface LegacyProjectionAdapterOptions {
  readonly ownerId: string;
  readonly host: AgentHost;
  readonly execution: AgentExecution;
  readonly transcript: AgentTranscript;
  readonly sourceSettlement?: (
    event: Extract<AgentExecutionEvent, { readonly type: 'finished' | 'failed' }>,
  ) => AgentTranscriptAccessResult<'confirmed' | 'unresolved'>;
  readonly onProjectionError?: (error: unknown, chatId: string) => void;
}

export interface LegacyProjectionAdapter {
  readonly execution: AgentExecutionV4;
  readonly transcript: JournalBackedAgentTranscriptStream;
  runTracked<T>(
    chatId: string,
    operation: AgentTurnOwnerOperationIdentityV4,
    action: () => Promise<T>,
  ): Promise<T>;
  deliverSteer<T extends AgentSteerResult>(
    chatId: string,
    operation: AgentTurnBoundOperationIdentityV4,
    action: () => Promise<T>,
  ): Promise<T>;
  replaceTrackedOperation(
    chatId: string,
    operation: AgentTurnOwnerOperationIdentityV4,
  ): void;
}

export function createLegacyProjectionAdapter(
  options: LegacyProjectionAdapterOptions,
): LegacyProjectionAdapter {
  const transcript = new JournalBackedAgentTranscriptStream({
    ownerId: options.ownerId,
    directory: () => options.host.storage.directory('transcript-projection-v4'),
    bootstrap: async (request) => access(async () => {
      const snapshot = await options.transcript.load(request);
      return transcriptSeedEntries(options.ownerId, snapshot.messages);
    }),
    resolveNativeSession: (request) => access(() => options.transcript.resolveNativeSession(request)),
    describeSource: (request) => access(() => options.transcript.describeSource(request)),
    releaseProvider: (request) => options.transcript.release(request),
  });
  const operations = new Map<string, AgentTurnOwnerOperationIdentityV4>();
  const chains = new Map<string, Promise<void>>();
  const faults = new Map<string, unknown>();
  const controls = new Map<string, Map<string, string>>();
  const controlOrder = new Map<string, number>();

  const enqueue = (chatId: string, operation: () => Promise<void>): Promise<void> => {
    const previous = chains.get(chatId) ?? Promise.resolve();
    const next = previous.then(operation, operation).catch((error) => {
      faults.set(chatId, error);
      options.onProjectionError?.(error, chatId);
    });
    chains.set(chatId, next);
    return next;
  };

  options.execution.subscribe((event) => {
    const operation = operations.get(event.chatId);
    if (!operation) return;
    void enqueue(event.chatId, async () => {
      const chat = transcript.referenceForOperation(event.chatId, operation);
      if (!chat) throw new TypeError(`Projection segment ${event.chatId} is not open`);
      switch (event.type) {
        case 'messages':
          await projectMessages({
            transcript,
            chat,
            operation,
            messages: event.messages,
            controls,
            controlOrder,
          });
          return;
        case 'processing':
          return;
        case 'session-created':
          await transcript.emitSession(chat, operation, event.session);
          return;
        case 'finished':
        case 'failed': {
          const projectionFault = faults.get(event.chatId);
          const settlement = options.sourceSettlement?.(event)
            ?? { kind: 'ready' as const, value: 'confirmed' as const };
          const sourceSettlement = settlement.kind === 'ready'
            ? settlement.value
            : 'unresolved';
          const outcome = projectionFault
            ? {
                kind: 'failed' as const,
                error: new AgentIntegrationError(
                  'TRANSCRIPT_UNAVAILABLE',
                  'The authoritative transcript projection failed',
                  true,
                ),
              }
            : event.type === 'finished'
              ? { kind: 'finished' as const, exitCode: event.exitCode }
              : { kind: 'failed' as const, error: event.error };
          if ((controls.get(event.chatId)?.size ?? 0) > 0) {
            await transcript.emitControl(chat, operation, {
              kind: 'clear',
            });
            controls.delete(event.chatId);
          }
          await transcript.emitTerminal({
            chat,
            operation,
            outcome,
            sourceSettlement: projectionFault ? 'unresolved' : sourceSettlement,
          });
          operations.delete(event.chatId);
          faults.delete(event.chatId);
          controlOrder.delete(event.chatId);
          return;
        }
      }
    });
  });

  const runTracked = async <T>(
    chatId: string,
    operation: AgentTurnOwnerOperationIdentityV4,
    action: () => Promise<T>,
  ): Promise<T> => {
    const current = operations.get(chatId);
    if (current && !sameOwner(current, operation)) {
      throw new TypeError(`Cannot replace active projection operation for ${chatId}`);
    }
    operations.set(chatId, operation);
    try {
      return await action();
    } catch (error) {
      if (operations.get(chatId) === operation) operations.delete(chatId);
      throw error;
    }
  };

  const adaptedExecution: AgentExecutionV4 = {
    start: async (request) => runTracked(request.chatId, request.operation, () => (
      options.execution.start(withProjectionAdmission(request, transcript))
    )),
    resume: async (request) => runTracked(request.chatId, request.operation, () => (
      options.execution.resume(withProjectionAdmission(request, transcript))
    )),
    abort: (agentSessionId) => options.execution.abort(agentSessionId),
    isRunning: (agentSessionId) => options.execution.isRunning(agentSessionId),
    runningSessions: () => options.execution.runningSessions(),
    ...(options.execution.applySessionConfiguration ? {
      applySessionConfiguration: (agentSessionId, configuration) => (
        options.execution.applySessionConfiguration!(agentSessionId, configuration)
      ),
    } : {}),
    ...(options.execution.respondToPermission ? {
      respondToPermission: (permissionRequestId, decision) => (
        options.execution.respondToPermission!(permissionRequestId, decision)
      ),
    } : {}),
    ...(options.execution.prepareProjectPathUpdate ? {
      prepareProjectPathUpdate: (request) => options.execution.prepareProjectPathUpdate!(request),
    } : {}),
  };

  const deliverSteer = async <T extends AgentSteerResult>(
    chatId: string,
    operation: AgentTurnBoundOperationIdentityV4,
    action: () => Promise<T>,
  ): Promise<T> => {
    const result = await action();
    if (result.kind !== 'accepted') return result;
    const chat = transcript.referenceForOperation(chatId, operation);
    if (!chat) throw new TypeError(`Projection segment ${chatId} is not open`);
    await transcript.promoteActiveInput(chat, operation);
    return result;
  };

  const replaceTrackedOperation = (
    chatId: string,
    operation: AgentTurnOwnerOperationIdentityV4,
  ): void => {
    const current = operations.get(chatId);
    if (current && current.agentOwnershipEpoch !== operation.agentOwnershipEpoch) {
      throw new TypeError(`Cannot replace projection ownership for ${chatId}`);
    }
    operations.set(chatId, operation);
  };

  return {
    execution: adaptedExecution,
    transcript,
    runTracked,
    deliverSteer,
    replaceTrackedOperation,
  };
}

async function projectMessages(options: {
  readonly transcript: JournalBackedAgentTranscriptStream;
  readonly chat: AgentTranscriptRequestV4['chat'];
  readonly operation: AgentTurnBoundOperationIdentityV4;
  readonly messages: readonly ChatMessage[];
  readonly controls: Map<string, Map<string, string>>;
  readonly controlOrder: Map<string, number>;
}): Promise<void> {
  let durable: ChatMessage[] = [];
  const flush = async () => {
    if (!durable.length) return;
    const messages = durable;
    durable = [];
    await options.transcript.appendMessages({
      chat: options.chat,
      operation: options.operation,
      messages,
    });
  };
  for (const message of options.messages) {
    if (message instanceof PermissionRequestMessage) {
      await flush();
      const byId = options.controls.get(options.chat.chatId) ?? new Map<string, string>();
      const incarnation = byId.get(message.permissionRequestId) ?? randomUUID();
      byId.set(message.permissionRequestId, incarnation);
      options.controls.set(options.chat.chatId, byId);
      const displayOrder = options.controlOrder.get(options.chat.chatId) ?? 0;
      options.controlOrder.set(options.chat.chatId, displayOrder + 1);
      await options.transcript.emitControl(options.chat, options.operation, {
        kind: 'upsert',
        row: {
          id: message.permissionRequestId,
          incarnation,
          operation: options.operation,
          anchorEntryId: null,
          displayOrder,
          message,
        },
      });
      continue;
    }
    if (message instanceof PermissionResolvedMessage
        || message instanceof PermissionCancelledMessage) {
      await flush();
      const byId = options.controls.get(options.chat.chatId);
      const incarnation = byId?.get(message.permissionRequestId);
      if (!incarnation) continue;
      await options.transcript.emitControl(options.chat, options.operation, {
        kind: 'remove',
        id: message.permissionRequestId,
        incarnation,
      });
      byId?.delete(message.permissionRequestId);
      if (byId?.size === 0) options.controls.delete(options.chat.chatId);
      continue;
    }
    durable.push(message);
  }
  await flush();
}

function withProjectionAdmission<
  Request extends {
    readonly chatId: string;
    readonly operation: AgentTurnOwnerOperationIdentityV4;
    readonly admission: import('@garcon/server-agent-interface').AgentExecutionAdmission;
  },
>(
  request: Request,
  transcript: JournalBackedAgentTranscriptStream,
): Request {
  let promotion: Promise<void> | null = null;
  return {
    ...request,
    admission: {
      signal: request.admission.signal,
      markStarted: () => {
        const chat = transcript.referenceForOperation(request.chatId, request.operation);
        if (!chat) throw new TypeError(`Projection segment ${request.chatId} is not open`);
        promotion ??= transcript.promoteActiveInput(chat, request.operation);
        void promotion.catch(() => {});
        request.admission.markStarted();
      },
      markAbortable: () => request.admission.markAbortable(),
    },
  };
}

async function access<T>(action: () => Promise<T>): Promise<AgentTranscriptAccessResult<T>> {
  try {
    return { kind: 'ready', value: await action() };
  } catch (error) {
    if (error instanceof AgentIntegrationError) {
      return { kind: 'degraded', errorCode: error.code, retryable: error.retryable };
    }
    throw error;
  }
}

function sameOwner(
  left: AgentTurnOwnerOperationIdentityV4,
  right: AgentTurnOwnerOperationIdentityV4,
): boolean {
  return left.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.turnOwner.clientRequestId === right.turnOwner.clientRequestId
    && left.turnOwner.turnId === right.turnOwner.turnId;
}
