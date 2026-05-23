import type { ChatMessage } from './chat-types';

export interface ChatMessageIdentityOptions {
  includeContentToken?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function addToken(tokens: string[], prefix: string, value: unknown): void {
  const text = nonEmptyString(value);
  if (text) tokens.push(`${prefix}:${text}`);
}

export function chatMessageIdentityTokens(
  message: ChatMessage | Record<string, unknown> | null | undefined,
  options: ChatMessageIdentityOptions = {},
): string[] {
  const raw = asRecord(message);
  const type = nonEmptyString(raw.type);
  if (!type) return [];

  const tokens: string[] = [];
  addToken(tokens, `${type}:tool`, raw.toolId);

  if (type === 'user-message') {
    const metadata = asRecord(raw.metadata);
    addToken(tokens, `${type}:upstream-request`, metadata.upstreamRequestId);
    addToken(tokens, `${type}:client-request`, metadata.clientRequestId);
    addToken(tokens, `${type}:turn`, metadata.turnId);
    addToken(tokens, `${type}:message`, metadata.messageId);
    return tokens;
  }

  if (options.includeContentToken) {
    const content = nonEmptyString(raw.content);
    const normalized = content?.trim();
    if (normalized) tokens.push(`${type}:content:${normalized}`);
  }

  return tokens;
}

export function mergeChatMessagesByIdentity(
  base: ChatMessage[],
  incoming: ChatMessage[],
  options: ChatMessageIdentityOptions = {},
): ChatMessage[] {
  if (incoming.length === 0) return base;

  const seen = new Set<string>();
  for (const message of base) {
    for (const token of chatMessageIdentityTokens(message, options)) {
      seen.add(token);
    }
  }

  const merged = [...base];
  for (const message of incoming) {
    const tokens = chatMessageIdentityTokens(message, options);
    if (tokens.some((token) => seen.has(token))) continue;
    for (const token of tokens) seen.add(token);
    merged.push(message);
  }

  return merged;
}
