import {
  CommandRequestValidationError,
  optionalNonEmptyString,
  requestRecord,
  requiredChatId,
  requiredCommandCorrelationId,
} from './command-request-validation.js';
import type { DeleteChatCommandRequest, ForkChatCommandRequest } from './chat-command-contracts.js';

export function parseForkChatCommandRequest(value: unknown): ForkChatCommandRequest {
  const body = requestRecord(value);
  const upToOrdinal = body.upToOrdinal;
  const transcriptViewId = optionalNonEmptyString(body, 'transcriptViewId');
  if (
    upToOrdinal !== undefined
    && (!Number.isSafeInteger(upToOrdinal) || Number(upToOrdinal) <= 0)
  ) {
    throw new CommandRequestValidationError('upToOrdinal must be a positive integer');
  }
  if (transcriptViewId !== undefined && upToOrdinal === undefined) {
    throw new CommandRequestValidationError('transcriptViewId requires upToOrdinal');
  }
  if (upToOrdinal !== undefined && transcriptViewId === undefined) {
    throw new CommandRequestValidationError('upToOrdinal requires transcriptViewId');
  }
  const allowHandoffFork = parseHandoffForkConsent(body);
  const clientRequestId = body.clientRequestId === undefined
    ? undefined
    : requiredCommandCorrelationId(body, 'clientRequestId');
  return {
    sourceChatId: requiredChatId(body, 'sourceChatId'),
    chatId: requiredChatId(body, 'chatId'),
    ...(upToOrdinal === undefined ? {} : { upToOrdinal: Number(upToOrdinal) }),
    ...(allowHandoffFork ? { allowHandoffFork: true } : {}),
    ...(transcriptViewId === undefined ? {} : { transcriptViewId }),
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
  };
}

export function parseHandoffForkConsent(body: Record<string, unknown>): true | undefined {
  const consent = body.allowHandoffFork;
  if (consent !== undefined && typeof consent !== 'boolean') {
    throw new CommandRequestValidationError('allowHandoffFork must be a boolean');
  }
  return consent === true ? true : undefined;
}

export function parseDeleteChatCommandRequest(value: unknown): DeleteChatCommandRequest {
  return { chatId: requiredChatId(requestRecord(value), 'chatId') };
}
