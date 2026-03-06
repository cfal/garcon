import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { supportsFork } from '../../common/providers.ts';

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

function buildForkDestination(sourcePath, newProviderSessionId) {
  const dir = path.dirname(sourcePath);
  return path.join(dir, `${newProviderSessionId}.jsonl`);
}

export async function forkChatFileCopy({
  sourceSession,
  sourceChatId,
  targetChatId,
  registry,
  settings,
  metadata,
}) {
  const sourceProvider = sourceSession.provider;
  if (!supportsFork(sourceProvider)) {
    throw new Error(`Provider does not support fork: ${sourceProvider}`);
  }

  let sourceNativePath = sourceSession.nativePath || null;
  if (!sourceNativePath) {
    throw new Error(`Source native path unavailable for chat ${sourceChatId}`);
  }

  const sourceProviderSessionId = sourceSession.providerSessionId;
  if (!sourceProviderSessionId) {
    throw new Error(`Source providerSessionId missing for chat ${sourceChatId}`);
  }

  const newProviderSessionId = crypto.randomUUID();
  const destinationNativePath = buildForkDestination(sourceNativePath, newProviderSessionId);

  const raw = await fs.readFile(sourceNativePath, 'utf8');
  const rewritten = raw
    .split('\n')
    .map((line) => replaceUuidBounded(line, sourceProviderSessionId, newProviderSessionId))
    .join('\n');

  assertJsonlValid(rewritten, destinationNativePath);

  await fs.writeFile(destinationNativePath, rewritten, 'utf8');

  const created = registry.addChat({
    id: targetChatId,
    provider: sourceProvider,
    model: sourceSession.model || null,
    projectPath: sourceSession.projectPath,
    nativePath: destinationNativePath,
    tags: Array.isArray(sourceSession.tags) ? [...sourceSession.tags] : [],
    providerSessionId: newProviderSessionId,
    permissionMode: sourceSession.permissionMode || 'default',
    thinkingMode: sourceSession.thinkingMode || 'none',
  });

  if (!created) {
    await fs.unlink(destinationNativePath).catch(() => {});
    throw new Error(`Chat ID collision: ${targetChatId}`);
  }

  await settings.ensureInNormal(targetChatId);

  const sourceMeta = metadata.getChatMetadata(sourceChatId);
  if (sourceMeta?.firstMessage) {
    metadata.addNewChatMetadata(targetChatId, sourceMeta.firstMessage);
  }

  return {
    sourceChatId,
    chatId: targetChatId,
    provider: sourceProvider,
    providerSessionId: newProviderSessionId,
    nativePath: destinationNativePath,
  };
}
