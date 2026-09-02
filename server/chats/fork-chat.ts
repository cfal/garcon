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
import type { LedgerRow, LedgerRowDraft } from '../ledger/contracts.js';
import { isPresentationOnlyProviderRow } from '../ledger/contracts.js';
import { frozenConversationDrafts } from '../ledger/projection.js';
import type { JsonObject } from '../../common/json.js';

const logger = createLogger('chats:fork');

// The nearest conversational provider row at or before the point owns the native position.
// Core-authored rows and presentation-only errors resolve back to it. A conversational provider
// row resolves to itself even when the provider has not correlated it yet: handing the facet that
// row's empty identity is what lets the integration refuse. Rows below the content start belong
// to an earlier binding and anchor nothing.
function nativeForkAnchor(
  rows: readonly LedgerRow[],
  contentStartOrdinal: number,
): LedgerRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.ordinal < contentStartOrdinal) return null;
    if (row.kind === 'provider-row' && !isPresentationOnlyProviderRow(row)) return row;
  }
  return null;
}

// The integration refuses a point it cannot fork natively. With consent that refusal means
// "seed from the frozen conversation instead"; without it, it reaches the caller unchanged.
function isUnsettledForkPoint(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'TRANSCRIPT_NOT_YET_PERSISTED';
}

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
  signal: AbortSignal;
  upToOrdinal?: number;
  // Consent to a handoff fork when the point cannot be forked natively. Without it the
  // integration's refusal reaches the caller, who asks the user before repeating the request.
  allowHandoffFork?: boolean;
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
    signal: AbortSignal;
  }) => Promise<ForkedAgentSessionOutcome | null>;
  discardForkedAgentSession: (agentId: string, session: StartedAgentSession) => Promise<void>;
  // Reads the forked session's own history so the target feed matches the session it resumes
  // from. Answers null when the provider offers no import, which keeps the frozen projection.
  readForkedNativeHistory: (args: {
    targetChatId: string;
    sourceSession: ChatRegistryEntry;
    fork: StartedAgentSession;
    signal: AbortSignal;
  }) => Promise<LedgerRowDraft[] | null>;
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
  signal,
  upToOrdinal,
  allowHandoffFork = false,
  registry,
  settings,
  metadata,
  ledger,
  ownership,
  forkAgentSession,
  discardForkedAgentSession,
  readForkedNativeHistory,
}: ForkChatInput): Promise<ForkChatFileCopyResult> {
  signal.throwIfAborted();
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
  const anchor = nativeForkAnchor(sourceRows, sourceView.contentStartOrdinal);
  // Whether the anchor is forkable is the integration's call, so the request is delegated with
  // whatever identity that row carries, including none. Only the owning integration knows what
  // its metadata means and whether the provider has persisted far enough to honour it. Forking
  // the whole chat continues from the session tip, which is always a native position; forking at
  // a point needs an anchor, and with none there is nothing native to branch from, so the
  // handoff fork is taken without asking.
  const needsNativeFork = Boolean(sourceAgentSessionId)
    && (upToOrdinal === undefined || anchor !== null);
  let forkOutcome: ForkedAgentSessionOutcome | null = null;
  if (needsNativeFork) {
    try {
      forkOutcome = await forkAgentSession({
        sourceSession,
        sourceChatId,
        targetChatId,
        signal,
        ...(upToOrdinal === undefined
          ? {}
          : {
              messageOrdinal: upToOrdinal,
              providerMeta: anchor?.providerMeta ?? null,
            }),
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!allowHandoffFork || !isUnsettledForkPoint(error)) throw error;
      forkOutcome = null;
    }
  }
  const nativeFork = forkOutcome?.kind === 'materialized' ? forkOutcome.session : null;
  await throwIfForkCancelled(
    signal,
    nativeFork,
    sourceSession.agentId,
    discardForkedAgentSession,
  );
  if (forkOutcome?.kind === 'unmaterialized' && !allowHandoffFork) {
    throw new DomainError(
      'TRANSCRIPT_NOT_YET_PERSISTED',
      'The native fork is not materialized yet. Try again shortly or confirm a handoff fork.',
      409,
      true,
    );
  }
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
  // The forked session, not the source's rows, is what the target resumes from, so its own
  // history decides the feed. Copying the source across would start the chat already
  // disagreeing with its session. A handoff fork has no session to read and keeps the
  // frozen projection.
  let nativeSeed: LedgerRowDraft[] | null = null;
  if (nativeFork) {
    try {
      nativeSeed = await readForkedNativeHistory({
        targetChatId,
        sourceSession,
        fork: nativeFork,
        signal,
      });
      signal.throwIfAborted();
    } catch (error) {
      const cleanupErrors = await discardForkResources(
        nativeFork,
        sourceSession.agentId,
        discardForkedAgentSession,
      );
      throwForkFailureAfterCleanup(signal, error, cleanupErrors);
    }
  }
  const sessionRow: LedgerRowDraft[] = nativeFork
    ? [{
      kind: 'session',
      at: new Date().toISOString(),
      detail: nativeFork,
      providerMeta: null,
    }]
    : [];
  // A native seed describes the current binding itself, so only what sits below the source's
  // content start is frozen ahead of it: history from earlier agents that no provider ever
  // held, carried across the fork the same way a reload preserves it. Without a seed the whole
  // selection freezes.
  const frozenPrefix = frozenConversationDrafts(
    nativeSeed
      ? sourceRows.filter((row) => row.ordinal < sourceView.contentStartOrdinal)
      : sourceRows,
  );
  const seedRows = [...frozenPrefix, ...sessionRow, ...(nativeSeed ?? [])];
  const contentStartOrdinal = frozenPrefix.length + 1;
  try {
    ledger.initializeChat(targetChatId, seedRows, contentStartOrdinal);
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
      parentChat: {
        chatId: sourceChatId,
        relation: 'fork',
        transcriptViewId: selectedWatermark.viewId,
        ordinal: selectedWatermark.ordinal,
      },
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
    signal.throwIfAborted();
    await registry.updateChat(sourceChatId, {
      nextForkOrdinal: nextForkOrdinal + 1,
    }, { flush: true });
    signal.throwIfAborted();
    await settings.ensureInNormal(targetChatId);
    signal.throwIfAborted();

    const sourceMeta = metadata.getChatMetadata(sourceChatId);
    if (sourceMeta?.firstMessage) metadata.addNewChatMetadata(targetChatId, sourceMeta.firstMessage);
    await settings.setSessionName(targetChatId, forkTitle);
    signal.throwIfAborted();
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await rollback();
    } catch (rollbackError) {
      cleanupErrors.push(rollbackError);
    }
    throwForkFailureAfterCleanup(
      signal,
      error,
      cleanupErrors,
      `Failed to create and roll back fork ${targetChatId}`,
    );
  }

  logger.info('fork created', {
    sourceChatId,
    targetChatId,
    agentId: sourceSession.agentId,
    kind: nativeFork ? 'native' : 'lazy',
    point: upToOrdinal ?? null,
    copiedRows: frozenPrefix.length,
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

async function throwIfForkCancelled(
  signal: AbortSignal,
  nativeFork: StartedAgentSession | null,
  agentId: string,
  discardForkedAgentSession: (agentId: string, session: StartedAgentSession) => Promise<void>,
): Promise<void> {
  if (!signal.aborted) return;
  const cleanupErrors = await discardForkResources(
    nativeFork,
    agentId,
    discardForkedAgentSession,
  );
  try {
    signal.throwIfAborted();
  } catch (error) {
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors]);
    throw error;
  }
}

function throwForkFailureAfterCleanup(
  signal: AbortSignal,
  error: unknown,
  cleanupErrors: readonly unknown[],
  aggregateMessage?: string,
): never {
  let primary = error;
  try {
    signal.throwIfAborted();
  } catch (cancellation) {
    primary = cancellation;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([primary, ...cleanupErrors], aggregateMessage);
  }
  throw primary;
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
