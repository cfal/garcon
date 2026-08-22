import crypto from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentAttachment } from '@garcon/common/agent-execution';
import type {
  AgentHost,
  AgentNativeSessionRef,
} from '@garcon/server-agent-interface';
import { hasNodeErrorCode } from '../lib/errors.js';
import { syncDirectory } from '../lib/json-file-store.js';

const DIRECT_SESSION_NAMESPACE = 'direct-sessions-v1';
const DIRECT_SESSION_SCHEMA_VERSION = 1;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface DirectSessionHeaderV1 {
  readonly type: 'session';
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface DirectUserRecordV1 {
  readonly type: 'user';
  readonly at: string;
  readonly runId: string;
  readonly content: string;
  readonly attachments: readonly AgentAttachment[];
}

export interface DirectResponsesCheckpointV1 {
  readonly kind: 'openai-response';
  readonly responseId: string;
  readonly endpointId: string;
  readonly endpointFingerprint: string;
  readonly model: string;
}

export interface DirectAssistantRecordV1 {
  readonly type: 'assistant';
  readonly at: string;
  readonly runId: string;
  readonly content: string;
  readonly checkpoint: DirectResponsesCheckpointV1 | null;
}

export type DirectSessionRecordV1 = DirectUserRecordV1 | DirectAssistantRecordV1;

export interface DirectSessionSnapshot {
  readonly header: DirectSessionHeaderV1;
  readonly records: readonly DirectSessionRecordV1[];
  readonly path: string;
}

export interface DirectSessionStoreOptions {
  readonly host: Pick<AgentHost, 'agentId' | 'storage'>;
  readonly now?: () => string;
  readonly syncDirectory?: (directory: string) => Promise<void>;
}

interface ParsedSessionFile {
  readonly header: DirectSessionHeaderV1;
  readonly records: readonly DirectSessionRecordV1[];
  readonly appendOffset: number;
  readonly separator: '' | '\n';
  readonly ignoredTail: boolean;
}

export class DirectSessionStore {
  readonly #host: DirectSessionStoreOptions['host'];
  readonly #now: () => string;
  readonly #syncDirectory: (directory: string) => Promise<void>;
  readonly #operations = new Map<string, Promise<void>>();
  #directoryPromise: Promise<string> | null = null;

  constructor(options: DirectSessionStoreOptions) {
    this.#host = options.host;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#syncDirectory = options.syncDirectory ?? syncDirectory;
  }

  createSessionId(): string {
    return crypto.randomUUID();
  }

  nativeReference(sessionId: string): AgentNativeSessionRef {
    requireSessionId(sessionId);
    return {
      ownerId: this.#host.agentId,
      schemaVersion: DIRECT_SESSION_SCHEMA_VERSION,
      value: { sessionId },
    };
  }

  sessionIdFromReference(
    reference: AgentNativeSessionRef | null,
    expectedSessionId?: string | null,
  ): string {
    if (!isRecord(reference) || !hasExactKeys(reference, ['ownerId', 'schemaVersion', 'value'])) {
      throw new TypeError('Direct native session reference is invalid');
    }
    if (
      reference.ownerId !== this.#host.agentId
      || reference.schemaVersion !== DIRECT_SESSION_SCHEMA_VERSION
      || !isRecord(reference.value)
      || !hasExactKeys(reference.value, ['sessionId'])
    ) {
      throw new TypeError('Direct native session reference is invalid');
    }
    const sessionId = requireSessionId(reference.value.sessionId);
    if (expectedSessionId !== undefined && expectedSessionId !== null) {
      requireSessionId(expectedSessionId);
      if (sessionId !== expectedSessionId) {
        throw new TypeError('Direct native session reference does not match the selected session');
      }
    }
    return sessionId;
  }

  async create(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly content: string;
    readonly attachments: readonly AgentAttachment[];
  }): Promise<DirectSessionSnapshot> {
    const sessionId = requireSessionId(input.sessionId);
    return this.#serialized(sessionId, async () => {
      const directory = await this.#directory();
      const filePath = path.join(directory, `${sessionId}.jsonl`);
      const createdAt = requireTimestamp(this.#now(), 'createdAt');
      const header: DirectSessionHeaderV1 = {
        type: 'session',
        schemaVersion: DIRECT_SESSION_SCHEMA_VERSION,
        ownerId: requireNonEmptyString(this.#host.agentId, 'ownerId'),
        sessionId,
        createdAt,
      };
      const user = parseUserRecord({
        type: 'user',
        at: createdAt,
        runId: input.runId,
        content: input.content,
        attachments: input.attachments,
      });
      const payload = encodeLines([header, user]);
      const file = await fs.open(
        filePath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.chmod(0o600);
        await file.writeFile(payload);
        await file.sync();
      } finally {
        await file.close().catch(() => undefined);
      }
      await this.#syncDirectory(directory);
      return { header, records: [user], path: filePath };
    });
  }

  async load(sessionId: string): Promise<DirectSessionSnapshot> {
    const validatedSessionId = requireSessionId(sessionId);
    return this.#serialized(validatedSessionId, async () => {
      const filePath = await this.#sessionFilePath(validatedSessionId);
      const file = await openRegularFile(filePath, constants.O_RDONLY);
      try {
        const parsed = parseSessionFile(
          await file.readFile(),
          this.#host.agentId,
          validatedSessionId,
        );
        return { header: parsed.header, records: parsed.records, path: filePath };
      } finally {
        await file.close().catch(() => undefined);
      }
    });
  }

  async appendUser(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly content: string;
    readonly attachments: readonly AgentAttachment[];
  }): Promise<DirectUserRecordV1> {
    const record = parseUserRecord({
      type: 'user',
      at: requireTimestamp(this.#now(), 'at'),
      runId: input.runId,
      content: input.content,
      attachments: input.attachments,
    });
    await this.#append(input.sessionId, record);
    return record;
  }

  async appendAssistant(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly content: string;
    readonly checkpoint?: DirectResponsesCheckpointV1 | null;
  }): Promise<DirectAssistantRecordV1> {
    const record = parseAssistantRecord({
      type: 'assistant',
      at: requireTimestamp(this.#now(), 'at'),
      runId: input.runId,
      content: input.content,
      checkpoint: input.checkpoint ?? null,
    });
    await this.#append(input.sessionId, record);
    return record;
  }

  async delete(sessionId: string): Promise<void> {
    const validatedSessionId = requireSessionId(sessionId);
    await this.#serialized(validatedSessionId, async () => {
      const directory = await this.#directory();
      const filePath = path.join(directory, `${validatedSessionId}.jsonl`);
      try {
        await fs.rm(filePath);
      } catch (error) {
        if (hasNodeErrorCode(error, 'ENOENT')) return;
        throw error;
      }
      await this.#syncDirectory(directory);
    });
  }

  async #append(sessionId: string, record: DirectSessionRecordV1): Promise<void> {
    const validatedSessionId = requireSessionId(sessionId);
    await this.#serialized(validatedSessionId, async () => {
      const filePath = await this.#sessionFilePath(validatedSessionId);
      const file = await openRegularFile(filePath, constants.O_RDWR);
      try {
        const parsed = parseSessionFile(
          await file.readFile(),
          this.#host.agentId,
          validatedSessionId,
        );
        validateSequence([...parsed.records, record]);
        if (parsed.ignoredTail) {
          await file.truncate(parsed.appendOffset);
          await file.sync();
        }
        const encoded = Buffer.from(`${parsed.separator}${JSON.stringify(record)}\n`, 'utf8');
        await writeAll(file, encoded, parsed.appendOffset);
        await file.sync();
      } finally {
        await file.close().catch(() => undefined);
      }
    });
  }

  async #directory(): Promise<string> {
    this.#directoryPromise ??= this.#host.storage.directory(DIRECT_SESSION_NAMESPACE);
    return this.#directoryPromise;
  }

  async #sessionFilePath(sessionId: string): Promise<string> {
    return path.join(await this.#directory(), `${sessionId}.jsonl`);
  }

  async #serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.#operations.set(sessionId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#operations.get(sessionId) === queued) this.#operations.delete(sessionId);
    }
  }
}

