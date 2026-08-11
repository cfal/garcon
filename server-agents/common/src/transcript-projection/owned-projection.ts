import type {
  AgentExecutionV4,
  AgentHost,
  AgentOperationIdentityV4,
  AgentStartedSession,
  AgentSteerResult,
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
} from '@garcon/common/chat-types';
import { randomUUID } from 'node:crypto';
import type { AgentNativeEvidenceSource } from './evidence-source.js';
import {
  JournalBackedAgentTranscriptStream,
  transcriptSeedEntries,
  type AgentProviderSettlement,
} from './journal-stream.js';
import type {
  AgentProjectionProducerMessage,
  AgentProjectionProducerEvent,
  AgentProjectionRuntimeExecution,
} from '../execution/projection-events.js';

export interface AgentOwnedProjectionOptions {
  readonly ownerId: string;
  readonly host: AgentHost;
  readonly execution: AgentProjectionRuntimeExecution;
  readonly nativeEvidence: AgentNativeEvidenceSource;
  readonly sourceSettlement?: (
    event: Extract<AgentProjectionProducerEvent, { readonly type: 'finished' | 'failed' }>,
  ) =>
    | AgentTranscriptAccessResult<AgentProviderSettlement>
    | Promise<AgentTranscriptAccessResult<AgentProviderSettlement>>;
  readonly onProjectionError?: (error: unknown, chatId: string) => void;
}

