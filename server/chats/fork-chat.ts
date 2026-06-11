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

interface ForkChatSettings {
  getChatName(chatId: string): string | null | undefined;
  ensureInNormal(chatId: string): Promise<unknown>;
  setSessionName(chatId: string, title: string): Promise<unknown>;
}

interface ForkChatMetadata {
  getChatMetadata(chatId: string): { firstMessage?: string | null } | null;
  addNewChatMetadata(chatId: string, firstMessage: string): void;
}

interface ForkChatFileCopyInput {
  sourceSession: ChatRegistryEntry;
  sourceChatId: string;
  targetChatId: string;
  registry: IChatRegistry;
  settings: ForkChatSettings;
  metadata: ForkChatMetadata;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function buildForkDestination(sourcePath: string, newAgentSessionId: string): string {
  const dir = path.dirname(sourcePath);
  return path.join(dir, `${newAgentSessionId}.jsonl`);
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
  registry,
  settings,
  metadata,
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

  const nativeFork = forkAgentSession
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
    const rewritten = raw
      .split('\n')
      .map((line) => replaceUuidBounded(line, sourceAgentSessionId, generatedAgentSessionId))
      .join('\n');

    assertJsonlValid(rewritten, destinationNativePath);

    await fs.writeFile(destinationNativePath, rewritten, 'utf8');
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
