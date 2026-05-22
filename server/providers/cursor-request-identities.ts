import fs from 'fs';
import path from 'path';
import { UserMessage, type ChatMessage } from '../../common/chat-types.js';

interface CursorRequestIdentityRecord {
  chatId: string;
  providerSessionId?: string;
  clientRequestId?: string;
  turnId?: string;
  providerRequestId?: string;
  userEchoSeen?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CursorRequestIdentityFile {
  version: 1;
  records: CursorRequestIdentityRecord[];
}

interface CursorRequestIdentityInput {
  chatId: string;
  providerSessionId?: string | null;
  clientRequestId?: string | null;
  turnId?: string | null;
  providerRequestId?: string | null;
  userEchoSeen?: boolean;
}

interface CursorHistoryContext {
  chatId?: string;
  providerSessionId?: string | null;
}

const MAX_RECORDS = 1000;

function cleanString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordMatchesInput(record: CursorRequestIdentityRecord, input: CursorRequestIdentityInput): boolean {
  const providerRequestId = cleanString(input.providerRequestId);
  if (providerRequestId && record.providerRequestId === providerRequestId) return true;

  const clientRequestId = cleanString(input.clientRequestId);
  if (clientRequestId && record.clientRequestId === clientRequestId) return true;

  const turnId = cleanString(input.turnId);
  if (turnId && record.turnId === turnId) return true;

  const providerSessionId = cleanString(input.providerSessionId);
  return Boolean(
    input.chatId
    && providerSessionId
    && record.chatId === input.chatId
    && record.providerSessionId === providerSessionId
    && !record.providerRequestId,
  );
}

function isUserMessage(message: ChatMessage): message is UserMessage {
  return message.type === 'user-message';
}

function withUserMetadata(message: UserMessage, metadata: Record<string, string>): UserMessage {
  return new UserMessage(message.timestamp, message.content, message.images, {
    ...message.metadata,
    ...metadata,
  });
}

export class CursorRequestIdentityStore {
  #filePath: string | null;
  #records: CursorRequestIdentityRecord[] = [];

  constructor(workspaceDir?: string | null) {
    this.#filePath = workspaceDir ? path.join(workspaceDir, 'cursor-request-identities.json') : null;
    this.#load();
  }

  rememberTurn(input: CursorRequestIdentityInput): void {
    this.#upsert(input);
  }

  rememberProviderSession(input: CursorRequestIdentityInput): void {
    this.#upsert(input);
  }

  markUserEcho(input: CursorRequestIdentityInput): void {
    this.#upsert({ ...input, userEchoSeen: true });
  }

  markProviderRequestId(input: CursorRequestIdentityInput): void {
    this.#upsert(input);
  }

  applyToMessages(messages: ChatMessage[], context: CursorHistoryContext): ChatMessage[] {
    const chatId = cleanString(context.chatId);
    const providerSessionId = cleanString(context.providerSessionId);
    if (!chatId && !providerSessionId) return messages;

    const records = this.#recordsForContext(chatId, providerSessionId);
    if (records.length === 0) return messages;

    let changed = false;
    const annotated = messages.map((message) => {
      if (!isUserMessage(message)) return message;
      const providerRequestId = cleanString(message.metadata?.providerRequestId);
      if (!providerRequestId) return message;
      const record = records.find((entry) => entry.providerRequestId === providerRequestId);
      if (!record?.clientRequestId && !record?.turnId) return message;
      changed = true;
      return withUserMetadata(message, {
        ...(record.clientRequestId ? { clientRequestId: record.clientRequestId } : {}),
        ...(record.turnId ? { turnId: record.turnId } : {}),
      });
    });

    const latestUserIndex = annotated.findLastIndex((message) => isUserMessage(message));
    if (latestUserIndex >= 0) {
      const latestUser = annotated[latestUserIndex];
      if (isUserMessage(latestUser) && !latestUser.metadata?.providerRequestId) {
        const liveEcho = [...records]
          .reverse()
          .find((record) => record.userEchoSeen && !record.providerRequestId && (record.clientRequestId || record.turnId));
        if (liveEcho) {
          changed = true;
          annotated[latestUserIndex] = withUserMetadata(latestUser, {
            ...(liveEcho.clientRequestId ? { clientRequestId: liveEcho.clientRequestId } : {}),
            ...(liveEcho.turnId ? { turnId: liveEcho.turnId } : {}),
          });
        }
      }
    }

    return changed ? annotated : messages;
  }

  #recordsForContext(chatId?: string, providerSessionId?: string): CursorRequestIdentityRecord[] {
    return this.#records
      .filter((record) => (
        (!chatId || record.chatId === chatId)
        && (!providerSessionId || record.providerSessionId === providerSessionId)
      ))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  #upsert(input: CursorRequestIdentityInput): void {
    if (!input.clientRequestId && !input.turnId && !input.providerRequestId) return;
    const now = new Date().toISOString();
    const existing = [...this.#records].reverse().find((record) => recordMatchesInput(record, input));
    if (existing) {
      existing.providerSessionId = cleanString(input.providerSessionId) ?? existing.providerSessionId;
      existing.clientRequestId = cleanString(input.clientRequestId) ?? existing.clientRequestId;
      existing.turnId = cleanString(input.turnId) ?? existing.turnId;
      existing.providerRequestId = cleanString(input.providerRequestId) ?? existing.providerRequestId;
      existing.userEchoSeen = input.userEchoSeen ?? existing.userEchoSeen;
      existing.updatedAt = now;
    } else {
      this.#records.push({
        chatId: input.chatId,
        providerSessionId: cleanString(input.providerSessionId),
        clientRequestId: cleanString(input.clientRequestId),
        turnId: cleanString(input.turnId),
        providerRequestId: cleanString(input.providerRequestId),
        userEchoSeen: input.userEchoSeen,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.#records = this.#records.slice(-MAX_RECORDS);
    this.#persist();
  }

  #load(): void {
    if (!this.#filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#filePath, 'utf8')) as CursorRequestIdentityFile;
      if (parsed.version === 1 && Array.isArray(parsed.records)) {
        this.#records = parsed.records.filter((record) => typeof record.chatId === 'string');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('cursor: failed to load request identities:', error instanceof Error ? error.message : String(error));
      }
    }
  }

  #persist(): void {
    if (!this.#filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
      const payload: CursorRequestIdentityFile = {
        version: 1,
        records: this.#records,
      };
      fs.writeFileSync(this.#filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      console.warn('cursor: failed to persist request identities:', error instanceof Error ? error.message : String(error));
    }
  }
}
