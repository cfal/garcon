import crypto from 'node:crypto';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import type { StartedAgentSession } from '../agents/session-types.js';
import { extractFirstLine } from '../lib/text.js';
import type { AgentOwnershipJournal } from './agent-ownership-journal.js';
import type { CarryOverForkStage } from './chat-carryover-store.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('chats:fork');

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
  }): Promise<CarryOverForkStage>;
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
  discardForkedAgentSession: (agentId: string, session: StartedAgentSession) => Promise<void>;
}

export interface ForkChatFileCopyResult {
  sourceChatId: string;
  chatId: string;
  agentId: string;
  agentSessionId: string | null;
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
  discardForkedAgentSession,
}: ForkChatInput): Promise<ForkChatFileCopyResult> {
  const startedAt = Date.now();
  const sourceAgentSessionId = sourceSession.agentSessionId;
  const targetEpoch = crypto.randomUUID();
  const carryOverStage = await carryOver?.stageFork({
    sourceChatId,
    targetChatId,
    targetEpoch,
    ownerId: sourceSession.agentId,
    ownerModel: sourceSession.model,
    ...(upToSequence ? { upToSequence } : {}),
  }) ?? {
    sourceRenderedMessageCount: 0,
    selectedRenderedMessageCount: 0,
    staged: false,
  };
  const selectedNativeCount = upToSequence === undefined
    ? null
    : upToSequence - carryOverStage.selectedRenderedMessageCount;
  if (selectedNativeCount !== null && selectedNativeCount > 0 && !sourceAgentSessionId) {
    await carryOver?.discardStaged(targetChatId, targetEpoch);
    throw new DomainError(
      'TRANSCRIPT_UNAVAILABLE',
      'Fork message is outside the source transcript',
      422,
    );
  }
  const needsNativeFork = Boolean(sourceAgentSessionId)
    && (selectedNativeCount === null || selectedNativeCount > 0);
  let nativeFork: StartedAgentSession | null = null;
  try {
    if (needsNativeFork) {
      nativeFork = await forkAgentSession({
        sourceSession,
        sourceChatId,
        targetChatId,
        ...(upToSequence ? { messageSequence: upToSequence } : {}),
      });
    }
  } catch (error) {
    await carryOver?.discardStaged(targetChatId, targetEpoch);
    throw error;
  }
  if (needsNativeFork && !nativeFork?.agentSessionId) {
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
    nativeSession: nativeFork?.nativeSession ?? null,
    agentOwnershipEpoch: targetEpoch,
    tags: [...sourceSession.tags],
    agentSessionId: nativeFork?.agentSessionId ?? null,
    nextForkOrdinal: 1,
    permissionMode: sourceSession.permissionMode,
    thinkingMode: sourceSession.thinkingMode,
    agentSettingsById: { ...sourceSession.agentSettingsById },
  });
  if (!created) {
    const error = new Error(`Chat ID collision: ${targetChatId}`);
    const cleanups = [carryOver?.discardStaged(targetChatId, targetEpoch)];
    if (nativeFork) cleanups.push(discardForkedAgentSession(sourceSession.agentId, nativeFork));
    const failures = (await Promise.allSettled(cleanups)).filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures.map((failure) => failure.reason)], error.message);
    }
    throw error;
  }

  let rolledBack = false;
  const rollback = async () => {
    if (rolledBack) return;
    const cleanups = [rollbackForkTarget({
        sourceChatId,
        targetChatId,
        registry,
        settings,
        ownership,
        sourceNextForkOrdinal: nextForkOrdinal,
      }), carryOver?.discardStaged(targetChatId, targetEpoch)];
    if (nativeFork) cleanups.push(discardForkedAgentSession(sourceSession.agentId, nativeFork));
    const failures = (await Promise.allSettled(cleanups)).filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to roll back fork ${targetChatId}`,
      );
    }
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

  logger.info('fork created', {
    sourceChatId,
    targetChatId,
    agentId: sourceSession.agentId,
    kind: nativeFork ? 'native' : 'lazy',
    point: upToSequence ?? null,
    carryOverMessages: carryOverStage.selectedRenderedMessageCount,
    durationMs: Date.now() - startedAt,
  });

  return {
    sourceChatId,
    chatId: targetChatId,
    agentId: sourceSession.agentId,
    agentSessionId: nativeFork?.agentSessionId ?? null,
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
