import type { ChatMessage } from './chat-types.js';
import {
  parseChatHistoryResponse,
  isUnavailableChatHistoryResponse,
  parseChatHistoryState,
  parseResendCandidates,
  parseTranscriptMessages,
  type ResendCandidate,
  type TranscriptMessage,
  type TranscriptPage,
  type UnavailableChatHistoryResponse,
} from './chat-view.js';
import { isRecord } from './json.js';

export const TRANSCRIPT_ANCHOR_TARGET = 100;
export const TRANSCRIPT_ANCHOR_MAX_BUDGET = 200;

export type TranscriptAnchorDirection = 'backward' | 'forward';
export type TranscriptAnchorPageStatus = 'partial' | 'complete' | 'exhausted';

export interface TranscriptAnchorRequest {
  readonly chatId: string;
  readonly direction: TranscriptAnchorDirection;
  readonly anchorsRemaining: number;
  readonly transcriptViewId?: string;
  readonly cursorOrdinal?: number;
  readonly watermarkOrdinal?: number;
  readonly purpose?: 'activation';
}

export interface TranscriptAnchorPage {
  readonly historyState: { readonly kind: 'complete' };
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly direction: TranscriptAnchorDirection;
  readonly watermarkOrdinal: number;
  readonly lastOrdinal: number;
  readonly startOrdinal: number;
  readonly endOrdinal: number;
  readonly anchorsRemaining: number;
  readonly pageStatus: TranscriptAnchorPageStatus;
  readonly messages: TranscriptMessage[];
  readonly resendCandidates: ResendCandidate[];
}

export type TranscriptAnchorResponse = TranscriptAnchorPage | UnavailableChatHistoryResponse;

export class TranscriptAnchorRequestError extends Error {}

export function isTranscriptAnchor(message: Pick<ChatMessage, 'type'>): boolean {
  return message.type === 'user-message' || message.type === 'assistant-message';
}

export function parseTranscriptAnchorRequest(value: unknown): TranscriptAnchorRequest {
  function invalid(reason: string): never {
    throw new TranscriptAnchorRequestError(`Invalid combined history request: ${reason}`);
  }
  if (!isRecord(value)) invalid('expected an object');
  const chatId = stringField(value.chatId, 'chatId', invalid);
  const direction = value.direction;
  if (direction !== 'backward' && direction !== 'forward') invalid('direction');
  const anchorsRemaining = integerField(value.anchorsRemaining, 'anchorsRemaining', invalid);
  if (anchorsRemaining > TRANSCRIPT_ANCHOR_MAX_BUDGET) invalid('anchor budget exceeds maximum');
  const transcriptViewId = value.transcriptViewId === undefined
    ? undefined : stringField(value.transcriptViewId, 'transcriptViewId', invalid);
  const cursorOrdinal = value.cursorOrdinal === undefined
    ? undefined : integerField(value.cursorOrdinal, 'cursorOrdinal', invalid);
  const watermarkOrdinal = value.watermarkOrdinal === undefined
    ? undefined : integerField(value.watermarkOrdinal, 'watermarkOrdinal', invalid);
  if (cursorOrdinal !== undefined && !transcriptViewId) invalid('cursor requires a view');
  if (direction === 'backward' && cursorOrdinal === 0) invalid('backward cursor must be positive');
  if (watermarkOrdinal !== undefined) {
    if (cursorOrdinal === undefined || !transcriptViewId) invalid('watermark requires a view and cursor');
    if (watermarkOrdinal === Number.MAX_SAFE_INTEGER) invalid('watermark exceeds maximum');
    if (cursorOrdinal > watermarkOrdinal + (direction === 'backward' ? 1 : 0)) {
      invalid('cursor exceeds watermark');
    }
  } else if (anchorsRemaining === 0) invalid('zero budget requires a continuation');
  const purpose = value.purpose;
  if (purpose !== undefined && (
    purpose !== 'activation' || direction !== 'backward'
    || cursorOrdinal !== undefined || watermarkOrdinal !== undefined
  )) invalid('activation requires initial backward history');
  return {
    chatId, direction, anchorsRemaining,
    ...(transcriptViewId === undefined ? {} : { transcriptViewId }),
    ...(cursorOrdinal === undefined ? {} : { cursorOrdinal }),
    ...(watermarkOrdinal === undefined ? {} : { watermarkOrdinal }),
    ...(purpose === undefined ? {} : { purpose }),
  };
}

export function isCompleteTranscriptAnchorResponse(
  response: TranscriptAnchorResponse,
): response is TranscriptAnchorPage {
  return response.historyState.kind === 'complete';
}

