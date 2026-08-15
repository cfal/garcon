import crypto from 'node:crypto';
import type { PermissionMode } from '@garcon/common/chat-modes';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';
import type { SSEEvent } from './sse-events.js';

export interface OpenCodeTurnContext {
  eventMetadata: RuntimeEventMetadata;
  operation: AgentRuntimeOperation;
  // OpenCode assigns this ID and Garcon resolves it from the submitted prompt part event.
  providerMessageId: string | null;
  providerPromptPartId: string;
  providerPromptText: string;
  providerObservedEventId: string | null;
  providerContinuationMessageIds: Set<string>;
  recentEventIds: Set<string>;
  providerSteeringPartIds: Set<string>;
  pendingSteeringMessageIds: Set<string>;
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
  // A transport or control-plane failure can retire Garcon's turn while OpenCode still owns
  // provider work. The next turn aborts that work before submitting another prompt.
  providerWorkRequiresQuiescence: boolean;
  // Terminal session events have no prompt identity. Recovery drops the abort backlog until
  // OpenCode publishes the exact caller-owned part for the successor prompt.
  terminalEventsFencedUntilPrompt: boolean;
  activeSteeringDeliveries: number;
  deferredIdleEventId: string | null;
  // A stopped turn leaves accepted follow-up messages in OpenCode's transcript. The next
  // prompt reverts the earliest unconsumed one before OpenCode can include it in model input.
  pendingSteeringRevertMessageId: string | null;
  turn: OpenCodeTurnContext;
}

// OpenCode assigns IDs before durable commits, so concurrent publishers can deliver unseen
// events outside lexical order. The bounded window rejects actual duplicates without making
// ordering an arrival contract; durable sequence metadata can replace it if global replay grows.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/core/src/event.ts#L419-L437
const RECENT_EVENT_ID_LIMIT = 512;

export function createOpenCodeTurnContext(
  eventMetadata: RuntimeEventMetadata,
  promptText: string,
  operation: AgentRuntimeOperation,
): OpenCodeTurnContext {
  return {
    eventMetadata,
    operation,
    providerMessageId: null,
    providerPromptPartId: createOpenCodePromptPartId(),
    providerPromptText: promptText,
    providerObservedEventId: null,
    providerContinuationMessageIds: new Set(),
    recentEventIds: new Set(),
    providerSteeringPartIds: new Set(),
    pendingSteeringMessageIds: new Set(),
    observedUserMessageIds: new Set(),
    autoCompactionActive: false,
    pendingContextOverflowError: null,
    assistantMessageIds: new Set(),
    messageRoles: new Map(),
    assistantPartTypes: new Map(),
  };
}

export function createOpenCodePromptPartId(): string {
  return `prt_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function observeOpenCodeSteeringPart(
  session: OpenCodeSession,
  event: SSEEvent,
): string | null {
  if (event.type !== 'message.part.updated') return null;
  const part = event.properties?.part;
  const partId = typeof part?.id === 'string' ? part.id : '';
  const messageId = typeof part?.messageID === 'string' ? part.messageID : '';
  if (!partId || !messageId || !session.turn.providerSteeringPartIds.has(partId)) return null;

  session.turn.providerContinuationMessageIds.add(messageId);
  session.turn.pendingSteeringMessageIds.add(messageId);
  session.turn.providerObservedEventId = event.id ?? null;
  return partId;
}

export function acceptUniqueOpenCodeTurnEvent(
  turn: OpenCodeTurnContext,
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
    && event.type !== 'session.compacted'
  ) {
    return true;
  }
  if (typeof event.id !== 'string' || !event.id) {
    logger.warn('Ignoring OpenCode event without an event ID', { eventType: event.type });
    return false;
  }
  if (turn.recentEventIds.has(event.id)) {
    logger.debug('Ignoring replayed OpenCode event', {
      eventType: event.type,
      eventId: event.id,
    });
    return false;
  }
  turn.recentEventIds.add(event.id);
  if (turn.recentEventIds.size > RECENT_EVENT_ID_LIMIT) {
    const oldestEventId = turn.recentEventIds.values().next().value;
    if (oldestEventId) turn.recentEventIds.delete(oldestEventId);
  }
  return true;
}

export function openCodeEventBelongsToTurn(
  turn: OpenCodeTurnContext,
  event: SSEEvent,
  onPromptBound?: () => void,
): boolean {
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
    turn.pendingSteeringMessageIds.delete(info.parentID);
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
      onPromptBound?.();
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
