import crypto from 'node:crypto';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import type {
  ForkedAgentSessionOutcome,
  StartedAgentSession,
} from '../agents/session-types.js';
import { extractFirstLine } from '../lib/text.js';
import type { AgentOwnershipJournal } from './agent-ownership-journal.js';
import type {
  CarryOverTranscriptStore,
} from './carryover-transcript-store.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import { CommandValidationError } from '../lib/command-validation-error.js';

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

type ForkChatCarryOver = Pick<
  CarryOverTranscriptStore,
  'assertAvailable' | 'logicalMessageCount' | 'resolveCutoff'
>;

interface ForkChatInput {
  sourceSession: ChatRegistryEntry;
  sourceChatId: string;
  targetChatId: string;
  upToSequence?: number;
  registry: IChatRegistry;
  settings: ForkChatSettings;
  metadata: ForkChatMetadata;
  carryOver: ForkChatCarryOver;
  ownership: Pick<AgentOwnershipJournal, 'delete'>;
  getViewCursor(chatId: string): { lastSeq: number } | null;
  forkAgentSession: (args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
    messageSequence?: number;
  }) => Promise<ForkedAgentSessionOutcome | null>;
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
  getViewCursor,
  forkAgentSession,
  discardForkedAgentSession,
}: ForkChatInput): Promise<ForkChatFileCopyResult> {
  const startedAt = Date.now();
  const sourceAgentSessionId = sourceSession.agentSessionId;
  const targetEpoch = crypto.randomUUID();
  const sourceSegments = sourceSession.carryOverSegments;
  await carryOver.assertAvailable(sourceSegments);
  const sourceArchivedCount = carryOver.logicalMessageCount(sourceSegments);
  let selectedArchivedCount = sourceArchivedCount;
  let targetSegments = sourceSegments;
  if (upToSequence !== undefined && upToSequence <= sourceArchivedCount) {
    selectedArchivedCount = upToSequence;
    targetSegments = carryOver.resolveCutoff(sourceSegments, upToSequence);
  }
  const selectedNativeCount = upToSequence === undefined
    ? null
    : upToSequence - selectedArchivedCount;
  if (selectedNativeCount !== null && selectedNativeCount > 0 && !sourceAgentSessionId) {
    throw new DomainError(
      'TRANSCRIPT_UNAVAILABLE',
      'Fork message is outside the source transcript',
      422,
    );
  }
  const needsNativeFork = Boolean(sourceAgentSessionId)
    && (selectedNativeCount === null || selectedNativeCount > 0);
  let forkOutcome: ForkedAgentSessionOutcome | null = null;
  try {
    if (needsNativeFork) {
      forkOutcome = await forkAgentSession({
        sourceSession,
        sourceChatId,
        targetChatId,
        ...(upToSequence === undefined ? {} : { messageSequence: upToSequence }),
      });
    }
  } catch (error) {
    throw error;
  }
  if (needsNativeFork && !forkOutcome) {
    throw new Error(`Failed to create fork target for chat ${targetChatId}`);
  }
  if (
    forkOutcome?.kind === 'unmaterialized'
    && (getViewCursor(sourceChatId)?.lastSeq ?? 0)
      > selectedArchivedCount
  ) {
    // Empty-snapshot forks succeed only when the user cannot see anything the child would lose;
    // otherwise the provider transcript is still flushing and the fork is retryable.
    throw new CommandValidationError(
      'TRANSCRIPT_NOT_YET_PERSISTED',
      "This chat's transcript hasn't been written yet. Try the fork again in a moment.",
      409,
      true,
    );
  }
  const nativeFork = forkOutcome?.kind === 'materialized' ? forkOutcome.session : null;
  try {
    validateForkedSeedReceipt(sourceSession, nativeFork);
  } catch (error) {
    const cleanupErrors = await discardForkResources(
      nativeFork,
      sourceSession.agentId,
      discardForkedAgentSession,
    );
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors]);
    throw error;
  }

  const sourceTitle = resolveVisibleChatTitle(sourceChatId, settings, metadata);
  const nextForkOrdinal = normalizeNextForkOrdinal(sourceSession.nextForkOrdinal) ?? 1;
  const forkTitle = `${sourceTitle} (${nextForkOrdinal})`;
  let created: boolean;
  try {
    created = registry.addChat({
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
      carryOverSegments: targetSegments,
      nativeSeedReceipt: nativeFork?.nativeSeedReceipt ?? null,
      carryOverMigrationQuarantine: sourceSession.carryOverMigrationQuarantine,
    });
  } catch (error) {
    const cleanupErrors = await discardForkResources(
      nativeFork,
      sourceSession.agentId,
      discardForkedAgentSession,
    );
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors]);
    throw error;
  }
  if (!created) {
    const error = new Error(`Chat ID collision: ${targetChatId}`);
    const cleanupErrors = await discardForkResources(
      nativeFork,
      sourceSession.agentId,
      discardForkedAgentSession,
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], error.message);
    }
    throw error;
  }

  let rolledBack = false;
  const rollback = async () => {
    if (rolledBack) return;
    const cleanupErrors: unknown[] = [];
    try {
      await rollbackForkTarget({
        sourceChatId,
        targetChatId,
        registry,
        settings,
        ownership,
        sourceNextForkOrdinal: nextForkOrdinal,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (nativeFork) {
      try {
        await discardForkedAgentSession(sourceSession.agentId, nativeFork);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `Failed to roll back fork ${targetChatId}`,
      );
    }
    rolledBack = true;
  };

  try {
    await registry.flush();
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
    carryOverMessages: selectedArchivedCount,
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

async function discardForkResources(
  nativeFork: StartedAgentSession | null,
  agentId: string,
  discardForkedAgentSession: (agentId: string, session: StartedAgentSession) => Promise<void>,
): Promise<unknown[]> {
  const cleanups: Promise<void>[] = [];
  if (nativeFork) cleanups.push(discardForkedAgentSession(agentId, nativeFork));
  return (await Promise.allSettled(cleanups)).flatMap((result) => (
    result.status === 'rejected' ? [result.reason] : []
  ));
}

function validateForkedSeedReceipt(
  source: ChatRegistryEntry,
  target: StartedAgentSession | null,
): void {
  const receipt = target?.nativeSeedReceipt ?? null;
  if (!receipt) return;
  if (!target || !source.nativeSeedReceipt) {
    throw new Error('Forked agent returned an unexpected carried-context receipt');
  }
  const expected = {
    ...source.nativeSeedReceipt,
    agentSessionId: target.agentSessionId,
  };
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error('Forked agent returned an invalid carried-context receipt');
  }
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
