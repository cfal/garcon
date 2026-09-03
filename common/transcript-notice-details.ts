import { parseChatId } from './chat-id.js';
import {
  PREAMBLE_MAX_COUNT,
  normalizePreambleTitle,
} from './preambles.js';

export type AppliedPreambleReference = {
  readonly id: string;
  readonly title: string;
};

export interface PreambleApplicationNoticeDetail {
  readonly type: 'preamble-application';
  readonly preambles: readonly AppliedPreambleReference[];
}

export interface CarryoverMigrationQuarantineNoticeDetail {
  readonly type: 'carryover-migration-quarantine';
  readonly artifactId: string;
  readonly errorCode: string;
}

export interface HandoffSummaryNoticeDetail {
  readonly type: 'handoff-summary';
}

export interface ChatIdDisclosureNoticeDetail {
  readonly type: 'chat-id-disclosure';
}

export type ChatIdDiscoveryFailureReason =
  | 'disabled'
  | 'delivery-failed';

export interface ChatIdDiscoveryFailureNoticeDetail {
  readonly type: 'chat-id-discovery-failure';
  readonly reason: ChatIdDiscoveryFailureReason;
}

export type InterAgentMessageDeliveryStatus = 'delivered' | 'queued' | 'failed';

export type InterAgentMessageFailureReason =
  | 'disabled'
  | 'self-send'
  | 'target-not-found'
  | 'target-unavailable'
  | 'queue-full'
  | 'provider-rejected'
  | 'delivery-unknown'
  | 'server-shutting-down'
  | 'delivery-failed';

export type InterAgentMessageResult =
  | {
      readonly chatId: string;
      readonly status: 'delivered' | 'queued';
    }
  | {
      readonly chatId: string;
      readonly status: 'failed';
      readonly reason: InterAgentMessageFailureReason;
    };

export interface InterAgentMessageOutcomeNoticeDetail {
  readonly type: 'inter-agent-message-outcome';
  readonly results: readonly InterAgentMessageResult[];
}

export interface InterAgentMessageReceivedNoticeDetail {
  readonly type: 'inter-agent-message-received';
  readonly fromChatId: string | null;
}

export type ServerControlReceiptDetail = InterAgentMessageReceivedNoticeDetail;

export type TranscriptNoticeDetail =
  | PreambleApplicationNoticeDetail
  | CarryoverMigrationQuarantineNoticeDetail
  | HandoffSummaryNoticeDetail
  | ChatIdDisclosureNoticeDetail
  | ChatIdDiscoveryFailureNoticeDetail
  | InterAgentMessageOutcomeNoticeDetail
  | InterAgentMessageReceivedNoticeDetail;

export function isCarryoverMigrationQuarantineNoticeDetail(
  value: unknown,
): value is CarryoverMigrationQuarantineNoticeDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  return detail.type === 'carryover-migration-quarantine'
    && typeof detail.artifactId === 'string'
    && detail.artifactId.length > 0
    && typeof detail.errorCode === 'string'
    && detail.errorCode.length > 0;
}

export function isPreambleApplicationNoticeDetail(
  value: unknown,
): value is PreambleApplicationNoticeDetail {
  if (!hasType(value, 'preamble-application')) return false;
  const preambles = (value as Record<string, unknown>).preambles;
  if (!Array.isArray(preambles) || preambles.length < 1 || preambles.length > PREAMBLE_MAX_COUNT) {
    return false;
  }
  const ids = new Set<string>();
  return preambles.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || ids.has(id) || normalizePreambleTitle(raw.title) === null) return false;
    ids.add(id);
    return Object.keys(raw).every((key) => key === 'id' || key === 'title');
  });
}

export function isHandoffSummaryNoticeDetail(
  value: unknown,
): value is HandoffSummaryNoticeDetail {
  return hasType(value, 'handoff-summary');
}

export function isChatIdDisclosureNoticeDetail(
  value: unknown,
): value is ChatIdDisclosureNoticeDetail {
  return hasType(value, 'chat-id-disclosure');
}

export function isChatIdDiscoveryFailureNoticeDetail(
  value: unknown,
): value is ChatIdDiscoveryFailureNoticeDetail {
  if (!hasType(value, 'chat-id-discovery-failure')) return false;
  const reason = (value as Record<string, unknown>).reason;
  return reason === 'disabled'
    || reason === 'delivery-failed';
}

export function isInterAgentMessageOutcomeNoticeDetail(
  value: unknown,
): value is InterAgentMessageOutcomeNoticeDetail {
  if (!hasType(value, 'inter-agent-message-outcome')) return false;
  const results = (value as Record<string, unknown>).results;
  if (!Array.isArray(results) || results.length === 0 || results.length > 16) return false;
  const seen = new Set<string>();
  for (const result of results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const candidate = result as Record<string, unknown>;
    if (typeof candidate.chatId !== 'string' || seen.has(candidate.chatId)) return false;
    try {
      parseChatId(candidate.chatId);
    } catch {
      return false;
    }
    seen.add(candidate.chatId);
    if (candidate.status === 'delivered' || candidate.status === 'queued') continue;
    if (candidate.status !== 'failed' || !isInterAgentMessageFailureReason(candidate.reason)) {
      return false;
    }
  }
  return true;
}

export function isInterAgentMessageReceivedNoticeDetail(
  value: unknown,
): value is InterAgentMessageReceivedNoticeDetail {
  if (!hasType(value, 'inter-agent-message-received')) return false;
  const fromChatId = (value as Record<string, unknown>).fromChatId;
  if (fromChatId === null) return true;
  try {
    parseChatId(fromChatId);
    return true;
  } catch {
    return false;
  }
}

function hasType(value: unknown, type: string): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).type === type;
}

export function parseTranscriptNoticeDetail(value: unknown): TranscriptNoticeDetail | null {
  if (isPreambleApplicationNoticeDetail(value)) {
    return {
      type: value.type,
      preambles: value.preambles.map((preamble) => ({
        id: preamble.id.trim(),
        title: normalizePreambleTitle(preamble.title)!,
      })),
    };
  }
  if (isCarryoverMigrationQuarantineNoticeDetail(value)) {
    return {
      type: value.type,
      artifactId: value.artifactId,
      errorCode: value.errorCode,
    };
  }
  if (isHandoffSummaryNoticeDetail(value)) return { type: value.type };
  if (isChatIdDisclosureNoticeDetail(value)) return { type: value.type };
  if (isChatIdDiscoveryFailureNoticeDetail(value)) {
    return { type: value.type, reason: value.reason };
  }
  if (isInterAgentMessageOutcomeNoticeDetail(value)) {
    return {
      type: value.type,
      results: value.results.map((result) => result.status === 'failed'
        ? {
            chatId: result.chatId,
            status: result.status,
            reason: result.reason,
          }
        : { chatId: result.chatId, status: result.status }),
    };
  }
  if (isInterAgentMessageReceivedNoticeDetail(value)) {
    return { type: value.type, fromChatId: value.fromChatId };
  }
  return null;
}

function isInterAgentMessageFailureReason(value: unknown): value is InterAgentMessageFailureReason {
  return value === 'disabled'
    || value === 'self-send'
    || value === 'target-not-found'
    || value === 'target-unavailable'
    || value === 'queue-full'
    || value === 'provider-rejected'
    || value === 'delivery-unknown'
    || value === 'server-shutting-down'
    || value === 'delivery-failed';
}
