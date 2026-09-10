import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentChatReference, AgentIntegration } from '@garcon/server-agent-interface';
import type { TranscriptWatermark } from '../ledger/contracts.js';
import type { ResolvedAgentHandoffTarget } from '../agents/agent-handoff-types.js';
import { isEmptyEarlierJournal, isOwnershipJournal } from './agent-ownership-journal-format.js';
import { sameExecutionOwner, type ExecutionLocation } from '../../common/execution-location.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { createLogger } from '../lib/log.js';
import { DomainError } from '../lib/domain-error.js';
import type {
  ChatRegistryEntry,
  ChatRegistryResolvedEntry,
  IChatRegistry,
} from './store.js';
import { carryOverRevision } from './carryover-segments.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import { createPreambleBoundaryBinding } from '../preambles/boundary.js';

const logger = createLogger('chats:ownership-journal');
export const AGENT_OWNERSHIP_JOURNAL_VERSION = 6 as const;
const DEFAULT_RELEASE_TIMEOUT_MS = 30_000;

export interface AgentHandoffIntent {
  readonly version: 6;
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly submittedTargetHash: string;
  readonly kind: 'handoff';
  readonly chatId: string;
  readonly phase: 'commit-decided' | 'registry-committed';
  readonly source: {
    readonly agentId: string;
    readonly agentOwnershipEpoch: string;
    readonly executionLocation: ExecutionLocation;
  };
  readonly target: {
    readonly execution: ResolvedAgentHandoffTarget;
    readonly agentOwnershipEpoch: string;
  };
  readonly watermark: TranscriptWatermark;
  readonly createdAt: string;
}

export interface LocatedNativeRelease {
  readonly executionLocation: ExecutionLocation;
  readonly chat: NativeReleaseChatReference;
}

export interface NativeReleaseChatReference extends Omit<AgentChatReference, 'settings'> {
  readonly settings: AgentChatReference['settings'] | null;
}

export interface DeleteIntent {
  readonly version: 3;
  readonly operationId: string;
  readonly kind: 'delete';
  readonly chatId: string;
  readonly phase: 'prepared' | 'registry-removed';
  readonly sourceEpoch: string | null;
  readonly releaseReferences: readonly LocatedNativeRelease[];
  readonly createdAt: string;
}

export type ChatDeletionResult = { readonly kind: 'ledger-removed' } | { readonly kind: 'not-found' };

export interface AgentOwnershipJournalFile {
  readonly version: typeof AGENT_OWNERSHIP_JOURNAL_VERSION;
  readonly ownershipIntents: readonly (AgentHandoffIntent | DeleteIntent)[];
}

export function emptyOwnershipJournal(): AgentOwnershipJournalFile {
  return { version: AGENT_OWNERSHIP_JOURNAL_VERSION, ownershipIntents: [] };
}

export class AgentOwnershipJournal {
  readonly #filePath: string;
  readonly #registry: IChatRegistry;
  readonly #resolveNativeIntegration: (reference: LocatedNativeRelease) => AgentIntegration | null;
  readonly #ledger: Pick<TranscriptLedgerService, 'deleteChat'>;
  readonly #releaseTimeoutMs: number;
  readonly #write: typeof writeJsonFileAtomic;
  #journal: AgentOwnershipJournalFile = emptyOwnershipJournal();
  #pendingJournal: AgentOwnershipJournalFile | null = null;
  readonly #removedLedgers = new Set<string>();
  #deletePromise: Promise<void> = Promise.resolve();
  #providerCleanupPromise: Promise<void> = Promise.resolve();
  #mutationPromise: Promise<void> = Promise.resolve();

