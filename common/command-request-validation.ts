import { InvalidChatIdError, parseChatId } from './chat-id.js';

export const COMMAND_CORRELATION_ID_MAX_BYTES = 256;
export const QUEUE_ENTRY_ID_MAX_BYTES = 128;

const utf8Encoder = new TextEncoder();

export class CommandRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRequestValidationError';
  }
}

export function isCommandCorrelationIdWithinLimit(value: string): boolean {
  return utf8Encoder.encode(value).byteLength <= COMMAND_CORRELATION_ID_MAX_BYTES;
}

export function isQueueEntryIdWithinLimit(value: string): boolean {
  return utf8Encoder.encode(value).byteLength <= QUEUE_ENTRY_ID_MAX_BYTES;
}

export function requestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandRequestValidationError('request body must be an object');
  }
  return value as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CommandRequestValidationError(`${field} is required`);
  }
  return value.trim();
}

export function requiredCommandCorrelationId(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = requiredString(body, field);
  if (!isCommandCorrelationIdWithinLimit(value)) {
    throw new CommandRequestValidationError(
      `${field} must be at most ${COMMAND_CORRELATION_ID_MAX_BYTES} bytes`,
    );
  }
  return value;
}

export function requiredQueueEntryId(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  if (!isQueueEntryIdWithinLimit(value)) {
    throw new CommandRequestValidationError(
      `${field} must be at most ${QUEUE_ENTRY_ID_MAX_BYTES} bytes`,
    );
  }
  return value;
}

export function requiredChatId(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  try {
    return parseChatId(value);
  } catch (error) {
    if (!(error instanceof InvalidChatIdError)) throw error;
    throw new CommandRequestValidationError(
      `${field} must be a valid 16-digit Unix-microsecond timestamp`,
    );
  }
}

export function optionalChatId(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredChatId(body, field);
}

export function requiredContent(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CommandRequestValidationError(`${field} is required`);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  trim = true,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new CommandRequestValidationError(`${field} must be a string`);
  }
  return trim ? value.trim() : value;
}

export function optionalNonEmptyString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = optionalString(body, field);
  if (value !== undefined && value.length === 0) {
    throw new CommandRequestValidationError(`${field} must not be empty`);
  }
  return value;
}

export function optionalNullableString(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') {
    throw new CommandRequestValidationError(`${field} must be a string or null`);
  }
  return value.trim();
}

export function optionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandRequestValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
