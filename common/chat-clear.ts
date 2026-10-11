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
  readonly target: ClearChatTarget;
}

export type ClearChatTarget =
  | { readonly kind: 'all' }
  | { readonly kind: 'before-message'; readonly ordinal: number };

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
  const target = requestRecord(body.target);
  let parsedTarget: ClearChatTarget;
  if (target.kind === 'all' && Object.keys(target).length === 1) {
    parsedTarget = { kind: 'all' };
  } else if (target.kind === 'before-message' && Object.keys(target).every(key => key === 'kind' || key === 'ordinal')
    && typeof target.ordinal === 'number' && Number.isSafeInteger(target.ordinal)
    && target.ordinal >= 1 && target.ordinal <= body.lastOrdinal) {
    parsedTarget = { kind: 'before-message', ordinal: target.ordinal };
  } else {
    throw new CommandRequestValidationError('A valid clear target is required');
  }
  return {
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredString(body, 'transcriptViewId'),
    lastOrdinal: body.lastOrdinal,
    target: parsedTarget,
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
