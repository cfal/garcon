import crypto from 'node:crypto';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import type {
  ForkedAgentSessionOutcome,
  StartedAgentSession,
} from '../agents/session-types.js';
import { extractFirstLine } from '../lib/text.js';
import type { AgentOwnershipJournal } from './agent-ownership-journal.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import { frozenConversationDrafts } from '../ledger/projection.js';
import type { JsonObject } from '../../common/json.js';

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

interface ForkChatInput {
  sourceSession: ChatRegistryEntry;
  sourceChatId: string;
  targetChatId: string;
  upToOrdinal?: number;
  registry: IChatRegistry;
  settings: ForkChatSettings;
  metadata: ForkChatMetadata;
  ledger: Pick<
    TranscriptLedgerService,
    'currentView' | 'highWatermark' | 'rowsThrough' | 'initializeChat' | 'deleteChat'
  >;
  ownership: Pick<AgentOwnershipJournal, 'delete'>;
  forkAgentSession: (args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
    messageOrdinal?: number;
    providerMeta?: JsonObject | null;
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
  upToOrdinal,
  registry,
  settings,
  metadata,
  ledger,
  ownership,
  forkAgentSession,
  discardForkedAgentSession,
}: ForkChatInput): Promise<ForkChatFileCopyResult> {
  const startedAt = Date.now();
  const sourceAgentSessionId = sourceSession.agentSessionId;
  const targetEpoch = crypto.randomUUID();
  const sourceView = ledger.currentView(sourceChatId);
  if (!sourceView) {
    throw new DomainError('TRANSCRIPT_UNAVAILABLE', 'Source transcript is unavailable', 422);
  }
  const sourceWatermark = ledger.highWatermark(sourceChatId);
  const selectedOrdinal = upToOrdinal ?? sourceWatermark.ordinal;
  if (!Number.isSafeInteger(selectedOrdinal)
      || selectedOrdinal < 0
      || selectedOrdinal > sourceWatermark.ordinal) {
    throw new DomainError(
      'TRANSCRIPT_UNAVAILABLE',
      'Fork message is outside the source transcript',
      422,
    );
  }
  const selectedWatermark = { viewId: sourceWatermark.viewId, ordinal: selectedOrdinal };
  const sourceRows = ledger.rowsThrough(sourceChatId, selectedWatermark);
  const frozenRows = frozenConversationDrafts(sourceRows);
  const selectedProviderMeta = upToOrdinal === undefined
    ? null
    : sourceRows.at(-1)?.providerMeta ?? null;
  const needsNativeFork = Boolean(sourceAgentSessionId)
    && selectedOrdinal >= sourceView.contentStartOrdinal
    && (upToOrdinal === undefined || selectedProviderMeta !== null);
  let forkOutcome: ForkedAgentSessionOutcome | null = null;
  if (needsNativeFork) {
    forkOutcome = await forkAgentSession({
      sourceSession,
      sourceChatId,
      targetChatId,
      ...(upToOrdinal === undefined
        ? {}
        : {
            messageOrdinal: upToOrdinal,
            providerMeta: selectedProviderMeta,
          }),
    });
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

  if (ledger.currentView(targetChatId)) {
    const error = new Error(`Chat ID collision: ${targetChatId}`);
    const cleanupErrors = await discardForkResources(
      nativeFork,
      sourceSession.agentId,
      discardForkedAgentSession,
    );
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], error.message);
    throw error;
  }
  const contentStartOrdinal = frozenRows.length + 1;
  try {
    ledger.initializeChat(targetChatId, [
      ...frozenRows,
      ...(nativeFork ? [{
        kind: 'session' as const,
        at: new Date().toISOString(),
        detail: nativeFork,
        providerMeta: null,
      }] : []),
    ], contentStartOrdinal);
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
      carryOverSegments: [],
      nativeSeedReceipt: nativeFork?.nativeSeedReceipt ?? null,
      carryOverMigrationQuarantine: null,
    });
  } catch (error) {
    ledger.deleteChat(targetChatId);
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
    ledger.deleteChat(targetChatId);
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
    point: upToOrdinal ?? null,
    copiedRows: frozenRows.length,
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
