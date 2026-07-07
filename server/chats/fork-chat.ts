import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.ts';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import type { StartedAgentSession } from '../agents/session-types.js';
import { extractFirstLine } from '../lib/text.js';
import { errorMessage } from '../lib/errors.js';

interface ForkChatSettings {
  getChatName(chatId: string): string | null | undefined;
  ensureInNormal(chatId: string): Promise<unknown>;
  setSessionName(chatId: string, title: string): Promise<unknown>;
}

interface ForkChatMetadata {
  getChatMetadata(chatId: string): { firstMessage?: string | null } | null;
  addNewChatMetadata(chatId: string, firstMessage: string): void;
}

interface ForkChatCarryOver {
  copy(sourceChatId: string, targetChatId: string): void;
}

interface ForkChatFileCopyInput {
  sourceSession: ChatRegistryEntry;
  sourceChatId: string;
  targetChatId: string;
  truncateAfterEntryId?: string;
  truncateAfterLine?: number;
  registry: IChatRegistry;
  settings: ForkChatSettings;
  metadata: ForkChatMetadata;
  carryOver?: ForkChatCarryOver;
  forkAgentSession?: (args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
  }) => Promise<StartedAgentSession | null>;
  supportsFork?: (agentId: string) => boolean;
}

export interface ForkChatFileCopyResult {
  sourceChatId: string;
  chatId: string;
  agentId: string;
  agentSessionId: string;
  nativePath: string;
}