export interface AgentOwnedProjection {
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

export function createAgentOwnedProjection(
  options: AgentOwnedProjectionOptions,
): AgentOwnedProjection {
  const transcript = new JournalBackedAgentTranscriptStream({
    ownerId: options.ownerId,
    directory: () => options.host.storage.directory('transcript-projection-v4'),
    bootstrap: async (request) => access(async () => {
      const snapshot = await options.nativeEvidence.load(request);
      return transcriptSeedEntries(options.ownerId, snapshot.messages);
    }),
    resolveNativeSession: (request) => access(() => options.nativeEvidence.resolveNativeSession(request)),
    describeSource: (request) => access(() => options.nativeEvidence.describeSource(request)),
    releaseProvider: (request) => options.nativeEvidence.release(request),
  });
  const operations = new Map<string, AgentTurnOwnerOperationIdentityV4>();
  const attributions = new Map<string, AgentTurnBoundOperationIdentityV4>();
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

  options.execution.subscribeProjectionEvents((event) => {
    const terminalOperation = operations.get(event.chatId);
    if (!terminalOperation || !sameOwner(terminalOperation, event.operation)) return;
    const causalOperation = attributions.get(event.chatId) ?? terminalOperation;
    void enqueue(event.chatId, async () => {
      const chat = transcript.referenceForOperation(event.chatId, terminalOperation);
      if (!chat) throw new TypeError(`Projection segment ${event.chatId} is not open`);
      switch (event.type) {
        case 'messages':
          await projectMessages({
            transcript,
            chat,
            operation: causalOperation,
            messages: event.messages,
            controls,
            controlOrder,
          });
          return;
        case 'processing':
          return;
        case 'session-created':
          await transcript.emitSession(chat, terminalOperation, event.session);
          return;
        case 'finished':
        case 'failed': {
          const projectionFault = faults.get(event.chatId);
          if ((controls.get(event.chatId)?.size ?? 0) > 0) {
            await transcript.emitControl(chat, causalOperation, {
              kind: 'clear',
            });
            controls.delete(event.chatId);
          }
          // One gated settled boundary: the provider persistence proof runs
          // first, and the audited evidence is read at or after it, so the
          // boundary leaves aliases, fences, and imported missed output
          // coherent before the terminal publishes. A boundary that throws
          // cannot prove settlement, so a finished provider outcome is
          // withheld as a retryable failure instead of publishing success the
          // audit never established.
          let sourceSettlement: 'confirmed' | 'unresolved' = 'unresolved';
          let boundaryFailure: unknown = null;
          try {
            sourceSettlement = await transcript.settleNativeBoundary({
              chat,
              operation: causalOperation,
              signal: AbortSignal.timeout(10_000),
              sourceSettlement: options.sourceSettlement
                ? async () => {
                    const settlement = await options.sourceSettlement!(event);
                    return settlement.kind === 'ready'
                      ? settlement.value
                      : { verdict: 'unresolved' as const };
                  }
                : undefined,
            });
          } catch (error) {
            boundaryFailure = error;
            options.onProjectionError?.(error, event.chatId);
          }
          const settled = sourceSettlement === 'confirmed' && boundaryFailure === null;
          const outcome = projectionFault
            ? {
                kind: 'failed' as const,
                error: new AgentIntegrationError(
                  'TRANSCRIPT_UNAVAILABLE',
                  'The authoritative transcript projection failed',
                  true,
                ),
              }
            : event.type === 'failed'
              ? { kind: 'failed' as const, error: event.error }
              : settled
                ? { kind: 'finished' as const, exitCode: event.exitCode }
                : {
                    kind: 'failed' as const,
                    error: new AgentIntegrationError(
                      'TRANSCRIPT_UNAVAILABLE',
                      'The provider transcript was not proven settled for this turn',
                      true,
                    ),
                  };
          await transcript.emitTerminal({
            chat,
            operation: terminalOperation,
            outcome,
            sourceSettlement: projectionFault || boundaryFailure ? 'unresolved' : sourceSettlement,
          });
          operations.delete(event.chatId);
          attributions.delete(event.chatId);
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
    attributions.set(chatId, operation);
    try {
      const result = await action();
      // Blocking provider runtimes emit their terminal callback before their
      // execution promise resolves. Flush that already-enqueued frontier so
      // core cannot observe provider idle ahead of projection persistence.
      await (chains.get(chatId) ?? Promise.resolve());
      return result;
    } catch (error) {
      if (operations.get(chatId) === operation) operations.delete(chatId);
      if (sameOperation(attributions.get(chatId), operation)) attributions.delete(chatId);
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
    const owner = operations.get(chatId);
    if (!owner || !sameTurnOwner(owner.turnOwner, operation.turnOwner)) {
      throw new TypeError(`Cannot attribute a steer outside the active turn for ${chatId}`);
    }
    const previous = attributions.get(chatId) ?? owner;
    attributions.set(chatId, operation);
    try {
      const result = await action();
      if (result.kind !== 'accepted') {
        if (sameOperation(attributions.get(chatId), operation)) attributions.set(chatId, previous);
        return result;
      }
      const chat = transcript.referenceForOperation(chatId, operation);
      if (!chat) throw new TypeError(`Projection segment ${chatId} is not open`);
      await transcript.promoteActiveInput(chat, operation);
      return result;
    } catch (error) {
      if (sameOperation(attributions.get(chatId), operation)) attributions.set(chatId, previous);
      throw error;
    }
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
    attributions.set(chatId, operation);
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
  readonly messages: readonly AgentProjectionProducerMessage[];
  readonly controls: Map<string, Map<string, string>>;
  readonly controlOrder: Map<string, number>;
}): Promise<void> {
  let durable: AgentProjectionProducerMessage[] = [];
  const flush = async () => {
    if (!durable.length) return;
    const messages = durable;
    durable = [];
    await options.transcript.appendMessages({
      chat: options.chat,
      operation: options.operation,
      messages: messages.map((record) => record.message),
      sources: messages.map((record) => ({
        source: record.source,
        nativeAlias: record.nativeAlias,
      })),
    });
  };
  for (const record of options.messages) {
    const message = record.message;
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
      durable.push(record);
      continue;
    }
    durable.push(record);
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
      markStarted: async () => {
        const chat = transcript.referenceForOperation(request.chatId, request.operation);
        if (!chat) throw new TypeError(`Projection segment ${request.chatId} is not open`);
        promotion ??= transcript.promoteActiveInput(chat, request.operation);
        await promotion;
        await request.admission.markStarted();
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

function sameTurnOwner(
  left: AgentTurnBoundOperationIdentityV4['turnOwner'],
  right: AgentTurnBoundOperationIdentityV4['turnOwner'],
): boolean {
  return left.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.clientRequestId === right.clientRequestId
    && left.turnId === right.turnId;
}

function sameOperation(
  left: AgentTurnBoundOperationIdentityV4 | undefined,
  right: AgentTurnBoundOperationIdentityV4,
): boolean {
  return left?.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.commandType === right.commandType
    && left.clientRequestId === right.clientRequestId
    && left.clientMessageId === right.clientMessageId
    && left.turnId === right.turnId
    && sameTurnOwner(left.turnOwner, right.turnOwner);
}
