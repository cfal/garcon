import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import {
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.ts';

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replaceUuidBounded(line, oldUuid, newUuid) {
  const pattern = new RegExp(`\\b${escapeRegExp(oldUuid)}\\b`, 'g');
  return line.replace(pattern, newUuid);
}

export function assertJsonlValid(content, targetPath) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${targetPath}:${i + 1}: ${error.message}`);
    }
  }
}

function buildForkDestination(sourcePath, newAgentSessionId) {
  const dir = path.dirname(sourcePath);
  return path.join(dir, `${newAgentSessionId}.jsonl`);
}

function extractFirstLine(text) {
  if (!text) return '';
  const nl = text.indexOf('\n');
  if (nl < 0) return text.trim();
  return text.slice(0, nl).trim();
}

function normalizeNextForkOrdinal(value) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveVisibleChatTitle(chatId, settings, metadata) {
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
}) {
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

    newAgentSessionId = crypto.randomUUID();
    destinationNativePath = buildForkDestination(sourceNativePath, newAgentSessionId);

    const raw = await fs.readFile(sourceNativePath, 'utf8');
    const rewritten = raw
      .split('\n')
      .map((line) => replaceUuidBounded(line, sourceAgentSessionId, newAgentSessionId))
      .join('\n');

    assertJsonlValid(rewritten, destinationNativePath);

    await fs.writeFile(destinationNativePath, rewritten, 'utf8');
    ownsDestinationFile = true;
  }

  const created = registry.addChat({
    id: targetChatId,
    agentId: sourceAgentId,
    model: sourceSession.model || null,
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
