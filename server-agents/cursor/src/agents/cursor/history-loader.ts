import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { Database } from 'bun:sqlite';
import {
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { deterministicTranscriptTimestamp } from '@garcon/server-agent-common/shared/transcript-timestamp';
import { normalizeCursorToolResultContent } from './tool-result-converter.js';
import { convertCursorToolUse } from './tool-use-converter.js';

export interface CursorDbBlob {
  rowid: number;
  id: string;
  data?: Uint8Array | Buffer | null;
}

interface CursorJsonBlob extends CursorDbBlob {
  parsed: Record<string, unknown>;
}

export interface CursorMessageBlob {
  content: Record<string, unknown>;
  id: string;
  rowid: number;
  sequence: number;
}

const USER_QUERY_OPEN_TAG = '<user_query>';
const USER_QUERY_CLOSE_TAG = '</user_query>';

export interface CursorPreview {
  createdAt: string | null;
  firstMessage: string;
  lastActivity: string | null;
  lastMessage: string;
}

function cursorHomePath(): string {
  return path.join(os.homedir(), '.cursor');
}

function sanitizeCursorSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new Error('Cursor session id is required.');
  if (
    normalized.includes('..')
    || normalized.includes(path.posix.sep)
    || normalized.includes(path.win32.sep)
    || normalized !== path.basename(normalized)
  ) {
    throw new Error(`Invalid Cursor session id "${sessionId}".`);
  }
  return normalized;
}

function assertPathWithin(basePath: string, targetPath: string, message: string): string {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(message);
  }
  return resolvedTarget;
}

function cursorWorkspaceHash(projectPath: string): string {
  return crypto.createHash('md5').update(path.resolve(projectPath)).digest('hex');
}

export function cursorStreamJsonStoreDbPath(
  sessionId: string,
  projectPath: string,
  cursorHome = cursorHomePath(),
): string {
  return path.join(cursorStreamJsonSessionDirPath(sessionId, projectPath, cursorHome), 'store.db');
}

export function cursorStreamJsonSessionDirPath(
  sessionId: string,
  projectPath: string,
  cursorHome = cursorHomePath(),
): string {
  const safeSessionId = sanitizeCursorSessionId(sessionId);
  const baseSessionsPath = path.join(cursorHome, 'chats', cursorWorkspaceHash(projectPath));
  const sessionDirPath = path.join(baseSessionsPath, safeSessionId);
  return assertPathWithin(
    baseSessionsPath,
    sessionDirPath,
    `Invalid Cursor transcript session path for "${sessionId}".`,
  );
}

export function cursorAcpSessionDirPath(sessionId: string, cursorHome = cursorHomePath()): string {
  const safeSessionId = sanitizeCursorSessionId(sessionId);
  const baseSessionsPath = path.join(cursorHome, 'acp-sessions');
  const sessionDirPath = path.join(baseSessionsPath, safeSessionId);
  return assertPathWithin(
    baseSessionsPath,
    sessionDirPath,
    `Invalid Cursor transcript session path for "${sessionId}".`,
  );
}

export function cursorAcpStoreDbPath(sessionId: string, cursorHome = cursorHomePath()): string {
  return path.join(cursorAcpSessionDirPath(sessionId, cursorHome), 'store.db');
}

export function cursorStoreDbPath(sessionId: string, projectPath: string, cursorHome = cursorHomePath()): string {
  const acpStoreDbPath = cursorAcpStoreDbPath(sessionId, cursorHome);
  if (fs.existsSync(acpStoreDbPath)) return acpStoreDbPath;

  const streamJsonStoreDbPath = cursorStreamJsonStoreDbPath(sessionId, projectPath, cursorHome);
  if (fs.existsSync(streamJsonStoreDbPath)) return streamJsonStoreDbPath;

  return acpStoreDbPath;
}

function isInternalCursorText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (normalized.includes(USER_QUERY_OPEN_TAG)) return false;
  return normalized.startsWith('<user_info>') || normalized.startsWith('<system_reminder>');
}

function isInternalCursorPart(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false;
  const raw = part as Record<string, unknown>;
  const type = typeof raw.type === 'string' ? raw.type : '';
  return type === 'user_info'
    || type === 'system_reminder'
    || isInternalCursorText(raw.text);
}

