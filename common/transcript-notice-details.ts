export interface CarryoverMigrationQuarantineNoticeDetail {
  readonly type: 'carryover-migration-quarantine';
  readonly artifactId: string;
  readonly errorCode: string;
}

export interface HandoffSummaryNoticeDetail {
  readonly type: 'handoff-summary';
}

export interface ChatIdRequestNoticeDetail {
  readonly type: 'chat-id-request';
}

export interface ChatIdDisclosureNoticeDetail {
  readonly type: 'chat-id-disclosure';
}

export type ChatIdDiscoveryFailureReason =
  | 'disabled'
  | 'unsupported'
  | 'turn-unavailable'
  | 'delivery-failed';

export interface ChatIdDiscoveryFailureNoticeDetail {
  readonly type: 'chat-id-discovery-failure';
  readonly reason: ChatIdDiscoveryFailureReason;
}

export type TranscriptNoticeDetail =
  | CarryoverMigrationQuarantineNoticeDetail
  | HandoffSummaryNoticeDetail
  | ChatIdRequestNoticeDetail
  | ChatIdDisclosureNoticeDetail
  | ChatIdDiscoveryFailureNoticeDetail;

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

export function isHandoffSummaryNoticeDetail(
  value: unknown,
): value is HandoffSummaryNoticeDetail {
  return hasType(value, 'handoff-summary');
}

export function isChatIdRequestNoticeDetail(
  value: unknown,
): value is ChatIdRequestNoticeDetail {
  return hasType(value, 'chat-id-request');
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
    || reason === 'unsupported'
    || reason === 'turn-unavailable'
    || reason === 'delivery-failed';
}

function hasType(value: unknown, type: string): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).type === type;
}