async function openRegularFile(filePath: string, flags: number) {
  const file = await fs.open(filePath, flags | constants.O_NOFOLLOW);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new TypeError('Direct session source is not a regular file');
    return file;
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function writeAll(
  file: Awaited<ReturnType<typeof fs.open>>,
  value: Uint8Array,
  offset: number,
): Promise<void> {
  let written = 0;
  while (written < value.byteLength) {
    const result = await file.write(value, written, value.byteLength - written, offset + written);
    if (result.bytesWritten <= 0) throw new Error('Direct session append made no progress');
    written += result.bytesWritten;
  }
}

function parseSessionFile(
  raw: Buffer,
  expectedOwnerId: string,
  expectedSessionId: string,
): ParsedSessionFile {
  const endsWithNewline = raw.at(-1) === 0x0a;
  const lastNewline = raw.lastIndexOf(0x0a);
  const completeLength = endsWithNewline ? raw.length : lastNewline + 1;
  const completeLines = decodeUtf8(raw.subarray(0, completeLength))
    .split('\n')
    .slice(0, -1);
  const values = completeLines.map((line, index) => parseJsonLine(line, index + 1));
  let ignoredTail = false;
  let separator: '' | '\n' = '';
  let appendOffset = raw.length;

  if (values.length < 1) throw new TypeError('Direct session is missing its header');
  const header = parseHeader(values[0]);
  if (header.ownerId !== expectedOwnerId || header.sessionId !== expectedSessionId) {
    throw new TypeError('Direct session header does not match the selected session');
  }
  let records = values.slice(1).map(parseSessionRecord);
  validateSequence(records);
  if (!endsWithNewline && completeLength < raw.length) {
    try {
      const tail = parseSessionRecord(parseJsonLine(
        decodeUtf8(raw.subarray(completeLength)),
        completeLines.length + 1,
      ));
      validateSequence([...records, tail]);
      records = [...records, tail];
      separator = '\n';
    } catch {
      ignoredTail = true;
      appendOffset = completeLength;
    }
  }
  if (records.length < 1 || records[0]?.type !== 'user') {
    throw new TypeError('Direct session is missing its first user record');
  }
  return { header, records, appendOffset, separator, ignoredTail };
}

function parseJsonLine(line: string, lineNumber: number): unknown {
  if (!line) throw new TypeError(`Direct session record ${lineNumber} is empty`);
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new TypeError(`Direct session record ${lineNumber} is malformed`, { cause: error });
  }
}

