import {
  CommandRequestValidationError,
  requestRecord,
  requiredChatId,
  requiredString,
} from './command-request-validation.js';

export interface ClearChatRequest {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly lastOrdinal: number;
}

export interface ClearChatResponse {
  readonly success: true;
  readonly chatId: string;
  readonly transcriptViewId: string;
}

export function parseClearChatRequest(value: unknown): ClearChatRequest {
  const body = requestRecord(value);
  if (typeof body.lastOrdinal !== 'number' || !Number.isSafeInteger(body.lastOrdinal) || body.lastOrdinal < 0) {
    throw new CommandRequestValidationError('lastOrdinal must be a nonnegative integer');
  }
  return {
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredString(body, 'transcriptViewId'),
    lastOrdinal: body.lastOrdinal,
  };
}

export function parseClearChatResponse(value: unknown): ClearChatResponse {
  const body = requestRecord(value);
  if (body.success !== true) throw new TypeError('Invalid clear chat response');
  return {
    success: true,
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredString(body, 'transcriptViewId'),
  };
}
