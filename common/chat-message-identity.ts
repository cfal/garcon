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

export class ChatMessageIdentityIndex {
  #tokens = new Set<string>();

  constructor(private readonly options: ChatMessageIdentityOptions = {}) {}

  reset(messages: Iterable<ChatMessage> = []): void {
    this.#tokens.clear();
    this.addMany(messages);
  }

  has(message: ChatMessage): boolean {
    return chatMessageIdentityTokens(message, this.options).some((token) => this.#tokens.has(token));
  }

  add(message: ChatMessage): void {
    for (const token of chatMessageIdentityTokens(message, this.options)) {
      this.#tokens.add(token);
    }
  }

  addMany(messages: Iterable<ChatMessage>): void {
    for (const message of messages) {
      this.add(message);
    }
  }

  takeNew(messages: ChatMessage[]): ChatMessage[] {
    const next: ChatMessage[] = [];
    for (const message of messages) {
      if (this.has(message)) continue;
      this.add(message);
      next.push(message);
    }
    return next;
  }
}

export function mergeChatMessagesByIdentity(
  base: ChatMessage[],
  incoming: ChatMessage[],
  options: ChatMessageIdentityOptions = {},
): ChatMessage[] {
  if (incoming.length === 0) return base;

  const index = new ChatMessageIdentityIndex(options);
  index.reset(base);
  const next = index.takeNew(incoming);
  if (next.length === 0) return base;
  return [...base, ...next];
}
