import {
  CommandRequestValidationError,
  isCommandCorrelationIdWithinLimit,
  requestRecord,
  requiredChatId,
  requiredCommandCorrelationId,
} from './command-request-validation.js';
import { InvalidChatIdError, parseChatId } from './chat-id.js';
import {
  isPreambleId,
  normalizeChatPreambleSelection,
  normalizePreambleSelectionProjection,
  PREAMBLE_MAX_COUNT,
  type ChatPreambleSelection,
  type PreambleId,
  type PreambleSelectionProjection,
} from './preambles.js';
import { isRecord } from './json.js';

export const CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES = 32 * 1024;

export interface ChatPreambleSelectionTargetResponse {
  readonly success: true;
  readonly chatId: string;
  readonly transcriptViewId: string;
  // The chat's own canonical project path, needed to project an unsaved draft
  // client-side; it is not preamble scope or path data.
  readonly canonicalProjectPath: string;
  readonly selection: ChatPreambleSelection;
  readonly projection: PreambleSelectionProjection;
}

export interface UpdateChatPreambleSelectionRequest {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly clientRequestId: string;
  readonly clientMessageId: string;
  readonly expectedRevision: number;
  readonly orderedPreambleIds: readonly PreambleId[];
}

export interface UpdateChatPreambleSelectionResponse {
  readonly success: true;
  readonly commandType: 'chat-preambles-update';
  readonly clientRequestId: string;
  readonly clientMessageId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly status: 'updated' | 'unchanged' | 'duplicate';
  readonly mutationRevision: number;
  readonly noticeOrdinal: number | null;
  readonly selection: ChatPreambleSelection;
  readonly projection: PreambleSelectionProjection;
}

export interface PreambleSelectionPreviewRequest {
  readonly projectPath: string;
  readonly orderedPreambleIds?: readonly PreambleId[];
}

export interface PreambleSelectionPreviewResponse {
  readonly success: true;
  readonly canonicalProjectPath: string;
  readonly orderedPreambleIds: readonly PreambleId[];
  readonly projection: PreambleSelectionProjection;
}

export type PreambleSelectionCommittedState = true | 'unknown';

export interface PreambleSelectionPartialErrorBody {
  readonly success: false;
  readonly errorCode:
    | 'PREAMBLE_SELECTION_NOTICE_FAILED'
    | 'PREAMBLE_SELECTION_SAVE_UNKNOWN';
  readonly message: string;
  readonly retryable: boolean;
  readonly selectionCommitted: PreambleSelectionCommittedState;
  readonly selection?: ChatPreambleSelection;
}

function requiredOrderedPreambleIds(value: readonly unknown[]): readonly PreambleId[] {
  if (value.length > PREAMBLE_MAX_COUNT) {
    throw new CommandRequestValidationError('orderedPreambleIds is too long');
  }
  const ids: PreambleId[] = [];
  for (const item of value) {
    if (!isPreambleId(item)) {
      throw new CommandRequestValidationError('orderedPreambleIds contains an invalid preamble ID');
    }
    if (ids.includes(item)) {
      throw new CommandRequestValidationError('orderedPreambleIds contains a duplicate ID');
    }
    ids.push(item);
  }
  return ids;
}

export function parseUpdateChatPreambleSelectionRequest(
  value: unknown,
): UpdateChatPreambleSelectionRequest {
  const body = strictRecord(value, [
    'chatId',
    'transcriptViewId',
    'clientRequestId',
    'clientMessageId',
    'expectedRevision',
    'orderedPreambleIds',
  ]);
  const orderedPreambleIds = body.orderedPreambleIds;
  if (!Array.isArray(orderedPreambleIds)) {
    throw new CommandRequestValidationError('orderedPreambleIds is required');
  }
  const expectedRevision = body.expectedRevision;
  if (
    typeof expectedRevision !== 'number'
    || !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 0
  ) {
    throw new CommandRequestValidationError('expectedRevision must be a nonnegative integer');
  }
  return {
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredTranscriptViewId(body, 'transcriptViewId'),
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    clientMessageId: requiredCommandCorrelationId(body, 'clientMessageId'),
    expectedRevision,
    orderedPreambleIds: requiredOrderedPreambleIds(orderedPreambleIds),
  };
}

