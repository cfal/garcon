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
import type { ForkTranscriptEntryContext } from '../agents/types.js';
import { extractFirstLine } from '../lib/text.js';
import { errorMessage } from '../lib/errors.js';
import { parseFirstJsonlValue } from '../lib/jsonl.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('chats:fork');

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
  assertSourceSnapshotStable?: (sourceChanged: boolean) => void;
  rewriteForkTranscriptEntry?: (
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ) => unknown;
}

export interface ForkChatFileCopyResult {
  sourceChatId: string;
  chatId: string;
  agentId: string;
  agentSessionId: string;
  nativePath: string;
}

export interface NormalizedForkJsonl {
  content: string;
  discardedSuffixLines: number;
  droppedIncompleteTail: boolean;
}

export function assertJsonlValid(content: string, targetPath: string): void {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseFirstJsonlValue(lines[i]);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'value' && !parsed.discardedSuffix) continue;
    const detail = parsed.kind === 'value'
      ? 'Unexpected content after first JSON value'
      : parsed.kind === 'incomplete'
        ? 'Incomplete JSON value'
        : errorMessage(parsed.error);
    throw new Error(`Invalid JSONL at ${targetPath}:${i + 1}: ${detail}`);
  }
}

function rewriteForkJsonl(
  content: string,
  targetPath: string,
  rewriteEntry: ForkChatFileCopyInput['rewriteForkTranscriptEntry'],
  context: ForkTranscriptEntryContext,
): string {
  if (!rewriteEntry) return content;

  return content.split('\n').map((line, index) => {
    const parsed = parseFirstJsonlValue(line);
    if (parsed.kind === 'empty') return line;
    if (parsed.kind !== 'value' || parsed.discardedSuffix) {
      throw new Error(`Cannot rewrite invalid normalized JSONL at ${targetPath}:${index + 1}`);
    }

    const rewritten = rewriteEntry(parsed.value, context);
    if (Object.is(rewritten, parsed.value)) return line;
    const serialized = JSON.stringify(rewritten);
    if (serialized === undefined) {
      throw new Error(`Fork transcript rewriter returned a non-JSON value at ${targetPath}:${index + 1}`);
    }
    return serialized;
  }).join('\n');
}

export function normalizeForkJsonl(content: string, targetPath: string): NormalizedForkJsonl {
  const lines = content.split('\n');
  const kept: string[] = [];
  let lastContentLine = -1;
  let discardedSuffixLines = 0;
  let droppedIncompleteTail = false;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) {
      lastContentLine = index;
      break;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseFirstJsonlValue(lines[i]);
    if (parsed.kind === 'empty') {
      kept.push(lines[i]);
      continue;
    }

    if (parsed.kind === 'value') {
      kept.push(parsed.raw);
      if (parsed.discardedSuffix) discardedSuffixLines += 1;
      continue;
    }

    if (parsed.kind === 'incomplete' && i === lastContentLine) {
      droppedIncompleteTail = true;
      break;
    }

    const detail = parsed.kind === 'incomplete'
      ? 'Incomplete JSON value before end of file'
      : errorMessage(parsed.error);
    throw new Error(`Invalid JSONL at ${targetPath}:${i + 1}: ${detail}`);
  }

  return {
    content: kept.join('\n'),
    discardedSuffixLines,
    droppedIncompleteTail,
  };
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
  const parsed = parseFirstJsonlValue<Record<string, unknown>>(line);
  if (parsed.kind !== 'value') return null;
  if (nonEmptyString(parsed.value.uuid)) return parsed.value.uuid;
  if (nonEmptyString(parsed.value.id)) return parsed.value.id;
  if (nonEmptyString(parsed.value.messageId)) return parsed.value.messageId;
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
  assertSourceSnapshotStable,
  rewriteForkTranscriptEntry,
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

    assertSourceSnapshotStable?.(false);
    const sourceBeforeRead = await fs.stat(sourceNativePath);
    const raw = await fs.readFile(sourceNativePath, 'utf8');
    const sourceAfterRead = await fs.stat(sourceNativePath);
    assertSourceSnapshotStable?.(
      sourceBeforeRead.dev !== sourceAfterRead.dev
      || sourceBeforeRead.ino !== sourceAfterRead.ino
      || sourceBeforeRead.size !== sourceAfterRead.size
      || sourceBeforeRead.mtimeMs !== sourceAfterRead.mtimeMs,
    );
    const rawSnapshot = truncateJsonlForPoint(raw, truncateAfterEntryId, truncateAfterLine);
    const normalized = normalizeForkJsonl(rawSnapshot, sourceNativePath);
    if (normalized.discardedSuffixLines > 0) {
      logger.warn(
        `discarded JSONL suffixes after the first value on ${normalized.discardedSuffixLines} line(s) for chat ${sourceChatId}`,
      );
    }
    const rewritten = rewriteForkJsonl(
      normalized.content,
      sourceNativePath,
      rewriteForkTranscriptEntry,
      {
        sourceAgentSessionId,
        targetAgentSessionId: generatedAgentSessionId,
      },
    );
    const destinationContent = rewritten && !rewritten.endsWith('\n')
      ? `${rewritten}\n`
      : rewritten;

    assertJsonlValid(destinationContent, destinationNativePath);
    await fs.writeFile(destinationNativePath, destinationContent, 'utf8');
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