function escapeRegExp(input: string): string {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replaceUuidBounded(line: string, oldUuid: string, newUuid: string): string {
  const pattern = new RegExp(`\\b${escapeRegExp(oldUuid)}\\b`, 'g');
  return line.replace(pattern, newUuid);
}

export function assertJsonlValid(content: string, targetPath: string): void {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${targetPath}:${i + 1}: ${errorMessage(error)}`);
    }
  }
}

// Drops a trailing incomplete JSON line left by an in-flight write so a fork
// captured mid-turn snapshots the last completed turn instead of failing.
// Throws when a malformed line is followed by more content, which signals real
// corruption rather than a partial tail.
export function sanitizeForkJsonl(content: string, targetPath: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) {
      kept.push(raw);
      continue;
    }
    try {
      JSON.parse(raw.trim());
      kept.push(raw);
    } catch (error) {
      const hasMoreContent = lines.slice(i + 1).some((rest) => rest.trim().length > 0);
      if (hasMoreContent) {
        throw new Error(`Invalid JSONL at ${targetPath}:${i + 1}: ${errorMessage(error)}`);
      }
      break;
    }
  }
  return kept.join('\n');
}

function buildForkDestination(sourcePath: string, newAgentSessionId: string): string {
  const dir = path.dirname(sourcePath);
  return path.join(dir, `${newAgentSessionId}.jsonl`);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function jsonlEntryId(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (nonEmptyString(parsed.uuid)) return parsed.uuid;
    if (nonEmptyString(parsed.id)) return parsed.id;
    if (nonEmptyString(parsed.messageId)) return parsed.messageId;
  } catch {
    return null;
  }
  return null;
}

export function truncateJsonlAfterLine(content: string, lineNumber: number | null | undefined): string {
  if (!isPositiveInt(lineNumber)) return content;
  const lines = content.split('\n');
  if (lineNumber >= lines.length) return content;
  return lines.slice(0, lineNumber).join('\n');
}

export function truncateJsonlAfterEntryId(content: string, entryId: string | null | undefined): string | null {
  if (!nonEmptyString(entryId)) return null;
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (jsonlEntryId(lines[index]) === entryId) {
      return lines.slice(0, index + 1).join('\n');
    }
  }
  return null;
}

function truncateJsonlForPoint(
  content: string,
  entryId: string | null | undefined,
  lineNumber: number | null | undefined,
): string {
  const entrySnapshot = truncateJsonlAfterEntryId(content, entryId);
  if (entrySnapshot !== null) return entrySnapshot;
  if (isPositiveInt(lineNumber)) {
    const lines = content.split('\n');
    if (lineNumber > lines.length) {
      throw new Error(`Cannot truncate JSONL after missing source line ${lineNumber}`);
    }
    return truncateJsonlAfterLine(content, lineNumber);
  }
  if (nonEmptyString(entryId)) {
    throw new Error(`Cannot truncate JSONL after missing source entry ${entryId}`);
  }
  return content;
}

function normalizeNextForkOrdinal(value: unknown): number | null {
  const parsed = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : typeof value === 'number'
      ? value
      : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveVisibleChatTitle(
  chatId: string,
  settings: ForkChatSettings,
  metadata: ForkChatMetadata,
): string {
  const overrideTitle = settings.getChatName(chatId);
  const fallbackTitle = metadata.getChatMetadata(chatId)?.firstMessage;
  return extractFirstLine(overrideTitle || fallbackTitle || 'New Session') || 'New Session';
}

export async function forkChatFileCopy({
  sourceSession,
  sourceChatId,
  targetChatId,
  truncateAfterEntryId,
  truncateAfterLine,
  registry,
  settings,
  metadata,
  carryOver,
  forkAgentSession,
  supportsFork,
}: ForkChatFileCopyInput): Promise<ForkChatFileCopyResult> {
  const sourceAgentId = sourceSession.agentId;
  if (supportsFork && !supportsFork(sourceAgentId)) {
    throw new Error(`Agent does not support fork: ${sourceAgentId}`);
  }

  const sourceAgentSessionId = sourceSession.agentSessionId;
  if (!sourceAgentSessionId) {
    throw new Error(`Source agentSessionId missing for chat ${sourceChatId}`);
  }

  const sourceTitle = resolveVisibleChatTitle(sourceChatId, settings, metadata);
  const nextForkOrdinal = normalizeNextForkOrdinal(sourceSession.nextForkOrdinal) ?? 1;
  const forkTitle = `${sourceTitle} (${nextForkOrdinal})`;

  const nativeFork = forkAgentSession && !truncateAfterEntryId && !truncateAfterLine
    ? await forkAgentSession({ sourceSession, sourceChatId, targetChatId })
    : null;

  let newAgentSessionId = nativeFork?.agentSessionId || null;
  let destinationNativePath = nativeFork?.nativePath || null;
  let ownsDestinationFile = false;

  if (!newAgentSessionId || !destinationNativePath) {
    const sourceNativePath = sourceSession.nativePath || null;
    if (!sourceNativePath) {
      throw new Error(`Source native path unavailable for chat ${sourceChatId}`);
    }

    const generatedAgentSessionId = crypto.randomUUID();
    newAgentSessionId = generatedAgentSessionId;
    destinationNativePath = buildForkDestination(sourceNativePath, generatedAgentSessionId);

    const raw = await fs.readFile(sourceNativePath, 'utf8');
    const rawSnapshot = truncateJsonlForPoint(raw, truncateAfterEntryId, truncateAfterLine);
    const rewritten = rawSnapshot
      .split('\n')
      .map((line) => replaceUuidBounded(line, sourceAgentSessionId, generatedAgentSessionId))
      .join('\n');

    const sanitized = sanitizeForkJsonl(rewritten, destinationNativePath);
    assertJsonlValid(sanitized, destinationNativePath);

    await fs.writeFile(destinationNativePath, sanitized, 'utf8');
    ownsDestinationFile = true;
  }

  if (!newAgentSessionId || !destinationNativePath) {
    throw new Error(`Failed to create fork target for chat ${targetChatId}`);
  }

  const created = registry.addChat({
    id: targetChatId,
    agentId: sourceAgentId,
    model: sourceSession.model || '',
    apiProviderId: sourceSession.apiProviderId ?? null,
    modelEndpointId: sourceSession.modelEndpointId ?? null,
    modelProtocol: sourceSession.modelProtocol ?? null,
    projectPath: sourceSession.projectPath,
    nativePath: destinationNativePath,
    tags: Array.isArray(sourceSession.tags) ? [...sourceSession.tags] : [],
    agentSessionId: newAgentSessionId,
    nextForkOrdinal: 1,
    permissionMode: normalizePermissionMode(sourceSession.permissionMode),
    thinkingMode: normalizeThinkingMode(sourceSession.thinkingMode),
    claudeThinkingMode: normalizeClaudeThinkingMode(sourceSession.claudeThinkingMode),
    ampAgentMode: normalizeAmpAgentMode(sourceSession.ampAgentMode),
  });

  if (!created) {
    if (ownsDestinationFile) await fs.unlink(destinationNativePath).catch(() => {});
    throw new Error(`Chat ID collision: ${targetChatId}`);
  }

  // Carry-over segments hold prior-agent history for a switched chat; a fork must
  // inherit them so the forked chat renders the same continuation.
  carryOver?.copy(sourceChatId, targetChatId);

  registry.updateChat(sourceChatId, { nextForkOrdinal: nextForkOrdinal + 1 });
  await settings.ensureInNormal(targetChatId);

  const sourceMeta = metadata.getChatMetadata(sourceChatId);
  if (sourceMeta?.firstMessage) {
    metadata.addNewChatMetadata(targetChatId, sourceMeta.firstMessage);
  }

  await settings.setSessionName(targetChatId, forkTitle);

  return {
    sourceChatId,
    chatId: targetChatId,
    agentId: sourceAgentId,
    agentSessionId: newAgentSessionId,
    nativePath: destinationNativePath,
  };
}
