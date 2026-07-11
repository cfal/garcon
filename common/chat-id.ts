const CHAT_ID_PATTERN = /^\d{16}$/;
const LEGACY_SECONDS_CHAT_ID_PATTERN = /^\d{10}$/;
const LEGACY_MILLISECONDS_CHAT_ID_PATTERN = /^\d{13}$/;
const MICROSECONDS_PER_MILLISECOND = 1_000n;
const MAX_SAFE_CHAT_ID = BigInt(Number.MAX_SAFE_INTEGER);

declare const chatIdBrand: unique symbol;

export type ChatId = string & { readonly [chatIdBrand]: true };

export class InvalidChatIdError extends Error {
  constructor(readonly value: unknown) {
    super('Chat ID must be a valid 16-digit Unix-microsecond timestamp');
    this.name = 'InvalidChatIdError';
  }
}

export function parseChatId(value: unknown): ChatId {
  if (typeof value !== 'string' || !CHAT_ID_PATTERN.test(value)) {
    throw new InvalidChatIdError(value);
  }

  const epochMicros = BigInt(value);
  if (epochMicros > MAX_SAFE_CHAT_ID) throw new InvalidChatIdError(value);

  const epochMs = Number(epochMicros / MICROSECONDS_PER_MILLISECOND);
  if (!Number.isSafeInteger(epochMs) || epochMs <= 0) {
    throw new InvalidChatIdError(value);
  }
  if (!Number.isFinite(new Date(epochMs).getTime())) {
    throw new InvalidChatIdError(value);
  }
  return value as ChatId;
}

export function chatIdFromEpochMicroseconds(epochMicros: bigint): ChatId {
  return parseChatId(epochMicros.toString());
}

export function chatIdFromTimestamp(epochMs: number, microsWithinMs: number): ChatId {
  if (!Number.isSafeInteger(epochMs) || epochMs <= 0) {
    throw new InvalidChatIdError(epochMs);
  }
  if (!Number.isInteger(microsWithinMs) || microsWithinMs < 0 || microsWithinMs > 999) {
    throw new InvalidChatIdError(microsWithinMs);
  }
  return chatIdFromEpochMicroseconds(
    BigInt(epochMs) * MICROSECONDS_PER_MILLISECOND + BigInt(microsWithinMs),
  );
}

export function chatIdCreatedAt(chatId: string): Date {
  const parsed = parseChatId(chatId);
  return new Date(Number(BigInt(parsed) / MICROSECONDS_PER_MILLISECOND));
}

export function legacyChatIdToCanonical(value: unknown): ChatId | null {
  if (typeof value !== 'string') return null;
  if (LEGACY_SECONDS_CHAT_ID_PATTERN.test(value)) {
    return parseChatId(value.padEnd(16, '0'));
  }
  if (LEGACY_MILLISECONDS_CHAT_ID_PATTERN.test(value)) {
    return parseChatId(value.padEnd(16, '0'));
  }
  return null;
}
