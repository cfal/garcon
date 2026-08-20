import {
  CommandRequestValidationError,
  requestRecord,
  requiredChatId,
  requiredCommandCorrelationId,
  requiredString,
} from './command-request-validation.js';
import { isRecord } from './json.js';

export const CHAT_ROW_TYPES = ['notice', 'error'] as const;
export type ChatRowType = (typeof CHAT_ROW_TYPES)[number];

export const CHAT_ROW_CONTENT_MAX_BYTES = 64 * 1024;
export const CHAT_ROW_TITLE_MAX_CODE_POINTS = 120;

const utf8Encoder = new TextEncoder();
const chatRowTitleControl = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export interface ChatRowTargetResponse {
  readonly success: true;
  readonly chatId: string;
  readonly transcriptViewId: string;
}

export interface AddChatRowRequest {
  readonly clientRequestId: string;
  readonly clientMessageId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly type: ChatRowType;
  readonly title?: string;
  readonly content: string;
}

export interface AddChatRowResponse {
  readonly success: true;
  readonly commandType: 'chat-row-add';
  readonly clientRequestId: string;
  readonly clientMessageId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly ordinal: number;
  readonly type: ChatRowType;
  readonly status: 'appended' | 'duplicate';
  readonly timestamp: string;
}

export function parseChatRowContent(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CommandRequestValidationError('content is required');
  }
  if (!value.isWellFormed()) {
    throw new CommandRequestValidationError('content must contain well-formed Unicode');
  }
  if (utf8Encoder.encode(value).byteLength > CHAT_ROW_CONTENT_MAX_BYTES) {
    throw new CommandRequestValidationError(
      `content must be at most ${CHAT_ROW_CONTENT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

export function parseChatRowTitle(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new CommandRequestValidationError('title must be a string');
  }
  const title = value.trim();
  if (title.length === 0) {
    throw new CommandRequestValidationError('title must not be empty');
  }
  if (!title.isWellFormed()) {
    throw new CommandRequestValidationError('title must contain well-formed Unicode');
  }
  if (chatRowTitleControl.test(title)) {
    throw new CommandRequestValidationError('title must be a single line');
  }
  if ([...title].length > CHAT_ROW_TITLE_MAX_CODE_POINTS) {
    throw new CommandRequestValidationError(
      `title must be at most ${CHAT_ROW_TITLE_MAX_CODE_POINTS} characters`,
    );
  }
  return title;
}

export function parseAddChatRowRequest(value: unknown): AddChatRowRequest {
  const body = requestRecord(value);
  if (body.type !== 'notice' && body.type !== 'error') {
    throw new CommandRequestValidationError('type must be notice or error');
  }
  const title = parseChatRowTitle(body.title);
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    clientMessageId: requiredCommandCorrelationId(body, 'clientMessageId'),
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredString(body, 'transcriptViewId'),
    type: body.type,
    ...(title === undefined ? {} : { title }),
    content: parseChatRowContent(body.content),
  };
}

export function parseChatRowTargetResponse(value: unknown): ChatRowTargetResponse | null {
  if (
    !isRecord(value)
    || value.success !== true
    || !isNonEmptyString(value.chatId)
    || !isNonEmptyString(value.transcriptViewId)
  ) {
    return null;
  }
  return {
    success: true,
    chatId: value.chatId,
    transcriptViewId: value.transcriptViewId,
  };
}

export function parseAddChatRowResponse(value: unknown): AddChatRowResponse | null {
  if (
    !isRecord(value)
    || value.success !== true
    || value.commandType !== 'chat-row-add'
    || !isNonEmptyString(value.clientRequestId)
    || !isNonEmptyString(value.clientMessageId)
    || !isNonEmptyString(value.chatId)
    || !isNonEmptyString(value.transcriptViewId)
    || !Number.isSafeInteger(value.ordinal)
    || Number(value.ordinal) < 1
    || (value.type !== 'notice' && value.type !== 'error')
    || (value.status !== 'appended' && value.status !== 'duplicate')
    || !isNonEmptyString(value.timestamp)
  ) {
    return null;
  }
  return {
    success: true,
    commandType: 'chat-row-add',
    clientRequestId: value.clientRequestId,
    clientMessageId: value.clientMessageId,
    chatId: value.chatId,
    transcriptViewId: value.transcriptViewId,
    ordinal: Number(value.ordinal),
    type: value.type,
    status: value.status,
    timestamp: value.timestamp,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
