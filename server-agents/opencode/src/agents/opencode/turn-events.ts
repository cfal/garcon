import crypto from 'node:crypto';
import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';
import {
  isOpenCodeCompactionAssistant,
  type OpenCodeAssistantTerminal,
  type SSEEvent,
} from './sse-events.js';

export interface OpenCodeTurnContext {
  operation: AgentRuntimeOperation;
  // A manual compaction turn: the provider's summary assistant settles the turn
  // and its internals stay out of the transcript.
  compaction?: boolean;
  // Later message updates retain the completed timestamp, so a manual turn
  // would otherwise republish its boundary.
  manualCompactionBoundaryPublished?: boolean;
  // OpenCode assigns this ID and Garcon resolves it from the submitted prompt part event.
  providerMessageId: string | null;
  providerPromptPartId: string;
  providerPromptRequestCompleted: boolean;
  providerSteeringDeliveryUnconfirmed: boolean;
  // Identity of the last surfaced retry notice so stream replays and repeated
  // status frames for the same scheduled attempt append one row, not many.
  lastRetryNoticeKey: string | null;
  providerContinuationMessageIds: Set<string>;
  // Tracks automatic control messages and linked summary assistants so prompt
  // failures exclude internal compaction work.
  automaticCompactionMessageIds: Set<string>;
  recentEventIds: Set<string>;
  providerSteeringPartIds: Set<string>;
  pendingSteeringMessageIds: Set<string>;
  observedUserMessageIds: Set<string>;
  assistantMessageIds: Set<string>;
  assistantTerminals: Map<string, OpenCodeAssistantTerminal>;
  publishedPartIds: Set<string>;
  messageRoles: Map<string, string>;
  assistantPartTypes: Map<string, string>;
}

export interface OpenCodeSession {
  status: 'running' | 'completed' | 'aborted';
  // Set while a provider abort is in flight so a named completion cannot claim the turn
  // before the abort is acknowledged; a rejected abort replays the completion.
  aborting?: boolean;
  chatId: string;
  model?: string;
  // The variant the current turn submitted, so steering joins the same effort.
  thinkingVariant?: string;
  permissionMode: PermissionMode;
  directory?: string;
  startedAt: string;
  lastActivityAt: number;
  // Turn-derived uncertainty requires an abort before reuse. Stream loss pins it until process
  // closure; abort start sets it eagerly, while steering release and settlement may recompute it.
  // Pending reverts remain purge-fenced.
  providerWorkRequiresQuiescence: boolean;
  activeSteeringDeliveries: number;
  deferredTerminal: OpenCodeAssistantTerminal | null;
  // A stopped turn leaves accepted follow-up messages in OpenCode's transcript. The next
  // prompt reverts the earliest unconsumed one before OpenCode can include it in model input.
  pendingSteeringRevertMessageId: string | null;
  turn: OpenCodeTurnContext;
}

export function relocateOpenCodeSession(session: OpenCodeSession, directory: string): void {
  session.directory = directory;
  session.lastActivityAt = Date.now();
}

export function activateOpenCodeSessionTurn(
  session: OpenCodeSession,
  input: {
    chatId: string;
    model: string | undefined;
    thinkingVariant?: string;
    permissionMode: PermissionMode;
    directory: string | undefined;
    turn: OpenCodeTurnContext;
  },
): void {
  session.status = 'running';
  session.aborting = false;
  session.providerWorkRequiresQuiescence = false;
  session.activeSteeringDeliveries = 0;
  session.deferredTerminal = null;
  session.chatId = input.chatId;
  session.model = input.model;
  session.thinkingVariant = input.thinkingVariant;
  session.permissionMode = input.permissionMode;
  session.directory = input.directory;
  session.lastActivityAt = Date.now();
  session.turn = input.turn;
}

// OpenCode assigns IDs before durable commits, so concurrent publishers can deliver unseen
// events outside lexical order. The bounded window rejects actual duplicates without making
// ordering an arrival contract; durable sequence metadata can replace it if global replay grows.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/core/src/event.ts#L419-L437
const RECENT_EVENT_ID_LIMIT = 512;

export function createOpenCodeTurnContext(
  operation: AgentRuntimeOperation,
  options: { compaction?: boolean } = {},
): OpenCodeTurnContext {
  return {
    operation,
    compaction: options.compaction === true,
    providerMessageId: null,
    providerPromptPartId: createOpenCodePromptPartId(),
    providerPromptRequestCompleted: false,
    providerSteeringDeliveryUnconfirmed: false,
    lastRetryNoticeKey: null,
    providerContinuationMessageIds: new Set(),
    automaticCompactionMessageIds: new Set(),
    recentEventIds: new Set(),
    providerSteeringPartIds: new Set(),
    pendingSteeringMessageIds: new Set(),
    observedUserMessageIds: new Set(),
    assistantMessageIds: new Set(),
    assistantTerminals: new Map(),
    publishedPartIds: new Set(),
    messageRoles: new Map(),
    assistantPartTypes: new Map(),
  };
}

export function openCodeTurnRequiresProviderQuiescence(turn: OpenCodeTurnContext): boolean {
  return !turn.providerPromptRequestCompleted
    || turn.providerSteeringDeliveryUnconfirmed
    || turn.pendingSteeringMessageIds.size > 0;
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
    && event.type !== 'question.asked'
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
): boolean {
  if (event.type === 'message.updated') {
    const info = event.properties?.info;
    const messageId = typeof info?.id === 'string' ? info.id : '';
    if (info?.role === 'user') {
      if (messageId) turn.observedUserMessageIds.add(messageId);
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
    if (isOpenCodeCompactionAssistant(info)) {
      if (!turn.compaction) {
        if (!turn.automaticCompactionMessageIds.has(info.parentID)) return false;
        // A recorded terminal means this automatic boundary already dispatched;
        // terminal recording follows dispatch in the global event handler.
        if (turn.assistantTerminals.has(messageId)) return false;
        turn.automaticCompactionMessageIds.add(messageId);
      }
      turn.assistantMessageIds.add(messageId);
      return true;
    }
    turn.assistantMessageIds.add(messageId);
    // A batched loop consumes every queued steering message up to its parent;
    // ids sort lexically, so all pending steers at or below the parent were read.
    for (const pending of turn.pendingSteeringMessageIds) {
      if (pending <= info.parentID) turn.pendingSteeringMessageIds.delete(pending);
    }
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
      return false;
    }
    if (messageId && turn.observedUserMessageIds.has(messageId)) {
      return false;
    }
    return Boolean(messageId) && turn.assistantMessageIds.has(messageId);
  }
  if (event.type === 'message.part.delta') {
    const messageId = event.properties?.messageID;
    return typeof messageId === 'string' && turn.assistantMessageIds.has(messageId);
  }
  return true;
}

export function shouldWarnForUnroutedOpenCodeEvent(
  eventType: string,
  managedSession: boolean,
): boolean {
  // Native fork replays are published before OpenCode returns the child session identity.
  // https://github.com/anomalyco/opencode/blob/47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7/packages/opencode/src/session/session.ts#L691-L730
  if (
    !managedSession
    && (eventType === 'message.updated' || eventType === 'message.part.updated')
  ) return false;
  return eventType === 'message.updated'
    || eventType === 'message.part.updated'
    || eventType === 'message.part.delta'
    || eventType === 'permission.asked'
    || eventType === 'question.asked'
    || eventType === 'session.error';
}
