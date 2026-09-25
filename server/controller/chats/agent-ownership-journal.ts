import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentChatReference } from '@garcon/server-agent-interface';
import type { TranscriptWatermark } from '../ledger/contracts.js';
import type { ResolvedAgentHandoffTarget } from '../agents/agent-handoff-types.js';
import type { AgentDirectory } from '../agents/directory.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import { isEmptyEarlierJournal, isJournalV5 } from './agent-ownership-journal-format.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../../common/json-file-store.js';
import type { RetainExecutorReferences } from '../executors/reference-writes.js';
import { ApiProviderDurableReferences, type RetainProviderReferences } from '../api-providers/reference-writes.js';
import { createLogger } from '../../common/log.js';
import { DomainError } from '../../common/domain-error.js';
import type {
  ChatRegistryEntry,
  ChatRegistryResolvedEntry,
  IChatRegistry,
} from './store.js';
import { carryOverRevision } from './carryover-segments.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import { createPreambleBoundaryBinding } from '../preambles/boundary.js';

const logger = createLogger('chats:ownership-journal');
export const AGENT_OWNERSHIP_JOURNAL_VERSION = 5 as const;
const DEFAULT_RELEASE_TIMEOUT_MS = 30_000;

export interface AgentHandoffIntent {
  readonly version: 5;
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly submittedTargetHash: string;
  readonly kind: 'handoff';
  readonly chatId: string;
  readonly phase: 'commit-decided' | 'registry-committed';
  readonly source: {
    readonly executorId?: string | null;
    readonly agentId: string;
    readonly agentOwnershipEpoch: string;
  };
  readonly target: {
    readonly execution: ResolvedAgentHandoffTarget;
    readonly agentOwnershipEpoch: string;
  };
  readonly watermark: TranscriptWatermark;
  readonly createdAt: string;
}

export interface DeleteIntentV2 {
  readonly version: 2;
  readonly operationId: string;
  readonly kind: 'delete';
  readonly chatId: string;
  readonly phase: 'prepared' | 'registry-removed';
  readonly sourceEpoch: string | null;
  readonly releaseReferences: readonly (AgentChatReference & { readonly executorId?: string | null })[];
  readonly createdAt: string;
}

export interface AgentOwnershipJournalFileV5 {
  readonly version: typeof AGENT_OWNERSHIP_JOURNAL_VERSION;
  readonly ownershipIntents: readonly (AgentHandoffIntent | DeleteIntentV2)[];
}

export function emptyOwnershipJournalV5(): AgentOwnershipJournalFileV5 {
  return { version: AGENT_OWNERSHIP_JOURNAL_VERSION, ownershipIntents: [] };
}

export class AgentOwnershipJournal {
  readonly #filePath: string;
  readonly #registry: IChatRegistry;
  readonly #integrations: Pick<AgentDirectory, 'get' | 'require'>;
  readonly #ledger: Pick<TranscriptLedgerService, 'deleteChat'>;
  readonly #releaseTimeoutMs: number;
  readonly #retainExecutorReferences?: RetainExecutorReferences;
  readonly #providerReferences: ApiProviderDurableReferences;
  readonly #isExecutorConfigured: (executorId: string) => boolean;
  readonly #unconfirmedExecutorReferences = new Set<string>();
  readonly #completedLedgerDeletes = new Set<string>();
  #journal: AgentOwnershipJournalFileV5 = emptyOwnershipJournalV5();
  #deletePromise: Promise<void> = Promise.resolve();
  #providerCleanupPromise: Promise<void> = Promise.resolve();
  #mutationPromise: Promise<void> = Promise.resolve();

