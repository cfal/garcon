import {
  parseChatMessage,
  type ChatMessage,
  type ToolUseChatMessage,
  UserMessage,
} from '../../common/chat-types.js';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import { isRecord, stableJsonStringify, type JsonObject } from '../../common/json.js';
import {
  coerceDurableCliBodyDisclosure,
  coerceDurableCliPresentation,
  isCliRowFormat,
} from '../../common/cli-presentation.js';
import { parseNativeSeedReceipt } from '../../common/transcript-seed.js';
import { normalizePendingPreambleBoundary } from '../../common/preambles.js';
import { parsePreamblePrefixReceipt } from '../../common/preamble-prefix.js';
import type {
  AgentEstablishedSession,
  AgentPermissionLifecycle,
  AgentPermissionOption,
  AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import type {
  LedgerAgentSwitchDetail,
  LedgerCliRowNoticeDetail,
  LedgerPermissionRow,
  LedgerRow,
  LedgerRowDraft,
  LedgerUserInputDetail,
  TranscriptViewId,
} from './contracts.js';
import { isLedgerCliRowNoticeDetail } from './contracts.js';

export interface StoredLedgerRow {
  readonly view_id: string;
  readonly ordinal: number;
  readonly kind: LedgerRow['kind'];
  readonly at: string;
  readonly client_message_id: string | null;
  readonly payload_json: string;
}

interface StoredPayload {
  readonly providerMeta: JsonObject | null;
  readonly value: unknown;
}

export function encodeLedgerDraft(draft: LedgerRowDraft): {
  readonly clientMessageId: string | null;
  readonly payloadJson: string;
} {
  const clientMessageId = draft.kind === 'user-input'
    ? draft.detail.clientMessageId
    : draft.kind === 'notice' && isLedgerCliRowNoticeDetail(draft.detail)
      ? draft.detail.clientMessageId
      : null;
  const value = draftValue(draft);
  return {
    clientMessageId,
    payloadJson: stableJsonStringify({
      providerMeta: draft.providerMeta ?? null,
      value,
    }),
  };
}

export function decodeLedgerRow(row: StoredLedgerRow): LedgerRow {
  const payload = parsePayload(row.payload_json);
  const base = {
    viewId: row.view_id as TranscriptViewId,
    ordinal: positiveInteger(row.ordinal, 'ordinal'),
    at: nonEmptyString(row.at, 'row timestamp'),
    providerMeta: payload.providerMeta,
  };

  switch (row.kind) {
    case 'user-input': {
      const detail = parseUserInput(payload.value);
      if (detail.clientMessageId !== row.client_message_id) {
        throw new TypeError('Stored user-input identity does not match its payload');
      }
      return { ...base, kind: 'user-input', detail };
    }
    case 'provider-row':
      return { ...base, kind: 'provider-row', message: parseMessage(payload.value) };
    case 'notice': {
      const value = record(payload.value, 'notice payload');
      const message = nonEmptyString(value.message, 'notice message');
      const detail = jsonObject(value.detail, 'notice detail');
      const cliRowDetail = parseLedgerCliRowNoticeDetail(detail);
      if (cliRowDetail) {
        if (cliRowDetail.clientMessageId !== row.client_message_id) {
          throw new TypeError('Stored chat row identity does not match its payload');
        }
        if (payload.providerMeta !== null) {
          throw new TypeError('Stored chat row provider metadata must be null');
        }
      } else if (row.client_message_id !== null) {
        throw new TypeError('Stored notice has an unexpected client message identity');
      }
      return {
        ...base,
        kind: 'notice',
        message,
        detail: cliRowDetail ?? detail,
      };
    }
    case 'agent-switch':
      return { ...base, kind: 'agent-switch', detail: parseAgentSwitch(payload.value) };
    case 'session':
      return { ...base, kind: 'session', detail: parseSession(payload.value) };
    case 'run-ended': {
      const value = record(payload.value, 'run-ended payload');
      const outcome = value.outcome;
      const origin = value.origin;
      if (outcome !== 'finished' && outcome !== 'failed' && outcome !== 'interrupted') {
        throw new TypeError('Stored run outcome is invalid');
      }
      if (origin !== 'provider' && origin !== 'core') {
        throw new TypeError('Stored run origin is invalid');
      }
      const error = value.error === undefined ? undefined : parseRunFailure(value.error);
      return { ...base, kind: 'run-ended', outcome, origin, ...(error ? { error } : {}) };
    }
    case 'permission-requested':
    case 'permission-resolved':
    case 'permission-cancelled':
    case 'permission-expired': {
      const lifecycle = parsePermissionLifecycle(payload.value);
      const expectedKind = `permission-${lifecycle.kind}`;
      if (row.kind !== expectedKind) {
        throw new TypeError('Stored permission kind does not match its lifecycle payload');
      }
      return { ...base, kind: row.kind, lifecycle } as LedgerPermissionRow;
    }
    default:
      throw new TypeError(`Unknown transcript row kind: ${String(row.kind)}`);
  }
}

export function submissionFingerprint(detail: LedgerUserInputDetail): string {
  return stableJsonStringify({
    content: detail.message.content,
    images: detail.message.images ?? null,
    presentation: detail.message.presentation ?? null,
    attachments: detail.attachments,
    steer: detail.steer,
  });
}

export function cliRowFingerprint(
  message: string,
  detail: LedgerCliRowNoticeDetail,
): string {
  return stableJsonStringify({
    presentation: detail.presentation,
    format: detail.format,
    disclosure: detail.disclosure,
    title: detail.title,
    content: message,
  });
}

function draftValue(draft: LedgerRowDraft): unknown {
  switch (draft.kind) {
    case 'user-input':
      return draft.detail;
    case 'provider-row':
      return draft.message;
    case 'notice':
      return { message: draft.message, detail: draft.detail };
    case 'agent-switch':
    case 'session':
      return draft.detail;
    case 'run-ended':
      return {
        outcome: draft.outcome,
        origin: draft.origin,
        ...(draft.error ? { error: draft.error } : {}),
      };
    case 'permission-requested':
    case 'permission-resolved':
    case 'permission-cancelled':
    case 'permission-expired':
      return encodePermissionLifecycle(draft.lifecycle);
  }
}

export function parseLedgerCliRowNoticeDetail(
  detail: JsonObject,
): LedgerCliRowNoticeDetail | null {
  if (detail.type !== 'cli-row') return null;
  if (
    typeof detail.clientMessageId !== 'string'
    || detail.clientMessageId.length === 0
    || (
      detail.title !== null
      && !(typeof detail.title === 'string' && detail.title.length > 0)
    )
  ) {
    throw new TypeError('Stored chat row detail is invalid');
  }
  return {
    type: 'cli-row',
    clientMessageId: detail.clientMessageId,
    presentation: coerceDurableCliPresentation(detail.presentation),
    format: isCliRowFormat(detail.format) ? detail.format : 'plain',
    disclosure: coerceDurableCliBodyDisclosure(detail.disclosure),
    title: detail.title,
  };
}

function parsePayload(value: string): StoredPayload {
  const parsed: unknown = JSON.parse(value);
  const payload = record(parsed, 'ledger payload');
  return {
    providerMeta: payload.providerMeta === null
      ? null
      : jsonObject(payload.providerMeta, 'provider metadata'),
    value: payload.value,
  };
}

function parseUserInput(value: unknown): LedgerUserInputDetail {
  const detail = record(value, 'user-input payload');
  const message = parseMessage(detail.message);
  if (!(message instanceof UserMessage)) {
    throw new TypeError('Stored user-input message is not a user message');
  }
  const clientMessageId = detail.clientMessageId === null
    ? null
    : nonEmptyString(detail.clientMessageId, 'client message ID');
  if (!Array.isArray(detail.attachments)) {
    throw new TypeError('Stored input attachments are invalid');
  }
  const attachments = detail.attachments.map((attachment) => {
    const item = record(attachment, 'input attachment');
    if (item.kind !== 'image') throw new TypeError('Stored input attachment kind is invalid');
    return {
      kind: 'image' as const,
      data: nonEmptyString(item.data, 'attachment data'),
      name: item.name === null ? null : nonEmptyString(item.name, 'attachment name'),
      mimeType: nonEmptyString(item.mimeType, 'attachment MIME type'),
    };
  });
  if (typeof detail.steer !== 'boolean') throw new TypeError('Stored steer flag is invalid');
  const preambleBoundary = detail.preambleBoundary === undefined || detail.preambleBoundary === null
    ? null
    : normalizePendingPreambleBoundary(detail.preambleBoundary);
  const preamblePrefixReceipt = detail.preamblePrefixReceipt === undefined
    || detail.preamblePrefixReceipt === null
    ? null
    : parsePreamblePrefixReceipt(detail.preamblePrefixReceipt);
  if (detail.preambleBoundary != null && !preambleBoundary) {
    throw new TypeError('Stored preamble boundary proof is invalid');
  }
  if (detail.preamblePrefixReceipt != null && !preamblePrefixReceipt) {
    throw new TypeError('Stored preamble prefix receipt is invalid');
  }
  if (preamblePrefixReceipt && !preambleBoundary) {
    throw new TypeError('Stored preamble receipt has no boundary proof');
  }
  return {
    clientMessageId,
    message,
    attachments,
    steer: detail.steer,
    preambleBoundary,
    preamblePrefixReceipt,
  };
}

function parseAgentSwitch(value: unknown): LedgerAgentSwitchDetail {
  const detail = record(value, 'agent switch payload');
  return {
    fromAgentId: nonEmptyString(detail.fromAgentId, 'agent switch source'),
    toAgentId: nonEmptyString(detail.toAgentId, 'agent switch target'),
    fromModel: detail.fromModel === null ? null : nonEmptyString(detail.fromModel, 'source model'),
    toModel: detail.toModel === null ? null : nonEmptyString(detail.toModel, 'target model'),
  };
}

function parseSession(value: unknown): AgentEstablishedSession {
  const session = record(value, 'session payload');
  const agentSessionId = nonEmptyString(session.agentSessionId, 'agent session ID');
  const nativeSession = session.nativeSession === null
    ? null
    : parseNativeSession(session.nativeSession);
  const nativeSeedReceipt = session.nativeSeedReceipt === null
    ? null
    : parseNativeSeedReceipt(session.nativeSeedReceipt);
  if (session.nativeSeedReceipt !== null && !nativeSeedReceipt) {
    throw new TypeError('Stored native seed receipt is invalid');
  }
  if (nativeSeedReceipt && nativeSeedReceipt.agentSessionId !== agentSessionId) {
    throw new TypeError('Stored native seed receipt session mismatch');
  }
  return { agentSessionId, nativeSession, nativeSeedReceipt };
}

function parseNativeSession(value: unknown): AgentEstablishedSession['nativeSession'] {
  const session = record(value, 'native session');
  return {
    ownerId: nonEmptyString(session.ownerId, 'native session owner'),
    schemaVersion: positiveInteger(session.schemaVersion, 'native session schema version'),
    value: jsonObject(session.value, 'native session value'),
  };
}

function parsePermissionLifecycle(value: unknown): AgentPermissionLifecycle {
  const lifecycle = record(value, 'permission lifecycle');
  const permissionOccurrenceId = nonEmptyString(
    lifecycle.incarnation,
    'permission occurrence ID',
  );
  switch (lifecycle.kind) {
    case 'requested': {
      const requestedTool = parseMessage(lifecycle.requestedTool) as ToolUseChatMessage;
      if (!('toolId' in requestedTool)) throw new TypeError('Permission request tool is invalid');
      if (!Array.isArray(lifecycle.options)) throw new TypeError('Permission options are invalid');
      const options = lifecycle.options.map((option) => {
        const parsed = jsonObject(option, 'permission option') as AgentPermissionOption;
        nonEmptyString(parsed.id, 'permission option ID');
        nonEmptyString(parsed.label, 'permission option label');
        return parsed;
      });
      return { kind: 'requested', permissionOccurrenceId, requestedTool, options };
    }
    case 'resolved': {
      const decision = record(lifecycle.decision, 'permission decision');
      if (typeof decision.allow !== 'boolean') throw new TypeError('Permission decision is invalid');
      const parsedDecision: PermissionDecisionPayload = {
        allow: decision.allow,
        ...(typeof decision.alwaysAllow === 'boolean'
          ? { alwaysAllow: decision.alwaysAllow }
          : {}),
        ...(isRecord(decision.response)
          ? { response: decision.response }
          : {}),
      };
      return {
        kind: 'resolved',
        permissionOccurrenceId,
        decision: parsedDecision,
      };
    }
    case 'cancelled':
      return {
        kind: 'cancelled',
        permissionOccurrenceId,
        reason: lifecycle.reason === null
          ? null
          : nonEmptyString(lifecycle.reason, 'permission cancellation reason'),
      };
    case 'expired':
      return { kind: 'expired', permissionOccurrenceId };
    default:
      throw new TypeError('Stored permission lifecycle kind is invalid');
  }
}

function encodePermissionLifecycle(value: AgentPermissionLifecycle): Record<string, unknown> {
  const { permissionOccurrenceId, ...detail } = value;
  return { ...detail, incarnation: permissionOccurrenceId };
}

function parseRunFailure(value: unknown): AgentRunFailureDetail {
  const error = record(value, 'run failure');
  const message = error.message === undefined
    ? undefined
    : nonEmptyString(error.message, 'run failure message');
  return {
    code: nonEmptyString(error.code, 'run failure code'),
    ...(message ? { message } : {}),
  };
}

function parseMessage(value: unknown): ChatMessage {
  const message = parseChatMessage(record(value, 'chat message'));
  if (!message) throw new TypeError('Stored chat message is invalid');
  return message;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function jsonObject(value: unknown, label: string): JsonObject {
  const parsed = record(value, label);
  stableJsonStringify(parsed);
  return parsed as JsonObject;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return Number(value);
}