  constructor(options: {
    workspaceDir: string;
    registry: IChatRegistry;
    resolveNativeIntegration(reference: LocatedNativeRelease): AgentIntegration | null;
    ledger: Pick<TranscriptLedgerService, 'deleteChat'>;
    releaseTimeoutMs?: number;
    write?: typeof writeJsonFileAtomic;
  }) {
    this.#filePath = path.join(options.workspaceDir, 'agent-ownership-journal.json');
    this.#registry = options.registry;
    this.#resolveNativeIntegration = options.resolveNativeIntegration;
    this.#ledger = options.ledger;
    this.#releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    this.#write = options.write ?? writeJsonFileAtomic;
    if (!Number.isSafeInteger(this.#releaseTimeoutMs) || this.#releaseTimeoutMs < 1) {
      throw new Error('Ownership cleanup release timeout must be a positive integer');
    }
  }

  async initialize(): Promise<void> {
    this.#journal = await this.#load();
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

  hasPending(chatId: string): boolean {
    return this.pendingKind(chatId) !== null;
  }

  pendingKind(chatId: string): 'handoff' | 'delete' | null {
    return this.#fencedIntents().find((intent) => intent.chatId === chatId)?.kind ?? null;
  }

  roots(): ReadonlySet<string> {
    return new Set();
  }

  pendingHandoffs(): readonly AgentHandoffIntent[] {
    return structuredClone(this.#fencedIntents().filter(
      (intent): intent is AgentHandoffIntent => intent.kind === 'handoff',
    ));
  }

  findHandoff(chatId: string, clientRequestId: string): AgentHandoffIntent | null {
    return structuredClone(this.#fencedIntents().find((intent): intent is AgentHandoffIntent => (
      intent.kind === 'handoff'
      && intent.chatId === chatId
      && intent.clientRequestId === clientRequestId
    )) ?? null);
  }

  /** Confirms a renamed replacement before ledger or registry roll-forward; read-back is not durability proof. */
  reconcileDurability(): Promise<void> {
    return this.#mutate<void>((journal) => journal);
  }

  async decideHandoff(options: {
    readonly operationId: string;
    readonly clientRequestId: string;
    readonly submittedTargetHash: string;
    readonly chatId: string;
    readonly source: Pick<ChatRegistryEntry, 'agentId' | 'agentOwnershipEpoch' | 'executionLocation'>;
    readonly target: ResolvedAgentHandoffTarget;
    readonly targetAgentOwnershipEpoch: string;
    readonly watermark: TranscriptWatermark;
  }): Promise<AgentHandoffIntent> {
    const intent: AgentHandoffIntent = {
      version: 6,
      operationId: options.operationId,
      clientRequestId: options.clientRequestId,
      submittedTargetHash: options.submittedTargetHash,
      kind: 'handoff',
      chatId: options.chatId,
      phase: 'commit-decided',
      source: {
        agentId: options.source.agentId,
        agentOwnershipEpoch: options.source.agentOwnershipEpoch,
        executionLocation: { ...options.source.executionLocation },
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
    });
    return structuredClone(this.#requireHandoff(options.operationId));
  }

  async applyHandoffDecision(operationId: string): Promise<ChatRegistryResolvedEntry> {
    await this.reconcileDurability();
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
    const updated = await this.#registry.updateChat(intent.chatId, {
      agentId: execution.agentId,
      executionLocation: execution.executionLocation,
      projectPath: execution.projectPath,
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
    }, { flush: true });
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

  delete(chatId: string): Promise<ChatDeletionResult> {
    return this.#scheduleDeleteWork(() => this.#deleteNow(chatId));
  }

  waitForProviderCleanup(): Promise<void> {
    return this.#providerCleanupPromise;
  }

  async #deleteNow(chatId: string): Promise<ChatDeletionResult> {
    const intent = await this.#mutate((journal) => {
      const current = this.#registry.getChat(chatId);
      const existing = journal.ownershipIntents.find((candidate) => candidate.chatId === chatId);
      if (existing?.kind === 'delete' && (!current || existing.sourceEpoch === current.agentOwnershipEpoch)) {
        return { journal, result: existing };
      }
      assertAvailable(journal, chatId, 'SESSION_BUSY');
      if (!current) return { journal, result: null };
      const reference: NativeReleaseChatReference = structuredClone({
        chatId,
        agentId: current.agentId,
        agentSessionId: current.agentSessionId,
        projectPath: current.projectPath,
        model: current.model,
        nativeSession: current.nativeSession,
        carryOverRevision: carryOverRevision(current.carryOverSegments, current.carryOverMigrationQuarantine),
        nativeSeedReceipt: current.nativeSeedReceipt,
        settings: current.agentSettingsById[current.agentId] ?? null,
      });
      const prepared: DeleteIntent = {
        version: 3,
        operationId: crypto.randomUUID(),
        kind: 'delete',
        chatId,
        phase: 'prepared',
        sourceEpoch: current.agentOwnershipEpoch,
        releaseReferences: [{ executionLocation: { ...current.executionLocation }, chat: reference }],
        createdAt: new Date().toISOString(),
      };
      return {
        journal: {
          ...journal,
          ownershipIntents: [...journal.ownershipIntents, prepared],
        },
        result: prepared,
      };
    });
    if (!intent) return { kind: 'not-found' };
    await this.#recoverDelete(intent);
    return { kind: 'ledger-removed' };
  }

  async #recoverDelete(intent: DeleteIntent): Promise<void> {
    await this.reconcileDurability();
    const retained = this.#findDelete(intent.operationId);
    if (!retained) return;
    if (!this.#removedLedgers.has(intent.operationId)) {
      const current = this.#registry.getChat(intent.chatId);
      if (current) {
        if (retained.sourceEpoch !== current.agentOwnershipEpoch) {
          throw new Error(`Agent delete journal integrity failure for chat ${intent.chatId}`);
        }
        this.#registry.removeChat(intent.chatId);
      }
      await this.#registry.flush();
      if (retained.phase !== 'registry-removed') {
        await this.#replaceIntent({ ...retained, phase: 'registry-removed' });
      }
      // Native cleanup retries cannot remove the controller ledger twice.
      this.#ledger.deleteChat(intent.chatId);
      this.#removedLedgers.add(intent.operationId);
    }
    void this.#scheduleProviderCleanup(() => this.#finishDelete(intent.operationId)).catch((error) => {
      logger.warn('Recovered delete cleanup failed', {
        chatId: intent.chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #finishDelete(operationId: string): Promise<void> {
    await this.reconcileDurability();
    // An earlier queued cleanup may have discharged the intent before this retry runs.
    const intent = this.#findDelete(operationId);
    if (!intent) return;
    let remaining = [...intent.releaseReferences];
    for (const reference of [...remaining]) {
      try {
        const integration = this.#resolveNativeIntegration(reference);
        if (!integration) {
          logger.warn('Native cleanup owner unavailable', {
            chatId: intent.chatId, agentId: reference.chat.agentId, ...reference.executionLocation,
          });
          continue;
        }
        if (integration.descriptor.id !== reference.chat.agentId) throw new Error('Native cleanup provider mismatch');
        const chat = structuredClone(reference.chat);
        await this.#releaseTranscript(integration, {
          chat: { ...chat, settings: integration.settings.parse(chat.settings ?? integration.settings.defaults()) },
          reason: 'deleted',
        });
      } catch (error) {
        logger.warn('Delete cleanup release failed', {
          chatId: intent.chatId,
          agentId: reference.chat.agentId,
          errorCode: errorCode(error),
        });
        continue;
      }
      remaining = remaining.filter((candidate) => candidate !== reference);
      if (remaining.length > 0) {
        await this.#replaceIntent({ ...intent, releaseReferences: remaining });
      }
    }
    if (remaining.length === 0) await this.#removeIntent(intent.operationId);
  }

  #findDelete(operationId: string): DeleteIntent | undefined {
    return this.#journal.ownershipIntents.find((intent): intent is DeleteIntent => (
      intent.kind === 'delete' && intent.operationId === operationId
    ));
  }

  #requireHandoff(operationId: string): AgentHandoffIntent {
    const intent = this.#fencedIntents().find((candidate): candidate is AgentHandoffIntent => (
      candidate.kind === 'handoff' && candidate.operationId === operationId
    ));
    if (!intent) throw new Error(`Agent handoff intent not found: ${operationId}`);
    return intent;
  }

  async #replaceIntent(intent: AgentHandoffIntent | DeleteIntent): Promise<void> {
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
    integration: AgentIntegration,
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
    mutation: (current: AgentOwnershipJournalFile) =>
      | AgentOwnershipJournalFile
      | { journal: AgentOwnershipJournalFile; result: T },
  ): Promise<T> {
    const operation = this.#mutationPromise.catch(() => undefined).then(async () => {
      await this.#confirmPendingWrite();
      const outcome = mutation(this.#journal);
      const journal = 'journal' in outcome ? outcome.journal : outcome;
      const result = 'journal' in outcome ? outcome.result : undefined as T;
      if (journal !== this.#journal) {
        try {
          await this.#write(this.#filePath, journal, { mode: 0o600 });
        } catch (error) {
          if (error instanceof AtomicJsonWriteError && error.renamed) this.#pendingJournal = journal;
          throw error;
        }
        this.#installJournal(journal);
      }
      return result;
    });
    this.#mutationPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #confirmPendingWrite(): Promise<void> {
    if (!this.#pendingJournal) return;
    await this.#write(this.#filePath, this.#pendingJournal, { mode: 0o600 });
    this.#installJournal(this.#pendingJournal);
    this.#pendingJournal = null;
  }

  #installJournal(journal: AgentOwnershipJournalFile): void {
    this.#journal = journal;
    const retained = new Set(journal.ownershipIntents.map((intent) => intent.operationId));
    for (const operationId of this.#removedLedgers) {
      if (!retained.has(operationId)) this.#removedLedgers.delete(operationId);
    }
  }

  #fencedIntents(): AgentOwnershipJournalFile['ownershipIntents'] {
    if (!this.#pendingJournal) return this.#journal.ownershipIntents;
    // Additions may survive restart; removals cannot release authority until confirmed.
    const intents = new Map(this.#journal.ownershipIntents.map((intent) => [intent.operationId, intent]));
    for (const intent of this.#pendingJournal.ownershipIntents) intents.set(intent.operationId, intent);
    return [...intents.values()];
  }

  async #load(): Promise<AgentOwnershipJournalFile> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.#filePath, 'utf8'));
      if (isOwnershipJournal(value)) return value;
      if (isEmptyEarlierJournal(value)) return emptyOwnershipJournal();
      throw new Error('Invalid agent ownership journal');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyOwnershipJournal();
      throw error;
    }
  }
}

function sameHandoffDecision(left: AgentHandoffIntent, right: AgentHandoffIntent): boolean {
  return left.clientRequestId === right.clientRequestId
    && left.submittedTargetHash === right.submittedTargetHash
    && left.chatId === right.chatId
    && sameExecutionOwner(left.source, right.source)
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
  return current !== null && sameExecutionOwner(current, intent.source)
    && current.agentOwnershipEpoch === intent.source.agentOwnershipEpoch;
}

export function matchesHandoffTarget(
  current: ChatRegistryEntry | null,
  intent: AgentHandoffIntent,
): boolean {
  return current !== null && sameExecutionOwner(current, intent.target.execution)
    && current.projectPath === intent.target.execution.projectPath
    && current.agentOwnershipEpoch === intent.target.agentOwnershipEpoch;
}

function assertAvailable(
  journal: AgentOwnershipJournalFile,
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