export function parseTranscriptAnchorResponse(
  request: TranscriptAnchorRequest,
  value: unknown,
): TranscriptAnchorResponse {
  function invalid(reason: string): never {
    throw new Error(`Invalid combined history page: ${reason}`);
  }
  if (!isRecord(value)) invalid('expected an object');
  const historyState = parseChatHistoryState(value.historyState);
  if (!historyState) invalid('historyState');
  if (historyState.kind !== 'complete') {
    for (const field of ['direction', 'watermarkOrdinal', 'startOrdinal', 'endOrdinal', 'anchorsRemaining', 'pageStatus', 'resendCandidates']) {
      if (value[field] !== undefined) invalid(`unavailable ${field}`);
    }
    const unavailable = parseChatHistoryResponse({ chatId: request.chatId }, value);
    if (!isUnavailableChatHistoryResponse(unavailable)) invalid('unavailable history');
    return unavailable;
  }
  const messages = parseTranscriptMessages(value.messages);
  const resendCandidates = parseResendCandidates(value.resendCandidates);
  if (!messages || !resendCandidates) invalid('messages or resendCandidates');
  const direction = request.direction;
  if (value.direction !== direction) invalid('direction does not match request');
  const pageStatus = value.pageStatus;
  if (pageStatus !== 'partial' && pageStatus !== 'complete' && pageStatus !== 'exhausted') invalid('pageStatus');
  const page: TranscriptAnchorPage = {
    historyState,
    chatId: stringField(value.chatId, 'chatId', invalid),
    transcriptViewId: stringField(value.transcriptViewId, 'transcriptViewId', invalid),
    direction,
    watermarkOrdinal: integerField(value.watermarkOrdinal, 'watermarkOrdinal', invalid),
    lastOrdinal: integerField(value.lastOrdinal, 'lastOrdinal', invalid),
    startOrdinal: integerField(value.startOrdinal, 'startOrdinal', invalid),
    endOrdinal: integerField(value.endOrdinal, 'endOrdinal', invalid),
    anchorsRemaining: integerField(value.anchorsRemaining, 'anchorsRemaining', invalid),
    pageStatus,
    messages,
    resendCandidates,
  };
  if (page.chatId !== request.chatId || (
    request.transcriptViewId !== undefined && page.transcriptViewId !== request.transcriptViewId
  )) invalid('identity does not match request');
  const watermarkOrdinal = page.watermarkOrdinal;
  if (watermarkOrdinal !== (request.watermarkOrdinal ?? page.lastOrdinal) || watermarkOrdinal > page.lastOrdinal
    || page.lastOrdinal === Number.MAX_SAFE_INTEGER) invalid('watermark');
  const cursor = request.cursorOrdinal ?? (direction === 'backward' ? watermarkOrdinal + 1 : 0);
  const width = page.endOrdinal - page.startOrdinal;
  if (page.startOrdinal < 1 || width < 0
    || page.endOrdinal > watermarkOrdinal + 1) invalid('raw span');
  if (direction === 'backward' ? page.endOrdinal !== cursor : page.startOrdinal !== cursor + 1) {
    invalid('cursor contiguity');
  }
  if (messages.length > width || messages.some(entry =>
    entry.ordinal < page.startOrdinal || entry.ordinal >= page.endOrdinal
  )) invalid('message outside raw span');
  const anchors = messages.filter(entry => isTranscriptAnchor(entry.message)).length;
  if (page.anchorsRemaining !== request.anchorsRemaining - anchors) invalid('anchor budget');
  const atEdge = direction === 'backward' ? page.startOrdinal === 1 : page.endOrdinal === watermarkOrdinal + 1;
  if ((pageStatus === 'exhausted') !== atEdge) invalid('exhaustion');
  if (pageStatus === 'complete' && (page.anchorsRemaining !== 0
    || (width === 0 && request.anchorsRemaining !== 0))) invalid('completion');
  if (pageStatus === 'partial' && width === 0) invalid('partial must make progress');
  if ((direction === 'forward' || request.cursorOrdinal !== undefined) && resendCandidates.length !== 0) {
    invalid('resend candidates on continuation');
  }
  return page;
}

export function transcriptAnchorCursor(page: TranscriptAnchorPage): number {
  return page.direction === 'backward' ? page.startOrdinal : page.endOrdinal - 1;
}

export function transcriptAnchorContinuation(page: TranscriptAnchorPage): TranscriptAnchorRequest | null {
  if (page.pageStatus !== 'partial') return null;
  return {
    chatId: page.chatId,
    direction: page.direction,
    transcriptViewId: page.transcriptViewId,
    watermarkOrdinal: page.watermarkOrdinal,
    cursorOrdinal: transcriptAnchorCursor(page),
    anchorsRemaining: page.anchorsRemaining,
  };
}

export function transcriptAnchorWindow(page: TranscriptAnchorPage): TranscriptPage {
  if (page.startOrdinal === page.endOrdinal && page.watermarkOrdinal !== 0) {
    throw new Error('Empty terminal anchor chunks do not describe a transcript window');
  }
  const nextBeforeOrdinal = page.startOrdinal > 1 ? page.startOrdinal : null;
  return {
    transcriptViewId: page.transcriptViewId,
    messages: page.messages,
    lastOrdinal: page.lastOrdinal,
    pageOldestOrdinal: page.messages[0]?.ordinal ?? 0,
    pageNewestOrdinal: page.endOrdinal - 1,
    nextBeforeOrdinal,
    hasMore: nextBeforeOrdinal !== null,
  };
}

function integerField(value: unknown, field: string, invalid: (reason: string) => never): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

function stringField(value: unknown, field: string, invalid: (reason: string) => never): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(field);
  return value;
}
