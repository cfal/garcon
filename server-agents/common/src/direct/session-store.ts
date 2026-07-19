// Persists text-only direct chat history for compatible API providers.

import { promises as fs } from 'fs';
import { hasNodeErrorCode } from '@garcon/server-agent-common/lib/errors';
import { syncDirectory } from '@garcon/server-agent-common/lib/json-file-store';

export type DirectConversationRole = 'user' | 'assistant';

export interface DirectMessageIdentity {
  clientRequestId?: string;
  clientMessageId?: string;
  turnId?: string;
}

export interface DirectConversationMessage {
  role: DirectConversationRole;
  content: string;
  clientRequestId?: string;
  clientMessageId?: string;
  turnId?: string;
}

export interface PersistedDirectMessage extends DirectConversationMessage {
  timestamp: string;
}

export interface DirectSessionStoreConfig {
  getSessionDir: () => string;
  getSessionFilePath: (sessionId: string) => string;
  fileSystem?: Pick<
    typeof fs,
    'mkdir' | 'open' | 'readFile' | 'rm' | 'stat'
  >;
  syncDirectory?: (directory: string) => Promise<void>;
}

const DELIVERY_IDENTITY_FIELDS = [
  'clientRequestId',
  'clientMessageId',
  'turnId',
] as const;

type DeliveryIdentityField = typeof DELIVERY_IDENTITY_FIELDS[number];

