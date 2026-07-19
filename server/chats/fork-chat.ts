import crypto from 'node:crypto';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import type { StartedAgentSession } from '../agents/session-types.js';
import { extractFirstLine } from '../lib/text.js';
import type { AgentOwnershipJournal } from './agent-ownership-journal.js';

interface ForkChatSettings {
  getChatName(chatId: string): string | null | undefined;
  ensureInNormal(chatId: string): Promise<unknown>;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  removeFromAllOrderLists(chatId: string): Promise<unknown>;
  removeSessionName(chatId: string): Promise<unknown>;
}

interface ForkChatMetadata {
  getChatMetadata(chatId: string): { firstMessage?: string | null } | null;
  addNewChatMetadata(chatId: string, firstMessage: string): void;
}

interface ForkChatCarryOver {
  stageFork(input: {
    sourceChatId: string;
    targetChatId: string;
    targetEpoch: string;
    ownerId: string;
    ownerModel: string;
    upToSequence?: number;
  }): Promise<void>;
  promoteStaged(chatId: string, targetEpoch: string): Promise<void>;
  discardStaged(chatId: string, targetEpoch: string): Promise<void>;
}

interface ForkChatInput {
  sourceSession: ChatRegistryEntry;
  sourceChatId: string;
  targetChatId: string;
  upToSequence?: number;
  registry: IChatRegistry;
  settings: ForkChatSettings;
  metadata: ForkChatMetadata;
  carryOver?: ForkChatCarryOver;
  ownership: Pick<AgentOwnershipJournal, 'delete'>;
  forkAgentSession: (args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
    messageSequence?: number;
  }) => Promise<StartedAgentSession | null>;
}

export interface ForkChatFileCopyResult {
  sourceChatId: string;
  chatId: string;
  agentId: string;
  agentSessionId: string;
  sourceNextForkOrdinal: number;
  rollback(): Promise<void>;
}

export interface ForkTargetRollbackInput {
  sourceChatId: string;
  targetChatId: string;
  registry: IChatRegistry;
  settings: ForkChatSettings;
  ownership: Pick<AgentOwnershipJournal, 'delete'>;
  sourceNextForkOrdinal?: number;
}

export async function rollbackForkTarget({
  sourceChatId,
  targetChatId,
  registry,
  settings,
  ownership,
  sourceNextForkOrdinal,
}: ForkTargetRollbackInput): Promise<void> {
  await Promise.all([
    settings.removeFromAllOrderLists(targetChatId),
    settings.removeSessionName(targetChatId),
  ]);
  await ownership.delete(targetChatId);
  const source = registry.getChat(sourceChatId);
  if (source && sourceNextForkOrdinal !== undefined) {
    await registry.updateChat(sourceChatId, {
      nextForkOrdinal: sourceNextForkOrdinal,
    }, { flush: true });
  }
}

export async function forkChatFileCopy({
  sourceSession,
  sourceChatId,
  targetChatId,
  upToSequence,
  registry,
  settings,
  metadata,
  carryOver,
  ownership,
  forkAgentSession,
}: ForkChatInput): Promise<ForkChatFileCopyResult> {
  const sourceAgentSessionId = sourceSession.agentSessionId;
  if (!sourceAgentSessionId) throw new Error(`Source agentSessionId missing for chat ${sourceChatId}`);

  const targetEpoch = crypto.randomUUID();
  await carryOver?.stageFork({
    sourceChatId,
    targetChatId,
    targetEpoch,
    ownerId: sourceSession.agentId,
    ownerModel: sourceSession.model,
    ...(upToSequence ? { upToSequence } : {}),
  });
  let nativeFork: StartedAgentSession | null;
  try {
    nativeFork = await forkAgentSession({
      sourceSession,
      sourceChatId,
      targetChatId,
      ...(upToSequence ? { messageSequence: upToSequence } : {}),
    });
  } catch (error) {
    await carryOver?.discardStaged(targetChatId, targetEpoch);
    throw error;
  }
  if (!nativeFork?.agentSessionId) {
    await carryOver?.discardStaged(targetChatId, targetEpoch);
    throw new Error(`Failed to create fork target for chat ${targetChatId}`);
  }

  const sourceTitle = resolveVisibleChatTitle(sourceChatId, settings, metadata);
  const nextForkOrdinal = normalizeNextForkOrdinal(sourceSession.nextForkOrdinal) ?? 1;
  const forkTitle = `${sourceTitle} (${nextForkOrdinal})`;
  const created = registry.addChat({
    id: targetChatId,
    agentId: sourceSession.agentId,
    model: sourceSession.model,
    apiProviderId: sourceSession.apiProviderId ?? null,
    modelEndpointId: sourceSession.modelEndpointId ?? null,
    modelProtocol: sourceSession.modelProtocol ?? null,
    projectPath: sourceSession.projectPath,
    nativeSession: nativeFork.nativeSession,
    agentOwnershipEpoch: targetEpoch,
    tags: [...sourceSession.tags],
    agentSessionId: nativeFork.agentSessionId,
    nextForkOrdinal: 1,
    permissionMode: sourceSession.permissionMode,
    thinkingMode: sourceSession.thinkingMode,
    agentSettingsById: { ...sourceSession.agentSettingsById },
  });
  if (!created) {
    await carryOver?.discardStaged(targetChatId, targetEpoch);
    throw new Error(`Chat ID collision: ${targetChatId}`);
  }

  let rolledBack = false;
  const rollback = async () => {
    if (rolledBack) return;
    await rollbackForkTarget({
      sourceChatId,
      targetChatId,
      registry,
      settings,
      ownership,
      sourceNextForkOrdinal: nextForkOrdinal,
    });
    rolledBack = true;
  };

  try {
    await registry.flush();
    await carryOver?.promoteStaged(targetChatId, targetEpoch);
    await registry.updateChat(sourceChatId, {
      nextForkOrdinal: nextForkOrdinal + 1,
    }, { flush: true });
    await settings.ensureInNormal(targetChatId);

    const sourceMeta = metadata.getChatMetadata(sourceChatId);
    if (sourceMeta?.firstMessage) metadata.addNewChatMetadata(targetChatId, sourceMeta.firstMessage);
    await settings.setSessionName(targetChatId, forkTitle);
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Failed to create and roll back fork ${targetChatId}`);
    }
    throw error;
  }

  return {
    sourceChatId,
    chatId: targetChatId,
    agentId: sourceSession.agentId,
    agentSessionId: nativeFork.agentSessionId,
    sourceNextForkOrdinal: nextForkOrdinal,
    rollback,
  };
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
