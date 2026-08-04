import crypto from 'node:crypto';
import type { PermissionMode } from '@garcon/common/chat-modes';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { SSEEvent } from './sse-events.js';

export interface OpenCodeTurnContext {
  eventMetadata: RuntimeEventMetadata;
  // OpenCode assigns this ID and Garcon resolves it from the submitted prompt part event.
  providerMessageId: string | null;
  providerPromptPartId: string;
  providerPromptText: string;
  providerObservedEventId: string | null;
  providerContinuationMessageIds: Set<string>;
  observedUserMessageIds: Set<string>;
  autoCompactionActive: boolean;
  pendingContextOverflowError: string | null;
  assistantMessageIds: Set<string>;
  messageRoles: Map<string, string>;
  assistantPartTypes: Map<string, string>;
}

export interface OpenCodeSession {
  status: 'running' | 'completed' | 'aborted';
  // Set while a provider abort is in flight so the abort unwind's idle cannot claim the
  // turn finished before the abort is acknowledged; a rejected abort replays the skip.
  aborting?: boolean;
  skippedIdleEventId?: string | null;
  chatId: string;
  model?: string;
  permissionMode: PermissionMode;
  directory?: string;
  startedAt: string;
  lastActivityAt: number;
  lastEventId: string | null;
  turn: OpenCodeTurnContext;
}

export function createOpenCodeTurnContext(
  eventMetadata: RuntimeEventMetadata,
  promptText: string,
): OpenCodeTurnContext {
  return {
    eventMetadata,
    providerMessageId: null,
    providerPromptPartId: `prt_${crypto.randomUUID().replaceAll('-', '')}`,
    providerPromptText: promptText,
    providerObservedEventId: null,
    providerContinuationMessageIds: new Set(),
    observedUserMessageIds: new Set(),
    autoCompactionActive: false,
    pendingContextOverflowError: null,
    assistantMessageIds: new Set(),
    messageRoles: new Map(),
    assistantPartTypes: new Map(),
  };
}

export function acceptSequencedOpenCodeTurnEvent(
  session: OpenCodeSession,
  event: SSEEvent,
  logger: AgentLogger,
): boolean {
  if (
    event.type !== 'message.updated'
    && event.type !== 'message.part.updated'
    && event.type !== 'message.part.delta'
    && event.type !== 'permission.asked'
    && event.type !== 'session.status'
    && event.type !== 'session.error'
  ) {
    return true;
  }
  if (typeof event.id !== 'string' || !event.id) {
    logger.warn('Ignoring OpenCode event without an event ID', { eventType: event.type });
    return false;
  }
  if (session.lastEventId && event.id <= session.lastEventId) {
    logger.debug('Ignoring replayed or out-of-order OpenCode event', {
      eventType: event.type,
      eventId: event.id,
    });
    return false;
  }
  session.lastEventId = event.id;
  return true;
}

export function openCodeEventBelongsToTurn(
  session: OpenCodeSession,
  event: SSEEvent,
): boolean {
  const turn = session.turn;
  if (event.type === 'message.updated') {
    const info = event.properties?.info;
    const messageId = typeof info?.id === 'string' ? info.id : '';
    if (info?.role === 'user') {
      if (messageId) turn.observedUserMessageIds.add(messageId);
      if (turn.providerMessageId && messageId === turn.providerMessageId) {
        turn.providerObservedEventId = event.id ?? null;
      }
      return false;
    }
    if (
      info?.role !== 'assistant'
      || !turn.providerMessageId
      || (
        info.parentID !== turn.providerMessageId
        && !turn.providerContinuationMessageIds.has(info.parentID)
      )
      || !messageId
    ) {
      return false;
    }
    turn.providerObservedEventId = event.id ?? null;
    turn.assistantMessageIds.add(messageId);
    return true;
  }
  if (event.type === 'message.part.updated') {
    const part = event.properties?.part;
    const messageId = typeof part?.messageID === 'string' ? part.messageID : '';
    if (turn.providerMessageId === null) {
      // OpenCode preserves caller-owned part IDs while assigning the ordered message ID.
      // https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/prompt.ts#L693-L697
      if (
        !messageId
        || part?.id !== turn.providerPromptPartId
      ) return false;
      turn.providerMessageId = messageId;
      turn.providerObservedEventId = event.id ?? null;
      return false;
    }
    if (messageId && turn.observedUserMessageIds.has(messageId)) {
      if (part?.type === 'compaction' && part.auto === true) {
        turn.autoCompactionActive = true;
        return false;
      }
      const isSyntheticContinuation = part?.synthetic === true;
      const isCompactionReplay = turn.autoCompactionActive
        && part?.type === 'text'
        && part.text === turn.providerPromptText;
      if (isSyntheticContinuation || isCompactionReplay) {
        turn.providerContinuationMessageIds.add(messageId);
      }
      return false;
    }
    return Boolean(messageId) && turn.assistantMessageIds.has(messageId);
  }
  if (event.type === 'message.part.delta') {
    const messageId = event.properties?.messageID;
    return typeof messageId === 'string' && turn.assistantMessageIds.has(messageId);
  }
  if (event.type === 'session.compacted') {
    turn.autoCompactionActive = false;
    turn.pendingContextOverflowError = null;
  }
  return true;
}
