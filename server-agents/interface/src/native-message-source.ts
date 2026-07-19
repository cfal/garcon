import type { ChatMessage } from '@garcon/common/chat-types';

export interface NativeMessageSource {
  readonly entryId?: string;
  readonly lineNumber?: number;
  readonly byteOffset?: number;
  readonly withinSourceOrdinal?: number;
}

const NATIVE_MESSAGE_SOURCE = Symbol.for('garcon.nativeMessageSource');

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function attachNativeMessageSource<T extends object>(
  target: T,
  source: NativeMessageSource | null | undefined,
): T {
  if (!source || (
    !nonEmptyString(source.entryId)
    && !isPositiveInt(source.lineNumber)
    && !isPositiveInt(source.byteOffset)
    && !isNonNegativeInt(source.withinSourceOrdinal)
  )) return target;

  Object.defineProperty(target, NATIVE_MESSAGE_SOURCE, {
    value: {
      ...(nonEmptyString(source.entryId) ? { entryId: source.entryId } : {}),
      ...(isPositiveInt(source.lineNumber) ? { lineNumber: source.lineNumber } : {}),
      ...(isPositiveInt(source.byteOffset) ? { byteOffset: source.byteOffset } : {}),
      ...(isNonNegativeInt(source.withinSourceOrdinal)
        ? { withinSourceOrdinal: source.withinSourceOrdinal }
        : {}),
    },
    enumerable: false,
    configurable: true,
  });
  return target;
}

export function attachNativeSourceToMessages<T extends ChatMessage>(
  messages: T[],
  source: NativeMessageSource | null | undefined,
): T[] {
  for (const message of messages) attachNativeMessageSource(message, source);
  return messages;
}

export function getNativeMessageSource(value: unknown): NativeMessageSource | null {
  const source = getStoredNativeMessageSource(value);
  if (!source) return null;
  const { withinSourceOrdinal: _withinSourceOrdinal, ...publicSource } = source;
  return publicSource;
}

export function getNativeMessageRevisionSource(value: unknown): NativeMessageSource | null {
  return getStoredNativeMessageSource(value);
}

function getStoredNativeMessageSource(value: unknown): NativeMessageSource | null {
  if (!value || typeof value !== 'object') return null;
  const source = (value as Record<PropertyKey, unknown>)[NATIVE_MESSAGE_SOURCE];
  if (!source || typeof source !== 'object') return null;
  const raw = source as Record<string, unknown>;
  return {
    ...(nonEmptyString(raw.entryId) ? { entryId: raw.entryId } : {}),
    ...(isPositiveInt(raw.lineNumber) ? { lineNumber: raw.lineNumber } : {}),
    ...(isPositiveInt(raw.byteOffset) ? { byteOffset: raw.byteOffset } : {}),
    ...(isNonNegativeInt(raw.withinSourceOrdinal)
      ? { withinSourceOrdinal: raw.withinSourceOrdinal }
      : {}),
  };
}