function unwrapUserQueryText(value: string, role: 'assistant' | 'user'): string {
  if (role !== 'user') return value;
  const normalized = value.trimStart();
  const openIndex = normalized.indexOf(USER_QUERY_OPEN_TAG);
  if (openIndex < 0) return value;
  const afterOpen = normalized.slice(openIndex + USER_QUERY_OPEN_TAG.length);
  const closeIndex = afterOpen.lastIndexOf(USER_QUERY_CLOSE_TAG);
  const inner = closeIndex >= 0 ? afterOpen.slice(0, closeIndex) : afterOpen;
  return inner.trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeToolId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function toBuffer(value: Uint8Array | Buffer | null | undefined): Buffer | null {
  if (!value) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function toIsoString(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

function timestampForContent(content: Record<string, unknown>, fallback: string): string {
  const message = asObject(content.message);
  return toIsoString(
    content.timestamp ?? content.createdAt ?? content.created_at ?? message.timestamp ?? message.createdAt,
    fallback,
  );
}

function extractCursorToolResultContent(item: Record<string, unknown>): unknown {
  if (typeof item.result === 'string' && item.result.trim()) return item.result;
  if (typeof item.output === 'string' && item.output.trim()) return item.output;
  if (Array.isArray(item.experimental_content)) {
    const text = item.experimental_content
      .map((part) => typeof part === 'string' ? part : asString(asObject(part).text) ?? '')
      .filter(Boolean)
      .join('\n');
    if (text.trim()) return text;
  }
  return item.result ?? item.output ?? item.content ?? '';
}

function parseCursorToolInput(rawInput: unknown): unknown {
  if (typeof rawInput !== 'string') return rawInput;
  const trimmed = rawInput.trim();
  if (!trimmed) return rawInput;
  try {
    return JSON.parse(trimmed);
  } catch {
    return rawInput;
  }
}

function normalizeCursorToolInput(toolName: string, rawInput: unknown): unknown {
  const parsed = parseCursorToolInput(rawInput);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const input = parsed as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...input };

  const filePath = input.file_path ?? input.filePath ?? input.path ?? input.file ?? input.filename;
  if (typeof filePath === 'string' && filePath.trim()) normalized.file_path = filePath;

  if (toolName === 'Write') {
    const content = input.content
      ?? input.text
      ?? input.value
      ?? input.contents
      ?? input.fileContent
      ?? input.new_string
      ?? input.newString;
    if (typeof content === 'string') normalized.content = content;
  }

  if (toolName === 'Edit') {
    const oldString = input.old_string ?? input.oldString ?? input.old ?? '';
    const newString = input.new_string ?? input.newString ?? input.new ?? input.content ?? '';
    if (typeof oldString === 'string') normalized.old_string = oldString;
    if (typeof newString === 'string') normalized.new_string = newString;
  }

  if (toolName === 'ApplyPatch') {
    const patch = input.patch ?? input.diff ?? input.content;
    if (typeof patch === 'string' && !normalized.patch) normalized.patch = patch;
  }

  return normalized;
}

export function readCursorBlobs(
  storeDbPath: string,
  options: { signal?: AbortSignal; maxBlobBytes?: number } = {},
): CursorMessageBlob[] {
  const db = new Database(storeDbPath, { readonly: true, create: false });
  try {
    if (options.maxBlobBytes !== undefined) {
      const oversized = db.query<{ id: string; size: number }, [number]>(`
        SELECT id, length(data) AS size FROM blobs WHERE length(data) > ? LIMIT 1
      `).get(options.maxBlobBytes);
      if (oversized) throw new Error(`Cursor transcript record exceeds ${options.maxBlobBytes} bytes`);
    }
    const allBlobs = db.query('SELECT rowid, id, data FROM blobs').all() as CursorDbBlob[];
    const blobMap = new Map<string, CursorDbBlob>();
    const parentRefs = new Map<string, string[]>();
    const jsonBlobs: CursorJsonBlob[] = [];

    for (const blob of allBlobs) {
      if (options.signal?.aborted) throw new DOMException('Transcript search load cancelled', 'AbortError');
      blobMap.set(blob.id, blob);
      const data = toBuffer(blob.data);
      if (data && data[0] === 0x7B) {
        try {
          jsonBlobs.push({ ...blob, parsed: JSON.parse(data.toString('utf8')) as Record<string, unknown> });
        } catch {
          // Cursor stores non-message JSON fragments in the same blob table.
        }
      }
    }

    for (const blob of allBlobs) {
      if (options.signal?.aborted) throw new DOMException('Transcript search load cancelled', 'AbortError');
      const data = toBuffer(blob.data);
      if (!data || data[0] === 0x7B) continue;
      const parents: string[] = [];
      let i = 0;
      while (i < data.length - 33) {
        if (data[i] === 0x0A && data[i + 1] === 0x20) {
          const parentHash = data.slice(i + 2, i + 34).toString('hex');
          if (blobMap.has(parentHash)) parents.push(parentHash);
          i += 34;
        } else {
          i += 1;
        }
      }
      if (parents.length > 0) parentRefs.set(blob.id, parents);
    }

    const visited = new Set<string>();
    const sorted: CursorDbBlob[] = [];
    const visit = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      for (const parentId of parentRefs.get(nodeId) || []) visit(parentId);
      const blob = blobMap.get(nodeId);
      if (blob) sorted.push(blob);
    };

    for (const blob of allBlobs) {
      if (!parentRefs.has(blob.id)) visit(blob.id);
    }
    for (const blob of allBlobs) visit(blob.id);

    const messageOrder = new Map<string, number>();
    let orderIndex = 0;
    for (const blob of sorted) {
      if (options.signal?.aborted) throw new DOMException('Transcript search load cancelled', 'AbortError');
      const data = toBuffer(blob.data);
      if (!data || data[0] === 0x7B) continue;
      for (const jsonBlob of jsonBlobs) {
        try {
          const idBytes = Buffer.from(jsonBlob.id, 'hex');
          if (data.includes(idBytes) && !messageOrder.has(jsonBlob.id)) {
            messageOrder.set(jsonBlob.id, orderIndex);
            orderIndex += 1;
          }
        } catch {
          // Malformed blob ids are ignored.
        }
      }
    }

    return jsonBlobs
      .sort((a, b) => {
        const aOrder = messageOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = messageOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return aOrder !== bOrder ? aOrder - bOrder : a.rowid - b.rowid;
      })
      .filter((blob) => (blob.parsed.role ?? asObject(blob.parsed.message).role) !== 'system')
      .map((blob, index) => ({
        id: blob.id,
        rowid: blob.rowid,
        sequence: index + 1,
        content: blob.parsed,
      }));
  } finally {
    db.close();
  }
}

function textFromPart(part: unknown, role: 'assistant' | 'user'): string {
  if (typeof part === 'string') {
    return isInternalCursorText(part) ? '' : unwrapUserQueryText(part, role);
  }
  if (isInternalCursorPart(part)) return '';
  const text = asString(asObject(part).text);
  return text ? unwrapUserQueryText(text, role) : '';
}

function upstreamRequestIdFromContent(content: Record<string, unknown>, nestedMessage: Record<string, unknown>): string | undefined {
  const cursorOptions = asObject(asObject(content.providerOptions).cursor);
  const nestedCursorOptions = asObject(asObject(nestedMessage.providerOptions).cursor);
  return asString(
    cursorOptions.requestId
    ?? cursorOptions.request_id
    ?? nestedCursorOptions.requestId
    ?? nestedCursorOptions.request_id
    ?? content.requestId
    ?? content.request_id
    ?? nestedMessage.requestId
    ?? nestedMessage.request_id,
  );
}

function normalizeCursorContent(content: Record<string, unknown>, blob: CursorMessageBlob, timestamp: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const nestedMessage = asObject(content.message);
  const roleValue = asString(content.role ?? nestedMessage.role);
  if (!roleValue || roleValue === 'system') return messages;

  if (roleValue === 'tool') {
    const cursorOptions = asObject(asObject(content.providerOptions).cursor);
    const highLevelToolCallResult = asObject(cursorOptions.highLevelToolCallResult);
    const toolItems = Array.isArray(content.content) ? content.content : [];
    for (const item of toolItems) {
      const rawItem = asObject(item);
      if (rawItem.type !== 'tool-result') continue;
      const toolId = normalizeToolId(rawItem.toolCallId)
        ?? normalizeToolId(rawItem.tool_call_id)
        ?? normalizeToolId(highLevelToolCallResult.toolCallId)
        ?? normalizeToolId(highLevelToolCallResult.tool_call_id)
        ?? normalizeToolId(content.id)
        ?? '';
      const toolName = rawItem.toolName ?? rawItem.tool_name ?? highLevelToolCallResult.toolName ?? highLevelToolCallResult.tool_name;
      messages.push(new ToolResultMessage(
        timestamp,
        toolId,
        normalizeCursorToolResultContent(toolName, extractCursorToolResultContent(rawItem), highLevelToolCallResult),
        Boolean(rawItem.isError || rawItem.is_error),
      ));
    }
    return messages;
  }

  const role = roleValue === 'user' ? 'user' : 'assistant';
  const rawContent = content.content ?? nestedMessage.content;
  const upstreamRequestId = role === 'user' ? upstreamRequestIdFromContent(content, nestedMessage) : undefined;
  const userMetadata = upstreamRequestId ? { upstreamRequestId } : undefined;

  if (Array.isArray(rawContent)) {
    for (let partIndex = 0; partIndex < rawContent.length; partIndex += 1) {
      const part = rawContent[partIndex];
      const rawPart = asObject(part);
      if (rawPart.type === 'reasoning' || rawPart.type === 'thinking') {
        const text = asString(rawPart.text ?? rawPart.thinking);
        if (text) messages.push(new ThinkingMessage(timestamp, text));
        continue;
      }
      if (rawPart.type === 'tool-call' || rawPart.type === 'tool_use') {
        const rawToolName = asString(rawPart.toolName ?? rawPart.name) ?? 'Unknown';
        messages.push(convertCursorToolUse(timestamp, {
          ...rawPart,
          args: normalizeCursorToolInput(rawToolName, rawPart.args ?? rawPart.input),
          id: rawPart.toolCallId ?? rawPart.tool_call_id ?? rawPart.id ?? `${blob.id}_${partIndex}`,
        }));
        continue;
      }

      const text = textFromPart(part, role);
      if (!text.trim()) continue;
      messages.push(role === 'user'
        ? new UserMessage(timestamp, stripResolvedFileMentionContext(text), undefined, userMetadata)
        : new AssistantMessage(timestamp, text));
    }
    return messages;
  }

  if (typeof rawContent === 'string' && rawContent.trim() && !isInternalCursorText(rawContent)) {
    const text = unwrapUserQueryText(rawContent, role);
    if (text.trim()) {
      messages.push(role === 'user'
        ? new UserMessage(timestamp, stripResolvedFileMentionContext(text), undefined, userMetadata)
        : new AssistantMessage(timestamp, text));
    }
  }

  return messages;
}

export function normalizeCursorBlobs(blobs: CursorMessageBlob[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < blobs.length; index += 1) {
    const blob = blobs[index];
    const fallbackTimestamp = deterministicTranscriptTimestamp(blob.sequence ?? index + 1);
    const timestamp = timestampForContent(blob.content, fallbackTimestamp);
    messages.push(...normalizeCursorContent(blob.content, blob, timestamp));
  }
  return messages;
}

export async function loadCursorChatMessagesBySessionId(
  sessionId: string,
  projectPath: string,
  cursorHome?: string,
): Promise<ChatMessage[]> {
  if (!sessionId) return [];
  const storeDbPath = cursorStoreDbPath(sessionId, projectPath, cursorHome);
  if (!fs.existsSync(storeDbPath)) {
    throw new Error(`Cursor transcript database not found: ${storeDbPath}`);
  }
  return normalizeCursorBlobs(readCursorBlobs(storeDbPath));
}

function previewText(message: ChatMessage): string {
  switch (message.type) {
    case 'user-message':
    case 'assistant-message':
    case 'thinking':
      return message.content;
    default:
      return '';
  }
}

export async function getCursorPreviewFromSessionId(
  sessionId: string,
  projectPath: string,
  cursorHome?: string,
): Promise<CursorPreview | null> {
  const messages = await loadCursorChatMessagesBySessionId(sessionId, projectPath, cursorHome);
  if (messages.length === 0) return null;

  const visibleMessages = messages.filter((message) =>
    message.type === 'user-message' || message.type === 'assistant-message');
  const firstUser = visibleMessages.find((message) => message.type === 'user-message');
  const lastVisible = [...visibleMessages].reverse()[0];
  const lastActivity = [...messages].reverse().find((message) => typeof message.timestamp === 'string');

  return {
    createdAt: messages[0]?.timestamp ?? null,
    firstMessage: firstUser ? previewText(firstUser) : 'Unknown Cursor Session',
    lastActivity: lastActivity?.timestamp ?? null,
    lastMessage: lastVisible ? previewText(lastVisible) : 'Unknown Cursor Session',
  };
}