export function parsePreambleSelectionPreviewRequest(
  value: unknown,
): PreambleSelectionPreviewRequest {
  const body = strictRecord(value, ['projectPath', 'orderedPreambleIds']);
  const projectPath = body.projectPath;
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    throw new CommandRequestValidationError('projectPath is required');
  }
  if (body.orderedPreambleIds === undefined) {
    return { projectPath };
  }
  if (!Array.isArray(body.orderedPreambleIds)) {
    throw new CommandRequestValidationError('orderedPreambleIds must be an array');
  }
  return { projectPath, orderedPreambleIds: requiredOrderedPreambleIds(body.orderedPreambleIds) };
}

function projectionPartitionsSelection(
  projection: PreambleSelectionProjection,
  selection: ChatPreambleSelection,
): boolean {
  const eligibleIds = new Set(projection.eligiblePreambles.map((entry) => entry.id));
  const unavailableIds = new Set(projection.unavailable.map((entry) => entry.id));
  if (eligibleIds.size + unavailableIds.size !== selection.orderedPreambleIds.length) {
    return false;
  }
  const expectedEligible: PreambleId[] = [];
  const expectedUnavailable: PreambleId[] = [];
  for (const id of selection.orderedPreambleIds) {
    if (eligibleIds.has(id)) expectedEligible.push(id);
    else if (unavailableIds.has(id)) expectedUnavailable.push(id);
    else return false;
  }
  return expectedEligible.every(
    (id, index) => id === projection.eligiblePreambles[index]?.id,
  ) && expectedUnavailable.every(
    (id, index) => id === projection.unavailable[index]?.id,
  );
}

// Status and notice ordinal must agree: `updated` always records its notice
// row; `unchanged` never does; `duplicate` reports the original row.
function updateStatusConsistent(
  status: unknown,
  noticeOrdinal: unknown,
): boolean {
  if (status === 'updated') return noticeOrdinal !== null;
  if (status === 'unchanged') return noticeOrdinal === null;
  return status === 'duplicate' && noticeOrdinal !== null;
}

export function parseChatPreambleSelectionTargetResponse(
  value: unknown,
): ChatPreambleSelectionTargetResponse | null {
  const response = responseRecord(value, [
    'success',
    'chatId',
    'transcriptViewId',
    'canonicalProjectPath',
    'selection',
    'projection',
  ]);
  if (!response || response.success !== true) return null;
  const selection = normalizeChatPreambleSelection(response.selection);
  const projection = normalizePreambleSelectionProjection(response.projection);
  if (!isResponseChatId(response.chatId)
    || !isTranscriptViewId(response.transcriptViewId)
    || !isNonEmptyString(response.canonicalProjectPath)
    || !selection
    || !projection
    || !projectionPartitionsSelection(projection, selection)) return null;
  return {
    success: true,
    chatId: response.chatId,
    transcriptViewId: response.transcriptViewId,
    canonicalProjectPath: response.canonicalProjectPath,
    selection,
    projection,
  };
}

export function parseUpdateChatPreambleSelectionResponse(
  value: unknown,
): UpdateChatPreambleSelectionResponse | null {
  const response = responseRecord(value, [
    'success',
    'commandType',
    'clientRequestId',
    'clientMessageId',
    'chatId',
    'transcriptViewId',
    'status',
    'mutationRevision',
    'noticeOrdinal',
    'selection',
    'projection',
  ]);
  if (
    !response
    || response.success !== true
    || response.commandType !== 'chat-preambles-update'
    || !isResponseCorrelationId(response.clientRequestId)
    || !isResponseCorrelationId(response.clientMessageId)
    || !isResponseChatId(response.chatId)
    || !isTranscriptViewId(response.transcriptViewId)
    || !updateStatusConsistent(response.status, response.noticeOrdinal)
    || !Number.isSafeInteger(response.mutationRevision)
    || Number(response.mutationRevision) < 0
    || !(
      response.noticeOrdinal === null
      || (Number.isSafeInteger(response.noticeOrdinal) && Number(response.noticeOrdinal) >= 1)
    )
  ) return null;
  const selection = normalizeChatPreambleSelection(response.selection);
  const projection = normalizePreambleSelectionProjection(response.projection);
  if (
    !selection
    || !projection
    || !projectionPartitionsSelection(projection, selection)
  ) return null;
  if (response.status !== 'updated'
    && response.status !== 'unchanged'
    && response.status !== 'duplicate') {
    return null;
  }
  const mutationRevision = Number(response.mutationRevision);
  if (response.status === 'duplicate'
    ? selection.revision < mutationRevision
    : selection.revision !== mutationRevision) return null;
  return {
    success: true,
    commandType: 'chat-preambles-update',
    clientRequestId: response.clientRequestId,
    clientMessageId: response.clientMessageId,
    chatId: response.chatId,
    transcriptViewId: response.transcriptViewId,
    status: response.status,
    mutationRevision,
    noticeOrdinal: response.noticeOrdinal as number | null,
    selection,
    projection,
  };
}