  constructor(options: {
    workspaceDir: string;
    registry: IChatRegistry;
    integrations: Pick<AgentDirectory, 'get' | 'require'>;
    ledger: Pick<TranscriptLedgerService, 'deleteChat'>;
    releaseTimeoutMs?: number;
    retainExecutorReferences?: RetainExecutorReferences;
    retainProviderReferences?: RetainProviderReferences;
    isExecutorConfigured?: (executorId: string) => boolean;
  }) {
    this.#filePath = path.join(options.workspaceDir, 'agent-ownership-journal.json');
    this.#registry = options.registry;
    this.#integrations = options.integrations;
    this.#ledger = options.ledger;
    this.#releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    this.#retainExecutorReferences = options.retainExecutorReferences;
    this.#providerReferences = new ApiProviderDurableReferences(options.retainProviderReferences);
    this.#isExecutorConfigured = options.isExecutorConfigured ?? (() => true);
    if (!Number.isSafeInteger(this.#releaseTimeoutMs) || this.#releaseTimeoutMs < 1) {
      throw new Error('Ownership cleanup release timeout must be a positive integer');
    }
  }

  async initialize(): Promise<void> {
    this.#journal = await this.#load();
    this.#providerReferences.initialize(journalProviders(this.#journal));
    for (const intent of [...this.#journal.ownershipIntents]) {
      if (intent.kind !== 'delete') continue;
      try {
        await this.#recoverDelete(intent);
      } catch (error) {
        logger.warn('Ownership recovery retained an inconsistent delete intent', {
          chatId: intent.chatId,
          operationId: intent.operationId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  referencesApiProvider(id: string): boolean {
    return this.#providerReferences.references(id);
  }

  hasPending(chatId: string): boolean {
    return this.#journal.ownershipIntents.some((intent) => intent.chatId === chatId);
  }

  referencesExecutor(executorId: string): boolean {
    return this.#unconfirmedExecutorReferences.has(executorId) || journalExecutors(this.#journal).includes(executorId);
  }

  blocksExecutorRemoval(executorId: string): boolean {
    return this.#unconfirmedExecutorReferences.has(executorId) || this.#journal.ownershipIntents.some((intent) => (
      (intent.kind === 'handoff' || intent.phase === 'prepared' || !this.#completedLedgerDeletes.has(intent.operationId))
        && intentExecutors(intent).includes(executorId)
    ));
  }

  retireRemovedExecutor(executorId: string): Promise<void> {
    return this.#scheduleProviderCleanup(async () => {
      if (this.#isExecutorConfigured(executorId)) return;
      await this.#finishExecutorDeletes(executorId);
    });
  }

  retryProviderCleanup(executorId: string): Promise<void> {
    return this.#scheduleProviderCleanup(() => this.#finishExecutorDeletes(executorId));
  }

  roots(): ReadonlySet<string> {
    return new Set();
  }

  pendingHandoffs(): readonly AgentHandoffIntent[] {
    return this.#journal.ownershipIntents.filter(
      (intent): intent is AgentHandoffIntent => intent.kind === 'handoff',
    );
  }

  findHandoff(chatId: string, clientRequestId: string): AgentHandoffIntent | null {
    return this.#journal.ownershipIntents.find((intent): intent is AgentHandoffIntent => (
      intent.kind === 'handoff'
      && intent.chatId === chatId
      && intent.clientRequestId === clientRequestId
    )) ?? null;
  }

  async decideHandoff(options: {
    readonly operationId: string;
    readonly clientRequestId: string;
    readonly submittedTargetHash: string;
    readonly chatId: string;
    readonly source: Pick<ChatRegistryEntry, 'executorId' | 'agentId' | 'agentOwnershipEpoch'>;
    readonly target: ResolvedAgentHandoffTarget;
    readonly targetAgentOwnershipEpoch: string;
    readonly watermark: TranscriptWatermark;
  }): Promise<AgentHandoffIntent> {
    const intent: AgentHandoffIntent = {
      version: 5,
      operationId: options.operationId,
      clientRequestId: options.clientRequestId,
      submittedTargetHash: options.submittedTargetHash,
      kind: 'handoff',
      chatId: options.chatId,
      phase: 'commit-decided',
      source: {
        ...(options.source.executorId ? { executorId: options.source.executorId } : {}),
        agentId: options.source.agentId,
        agentOwnershipEpoch: options.source.agentOwnershipEpoch,
      },
      target: {
        execution: structuredClone(options.target),
        agentOwnershipEpoch: options.targetAgentOwnershipEpoch,
      },
      watermark: structuredClone(options.watermark),
      createdAt: new Date().toISOString(),
    };
    await this.#mutate((current) => {
      const existing = current.ownershipIntents.find(
        (candidate) => candidate.operationId === options.operationId,
      );
      if (existing) {
        if (existing.kind === 'handoff' && sameHandoffDecision(existing, intent)) {
          return { journal: current, result: existing };
        }
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'The handoff operation was decided with different inputs.',
          409,
        );
      }
      assertAvailable(current, options.chatId);
      return {
        journal: {
          ...current,
          ownershipIntents: [...current.ownershipIntents, intent],
        },
        result: intent,
      };
    }, [options.source.executorId]);
    return this.#requireHandoff(options.operationId);
  }

  async applyHandoffDecision(operationId: string): Promise<ChatRegistryResolvedEntry> {
    let intent = this.#requireHandoff(operationId);
    const current = this.#registry.getChat(intent.chatId);
    if (current && matchesHandoffTarget(current, intent)) {
      return { id: intent.chatId, ...current };
    }
    if (!current || !matchesHandoffSource(current, intent)) {
      throw new DomainError(
        'STALE_CHAT_OWNERSHIP',
        `Agent handoff ownership changed for ${intent.chatId}.`,
        409,
      );
    }
    const execution = intent.target.execution;
    const updated = await this.#registry.installAgentOwnership(intent.chatId, {
      executorId: execution.executorId,
      projectPath: execution.projectPath ?? current.projectPath,
      patch: {
        agentId: execution.agentId,
        model: execution.model,
        apiProviderId: execution.apiProviderId,
        modelEndpointId: execution.modelEndpointId,
        modelProtocol: execution.modelProtocol,
        permissionMode: execution.permissionMode,
        thinkingMode: execution.thinkingMode,
        agentSettingsById: {
          ...current.agentSettingsById,
          [execution.agentId]: execution.agentSettings,
        },
        agentSessionId: null,
        nativeSession: null,
        nativeSeedReceipt: null,
        carryOverSegments: [],
        carryOverMigrationQuarantine: null,
        ...createPreambleBoundaryBinding('agent-switch', intent.target.agentOwnershipEpoch),
      },
    });
    if (!updated) throw new Error(`Session not found: ${intent.chatId}`);

    if (intent.phase !== 'registry-committed') {
      intent = { ...intent, phase: 'registry-committed' };
      await this.#replaceIntent(intent);
    }
    return updated;
  }

  async completeHandoff(operationId: string): Promise<void> {
    const intent = this.#requireHandoff(operationId);
    if (!matchesHandoffTarget(this.#registry.getChat(intent.chatId), intent)) {
      throw new Error(`Cannot complete handoff before target ownership is installed: ${operationId}`);
    }
    await this.#removeIntent(operationId);
  }

  delete(chatId: string): Promise<void> {
    return this.#scheduleDeleteWork(() => this.#deleteNow(chatId));
  }

  waitForProviderCleanup(): Promise<void> {
    return this.#providerCleanupPromise;
  }

  async #deleteNow(chatId: string): Promise<void> {
    const current = this.#registry.getChat(chatId);
    const intent = await this.#mutate((journal) => {
      assertAvailable(journal, chatId, 'SESSION_BUSY');
      if (!current) return { journal, result: null };
      const integration = this.#integrations.get(current.agentId, current.executorId);
      const revision = carryOverRevision(current.carryOverSegments, current.carryOverMigrationQuarantine);
      const settings = current.agentSettingsById[current.agentId];
      const reference = integration
        ? toAgentChatReference(integration, chatId, current, revision)
        : settings ? {
            chatId, agentId: current.agentId, agentSessionId: current.agentSessionId,
            nativeSession: current.nativeSession, nativeSeedReceipt: current.nativeSeedReceipt,
            projectPath: current.projectPath, model: current.model, settings, carryOverRevision: revision,
          } : null;
      const prepared: DeleteIntentV2 = {
        version: 2,
        operationId: crypto.randomUUID(),
        kind: 'delete',
        chatId,
        phase: 'prepared',
        sourceEpoch: current.agentOwnershipEpoch,
        releaseReferences: reference ? [{ ...reference, ...(current.executorId ? { executorId: current.executorId } : {}) }] : [],
        createdAt: new Date().toISOString(),
      };
      return {
        journal: {
          ...journal,
          ownershipIntents: [...journal.ownershipIntents, prepared],
        },
        result: prepared,
      };
    }, [current?.executorId]);
    if (!intent) return;
    this.#registry.removeChat(chatId);
    await this.#registry.flush();
    // The provider-neutral ledger must be removed before delete resolves. Only
    // provider/native release is detached, so same-id recreation is safe.
    this.#ledger.deleteChat(chatId);
    this.#completedLedgerDeletes.add(intent.operationId);
    const removed = { ...intent, phase: 'registry-removed' as const };
    await this.#replaceIntent(removed);
    void this.#scheduleProviderCleanup(() => this.#finishDelete(removed.operationId)).catch((error) => {
      logger.warn('Delete cleanup scheduling failed', {
        chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #recoverDelete(intent: DeleteIntentV2): Promise<void> {
    const current = this.#registry.getChat(intent.chatId);
    if (current) {
      if (intent.sourceEpoch !== current.agentOwnershipEpoch) {
        throw new Error(`Agent delete journal integrity failure for chat ${intent.chatId}`);
      }
      this.#registry.removeChat(intent.chatId);
      await this.#registry.flush();
    }
    this.#ledger.deleteChat(intent.chatId);
    this.#completedLedgerDeletes.add(intent.operationId);
    const removed = { ...intent, phase: 'registry-removed' as const };
    await this.#replaceIntent(removed);
    void this.#scheduleProviderCleanup(() => this.#finishDelete(removed.operationId)).catch((error) => {
      logger.warn('Recovered delete cleanup failed', {
        chatId: intent.chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #finishExecutorDeletes(executorId: string): Promise<void> {
    for (const intent of this.#journal.ownershipIntents) {
      if (intent.kind === 'delete' && intent.phase === 'registry-removed' && intentExecutors(intent).includes(executorId)) {
        await this.#finishDelete(intent.operationId);
      }
    }
  }

  async #finishDelete(operationId: string): Promise<void> {
    const intent = this.#journal.ownershipIntents.find((entry) => entry.operationId === operationId);
    if (!intent || intent.kind !== 'delete' || intent.phase !== 'registry-removed') return;
    // Recovery can retain registry-removed intents whose controller cleanup failed.
    if (!this.#completedLedgerDeletes.has(operationId)) return;
    let remaining = [...intent.releaseReferences];
    for (const reference of [...remaining]) {
      const { executorId, ...chat } = reference;
      // Forgetting an executor abandons native cleanup, not controller ledger cleanup.
      if (this.#isExecutorConfigured(effectiveExecutorId(executorId))) {
        const integration = this.#integrations.get(reference.agentId, executorId);
        if (!integration) continue;
        try {
          await this.#releaseTranscript(integration, { chat, reason: 'deleted' });
        } catch (error) {
          logger.warn('Delete cleanup release failed', {
            chatId: intent.chatId,
            agentId: reference.agentId,
            errorCode: errorCode(error),
          });
          continue;
        }
      }
      remaining = remaining.filter((candidate) => candidate !== reference);
      if (remaining.length > 0) {
        await this.#replaceIntent({ ...intent, releaseReferences: remaining });
      }
    }
    if (remaining.length === 0) await this.#removeIntent(intent.operationId);
  }

  #requireHandoff(operationId: string): AgentHandoffIntent {
    const intent = this.#journal.ownershipIntents.find((candidate): candidate is AgentHandoffIntent => (
      candidate.kind === 'handoff' && candidate.operationId === operationId
    ));
    if (!intent) throw new Error(`Agent handoff intent not found: ${operationId}`);
    return intent;
  }

  async #replaceIntent(intent: AgentHandoffIntent | DeleteIntentV2): Promise<void> {
    await this.#mutate((current) => ({
      ...current,
      ownershipIntents: current.ownershipIntents.map((candidate) => (
        candidate.operationId === intent.operationId ? intent : candidate
      )),
    }));
  }

  async #removeIntent(operationId: string): Promise<void> {
    await this.#mutate((current) => ({
      ...current,
      ownershipIntents: current.ownershipIntents.filter(
        (intent) => intent.operationId !== operationId,
      ),
    }));
    this.#completedLedgerDeletes.delete(operationId);
  }

  #scheduleDeleteWork<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#deletePromise.catch(() => undefined).then(work);
    this.#deletePromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #scheduleProviderCleanup<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#providerCleanupPromise.catch(() => undefined).then(work);
    this.#providerCleanupPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #releaseTranscript(
    integration: ReturnType<AgentDirectory['require']>,
    request: { readonly chat: AgentChatReference; readonly reason: 'deleted' },
  ): Promise<void> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        const error = new Error('Provider transcript release timed out');
        error.name = 'AbortError';
        reject(error);
      }, this.#releaseTimeoutMs);
    });
    try {
      await Promise.race([
        integration.nativeSessions?.release({
          ...request,
          chat: request.chat,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #mutate<T>(
    mutation: (current: AgentOwnershipJournalFileV5) =>
      | AgentOwnershipJournalFileV5
      | { journal: AgentOwnershipJournalFileV5; result: T },
    inheritedExecutors: readonly (string | null | undefined)[] = [],
  ): Promise<T> {
    const operation = this.#mutationPromise.catch(() => undefined).then(async () => {
      const outcome = mutation(this.#journal);
      const journal = 'journal' in outcome ? outcome.journal : outcome;
      const result = 'journal' in outcome ? outcome.result : undefined as T;
      if (journal !== this.#journal) {
        const executors = journalExecutors(journal);
        const release = this.#retainExecutorReferences?.(executors, [...journalExecutors(this.#journal), ...inheritedExecutors]);
        try {
          try {
            await this.#providerReferences.publish(journalProviders(journal),
              () => writeJsonFileAtomic(this.#filePath, journal, { mode: 0o600 }));
          } catch (error) {
            // A renamed but unconfirmed decision still prevents executor deletion.
            if (error instanceof AtomicJsonWriteError && error.renamed) {
              for (const id of executors) this.#unconfirmedExecutorReferences.add(id);
            }
            throw error;
          }
          this.#journal = journal;
          this.#unconfirmedExecutorReferences.clear();
        } finally {
          release?.();
        }
      }
      return result;
    });
    this.#mutationPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #load(): Promise<AgentOwnershipJournalFileV5> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.#filePath, 'utf8'));
      if (isJournalV5(value)) return value;
      if (isEmptyEarlierJournal(value)) return emptyOwnershipJournalV5();
      throw new Error('Invalid agent ownership journal');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyOwnershipJournalV5();
      throw error;
    }
  }
}

function journalExecutors(journal: AgentOwnershipJournalFileV5): string[] {
  return journal.ownershipIntents.flatMap(intentExecutors);
}

function journalProviders(journal: AgentOwnershipJournalFileV5): (string | null | undefined)[] {
  return journal.ownershipIntents.flatMap((intent) => intent.kind === 'handoff' ? [intent.target.execution.apiProviderId] : []);
}

function intentExecutors(intent: AgentHandoffIntent | DeleteIntentV2): string[] {
  return intent.kind === 'handoff'
    ? [effectiveExecutorId(intent.source.executorId), effectiveExecutorId(intent.target.execution.executorId)]
    : intent.releaseReferences.map((reference) => effectiveExecutorId(reference.executorId));
}

function sameHandoffDecision(left: AgentHandoffIntent, right: AgentHandoffIntent): boolean {
  return left.clientRequestId === right.clientRequestId
    && left.submittedTargetHash === right.submittedTargetHash
    && left.chatId === right.chatId
    && left.source.agentId === right.source.agentId
    && effectiveExecutorId(left.source.executorId) === effectiveExecutorId(right.source.executorId)
    && left.source.agentOwnershipEpoch === right.source.agentOwnershipEpoch
    && left.target.agentOwnershipEpoch === right.target.agentOwnershipEpoch
    && JSON.stringify(left.target.execution) === JSON.stringify(right.target.execution)
    && left.watermark.viewId === right.watermark.viewId
    && left.watermark.ordinal === right.watermark.ordinal;
}

function matchesHandoffSource(
  current: ChatRegistryEntry | null,
  intent: AgentHandoffIntent,
): boolean {
  return current?.agentId === intent.source.agentId
    && effectiveExecutorId(current.executorId) === effectiveExecutorId(intent.source.executorId)
    && current.agentOwnershipEpoch === intent.source.agentOwnershipEpoch;
}

export function matchesHandoffTarget(
  current: ChatRegistryEntry | null,
  intent: AgentHandoffIntent,
): boolean {
  return current?.agentId === intent.target.execution.agentId
    && effectiveExecutorId(current.executorId) === effectiveExecutorId(intent.target.execution.executorId)
    && (intent.target.execution.projectPath === undefined || current.projectPath === intent.target.execution.projectPath)
    && current.agentOwnershipEpoch === intent.target.agentOwnershipEpoch;
}

function assertAvailable(
  journal: AgentOwnershipJournalFileV5,
  chatId: string,
  code: 'AGENT_HANDOFF_REQUIRES_IDLE' | 'SESSION_BUSY' = 'AGENT_HANDOFF_REQUIRES_IDLE',
): void {
  if (!journal.ownershipIntents.some((intent) => intent.chatId === chatId)) return;
  throw new DomainError(code, `Agent ownership change is pending for ${chatId}.`, 409, true);
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}