function parseHeader(value: unknown): DirectSessionHeaderV1 {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['type', 'schemaVersion', 'ownerId', 'sessionId', 'createdAt'],
  )) {
    throw new TypeError('Direct session header is invalid');
  }
  if (value.type !== 'session' || value.schemaVersion !== DIRECT_SESSION_SCHEMA_VERSION) {
    throw new TypeError('Direct session header schema is unsupported');
  }
  return {
    type: 'session',
    schemaVersion: DIRECT_SESSION_SCHEMA_VERSION,
    ownerId: requireNonEmptyString(value.ownerId, 'ownerId'),
    sessionId: requireSessionId(value.sessionId),
    createdAt: requireTimestamp(value.createdAt, 'createdAt'),
  };
}

function parseSessionRecord(value: unknown): DirectSessionRecordV1 {
  if (!isRecord(value)) throw new TypeError('Direct session record is invalid');
  if (value.type === 'user') return parseUserRecord(value);
  if (value.type === 'assistant') return parseAssistantRecord(value);
  throw new TypeError('Direct session record type is unsupported');
}

function parseUserRecord(value: unknown): DirectUserRecordV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'at', 'runId', 'content', 'attachments'])) {
    throw new TypeError('Direct user record is invalid');
  }
  const content = requireString(value.content, 'content');
  const attachments = parseAttachments(value.attachments);
  if (!content && attachments.length === 0) {
    throw new TypeError('Direct user record requires content or attachments');
  }
  return {
    type: 'user',
    at: requireTimestamp(value.at, 'at'),
    runId: requireNonEmptyString(value.runId, 'runId'),
    content,
    attachments,
  };
}

