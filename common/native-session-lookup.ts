import { isAgentId, type AgentId } from './agents.js';
import { parseChatId, type ChatId } from './chat-id.js';
import { isRecord } from './json.js';

export const NATIVE_SESSION_ID_MAX_BYTES = 256;

const textEncoder = new TextEncoder();
const unsafeControl = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export interface NativeSessionLookupRequest {
  readonly nativeSessionId: string;
  readonly agent?: AgentId;
}

export interface NativeSessionLookupResponse {
  readonly chatId: ChatId;
}

export class NativeSessionLookupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeSessionLookupValidationError';
  }
}

export function parseNativeSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new NativeSessionLookupValidationError('nativeSessionId is required');
  }
  if (textEncoder.encode(value).byteLength > NATIVE_SESSION_ID_MAX_BYTES) {
    throw new NativeSessionLookupValidationError(
      `nativeSessionId must be at most ${NATIVE_SESSION_ID_MAX_BYTES} bytes`,
    );
  }
  if (unsafeControl.test(value)) {
    throw new NativeSessionLookupValidationError(
      'nativeSessionId must not contain control characters',
    );
  }
  return value;
}

export function parseNativeSessionLookupRequest(value: unknown): NativeSessionLookupRequest {
  if (!isRecord(value)) {
    throw new NativeSessionLookupValidationError('request body must be an object');
  }
  const nativeSessionId = parseNativeSessionId(value.nativeSessionId);
  if (value.agent === undefined) return { nativeSessionId };
  if (!isAgentId(value.agent)) {
    throw new NativeSessionLookupValidationError('agent must be a valid agent ID');
  }
  return { nativeSessionId, agent: value.agent };
}

export function parseNativeSessionLookupResponse(value: unknown): NativeSessionLookupResponse {
  if (!isRecord(value)) {
    throw new NativeSessionLookupValidationError('response body must be an object');
  }
  const chatId = parseChatId(value.chatId);
  return { chatId };
}