interface DirectSessionFileRevision {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function fileRevision(stat: { size: number; mtimeMs: number; ctimeMs: number }): DirectSessionFileRevision {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function fileRevisionsMatch(
  left: DirectSessionFileRevision | undefined,
  right: DirectSessionFileRevision,
): boolean {
  return left?.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function matchingIdentityFields(
  message: DirectMessageIdentity,
  identity: DirectMessageIdentity,
): DeliveryIdentityField[] {
  return DELIVERY_IDENTITY_FIELDS.filter((field) => (
    identity[field] !== undefined && message[field] === identity[field]
  ));
}

function hasExactIdentity(
  message: DirectMessageIdentity,
  identity: DirectMessageIdentity,
): boolean {
  return DELIVERY_IDENTITY_FIELDS.every((field) => message[field] === identity[field]);
}

export class DirectSessionStore {
  readonly #validatedFileRevisions = new Map<string, DirectSessionFileRevision>();
  readonly #fileSystem: NonNullable<DirectSessionStoreConfig['fileSystem']>;
  readonly #syncDirectory: (directory: string) => Promise<void>;

  constructor(private readonly config: DirectSessionStoreConfig) {
    this.#fileSystem = config.fileSystem ?? fs;
    this.#syncDirectory = config.syncDirectory ?? syncDirectory;
  }

  async append(
    sessionId: string,
    role: DirectConversationRole,
    content: string,
    identity: DirectMessageIdentity = {},
  ): Promise<void> {
    await this.#fileSystem.mkdir(this.config.getSessionDir(), { recursive: true });
    const entry: PersistedDirectMessage = {
      role,
      content,
      timestamp: new Date().toISOString(),
      ...(identity.clientRequestId ? { clientRequestId: identity.clientRequestId } : {}),
      ...(identity.clientMessageId ? { clientMessageId: identity.clientMessageId } : {}),
      ...(identity.turnId ? { turnId: identity.turnId } : {}),
    };
    const sessionFilePath = this.config.getSessionFilePath(sessionId);
    const prepared = await this.#prepareFileForAppend(sessionFilePath);
    const serialized = `${prepared.separator}${JSON.stringify(entry)}\n`;
    const file = await this.#fileSystem.open(sessionFilePath, 'a');
    try {
      await file.writeFile(serialized, 'utf8');
      await file.sync();
    } finally {
      await file.close().catch(() => {});
    }
    if (!prepared.fileExisted) await this.#syncDirectory(this.config.getSessionDir());
    await this.#rememberFileRevision(
      sessionFilePath,
      prepared.fileLength + Buffer.byteLength(serialized),
    );
  }

  async delete(sessionId: string): Promise<void> {
    const sessionFilePath = this.config.getSessionFilePath(sessionId);
    this.#validatedFileRevisions.delete(sessionFilePath);
    try {
      await this.#fileSystem.rm(sessionFilePath);
      await this.#syncDirectory(this.config.getSessionDir());
    } catch (error: unknown) {
      if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
    }
  }

  async prepareUserTurn(
    sessionId: string,
    content: string,
    identity: DirectMessageIdentity,
  ): Promise<'appended' | 'already-persisted' | 'turn-complete'> {
    const suppliedFields = DELIVERY_IDENTITY_FIELDS.filter((field) => identity[field] !== undefined);
    if (suppliedFields.length === 0) {
      await this.append(sessionId, 'user', content, identity);
      return 'appended';
    }

    const messages = await this.read(sessionId) ?? [];
    const matchingUserIndexes = messages.flatMap((message, index) => (
      message.role === 'user' && matchingIdentityFields(message, identity).length > 0
        ? [index]
        : []
    ));
    if (matchingUserIndexes.length === 0) {
      await this.append(sessionId, 'user', content, identity);
      return 'appended';
    }

    if (matchingUserIndexes.length !== 1) {
      throw new Error('Direct session delivery identity resolves to multiple persisted user messages');
    }
    const userIndex = matchingUserIndexes[0]!;
    const persistedUser = messages[userIndex]!;
    if (!hasExactIdentity(persistedUser, identity)) {
      throw new Error('Direct session delivery identity conflicts with the persisted identity tuple');
    }
    if (persistedUser.content !== content) {
      throw new Error('Direct session delivery identity was reused with different content');
    }
    const completed = messages
      .slice(userIndex + 1)
      .some((message) => message.role === 'assistant' && hasExactIdentity(message, identity));
    return completed ? 'turn-complete' : 'already-persisted';
  }

  async read(sessionId: string): Promise<DirectConversationMessage[] | null> {
    let raw = '';
    const sessionFilePath = this.config.getSessionFilePath(sessionId);
    try {
      raw = await this.#fileSystem.readFile(sessionFilePath, 'utf8');
    } catch (error: unknown) {
      if (hasNodeErrorCode(error, 'ENOENT')) return null;
      throw error;
    }

    const messages = parseDirectSession(raw);
    if (raw.endsWith('\n')) {
      await this.#rememberFileRevision(sessionFilePath, Buffer.byteLength(raw));
    }

    return messages.length > 0 ? messages : null;
  }

  async #prepareFileForAppend(
    sessionFilePath: string,
  ): Promise<{ separator: string; fileLength: number; fileExisted: boolean }> {
    try {
      const stat = await this.#fileSystem.stat(sessionFilePath);
      if (fileRevisionsMatch(
        this.#validatedFileRevisions.get(sessionFilePath),
        fileRevision(stat),
      )) {
        return { separator: '', fileLength: stat.size, fileExisted: true };
      }
    } catch (error: unknown) {
      if (hasNodeErrorCode(error, 'ENOENT')) {
        this.#validatedFileRevisions.delete(sessionFilePath);
        return { separator: '', fileLength: 0, fileExisted: false };
      }
      throw error;
    }

    let raw: Buffer;
    try {
      raw = await this.#fileSystem.readFile(sessionFilePath);
    } catch (error: unknown) {
      if (hasNodeErrorCode(error, 'ENOENT')) {
        return { separator: '', fileLength: 0, fileExisted: false };
      }
      throw error;
    }
    if (raw.length === 0) return { separator: '', fileLength: 0, fileExisted: true };

    const lastNewline = raw.lastIndexOf(0x0a);
    const completeLength = lastNewline + 1;
    const complete = raw.subarray(0, completeLength).toString('utf8');
    parseDirectSession(complete);
    if (completeLength === raw.length) {
      return { separator: '', fileLength: raw.length, fileExisted: true };
    }

    const trailing = raw.subarray(completeLength).toString('utf8');
    if (parseDirectMessageLine(trailing)) {
      return { separator: '\n', fileLength: raw.length, fileExisted: true };
    }
    const file = await this.#fileSystem.open(sessionFilePath, 'r+');
    try {
      await file.truncate(completeLength);
      await file.sync();
    } finally {
      await file.close().catch(() => {});
    }
    return { separator: '', fileLength: completeLength, fileExisted: true };
  }

  async #rememberFileRevision(sessionFilePath: string, expectedSize: number): Promise<void> {
    const stat = await this.#fileSystem.stat(sessionFilePath);
    if (stat.size === expectedSize) {
      this.#validatedFileRevisions.set(sessionFilePath, fileRevision(stat));
    } else {
      this.#validatedFileRevisions.delete(sessionFilePath);
    }
  }
}

function parseDirectSession(raw: string): DirectConversationMessage[] {
  const lines = raw.split('\n');
  const hasIncompleteTail = !raw.endsWith('\n');
  const messages: DirectConversationMessage[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const parsed = parseDirectMessageLine(line);
    if (parsed) {
      messages.push(parsed);
      continue;
    }
    if (hasIncompleteTail && index === lines.length - 1) continue;
    throw new Error(`Direct session transcript contains malformed record at line ${index + 1}`);
  }
  return messages;
}

export function parseDirectMessageLine(line: string): DirectConversationMessage | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const role = parsed.role;
    const content = parsed.content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
      return {
        role,
        content,
        ...(typeof parsed.clientRequestId === 'string' ? { clientRequestId: parsed.clientRequestId } : {}),
        ...(typeof parsed.clientMessageId === 'string' ? { clientMessageId: parsed.clientMessageId } : {}),
        ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}