export function parsePreambleSelectionPreviewResponse(
  value: unknown,
): PreambleSelectionPreviewResponse | null {
  const response = responseRecord(value, [
    'success',
    'canonicalProjectPath',
    'orderedPreambleIds',
    'projection',
  ]);
  if (!response || response.success !== true) return null;
  const projection = normalizePreambleSelectionProjection(response.projection);
  if (
    !isNonEmptyString(response.canonicalProjectPath)
    || !Array.isArray(response.orderedPreambleIds)
    || response.orderedPreambleIds.length > PREAMBLE_MAX_COUNT
    || new Set(response.orderedPreambleIds).size !== response.orderedPreambleIds.length
    || !response.orderedPreambleIds.every((id): id is PreambleId => isPreambleId(id))
    || !projection
    || !projectionPartitionsSelection(
      projection,
      { revision: 0, orderedPreambleIds: response.orderedPreambleIds as PreambleId[] },
    )
  ) return null;
  return {
    success: true,
    canonicalProjectPath: response.canonicalProjectPath,
    orderedPreambleIds: [...response.orderedPreambleIds],
    projection,
  };
}

export function parsePreambleSelectionPartialError(
  value: unknown,
): PreambleSelectionPartialErrorBody | null {
  const response = responseRecord(value, [
    'success',
    'errorCode',
    'message',
    'retryable',
    'selectionCommitted',
    'selection',
  ]);
  if (
    !response
    || response.success !== false
    || (response.errorCode !== 'PREAMBLE_SELECTION_NOTICE_FAILED'
      && response.errorCode !== 'PREAMBLE_SELECTION_SAVE_UNKNOWN')
    || !isNonEmptyString(response.message)
    || response.retryable !== false
    || (response.selectionCommitted !== true && response.selectionCommitted !== 'unknown')
  ) return null;
  // The commit state and error code must agree, and a supplied selection must
  // be well formed; malformed payloads reject instead of dropping fields.
  const codeMatchesCommit = response.errorCode === 'PREAMBLE_SELECTION_NOTICE_FAILED'
    ? response.selectionCommitted === true
    : response.selectionCommitted === 'unknown';
  if (!codeMatchesCommit) return null;
  let selection: ChatPreambleSelection | undefined;
  if (response.selection !== undefined) {
    const parsed = normalizeChatPreambleSelection(response.selection);
    if (!parsed) return null;
    selection = parsed;
  }
  if (response.errorCode === 'PREAMBLE_SELECTION_NOTICE_FAILED' && !selection) return null;
  return {
    success: false,
    errorCode: response.errorCode,
    message: response.message,
    retryable: response.retryable,
    selectionCommitted: response.selectionCommitted,
    ...(selection === undefined ? {} : { selection }),
  };
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const body = requestRecord(value);
  const allowed = new Set(keys);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new CommandRequestValidationError(`${key} is not supported`);
    }
  }
  return body;
}

function requiredTranscriptViewId(body: Record<string, unknown>, field: string): string {
  const value = requiredCommandCorrelationId(body, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new CommandRequestValidationError(`${field} must be a transcript view UUID`);
  }
  return value;
}

function responseRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) ? value : null;
}

function isResponseChatId(value: unknown): value is string {
  try {
    parseChatId(value);
    return true;
  } catch (error) {
    if (error instanceof InvalidChatIdError) return false;
    throw error;
  }
}

function isTranscriptViewId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function isResponseCorrelationId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && isCommandCorrelationIdWithinLimit(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