function parseAssistantRecord(value: unknown): DirectAssistantRecordV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'at', 'runId', 'content', 'checkpoint'])) {
    throw new TypeError('Direct assistant record is invalid');
  }
  const content = requireString(value.content, 'content');
  if (!content.trim()) throw new TypeError('Direct assistant record content is empty');
  return {
    type: 'assistant',
    at: requireTimestamp(value.at, 'at'),
    runId: requireNonEmptyString(value.runId, 'runId'),
    content,
    checkpoint: value.checkpoint === null ? null : parseCheckpoint(value.checkpoint),
  };
}

function parseCheckpoint(value: unknown): DirectResponsesCheckpointV1 {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['kind', 'responseId', 'endpointId', 'endpointFingerprint', 'model'],
  )) {
    throw new TypeError('Direct Responses checkpoint is invalid');
  }
  const endpointFingerprint = requireNonEmptyString(
    value.endpointFingerprint,
    'endpointFingerprint',
  );
  if (!SHA256_PATTERN.test(endpointFingerprint)) {
    throw new TypeError('Direct Responses checkpoint fingerprint is invalid');
  }
  if (value.kind !== 'openai-response') {
    throw new TypeError('Direct Responses checkpoint kind is invalid');
  }
  return {
    kind: 'openai-response',
    responseId: requireNonEmptyString(value.responseId, 'responseId'),
    endpointId: requireNonEmptyString(value.endpointId, 'endpointId'),
    endpointFingerprint,
    model: requireNonEmptyString(value.model, 'model'),
  };
}

function parseAttachments(value: unknown): readonly AgentAttachment[] {
  if (!Array.isArray(value)) throw new TypeError('Direct user attachments are invalid');
  return value.map((attachment) => {
    if (!isRecord(attachment) || !hasExactKeys(attachment, ['kind', 'data', 'name', 'mimeType'])) {
      throw new TypeError('Direct user attachment is invalid');
    }
    if (attachment.kind !== 'image') throw new TypeError('Direct user attachment kind is invalid');
    const name = attachment.name;
    if (name !== null && typeof name !== 'string') {
      throw new TypeError('Direct user attachment name is invalid');
    }
    if (typeof name === 'string' && !name.isWellFormed()) {
      throw new TypeError('Direct user attachment name contains malformed Unicode');
    }
    return {
      kind: 'image',
      data: requireNonEmptyString(attachment.data, 'attachment data'),
      name,
      mimeType: requireNonEmptyString(attachment.mimeType, 'attachment MIME type'),
    };
  });
}

function validateSequence(records: readonly DirectSessionRecordV1[]): void {
  const users = new Set<string>();
  const assistants = new Set<string>();
  for (const record of records) {
    if (record.type === 'user') {
      if (users.has(record.runId)) throw new TypeError('Direct session contains a duplicate user run');
      users.add(record.runId);
      continue;
    }
    if (!users.has(record.runId)) {
      throw new TypeError('Direct assistant record has no preceding user record');
    }
    if (assistants.has(record.runId)) {
      throw new TypeError('Direct session contains a duplicate assistant run');
    }
    assistants.add(record.runId);
  }
}

function encodeLines(values: readonly unknown[]): Buffer {
  return Buffer.from(`${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return utf8Decoder.decode(value);
  } catch (error) {
    throw new TypeError('Direct session contains invalid UTF-8', { cause: error });
  }
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new TypeError('Direct session ID is invalid');
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireNonEmptyString(value, field);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new TypeError(`Direct session ${field} is invalid`);
  }
  return timestamp;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const string = requireString(value, field);
  if (!string) throw new TypeError(`Direct session ${field} is empty`);
  return string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw new TypeError(`Direct session ${field} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && [...expected].sort().every((key, index) => actual[index] === key);
}
